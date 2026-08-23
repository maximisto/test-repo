/**
 * Library compaction — the rolling current-state baseline.
 *
 * THE PROBLEM THIS SOLVES (measured on 2026-08-11, the talk morning): the
 * library is append-only, and mission prompts carried the N newest FULL
 * memos. Every run enriched the library, so every later run paid more input
 * tokens for the same knowledge restated across memos — and drafted a longer
 * memo because it saw longer context. Credit burn grew run over run, and
 * drafts crossed the summary cap.
 *
 * THE SHAPE: after a run records its findings, a cheap model (the `ops`
 * lane) merges the previous baseline with those findings into one compact
 * "what is true now" digest, appended as a dated library entry titled with
 * `LIBRARY_BASELINE_TITLE_PREFIX`. The read path (`readLibrary`) then stops
 * at the newest baseline: prompts carry "the baseline + anything newer",
 * never the full history. The history itself stays in Drive, untouched and
 * inspectable — compaction changes what a PROMPT carries, not what the
 * customer keeps.
 *
 * APPEND-ONLY BY DESIGN: the verified Drive action set has no update/delete,
 * and this lane must never destroy a customer's records anyway. Each refresh
 * is a NEW dated entry (time-stamped title so multiple same-day runs never
 * collide with the idempotent naming); older baselines fall out of prompts
 * because compaction drops everything older than the newest one.
 *
 * FAILS SOFT: this is an auxiliary lane. A failed merge or write returns
 * `ok: false` for the caller to record as a run warning — it must never fail
 * the mission that already recorded its findings.
 */

import { randomUUID } from 'node:crypto';
import {
  generateTextDetailed,
  type TextGenerationResult,
} from '../models';
import {
  LIBRARY_BASELINE_TITLE_PREFIX,
  MAX_ENTRY_CONTENT_BYTES,
  MAX_LIBRARY_HISTORY_RECOVERY_FILES,
  MAX_RECOVERABLE_APP_ENTRY_CONTENT_BYTES,
  MAX_RECOVERABLE_APP_HISTORY_BYTES,
  appendLibraryEntry,
  buildLibraryAccessFailure,
  hasUnknownLibraryMutationOutcome,
  isLibraryBaselineFileName,
  isLibraryFailure,
  readLibrary,
  type AccountLibraryDeps,
  type AccountLibrarySnapshot,
} from './accountLibrary';
import {
  AUTOMATION_SUMMARY_MAX_BYTES,
  countAutomationWords,
  requireBoundedAutomationOutput,
} from '../platform/automationSummaryPolicy';

/** Output bound for the merge — the digest must stay a fraction of what it compacts. */
export const LIBRARY_BASELINE_MAX_TOKENS = 900;
export const LIBRARY_BASELINE_WORD_LIMIT = 400;
// A published baseline is an authoritative prompt compaction boundary, so it
// must be fully readable through the ordinary account-library entry lane.
// That reader conservatively marks a body that fills its whole byte allowance
// as possibly truncated, so the write ceiling stays one byte below the read
// allowance; even the exact boundary can never become an ambiguous authority.
export const LIBRARY_BASELINE_MAX_BYTES = MAX_ENTRY_CONTENT_BYTES - 1;

/** How many newest entries the merge may look at to find the prior baseline. */
export const LIBRARY_BASELINE_LOOKBACK_LIMIT = 10;
export const LIBRARY_BASELINE_MAX_PROMPT_SOURCE_COUNT = MAX_LIBRARY_HISTORY_RECOVERY_FILES + 2;
const LIBRARY_BASELINE_SOURCE_FRAME_MAX_BYTES = 80;
const BASELINE_NEUTRALIZED_BYTE_RATIO_NUMERATOR = 20;
const BASELINE_NEUTRALIZED_BYTE_RATIO_DENOMINATOR = 17;

export type UpdateLibraryBaselineResult =
  | {
      ok: true;
      fileName: string;
      created: boolean;
      generationUsage?: TextGenerationResult['usage'];
      /**
       * True when this baseline was bootstrapped for a section that had no
       * baseline and more history than the recovery window. The baseline
       * text itself names what was not folded in.
       */
      historyTruncated?: boolean;
    }
  | {
      ok: false;
      message: string;
      generationRejected?: boolean;
      externalActionOutcome?: 'unknown';
    };

export interface UpdateLibraryBaselineInput {
  workspaceId: string;
  section: string;
  /** Stable run identity; makes each append unique even within one millisecond. */
  runId?: string;
  /** The findings memo the run just recorded — the delta to fold in. */
  latestFindingsMarkdown: string;
  /** The shared fence rule sentence (server.ts owns the wording so prompts cannot drift). */
  untrustedRule: string;
  /** Delimiter neutralizer, so fence syntax quoted inside inputs cannot break out. */
  neutralize: (text: string) => string;
}

type BaselineGenerator = (
  ...args: Parameters<typeof generateTextDetailed>
) => Promise<TextGenerationResult | string>;

type BaselineDeps = AccountLibraryDeps & { generate?: BaselineGenerator };

type LibraryAppendResult = Awaited<ReturnType<typeof appendLibraryEntry>>;

export type AppendLibraryEntryWithBaselineResult = {
  libraryResult: LibraryAppendResult;
  baselineResult?: UpdateLibraryBaselineResult;
};

// A baseline is a compare-and-append chain. Serialize each workspace/section
// inside this process so two runs cannot both read the same predecessor and
// publish divergent successors. Violema runs one backend process today; the
// unique run id still prevents filename collision if the storage layer races.
const baselineQueues = new Map<string, Promise<void>>();

function baselineLockKey(workspaceId: string, section: string) {
  return JSON.stringify([workspaceId.trim(), section.trim().toLowerCase()]);
}

async function withBaselineLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = baselineQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => turn);
  baselineQueues.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (baselineQueues.get(key) === tail) baselineQueues.delete(key);
  }
}

function fencedBlock(name: string, body: string, neutralize: (text: string) => string): string {
  return `<untrusted_source name='${name}'>\n${neutralize(body)}\n</untrusted_source>`;
}

export function buildLibraryBaselineSystemPrompt(section: string, untrustedRule: string): string {
  return (
    `You maintain the compact rolling "current state" baseline of a workspace's ${section} library. ` +
    `Merge the prior baseline and ALL newer findings into ONE up-to-date digest of what is true now: ` +
    `concrete facts, named entities, prices, dates, and open follow-ups. When they conflict, the newest ` +
    `findings win. Keep numbers and dates exact; drop narrative, repetition, and anything superseded. ` +
    `At most ${LIBRARY_BASELINE_WORD_LIMIT} words of markdown bullets under short headings. ` +
    `Output the digest only, with no commentary. ${untrustedRule}`
  );
}

export function buildLibraryBaselineGenerationPrompt(input: {
  section: string;
  untrustedRule: string;
  neutralize: (text: string) => string;
  priorBaseline?: string;
  newerFindings: string[];
}) {
  return {
    system: buildLibraryBaselineSystemPrompt(input.section, input.untrustedRule),
    userContent: [
      fencedBlock('prior baseline', input.priorBaseline?.trim() || '(none recorded yet)', input.neutralize),
      ...input.newerFindings.map((content, index) =>
        fencedBlock(`newer findings ${index + 1}`, content, input.neutralize)),
    ].join('\n\n'),
  };
}

/**
 * Byte-safe upper bound for the visible baseline user message before JSON
 * serialization. The production delimiter neutralizer's largest expansion is
 * `<untrusted_source` (17 bytes) to `&lt;untrusted_source` (20 bytes). Each
 * bounded Drive record also receives a small fixed fence/name frame.
 */
export function projectLibraryBaselineUserContentBytes(input: {
  historicalContentBytes: number;
  currentFindingsBytes: number;
  sourceCount: number;
}) {
  const contentBytes = Math.max(0, Math.trunc(input.historicalContentBytes))
    + Math.max(0, Math.trunc(input.currentFindingsBytes))
    + Buffer.byteLength('(none recorded yet)', 'utf8');
  const neutralizedContentBytes = Math.ceil(
    contentBytes
      * BASELINE_NEUTRALIZED_BYTE_RATIO_NUMERATOR
      / BASELINE_NEUTRALIZED_BYTE_RATIO_DENOMINATOR,
  );
  const sourceCount = Math.max(1, Math.trunc(input.sourceCount));
  return neutralizedContentBytes
    + sourceCount * LIBRARY_BASELINE_SOURCE_FRAME_MAX_BYTES
    + (sourceCount - 1) * 2;
}

/**
 * Fold the run's findings into the section's rolling baseline on the cheap
 * lane. Reads its own prior baseline (app entries only — no folder-drop
 * sweep), merges, and appends the refreshed digest as a new dated entry.
 */
export async function updateLibraryBaseline(
  input: UpdateLibraryBaselineInput,
  deps: BaselineDeps = {},
): Promise<UpdateLibraryBaselineResult> {
  const findings = input.latestFindingsMarkdown?.trim();
  if (!findings) {
    return { ok: false, message: 'No findings were drafted this run, so the baseline was left as it was.' };
  }

  const lockKey = baselineLockKey(input.workspaceId, input.section);
  return withBaselineLock(lockKey, () => updateLibraryBaselineLocked(input, findings, deps));
}

/**
 * Append one findings memo and advance its successor baseline under the same
 * section lock. Locking only the merge allowed another run to append while a
 * predecessor merge was in flight; that newer memo could then land behind a
 * baseline that did not contain it and disappear from future prompt reads if
 * its own refresh failed. The append and compaction boundary are one ordered
 * section transaction here (append-only in Drive, serialized in-process).
 */
export async function appendLibraryEntryWithBaseline(
  input: UpdateLibraryBaselineInput & {
    entry: { title: string; markdown: string; versionId?: string };
  },
  deps: BaselineDeps = {},
): Promise<AppendLibraryEntryWithBaselineResult> {
  const lockKey = baselineLockKey(input.workspaceId, input.section);
  return withBaselineLock(lockKey, async () => {
    const findings = input.latestFindingsMarkdown?.trim();
    let repairedBeforeAppend: UpdateLibraryBaselineResult | undefined;

    // A soft merge failure leaves one or more findings memos above the last
    // healthy baseline. Repair that bounded backlog before writing another
    // memo. Otherwise every transient provider outage grows the unbaselined
    // byte window until no later transaction can read enough history to
    // recover. When repair is needed it replaces (rather than precedes) this
    // transaction's normal successor merge, keeping the projected model-call
    // count unchanged; the new memo remains visible immediately above the
    // repaired baseline until the next transaction folds it in.
    const existingSnapshot = await readLibrary(
      input.workspaceId,
      input.section,
      {
        limit: LIBRARY_BASELINE_LOOKBACK_LIMIT,
        includeOperatorFiles: false,
        requireCompleteAppHistory: true,
        maxAppEntryContentBytes: MAX_RECOVERABLE_APP_ENTRY_CONTENT_BYTES,
        maxAppHistoryBytes: MAX_RECOVERABLE_APP_HISTORY_BYTES,
      },
      deps,
    );
    if (!existingSnapshot.ok) return { libraryResult: existingSnapshot };

    const priorBaselineIndex = existingSnapshot.data.entries.findIndex(
      (entry) =>
        isLibraryBaselineFileName(entry.fileName)
        && Boolean(entry.content?.trim())
        && !entry.truncated
        && !entry.contentError,
    );
    const pendingEntries = existingSnapshot.data.entries
      .slice(0, priorBaselineIndex >= 0 ? priorBaselineIndex : existingSnapshot.data.entries.length)
      .filter((entry) => !isLibraryBaselineFileName(entry.fileName));

    // A section that has never been compacted cannot be repaired memo by
    // memo: there is no baseline to repair toward, and when its history
    // exceeds the recovery window no transaction could ever read it
    // completely. Append, then let the successor merge bootstrap a first
    // baseline from the readable window and stamp what it left out.
    const bootstrapping = isBaselineBootstrapCase(existingSnapshot.data);

    if (pendingEntries.length > 0 && !bootstrapping) {
      const unreadablePendingEntry = pendingEntries.find(
        (entry) => entry.truncated || Boolean(entry.contentError) || !entry.content?.trim(),
      );
      if (existingSnapshot.data.appEntryHistoryComplete === false || unreadablePendingEntry) {
        return {
          libraryResult: buildLibraryAccessFailure(
            'integration_query_failed',
            unreadablePendingEntry
              ? `Existing findings "${unreadablePendingEntry.fileName}" could not be read completely, so no new memo was appended.`
              : 'Existing unbaselined findings are outside the bounded recovery window, so no new memo was appended.',
          ),
        };
      }

      const repairFindings = pendingEntries[0]?.content?.trim();
      if (!repairFindings) {
        return {
          libraryResult: buildLibraryAccessFailure(
            'integration_query_failed',
            'Existing findings could not be recovered safely, so no new memo was appended.',
          ),
        };
      }
      repairedBeforeAppend = await updateLibraryBaselineLocked(
        {
          ...input,
          runId: `${input.runId?.trim() || randomUUID()}-preappend-repair`,
          latestFindingsMarkdown: repairFindings,
        },
        repairFindings,
        deps,
      );
      if (!repairedBeforeAppend.ok) {
        const failure = buildLibraryAccessFailure(
          'integration_query_failed',
          `Existing findings could not be compacted before this write. ${repairedBeforeAppend.message}`,
        );
        return {
          libraryResult: repairedBeforeAppend.externalActionOutcome === 'unknown'
            ? { ...failure, externalActionOutcome: 'unknown' as const }
            : failure,
          baselineResult: repairedBeforeAppend,
        };
      }
    }

    const libraryResult = await appendLibraryEntry(
      input.workspaceId,
      input.section,
      input.entry,
      deps,
    );
    if (isLibraryFailure(libraryResult) || !libraryResult.created) {
      return { libraryResult };
    }

    if (!findings) {
      return {
        libraryResult,
        baselineResult: {
          ok: false,
          message: 'No findings were drafted this run, so the baseline was left as it was.',
        },
      };
    }

    if (repairedBeforeAppend) {
      return { libraryResult, baselineResult: repairedBeforeAppend };
    }

    try {
      const baselineResult = await updateLibraryBaselineLocked(
        input,
        findings,
        deps,
        { fileId: libraryResult.fileId, content: findings },
      );
      return { libraryResult, baselineResult };
    } catch (error) {
      return {
        libraryResult,
        baselineResult: {
          ok: false,
          message: `The baseline merge failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
        },
      };
    }
  });
}

async function updateLibraryBaselineLocked(
  input: UpdateLibraryBaselineInput,
  findings: string,
  deps: BaselineDeps,
  knownFindingsEntry?: { fileId: string; content: string },
): Promise<UpdateLibraryBaselineResult> {
  const generate = deps.generate ?? generateTextDetailed;
  const findingsBytes = Buffer.byteLength(findings, 'utf8');
  if (findingsBytes > AUTOMATION_SUMMARY_MAX_BYTES) {
    return {
      ok: false,
      message:
        `The baseline was left unchanged because the current findings contain ${findingsBytes} bytes, ` +
        `over the ${AUTOMATION_SUMMARY_MAX_BYTES}-byte brief limit.`,
    };
  }

  const snapshot = await readLibrary(
    input.workspaceId,
    input.section,
    {
      limit: LIBRARY_BASELINE_LOOKBACK_LIMIT,
      includeOperatorFiles: false,
      requireCompleteAppHistory: true,
      maxAppEntryContentBytes: MAX_RECOVERABLE_APP_ENTRY_CONTENT_BYTES,
      maxAppHistoryBytes: MAX_RECOVERABLE_APP_HISTORY_BYTES,
      ...(knownFindingsEntry
        ? { knownAppEntryContentByFileId: { [knownFindingsEntry.fileId]: knownFindingsEntry.content } }
        : {}),
    },
    deps,
  );
  if (!snapshot.ok) {
    return { ok: false, message: snapshot.message };
  }

  const priorBaseline = snapshot.data.entries.find(
    (entry) =>
      isLibraryBaselineFileName(entry.fileName)
      && Boolean(entry.content?.trim())
      && !entry.truncated
      && !entry.contentError,
  );

  const bootstrapping = !priorBaseline && isBaselineBootstrapCase(snapshot.data);
  const unreadableSource = snapshot.data.entries.find(
    (entry) =>
      !isLibraryBaselineFileName(entry.fileName)
      && (entry.truncated || Boolean(entry.contentError) || !entry.content?.trim()),
  );
  if (unreadableSource && !bootstrapping) {
    return {
      ok: false,
      message:
        `The baseline was left unchanged because "${unreadableSource.fileName}" could not be read completely.`,
    };
  }

  if (!priorBaseline && snapshot.data.appEntryHistoryComplete === false && !bootstrapping) {
    return {
      ok: false,
      message:
        'The baseline was left unchanged because older unbaselined library history is outside the safe read window.',
    };
  }

  const priorBaselineIndex = priorBaseline
    ? snapshot.data.entries.findIndex((entry) => entry.fileId === priorBaseline.fileId)
    : snapshot.data.entries.length;
  const candidateEntries = snapshot.data.entries
    .slice(0, priorBaselineIndex)
    .filter((entry) => !isLibraryBaselineFileName(entry.fileName));
  // In the bootstrap case only fully readable memos are folded; the first
  // memo the window could not read completely marks where the fold stops.
  const firstUnfolded = bootstrapping
    ? candidateEntries.find((entry) => entry.truncated || Boolean(entry.contentError) || !entry.content?.trim())
    : undefined;
  const newerFindings = candidateEntries
    .filter((entry) => !(entry.truncated || Boolean(entry.contentError) || !entry.content?.trim()))
    .map((entry) => entry.content?.trim())
    .filter((content): content is string => Boolean(content));
  if (!newerFindings.includes(findings)) newerFindings.push(findings);
  const uniqueNewerFindings = [...new Set(newerFindings)];
  const bootstrapNotice = bootstrapping
    ? buildBaselineBootstrapNotice(firstUnfolded?.fileName)
    : '';

  const generationPrompt = buildLibraryBaselineGenerationPrompt({
    section: input.section,
    untrustedRule: input.untrustedRule,
    neutralize: input.neutralize,
    priorBaseline: priorBaseline?.content || undefined,
    newerFindings: uniqueNewerFindings,
  });

  let merged: string;
  let generationUsage: TextGenerationResult['usage'] | undefined;
  try {
    const generated = await generate(
      'ops',
      generationPrompt.system,
      [{ role: 'user', content: generationPrompt.userContent }],
      LIBRARY_BASELINE_MAX_TOKENS,
      input.workspaceId,
      deps.signal ? { signal: deps.signal } : undefined,
    );
    if (typeof generated !== 'string') {
      generationUsage = generated.usage;
      if (!generated.stopReason?.trim()) {
        return {
          ok: false,
          message: 'The baseline merge did not report a terminal stop reason and was not recorded.',
          generationRejected: true,
        };
      }
    }
    try {
      merged = requireBoundedAutomationOutput(
        typeof generated === 'string' ? { text: generated } : generated,
        LIBRARY_BASELINE_MAX_BYTES - Buffer.byteLength(bootstrapNotice, 'utf8'),
        'baseline',
      );
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The baseline merge returned an invalid result.',
        generationRejected: true,
      };
    }
  } catch (error) {
    return {
      ok: false,
      message: `The baseline merge failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
    };
  }
  if (bootstrapNotice) merged = `${merged.trimEnd()}\n\n${bootstrapNotice}`;
  const mergedWords = countAutomationWords(merged);
  if (mergedWords > LIBRARY_BASELINE_WORD_LIMIT) {
    return {
      ok: false,
      message:
        `The baseline merge produced ${mergedWords} words, over the ${LIBRARY_BASELINE_WORD_LIMIT}-word limit, and was not recorded.`,
      generationRejected: true,
    };
  }
  // Time + run identity: `appendLibraryEntry` is idempotent per
  // (section,date,title), so clock precision alone is not an identity. The
  // run suffix prevents sequential and concurrent refreshes from silently
  // treating distinct merged bodies as the same append.
  const now = deps.now ? deps.now() : new Date();
  const timeStamp = [
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
    String(now.getUTCMilliseconds()).padStart(3, '0'),
  ].join('.');
  const runIdentity = (input.runId?.trim() || randomUUID())
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || randomUUID();
  const appended = await appendLibraryEntry(
    input.workspaceId,
    input.section,
    {
      title: `${LIBRARY_BASELINE_TITLE_PREFIX} ${timeStamp} ${runIdentity}`,
      markdown: merged,
      kind: 'baseline',
    },
    deps,
  );
  if (isLibraryFailure(appended)) {
    return {
      ok: false,
      message: appended.message,
      ...(hasUnknownLibraryMutationOutcome(appended)
        ? { externalActionOutcome: 'unknown' as const }
        : {}),
    };
  }

  return {
    ok: true,
    fileName: appended.fileName,
    created: appended.created,
    ...(generationUsage ? { generationUsage } : {}),
    ...(bootstrapping ? { historyTruncated: true } : {}),
  };
}

/**
 * A section with no baseline anywhere in its listing and more history than
 * the recovery window. Nothing downstream can ever compact it unless the
 * write lane bootstraps a first baseline from what it could read.
 */
function isBaselineBootstrapCase(
  snapshot: Pick<AccountLibrarySnapshot, 'appBaselineListed' | 'appEntryHistoryComplete' | 'appHistoryBeyondWindow'>,
): boolean {
  return snapshot.appBaselineListed === false
    && snapshot.appEntryHistoryComplete === false
    && snapshot.appHistoryBeyondWindow === true;
}

function buildBaselineBootstrapNotice(firstUnfoldedFileName?: string): string {
  const boundary = firstUnfoldedFileName
    ? `"${firstUnfoldedFileName}" and everything older`
    : 'older findings beyond the read window';
  return (
    `_Bootstrapped baseline: this section had no baseline and more history than one read can cover. ` +
    `${boundary} were not folded in; those files remain in the library folder._`
  );
}

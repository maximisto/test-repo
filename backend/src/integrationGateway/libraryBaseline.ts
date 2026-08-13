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

import { generateText } from '../models';
import {
  LIBRARY_BASELINE_TITLE_PREFIX,
  appendLibraryEntry,
  isLibraryBaselineFileName,
  isLibraryFailure,
  readLibrary,
  type AccountLibraryDeps,
} from './accountLibrary';

/** Output bound for the merge — the digest must stay a fraction of what it compacts. */
export const LIBRARY_BASELINE_MAX_TOKENS = 900;
export const LIBRARY_BASELINE_WORD_LIMIT = 400;

/** How many newest entries the merge may look at to find the prior baseline. */
const BASELINE_LOOKBACK_LIMIT = 8;

export type UpdateLibraryBaselineResult =
  | { ok: true; fileName: string; created: boolean }
  | { ok: false; message: string };

export interface UpdateLibraryBaselineInput {
  workspaceId: string;
  section: string;
  /** The findings memo the run just recorded — the delta to fold in. */
  latestFindingsMarkdown: string;
  /** The shared fence rule sentence (server.ts owns the wording so prompts cannot drift). */
  untrustedRule: string;
  /** Delimiter neutralizer, so fence syntax quoted inside inputs cannot break out. */
  neutralize: (text: string) => string;
}

type BaselineDeps = AccountLibraryDeps & { generate?: typeof generateText };

function fencedBlock(name: string, body: string, neutralize: (text: string) => string): string {
  return `<untrusted_source name='${name}'>\n${neutralize(body)}\n</untrusted_source>`;
}

function buildMergeSystemPrompt(section: string, untrustedRule: string): string {
  return (
    `You maintain the compact rolling "current state" baseline of a workspace's ${section} library. ` +
    `Merge the prior baseline and the newest findings into ONE up-to-date digest of what is true now: ` +
    `concrete facts, named entities, prices, dates, and open follow-ups. When they conflict, the newest ` +
    `findings win. Keep numbers and dates exact; drop narrative, repetition, and anything superseded. ` +
    `At most ${LIBRARY_BASELINE_WORD_LIMIT} words of markdown bullets under short headings. ` +
    `Output the digest only, with no commentary. ${untrustedRule}`
  );
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
  const generate = deps.generate ?? generateText;
  const findings = input.latestFindingsMarkdown?.trim();
  if (!findings) {
    return { ok: false, message: 'No findings were drafted this run, so the baseline was left as it was.' };
  }

  const snapshot = await readLibrary(
    input.workspaceId,
    input.section,
    { limit: BASELINE_LOOKBACK_LIMIT, includeOperatorFiles: false },
    deps,
  );
  if (!snapshot.ok) {
    return { ok: false, message: snapshot.message };
  }

  const priorBaseline = snapshot.data.entries.find(
    (entry) => isLibraryBaselineFileName(entry.fileName) && Boolean(entry.content?.trim()),
  );

  const userContent = [
    fencedBlock('prior baseline', priorBaseline?.content?.trim() || '(none recorded yet)', input.neutralize),
    fencedBlock('newest findings', findings, input.neutralize),
  ].join('\n\n');

  let merged: string;
  try {
    merged = (
      await generate(
        'ops',
        buildMergeSystemPrompt(input.section, input.untrustedRule),
        [{ role: 'user', content: userContent }],
        LIBRARY_BASELINE_MAX_TOKENS,
        input.workspaceId,
      )
    ).trim();
  } catch (error) {
    return {
      ok: false,
      message: `The baseline merge failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
    };
  }
  if (!merged) {
    return { ok: false, message: 'The baseline merge produced no text.' };
  }

  // Time-stamped title: `appendLibraryEntry` is idempotent per (section,
  // date, title), and the whole point of a rolling baseline is that it moves
  // several times a day. `.` instead of `:` because Drive filenames reject
  // colons (sanitizeEntryTitle would collapse them anyway).
  const now = deps.now ? deps.now() : new Date();
  const timeStamp = `${String(now.getUTCHours()).padStart(2, '0')}.${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const appended = await appendLibraryEntry(
    input.workspaceId,
    input.section,
    { title: `${LIBRARY_BASELINE_TITLE_PREFIX} ${timeStamp}`, markdown: merged },
    deps,
  );
  if (isLibraryFailure(appended)) {
    return { ok: false, message: appended.message };
  }

  return { ok: true, fileName: appended.fileName, created: appended.created };
}

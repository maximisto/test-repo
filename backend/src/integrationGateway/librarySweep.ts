/**
 * Library sweep — the operator-file discriminator.
 *
 * The account library (`accountLibrary.ts`) reads Drive through the
 * workspace's Composio `googledrive` connection, which is scoped to
 * `drive.file`: it only ever sees files the app itself created. An operator
 * who hand-drops a `.md`, `.pdf`, or `.docx` into the app-created
 * `Violema Library` folder is therefore invisible to every mission — the
 * highest-signal context available, unreachable by the grant that reads
 * everything else.
 *
 * THE DISCRIMINATOR
 *
 * This module adds a second, platform-owned reader: a Google service account
 * shared on the folder as a Viewer (see `adapters/nativeDriveReader.ts`),
 * which sees the whole tree — everything, operator-dropped or app-created.
 * The Composio lane still only sees app-created files. So:
 *
 *   (service-account listing of the tree) minus (Composio listing) = operator files, exactly
 *
 * No naming convention, no persisted tracking flag, no per-file provenance
 * write — the two grants' scopes are the discriminator. The one thing that
 * must hold for this to be correct is that the Composio listing is COMPLETE
 * for any folder whose files we classify: a truncated app-file listing would
 * misclassify app entries as operator files and duplicate them into evidence.
 * `listComposioVisibleFileIds` therefore reports exactly which folders it
 * paginated to completion, and only those folders' files are judged. It never
 * guesses.
 *
 * WHY THE PAGE BUDGET IS SHARED ACROSS FOLDERS, NOT PER FOLDER
 *
 * The SA tree can contain many section folders (each mission section is a
 * subfolder). `SWEEP_COMPOSIO_MAX_PAGES` bounds the total number of
 * `GOOGLEDRIVE_FIND_FILE` calls this sweep is allowed to make across every
 * folder combined — a workspace with many sections must not multiply the
 * cap, it must share it, or one sweep could make an unbounded number of
 * partner calls. When that shared budget cannot cover every folder, the
 * sweep degrades: it reads what fits, names the folders it did not reach in
 * `warnings`, and returns. It does NOT throw — a workspace with fourteen
 * subfolders is not an error condition, and turning it into one blocked the
 * whole mission run on a `critical` library-read step.
 *
 * FAILS HONEST, NEVER SILENT
 *
 * Every skip is named in `warnings`: unsupported mime, oversized file, files
 * dropped by the 20-file cap, files with no content budget left. A file whose
 * bytes cannot be parsed still becomes an entry — `content: null,
 * contentError: 'content unreadable'` — the same visible-gap semantics
 * `accountLibrary`'s `AccountLibraryEntry` already uses, rather than
 * disappearing without a trace. So does a file the budget ran out on
 * (`contentError: 'content budget exhausted'`), which is the most likely skip
 * in practice.
 *
 * Two ceilings, not one: `budgetBytes` bounds the whole operator lane, and
 * `MAX_ENTRY_CONTENT_BYTES` bounds any single file within it, so one fat drop
 * cannot monopolize the lane and starve everything behind it.
 *
 * MEMO
 *
 * A module-level, in-process LRU (`SWEEP_MEMO_MAX_ENTRIES` entries,
 * `SWEEP_MEMO_TTL_MS` TTL) keyed on `fileId + modifiedTime + md5Checksum`
 * skips re-downloading and re-parsing a file that has not changed since the
 * last sweep that read it. The memo stores the text already capped to the
 * budget it was parsed under; since every call site currently passes the
 * same fixed `budgetBytes`, this never under-serves a later sweep with more
 * room — if that ever changes, the cached text is re-clamped (never
 * re-expanded) to whatever budget the current sweep has left, via the same
 * byte-cap path `sourceParsing.parseSourceBuffer` uses for a fresh file, so a
 * memo hit can never hand back more bytes than the caller asked for.
 *
 * NOTHING WRITES
 *
 * This module only ever reads. The SA reader's Drive scope is
 * `drive.readonly`; no code path here ever calls a Drive write action.
 */

import {
  createDriveReader,
  readDriveReaderConfig,
  DriveReaderError,
  DRIVE_READER_MAX_DOWNLOAD_BYTES,
  type DriveFileMeta,
  type DriveFolderTree,
  type DriveReader,
} from './adapters/nativeDriveReader';
import { isParseableSourceMime, parseSourceBuffer } from './sourceParsing';
import { executeComposioAction } from '../composioBridge';
import { classifyFailure, type PartnerComposioExecutor } from './adapters/partnerComposio';
import { appendLibraryEntry, isLibraryFailure, MAX_ENTRY_CONTENT_BYTES } from './accountLibrary';
import { safeUrlFetch } from './safeUrlFetch';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const GOOGLE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';
const FIND_FILE_ACTION = 'GOOGLEDRIVE_FIND_FILE';
const CREATE_PERMISSION_ACTION = 'GOOGLEDRIVE_CREATE_PERMISSION';

export const MAX_OPERATOR_FILES_PER_SWEEP = 20;
export const SWEEP_COMPOSIO_MAX_PAGES = 10;
export const SWEEP_MEMO_MAX_ENTRIES = 50;
export const SWEEP_MEMO_TTL_MS = 15 * 60 * 1000;

export type FolderDropLaneState =
  | 'not_configured'
  | 'no_library_yet'
  | 'needs_share'
  | 'unavailable'
  | 'active';

export interface LibrarySweepDeps {
  /** Test seam. Default: built from `readDriveReaderConfig()`; `null` when the lane is unconfigured. */
  reader?: DriveReader | null;
  /** Composio executor seam. Default: the real bridge. */
  execute?: PartnerComposioExecutor;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface OperatorSourceEntry {
  fileId: string;
  fileName: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  /** Extracted text, byte-capped. Null when the file could not be read. */
  content: string | null;
  truncated: boolean;
  /** Set when this entry's body could not be read, so the gap stays visible. */
  contentError?: string;
}

export interface LibrarySweepResult {
  laneState: FolderDropLaneState;
  entries: OperatorSourceEntry[];
  /** Named skips: unsupported type, too large, over-cap drops. */
  warnings: string[];
}

export class LibrarySweepError extends Error {
  code: 'listing_failed' = 'listing_failed';

  constructor(message: string) {
    super(message);
    this.name = 'LibrarySweepError';
  }
}

// --- test overrides -----------------------------------------------------------

interface LibrarySweepTestOverrides {
  laneState?: FolderDropLaneState;
  sweep?: LibrarySweepResult;
}

let testOverrides: LibrarySweepTestOverrides | null = null;

/**
 * Short-circuits `getFolderDropLaneState`/`sweepOperatorFiles` with a fixed
 * answer, for callers (Task 4/5's API and read-path tests) that want to
 * steer lane state without wiring a fake reader end to end. Guarded so a
 * stray call outside a test process can never silently rewrite production
 * behavior.
 */
export function setLibrarySweepOverridesForTests(overrides: LibrarySweepTestOverrides | null): void {
  if (process.env.NODE_ENV !== 'test') return;
  testOverrides = overrides;
}

// --- reader email + resolution -------------------------------------------------

/** The email a founder shares their `Violema Library` folder with. Null when the lane is unconfigured. */
export function getFolderDropReaderEmail(): string | null {
  return readDriveReaderConfig()?.clientEmail ?? null;
}

function resolveReader(deps: LibrarySweepDeps): DriveReader | null {
  if (deps.reader !== undefined) return deps.reader;
  const config = readDriveReaderConfig();
  return config ? createDriveReader(config) : null;
}

// --- share --------------------------------------------------------------------

export type ShareLibraryFolderResult =
  | { ok: true }
  | { ok: false; reason: ReturnType<typeof classifyFailure> | 'manual_share_required' };

/**
 * Share the workspace's `Violema Library` root folder with the platform's
 * read-only Drive reader, so the folder-drop lane can move out of
 * `needs_share`.
 *
 * BRANCH A. Registry-verified 2026-08-06 against the live Composio tool
 * registry (not docs) on toolkit `googledrive`: `GOOGLEDRIVE_CREATE_PERMISSION`
 * is present, with `file_id`, `type`, `role` required and `email_address`
 * required when `type` is `user` — see Task 5's report for the full
 * registry-check output. `send_notification_email: false` because the
 * grantee here is the platform's own service-account reader, never a human
 * inbox, so a share notification would just bounce.
 */
export async function shareLibraryFolderWithReader(
  workspaceId: string,
  folderId: string,
  readerEmail: string,
  deps: LibrarySweepDeps = {},
): Promise<ShareLibraryFolderResult> {
  const execute = deps.execute ?? executeComposioAction;

  try {
    const response = await execute(
      CREATE_PERMISSION_ACTION,
      {
        file_id: folderId,
        type: 'user',
        role: 'reader',
        email_address: readerEmail,
        send_notification_email: false,
      },
      { entityId: workspaceId, signal: deps.signal },
    );
    if (!isRecord(response) || (response as ComposioEnvelope).successful !== true) {
      const failureDetail = isRecord(response) ? (response as ComposioEnvelope).error : 'share failed';
      return { ok: false, reason: classifyFailure(failureDetail ?? 'share failed') };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: classifyFailure(error) };
  }
}

// --- lane state -----------------------------------------------------------------

/**
 * The five buckets, named explicitly.
 *
 * `needs_share` is the only state that produces an operator-facing
 * instruction ("re-share your Violema Library folder"). Everything that is
 * OUR problem must therefore land somewhere else, or a single platform
 * outage renders as an accusation in every workspace's every run — telling
 * thousands of operators to fix something they did not break, and hiding our
 * own incident behind onboarding UI. `no_library_yet` is likewise never OUR
 * problem or the OPERATOR's fault — it is just a workspace that has not
 * written its first library entry yet — so it must never render as a server
 * misconfiguration either.
 *
 * - `not_configured`: no reader key on this server, OR the key is present
 *   but unusable, OR the platform side failed in a way the operator cannot
 *   act on:
 *     · `auth_failed` — malformed/expired/revoked platform credential.
 *     · HTTP 401/403 on the folder-meta probe — Drive API disabled on the
 *       project, the service account suspended, an org-policy change.
 *       `timedFetch` maps every non-ok Drive status to `http_error`, so the
 *       CODE cannot separate these; the STATUS can.
 * - `unavailable`: the configured reader hit a transient/platform-bound
 *   failure (timeout, response bound, transport failure, rate limit, or
 *   Drive 5xx). Retrying later is actionable; re-sharing is not.
 * - `no_library_yet`: a reader IS configured, but `rootFolderId` is null —
 *   this workspace's `Violema Library` folder does not exist yet (it is
 *   created lazily on the first library write). Nothing has ever been
 *   shared, so there is nothing to re-share and nothing wrong with the
 *   server; this is purely "come back after your first mission run."
 * - `needs_share`: a working key, a folder that DOES exist, and a probe that
 *   was told the folder is not there for it. A folder not shared with the
 *   reader returns 404 on the metadata probe, which is what makes this
 *   cleanly separable from the 401/403 bucket above.
 * - `active`: the reader could genuinely read the folder's own metadata.
 *
 * WHY THE PROBE IS A METADATA FETCH ON THE FOLDER, NEVER A CHILD LISTING
 *
 * Google Drive returns HTTP 200 with an empty file list when the caller
 * lacks access to a folder — it does not error. A child listing therefore
 * cannot distinguish "this folder is empty" from "I cannot see this folder
 * at all," which is exactly the gap that let an inaccessible folder report
 * `active` with zero files and zero warnings. `getFolderMeta` (Drive's
 * `files.get` on the folder id itself) genuinely 404s/403s when the reader
 * cannot see it, so it is the only thing either `getFolderDropLaneState` or
 * `sweepOperatorFiles` may use to decide whether the lane is truly open.
 */
function laneStateForDriveReaderError(error: DriveReaderError): FolderDropLaneState {
  if (error.code === 'auth_failed') return 'not_configured';
  if (error.status === 401) return 'not_configured';
  if (error.status === 403) {
    const reason = error.reason || '';
    if (/rate.?limit|quota|daily.?limit/i.test(reason)) return 'unavailable';
    if (/insufficientFilePermissions|appNotAuthorizedToFile|notAuthorizedToFile|forbiddenForFile/i.test(reason)) {
      return 'needs_share';
    }
    // Project/API disablement, org policy, and credential-level 403s are
    // server configuration problems. Unknown 403s stay here rather than
    // instructing an operator to re-share without evidence that sharing is
    // actually the failing boundary.
    return 'not_configured';
  }
  if (error.status === 404) return 'needs_share';
  return 'unavailable';
}

export async function getFolderDropLaneState(
  rootFolderId: string | null,
  deps: LibrarySweepDeps = {},
): Promise<FolderDropLaneState> {
  if (process.env.NODE_ENV === 'test' && testOverrides?.laneState !== undefined) {
    return testOverrides.laneState;
  }

  const reader = resolveReader(deps);
  if (!reader) return 'not_configured';
  // A configured reader with no folder to point at is a workspace-level
  // condition (the library has not been created yet), never a server
  // misconfiguration — see the bucket doc above.
  if (!rootFolderId) return 'no_library_yet';

  try {
    // The access probe, deliberately NOT `listFolderTree`: Drive returns
    // HTTP 200 with an empty file list for a folder the caller cannot see,
    // so a child listing can never tell "empty" apart from "inaccessible."
    await reader.getFolderMeta(rootFolderId, deps.signal);
    return 'active';
  } catch (error) {
    if (!(error instanceof DriveReaderError)) throw error;
    return laneStateForDriveReaderError(error);
  }
}

// --- Composio-visible listing (the other half of the set difference) ------------

interface ComposioEnvelope {
  successful?: boolean;
  data?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Same double-wrap defense `accountLibrary`'s `readDriveFiles` uses for Composio's envelope shapes. */
function readListingContainer(payload: unknown): Record<string, unknown> | unknown[] {
  return isRecord(payload) && isRecord(payload.data)
    ? (payload.data as Record<string, unknown>)
    : (payload as Record<string, unknown> | unknown[]);
}

function readListingFiles(payload: unknown): Record<string, unknown>[] | null {
  const container = readListingContainer(payload);
  const raw = Array.isArray(container)
    ? container
    : isRecord(container) && Array.isArray(container.files)
      ? container.files
      : null;
  if (!raw || raw.some((file) => !isRecord(file) || !asString(file.id))) return null;
  return raw;
}

function readListingNextPageToken(payload: unknown): { valid: true; value?: string } | { valid: false } {
  const container = readListingContainer(payload);
  if (!isRecord(container)) return { valid: true };
  if (!('nextPageToken' in container) || container.nextPageToken === undefined) return { valid: true };
  const value = asString(container.nextPageToken);
  return value ? { valid: true, value } : { valid: false };
}

/** Drive query strings are single-quoted, so quotes and backslashes must escape. */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface ComposioVisibleListing {
  /** Every app-created file id seen across the folders that were fully reconciled. */
  visible: Set<string>;
  /** Folders paginated to completeness — the ONLY folders whose files may be classified. */
  reconciledFolderIds: Set<string>;
  /** Folders the page budget could not cover. Their files are neither classified nor guessed at. */
  unreconciledFolderIds: string[];
}

/**
 * Composio-visible file ids across every folder id in the SA tree (root +
 * every nested section folder discovered by the SA reader). Each folder is
 * paginated to completeness; the page budget (`SWEEP_COMPOSIO_MAX_PAGES`) is
 * shared across every folder in this call, never per-folder.
 *
 * TWO FAILURE MODES, TWO DIFFERENT ANSWERS
 *
 * A rejected call or a malformed response is a real failure and still throws
 * `LibrarySweepError` — we cannot tell whether the folder is empty or the
 * partner is broken.
 *
 * Running out of PAGE BUDGET is different: it is a known, bounded, entirely
 * predictable consequence of a workspace having many section folders, and the
 * caller can still do useful work with the folders that fit. Throwing there
 * turned "the operator made 14 subfolders" into a hard failure on a
 * `critical` library-read step — a blocked mission run. So the budget case
 * reports WHICH folders were reconciled instead, and the caller confines
 * classification to those. An unreconciled folder's files are never guessed
 * at: without a complete app-file listing for that folder, an app-created
 * file there would be misread as an operator drop and duplicated into
 * evidence.
 */
async function listComposioVisibleFileIds(
  execute: PartnerComposioExecutor,
  workspaceId: string,
  folderIds: Iterable<string>,
  signal?: AbortSignal,
): Promise<ComposioVisibleListing> {
  const visible = new Set<string>();
  const reconciledFolderIds = new Set<string>();
  const unreconciledFolderIds: string[] = [];
  let pagesUsed = 0;
  let budgetSpent = false;

  for (const folderId of folderIds) {
    if (budgetSpent) {
      unreconciledFolderIds.push(folderId);
      continue;
    }

    let pageToken: string | undefined;
    let completed = true;
    do {
      if (pagesUsed >= SWEEP_COMPOSIO_MAX_PAGES) {
        completed = false;
        budgetSpent = true;
        break;
      }
      pagesUsed += 1;

      const input: Record<string, unknown> = {
        q: `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`,
        fields: 'files(id,name),nextPageToken',
        pageSize: 100,
        spaces: 'drive',
      };
      if (pageToken) input.pageToken = pageToken;

      let response: unknown;
      try {
        response = await execute(FIND_FILE_ACTION, input, { entityId: workspaceId, signal });
      } catch {
        throw new LibrarySweepError('Folder drop: the Composio listing failed.');
      }

      if (!isRecord(response) || (response as ComposioEnvelope).successful !== true) {
        throw new LibrarySweepError('Folder drop: the Composio listing failed.');
      }

      const envelope = response as ComposioEnvelope;
      const files = readListingFiles(envelope.data);
      const nextPage = readListingNextPageToken(envelope.data);
      if (!files || !nextPage.valid) {
        throw new LibrarySweepError('Folder drop: the Composio listing returned an invalid response.');
      }
      for (const file of files) {
        const id = asString(file.id);
        if (id) visible.add(id);
      }
      pageToken = nextPage.value;
    } while (pageToken);

    if (completed) reconciledFolderIds.add(folderId);
    else unreconciledFolderIds.push(folderId);
  }

  return { visible, reconciledFolderIds, unreconciledFolderIds };
}

// --- memo -------------------------------------------------------------------------

interface SweepMemoEntry {
  text: string;
  truncated: boolean;
  at: number;
}

const sweepMemo = new Map<string, SweepMemoEntry>();

function memoKeyFor(file: DriveFileMeta): string {
  return `${file.id}::${file.modifiedTime ?? ''}::${file.md5Checksum ?? ''}`;
}

function readSweepMemo(key: string, nowMs: number): SweepMemoEntry | null {
  const entry = sweepMemo.get(key);
  if (!entry) return null;
  if (nowMs - entry.at > SWEEP_MEMO_TTL_MS) {
    sweepMemo.delete(key);
    return null;
  }
  // Bump recency: delete + re-set moves this key to the end of Map's
  // insertion order, which is what the LRU eviction below walks from.
  sweepMemo.delete(key);
  sweepMemo.set(key, entry);
  return entry;
}

function writeSweepMemo(key: string, entry: SweepMemoEntry): void {
  sweepMemo.delete(key);
  sweepMemo.set(key, entry);
  while (sweepMemo.size > SWEEP_MEMO_MAX_ENTRIES) {
    const oldestKey = sweepMemo.keys().next().value;
    if (oldestKey === undefined) break;
    sweepMemo.delete(oldestKey);
  }
}

/** Test-only escape hatch: the memo is module-level and must not leak content across independent test runs. */
export function clearSweepMemoForTests(): void {
  sweepMemo.clear();
}

// --- per-file body resolution -----------------------------------------------------

/**
 * Resolve one file's extracted text, honoring the memo. Never throws: a
 * `DriveReaderError` from the download/export call, or a parse failure,
 * both collapse to `contentError: 'content unreadable'` — the visible-gap
 * semantics `AccountLibraryEntry` already uses. Any OTHER kind of error
 * (a bug, not an expected failure mode) is rethrown rather than swallowed.
 */
async function resolveFileText(
  reader: DriveReader,
  file: DriveFileMeta,
  maxBytes: number,
  isGoogleDoc: boolean,
  nowMs: number,
  signal?: AbortSignal,
): Promise<{ text: string | null; truncated: boolean; contentError?: string }> {
  const key = memoKeyFor(file);
  const cached = readSweepMemo(key, nowMs);
  if (cached) {
    // Re-clamp to the CURRENT budget without re-downloading or re-exporting.
    // `cached.truncated` is carried forward with OR, never discarded: the
    // cached text is itself already a possibly-partial view of the real
    // file (it was capped to whatever budget the sweep that wrote it had
    // left). A later sweep with more remainingBudget can re-clamp that
    // partial text and find it fits under the new, larger ceiling — but
    // "fits under a bigger ceiling" is not the same fact as "this is the
    // whole file". A file once known-partial must never later report
    // complete without an actual re-download/re-export.
    const reclamped = await parseSourceBuffer(
      { fileName: file.name, mimeType: 'text/plain', buffer: Buffer.from(cached.text, 'utf8') },
      maxBytes,
    );
    return reclamped.ok
      ? { text: reclamped.text, truncated: cached.truncated || reclamped.truncated }
      : { text: null, truncated: false, contentError: 'content unreadable' };
  }

  let parsed;
  try {
    if (isGoogleDoc) {
      const exported = await reader.exportDoc(file.id, signal);
      parsed = await parseSourceBuffer(
        { fileName: file.name, mimeType: 'text/plain', buffer: Buffer.from(exported, 'utf8') },
        maxBytes,
      );
    } else {
      const buffer = await reader.downloadFile(file.id, signal);
      parsed = await parseSourceBuffer({ fileName: file.name, mimeType: file.mimeType, buffer }, maxBytes);
    }
  } catch (error) {
    if (!(error instanceof DriveReaderError)) throw error;
    return { text: null, truncated: false, contentError: 'content unreadable' };
  }

  if (!parsed.ok) {
    return { text: null, truncated: false, contentError: 'content unreadable' };
  }

  writeSweepMemo(key, { text: parsed.text, truncated: parsed.truncated, at: nowMs });
  return { text: parsed.text, truncated: parsed.truncated };
}

/**
 * Byte ceilings are engineering facts; warnings are read by operators. "5 MB"
 * is a size someone can act on ("split the deck"); "5000000-byte cap" is a
 * number they have to decode first.
 */
function formatMegabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  const rendered = Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
  return `${rendered} MB`;
}

function modifiedTimeValue(file: DriveFileMeta): number {
  if (!file.modifiedTime) return 0;
  const parsed = Date.parse(file.modifiedTime);
  return Number.isFinite(parsed) ? parsed : 0;
}

// --- sweep ------------------------------------------------------------------------

/**
 * Sweep the operator-file set out of a workspace's `Violema Library` tree.
 *
 * Throws `LibrarySweepError` only when the Composio listing FAILS (rejected
 * call, malformed envelope) — never returns a result built on a listing whose
 * completeness it cannot vouch for. A listing that merely ran out of page
 * budget degrades instead: the folders that were reconciled are swept, the
 * ones that were not are named in `warnings`, and no file from an
 * unreconciled folder is classified.
 */
export async function sweepOperatorFiles(
  input: { workspaceId: string; rootFolderId: string; budgetBytes: number },
  deps: LibrarySweepDeps = {},
): Promise<LibrarySweepResult> {
  if (process.env.NODE_ENV === 'test' && testOverrides?.sweep !== undefined) {
    return testOverrides.sweep;
  }

  const reader = resolveReader(deps);
  if (!reader) {
    return { laneState: 'not_configured', entries: [], warnings: [] };
  }

  const execute = deps.execute ?? executeComposioAction;
  const nowFn = deps.now ?? (() => new Date());

  const warnings: string[] = [];

  // Verify access BEFORE ever listing children. `listFolderTree` on a folder
  // this reader cannot see returns HTTP 200 with an empty array, not an
  // error — so without this check, a blind folder would "successfully"
  // sweep zero files with zero warnings, which is exactly the silent
  // failure this module exists to prevent. `getFolderMeta` genuinely
  // 404s/403s when the reader lacks access.
  try {
    await reader.getFolderMeta(input.rootFolderId, deps.signal);
  } catch (error) {
    if (!(error instanceof DriveReaderError)) throw error;
    return { laneState: laneStateForDriveReaderError(error), entries: [], warnings: [] };
  }

  let tree: DriveFolderTree;
  try {
    tree = await reader.listFolderTree(input.rootFolderId, deps.signal);
  } catch (error) {
    if (!(error instanceof DriveReaderError)) throw error;
    return { laneState: laneStateForDriveReaderError(error), entries: [], warnings: [] };
  }

  if (tree.truncated) {
    warnings.push(
      'Folder drop: your Violema Library has more folders than one run can list, so some were not read this run.',
    );
  }

  const folderIds = new Set<string>([input.rootFolderId]);
  for (const file of tree.files) {
    if (file.mimeType === FOLDER_MIME_TYPE) folderIds.add(file.id);
  }

  // Throws LibrarySweepError on a rejected or malformed listing. Running out
  // of page budget is NOT that: it reports which folders it managed to
  // reconcile, and classification below is confined to exactly those.
  const listing = await listComposioVisibleFileIds(
    execute,
    input.workspaceId,
    folderIds,
    deps.signal,
  );
  if (listing.unreconciledFolderIds.length > 0) {
    warnings.push(
      `Folder drop: ${listing.unreconciledFolderIds.length} folder(s) were not read this run (the ${SWEEP_COMPOSIO_MAX_PAGES}-page listing budget ran out); any files inside them were skipped.`,
    );
  }

  const operatorFiles = tree.files.filter(
    (file) =>
      file.mimeType !== FOLDER_MIME_TYPE &&
      // Files listed before this field existed, and the root's own children,
      // belong to the root — which is always the first folder reconciled.
      listing.reconciledFolderIds.has(file.parentFolderId ?? input.rootFolderId) &&
      !listing.visible.has(file.id),
  );
  operatorFiles.sort((a, b) => modifiedTimeValue(b) - modifiedTimeValue(a));

  let selected = operatorFiles;
  if (operatorFiles.length > MAX_OPERATOR_FILES_PER_SWEEP) {
    const dropped = operatorFiles.slice(MAX_OPERATOR_FILES_PER_SWEEP);
    selected = operatorFiles.slice(0, MAX_OPERATOR_FILES_PER_SWEEP);
    warnings.push(
      `Folder drop: ${dropped.length} more file(s) were not read this run (${MAX_OPERATOR_FILES_PER_SWEEP}-file cap): ${dropped
        .map((file) => file.name)
        .join(', ')}`,
    );
  }

  const entries: OperatorSourceEntry[] = [];
  let remainingBudget = input.budgetBytes;
  const nowMs = nowFn().getTime();
  const starvedFileNames: string[] = [];

  for (const file of selected) {
    deps.signal?.throwIfAborted();
    const isGoogleDoc = file.mimeType === GOOGLE_DOC_MIME_TYPE;

    // The two free screens first: neither spends budget, and both already
    // name themselves in `warnings`, so a file rejected on type or size
    // should say THAT rather than "budget exhausted".
    if (!isGoogleDoc && !isParseableSourceMime(file.mimeType)) {
      warnings.push(`Folder drop: '${file.name}' skipped (unsupported type ${file.mimeType})`);
      continue;
    }

    if (!isGoogleDoc && typeof file.size === 'number' && file.size > DRIVE_READER_MAX_DOWNLOAD_BYTES) {
      warnings.push(
        `Folder drop: '${file.name}' skipped (larger than ${formatMegabytes(DRIVE_READER_MAX_DOWNLOAD_BYTES)})`,
      );
      continue;
    }

    // Out of room. The file still becomes an ENTRY — name, link, modified
    // time, and an explicit `contentError` — exactly the visible-gap
    // semantics `accountLibrary.readEntryContent` uses for the same
    // condition on the app-entry side. A bare `break` here was the one skip
    // in this module that left no trace anywhere: not in entries, not in
    // warnings, not in evidence.
    if (remainingBudget <= 0) {
      starvedFileNames.push(file.name);
      entries.push({
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        webViewLink: file.webViewLink,
        content: null,
        truncated: true,
        contentError: 'content budget exhausted',
      });
      continue;
    }

    // Per-entry ceiling as well as the lane-wide one: without it, a single
    // 12 KB markdown drop consumes the whole operator budget and starves
    // every later file. Same `MAX_ENTRY_CONTENT_BYTES` the app-entry path
    // applies, so neither origin can monopolize the shared ceiling.
    const perFileBudget = Math.min(MAX_ENTRY_CONTENT_BYTES, remainingBudget);
    const body = await resolveFileText(
      reader,
      file,
      perFileBudget,
      isGoogleDoc,
      nowMs,
      deps.signal,
    );
    if (body.text !== null) {
      remainingBudget -= Buffer.byteLength(body.text, 'utf8');
    }

    entries.push({
      fileId: file.id,
      fileName: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      webViewLink: file.webViewLink,
      content: body.text,
      truncated: body.truncated,
      ...(body.contentError ? { contentError: body.contentError } : {}),
    });
  }

  if (starvedFileNames.length > 0) {
    warnings.push(
      `Folder drop: ${starvedFileNames.length} file(s) were listed but not read this run (content budget exhausted): ${starvedFileNames.join(', ')}`,
    );
  }

  return { laneState: 'active', entries, warnings };
}

// --- URL ingestion ("paste a link") ----------------------------------------------

/**
 * A second front door onto the same `Sources` library section the folder
 * drop feeds — this one populated by pasting a link instead of dropping a
 * file. `safeUrlFetch` (the SSRF guard) is the ONLY thing allowed to touch
 * the network here; this module's job stops at turning its HTML body into
 * plain text and handing it to `appendLibraryEntry`, the same durable-write
 * path every other library writer uses.
 */

const URL_INGEST_SECTION = 'Sources';

const BASIC_ENTITY_DECODINGS: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** The five basic HTML entities plus `&nbsp;` — deliberately not a general-purpose HTML entity decoder. */
function decodeBasicEntities(text: string): string {
  return text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (match) => BASIC_ENTITY_DECODINGS[match] ?? match);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Removes `<script>...</script>` and `<style>...</style>` blocks WHOLESALE, contents included. */
function stripScriptAndStyleBlocks(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

/** Removes tag markup only; text between tags (including any inside `<title>`) is left in place. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

/**
 * Order matters, in both directions:
 *
 * 1. Strip real markup FIRST, then decode entities. Decoding first would
 *    turn escaped text like `&lt;script&gt;` into a literal `<script>` tag
 *    that the strip pass would then wrongly treat as real markup content to
 *    remove wholesale (losing the visible-escaped text a page author meant
 *    to display, e.g. a code sample).
 * 2. Strip AGAIN, after decoding. Decoding is exactly what can materialize
 *    NEW tag syntax that did not exist as real markup on the source page —
 *    a page that visibly displays `&lt;script&gt;alert(1)&lt;/script&gt;` as
 *    text decodes to the literal string `<script>alert(1)</script>`, which
 *    is live, renderable tag syntax if left in a stored entry. The library
 *    entry this produces is "evidence" a mission reasons over and a human
 *    may later render — it must be inert BY CONSTRUCTION, not merely safe
 *    because today's one HTML-rendering surface happens to re-escape it.
 *    This second pass accepts a small amount of prose lossiness (a decoded
 *    "a < b" also gets stripped) as the price of never storing live markup
 *    syntax, decoded or otherwise.
 */
function extractPlainText(html: string): string {
  const withoutScriptsAndStyles = stripScriptAndStyleBlocks(html);
  const withoutTags = stripTags(withoutScriptsAndStyles);
  const decoded = decodeBasicEntities(withoutTags);
  const reNeutralized = stripTags(decoded);
  return collapseWhitespace(reNeutralized);
}

function extractPageTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = collapseWhitespace(decodeBasicEntities(stripTags(match[1])));
  return title || null;
}

/**
 * Same UTF-8-safe truncation convention `sourceParsing.ts`'s `capToByteLimit`
 * uses: `Buffer#write` never writes a partial multi-byte sequence, so the
 * returned text's byte length is always <= maxBytes.
 */
function capToByteLength(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const safeMax = Math.max(0, maxBytes);
  const bounded = Buffer.alloc(safeMax);
  const written = bounded.write(text, 0, safeMax, 'utf8');
  return bounded.toString('utf8', 0, written);
}

export type IngestUrlIntoLibraryResult =
  | { ok: true; fileName: string; sourceUrl: string }
  | { ok: false; code: 'invalid_url' | 'fetch_blocked' | 'fetch_failed' | 'write_failed'; message: string };

/**
 * Fetch a URL through the SSRF guard, reduce it to plain text, and append it
 * as a dated entry in the workspace's `Sources` library section.
 *
 * Deliberately validates scheme up front (before calling `fetchUrl` at all)
 * so an obviously malformed input never even reaches the network guard —
 * not a correctness requirement (`safeUrlFetch` would refuse it anyway with
 * the same `invalid_url` reason), just one fewer async hop for the common
 * "empty paste" and "not a URL" mistakes.
 */
export async function ingestUrlIntoLibrary(
  input: { workspaceId: string; url: string },
  deps: LibrarySweepDeps & { fetchUrl?: typeof safeUrlFetch } = {},
): Promise<IngestUrlIntoLibraryResult> {
  const trimmedUrl = typeof input.url === 'string' ? input.url.trim() : '';
  if (!trimmedUrl) {
    return { ok: false, code: 'invalid_url', message: 'A URL is required.' };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    return { ok: false, code: 'invalid_url', message: 'That does not look like a valid URL.' };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, code: 'invalid_url', message: 'Only http and https links can be added to the library.' };
  }

  // From here on, every downstream use (the actual fetch, the front matter,
  // the returned `sourceUrl`, and the caller's audit-log host derivation in
  // server.ts) reads from `parsedUrl.href` — the URL parser's OWN normalized
  // serialization — never from the raw `trimmedUrl` input string. The WHATWG
  // URL parser silently strips embedded ASCII tab/newline/carriage-return
  // characters while validating, but a naive `${trimmedUrl}` interpolation
  // into the front matter would still write the ORIGINAL, unstripped string
  // — letting an embedded newline inject a forged extra front-matter line
  // (e.g. a second `source_url:` key) into what is meant to be a trusted,
  // machine-parsed header. `href` is provably single-line and fully escaped.
  const normalizedUrl = parsedUrl.href;

  const fetchUrl = deps.fetchUrl ?? safeUrlFetch;
  const fetched = await fetchUrl(normalizedUrl);
  if (!fetched.ok) {
    if (fetched.reason === 'invalid_url') {
      return { ok: false, code: 'invalid_url', message: 'That does not look like a valid URL.' };
    }
    if (fetched.reason === 'fetch_failed') {
      return { ok: false, code: 'fetch_failed', message: 'That link could not be reached.' };
    }
    // 'blocked_address' | 'too_many_redirects' | 'too_large' are all the SSRF
    // guard refusing the fetch, not an ordinary network hiccup — the operator
    // should hear "blocked", never "try again".
    return { ok: false, code: 'fetch_blocked', message: 'That link could not be safely fetched.' };
  }

  const title = extractPageTitle(fetched.body) || parsedUrl.hostname;
  const bodyText = capToByteLength(extractPlainText(fetched.body), MAX_ENTRY_CONTENT_BYTES);
  const now = deps.now ? deps.now() : new Date();
  const frontMatter = `---\nsource_url: ${normalizedUrl}\nfetched_at: ${now.toISOString()}\n---\n\n`;
  const markdown = `${frontMatter}${bodyText}`;

  const appended = await appendLibraryEntry(
    input.workspaceId,
    URL_INGEST_SECTION,
    { title, markdown },
    { execute: deps.execute, now: deps.now },
  );

  if (isLibraryFailure(appended)) {
    return { ok: false, code: 'write_failed', message: appended.message };
  }

  return { ok: true, fileName: appended.fileName, sourceUrl: normalizedUrl };
}

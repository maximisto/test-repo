/**
 * Account memory — the intelligence library.
 *
 * A mission that researches the same question every week and starts from a
 * blank page every week is a search box on a timer. The library is what turns
 * repetition into compounding: each run READS what Violema already knows about
 * this account, reasons about the delta, and WRITES back what it learned.
 *
 * THE DAY-ONE ONBOARDING STORY
 *
 *   1. The customer connects Google Drive (one OAuth, on /integrations).
 *   2. Their first mission run reads the library, finds it empty, and says so
 *      honestly — no prior findings, so this run is the baseline.
 *   3. That run appends its findings, creating `Violema Library/<Section>/` in
 *      the customer's own Drive.
 *   4. Every run after that opens with real prior context: "here is what we
 *      knew, here is what changed." By week four the mission is reasoning
 *      about a trend line no fresh web search could reconstruct.
 *
 * WHY THE CUSTOMER'S DRIVE, NOT OUR DATABASE
 *
 * The library is the customer's own institutional memory, so it lives in
 * storage they own, can read without us, can audit, and can take with them if
 * they leave. That is a deliberate trust position, not a storage shortcut. It
 * also means the folder is a product surface: a founder can open
 * `Violema Library/Competitive Intelligence/` and read the whole history as
 * plain markdown files, with no Violema login.
 *
 * WHY NO CACHED FOLDER ID
 *
 * The obvious optimization is to cache the folder id in workspace settings.
 * This module deliberately does not, and resolves the folder against Drive on
 * every call instead. Drive is the system of record here — the customer can
 * rename, move, or delete the folder at any time, and a cached id that has
 * quietly gone stale is the single most dangerous state this module could
 * hold, because the operation it feeds is a WRITE. Resolution costs one extra
 * find per call on a weekly mission, which is not a price worth paying a
 * correctness risk to avoid. If that ever shows up in latency, the right fix
 * is a short-lived in-process memo (the `readConnectedAppsWithCache` pattern
 * in composioBridge), not durable persistence of another system's id.
 *
 * MISSION-AGNOSTIC BY CONSTRUCTION
 *
 * Nothing here knows what a competitor is. A "section" is just a named
 * subfolder, so any mission — weekly founder update, customer health, hiring
 * pipeline — adopts the library by naming a section in its step inputs. No new
 * code is required to add one.
 *
 * NOTION / STRUCTURED BACKENDS — deliberately not built
 *
 * Notion is a credible second backend behind this same interface: sections map
 * to databases and entries to pages, which would buy queryable structure that
 * flat markdown files do not have. It is not built because Drive is the
 * connected surface today and a second backend before the first one has users
 * is speculative. Note also what is explicitly OUT of scope: coupling this to
 * any personal knowledge vault. The library is customer-owned storage for a
 * customer's own account memory — it must never read from, write to, or depend
 * on an operator's private notes.
 *
 * TRUST FLOOR
 *
 * - Fails closed. Drive not connected means an honest blocker naming Google
 *   Drive, never a silently skipped step and never invented library content.
 * - Reads never write. `readLibrary` only ever looks; the folder is created by
 *   `appendLibraryEntry`, which is already an audited external action. A read
 *   step must not mutate the customer's Drive as a side effect.
 * - Writes stay inside the library. Every create is parented to a folder id
 *   this module resolved under `Violema Library`; a write is refused outright
 *   rather than falling back to the Drive root.
 * - Bounded. Reads cap entry count, per-entry bytes, and total bytes, so a
 *   large library can never flood a model prompt or this process's memory.
 *
 * VERIFIED COMPOSIO ACTIONS (checked against the live tool registry, not docs —
 * all present and non-deprecated on toolkit `googledrive`):
 *
 *   GOOGLEDRIVE_FIND_FILE           q, fields, orderBy, pageSize, spaces
 *                                   -> { files: [{ id, name, ... }] }
 *   GOOGLEDRIVE_CREATE_FOLDER       name (required), parent_id
 *                                   -> { id }
 *   GOOGLEDRIVE_CREATE_FILE_FROM_TEXT
 *                                   file_name + text_content (required),
 *                                   mime_type, parent_id  -> { id, name }
 *   GOOGLEDRIVE_DOWNLOAD_FILE       fileId (required), mime_type
 *                                   -> { downloaded_file_content: { s3url } }
 *
 * Note `GOOGLEDRIVE_DOWNLOAD_FILE` does NOT return file text inline — it
 * returns a presigned S3 URL that must be fetched separately. That is why this
 * module carries a bounded `fetchText` dependency at all.
 */

import {
  classifyFailure as classifyPartnerFailure,
  type PartnerComposioExecutor,
} from './adapters/partnerComposio';
import { executeComposioAction } from '../composioBridge';
import { toolkitForPartnerSource } from './partnerAppMap';
import type { IntegrationQuerySuccess, IntegrationReadinessError } from './types';
import {
  getFolderDropLaneState,
  sweepOperatorFiles,
  LibrarySweepError,
  type FolderDropLaneState,
  type LibrarySweepResult,
} from './librarySweep';

/** The query-step source name a mission uses to reach the library. */
export const ACCOUNT_LIBRARY_SOURCE = 'account_library';

/**
 * The integration the library is actually built on. Readiness blockers,
 * provenance, and connect routes all name Google Drive rather than the
 * `account_library` capability, because Google Drive is the thing a founder
 * connects and the thing that genuinely holds the data.
 */
export const ACCOUNT_LIBRARY_BACKING_SOURCE = 'google_drive';

export const ACCOUNT_LIBRARY_READ_QUERY_TYPE = 'read';
export const ACCOUNT_LIBRARY_WRITE_QUERY_TYPE = 'write';

/** Root folder created in the customer's Drive. One per workspace. */
export const LIBRARY_ROOT_FOLDER_NAME = 'Violema Library';

/** The section the competitor monitor writes to. Sections are just subfolders. */
export const COMPETITIVE_INTELLIGENCE_SECTION = 'Competitive Intelligence';

/**
 * Where the weekly founder brief files itself, so the next one can open with
 * what changed rather than restating the week from zero.
 */
export const FOUNDER_BRIEF_SECTION = 'Founder Briefs';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const ENTRY_MIME_TYPE = 'text/markdown';
const ENTRY_FILE_EXTENSION = '.md';

const FIND_FILE_ACTION = 'GOOGLEDRIVE_FIND_FILE';
const CREATE_FOLDER_ACTION = 'GOOGLEDRIVE_CREATE_FOLDER';
const CREATE_FILE_FROM_TEXT_ACTION = 'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT';
const DOWNLOAD_FILE_ACTION = 'GOOGLEDRIVE_DOWNLOAD_FILE';

export const DEFAULT_LIBRARY_READ_LIMIT = 3;
export const MAX_LIBRARY_READ_LIMIT = 10;

/** Per-entry and whole-response ceilings on extracted text. */
export const MAX_ENTRY_CONTENT_BYTES = 8_000;
export const MAX_TOTAL_CONTENT_BYTES = 24_000;

/** Upper bound on a single appended entry, well under Drive's 10MB text limit. */
export const MAX_ENTRY_MARKDOWN_BYTES = 200_000;

const DOWNLOAD_TIMEOUT_MS = 10_000;

/** Bounded text fetch for a presigned download URL. */
export type LibraryFetchText = (url: string, maxBytes: number) => Promise<string>;

export interface AccountLibraryDeps {
  /** Composio executor seam. Defaults to the real bridge; tests inject a fake. */
  execute?: PartnerComposioExecutor;
  /** Presigned-URL reader seam. Defaults to a bounded global fetch. */
  fetchText?: LibraryFetchText;
  now?: () => Date;
}

export interface AccountLibraryEntry {
  fileId: string;
  fileName: string;
  /** Entry date parsed from the file name, when it follows the dated convention. */
  entryDate?: string;
  modifiedTime?: string;
  webViewLink?: string;
  /** Extracted text, truncated to the byte ceilings. Null when unreadable. */
  content: string | null;
  truncated: boolean;
  /** Set when this entry's body could not be read, so the gap is visible. */
  contentError?: string;
  /**
   * Which reader saw this file: the platform folder-drop sweep
   * (`operator_file`) or the workspace's own Composio grant (`app_entry`).
   * Optional and additive — absent means legacy, pre-sweep behavior.
   */
  origin?: 'operator_file' | 'app_entry';
}

export interface AccountLibrarySnapshot {
  section: string;
  rootFolderName: string;
  /** False on the very first run, before any entry has created the folder. */
  libraryInitialized: boolean;
  folderId: string | null;
  entryCount: number;
  entries: AccountLibraryEntry[];
  /**
   * The folder-drop sweep's own verdict for this read: whether the platform
   * reader could see the library folder at all, and any named skips
   * (unsupported file, share problem, cap). Optional and additive.
   */
  sweep?: { laneState: FolderDropLaneState; warnings: string[] };
}

export interface AccountLibraryAppendResult {
  ok: true;
  section: string;
  folderId: string;
  fileId: string;
  fileName: string;
  /** False when an identical entry already existed — a rerun, not a duplicate. */
  created: boolean;
}

export interface EnsureLibraryFolderResult {
  ok: true;
  rootFolderId: string;
  folderId: string;
  /** True when this call created either folder. */
  createdFolder: boolean;
}

type LibraryFailure = IntegrationReadinessError;

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

/**
 * Every failure exits through here, so the customer always gets the same
 * honest instruction: connect Google Drive. `can_continue` is false because a
 * library step that silently no-ops would leave the mission reasoning against
 * context it never actually read.
 */
function libraryFailure(
  code: IntegrationReadinessError['code'],
  detail?: string,
): LibraryFailure {
  const scopeFailure = code === 'integration_scope_insufficient';
  const notReady = code === 'integration_not_ready' || code === 'integration_not_connected';

  return {
    ok: false,
    code,
    source: ACCOUNT_LIBRARY_BACKING_SOURCE,
    message: notReady
      ? "Google Drive must be connected before Violema can read or update this account's intelligence library."
      : scopeFailure
        ? 'Google Drive is connected but needs file read and write access to maintain the intelligence library.'
        : detail
          ? `Violema could not reach the intelligence library in Google Drive right now. ${detail}`
          : 'Violema could not reach the intelligence library in Google Drive right now.',
    can_continue: false,
    nextAction: {
      label: notReady
        ? 'Connect Google Drive'
        : scopeFailure
          ? 'Reauthorize Google Drive'
          : 'Retry Google Drive',
      route: `/integrations?provider=${ACCOUNT_LIBRARY_BACKING_SOURCE}`,
    },
  };
}

export function isLibraryFailure(
  value:
    | EnsureLibraryFolderResult
    | AccountLibraryAppendResult
    | ProvisionLibraryResult
    | LibraryStatus
    | LibraryFailure,
): value is LibraryFailure {
  return (value as { ok?: unknown }).ok === false;
}

/**
 * The Composio toolkit the library is actually stored in.
 *
 * `ACCOUNT_LIBRARY_BACKING_SOURCE` is the Violema *source id* (`google_drive`);
 * this is the *toolkit slug* (`googledrive`) that Composio and the capability
 * report speak. Resolved through `partnerAppMap` rather than written twice.
 */
export const ACCOUNT_LIBRARY_DRIVE_TOOLKIT = toolkitForPartnerSource('google_drive');

/**
 * The same honest refusal the run path produces, available to surfaces that
 * refuse *before* touching Drive — so "Connect Google Drive" and "Reauthorize
 * Google Drive" are worded identically wherever a founder meets them.
 */
export function buildLibraryAccessFailure(
  code: IntegrationReadinessError['code'],
  detail?: string,
): LibraryFailure {
  return libraryFailure(code, detail);
}

/**
 * Run one Drive action. Never throws: a rejected promise, a malformed
 * response, or `successful !== true` all become a classified failure, so no
 * caller can mistake an outage for an empty library.
 */
async function runDriveAction(
  execute: PartnerComposioExecutor,
  workspaceId: string,
  actionName: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; failure: LibraryFailure }> {
  try {
    const response = await execute(actionName, input, { entityId: workspaceId });
    if (!isRecord(response)) {
      return { ok: false, failure: libraryFailure('integration_query_failed') };
    }
    const envelope = response as ComposioEnvelope;
    if (envelope.successful !== true) {
      return {
        ok: false,
        failure: libraryFailure(classifyPartnerFailure(envelope.error ?? 'drive action failed')),
      };
    }
    return { ok: true, data: envelope.data };
  } catch (error) {
    return { ok: false, failure: libraryFailure(classifyPartnerFailure(error)) };
  }
}

/** Drive query strings are single-quoted, so quotes and backslashes must escape. */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function readDriveFiles(payload: unknown): Record<string, unknown>[] {
  const container = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const raw = Array.isArray(container)
    ? container
    : isRecord(container) && Array.isArray(container.files)
      ? container.files
      : [];
  return raw.filter(isRecord);
}

/**
 * Find one folder by exact name, optionally within a parent.
 *
 * Uses FIND_FILE rather than FIND_FOLDER deliberately: FIND_FILE takes a raw
 * Drive `q`, which lets us pin mimeType, parent, and trashed state exactly.
 * FIND_FOLDER's name matching is looser, and "loose" is the wrong property for
 * the lookup that decides where we are about to write.
 */
async function findFolderRecord(
  execute: PartnerComposioExecutor,
  workspaceId: string,
  name: string,
  parentId?: string,
): Promise<
  | { ok: true; folder: { id: string; webViewLink?: string } | null }
  | { ok: false; failure: LibraryFailure }
> {
  const clauses = [
    `mimeType = '${FOLDER_MIME_TYPE}'`,
    `name = '${escapeDriveQueryValue(name)}'`,
    'trashed = false',
  ];
  if (parentId) clauses.push(`'${escapeDriveQueryValue(parentId)}' in parents`);

  const result = await runDriveAction(execute, workspaceId, FIND_FILE_ACTION, {
    q: clauses.join(' and '),
    // `webViewLink` rides along so provisioning can deep-link the customer
    // straight to the folder in Drive without a second lookup. Metadata only —
    // no file contents are requested here.
    fields: 'files(id,name,createdTime,webViewLink)',
    // Oldest first: if a customer ever ends up with two same-named folders,
    // every run must keep choosing the same one.
    orderBy: 'createdTime',
    pageSize: 10,
    spaces: 'drive',
  });
  if (!result.ok) return result;

  const folder = readDriveFiles(result.data)
    .map((file) => {
      const id = asString(file.id);
      if (!id) return null;
      const webViewLink = asString(file.webViewLink);
      return { id, ...(webViewLink ? { webViewLink } : {}) };
    })
    .find((entry): entry is { id: string; webViewLink?: string } => entry !== null);

  return { ok: true, folder: folder ?? null };
}

/** Id-only wrapper, for the callers that never needed the link. */
async function findFolderByName(
  execute: PartnerComposioExecutor,
  workspaceId: string,
  name: string,
  parentId?: string,
): Promise<{ ok: true; folderId: string | null } | { ok: false; failure: LibraryFailure }> {
  const result = await findFolderRecord(execute, workspaceId, name, parentId);
  if (!result.ok) return result;
  return { ok: true, folderId: result.folder?.id ?? null };
}

async function createFolder(
  execute: PartnerComposioExecutor,
  workspaceId: string,
  name: string,
  parentId?: string,
): Promise<{ ok: true; folderId: string } | { ok: false; failure: LibraryFailure }> {
  const input: Record<string, unknown> = { name };
  if (parentId) input.parent_id = parentId;

  const result = await runDriveAction(execute, workspaceId, CREATE_FOLDER_ACTION, input);
  if (!result.ok) return result;

  const container =
    isRecord(result.data) && isRecord(result.data.data) ? result.data.data : result.data;
  const folderId = isRecord(container) ? asString(container.id) : undefined;
  if (!folderId) {
    return {
      ok: false,
      failure: libraryFailure('integration_query_failed', 'Drive did not return a folder id.'),
    };
  }
  return { ok: true, folderId };
}

export type FindLibraryRootFolderResult =
  | { ok: true; folderId: string | null }
  | { ok: false; failure: LibraryFailure };

/**
 * Read-only lookup of the workspace's `Violema Library` root folder id, for
 * callers (the folder-drop lane API) that only need the id — not a full
 * library read.
 *
 * The result is discriminated because "the folder does not exist" and "the
 * lookup could not run" are different facts with different owners. Only a
 * WORKING lookup that comes back empty may report confirmed absence
 * (`ok: true, folderId: null` → the lane reads as `no_library_yet`). A
 * failed lookup used to fold into the same `null`, which dressed a platform
 * outage in onboarding copy — HTTP 200 "run your first mission" while
 * Composio was down.
 *
 * One deliberate exception keeps absence honest rather than alarmist: a
 * workspace with no usable Drive lane at all (`integration_not_ready` /
 * `integration_not_connected` — no connected account, or the Composio
 * bridge itself is off) cannot have an app-created library, so that case IS
 * confirmed absence, not an outage.
 */
export async function findLibraryRootFolderId(
  workspaceId: string,
  deps: AccountLibraryDeps = {},
): Promise<FindLibraryRootFolderResult> {
  if (!workspaceId.trim()) return { ok: true, folderId: null };
  const execute = deps.execute ?? executeComposioAction;
  const result = await findFolderByName(execute, workspaceId, LIBRARY_ROOT_FOLDER_NAME);
  if (result.ok) return { ok: true, folderId: result.folderId };
  if (
    result.failure.code === 'integration_not_ready' ||
    result.failure.code === 'integration_not_connected'
  ) {
    return { ok: true, folderId: null };
  }
  return { ok: false, failure: result.failure };
}

async function findOrCreateFolder(
  execute: PartnerComposioExecutor,
  workspaceId: string,
  name: string,
  parentId?: string,
): Promise<
  { ok: true; folderId: string; created: boolean } | { ok: false; failure: LibraryFailure }
> {
  const found = await findFolderByName(execute, workspaceId, name, parentId);
  if (!found.ok) return found;
  if (found.folderId) return { ok: true, folderId: found.folderId, created: false };

  const created = await createFolder(execute, workspaceId, name, parentId);
  if (!created.ok) return created;
  return { ok: true, folderId: created.folderId, created: true };
}

function normalizeSection(section: string): string {
  return section.trim().replace(/\s+/g, ' ');
}

/**
 * Resolve `Violema Library/<section>/` in this workspace's Drive, creating
 * either folder if missing.
 *
 * `entityId` is the workspaceId, so Composio resolves the OAuth credential of
 * the workspace that owns the run. One tenant can never resolve into another
 * tenant's Drive.
 */
export async function ensureLibraryFolder(
  workspaceId: string,
  section: string,
  deps: AccountLibraryDeps = {},
): Promise<EnsureLibraryFolderResult | LibraryFailure> {
  const normalizedSection = normalizeSection(section);
  if (!workspaceId.trim()) {
    return libraryFailure('integration_not_connected');
  }
  if (!normalizedSection) {
    return libraryFailure('unsupported_query', 'No library section was named.');
  }

  const execute = deps.execute ?? executeComposioAction;

  const root = await findOrCreateFolder(execute, workspaceId, LIBRARY_ROOT_FOLDER_NAME);
  if (!root.ok) return root.failure;

  const sectionFolder = await findOrCreateFolder(
    execute,
    workspaceId,
    normalizedSection,
    root.folderId,
  );
  if (!sectionFolder.ok) return sectionFolder.failure;

  return {
    ok: true,
    rootFolderId: root.folderId,
    folderId: sectionFolder.folderId,
    createdFolder: root.created || sectionFolder.created,
  };
}

/**
 * Provision the library during setup instead of on first write.
 *
 * The folder used to appear lazily, the first time a mission wrote an entry.
 * That made setup feel like nothing had happened, and it meant the first sign a
 * Drive connection lacked write access was a failed run. Creating the folders
 * during connect turns that into an immediate, visible, checkable outcome — the
 * founder can open the folder in Drive and rename it before any mission runs.
 *
 * Idempotent: existing folders are reused, never duplicated. `createdFolder`
 * reports whether this call actually made anything.
 */
export interface ProvisionLibraryResult {
  ok: true;
  /** The `Violema Library` root — what the UI deep-links to. */
  folderId: string;
  folderName: string;
  webViewLink?: string;
  /** True when this call created the root or the section. */
  createdFolder: boolean;
  section: {
    name: string;
    folderId: string;
    webViewLink?: string;
  };
}

export async function provisionLibrarySection(
  workspaceId: string,
  section: string = COMPETITIVE_INTELLIGENCE_SECTION,
  deps: AccountLibraryDeps = {},
): Promise<ProvisionLibraryResult | LibraryFailure> {
  const ensured = await ensureLibraryFolder(workspaceId, section, deps);
  // Fail closed: `ensureLibraryFolder` stops at the first failure rather than
  // reporting a folder it did not create, and its message already names
  // "Connect Google Drive" or "Reauthorize Google Drive".
  if (isLibraryFailure(ensured)) return ensured;

  const execute = deps.execute ?? executeComposioAction;
  const normalizedSection = normalizeSection(section);

  // Best-effort links. The folders exist either way, so a link lookup that
  // fails must not turn a successful provision into an error — the UI simply
  // renders no deep link rather than a fabricated one.
  const [rootRecord, sectionRecord] = await Promise.all([
    findFolderRecord(execute, workspaceId, LIBRARY_ROOT_FOLDER_NAME),
    findFolderRecord(execute, workspaceId, normalizedSection, ensured.rootFolderId),
  ]);

  const rootLink = rootRecord.ok ? rootRecord.folder?.webViewLink : undefined;
  const sectionLink = sectionRecord.ok ? sectionRecord.folder?.webViewLink : undefined;

  return {
    ok: true,
    folderId: ensured.rootFolderId,
    folderName: LIBRARY_ROOT_FOLDER_NAME,
    ...(rootLink ? { webViewLink: rootLink } : {}),
    createdFolder: ensured.createdFolder,
    section: {
      name: normalizedSection,
      folderId: ensured.folderId,
      ...(sectionLink ? { webViewLink: sectionLink } : {}),
    },
  };
}

/**
 * How many entries the library holds and when the last one landed.
 *
 * Metadata only. `readLibrary` downloads each entry's body to build model
 * context, which is right for a mission and completely wrong for a status
 * badge: it would pull customer documents through the server every time the
 * connect page loaded. This lists file metadata and stops.
 *
 * `entryCount` is bounded by `LIBRARY_STATUS_MAX_ENTRIES`; `entryCountCapped`
 * says so, rather than reporting a capped number as if it were the total.
 */
export const LIBRARY_STATUS_MAX_ENTRIES = 50;

export interface LibraryStatus {
  provisioned: boolean;
  folderId?: string;
  entryCount?: number;
  lastEntryAt?: string;
  /** True when the library holds at least `LIBRARY_STATUS_MAX_ENTRIES` entries. */
  entryCountCapped?: boolean;
}

export async function summarizeLibrarySection(
  workspaceId: string,
  section: string = COMPETITIVE_INTELLIGENCE_SECTION,
  deps: AccountLibraryDeps = {},
): Promise<LibraryStatus | LibraryFailure> {
  const normalizedSection = normalizeSection(section);
  if (!workspaceId.trim()) return libraryFailure('integration_not_connected');
  if (!normalizedSection) return libraryFailure('unsupported_query', 'No library section was named.');

  const execute = deps.execute ?? executeComposioAction;

  const root = await findFolderByName(execute, workspaceId, LIBRARY_ROOT_FOLDER_NAME);
  if (!root.ok) return root.failure;
  if (!root.folderId) return { provisioned: false };

  const sectionFolder = await findFolderByName(
    execute,
    workspaceId,
    normalizedSection,
    root.folderId,
  );
  if (!sectionFolder.ok) return sectionFolder.failure;
  if (!sectionFolder.folderId) return { provisioned: false };

  const listing = await runDriveAction(execute, workspaceId, FIND_FILE_ACTION, {
    q: `'${escapeDriveQueryValue(sectionFolder.folderId)}' in parents and trashed = false`,
    // Note the absence of any content field, and no DOWNLOAD_FILE call below.
    fields: 'files(id,name,modifiedTime,createdTime)',
    orderBy: 'createdTime desc',
    pageSize: LIBRARY_STATUS_MAX_ENTRIES,
    spaces: 'drive',
  });
  if (!listing.ok) return listing.failure;

  const files = readDriveFiles(listing.data);
  const newest = files[0];
  const lastEntryAt = newest
    ? asString(newest.createdTime) || asString(newest.modifiedTime)
    : undefined;

  return {
    provisioned: true,
    folderId: sectionFolder.folderId,
    entryCount: files.length,
    ...(lastEntryAt ? { lastEntryAt } : {}),
    ...(files.length >= LIBRARY_STATUS_MAX_ENTRIES ? { entryCountCapped: true } : {}),
  };
}

function clampReadLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIBRARY_READ_LIMIT;
  return Math.min(MAX_LIBRARY_READ_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * Read a presigned download URL, stopping at `maxBytes`.
 *
 * Streamed rather than buffered: a library entry should be a few kilobytes,
 * but nothing about a URL guarantees that, and this process must not be
 * forced to hold an arbitrary file in memory to find out.
 */
async function defaultFetchText(url: string, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`download responded ${response.status}`);
    }
    const body = response.body;
    if (!body) return '';

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      const slice = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.length;
      if (total >= maxBytes) break;
    }
    await reader.cancel().catch(() => undefined);

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(merged);
  } finally {
    clearTimeout(timer);
  }
}

/** `2026-08-02 — Competitor snapshot.md` -> `2026-08-02`. */
function readEntryDate(fileName: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(fileName);
  return match ? match[1] : undefined;
}

async function readEntryContent(
  execute: PartnerComposioExecutor,
  fetchText: LibraryFetchText,
  workspaceId: string,
  fileId: string,
  budgetBytes: number,
): Promise<{ content: string | null; truncated: boolean; contentError?: string }> {
  if (budgetBytes <= 0) {
    return { content: null, truncated: true, contentError: 'content budget exhausted' };
  }

  const download = await runDriveAction(execute, workspaceId, DOWNLOAD_FILE_ACTION, { fileId });
  if (!download.ok) {
    return { content: null, truncated: false, contentError: 'download unavailable' };
  }

  const container =
    isRecord(download.data) && isRecord(download.data.data) ? download.data.data : download.data;
  const downloadable =
    isRecord(container) && isRecord(container.downloaded_file_content)
      ? container.downloaded_file_content
      : null;
  const s3url = downloadable ? asString(downloadable.s3url) : undefined;
  if (!s3url) {
    return { content: null, truncated: false, contentError: 'download url unavailable' };
  }

  const limit = Math.min(MAX_ENTRY_CONTENT_BYTES, budgetBytes);
  try {
    const text = await fetchText(s3url, limit);
    // Byte length, not character count — the ceiling is about transport size.
    const truncated = Buffer.byteLength(text, 'utf8') >= limit;
    return { content: text, truncated };
  } catch {
    return { content: null, truncated: false, contentError: 'content unreadable' };
  }
}

/**
 * Shown when the folder-drop lane has a working platform credential but the
 * customer's `Violema Library` folder is not (or no longer) shared with the
 * platform reader. Never shown for `not_configured` — that bucket means
 * there is nothing to re-share in the first place.
 */
export const FOLDER_DROP_NEEDS_SHARE_WARNING =
  "Folder drop is enabled but Violema's reader can no longer see your Violema Library folder — re-share it to include your dropped files.";

/**
 * Read the most recent entries in a section.
 *
 * Deliberately never creates anything. On a workspace that has never written
 * an entry the section folder does not exist yet, and the honest answer is an
 * initialized-false snapshot with zero entries — not a folder conjured as a
 * side effect of reading.
 */
export async function readLibrary(
  workspaceId: string,
  section: string,
  options: { limit?: number } = {},
  deps: AccountLibraryDeps = {},
): Promise<IntegrationQuerySuccess<AccountLibrarySnapshot> | LibraryFailure> {
  const normalizedSection = normalizeSection(section);
  if (!workspaceId.trim()) return libraryFailure('integration_not_connected');
  if (!normalizedSection) return libraryFailure('unsupported_query', 'No library section was named.');

  const execute = deps.execute ?? executeComposioAction;
  const fetchText = deps.fetchText ?? defaultFetchText;
  const now = deps.now ? deps.now() : new Date();
  const startedAt = Date.now();
  const limit = clampReadLimit(options.limit);

  const root = await findFolderByName(execute, workspaceId, LIBRARY_ROOT_FOLDER_NAME);
  if (!root.ok) return root.failure;

  // Folder-drop hook: a second, platform-owned reader sees operator-dropped
  // files the Composio `drive.file` grant above never can. Orchestration —
  // the discriminator, pagination, memo, per-file bounds — all lives in
  // `librarySweep`; this call site only decides when to ask and folds the
  // answer into the entries this section read returns. Operator entries are
  // capped to half the total content budget, so a heavy drop can never crowd
  // out every app-written entry.
  const rootFolderId = root.folderId;
  const probedLaneState = await getFolderDropLaneState(rootFolderId);
  // The probe above and the sweep below each run their own access check —
  // two separate Drive calls, so access can be revoked (or a platform
  // failure can begin) between them. When both ran, the sweep's verdict is
  // the LATER fact and the one the returned entries were actually gated by,
  // so it is authoritative: reporting the probe's stale 'active' alongside
  // an empty degraded sweep would be silent evidence omission.
  let laneState = probedLaneState;
  const sweepWarnings: string[] = [];
  let operatorEntries: AccountLibraryEntry[] = [];
  if (probedLaneState === 'active' && rootFolderId) {
    let sweepResult: LibrarySweepResult;
    try {
      sweepResult = await sweepOperatorFiles(
        { workspaceId, rootFolderId, budgetBytes: Math.floor(MAX_TOTAL_CONTENT_BYTES / 2) },
        { execute },
      );
    } catch (error) {
      if (!(error instanceof LibrarySweepError)) throw error;
      return libraryFailure('integration_query_failed', 'Folder-drop listing could not complete.');
    }
    laneState = sweepResult.laneState;
    sweepWarnings.push(...sweepResult.warnings);
    if (sweepResult.laneState === 'needs_share') {
      sweepWarnings.push(FOLDER_DROP_NEEDS_SHARE_WARNING);
    }
    operatorEntries = sweepResult.entries.map((entry) => ({
      fileId: entry.fileId,
      fileName: entry.fileName,
      modifiedTime: entry.modifiedTime,
      webViewLink: entry.webViewLink,
      content: entry.content,
      truncated: entry.truncated,
      origin: 'operator_file' as const,
      ...(entry.contentError ? { contentError: entry.contentError } : {}),
    }));
  } else if (probedLaneState === 'needs_share') {
    sweepWarnings.push(FOLDER_DROP_NEEDS_SHARE_WARNING);
  }
  const sweep = { laneState, warnings: sweepWarnings };
  const operatorBytesUsed = operatorEntries.reduce(
    (total, entry) => total + (entry.content ? Buffer.byteLength(entry.content, 'utf8') : 0),
    0,
  );

  let folderId: string | null = null;
  if (root.folderId) {
    const sectionFolder = await findFolderByName(
      execute,
      workspaceId,
      normalizedSection,
      root.folderId,
    );
    if (!sectionFolder.ok) return sectionFolder.failure;
    folderId = sectionFolder.folderId;
  }

  if (!folderId) {
    return librarySnapshotResult(
      {
        section: normalizedSection,
        rootFolderName: LIBRARY_ROOT_FOLDER_NAME,
        libraryInitialized: false,
        folderId: null,
        entryCount: operatorEntries.length,
        entries: operatorEntries,
        sweep,
      },
      now,
      startedAt,
    );
  }

  const listing = await runDriveAction(execute, workspaceId, FIND_FILE_ACTION, {
    q: `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`,
    fields: 'files(id,name,modifiedTime,createdTime,webViewLink),nextPageToken',
    orderBy: 'createdTime desc',
    pageSize: limit,
    spaces: 'drive',
  });
  if (!listing.ok) return listing.failure;

  const files = readDriveFiles(listing.data).slice(0, limit);
  const appEntries: AccountLibraryEntry[] = [];
  // App entries fill whatever budget the operator sweep above left behind, so
  // the two origins share one ceiling instead of each getting a full one.
  let remainingBudget = Math.max(0, MAX_TOTAL_CONTENT_BYTES - operatorBytesUsed);

  for (const file of files) {
    const fileId = asString(file.id);
    const fileName = asString(file.name);
    if (!fileId || !fileName) continue;

    const body = await readEntryContent(execute, fetchText, workspaceId, fileId, remainingBudget);
    if (body.content) {
      remainingBudget -= Buffer.byteLength(body.content, 'utf8');
    }

    appEntries.push({
      fileId,
      fileName,
      entryDate: readEntryDate(fileName),
      modifiedTime: asString(file.modifiedTime),
      webViewLink: asString(file.webViewLink),
      content: body.content,
      truncated: body.truncated,
      origin: 'app_entry' as const,
      ...(body.contentError ? { contentError: body.contentError } : {}),
    });
  }

  const entries = [...operatorEntries, ...appEntries];

  return librarySnapshotResult(
    {
      section: normalizedSection,
      rootFolderName: LIBRARY_ROOT_FOLDER_NAME,
      libraryInitialized: true,
      folderId,
      entryCount: entries.length,
      entries,
      sweep,
    },
    now,
    startedAt,
  );
}

/**
 * Provenance: the payload names `google_drive`, because that is where the
 * bytes genuinely came from. The `account_library` capability is how a mission
 * asks for the data; Google Drive is what answers, and the ledger, the origin
 * record, and the connect route should all agree on the real system.
 */
function librarySnapshotResult(
  snapshot: AccountLibrarySnapshot,
  now: Date,
  startedAt: number,
): IntegrationQuerySuccess<AccountLibrarySnapshot> {
  return {
    ok: true,
    source: ACCOUNT_LIBRARY_BACKING_SOURCE,
    query_type: 'account_library_read',
    data: snapshot,
    fetched_at: now.toISOString(),
    latency_ms: Math.max(0, Date.now() - startedAt),
    cache_hit: false,
    live: true,
  };
}

/** Drive rejects these in file names; collapse them rather than fail the run. */
function sanitizeEntryTitle(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function formatEntryDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function buildLibraryEntryFileName(title: string, now: Date): string {
  const safeTitle = sanitizeEntryTitle(title) || 'Entry';
  return `${formatEntryDate(now)} — ${safeTitle}${ENTRY_FILE_EXTENSION}`;
}

/**
 * Append one dated entry to a section, creating the library if needed.
 *
 * IDEMPOTENT per (section, date, title): the file name is derived from those
 * three, and an existing file with that name short-circuits the write. A
 * rerun of the same mission on the same day updates nothing and duplicates
 * nothing — it returns the entry that is already there with `created: false`.
 * Rerunning a mission is a normal operator action, and it must not litter a
 * customer's Drive.
 */
export async function appendLibraryEntry(
  workspaceId: string,
  section: string,
  entry: { title: string; markdown: string },
  deps: AccountLibraryDeps = {},
): Promise<AccountLibraryAppendResult | LibraryFailure> {
  const normalizedSection = normalizeSection(section);
  if (!workspaceId.trim()) return libraryFailure('integration_not_connected');
  if (!normalizedSection) return libraryFailure('unsupported_query', 'No library section was named.');

  const markdown = typeof entry.markdown === 'string' ? entry.markdown : '';
  if (!markdown.trim()) {
    // Writing an empty entry would corrupt the delta context every later run
    // reads. Better to fail the step and say why.
    return libraryFailure('unsupported_query', 'There was no drafted content to record.');
  }

  const execute = deps.execute ?? executeComposioAction;
  const now = deps.now ? deps.now() : new Date();

  const folder = await ensureLibraryFolder(workspaceId, normalizedSection, deps);
  if (isLibraryFailure(folder)) return folder;

  // Belt and braces: never issue a create without a parent resolved under
  // `Violema Library`. An unparented create would land in the customer's Drive
  // root, which is exactly the "wrote outside the library" failure.
  if (!folder.folderId) {
    return libraryFailure('integration_query_failed', 'The library folder could not be resolved.');
  }

  const fileName = buildLibraryEntryFileName(entry.title, now);

  const existing = await runDriveAction(execute, workspaceId, FIND_FILE_ACTION, {
    q: [
      `'${escapeDriveQueryValue(folder.folderId)}' in parents`,
      `name = '${escapeDriveQueryValue(fileName)}'`,
      'trashed = false',
    ].join(' and '),
    fields: 'files(id,name)',
    orderBy: 'createdTime',
    pageSize: 5,
    spaces: 'drive',
  });
  if (!existing.ok) return existing.failure;

  const existingId = readDriveFiles(existing.data)
    .map((file) => asString(file.id))
    .find((id): id is string => Boolean(id));

  if (existingId) {
    return {
      ok: true,
      section: normalizedSection,
      folderId: folder.folderId,
      fileId: existingId,
      fileName,
      created: false,
    };
  }

  const body =
    Buffer.byteLength(markdown, 'utf8') > MAX_ENTRY_MARKDOWN_BYTES
      ? `${markdown.slice(0, MAX_ENTRY_MARKDOWN_BYTES)}\n\n_[truncated by Violema]_`
      : markdown;

  const created = await runDriveAction(execute, workspaceId, CREATE_FILE_FROM_TEXT_ACTION, {
    file_name: fileName,
    text_content: body,
    mime_type: ENTRY_MIME_TYPE,
    parent_id: folder.folderId,
  });
  if (!created.ok) return created.failure;

  const container =
    isRecord(created.data) && isRecord(created.data.data) ? created.data.data : created.data;
  const fileId = isRecord(container) ? asString(container.id) : undefined;
  if (!fileId) {
    return libraryFailure('integration_query_failed', 'Drive did not return a file id.');
  }

  return {
    ok: true,
    section: normalizedSection,
    folderId: folder.folderId,
    fileId,
    fileName,
    created: true,
  };
}

/**
 * Render a library snapshot as prompt context.
 *
 * The wording matters as much as the data: an empty library must read as "this
 * is the baseline", never as an absence the model might paper over with
 * plausible-sounding history.
 */
export function renderLibraryContextMarkdown(snapshot: AccountLibrarySnapshot): string {
  if (!snapshot.libraryInitialized || snapshot.entries.length === 0) {
    return [
      `No prior ${snapshot.section} entries exist in this account's library yet.`,
      'Treat this run as the baseline: record what is true now, and do not describe changes you cannot evidence.',
    ].join(' ');
  }

  const rendered = snapshot.entries
    .map((item) => {
      const heading = `### ${item.entryDate || item.fileName}`;
      const content = item.content?.trim()
        ? item.content.trim()
        : `_(content unavailable: ${item.contentError || 'unreadable'})_`;
      return `${heading}\n${content}`;
    })
    .join('\n\n');

  return `Prior ${snapshot.section} findings already recorded for this account, newest first:\n\n${rendered}`;
}

/** True when a query step's inputs address the account library. */
export function isAccountLibraryRequest(
  inputs: Record<string, unknown> | undefined | null,
): boolean {
  const source = inputs?.source;
  return typeof source === 'string' && source.trim().toLowerCase() === ACCOUNT_LIBRARY_SOURCE;
}

/** True when a query step's inputs ask the library to record this run. */
export function isAccountLibraryWriteRequest(
  inputs: Record<string, unknown> | undefined | null,
): boolean {
  if (!isAccountLibraryRequest(inputs)) return false;
  const queryType = inputs?.query_type;
  return (
    typeof queryType === 'string'
    && queryType.trim().toLowerCase() === ACCOUNT_LIBRARY_WRITE_QUERY_TYPE
  );
}

/** Section named by a step, falling back to the competitive-intelligence default. */
export function readAccountLibrarySection(
  inputs: Record<string, unknown> | undefined | null,
): string {
  const section = inputs?.section;
  if (typeof section === 'string' && section.trim()) return normalizeSection(section);
  return COMPETITIVE_INTELLIGENCE_SECTION;
}

/** Entry title named by a step, falling back to a section-derived default. */
export function readAccountLibraryEntryTitle(
  inputs: Record<string, unknown> | undefined | null,
): string {
  const title = inputs?.entry_title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  return `${readAccountLibrarySection(inputs)} snapshot`;
}

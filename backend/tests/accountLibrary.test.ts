import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_LIBRARY_BACKING_SOURCE,
  ACCOUNT_LIBRARY_READ_QUERY_TYPE,
  ACCOUNT_LIBRARY_SOURCE,
  ACCOUNT_LIBRARY_WRITE_QUERY_TYPE,
  COMPETITIVE_INTELLIGENCE_SECTION,
  LIBRARY_ROOT_FOLDER_NAME,
  MAX_ENTRY_CONTENT_BYTES,
  appendLibraryEntry,
  buildLibraryEntryFileName,
  ensureLibraryFolder,
  findLibraryRootFolderId,
  isLibraryFailure,
  readLibrary,
  renderLibraryContextMarkdown,
  type AccountLibrarySnapshot,
} from '../src/integrationGateway/accountLibrary';
import { executeQueryData } from '../src/integrationGateway/queryData';
import { evaluateRunReadiness } from '../src/integrationGateway/runReadinessGate';
import type { PartnerComposioExecutor } from '../src/integrationGateway/adapters/partnerComposio';

interface RecordedCall {
  actionName: string;
  input: Record<string, unknown>;
  entityId: string;
}

interface FakeFolder {
  id: string;
  name: string;
  parent?: string;
}

interface FakeFile {
  id: string;
  name: string;
  parent: string;
  content: string;
}

/**
 * An in-memory stand-in for the four verified Drive actions. No network, no
 * Composio SDK, no API key — the executor is substituted wholesale, which is
 * the same seam `tests/partnerComposio.test.ts` uses.
 */
function createDriveFake(seed: { folders?: FakeFolder[]; files?: FakeFile[] } = {}) {
  const folders: FakeFolder[] = [...(seed.folders ?? [])];
  const files: FakeFile[] = [...(seed.files ?? [])];
  const calls: RecordedCall[] = [];
  let nextId = 1;

  const execute: PartnerComposioExecutor = async (actionName, input, ctx) => {
    calls.push({ actionName, input, entityId: ctx.entityId });

    if (actionName === 'GOOGLEDRIVE_FIND_FILE') {
      const q = String(input.q ?? '');
      const name = /name = '([^']*)'/.exec(q)?.[1];
      const parent = /'([^']*)' in parents/.exec(q)?.[1];
      const pageSize = Number(input.pageSize ?? 10);

      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
        const matched = folders.filter(
          (folder) => folder.name === name && (parent ? folder.parent === parent : !folder.parent),
        );
        return {
          successful: true,
          data: { files: matched.map((folder) => ({ id: folder.id, name: folder.name })) },
        };
      }

      let matched = files.filter((file) => file.parent === parent);
      if (name) matched = matched.filter((file) => file.name === name);
      if (String(input.orderBy ?? '').includes('desc')) matched = [...matched].reverse();

      return {
        successful: true,
        data: {
          files: matched.slice(0, pageSize).map((file) => ({
            id: file.id,
            name: file.name,
            modifiedTime: '2026-08-01T00:00:00.000Z',
            webViewLink: `https://drive.example/${file.id}`,
          })),
        },
      };
    }

    if (actionName === 'GOOGLEDRIVE_CREATE_FOLDER') {
      const folder: FakeFolder = {
        id: `folder_${nextId++}`,
        name: String(input.name),
        parent: input.parent_id ? String(input.parent_id) : undefined,
      };
      folders.push(folder);
      return { successful: true, data: { id: folder.id, name: folder.name } };
    }

    if (actionName === 'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT') {
      const file: FakeFile = {
        id: `file_${nextId++}`,
        name: String(input.file_name),
        parent: String(input.parent_id),
        content: String(input.text_content),
      };
      files.push(file);
      return { successful: true, data: { id: file.id, name: file.name } };
    }

    if (actionName === 'GOOGLEDRIVE_DOWNLOAD_FILE') {
      const file = files.find((item) => item.id === input.fileId);
      if (!file) return { successful: false, error: 'file not found' };
      // Mirrors the real response: content is a presigned URL, not inline text.
      return {
        successful: true,
        data: {
          id: file.id,
          name: file.name,
          downloaded_file_content: {
            name: file.name,
            mimetype: 'text/markdown',
            s3url: `https://s3.example/${file.id}`,
          },
        },
      };
    }

    return { successful: false, error: `unexpected action ${actionName}` };
  };

  const fetchText = async (url: string, maxBytes: number) => {
    const id = url.split('/').pop();
    const file = files.find((item) => item.id === id);
    if (!file) throw new Error('download missing');
    return file.content.slice(0, maxBytes);
  };

  return { execute, fetchText, calls, folders, files };
}

const FIXED_NOW = new Date('2026-08-02T09:00:00.000Z');
const now = () => FIXED_NOW;

function countCalls(calls: RecordedCall[], actionName: string) {
  return calls.filter((call) => call.actionName === actionName).length;
}

test('ensureLibraryFolder creates the library once and reuses it afterwards', async () => {
  const drive = createDriveFake();
  const deps = { execute: drive.execute, fetchText: drive.fetchText, now };

  const first = await ensureLibraryFolder('ws_acme', COMPETITIVE_INTELLIGENCE_SECTION, deps);
  assert.ok(!isLibraryFailure(first), 'Expected the first ensure to succeed.');
  assert.equal(first.createdFolder, true);

  const second = await ensureLibraryFolder('ws_acme', COMPETITIVE_INTELLIGENCE_SECTION, deps);
  assert.ok(!isLibraryFailure(second), 'Expected the second ensure to succeed.');
  assert.equal(second.createdFolder, false, 'A second ensure must not create anything.');

  // Root + section, created exactly once between the two calls.
  assert.equal(countCalls(drive.calls, 'GOOGLEDRIVE_CREATE_FOLDER'), 2);
  assert.equal(first.rootFolderId, second.rootFolderId);
  assert.equal(first.folderId, second.folderId);
  assert.equal(drive.folders.filter((f) => f.name === LIBRARY_ROOT_FOLDER_NAME).length, 1);
  assert.equal(
    drive.folders.filter((f) => f.name === COMPETITIVE_INTELLIGENCE_SECTION).length,
    1,
    'The section folder must not be duplicated.',
  );

  // The section folder is parented under the library root, never at Drive root.
  const section = drive.folders.find((f) => f.name === COMPETITIVE_INTELLIGENCE_SECTION);
  assert.equal(section?.parent, first.rootFolderId);
});

test('readLibrary never creates anything and reports an uninitialized library honestly', async () => {
  const drive = createDriveFake();
  const result = await readLibrary(
    'ws_acme',
    COMPETITIVE_INTELLIGENCE_SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText, now },
  );

  assert.ok(result.ok, 'A missing library is an empty read, not a failure.');
  const snapshot = result.data as AccountLibrarySnapshot;
  assert.equal(snapshot.libraryInitialized, false);
  assert.equal(snapshot.entryCount, 0);
  assert.deepEqual(snapshot.entries, []);
  assert.equal(
    countCalls(drive.calls, 'GOOGLEDRIVE_CREATE_FOLDER'),
    0,
    'A read step must never mutate the customer Drive.',
  );

  // The rendered context must tell the model this is a baseline, not let it
  // quietly invent a history.
  const rendered = renderLibraryContextMarkdown(snapshot);
  assert.match(rendered, /No prior/);
  assert.match(rendered, /baseline/);
});

test('readLibrary is bounded, newest-first, and stamped with live Google Drive provenance', async () => {
  const drive = createDriveFake({
    folders: [
      { id: 'root', name: LIBRARY_ROOT_FOLDER_NAME },
      { id: 'section', name: COMPETITIVE_INTELLIGENCE_SECTION, parent: 'root' },
    ],
    files: [
      { id: 'file_a', name: '2026-07-05 — Competitor snapshot.md', parent: 'section', content: 'oldest' },
      { id: 'file_b', name: '2026-07-12 — Competitor snapshot.md', parent: 'section', content: 'middle' },
      { id: 'file_c', name: '2026-07-19 — Competitor snapshot.md', parent: 'section', content: 'newer' },
      { id: 'file_d', name: '2026-07-26 — Competitor snapshot.md', parent: 'section', content: 'newest' },
    ],
  });

  const result = await readLibrary(
    'ws_acme',
    COMPETITIVE_INTELLIGENCE_SECTION,
    { limit: 2 },
    { execute: drive.execute, fetchText: drive.fetchText, now },
  );

  assert.ok(result.ok);
  // Provenance names the real system of record, so the ledger, the origin
  // record, and the connect route all agree on Google Drive.
  assert.equal(result.source, ACCOUNT_LIBRARY_BACKING_SOURCE);
  assert.equal(result.query_type, 'account_library_read');
  assert.equal(result.live, true);
  assert.equal(result.cache_hit, false);
  assert.equal(result.fetched_at, FIXED_NOW.toISOString());

  const snapshot = result.data as AccountLibrarySnapshot;
  assert.equal(snapshot.libraryInitialized, true);
  assert.equal(snapshot.entryCount, 2, 'The limit must bound how many entries come back.');
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.content),
    ['newest', 'newer'],
  );
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.entryDate),
    ['2026-07-26', '2026-07-19'],
  );

  // The entry listing, not the folder lookups (which also filter by parent).
  const listing = drive.calls.find(
    (call) =>
      call.actionName === 'GOOGLEDRIVE_FIND_FILE'
      && String(call.input.q).includes('in parents')
      && !String(call.input.q).includes('google-apps.folder'),
  );
  assert.equal(listing?.input.pageSize, 2, 'The limit must reach Drive, not just trim locally.');
});

test('readLibrary truncates an oversized entry instead of flooding the prompt', async () => {
  const oversized = 'x'.repeat(MAX_ENTRY_CONTENT_BYTES * 2);
  const drive = createDriveFake({
    folders: [
      { id: 'root', name: LIBRARY_ROOT_FOLDER_NAME },
      { id: 'section', name: COMPETITIVE_INTELLIGENCE_SECTION, parent: 'root' },
    ],
    files: [
      { id: 'file_big', name: '2026-07-26 — Competitor snapshot.md', parent: 'section', content: oversized },
    ],
  });

  const result = await readLibrary(
    'ws_acme',
    COMPETITIVE_INTELLIGENCE_SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText, now },
  );

  assert.ok(result.ok);
  const [entry] = (result.data as AccountLibrarySnapshot).entries;
  assert.equal(entry.truncated, true);
  assert.ok(
    Buffer.byteLength(entry.content ?? '', 'utf8') <= MAX_ENTRY_CONTENT_BYTES,
    'A single entry must never exceed the per-entry byte ceiling.',
  );
});

test('an unreadable entry body is reported as a gap, not silently dropped', async () => {
  const drive = createDriveFake({
    folders: [
      { id: 'root', name: LIBRARY_ROOT_FOLDER_NAME },
      { id: 'section', name: COMPETITIVE_INTELLIGENCE_SECTION, parent: 'root' },
    ],
    files: [
      { id: 'file_a', name: '2026-07-26 — Competitor snapshot.md', parent: 'section', content: 'fine' },
    ],
  });

  const result = await readLibrary(
    'ws_acme',
    COMPETITIVE_INTELLIGENCE_SECTION,
    {},
    {
      execute: drive.execute,
      fetchText: async () => {
        throw new Error('s3 unavailable');
      },
      now,
    },
  );

  assert.ok(result.ok);
  const [entry] = (result.data as AccountLibrarySnapshot).entries;
  assert.equal(entry.content, null);
  assert.equal(entry.contentError, 'content unreadable');
  assert.match(
    renderLibraryContextMarkdown(result.data as AccountLibrarySnapshot),
    /content unavailable/,
  );
});

test('appendLibraryEntry is idempotent per section, date, and title', async () => {
  const drive = createDriveFake();
  const deps = { execute: drive.execute, fetchText: drive.fetchText, now };
  const entry = { title: 'Competitor snapshot', markdown: '# Week one\n\nPricing held.' };

  const first = await appendLibraryEntry('ws_acme', COMPETITIVE_INTELLIGENCE_SECTION, entry, deps);
  assert.ok(!isLibraryFailure(first));
  assert.equal(first.created, true);
  assert.equal(first.fileName, '2026-08-02 — Competitor snapshot.md');
  assert.equal(first.fileName, buildLibraryEntryFileName(entry.title, FIXED_NOW));

  // A rerun on the same day: the operator pressing "run again" must not
  // litter the customer's Drive with duplicates.
  const second = await appendLibraryEntry('ws_acme', COMPETITIVE_INTELLIGENCE_SECTION, entry, deps);
  assert.ok(!isLibraryFailure(second));
  assert.equal(second.created, false);
  assert.equal(second.fileId, first.fileId);

  assert.equal(countCalls(drive.calls, 'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT'), 1);
  assert.equal(drive.files.length, 1);
});

test('appendLibraryEntry writes inside the library folder and only there', async () => {
  const drive = createDriveFake();
  const result = await appendLibraryEntry(
    'ws_acme',
    COMPETITIVE_INTELLIGENCE_SECTION,
    { title: 'Competitor snapshot', markdown: 'findings' },
    { execute: drive.execute, fetchText: drive.fetchText, now },
  );

  assert.ok(!isLibraryFailure(result));
  const create = drive.calls.find((call) => call.actionName === 'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT');
  assert.ok(create, 'Expected a file create.');
  assert.equal(create.input.parent_id, result.folderId, 'The entry must be parented to the section folder.');
  assert.ok(create.input.parent_id, 'An unparented create would land in the Drive root.');

  const section = drive.folders.find((folder) => folder.id === result.folderId);
  const root = drive.folders.find((folder) => folder.id === section?.parent);
  assert.equal(root?.name, LIBRARY_ROOT_FOLDER_NAME);
});

test('appendLibraryEntry refuses to record an empty draft', async () => {
  const drive = createDriveFake();
  const result = await appendLibraryEntry(
    'ws_acme',
    COMPETITIVE_INTELLIGENCE_SECTION,
    { title: 'Competitor snapshot', markdown: '   ' },
    { execute: drive.execute, fetchText: drive.fetchText, now },
  );

  assert.ok(isLibraryFailure(result), 'An empty entry would poison later delta context.');
  assert.equal(countCalls(drive.calls, 'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT'), 0);
});

test('the append result carries ids and names only, never the entry body', async () => {
  const drive = createDriveFake();
  const secretBody = '# Confidential competitive analysis\n\nAcme cut pricing to $49.';
  const result = await appendLibraryEntry(
    'ws_acme',
    COMPETITIVE_INTELLIGENCE_SECTION,
    { title: 'Competitor snapshot', markdown: secretBody },
    { execute: drive.execute, fetchText: drive.fetchText, now },
  );

  assert.ok(!isLibraryFailure(result));
  // The executor spreads this object straight into the `external_action_executed`
  // ledger metadata, so anything added here lands in the ledger. Keep it to
  // identifiers: no document body may ever reach the audit log.
  assert.deepEqual(
    Object.keys(result).sort(),
    ['created', 'fileId', 'fileName', 'folderId', 'ok', 'section'],
  );
  assert.ok(
    !JSON.stringify(result).includes('Confidential'),
    'The entry body must never appear in the ledger payload.',
  );
});

test('an unconnected Drive fails closed with an honest Connect Google Drive blocker', async () => {
  const unconnected: PartnerComposioExecutor = async () => ({
    successful: false,
    error: 'connected account not found for this entity',
  });

  const read = await readLibrary('ws_acme', COMPETITIVE_INTELLIGENCE_SECTION, {}, { execute: unconnected, now });
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.code, 'integration_not_ready');
  assert.equal(read.source, ACCOUNT_LIBRARY_BACKING_SOURCE);
  assert.equal(read.can_continue, false, 'A required library step must never be silently skipped.');
  assert.equal(read.nextAction.label, 'Connect Google Drive');
  assert.equal(read.nextAction.route, '/integrations?provider=google_drive');
  assert.ok(!/account_library/i.test(read.message), 'The blocker must name Drive, not the internal capability.');

  const write = await appendLibraryEntry(
    'ws_acme',
    COMPETITIVE_INTELLIGENCE_SECTION,
    { title: 'Competitor snapshot', markdown: 'findings' },
    { execute: unconnected, now },
  );
  assert.ok(isLibraryFailure(write));
  assert.equal(write.nextAction.route, '/integrations?provider=google_drive');
});

test('every Drive call is scoped to the calling workspace entity', async () => {
  const acme = createDriveFake();
  const globex = createDriveFake();

  await appendLibraryEntry(
    'ws_acme',
    COMPETITIVE_INTELLIGENCE_SECTION,
    { title: 'Competitor snapshot', markdown: 'acme findings' },
    { execute: acme.execute, fetchText: acme.fetchText, now },
  );
  await readLibrary(
    'ws_globex',
    COMPETITIVE_INTELLIGENCE_SECTION,
    {},
    { execute: globex.execute, fetchText: globex.fetchText, now },
  );

  assert.ok(acme.calls.length > 0 && globex.calls.length > 0);
  assert.deepEqual([...new Set(acme.calls.map((call) => call.entityId))], ['ws_acme']);
  assert.deepEqual([...new Set(globex.calls.map((call) => call.entityId))], ['ws_globex']);
});

test('executeQueryData routes account_library reads and refuses writes', async () => {
  const received: Array<{ workspaceId: string; section: string; limit?: number }> = [];

  const routed = await executeQueryData({
    workspaceId: 'ws_acme',
    source: ACCOUNT_LIBRARY_SOURCE,
    queryType: ACCOUNT_LIBRARY_READ_QUERY_TYPE,
    filters: { section: COMPETITIVE_INTELLIGENCE_SECTION },
    limit: 3,
    clientOverrides: {
      accountLibraryRead: async (workspaceId, section, options) => {
        received.push({ workspaceId, section, limit: options.limit });
        return {
          ok: true,
          source: ACCOUNT_LIBRARY_BACKING_SOURCE,
          query_type: 'account_library_read',
          data: {
            section,
            rootFolderName: LIBRARY_ROOT_FOLDER_NAME,
            libraryInitialized: false,
            folderId: null,
            entryCount: 0,
            entries: [],
          },
          fetched_at: FIXED_NOW.toISOString(),
          latency_ms: 1,
          cache_hit: false,
          live: true,
        };
      },
    },
  });

  assert.equal(routed.ok, true);
  assert.deepEqual(received, [
    { workspaceId: 'ws_acme', section: COMPETITIVE_INTELLIGENCE_SECTION, limit: 3 },
  ]);

  // A write must never travel the read path, where it would be logged as
  // `data_read` and disappear from the audit trail.
  const refused = await executeQueryData({
    workspaceId: 'ws_acme',
    source: ACCOUNT_LIBRARY_SOURCE,
    queryType: ACCOUNT_LIBRARY_WRITE_QUERY_TYPE,
  });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.code, 'unsupported_query');
  assert.equal(refused.source, ACCOUNT_LIBRARY_BACKING_SOURCE);
});

test('the run readiness gate blocks a library mission on Google Drive by name', async () => {
  const steps = [
    {
      kind: 'query',
      title: 'Read the competitive library',
      inputs: { source: ACCOUNT_LIBRARY_SOURCE, query_type: ACCOUNT_LIBRARY_READ_QUERY_TYPE },
    },
    {
      kind: 'query',
      title: 'Record findings in the library',
      inputs: { source: ACCOUNT_LIBRARY_SOURCE, query_type: ACCOUNT_LIBRARY_WRITE_QUERY_TYPE },
    },
    { kind: 'search', title: 'Search competitor moves', inputs: { query: 'competitors' } },
  ];

  const blocked = evaluateRunReadiness({
    workflowId: 'competitor-monitor',
    workspaceId: 'ws_acme',
    isDemoWorkspace: false,
    steps,
    runtimeStatus: {},
  });

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.tier, 'step_sources');
  assert.equal(blocked.blockers.length, 1, 'Two library steps are one connection to fix.');
  assert.equal(blocked.blockers[0].key, ACCOUNT_LIBRARY_BACKING_SOURCE);
  assert.equal(blocked.blockers[0].label, 'Connect Google Drive');
  assert.equal(blocked.blockers[0].route, '/integrations?provider=google_drive');
  assert.match(blocked.summary, /Google Drive/);

  const ready = evaluateRunReadiness({
    workflowId: 'competitor-monitor',
    workspaceId: 'ws_acme',
    isDemoWorkspace: false,
    steps,
    runtimeStatus: { google_drive: { ready: true } },
  });
  assert.equal(ready.allowed, true, 'A connected Drive unblocks the library mission.');
});

test('a mission naming both google_drive and account_library reports one blocker', async () => {
  const decision = evaluateRunReadiness({
    workflowId: 'competitor-monitor',
    workspaceId: 'ws_acme',
    isDemoWorkspace: false,
    steps: [
      { kind: 'query', title: 'Drive context', inputs: { source: 'google_drive', query_type: 'recent_files' } },
      {
        kind: 'query',
        title: 'Library context',
        inputs: { source: ACCOUNT_LIBRARY_SOURCE, query_type: ACCOUNT_LIBRARY_READ_QUERY_TYPE },
      },
    ],
    runtimeStatus: {},
  });

  assert.equal(decision.allowed, false);
  assert.deepEqual(
    decision.blockers.map((blocker) => blocker.key),
    [ACCOUNT_LIBRARY_BACKING_SOURCE],
    'One connection to fix must read as one blocker.',
  );
});

// --- findLibraryRootFolderId: confirmed absence vs failed lookup ---------------

test('findLibraryRootFolderId reports a found folder and a confirmed absence distinctly from failure', async () => {
  const found = createDriveFake({ folders: [{ id: 'root-1', name: LIBRARY_ROOT_FOLDER_NAME }] });
  assert.deepEqual(await findLibraryRootFolderId('ws_test', { execute: found.execute }), {
    ok: true,
    folderId: 'root-1',
  });

  // An empty listing from a WORKING lookup is the only thing allowed to mean
  // "the folder does not exist yet."
  const absent = createDriveFake();
  assert.deepEqual(await findLibraryRootFolderId('ws_test', { execute: absent.execute }), {
    ok: true,
    folderId: null,
  });
});

test('a Composio outage on the root lookup reports lookup failure, never a fresh workspace', async () => {
  // Sol's [medium] finding: every failed lookup used to fold to null, so a
  // platform outage rendered as no_library_yet — onboarding copy hiding an
  // incident. A failure that is not "this workspace has no Drive lane" must
  // surface as a failure.
  const execute: PartnerComposioExecutor = async () => {
    throw new Error('upstream unavailable');
  };
  const result = await findLibraryRootFolderId('ws_test', { execute });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, 'integration_query_failed');
});

test('a workspace with no Drive connection still reads as confirmed absence, not an outage', async () => {
  // No connected account means no app-created library can exist — that is a
  // genuine "no library yet", and the settings card should keep saying so.
  const noConnection: PartnerComposioExecutor = async () => {
    throw new Error('connected account not found for entity');
  };
  assert.deepEqual(await findLibraryRootFolderId('ws_test', { execute: noConnection }), {
    ok: true,
    folderId: null,
  });

  // Same for a server whose Composio bridge is off entirely (dev/test).
  const bridgeOff: PartnerComposioExecutor = async () => {
    throw new Error('Composio is not configured. Set COMPOSIO_API_KEY to enable.');
  };
  assert.deepEqual(await findLibraryRootFolderId('ws_test', { execute: bridgeOff }), {
    ok: true,
    folderId: null,
  });
});

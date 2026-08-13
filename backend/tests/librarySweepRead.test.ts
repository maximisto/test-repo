import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

import {
  COMPETITIVE_INTELLIGENCE_SECTION,
  MAX_TOTAL_CONTENT_BYTES,
  readLibrary,
} from '../src/integrationGateway/accountLibrary';
import {
  LibrarySweepError,
  setLibrarySweepOverridesForTests,
  type LibrarySweepResult,
} from '../src/integrationGateway/librarySweep';
import * as librarySweep from '../src/integrationGateway/librarySweep';
import { collectAutomationRunWarnings } from '../src/platform/automationLifecycle';
import type { PartnerComposioExecutor } from '../src/integrationGateway/adapters/partnerComposio';

const SECTION = COMPETITIVE_INTELLIGENCE_SECTION;
const ROOT_FOLDER_ID = 'root-1';
const SECTION_FOLDER_ID = 'section-1';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const NEEDS_SHARE_WARNING =
  "Folder drop is enabled but Violema's reader can no longer see your Violema Library folder — re-share it to include your dropped files.";

// --- fake Drive executor (root/section folder lookups + app entry files) -----

interface FakeFile {
  id: string;
  name: string;
  content: string;
}

function createFakeDrive(options: { appFiles?: FakeFile[]; rootExists?: boolean } = {}) {
  const appFiles = options.appFiles ?? [];
  const rootExists = options.rootExists ?? true;

  const execute: PartnerComposioExecutor = async (actionName, input) => {
    if (actionName === 'GOOGLEDRIVE_FIND_FILE') {
      const q = String(input.q ?? '');

      if (q.includes(`mimeType = '${FOLDER_MIME}'`)) {
        if (q.includes("name = 'Violema Library'")) {
          return rootExists
            ? { successful: true, data: { files: [{ id: ROOT_FOLDER_ID, name: 'Violema Library' }] } }
            : { successful: true, data: { files: [] } };
        }
        if (q.includes(`name = '${SECTION}'`)) {
          return { successful: true, data: { files: [{ id: SECTION_FOLDER_ID, name: SECTION }] } };
        }
        return { successful: true, data: { files: [] } };
      }

      // Entry listing inside the resolved section folder.
      return {
        successful: true,
        data: {
          files: appFiles.map((file) => ({
            id: file.id,
            name: file.name,
            modifiedTime: '2026-08-01T00:00:00.000Z',
          })),
        },
      };
    }

    if (actionName === 'GOOGLEDRIVE_DOWNLOAD_FILE') {
      const file = appFiles.find((item) => item.id === input.fileId);
      if (!file) return { successful: false, error: 'file not found' };
      return {
        successful: true,
        data: { downloaded_file_content: { s3url: `https://s3.example/${file.id}` } },
      };
    }

    return { successful: false, error: `unexpected action ${actionName}` };
  };

  const fetchText = async (url: string, maxBytes: number) => {
    const id = url.split('/').pop();
    const file = appFiles.find((item) => item.id === id);
    if (!file) throw new Error('test fixture: no content registered for ' + url);
    return file.content.slice(0, maxBytes);
  };

  return { execute, fetchText };
}

beforeEach(() => {
  setLibrarySweepOverridesForTests(null);
});

// --- readLibrary + folder-drop hook -------------------------------------------

test('operator entries precede app entries, both carry origin, and total content stays within budget', async () => {
  const operatorSweep: LibrarySweepResult = {
    laneState: 'active',
    entries: [
      {
        fileId: 'op-1',
        fileName: 'operator-notes.md',
        mimeType: 'text/markdown',
        modifiedTime: '2026-08-03T00:00:00.000Z',
        content: 'Operator dropped notes about a competitor pricing change.',
        truncated: false,
      },
    ],
    warnings: [],
  };
  setLibrarySweepOverridesForTests({ laneState: 'active', sweep: operatorSweep });

  const drive = createFakeDrive({
    appFiles: [
      { id: 'app-1', name: '2026-08-02 — Weekly snapshot.md', content: 'App-written findings from last week.' },
    ],
  });

  const result = await readLibrary(
    'ws_test',
    SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const snapshot = result.data;

  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.entries[0].fileId, 'op-1');
  assert.equal(snapshot.entries[0].origin, 'operator_file');
  assert.equal(snapshot.entries[1].fileId, 'app-1');
  assert.equal(snapshot.entries[1].origin, 'app_entry');

  const totalBytes = snapshot.entries.reduce(
    (sum, entry) => sum + (entry.content ? Buffer.byteLength(entry.content, 'utf8') : 0),
    0,
  );
  assert.ok(totalBytes <= MAX_TOTAL_CONTENT_BYTES, `expected ${totalBytes} <= ${MAX_TOTAL_CONTENT_BYTES}`);
  assert.equal(snapshot.sweep?.laneState, 'active');
  assert.deepEqual(snapshot.sweep?.warnings, []);
});

test('needs_share adds exactly the folder-drop warning and zero operator entries', async () => {
  setLibrarySweepOverridesForTests({ laneState: 'needs_share' });
  const drive = createFakeDrive({ appFiles: [] });

  const result = await readLibrary(
    'ws_test',
    SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const snapshot = result.data;

  assert.equal(
    snapshot.entries.filter((entry) => entry.origin === 'operator_file').length,
    0,
    'needs_share must never fabricate operator entries',
  );
  assert.deepEqual(snapshot.sweep?.warnings, [NEEDS_SHARE_WARNING]);
});

test('not_configured never adds a sweep warning', async () => {
  setLibrarySweepOverridesForTests({ laneState: 'not_configured' });
  const drive = createFakeDrive({ appFiles: [] });

  const result = await readLibrary(
    'ws_test',
    SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.sweep?.warnings, []);
});

test('no_library_yet never adds a sweep warning either — nothing is wrong, the library simply has not been created', async () => {
  // Distinct from not_configured: the platform reader IS working here, the
  // WORKSPACE just has no Violema Library folder yet. Neither condition is
  // an operator-actionable problem, so neither may add a warning.
  setLibrarySweepOverridesForTests({ laneState: 'no_library_yet' });
  const drive = createFakeDrive({ appFiles: [] });

  const result = await readLibrary(
    'ws_test',
    SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.sweep?.laneState, 'no_library_yet');
  assert.deepEqual(result.data.sweep?.warnings, []);
  assert.equal(
    result.data.entries.filter((entry) => entry.origin === 'operator_file').length,
    0,
    'no_library_yet must never fabricate operator entries',
  );
});

test('a sweep that degrades to needs_share after an active probe is authoritative: lane state and warning both report it', async () => {
  // The pre-read probe and the sweep's own access probe are two separate
  // Drive calls. If the operator revokes the share (or the folder becomes
  // unreadable) BETWEEN them, the sweep comes back degraded with zero
  // entries — and the read must report THAT, not the stale 'active' from
  // the first probe. Reporting active-with-no-entries here is exactly the
  // silent evidence omission the folder-drop lane exists to prevent.
  setLibrarySweepOverridesForTests({
    laneState: 'active',
    sweep: { laneState: 'needs_share', entries: [], warnings: [] },
  });
  const drive = createFakeDrive({ appFiles: [] });

  const result = await readLibrary(
    'ws_test',
    SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.sweep?.laneState, 'needs_share', 'the sweep verdict is later and must win');
  assert.deepEqual(result.data.sweep?.warnings, [NEEDS_SHARE_WARNING]);
  assert.equal(
    result.data.entries.filter((entry) => entry.origin === 'operator_file').length,
    0,
  );
});

test('a sweep that degrades to not_configured after an active probe reports not_configured with no share warning', async () => {
  // Same race, platform-side flavor: auth/timeout failures on the sweep's
  // probe land in not_configured — never the operator's problem, so no
  // re-share instruction. But the lane must still stop claiming active.
  setLibrarySweepOverridesForTests({
    laneState: 'active',
    sweep: { laneState: 'not_configured', entries: [], warnings: [] },
  });
  const drive = createFakeDrive({ appFiles: [] });

  const result = await readLibrary(
    'ws_test',
    SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.sweep?.laneState, 'not_configured');
  assert.deepEqual(result.data.sweep?.warnings, []);
});

test('a workspace whose library root does not exist yet reads as not_configured with no warning', async () => {
  // No override here: this exercises the REAL getFolderDropLaneState(null)
  // short-circuit, which returns 'not_configured' without ever touching a
  // reader when rootFolderId is null — a brand-new workspace's first-ever
  // read must never carry a spurious "re-share your folder" warning.
  const drive = createFakeDrive({ appFiles: [], rootExists: false });

  const result = await readLibrary(
    'ws_test',
    SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.libraryInitialized, false);
  assert.deepEqual(result.data.entries, []);
  assert.equal(result.data.sweep?.laneState, 'not_configured');
  assert.deepEqual(result.data.sweep?.warnings, []);
});

test('a LibrarySweepError from the sweep fails the whole read rather than misclassifying or silently dropping it', async (t) => {
  setLibrarySweepOverridesForTests({ laneState: 'active' });
  t.mock.method(librarySweep, 'sweepOperatorFiles', async () => {
    throw new LibrarySweepError('composio listing failed mid-sweep');
  });

  const drive = createFakeDrive({ appFiles: [] });
  const result = await readLibrary(
    'ws_test',
    SECTION,
    {},
    { execute: drive.execute, fetchText: drive.fetchText },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'integration_query_failed');
});

// --- collectAutomationRunWarnings (pure) --------------------------------------

test('collectAutomationRunWarnings: duplicate messages on one step dedupe to unique warnings', () => {
  const warnings = collectAutomationRunWarnings([
    {
      stepId: 'step-1',
      title: 'Read the library',
      kind: 'query',
      status: 'succeeded',
      warnings: ['a', 'a', 'b'],
    },
  ]);

  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings.map((warning) => warning.message), ['a', 'b']);
  assert.ok(warnings.every((warning) => warning.stepId === 'step-1' && warning.title === 'Read the library'));
});

test('collectAutomationRunWarnings: a failed auxiliary step still produces its warning alongside step warnings', () => {
  const warnings = collectAutomationRunWarnings([
    {
      stepId: 'step-2',
      title: 'Archive to CRM',
      kind: 'query',
      status: 'failed',
      stepSeverity: 'auxiliary',
      error: 'CRM API timed out',
    },
    {
      stepId: 'step-3',
      title: 'Read the library',
      kind: 'query',
      status: 'succeeded',
      warnings: ['share problem'],
    },
  ]);

  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings[0], { stepId: 'step-2', title: 'Archive to CRM', message: 'CRM API timed out' });
  assert.deepEqual(warnings[1], { stepId: 'step-3', title: 'Read the library', message: 'share problem' });
});

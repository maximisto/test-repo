import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * The folder-drop lane API: status (GET), verify (POST), and share (POST).
 *
 * Pinned here: all three routes are 401-first like the business-context
 * handlers; an unconfigured lane (no platform reader key) reports
 * `not_configured` and never audits; and the FIRST transition to `active`
 * fires exactly one `workspace.library_folder_share.enabled` audit event —
 * a second `verify` on an already-active lane must not fire a second one
 * (the `folderDropEnabledAt` stamp in the workspace profile's metadata bag
 * is what makes that idempotent, per server.ts's verify/share handlers).
 */

type TestServerContext = {
  baseUrl: string;
  sessionToken: string;
  workspaceId: string;
};

function closeServer(server: http.Server | null) {
  if (!server) return Promise.resolve();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// Set inside withApiServer once the relevant modules are dynamically imported
// (after chdir into the temp dir), so the module-cache instance the server
// itself uses is the same one these helpers read/write through.
let adminAccessStoreModule: typeof import('../src/adminAccessStore') | null = null;
let librarySweepModule: typeof import('../src/integrationGateway/librarySweep') | null = null;
let accountLibraryModule: typeof import('../src/integrationGateway/accountLibrary') | null = null;

/** Scoped to this endpoint's action, so assertions never depend on event ordering. */
function readFolderDropShareAuditEvents() {
  if (!adminAccessStoreModule) throw new Error('adminAccessStore module not loaded yet.');
  return adminAccessStoreModule
    .listAdminAuditEvents()
    .filter((event) => (event.action as string) === 'workspace.library_folder_share.enabled');
}

function generateTestKeypair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/** A synthetic `GOOGLE_LIBRARY_READER_KEY` value — never a real credential. */
function buildTestReaderKeyEnvValue(clientEmail: string): string {
  const { privateKey } = generateTestKeypair();
  return JSON.stringify({ client_email: clientEmail, private_key: privateKey });
}

async function withApiServer(
  options: { readerKeyEnvValue?: string },
  run: (context: TestServerContext) => Promise<void>,
) {
  const originalCwd = process.cwd();
  const originalApproved = process.env.VIOLEMA_APPROVED_EMAILS;
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalReaderKey = process.env.GOOGLE_LIBRARY_READER_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-folder-drop-api-'));

  // A fresh, unique email per `withApiServer` call — never the fixed
  // `qa@example.com` other test files use. `auth.ts`'s `USERS_FILE` (like
  // `platform/workspace.ts`'s `WORKSPACES_FILE`) is a module-level constant
  // resolved from `process.cwd()` at first import, not re-resolved per call
  // the way `adminAccessStore.ts`'s file paths are — so within ONE test
  // file's process, every `test()` block actually shares the same
  // underlying `auth-users.json` (and `platform-workspaces.json`), no
  // matter how many separate temp dirs `withApiServer` creates and tears
  // down. A fixed email would make `upsertAuthUser` find the SAME "existing"
  // user row across every test in this file, reuse its `id`, and therefore
  // reuse its derived `defaultWorkspaceId` too — silently leaking one test's
  // `folderDropEnabledAt` stamp into the next. A unique email guarantees a
  // fresh user id, and therefore a fresh, uncollided workspace, per test.
  const testEmail = `qa-${crypto.randomUUID()}@example.com`;

  process.chdir(tempDir);
  process.env.VIOLEMA_APPROVED_EMAILS = testEmail;
  process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
  if (options.readerKeyEnvValue) {
    process.env.GOOGLE_LIBRARY_READER_KEY = options.readerKeyEnvValue;
  } else {
    delete process.env.GOOGLE_LIBRARY_READER_KEY;
  }

  let server: http.Server | null = null;

  try {
    const serverModule = await import('../src/server');
    const auth = await import('../src/auth');
    const consent = await import('../src/betaConsentStore');
    const betaProgram = await import('../src/betaProgram');
    const adminAccessStore = await import('../src/adminAccessStore');
    const librarySweep = await import('../src/integrationGateway/librarySweep');
    const accountLibrary = await import('../src/integrationGateway/accountLibrary');
    adminAccessStoreModule = adminAccessStore;
    librarySweepModule = librarySweep;
    accountLibraryModule = accountLibrary;
    const acceptedAt = '2026-07-11T12:01:00.000Z';

    consent.recordBetaConsent({
      email: testEmail,
      participantType: 'founder_operator',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
      acceptedAt,
      authMethod: 'email',
      acceptanceSource: 'signup',
    });

    // Deliberately role: 'user', not 'admin'. `auth.ts`'s `upsertAuthUser`
    // gives an 'admin' user the fixed, shared `DEFAULT_WORKSPACE_ID`
    // constant as its `defaultWorkspaceId` — which would undo the
    // unique-email fix above by putting every test's user back onto the
    // SAME workspace. A 'user' role instead derives the workspace id from
    // this user's own (now-unique) id, so each test genuinely gets its own
    // workspace and its own, uncollided `folderDropEnabledAt` metadata bag.
    const user = auth.upsertAuthUser({
      email: testEmail,
      name: 'QA Operator',
      role: 'user',
      method: 'email',
      participantType: 'founder_operator',
      acceptedTerms: true,
      acceptedTermsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedTermsAt: acceptedAt,
      acceptedEducation: true,
    });
    const session = auth.createAuthSession(user.id);

    server = await new Promise<http.Server>((resolve) => {
      const listening = serverModule.default.listen(0, () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port.');

    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      sessionToken: session.token,
      workspaceId: user.defaultWorkspaceId,
    });

    auth.clearAuthSession(session.token);
  } finally {
    await closeServer(server);
    // The lane-state override is a module-level singleton (librarySweep.ts) —
    // it must never bleed from one test into the next.
    librarySweepModule?.setLibrarySweepOverridesForTests(null);
    adminAccessStoreModule = null;
    librarySweepModule = null;
    accountLibraryModule = null;
    process.chdir(originalCwd);
    if (typeof originalApproved === 'string') process.env.VIOLEMA_APPROVED_EMAILS = originalApproved;
    else delete process.env.VIOLEMA_APPROVED_EMAILS;
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalReaderKey === 'string') process.env.GOOGLE_LIBRARY_READER_KEY = originalReaderKey;
    else delete process.env.GOOGLE_LIBRARY_READER_KEY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function authHeaders(sessionToken: string) {
  return {
    cookie: `violema_session=${sessionToken}`,
    'Content-Type': 'application/json',
  };
}

test('folder-drop status/verify/share all require a session', async () => {
  await withApiServer({}, async ({ baseUrl }) => {
    const status = await fetch(`${baseUrl}/api/workspace/library/folder-drop`);
    assert.equal(status.status, 401);

    const verify = await fetch(`${baseUrl}/api/workspace/library/folder-drop/verify`, { method: 'POST' });
    assert.equal(verify.status, 401);

    const share = await fetch(`${baseUrl}/api/workspace/library/folder-drop/share`, { method: 'POST' });
    assert.equal(share.status, 401);
  });
});

test('an unconfigured folder-drop lane reports not_configured and never audits', async () => {
  await withApiServer({}, async ({ baseUrl, sessionToken }) => {
    const status = await fetch(`${baseUrl}/api/workspace/library/folder-drop`, {
      headers: authHeaders(sessionToken),
    });
    assert.equal(status.status, 200);
    const statusBody = await status.json() as Record<string, unknown>;
    assert.equal(statusBody.laneState, 'not_configured');
    assert.equal(statusBody.readerEmail, null);
    assert.equal(statusBody.rootFolderId, null);

    const verify = await fetch(`${baseUrl}/api/workspace/library/folder-drop/verify`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
    });
    assert.equal(verify.status, 200);
    const verifyBody = await verify.json() as Record<string, unknown>;
    assert.equal(verifyBody.laneState, 'not_configured');
    assert.equal(verifyBody.readerEmail, null);

    assert.equal(readFolderDropShareAuditEvents().length, 0, 'an unconfigured lane must never audit an enablement.');

    // Sharing with no reader configured must not attempt a live Composio
    // call, and must not claim manual-share is required either — there is
    // nothing to share to.
    const share = await fetch(`${baseUrl}/api/workspace/library/folder-drop/share`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
    });
    assert.equal(share.status, 200);
    const shareBody = await share.json() as Record<string, unknown>;
    assert.equal(shareBody.laneState, 'not_configured');
    assert.equal(shareBody.manualShare, undefined);
    assert.equal(readFolderDropShareAuditEvents().length, 0);
  });
});

test('a successful Drive lookup confirming no root folder reports no_library_yet', async (t) => {
  // MEASURED IN PRODUCTION: purpleorangehq and workspace_158339ffa04cc7ef both
  // have a working platform reader but no rootFolderId yet (their first
  // library write has not happened), and reported `not_configured` — which
  // blames the SERVER for a WORKSPACE-level condition. No lane-state
  // A missing Composio connection is NOT evidence of absence. This fixture
  // explicitly models the only state allowed to mean fresh workspace: a
  // successful Drive query whose result set is empty.
  const readerKeyEnvValue = buildTestReaderKeyEnvValue('reader@test.iam');

  await withApiServer({ readerKeyEnvValue }, async ({ baseUrl, sessionToken }) => {
    if (!accountLibraryModule) throw new Error('accountLibrary module not loaded yet.');
    t.mock.method(accountLibraryModule, 'findLibraryRootFolderId', async () => ({
      ok: true as const,
      folderId: null,
    }));
    const status = await fetch(`${baseUrl}/api/workspace/library/folder-drop`, {
      headers: authHeaders(sessionToken),
    });
    assert.equal(status.status, 200);
    const statusBody = await status.json() as Record<string, unknown>;
    assert.equal(statusBody.laneState, 'no_library_yet');
    assert.equal(statusBody.readerEmail, 'reader@test.iam');
    assert.equal(statusBody.rootFolderId, null);

    assert.equal(
      readFolderDropShareAuditEvents().length,
      0,
      'no_library_yet must never audit an enablement — the lane never reached active.',
    );
  });
});

test('the first transition to active audits exactly once, even across repeated verify calls', async (t) => {
  const readerKeyEnvValue = buildTestReaderKeyEnvValue('reader@test.iam');

  await withApiServer({ readerKeyEnvValue }, async ({ baseUrl, sessionToken, workspaceId }) => {
    if (!librarySweepModule) throw new Error('librarySweep module not loaded yet.');
    if (!accountLibraryModule) throw new Error('accountLibrary module not loaded yet.');
    t.mock.method(accountLibraryModule, 'findLibraryRootFolderId', async () => ({
      ok: true as const,
      folderId: 'root-folder',
    }));
    librarySweepModule.setLibrarySweepOverridesForTests({ laneState: 'active' });

    const first = await fetch(`${baseUrl}/api/workspace/library/folder-drop/verify`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as Record<string, unknown>;
    assert.equal(firstBody.laneState, 'active');
    assert.equal(firstBody.readerEmail, 'reader@test.iam');

    const second = await fetch(`${baseUrl}/api/workspace/library/folder-drop/verify`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as Record<string, unknown>;
    assert.equal(secondBody.laneState, 'active');

    const events = readFolderDropShareAuditEvents();
    assert.equal(events.length, 1, 'exactly one enablement event across both verify calls.');
    assert.equal(events[0].workspaceId, workspaceId);
    assert.deepEqual(Object.keys(events[0].metadata ?? {}), ['folderId'], 'audit metadata is content-free: folderId only.');
  });
});

/**
 * The TOCTOU fix-round-1 regression: `stampFolderDropEnabledOnFirstActivation`
 * used to accept a `currentMetadata` snapshot captured by `resolveWorkspaceContext`
 * near the top of each handler, BEFORE that handler's own `await` points
 * (Drive lookup, lane-state check, and — on `/share` — a live Composio call).
 * Two overlapping requests (e.g. a double-click, or a status poll landing
 * while a share is in flight) would each capture a snapshot showing no
 * `folderDropEnabledAt`, both pass the guard once their awaits resolved, and
 * both stamp + audit — two events for one logical transition.
 *
 * The fix re-reads the workspace profile FRESH, with no `await` between that
 * read, the guard, the `upsertWorkspaceProfile` write, and the (synchronous)
 * `recordAdminAuditEvent` call — making the whole sequence atomic on Node's
 * single-threaded event loop no matter how many other requests are in
 * flight. This test forces two requests to genuinely overlap by delaying
 * `getFolderDropLaneState` (the last `await` both `verify` and `share` take
 * before reaching the stamp call) via `t.mock.method` on the shared,
 * cached `librarySweep` module object — the same technique Task 4 used to
 * force `LibrarySweepError` through the real call path, and effective here
 * because the backend compiles to CommonJS, so `server.ts`'s import resolves
 * to a property lookup on this exact object at each call site.
 */
test('concurrent verify + share requests racing the first activation audit exactly once', async (t) => {
  const readerKeyEnvValue = buildTestReaderKeyEnvValue('reader@test.iam');

  await withApiServer({ readerKeyEnvValue }, async ({ baseUrl, sessionToken, workspaceId }) => {
    if (!librarySweepModule) throw new Error('librarySweep module not loaded yet.');
    if (!accountLibraryModule) throw new Error('accountLibrary module not loaded yet.');
    t.mock.method(accountLibraryModule, 'findLibraryRootFolderId', async () => ({
      ok: true as const,
      folderId: 'root-folder',
    }));

    // Both routes' handlers now pause here for ~30ms before reaching the
    // stamp call, guaranteeing the two concurrent requests below are both
    // genuinely in flight — neither has stamped yet — at the same time.
    t.mock.method(librarySweepModule, 'getFolderDropLaneState', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'active' as const;
    });
    t.mock.method(librarySweepModule, 'shareLibraryFolderWithReader', async () => ({ ok: true as const }));

    const [verifyResponse, shareResponse] = await Promise.all([
      fetch(`${baseUrl}/api/workspace/library/folder-drop/verify`, {
        method: 'POST',
        headers: authHeaders(sessionToken),
      }),
      fetch(`${baseUrl}/api/workspace/library/folder-drop/share`, {
        method: 'POST',
        headers: authHeaders(sessionToken),
      }),
    ]);

    assert.equal(verifyResponse.status, 200);
    assert.equal(shareResponse.status, 200);
    const verifyBody = await verifyResponse.json() as Record<string, unknown>;
    const shareBody = await shareResponse.json() as Record<string, unknown>;
    assert.equal(verifyBody.laneState, 'active');
    assert.equal(shareBody.laneState, 'active');

    const events = readFolderDropShareAuditEvents();
    assert.equal(events.length, 1, 'exactly one enablement event across concurrent verify+share calls.');
    assert.equal(events[0].workspaceId, workspaceId);
  });
});

test('a failed root-folder lookup surfaces as a platform failure, never as onboarding copy', async (t) => {
  // Sol's [medium] finding, route level: a Composio outage during the root
  // lookup used to fold to null and answer HTTP 200 `no_library_yet` —
  // directing operators to run a mission while the platform was down. All
  // three routes must refuse with a 502 and a distinct code instead, and
  // nothing may audit an enablement.
  const readerKeyEnvValue = buildTestReaderKeyEnvValue('reader@test.iam');

  await withApiServer({ readerKeyEnvValue }, async ({ baseUrl, sessionToken }) => {
    if (!accountLibraryModule) throw new Error('accountLibrary module not loaded yet.');
    t.mock.method(accountLibraryModule, 'findLibraryRootFolderId', async () => ({
      ok: false as const,
      failure: accountLibraryModule!.buildLibraryAccessFailure('integration_query_failed'),
    }));

    const status = await fetch(`${baseUrl}/api/workspace/library/folder-drop`, {
      headers: authHeaders(sessionToken),
    });
    assert.equal(status.status, 502);
    const statusBody = await status.json() as Record<string, unknown>;
    assert.equal(statusBody.code, 'folder_drop_lookup_failed');
    assert.equal(statusBody.laneState, undefined, 'a failed lookup must not invent a lane state');

    const verify = await fetch(`${baseUrl}/api/workspace/library/folder-drop/verify`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
    });
    assert.equal(verify.status, 502);

    const share = await fetch(`${baseUrl}/api/workspace/library/folder-drop/share`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
    });
    assert.equal(share.status, 502);

    assert.equal(readFolderDropShareAuditEvents().length, 0, 'a failed lookup must never audit an enablement.');
  });
});

// NF-6 (2026-08-23 re-review): a workspace that never connected Drive (or
// whose grant was revoked) is a customer-side precondition with a known next
// action, not a platform incident. It must answer with a lane state and the
// Connect CTA, never 502 and never onboarding copy.
test('a not-connected Drive answers a connect-required lane state, not a 502 or onboarding copy', async (t) => {
  const readerKeyEnvValue = buildTestReaderKeyEnvValue('reader@test.iam');

  await withApiServer({ readerKeyEnvValue }, async ({ baseUrl, sessionToken }) => {
    if (!accountLibraryModule) throw new Error('accountLibrary module not loaded yet.');
    for (const code of ['integration_not_connected', 'integration_not_ready'] as const) {
      t.mock.method(accountLibraryModule, 'findLibraryRootFolderId', async () => ({
        ok: false as const,
        failure: accountLibraryModule!.buildLibraryAccessFailure(code),
      }));

      for (const [route, method] of [
        ['/api/workspace/library/folder-drop', 'GET'],
        ['/api/workspace/library/folder-drop/verify', 'POST'],
        ['/api/workspace/library/folder-drop/share', 'POST'],
      ] as const) {
        const response = await fetch(`${baseUrl}${route}`, { method, headers: authHeaders(sessionToken) });
        const body = await response.json() as Record<string, unknown>;
        assert.equal(response.status, 200, `${code} ${route}: ${JSON.stringify(body)}`);
        assert.equal(body.laneState, 'drive_not_connected');
        assert.notEqual(body.laneState, 'no_library_yet');
        assert.equal(body.readerEmail, 'reader@test.iam');
        assert.equal(body.rootFolderId, null);
        const nextAction = body.nextAction as { label?: string; route?: string } | undefined;
        assert.equal(nextAction?.label, 'Connect Google Drive');
        assert.match(String(nextAction?.route), /^\/integrations/);
      }
    }
    assert.equal(readFolderDropShareAuditEvents().length, 0, 'a not-connected lane never audits an enablement.');
  });
});

test('a failed programmatic share returns a mapped non-2xx error instead of pretending needs_share', async (t) => {
  const readerKeyEnvValue = buildTestReaderKeyEnvValue('reader@test.iam');

  await withApiServer({ readerKeyEnvValue }, async ({ baseUrl, sessionToken }) => {
    if (!librarySweepModule) throw new Error('librarySweep module not loaded yet.');
    if (!accountLibraryModule) throw new Error('accountLibrary module not loaded yet.');
    t.mock.method(accountLibraryModule, 'findLibraryRootFolderId', async () => ({
      ok: true as const,
      folderId: 'root-folder',
    }));
    t.mock.method(librarySweepModule, 'shareLibraryFolderWithReader', async () => ({
      ok: false as const,
      reason: 'integration_query_failed' as const,
    }));

    const response = await fetch(`${baseUrl}/api/workspace/library/folder-drop/share`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
    });
    assert.equal(response.status, 502);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.code, 'folder_drop_share_failed');
    assert.match(String(body.error), /could not be shared automatically/i);
    assert.equal(body.laneState, undefined, 'a failed share must not invent a healthy onboarding state');
    assert.equal(readFolderDropShareAuditEvents().length, 0);
  });
});

test('manual-share-required preserves the actionable lane state and reader address on 409', async (t) => {
  const readerKeyEnvValue = buildTestReaderKeyEnvValue('reader@test.iam');

  await withApiServer({ readerKeyEnvValue }, async ({ baseUrl, sessionToken }) => {
    if (!librarySweepModule) throw new Error('librarySweep module not loaded yet.');
    if (!accountLibraryModule) throw new Error('accountLibrary module not loaded yet.');
    t.mock.method(accountLibraryModule, 'findLibraryRootFolderId', async () => ({
      ok: true as const,
      folderId: 'root-folder',
    }));
    t.mock.method(librarySweepModule, 'shareLibraryFolderWithReader', async () => ({
      ok: false as const,
      reason: 'manual_share_required' as const,
    }));

    const response = await fetch(`${baseUrl}/api/workspace/library/folder-drop/share`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.code, 'folder_drop_manual_share_required');
    assert.equal(body.manualShare, true);
    assert.equal(body.laneState, 'needs_share');
    assert.equal(body.readerEmail, 'reader@test.iam');
    assert.equal(body.rootFolderId, 'root-folder');
    assert.equal(readFolderDropShareAuditEvents().length, 0);
  });
});

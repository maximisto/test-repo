import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { PersistedAutomationStep } from '../src/platform/types';

/**
 * The review-rerun endpoint's handling of the OLD task and its stored note.
 *
 * Production 2026-08-05: a reviewer note ("add Viktor to the competitve
 * review") written a day earlier was replayed into a fresh run because the
 * rerun endpoint merges the stored request-changes note from whatever run id
 * the client still holds — however stale — and never clears it. The same
 * endpoint also set the OLD task to `running`, a status no run ever closes,
 * which is where the swept zombie-task family came from.
 *
 * Pinned here: a rerun consumes the stored note exactly once (cleared from
 * both the old task and the old run), and never re-animates the old task.
 */

const SUMMARIZE_ONLY_STEPS: PersistedAutomationStep[] = [
  {
    id: 'step_summarize_memo',
    kind: 'summarize',
    title: 'Draft memo',
    objective: 'Summarize findings into a memo.',
    inputs: {},
  },
];

type TestServerContext = {
  baseUrl: string;
  sessionToken: string;
  workspaceId: string;
  automationId: string;
  store: typeof import('../src/platform/store');
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

async function withRerunServer(
  t: TestContext,
  run: (context: TestServerContext) => Promise<void>,
) {
  const originalCwd = process.cwd();
  const originalApproved = process.env.VIOLEMA_APPROVED_EMAILS;
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-review-rerun-note-'));

  process.chdir(tempDir);
  process.env.VIOLEMA_APPROVED_EMAILS = 'qa@example.com';
  process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
  // Readiness only checks presence; the spawned run may fail against this key,
  // which is fine — the assertions below are about the OLD task and note.
  process.env.OPENROUTER_API_KEY = 'test-key-readiness-only';

  let server: http.Server | null = null;

  try {
    const models = await import('../src/models');
    t.mock.method(models, 'generateTextDetailed', async () => ({
      text: '# QA rerun brief\n\nThe requested change was applied.',
      stopReason: 'stop',
      usage: {
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
        provider: 'openrouter' as const,
        model: 'rerun-test-model',
      },
    }));
    const serverModule = await import('../src/server');
    const auth = await import('../src/auth');
    const consent = await import('../src/betaConsentStore');
    const betaProgram = await import('../src/betaProgram');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const acceptedAt = '2026-07-11T12:01:00.000Z';

    consent.recordBetaConsent({
      email: 'qa@example.com',
      participantType: 'founder_operator',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
      acceptedAt,
      authMethod: 'email',
      acceptanceSource: 'signup',
    });

    const user = auth.upsertAuthUser({
      email: 'qa@example.com',
      name: 'QA Operator',
      role: 'admin',
      method: 'email',
      participantType: 'founder_operator',
      acceptedTerms: true,
      acceptedTermsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedTermsAt: acceptedAt,
      acceptedEducation: true,
    });
    const session = auth.createAuthSession(user.id);

    const automation = scheduler.createAutomation(
      {
        workspaceId: user.defaultWorkspaceId,
        owner_user_id: user.id,
        name: 'QA competitor monitor',
        schedule: 'every monday at 9am',
        actions: ['Draft memo'],
        steps: SUMMARIZE_ONLY_STEPS,
      },
      async () => ({ ok: true }),
    );

    server = await new Promise<http.Server>((resolve) => {
      const listening = serverModule.default.listen(0, () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port.');

    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      sessionToken: session.token,
      workspaceId: user.defaultWorkspaceId,
      automationId: automation.id,
      store,
    });

    auth.clearAuthSession(session.token);
  } finally {
    await closeServer(server);
    process.chdir(originalCwd);
    if (typeof originalApproved === 'string') process.env.VIOLEMA_APPROVED_EMAILS = originalApproved;
    else delete process.env.VIOLEMA_APPROVED_EMAILS;
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalOpenRouter === 'string') process.env.OPENROUTER_API_KEY = originalOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function authHeaders(sessionToken: string) {
  return {
    cookie: `violema_session=${sessionToken}`,
    'Content-Type': 'application/json',
  };
}

/** An old, closed run carrying a stored request-changes note — the stale shape from 2026-08-05. */
function seedNotedRun(
  store: TestServerContext['store'],
  input: { workspaceId: string; automationId: string; credits?: number },
) {
  store.addLedgerEntry({
    workspaceId: input.workspaceId,
    source: 'manual_adjustment',
    deltaCredits: input.credits ?? 500,
    referenceType: 'manual',
    referenceId: 'test_rerun_credits',
  });
  const task = store.createTask({
    workspaceId: input.workspaceId,
    title: 'QA competitor monitor',
    kind: 'automation',
    priority: 'medium',
    metadata: { automationId: input.automationId },
  });
  const run = store.createTaskRun({
    workspaceId: input.workspaceId,
    taskId: task.id,
    agentRole: 'analyst',
    modelTier: 'default',
    estimatedCredits: 10,
    metadata: { automationId: input.automationId },
  });
  store.finalizeTaskRun(run.id, { status: 'succeeded' });
  const reviewRequest = {
    status: 'changes_requested',
    reviewer: 'qa@example.com',
    reviewedAt: '2026-08-04T01:45:00.000Z',
    note: 'add Viktor to the competitve review',
  };
  store.updateTask(task.id, {
    status: 'blocked',
    delegationState: 'review',
    metadata: { automationId: input.automationId, reviewRequired: true, reviewRequest },
  });
  store.updateTaskRun(run.id, { metadata: { reviewRequired: true, reviewRequest } });
  return { task, run };
}

test('a dry-run is inert and a forecast-only affordable rerun is refused synchronously', async (t) =>
  withRerunServer(t, async ({ baseUrl, sessionToken, automationId, workspaceId, store }) => {
    const { task, run } = seedNotedRun(store, { workspaceId, automationId, credits: 100 });

    const response = await fetch(`${baseUrl}/api/automations/${automationId}/reviews/${run.id}/rerun`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
      body: JSON.stringify({ dryRun: true }),
    });
    const payload = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 200);
    const wouldPatchTask = payload.wouldPatchTask as Record<string, unknown>;
    assert.equal(wouldPatchTask.status, undefined, 'The old task keeps its status; the fresh run owns its own task.');

    const runsBefore = store.listTaskRuns(workspaceId).length;
    const liveResponse = await fetch(`${baseUrl}/api/automations/${automationId}/reviews/${run.id}/rerun`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
      body: JSON.stringify({}),
    });
    const livePayload = await liveResponse.json() as Record<string, unknown>;
    assert.equal(liveResponse.status, 409);
    assert.equal(livePayload.code, 'insufficient_credits');
    assert.ok(Number(livePayload.requiredCredits) > Number(livePayload.availableCredits));
    assert.equal(store.listTaskRuns(workspaceId).length, runsBefore, 'no replacement run was started');
    const oldTask = store.listTasks(workspaceId).find((item) => item.id === task.id);
    const oldRun = store.listTaskRuns(workspaceId).find((item) => item.id === run.id);
    assert.equal((oldTask?.metadata?.reviewRequest as { status?: string })?.status, 'changes_requested');
    assert.equal((oldRun?.metadata?.reviewRequest as { status?: string })?.status, 'changes_requested');
  }));

test('a live rerun consumes the stored change note once and leaves the old task closed', async (t) =>
  withRerunServer(t, async ({ baseUrl, sessionToken, automationId, workspaceId, store }) => {
    const { task, run } = seedNotedRun(store, { workspaceId, automationId, credits: 5_000 });

    const response = await fetch(`${baseUrl}/api/automations/${automationId}/reviews/${run.id}/rerun`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
      body: JSON.stringify({}),
    });
    const payload = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.reviewFeedbackApplied, true, 'The stored note IS applied to the rerun it was written for.');

    const oldTask = store.listTasks(workspaceId).find((item) => item.id === task.id);
    assert.equal(oldTask?.status, 'blocked', 'The old task is never re-marked running by a rerun.');
    assert.equal(oldTask?.metadata?.reviewRequest ?? null, null, 'The consumed note is cleared from the old task.');

    const oldRun = store.listTaskRuns(workspaceId).find((item) => item.id === run.id);
    assert.equal(oldRun?.metadata?.reviewRequest ?? null, null, 'The consumed note is cleared from the old run.');

    const replay = await fetch(`${baseUrl}/api/automations/${automationId}/reviews/${run.id}/rerun`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
      body: JSON.stringify({}),
    });
    const replayPayload = await replay.json() as Record<string, unknown>;
    assert.equal(replay.status, 409, 'the historical run URL is single-use');
    assert.equal(replayPayload.code, 'review_not_rerunnable');
  }));

test('a failed scheduler handoff leaves the review claimable and releases its hold', async (t) =>
  withRerunServer(t, async ({ baseUrl, sessionToken, automationId, workspaceId, store }) => {
    const { task, run } = seedNotedRun(store, { workspaceId, automationId, credits: 5_000 });
    const writeFileSync = fs.writeFileSync.bind(fs);
    t.mock.method(fs, 'writeFileSync', ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof target === 'string' && target.endsWith(`${path.sep}automations.json`)) {
        throw new Error('automation handoff write unavailable');
      }
      return (writeFileSync as (...values: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.writeFileSync);

    const response = await fetch(`${baseUrl}/api/automations/${automationId}/reviews/${run.id}/rerun`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
      body: JSON.stringify({}),
    });
    const payload = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 503);
    assert.equal(payload.code, 'automation_start_unavailable');
    const oldTask = store.listTasks(workspaceId).find((item) => item.id === task.id);
    const oldRun = store.listTaskRuns(workspaceId).find((item) => item.id === run.id);
    assert.equal((oldTask?.metadata?.reviewRequest as { status?: string })?.status, 'changes_requested');
    assert.equal((oldRun?.metadata?.reviewRequest as { status?: string })?.status, 'changes_requested');
    const holds = store.listLedgerEntries(workspaceId).filter((entry) => entry.source === 'credit_hold');
    const active = holds.find((entry) => entry.metadata?.holdStatus === 'active');
    assert.ok(active, 'the preflight hold was created before the scheduler handoff failed');
    assert.ok(
      holds.some((entry) => entry.metadata?.holdId === active.metadata?.holdId && entry.metadata?.holdStatus === 'released'),
      'the failed handoff releases the exact transferred hold',
    );
  }));

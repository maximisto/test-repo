import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TaskRecord, TaskRunRecord } from '../src/platform/types';

type TestServerContext = {
  baseUrl: string;
  sessionToken: string;
  workspaceId: string;
  automationId: string;
  taskId: string;
  runId: string;
};

function closeServer(server: http.Server | null) {
  if (!server) return Promise.resolve();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withReviewServer(run: (context: TestServerContext) => Promise<void>) {
  const originalCwd = process.cwd();
  const originalApproved = process.env.VIOLEMA_APPROVED_EMAILS;
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalPostmarkKey = process.env.POSTMARK_API_KEY;
  const originalPostmarkFrom = process.env.POSTMARK_FROM_EMAIL;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-review-dry-run-'));

  process.chdir(tempDir);
  process.env.VIOLEMA_APPROVED_EMAILS = 'qa@example.com';
  process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
  process.env.POSTMARK_API_KEY = 'test-postmark-key';
  process.env.POSTMARK_FROM_EMAIL = 'violema@example.com';

  let server: http.Server | null = null;

  try {
    const { default: app } = await import('../src/server');
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
    const automation = scheduler.createAutomation({
      workspaceId: user.defaultWorkspaceId,
      owner_user_id: user.id,
      name: 'QA founder update',
      schedule: 'every monday at 9am',
      actions: ['Draft QA review'],
    }, async () => ({ ok: true }));

    const reviewArtifact = {
      kind: 'review_gate',
      title: 'Ready for review: QA founder update',
      payload: {
        markdown: '## QA founder update\nNothing should be sent during dry-run.',
        deliveryTarget: 'qa@example.com',
        approvalRequired: true,
      },
    };
    const task = store.createTask({
      workspaceId: user.defaultWorkspaceId,
      title: 'QA founder update',
      kind: 'automation',
      priority: 'medium',
      delegationState: 'review',
      metadata: {
        automationId: automation.id,
        latestArtifacts: [reviewArtifact],
        reviewRequired: true,
      },
    });
    const taskRun = store.createTaskRun({
      workspaceId: user.defaultWorkspaceId,
      taskId: task.id,
      agentRole: 'analyst',
      modelTier: 'default',
      estimatedCredits: 12,
      metadata: {
        automationId: automation.id,
        artifacts: [reviewArtifact],
        reviewRequired: true,
      },
    });
    store.updateTask(task.id, {
      status: 'waiting_review',
      delegationState: 'review',
    });
    store.updateTaskRun(taskRun.id, {
      status: 'succeeded',
      actualCredits: 8,
    });

    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port.');

    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      sessionToken: session.token,
      workspaceId: user.defaultWorkspaceId,
      automationId: automation.id,
      taskId: task.id,
      runId: taskRun.id,
    });

    auth.clearAuthSession(session.token);
  } finally {
    await closeServer(server);
    process.chdir(originalCwd);
    if (typeof originalApproved === 'string') process.env.VIOLEMA_APPROVED_EMAILS = originalApproved;
    else delete process.env.VIOLEMA_APPROVED_EMAILS;
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalPostmarkKey === 'string') process.env.POSTMARK_API_KEY = originalPostmarkKey;
    else delete process.env.POSTMARK_API_KEY;
    if (typeof originalPostmarkFrom === 'string') process.env.POSTMARK_FROM_EMAIL = originalPostmarkFrom;
    else delete process.env.POSTMARK_FROM_EMAIL;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function authHeaders(sessionToken: string) {
  return {
    cookie: `violema_session=${sessionToken}`,
    'Content-Type': 'application/json',
  };
}

async function readTask(baseUrl: string, sessionToken: string, taskId: string) {
  const response = await fetch(`${baseUrl}/api/platform/tasks`, { headers: authHeaders(sessionToken) });
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  return (payload.items as TaskRecord[]).find((item) => item.id === taskId);
}

async function readTaskRun(baseUrl: string, sessionToken: string, runId: string) {
  const response = await fetch(`${baseUrl}/api/platform/task-runs`, { headers: authHeaders(sessionToken) });
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  return (payload.items as TaskRunRecord[]).find((item) => item.id === runId);
}

async function readWorkflowLedger(baseUrl: string, sessionToken: string, runId: string) {
  const response = await fetch(`${baseUrl}/api/workflows/runs/${runId}/ledger`, {
    headers: authHeaders(sessionToken),
  });
  assert.equal(response.status, 200);
  return (await readJson(response)).items as Array<Record<string, unknown>>;
}

test('automation review dry-run approve does not send, mutate state, or append ledger events', async () => withReviewServer(async ({
  baseUrl,
  sessionToken,
  automationId,
  taskId,
  runId,
}) => {
  const response = await fetch(`${baseUrl}/api/automations/${automationId}/reviews/${runId}/approve`, {
    method: 'POST',
    headers: authHeaders(sessionToken),
    body: JSON.stringify({ reviewer: 'QA Operator', dryRun: true }),
  });
  const payload = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal((payload.receipt as Record<string, unknown>).status, 'delivered');
  assert.equal((payload.delivery as Record<string, unknown>).status, 'dry_run');
  assert.equal((payload.delivery as Record<string, unknown>).dryRun, true);
  assert.deepEqual((payload.wouldAppendLedgerEvents as Array<Record<string, unknown>>).map((event) => event.type), [
    'approval_granted',
    'external_action_executed',
  ]);

  const task = await readTask(baseUrl, sessionToken, taskId);
  const taskRun = await readTaskRun(baseUrl, sessionToken, runId);
  assert.equal(task?.status, 'waiting_review');
  assert.equal(task?.delegationState, 'review');
  assert.equal(task?.metadata?.reviewReceipt, undefined);
  assert.equal(taskRun?.metadata?.reviewReceipt, undefined);
  assert.deepEqual(await readWorkflowLedger(baseUrl, sessionToken, runId), []);
}));

test('automation review dry-run request-changes validates without mutating state', async () => withReviewServer(async ({
  baseUrl,
  sessionToken,
  automationId,
  taskId,
  runId,
}) => {
  const response = await fetch(`${baseUrl}/api/automations/${automationId}/reviews/${runId}/request-changes`, {
    method: 'POST',
    headers: authHeaders(sessionToken),
    body: JSON.stringify({ reviewer: 'QA Operator', note: 'Tighten the proof.', dryRun: true }),
  });
  const payload = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal((payload.reviewRequest as Record<string, unknown>).status, 'changes_requested');
  assert.deepEqual((payload.wouldAppendLedgerEvents as Array<Record<string, unknown>>).map((event) => event.type), [
    'approval_denied',
  ]);

  const task = await readTask(baseUrl, sessionToken, taskId);
  const taskRun = await readTaskRun(baseUrl, sessionToken, runId);
  assert.equal(task?.status, 'waiting_review');
  assert.equal(task?.metadata?.reviewRequest, undefined);
  assert.equal(taskRun?.metadata?.reviewRequest, undefined);
  assert.deepEqual(await readWorkflowLedger(baseUrl, sessionToken, runId), []);
}));

test('automation review dry-run rerun validates without triggering a fresh run', async () => withReviewServer(async ({
  baseUrl,
  sessionToken,
  automationId,
  taskId,
  runId,
}) => {
  const changeResponse = await fetch(`${baseUrl}/api/automations/${automationId}/reviews/${runId}/request-changes`, {
    method: 'POST',
    headers: authHeaders(sessionToken),
    body: JSON.stringify({ reviewer: 'QA Operator', note: 'Try a fresh version.' }),
  });
  assert.equal(changeResponse.status, 200, 'a rerun is valid only from an unresolved change request');
  const ledgerBefore = await readWorkflowLedger(baseUrl, sessionToken, runId);
  const runsBefore = await fetch(`${baseUrl}/api/platform/task-runs`, { headers: authHeaders(sessionToken) })
    .then(readJson)
    .then((payload) => (payload.items as TaskRunRecord[]).length);
  const response = await fetch(`${baseUrl}/api/automations/${automationId}/reviews/${runId}/rerun`, {
    method: 'POST',
    headers: authHeaders(sessionToken),
    body: JSON.stringify({ reviewer: 'QA Operator', note: 'Try a fresh version.', dryRun: true }),
  });
  const payload = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  // The rerun never re-animates the old task — the fresh run owns its own task
  // (the old `status: 'running'` patch was the zombie-task factory).
  assert.equal((payload.wouldPatchTask as Record<string, unknown>).status, undefined);
  assert.match(String(payload.message), /would request a fresh run/i);

  const runsAfter = await fetch(`${baseUrl}/api/platform/task-runs`, { headers: authHeaders(sessionToken) })
    .then(readJson)
    .then((nextPayload) => (nextPayload.items as TaskRunRecord[]).length);
  const task = await readTask(baseUrl, sessionToken, taskId);
  assert.equal(runsAfter, runsBefore);
  assert.equal(task?.status, 'blocked');
  assert.equal((task?.metadata?.reviewRequest as Record<string, unknown>)?.status, 'changes_requested');
  assert.equal(task?.metadata?.reviewRerun, undefined);
  assert.deepEqual(
    await readWorkflowLedger(baseUrl, sessionToken, runId),
    ledgerBefore,
    'the dry-run adds nothing beyond the already-recorded change request',
  );
}));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function closeServer(server: http.Server | null) {
  if (!server) return Promise.resolve();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('manual run and rerun acknowledge only after a durable task run owns the credit hold', async (t) => {
  const originalCwd = process.cwd();
  const originalApproved = process.env.VIOLEMA_APPROVED_EMAILS;
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-launch-receipt-'));
  let listening: http.Server | null = null;

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_APPROVED_EMAILS = 'launch-receipt@example.com';
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';

    const server = await import('../src/server');
    const auth = await import('../src/auth');
    const consent = await import('../src/betaConsentStore');
    const betaProgram = await import('../src/betaProgram');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const acceptedAt = '2026-08-22T12:00:00.000Z';
    consent.recordBetaConsent({
      email: 'launch-receipt@example.com',
      participantType: 'founder_operator',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
      acceptedAt,
      authMethod: 'email',
      acceptanceSource: 'signup',
    });
    const user = auth.upsertAuthUser({
      email: 'launch-receipt@example.com',
      name: 'Launch Receipt QA',
      role: 'admin',
      method: 'email',
      participantType: 'founder_operator',
      acceptedTerms: true,
      acceptedTermsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedTermsAt: acceptedAt,
      acceptedEducation: true,
    });
    const session = auth.createAuthSession(user.id);
    process.env.DEMO_WORKSPACE_IDS = user.defaultWorkspaceId;
    store.addLedgerEntry({
      workspaceId: user.defaultWorkspaceId,
      source: 'manual_adjustment',
      deltaCredits: 20_000,
      referenceType: 'manual',
      referenceId: 'launch_receipt_balance',
    });
    const steps = [{
      id: 'summary',
      kind: 'summarize' as const,
      title: 'Draft summary',
      objective: 'Draft the decision-ready summary.',
    }];
    const manualAutomation = scheduler.createAutomation({
      workspaceId: user.defaultWorkspaceId,
      owner_user_id: user.id,
      name: 'Manual launch receipt',
      schedule: 'every monday at 9am',
      actions: ['Draft summary'],
      steps,
    }, server.runAutomation);
    const rerunAutomation = scheduler.createAutomation({
      workspaceId: user.defaultWorkspaceId,
      owner_user_id: user.id,
      name: 'Rerun launch receipt',
      schedule: 'every tuesday at 9am',
      actions: ['Draft summary'],
      steps,
    }, server.runAutomation);
    const oldTask = store.createTask({
      workspaceId: user.defaultWorkspaceId,
      title: rerunAutomation.name,
      kind: 'automation',
      priority: 'medium',
      metadata: { automationId: rerunAutomation.id },
    });
    const oldRun = store.createTaskRun({
      workspaceId: user.defaultWorkspaceId,
      taskId: oldTask.id,
      agentRole: 'analyst',
      modelTier: 'default',
      estimatedCredits: 10,
      metadata: { automationId: rerunAutomation.id },
    });
    store.finalizeTaskRun(oldRun.id, { status: 'succeeded' });
    const reviewRequest = {
      status: 'changes_requested',
      reviewer: 'launch-receipt@example.com',
      reviewedAt: acceptedAt,
      note: 'Tighten the conclusion.',
    };
    store.updateTask(oldTask.id, {
      status: 'blocked',
      delegationState: 'review',
      metadata: { automationId: rerunAutomation.id, reviewRequired: true, reviewRequest },
    });
    store.updateTaskRun(oldRun.id, { metadata: { reviewRequired: true, reviewRequest } });

    listening = await new Promise<http.Server>((resolve) => {
      const bound = server.default.listen(0, () => resolve(bound));
    });
    const address = listening.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port.');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      cookie: `violema_session=${session.token}`,
      'Content-Type': 'application/json',
    };
    const renameSync = fs.renameSync.bind(fs);
    t.mock.method(console, 'error', () => undefined);
    t.mock.method(fs, 'renameSync', ((source: fs.PathLike, target: fs.PathLike) => {
      if (typeof target === 'string' && target.endsWith(`${path.sep}platform-tasks.json`)) {
        throw new Error('task store unavailable after scheduler handoff');
      }
      return renameSync(source, target);
    }) as typeof fs.renameSync);

    const manualResponse = await fetch(`${baseUrl}/api/automations/${manualAutomation.id}/run`, {
      method: 'POST',
      headers,
    });
    const manualPayload = await manualResponse.json() as Record<string, unknown>;
    assert.equal(manualResponse.status, 503);
    assert.equal(manualPayload.code, 'automation_start_unavailable');
    assert.equal(
      store.listTaskRuns(user.defaultWorkspaceId).some((run) => run.metadata?.automationId === manualAutomation.id),
      false,
      'no task run was durably created',
    );

    const rerunResponse = await fetch(
      `${baseUrl}/api/automations/${rerunAutomation.id}/reviews/${oldRun.id}/rerun`,
      { method: 'POST', headers, body: JSON.stringify({}) },
    );
    const rerunPayload = await rerunResponse.json() as Record<string, unknown>;
    assert.equal(rerunResponse.status, 503);
    assert.equal(rerunPayload.code, 'automation_start_unavailable');
    assert.equal(
      (store.listTaskRuns(user.defaultWorkspaceId).find((run) => run.id === oldRun.id)
        ?.metadata?.reviewRequest as { status?: string } | undefined)?.status,
      'changes_requested',
      'the old review remains claimable when no replacement task run exists',
    );

    const holds = store.listLedgerEntries(user.defaultWorkspaceId).filter((entry) => entry.source === 'credit_hold');
    const activeHoldIds = new Set(
      holds.filter((entry) => entry.metadata?.holdStatus === 'active')
        .map((entry) => String(entry.metadata?.holdId)),
    );
    for (const holdId of activeHoldIds) {
      assert.ok(
        holds.some((entry) => entry.metadata?.holdId === holdId && entry.metadata?.holdStatus === 'released'),
        `operator hold ${holdId} is released after the runner rejects the handoff`,
      );
    }
  } finally {
    await closeServer(listening);
    process.chdir(originalCwd);
    if (typeof originalApproved === 'string') process.env.VIOLEMA_APPROVED_EMAILS = originalApproved;
    else delete process.env.VIOLEMA_APPROVED_EMAILS;
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    if (typeof originalOpenRouter === 'string') process.env.OPENROUTER_API_KEY = originalOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

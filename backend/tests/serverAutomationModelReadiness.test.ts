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

test('manual run and rerun refuse an executable plan with no configured model route', async () => {
  const originalCwd = process.cwd();
  const originalApproved = process.env.VIOLEMA_APPROVED_EMAILS;
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const modelEnvKeys = [
    'ANTHROPIC_API_KEY',
    'MINIMAX_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'MISTRAL_API_KEY',
    'ZAI_API_KEY',
  ] as const;
  const originalModelEnv = new Map(modelEnvKeys.map((key) => [key, process.env[key]] as const));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-model-readiness-route-'));
  let listening: http.Server | null = null;

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_APPROVED_EMAILS = 'model-readiness@example.com';
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    for (const key of modelEnvKeys) delete process.env[key];

    const server = await import('../src/server');
    const auth = await import('../src/auth');
    const consent = await import('../src/betaConsentStore');
    const betaProgram = await import('../src/betaProgram');
    const scheduler = await import('../src/scheduler');
    const platform = await import('../src/platform');
    const store = await import('../src/platform/store');
    const acceptedAt = '2026-08-22T12:00:00.000Z';

    consent.recordBetaConsent({
      email: 'model-readiness@example.com',
      participantType: 'founder_operator',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
      acceptedAt,
      authMethod: 'email',
      acceptanceSource: 'signup',
    });
    const user = auth.upsertAuthUser({
      email: 'model-readiness@example.com',
      name: 'Model Readiness QA',
      role: 'admin',
      method: 'email',
      participantType: 'founder_operator',
      acceptedTerms: true,
      acceptedTermsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedTermsAt: acceptedAt,
      acceptedEducation: true,
    });
    const session = auth.createAuthSession(user.id);
    store.addLedgerEntry({
      workspaceId: user.defaultWorkspaceId,
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'model_readiness_test',
    });
    const automation = scheduler.createAutomation(
      {
        workspaceId: user.defaultWorkspaceId,
        owner_user_id: user.id,
        name: 'Model-gated summary',
        schedule: 'every monday at 9am',
        actions: ['Summarize the evidence'],
        steps: [{
          id: 'step_summary',
          kind: 'summarize',
          title: 'Summarize evidence',
          objective: 'Produce the decision-ready summary.',
        }],
      },
      async () => ({ ok: true }),
    );

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
    const runsBefore = store.listTaskRuns(user.defaultWorkspaceId).length;
    const balanceBefore = platform.buildCreditSnapshot(user.defaultWorkspaceId);

    const runResponse = await fetch(`${baseUrl}/api/automations/${automation.id}/run`, {
      method: 'POST',
      headers,
    });
    const runPayload = await runResponse.json() as Record<string, unknown>;
    assert.equal(runResponse.status, 409);
    assert.equal(runPayload.ok, false);
    assert.equal(runPayload.code, 'model_route_unavailable');
    assert.match(String(runPayload.error), /model route/i);
    assert.equal(store.listTaskRuns(user.defaultWorkspaceId).length, runsBefore);
    assert.equal(
      platform.buildCreditSnapshot(user.defaultWorkspaceId).creditsRemaining,
      balanceBefore.creditsRemaining,
      'the refused trigger neither reserves nor spends credits',
    );

    const task = store.createTask({
      workspaceId: user.defaultWorkspaceId,
      title: automation.name,
      kind: 'automation',
      priority: 'medium',
      metadata: { automationId: automation.id },
    });
    const oldRun = store.createTaskRun({
      workspaceId: user.defaultWorkspaceId,
      taskId: task.id,
      agentRole: 'analyst',
      modelTier: 'default',
      estimatedCredits: 10,
      metadata: { automationId: automation.id },
    });
    store.finalizeTaskRun(oldRun.id, { status: 'succeeded' });
    const reviewRequest = {
      status: 'changes_requested',
      reviewer: 'model-readiness@example.com',
      reviewedAt: '2026-08-22T12:05:00.000Z',
      note: 'Tighten the conclusion.',
    };
    store.updateTask(task.id, {
      status: 'blocked',
      delegationState: 'review',
      metadata: { automationId: automation.id, reviewRequired: true, reviewRequest },
    });
    store.updateTaskRun(oldRun.id, { metadata: { reviewRequired: true, reviewRequest } });
    const rerunCountBefore = store.listTaskRuns(user.defaultWorkspaceId).length;

    const rerunResponse = await fetch(
      `${baseUrl}/api/automations/${automation.id}/reviews/${oldRun.id}/rerun`,
      { method: 'POST', headers, body: JSON.stringify({}) },
    );
    const rerunPayload = await rerunResponse.json() as Record<string, unknown>;
    assert.equal(rerunResponse.status, 409);
    assert.equal(rerunPayload.ok, false);
    assert.equal(rerunPayload.code, 'model_route_unavailable');
    assert.equal(store.listTaskRuns(user.defaultWorkspaceId).length, rerunCountBefore);
    assert.equal(
      (store.listTaskRuns(user.defaultWorkspaceId).find((item) => item.id === oldRun.id)
        ?.metadata?.reviewRequest as { status?: string } | undefined)?.status,
      'changes_requested',
      'the refused rerun remains claimable after routes are configured',
    );
  } finally {
    await closeServer(listening);
    process.chdir(originalCwd);
    if (typeof originalApproved === 'string') process.env.VIOLEMA_APPROVED_EMAILS = originalApproved;
    else delete process.env.VIOLEMA_APPROVED_EMAILS;
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    for (const key of modelEnvKeys) {
      const value = originalModelEnv.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

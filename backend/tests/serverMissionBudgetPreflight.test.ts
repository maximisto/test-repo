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

test('manual run returns the mission-budget refusal synchronously and never triggers', async () => {
  const originalCwd = process.cwd();
  const originalApproved = process.env.VIOLEMA_APPROVED_EMAILS;
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-mission-budget-route-'));
  let listening: http.Server | null = null;

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_APPROVED_EMAILS = 'budget-qa@example.com';
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

    const server = await import('../src/server');
    const auth = await import('../src/auth');
    const consent = await import('../src/betaConsentStore');
    const betaProgram = await import('../src/betaProgram');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const acceptedAt = '2026-08-22T12:00:00.000Z';

    consent.recordBetaConsent({
      email: 'budget-qa@example.com',
      participantType: 'founder_operator',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
      acceptedAt,
      authMethod: 'email',
      acceptanceSource: 'signup',
    });
    const user = auth.upsertAuthUser({
      email: 'budget-qa@example.com',
      name: 'Budget QA',
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
      deltaCredits: 1_000,
      referenceType: 'manual',
      referenceId: 'mission_budget_route_test',
    });
    const onTrigger = async () => ({ ok: true });
    const createdAutomation = scheduler.createAutomation(
      {
        workspaceId: user.defaultWorkspaceId,
        owner_user_id: user.id,
        name: 'Budget-gated note',
        schedule: 'every monday at 9am',
        actions: ['Keep an orchestration note'],
        steps: [{
          id: 'step_note',
          kind: 'note',
          title: 'Keep note',
          objective: 'Keep an orchestration note without external I/O.',
        }],
      },
      onTrigger,
    );
    const automation = scheduler.updateAutomation(
      createdAutomation.id,
      { credit_budget_per_run: 1 },
      onTrigger,
    );
    assert.ok(automation, 'the persisted automation must accept its per-run budget');

    listening = await new Promise<http.Server>((resolve) => {
      const bound = server.default.listen(0, () => resolve(bound));
    });
    const address = listening.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port.');
    const runsBefore = store.listTaskRuns(user.defaultWorkspaceId).length;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/automations/${automation.id}/run`, {
      method: 'POST',
      headers: {
        cookie: `violema_session=${session.token}`,
        'Content-Type': 'application/json',
      },
    });
    const payload = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 409);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'credit_budget_exceeded');
    assert.match(String(payload.error), /per-run budget/i);
    assert.equal(payload.message, payload.error);
    assert.equal(payload.budgetCredits, 1);
    assert.ok(Number(payload.estimatedCredits) > 1);
    assert.equal(
      store.listTaskRuns(user.defaultWorkspaceId).length,
      runsBefore,
      'the async runner was never invoked',
    );

    const hardEnvelopeAutomation = scheduler.createAutomation(
      {
        workspaceId: user.defaultWorkspaceId,
        owner_user_id: user.id,
        name: 'Hard-envelope analysis',
        schedule: 'every tuesday at 9am',
        actions: ['Analyze the evidence', 'Summarize the findings'],
        steps: [
          {
            id: 'step_analyze',
            kind: 'analyze',
            title: 'Analyze evidence',
            objective: 'Analyze the gathered evidence.',
          },
          {
            id: 'step_summary',
            kind: 'summarize',
            title: 'Summarize findings',
            objective: 'Summarize the findings.',
          },
        ],
      },
      onTrigger,
    );
    const hardPlan = server.buildAutomationExecutionPlan(hardEnvelopeAutomation);
    assert.ok(hardPlan.estimatedCredits < 1_000, 'the forecast fits the workspace balance');
    assert.ok(hardPlan.manualAuthorizationCredits > 1_000, 'the reachable hard envelope does not');
    const runsBeforeHardEnvelope = store.listTaskRuns(user.defaultWorkspaceId).length;

    const hardResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/automations/${hardEnvelopeAutomation.id}/run`,
      {
        method: 'POST',
        headers: {
          cookie: `violema_session=${session.token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const hardPayload = await hardResponse.json() as Record<string, unknown>;
    assert.equal(hardResponse.status, 409);
    assert.equal(hardPayload.code, 'insufficient_credits');
    assert.ok(Number(hardPayload.requiredCredits) >= hardPlan.manualAuthorizationCredits);
    assert.equal(
      store.listTaskRuns(user.defaultWorkspaceId).length,
      runsBeforeHardEnvelope,
      'forecast-only affordability never acknowledges or starts the run',
    );
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

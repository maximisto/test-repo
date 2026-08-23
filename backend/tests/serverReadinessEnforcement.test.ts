import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PersistedAutomationStep } from '../src/platform/types';

/**
 * Readiness enforcement, end to end.
 *
 * The unit suite in runReadinessGate.test.ts proves the decision logic; this
 * file proves the server actually obeys it — that a blocked run reserves no
 * credits, that operator-initiated runs get the missing connection back on the
 * request, and that an approval re-checks provenance before sending.
 */

const STRIPE_QUERY_STEPS: PersistedAutomationStep[] = [
  {
    id: 'step_stripe_revenue',
    kind: 'query',
    title: 'Check Stripe revenue',
    objective: 'Pull revenue signals from Stripe.',
    inputs: { source: 'stripe', query_type: 'revenue_summary' },
  },
];

type TestServerContext = {
  baseUrl: string;
  sessionToken: string;
  workspaceId: string;
  automationId: string;
  server: typeof import('../src/server');
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

async function withReadinessServer(
  run: (context: TestServerContext) => Promise<void>,
  options: { demoWorkspace?: boolean } = {},
) {
  const originalCwd = process.cwd();
  const originalApproved = process.env.VIOLEMA_APPROVED_EMAILS;
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-readiness-enforcement-'));

  process.chdir(tempDir);
  process.env.VIOLEMA_APPROVED_EMAILS = 'qa@example.com';
  process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
  delete process.env.DEMO_WORKSPACE_IDS;

  let server: http.Server | null = null;

  try {
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

    if (options.demoWorkspace) {
      process.env.DEMO_WORKSPACE_IDS = user.defaultWorkspaceId;
    }

    // Stripe is deliberately left unconfigured in this temp workspace, so a
    // Stripe-reading automation is not ready to run.
    const automation = scheduler.createAutomation(
      {
        workspaceId: user.defaultWorkspaceId,
        owner_user_id: user.id,
        name: 'QA revenue watch',
        schedule: 'every monday at 9am',
        actions: ['Check Stripe revenue'],
        steps: STRIPE_QUERY_STEPS,
        notify: '#violema-demo',
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
      server: serverModule,
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
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function authHeaders(sessionToken: string) {
  return {
    cookie: `violema_session=${sessionToken}`,
    'Content-Type': 'application/json',
  };
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test('manual run endpoint answers 409 workflow_not_ready and never triggers the run', async () =>
  withReadinessServer(async ({ baseUrl, sessionToken, automationId, workspaceId, store }) => {
    const runsBefore = store.listTaskRuns(workspaceId).length;

    const response = await fetch(`${baseUrl}/api/automations/${automationId}/run`, {
      method: 'POST',
      headers: authHeaders(sessionToken),
    });
    const payload = await readJson(response);

    assert.equal(response.status, 409);
    assert.equal(payload.code, 'workflow_not_ready');
    assert.equal(payload.ok, false);
    // The dashboard flattens an error body to `error` first, `message` second —
    // both carry the full summary so every call site can say something true.
    assert.match(String(payload.error), /connect Stripe/i);
    assert.equal(payload.message, payload.error);

    const blockers = payload.blockers as Array<Record<string, unknown>>;
    assert.deepEqual(blockers.map((blocker) => blocker.key), ['stripe', 'slack']);
    assert.equal(blockers[0].label, 'Connect Stripe');
    assert.match(String(blockers[0].route), /^\/integrations\?provider=stripe/);
    assert.equal(blockers[1].label, 'Connect Slack');
    assert.match(String(blockers[1].route), /^\/integrations\?provider=slack/);

    // Blocked before triggering: no run record, so nothing was even attempted.
    assert.equal(store.listTaskRuns(workspaceId).length, runsBefore);
  }));

test('rerun endpoint answers 409 workflow_not_ready without starting a fresh run', async () =>
  withReadinessServer(async ({ baseUrl, sessionToken, automationId, workspaceId, store }) => {
    const task = store.createTask({
      workspaceId,
      title: 'QA revenue watch',
      kind: 'automation',
      priority: 'medium',
      delegationState: 'review',
      metadata: {
        automationId,
        reviewRequired: true,
        reviewRequest: {
          status: 'changes_requested',
          note: 'Try again.',
          reviewer: 'QA Operator',
          requestedAt: '2026-08-22T12:00:00.000Z',
        },
      },
    });
    const taskRun = store.createTaskRun({
      workspaceId,
      taskId: task.id,
      agentRole: 'analyst',
      modelTier: 'default',
      estimatedCredits: 10,
      metadata: {
        automationId,
        artifacts: [],
        reviewRequired: true,
        reviewRequest: {
          status: 'changes_requested',
          note: 'Try again.',
          reviewer: 'QA Operator',
          requestedAt: '2026-08-22T12:00:00.000Z',
        },
      },
    });
    store.updateTask(task.id, { status: 'blocked', delegationState: 'review' });
    const runsBefore = store.listTaskRuns(workspaceId).length;

    const response = await fetch(
      `${baseUrl}/api/automations/${automationId}/reviews/${taskRun.id}/rerun`,
      {
        method: 'POST',
        headers: authHeaders(sessionToken),
        body: JSON.stringify({ reviewer: 'QA Operator', note: 'Try again.' }),
      },
    );
    const payload = await readJson(response);

    assert.equal(response.status, 409);
    assert.equal(payload.code, 'workflow_not_ready');
    assert.match(String(payload.error), /connect Stripe/i);
    assert.equal(store.listTaskRuns(workspaceId).length, runsBefore);
  }));

test('a blocked run records the block but acquires no credit hold and no charge', async () =>
  withReadinessServer(async ({ workspaceId, automationId, server, store }) => {
    // Fund the workspace first: if enforcement ever regressed, the run would
    // proceed and a hold would appear, failing the assertions below.
    store.addLedgerEntry({
      workspaceId,
      source: 'manual_adjustment',
      deltaCredits: 500,
      referenceType: 'manual',
      referenceId: 'readiness_test_funding',
    });

    const result = await server.runAutomation({
      id: automationId,
      workspaceId,
      name: 'QA revenue watch',
      actions: ['Check Stripe revenue'],
      steps: STRIPE_QUERY_STEPS,
      notify: '#violema-demo',
    });

    assert.equal(result.ok, false);
    assert.match(String(result.error), /connect Stripe/i);

    // No hold was taken and nothing was debited.
    assert.equal(store.getWorkspaceCreditReserve(workspaceId).reservedCredits, 0);
    const automationLedgerEntries = store
      .listLedgerEntries(workspaceId)
      .filter((entry) => entry.referenceType === 'automation');
    assert.deepEqual(automationLedgerEntries, []);

    // The block is still visible in the product.
    const blockedRun = store
      .listTaskRuns(workspaceId)
      .find((run) => run.metadata?.automationId === automationId);
    assert.ok(blockedRun, 'Expected a task run recording the block.');
    assert.equal(blockedRun.status, 'failed');
    assert.equal(blockedRun.estimatedCredits, 0);
    assert.equal(blockedRun.actualCredits, 0);

    const blockedTask = store.listTasks(workspaceId).find((item) => item.id === blockedRun.taskId);
    assert.ok(blockedTask, 'Expected a task recording the block.');
    assert.equal(blockedTask.status, 'blocked');
    const readinessBlock = blockedTask.metadata?.readinessBlock as Record<string, unknown>;
    assert.equal(readinessBlock.code, 'workflow_not_ready');
    assert.equal(readinessBlock.tier, 'supported_workflow');
    assert.match(String(blockedTask.metadata?.latestSummary), /connect Stripe/i);
  }));

test('a demo workspace bypasses enforcement even with nothing connected', async () =>
  withReadinessServer(
    async ({ workspaceId, server }) => {
      const decision = await server.evaluateAutomationRunReadiness({
        workspaceId,
        workflowId: 'revenue-watch',
        steps: STRIPE_QUERY_STEPS,
      });

      assert.equal(decision.allowed, true);
      assert.equal(decision.tier, 'demo_bypass');
      assert.deepEqual(decision.blockers, []);
    },
    { demoWorkspace: true },
  ));

test('a real workspace is blocked by the same call a demo workspace passes', async () =>
  withReadinessServer(async ({ workspaceId, server }) => {
    const decision = await server.evaluateAutomationRunReadiness({
      workspaceId,
      workflowId: 'revenue-watch',
      steps: STRIPE_QUERY_STEPS,
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.tier, 'supported_workflow');
    assert.deepEqual(decision.blockers.map((blocker) => blocker.key), ['stripe']);
  }));

test('approval re-scans stored evidence and refuses to send simulated data', async () =>
  withReadinessServer(async ({ baseUrl, sessionToken, automationId, workspaceId, store }) => {
    const fabricatedArtifact = {
      kind: 'review_gate',
      title: 'Ready for review: QA revenue watch',
      payload: {
        markdown: '## Revenue\nMRR is $42,000.',
        deliveryTarget: '#violema-demo',
        approvalRequired: true,
        source: 'stripe',
        simulated: true,
        live: false,
      },
    };
    const task = store.createTask({
      workspaceId,
      title: 'QA revenue watch',
      kind: 'automation',
      priority: 'medium',
      delegationState: 'review',
      metadata: { automationId, latestArtifacts: [fabricatedArtifact], reviewRequired: true },
    });
    const taskRun = store.createTaskRun({
      workspaceId,
      taskId: task.id,
      agentRole: 'analyst',
      modelTier: 'default',
      estimatedCredits: 12,
      metadata: { automationId, artifacts: [fabricatedArtifact], reviewRequired: true },
    });
    store.updateTask(task.id, { status: 'waiting_review', delegationState: 'review' });
    store.updateTaskRun(taskRun.id, { status: 'succeeded' });

    const response = await fetch(
      `${baseUrl}/api/automations/${automationId}/reviews/${taskRun.id}/approve`,
      {
        method: 'POST',
        headers: authHeaders(sessionToken),
        body: JSON.stringify({ reviewer: 'QA Operator' }),
      },
    );
    const payload = await readJson(response);

    assert.equal(response.status, 409);
    assert.equal(payload.code, 'fabricated_evidence');
    assert.match(String(payload.error), /simulated stripe data/i);
    assert.equal(payload.message, payload.error);

    // Nothing was approved or delivered.
    const ledger = await fetch(`${baseUrl}/api/workflows/runs/${taskRun.id}/ledger`, {
      headers: authHeaders(sessionToken),
    }).then(readJson);
    assert.deepEqual(ledger.items, []);
    assert.equal(store.listTasks(workspaceId).find((item) => item.id === task.id)?.status, 'waiting_review');
  }));

test('the advisory readiness endpoint still reports without enforcing', async () =>
  withReadinessServer(async ({ baseUrl, sessionToken }) => {
    const response = await fetch(`${baseUrl}/api/workflows/revenue-watch/readiness`, {
      headers: authHeaders(sessionToken),
    });
    const payload = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    const report = payload.report as Record<string, unknown>;
    assert.equal(report.workflowId, 'revenue-watch');
    assert.equal(report.ready, false);
    assert.deepEqual(
      (report.blockers as Array<Record<string, unknown>>).map((blocker) => blocker.key),
      ['stripe'],
    );
  }));

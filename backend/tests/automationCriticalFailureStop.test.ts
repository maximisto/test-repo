import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a critical non-continuable query failure stops all downstream generation and delivery', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-critical-stop-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_critical_stop';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-critical-stop';

    const queryData = await import('../src/integrationGateway/queryData');
    const models = await import('../src/models');
    const integrations = await import('../src/integrations');
    let generationCalls = 0;
    let deliveryCalls = 0;
    t.mock.method(queryData, 'executeQueryData', async () => ({
      ok: false as const,
      code: 'integration_query_failed',
      source: 'google_drive',
      message: 'Violema could not read the account library history completely, so this run was stopped before producing a partial brief.',
      can_continue: false,
      nextAction: { label: 'Retry Google Drive', route: '/integrations?provider=google_drive' },
    }));
    t.mock.method(models, 'generateTextDetailed', async () => {
      generationCalls += 1;
      return {
        text: '# Partial brief\n\nThis output must never be generated.',
        stopReason: 'stop',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          provider: 'openrouter' as const,
          model: 'test-model',
        },
      };
    });
    t.mock.method(integrations, 'sendMessage', async () => {
      deliveryCalls += 1;
      return { success: true, status: 'delivered' };
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    const workspaceId = 'workspace_critical_stop';
    store.addLedgerEntry({
      workspaceId,
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'critical_stop_balance',
    });

    const result = await server.runAutomation({
      id: 'auto_critical_stop',
      workspaceId,
      name: 'Critical evidence stop',
      notify: 'C0123456789',
      actions: [],
      steps: [
        {
          id: 'library_read',
          kind: 'query',
          title: 'Read the account library',
          objective: 'Read the complete evidence history.',
          inputs: { source: 'account_library', query_type: 'read' },
        },
        { id: 'summary', kind: 'summarize', title: 'Draft brief', objective: 'Summarize the evidence.' },
        { id: 'deliver', kind: 'deliver', title: 'Deliver brief', objective: 'Deliver the brief.' },
      ],
    });

    assert.equal(result.ok, false);
    assert.equal(generationCalls, 0, 'no model may reason from known-incomplete evidence');
    assert.equal(deliveryCalls, 0, 'no partial brief may leave the workspace');
    const run = store.listTaskRuns(workspaceId)
      .find((candidate) => candidate.metadata?.automationId === 'auto_critical_stop');
    assert.ok(run);
    const steps = run.metadata?.stepExecutions as Array<{ stepId?: string; status?: string; stepSeverity?: string }>;
    assert.deepEqual(steps.map((step) => step.stepId), ['library_read']);
    assert.equal(steps[0]?.status, 'failed');
    assert.equal(steps[0]?.stepSeverity, 'critical');
    assert.equal(
      (run.metadata?.artifacts as Array<{ kind?: string }>).some((artifact) =>
        artifact.kind === 'summary' || artifact.kind === 'delivery' || artifact.kind === 'review_gate'
      ),
      false,
    );
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    if (typeof originalOpenRouter === 'string') process.env.OPENROUTER_API_KEY = originalOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (typeof originalSlackBotToken === 'string') process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
    else delete process.env.SLACK_BOT_TOKEN;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

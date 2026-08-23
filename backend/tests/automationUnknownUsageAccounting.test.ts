import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('missing, zero-only, partial, and retry-unknown provider usage quarantine the automation', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-unknown-usage-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_unknown_usage';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';

    const models = await import('../src/models');
    type Mode = 'missing' | 'zero' | 'partial' | 'contradictory' | 'retry_then_success' | 'partial_retry_then_success';
    let mode: Mode = 'missing';
    t.mock.method(console, 'warn', () => undefined);
    t.mock.method(models, 'generateTextDetailed', async (...args: Parameters<typeof models.generateTextDetailed>) => {
      const baseResult = {
        text: '# Provider accounting test\n\nThe brief was generated.',
        stopReason: 'stop',
      };
      if (mode === 'missing') return baseResult;
      if (mode === 'zero') {
        return {
          ...baseResult,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            provider: 'openrouter' as const,
            model: 'zero-usage-model',
          },
        };
      }
      if (mode === 'partial') {
        return {
          ...baseResult,
          usage: {
            inputTokens: 800,
            provider: 'openrouter' as const,
            model: 'partial-usage-model',
          },
        };
      }
      if (mode === 'contradictory') {
        return {
          ...baseResult,
          usage: {
            inputTokens: 800,
            outputTokens: 300,
            totalTokens: 900,
            provider: 'openrouter' as const,
            model: 'contradictory-usage-model',
          },
        };
      }

      const hooks = args[5];
      assert.ok(hooks?.beforeAttempt && hooks.onAttemptFailure && hooks.onAttemptSuccess);
      const firstAttempt = {
        routeIndex: 0,
        attemptNumber: 1,
        provider: 'openrouter' as const,
        model: 'retry-model',
        baseUrl: 'https://provider.example/v1',
      };
      const secondAttempt = { ...firstAttempt, attemptNumber: 2 };
      await hooks.beforeAttempt(firstAttempt);
      const retryableFailure = Object.assign(new Error('upstream returned 502'), { status: 502 });
      await hooks.onAttemptFailure(
        firstAttempt,
        retryableFailure,
        mode === 'partial_retry_then_success'
          ? {
              inputTokens: 800,
              provider: 'openrouter' as const,
              model: 'retry-model',
            }
          : undefined,
      );
      await hooks.beforeAttempt(secondAttempt);
      const success = {
        ...baseResult,
        usage: {
          inputTokens: 600,
          outputTokens: 200,
          totalTokens: 800,
          provider: 'openrouter' as const,
          model: 'retry-model',
        },
      };
      await hooks.onAttemptSuccess(secondAttempt, success);
      return success;
    });

    const server = await import('../src/server');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_unknown_usage',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'unknown_usage_test',
    });
    const onTrigger = async () => ({ ok: true });
    let automation = scheduler.createAutomation({
      workspaceId: 'workspace_unknown_usage',
      name: 'Unknown usage accounting test',
      schedule: 'every monday at 9am',
      actions: ['Summarize the evidence'],
      steps: [{
        id: 'summary',
        kind: 'summarize',
        title: 'Summarize the evidence',
        objective: 'Produce a concise brief.',
      }],
    }, onTrigger);

    for (const scenario of ['missing', 'zero', 'partial', 'contradictory', 'retry_then_success', 'partial_retry_then_success'] as const) {
      mode = scenario;
      const priorRunIds = new Set(store.listTaskRuns('workspace_unknown_usage').map((run) => run.id));
      const result = await server.runAutomation(automation);
      assert.equal(result.ok, false, `${scenario} usage must not certify a successful run`);
      assert.match(String(result.deliveryError), /accounting reconciliation/i);

      const run = store.listTaskRuns('workspace_unknown_usage')
        .find((candidate) => !priorRunIds.has(candidate.id));
      assert.ok(run, `${scenario} run was persisted`);
      assert.equal(run.status, 'failed');
      assert.equal(run.metadata?.settlementReconciliationRequired, true);
      assert.equal(run.metadata?.accountingComplete, false);
      assert.match(run.error ?? '', /Usage for .* physical provider attempt/i);

      const task = store.listTasks('workspace_unknown_usage').find((candidate) => candidate.id === run.taskId);
      assert.equal(task?.status, 'blocked');
      assert.equal(task?.metadata?.settlementReconciliationRequired, true);
      assert.equal(scheduler.getAutomationById(automation.id)?.status, 'paused');

      const calls = run.metadata?.generationCalls as Array<{
        status?: string;
        usage?: { totalTokens?: number };
      }>;
      const retried = scenario === 'retry_then_success' || scenario === 'partial_retry_then_success';
      assert.equal(calls.length, retried ? 2 : 1);
      if (retried) {
        assert.deepEqual(calls.map((call) => call.status), ['failed', 'succeeded']);
        assert.deepEqual(calls.map((call) => call.usage?.totalTokens), [undefined, 800]);
      }

      const stepCharges = run.metadata?.stepCharges as Array<{
        charge?: { tokenCredits?: number };
      }>;
      if (scenario === 'partial') {
        assert.equal(stepCharges[0]?.charge?.tokenCredits, 4, 'the partial success bills its known 800-token minimum');
      }
      if (scenario === 'contradictory') {
        assert.equal(stepCharges[0]?.charge?.tokenCredits, 8, 'the observed 1,100-token component sum wins over a contradictory 900 total');
        const telemetry = server.summarizeTaskRunProviderUsage(run);
        assert.deepEqual(
          { input: telemetry.inputTokens, output: telemetry.outputTokens, total: telemetry.totalTokens },
          { input: 800, output: 300, total: 1_100 },
        );
      }
      if (scenario === 'partial_retry_then_success') {
        assert.equal(stepCharges[0]?.charge?.tokenCredits, 8, 'partial failed and complete successful attempts are both billed');
      }

      const settlement = store.listLedgerEntries('workspace_unknown_usage').find((entry) =>
        entry.metadata?.holdStatus === 'settled'
        && entry.metadata?.taskRunId === run.id
      );
      assert.ok(settlement, `${scenario} known minimum was settled`);
      assert.equal(settlement.metadata?.settlementReconciliationRequired, true);
      assert.equal(settlement.metadata?.accountingComplete, false);

      const resumed = scheduler.updateAutomation(automation.id, { status: 'active' }, onTrigger);
      assert.ok(resumed);
      automation = resumed;
    }
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    if (typeof originalOpenRouter === 'string') process.env.OPENROUTER_API_KEY = originalOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

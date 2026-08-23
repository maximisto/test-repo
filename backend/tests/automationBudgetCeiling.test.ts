import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a 150-credit mission pauses before the next call and never settles above 150', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-budget-ceiling-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_budget_ceiling';
    process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

    const models = await import('../src/models');
    t.mock.method(console, 'log', () => undefined);
    let modelCalls = 0;
    t.mock.method(models, 'generateTextDetailed', async () => {
      modelCalls += 1;
      assert.equal(modelCalls, 1, 'the second generation must be refused before provider execution');
      return {
        text: '# Deep analysis\n\nA concise result from the large supplied context.',
        stopReason: 'stop',
        usage: {
          inputTokens: 7_000,
          outputTokens: 200,
          totalTokens: 7_200,
          provider: 'openrouter' as const,
          model: 'hard-analysis-model',
        },
      };
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_budget_ceiling',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'budget_ceiling_test',
    });

    const automation = {
      id: 'auto_budget_ceiling',
      workspaceId: 'workspace_budget_ceiling',
      name: 'Strict budget ceiling test',
      description: 'context '.repeat(800),
      actions: [],
      credit_budget_per_run: 150,
      steps: [
        {
          id: 'analysis',
          kind: 'analyze' as const,
          title: 'Deep evidence analysis',
          objective: 'Perform deep analysis of the supplied context.',
        },
        {
          id: 'summary',
          kind: 'summarize' as const,
          title: 'Founder summary',
          objective: 'Summarize the analysis.',
        },
      ],
    };
    const plan = server.buildAutomationExecutionPlan(automation);
    assert.ok(plan.estimatedCredits < 150, `fixture requires preflight below 150, got ${plan.estimatedCredits}`);

    const result = await server.runAutomation(automation);
    assert.equal(result.ok, false);
    assert.match(String(result.deliveryError), /paused before summary/i);
    assert.equal(modelCalls, 1);

    const run = store.listTaskRuns('workspace_budget_ceiling')
      .find((candidate) => candidate.metadata?.automationId === 'auto_budget_ceiling');
    assert.ok(run);
    assert.ok((run.actualCredits ?? Number.POSITIVE_INFINITY) <= 150);
    const budgetBlock = run.metadata?.creditBudgetBlock as {
      budgetCredits?: number;
      purpose?: string;
      projectedCredits?: number;
    };
    assert.equal(budgetBlock.budgetCredits, 150);
    assert.equal(budgetBlock.purpose, 'summary');
    assert.ok((budgetBlock.projectedCredits ?? 0) > 150);
    const calls = run.metadata?.generationCalls as Array<{ purpose?: string; usage?: unknown }>;
    assert.deepEqual(calls.map((call) => call.purpose), ['analysis']);
    assert.ok(calls[0].usage, 'the first call usage remains accounted');

    const settlement = store.listLedgerEntries('workspace_budget_ceiling').find((entry) =>
      entry.metadata?.holdStatus === 'settled' && entry.referenceId === 'auto_budget_ceiling'
    );
    assert.ok(settlement);
    assert.ok(Math.abs(settlement.deltaCredits) <= 150, `settled ${settlement.deltaCredits} credits`);
    assert.ok(Number(settlement.metadata?.settlementCredits) <= 150);
    assert.equal(settlement.metadata?.authorizedCredits, 150);
    assert.equal((settlement.metadata?.generationCalls as unknown[]).length, 1);
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

test('a retry attempt is separately authorized and failed-attempt usage stays in accounting', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-retry-budget-ceiling-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_retry_budget_ceiling';
    process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

    const models = await import('../src/models');
    t.mock.method(console, 'log', () => undefined);
    let providerAttempts = 0;
    t.mock.method(models, 'generateTextDetailed', async (...args: Parameters<typeof models.generateTextDetailed>) => {
      const hooks = args[5];
      assert.ok(hooks?.beforeAttempt && hooks.onAttemptFailure, 'runtime attempt hooks must reach the model boundary');
      const firstAttempt = {
        routeIndex: 0,
        attemptNumber: 1,
        provider: 'openrouter' as const,
        model: 'hard-analysis-model',
        baseUrl: 'https://provider.example/v1',
      };
      await hooks.beforeAttempt(firstAttempt);
      providerAttempts += 1;
      const retryable = Object.assign(new Error('provider failed after reporting usage'), { status: 503 });
      await hooks.onAttemptFailure(firstAttempt, retryable, {
        inputTokens: 6_800,
        outputTokens: 200,
        totalTokens: 7_000,
        provider: 'openrouter',
        model: 'hard-analysis-model',
      });

      const secondAttempt = { ...firstAttempt, attemptNumber: 2 };
      await hooks.beforeAttempt(secondAttempt);
      providerAttempts += 1;
      throw new Error('test fixture expected the second attempt to be blocked');
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_retry_budget_ceiling',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'retry_budget_ceiling_test',
    });

    const automation = {
      id: 'auto_retry_budget_ceiling',
      workspaceId: 'workspace_retry_budget_ceiling',
      name: 'Strict retry budget ceiling test',
      description: 'context '.repeat(800),
      actions: [],
      credit_budget_per_run: 150,
      steps: [
        {
          id: 'analysis',
          kind: 'analyze' as const,
          title: 'Deep evidence analysis',
          objective: 'Perform deep analysis of the supplied context.',
        },
        {
          id: 'summary',
          kind: 'summarize' as const,
          title: 'Founder summary',
          objective: 'Summarize the analysis.',
        },
      ],
    };
    const plan = server.buildAutomationExecutionPlan(automation);
    assert.ok(plan.estimatedCredits < 150, `fixture requires preflight below 150, got ${plan.estimatedCredits}`);

    const result = await server.runAutomation(automation);
    assert.equal(result.ok, false);
    assert.equal(providerAttempts, 1, 'the retry must be refused before a second provider request starts');

    const run = store.listTaskRuns('workspace_retry_budget_ceiling')
      .find((candidate) => candidate.metadata?.automationId === 'auto_retry_budget_ceiling');
    assert.ok(run);
    const calls = run.metadata?.generationCalls as Array<{
      status?: string;
      attemptNumber?: number;
      authorizedTokenCredits?: number;
      usage?: { totalTokens?: number };
    }>;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 'failed');
    assert.equal(calls[0].attemptNumber, 1);
    assert.ok((calls[0].authorizedTokenCredits ?? 0) > 0);
    assert.equal(calls[0].usage?.totalTokens, 7_000, 'usage from the failed provider attempt must be persisted');
    assert.equal(run.metadata?.creditBudgetBlock && (run.metadata.creditBudgetBlock as { purpose?: string }).purpose, 'analysis');
    assert.ok((run.actualCredits ?? Number.POSITIVE_INFINITY) <= 150);
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

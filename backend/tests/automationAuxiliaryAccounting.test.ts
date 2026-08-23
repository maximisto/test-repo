import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('summary, baseline, and memo usage reconcile through charges, settlement, and usage telemetry', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-aux-accounting-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_aux_accounting';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-aux-accounting';

    const models = await import('../src/models');
    const accountLibrary = await import('../src/integrationGateway/accountLibrary');
    const libraryBaseline = await import('../src/integrationGateway/libraryBaseline');
    const summaryPolicy = await import('../src/platform/automationSummaryPolicy');
    const fullBrief = Array.from({ length: 400 }, (_, index) => `fact${index + 1}`).join(' ');
    const invalidMemo = Array.from({ length: 351 }, (_, index) => `memo${index + 1}`).join(' ');
    const usages = [
      { inputTokens: 800, outputTokens: 200, totalTokens: 1_000, provider: 'openrouter' as const, model: 'summary-model' },
      { inputTokens: 500, outputTokens: 200, totalTokens: 700, provider: 'openrouter' as const, model: 'baseline-model' },
      { inputTokens: 600, outputTokens: 200, totalTokens: 800, provider: 'openrouter' as const, model: 'memo-model' },
    ];
    let modelCall = 0;
    t.mock.method(models, 'generateTextDetailed', async () => {
      const usage = usages[modelCall++];
      assert.ok(usage, `unexpected model call ${modelCall}`);
      return {
        text: modelCall === 1
          ? fullBrief
          : modelCall === 2
            ? 'Rolling baseline.'
            : invalidMemo,
        stopReason: 'stop',
        usage,
      };
    });

    t.mock.method(accountLibrary, 'appendLibraryEntry', async () => ({
      ok: true as const,
      section: accountLibrary.COMPETITIVE_INTELLIGENCE_SECTION,
      folderId: 'section-folder',
      fileId: 'brief-file',
      fileName: '2026-08-22 — Brief.md',
      created: true,
    }));
    t.mock.method(libraryBaseline, 'appendLibraryEntryWithBaseline', async (input: any, deps: any) => {
      assert.equal(
        input.entry.versionId,
        input.runId,
        'every distinct task run receives its own findings filename; only retries within that run are idempotent',
      );
      const generated = await deps.generate(
        'ops',
        'Merge the rolling baseline.',
        [{ role: 'user', content: input.latestFindingsMarkdown }],
        libraryBaseline.LIBRARY_BASELINE_MAX_TOKENS,
        input.workspaceId,
      );
      return {
        libraryResult: await accountLibrary.appendLibraryEntry(
          input.workspaceId,
          input.section,
          input.entry,
          deps,
        ),
        baselineResult: {
          ok: true as const,
          fileName: '2026-08-22 — Current state (rolling baseline) run.md',
          created: true,
          generationUsage: generated.usage,
        },
      };
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_aux_accounting',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'aux_accounting_test',
    });

    const result = await server.runAutomation({
      id: 'auto_aux_accounting',
      workspaceId: 'workspace_aux_accounting',
      name: 'Auxiliary accounting test',
      notify: 'C0123456789',
      actions: [],
      steps: [
        { id: 'summary', kind: 'summarize', title: 'Draft brief', objective: 'Draft a full brief.' },
        {
          id: 'library',
          kind: 'query',
          title: 'Record brief',
          objective: 'Record the full brief.',
          inputs: {
            source: 'account_library',
            query_type: 'write',
            section: accountLibrary.COMPETITIVE_INTELLIGENCE_SECTION,
            entry_title: 'Brief',
          },
        },
        {
          id: 'deliver',
          kind: 'deliver',
          title: 'Deliver memo after approval',
          objective: 'Hold for approval, then deliver the memo.',
        },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(modelCall, 3);
    const run = store.listTaskRuns('workspace_aux_accounting')
      .find((candidate) => candidate.metadata?.automationId === 'auto_aux_accounting');
    assert.ok(run);
    const generationCalls = run.metadata?.generationCalls as Array<{
      purpose: string;
      modelTier: string;
      usage?: { totalTokens?: number };
    }>;
    assert.deepEqual(generationCalls.map((call) => call.purpose), [
      'summary',
      'library_baseline',
      'delivery_memo',
    ]);
    assert.deepEqual(generationCalls.map((call) => call.usage?.totalTokens), [1_000, 700, 800]);
    const reviewGate = (run.metadata?.artifacts as Array<{
      kind?: string;
      payload?: { markdown?: string };
    }>).find((artifact) => artifact.kind === 'review_gate');
    const finalBody = reviewGate?.payload?.markdown ?? '';
    assert.equal(
      summaryPolicy.countAutomationWords(finalBody),
      summaryPolicy.AUTOMATION_MEMO_WORD_LIMIT,
      'the final rendered review body, including its footer, stays within 350 words',
    );
    assert.match(finalBody, /fact1/);
    assert.doesNotMatch(finalBody, /fact400/, 'an invalid memo must never fall through to the full brief');
    assert.match(finalBody, /Full analysis/);
    assert.equal(generationCalls[2].purpose, 'delivery_memo');

    const stepCharges = run.metadata?.stepCharges as Array<{
      charge?: { tokenCredits?: number };
      generationCalls?: unknown[];
    }>;
    assert.equal(
      stepCharges.reduce((sum, step) => sum + (step.charge?.tokenCredits ?? 0), 0),
      14,
      'default summary is 4 credits; both ops auxiliaries are 5 each',
    );
    assert.equal(stepCharges.reduce((sum, step) => sum + (step.generationCalls?.length ?? 0), 0), 3);

    const settlement = store.listLedgerEntries('workspace_aux_accounting').find((entry) =>
      entry.metadata?.holdStatus === 'settled' && entry.referenceId === 'auto_aux_accounting'
    );
    assert.ok(settlement, 'the run settlement is persisted');
    const settledCalls = settlement.metadata?.generationCalls as unknown[];
    assert.equal(settledCalls.length, 3);

    const telemetry = server.summarizeTaskRunProviderUsage(run);
    assert.deepEqual(
      { input: telemetry.inputTokens, output: telemetry.outputTokens, total: telemetry.totalTokens },
      { input: 1_900, output: 600, total: 2_500 },
    );
    assert.deepEqual(telemetry.modelRoutes.sort(), [
      'openrouter/baseline-model',
      'openrouter/memo-model',
      'openrouter/summary-model',
    ]);
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

test('a memo budget refusal stops the delivery step instead of falling through to a full-brief send', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-memo-budget-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_memo_budget';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-memo-budget';

    const models = await import('../src/models');
    const accountLibrary = await import('../src/integrationGateway/accountLibrary');
    const libraryBaseline = await import('../src/integrationGateway/libraryBaseline');
    t.mock.method(console, 'log', () => undefined);
    let modelCall = 0;
    t.mock.method(models, 'generateTextDetailed', async () => {
      modelCall += 1;
      if (modelCall === 1) {
        return {
          text: '# Full brief\n\nEvidence-backed findings.',
          stopReason: 'stop',
          usage: {
            inputTokens: 9_000,
            outputTokens: 1_000,
            totalTokens: 10_000,
            provider: 'openrouter' as const,
            model: 'summary-model',
          },
        };
      }
      if (modelCall === 2) {
        return {
          text: 'Rolling baseline.',
          stopReason: 'stop',
          usage: {
            inputTokens: 9_000,
            outputTokens: 1_000,
            totalTokens: 10_000,
            provider: 'openrouter' as const,
            model: 'baseline-model',
          },
        };
      }
      assert.fail('the memo provider call must be refused before execution');
    });

    t.mock.method(accountLibrary, 'appendLibraryEntry', async () => ({
      ok: true as const,
      section: accountLibrary.COMPETITIVE_INTELLIGENCE_SECTION,
      folderId: 'section-folder',
      fileId: 'brief-file',
      fileName: '2026-08-22 — Brief.md',
      created: true,
    }));
    t.mock.method(libraryBaseline, 'appendLibraryEntryWithBaseline', async (input: any, deps: any) => {
      const generated = await deps.generate(
        'ops',
        'Merge the rolling baseline.',
        [{ role: 'user', content: input.latestFindingsMarkdown }],
        libraryBaseline.LIBRARY_BASELINE_MAX_TOKENS,
        input.workspaceId,
      );
      return {
        libraryResult: await accountLibrary.appendLibraryEntry(
          input.workspaceId,
          input.section,
          input.entry,
          deps,
        ),
        baselineResult: {
          ok: true as const,
          fileName: '2026-08-22 — Current state (rolling baseline) run.md',
          created: true,
          generationUsage: generated.usage,
        },
      };
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_memo_budget',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'memo_budget_test',
    });

    const plannedAutomation = {
      id: 'auto_memo_budget',
      workspaceId: 'workspace_memo_budget',
      name: 'Memo budget refusal test',
      notify: 'C0123456789',
      actions: [],
      steps: [
        { id: 'summary', kind: 'summarize' as const, title: 'Draft brief', objective: 'Draft a full brief.' },
        {
          id: 'library',
          kind: 'query' as const,
          title: 'Record brief',
          objective: 'Record the full brief.',
          inputs: {
            source: 'account_library',
            query_type: 'write',
            section: accountLibrary.COMPETITIVE_INTELLIGENCE_SECTION,
            entry_title: 'Brief',
          },
        },
        {
          id: 'deliver',
          kind: 'deliver' as const,
          title: 'Deliver memo after approval',
          objective: 'Hold for approval, then deliver the memo.',
        },
      ],
    };
    const plan = server.buildAutomationExecutionPlan(plannedAutomation);
    const automation = {
      ...plannedAutomation,
      credit_budget_per_run: plan.estimatedCredits,
    };

    const result = await server.runAutomation(automation);
    assert.equal(result.ok, false);
    assert.match(String(result.deliveryError), /paused before delivery_memo/i);
    assert.equal(modelCall, 2, 'summary and baseline ran; memo did not');

    const run = store.listTaskRuns('workspace_memo_budget')
      .find((candidate) => candidate.metadata?.automationId === 'auto_memo_budget');
    assert.ok(run);
    const budgetBlock = run.metadata?.creditBudgetBlock as { purpose?: string; budgetCredits?: number };
    assert.equal(budgetBlock.purpose, 'delivery_memo');
    assert.equal(budgetBlock.budgetCredits, plan.estimatedCredits);
    const steps = run.metadata?.stepExecutions as Array<{
      stepId?: string;
      status?: string;
      output?: unknown;
    }>;
    const deliveryStep = steps.find((step) => step.stepId === 'deliver');
    assert.equal(deliveryStep?.status, 'failed');
    assert.equal(deliveryStep?.output, undefined);
    const calls = run.metadata?.generationCalls as Array<{ purpose?: string }>;
    assert.deepEqual(calls.map((call) => call.purpose), ['summary', 'library_baseline']);

    const settlement = store.listLedgerEntries('workspace_memo_budget').find((entry) =>
      entry.metadata?.holdStatus === 'settled' && entry.referenceId === 'auto_memo_budget'
    );
    assert.ok(settlement);
    assert.ok(Math.abs(settlement.deltaCredits) <= plan.estimatedCredits);
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// NF-1 secondary (2026-08-23 re-review): an unbudgeted run extends its hold
// at each call boundary. When the workspace balance cannot cover the next
// call's byte-safe maximum, the run must pause as an honest credit block
// that points at workspace credits, not die with a raw step error or tell
// the operator to raise a per-run budget they never set.
test('an unbudgeted run that outgrows the workspace balance pauses as a credit block', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-balance-exhaustion-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_balance_exhaustion';
    process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

    const models = await import('../src/models');
    t.mock.method(console, 'log', () => undefined);
    t.mock.method(console, 'warn', () => undefined);
    let modelCalls = 0;
    t.mock.method(models, 'generateTextDetailed', async () => {
      modelCalls += 1;
      assert.equal(modelCalls, 1, 'no provider call may start once the workspace cannot reserve its maximum');
      // The analysis runs heavy, eating most of the workspace balance, so
      // the summary's byte-safe maximum no longer fits and the hold cannot
      // be extended.
      return {
        text: '# Deep analysis\n\nA concise result from the large supplied context.',
        stopReason: 'stop',
        usage: {
          inputTokens: 100_000,
          outputTokens: 500,
          totalTokens: 100_500,
          provider: 'openrouter' as const,
          model: 'hard-analysis-model',
        },
      };
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    const cost = await import('../src/platform/cost');

    const automation = {
      id: 'auto_balance_exhaustion',
      workspaceId: 'workspace_balance_exhaustion',
      name: 'Balance exhaustion test',
      description: 'context '.repeat(3_000),
      actions: [],
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
    const analysisProjection = plan.generationProjections.find((projection) => projection.purpose === 'analysis');
    assert.ok(analysisProjection, 'the plan projects the analysis call');
    // Enough for the forecast plus the analysis call's byte-safe maximum, so
    // the first call is authorized; the heavy analysis usage then leaves too
    // little for the summary's maximum.
    const balanceCredits = plan.estimatedCredits + cost.maximumGenerationCallTokenCredits(analysisProjection).tokenCredits + 10;
    store.addLedgerEntry({
      workspaceId: 'workspace_balance_exhaustion',
      source: 'manual_adjustment',
      deltaCredits: balanceCredits,
      referenceType: 'manual',
      referenceId: 'balance_exhaustion_test',
    });

    const result = await server.runAutomation(automation);
    assert.equal(result.ok, false);
    assert.equal(modelCalls, 1, 'the analysis ran; the summary was refused before provider spend');
    assert.match(String(result.deliveryError), /paused before .*summary/i);

    const run = store.listTaskRuns('workspace_balance_exhaustion')
      .find((candidate) => candidate.metadata?.automationId === 'auto_balance_exhaustion');
    assert.ok(run);
    const block = run.metadata?.creditBudgetBlock as { purpose?: string; summary?: string } | undefined;
    assert.ok(block, 'the pause is recorded as a credit block, not a bare step error');
    assert.match(String(block.purpose), /summary/i);
    assert.match(String(block.summary), /workspace/i);
    assert.match(String(block.summary), /add credits|upgrade/i);
    assert.doesNotMatch(String(block.summary), /per-run budget|raise the budget/i, 'no budget was set, so none can be raised');

    const settlement = store.listLedgerEntries('workspace_balance_exhaustion').find((entry) =>
      entry.metadata?.holdStatus === 'settled' && entry.referenceId === 'auto_balance_exhaustion'
    );
    assert.ok(settlement, 'the hold settles instead of leaking');
    assert.ok(Math.abs(settlement.deltaCredits) <= balanceCredits);
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

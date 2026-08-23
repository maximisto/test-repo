import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { maximumGenerationCallTokenCredits } from '../src/platform/cost';

test('a generation with incomplete usage halts before the next provider call', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-incomplete-usage-budget-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_incomplete_usage_budget';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';

    const models = await import('../src/models');
    let providerCalls = 0;
    t.mock.method(models, 'generateTextDetailed', async () => {
      providerCalls += 1;
      return {
        text: `# Analysis ${providerCalls}\n\nObserved evidence.`,
        stopReason: 'stop',
        usage: providerCalls === 1
          ? {
              inputTokens: 800,
              provider: 'openrouter' as const,
              model: 'partial-usage-model',
            }
          : {
              inputTokens: 800,
              outputTokens: 200,
              totalTokens: 1_000,
              provider: 'openrouter' as const,
              model: 'complete-usage-model',
            },
      };
    });
    const server = await import('../src/server');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const workspaceId = 'workspace_incomplete_usage_budget';
    store.addLedgerEntry({
      workspaceId,
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'incomplete_usage_budget_balance',
    });
    const baseAutomation = scheduler.createAutomation({
      workspaceId,
      name: 'Incomplete usage budget test',
      schedule: 'every monday at 9am',
      actions: ['Analyze the first source', 'Analyze the second source'],
      steps: [
        {
          id: 'analysis_one',
          kind: 'analyze',
          title: 'Analyze first source',
          objective: 'Analyze the first source.',
        },
        {
          id: 'analysis_two',
          kind: 'analyze',
          title: 'Analyze second source',
          objective: 'Analyze the second source.',
        },
      ],
    }, server.runAutomation);
    const plan = server.buildAutomationExecutionPlan(baseAutomation);
    const analyses = plan.generationProjections.filter((call) => call.purpose === 'analysis');
    assert.equal(analyses.length, 2);
    const fixedCredits = plan.steps
      .filter((step) => step.id === 'analysis_one' || step.id === 'analysis_two')
      .reduce((total, step) => total + server.projectedAuthorizedStepCredits({
        stepId: step.id,
        kind: step.kind,
        title: step.title,
        assignedRole: step.assignedRole,
        modelTier: step.modelTier,
        status: 'planned',
        generationCalls: [],
      }), 0);
    const attemptCredits = analyses.reduce(
      (total, call) => total + maximumGenerationCallTokenCredits(call).tokenCredits,
      0,
    );
    const budget = fixedCredits + attemptCredits - 1;
    assert.ok(plan.estimatedCredits < budget, 'the forecast is allowed to begin under this mission budget');
    const automation = scheduler.updateAutomation(
      baseAutomation.id,
      { credit_budget_per_run: budget },
      server.runAutomation,
    );
    assert.ok(automation);

    const result = await server.runAutomation(automation);
    assert.equal(result.ok, false);
    const run = store.listTaskRuns(workspaceId)
      .find((candidate) => candidate.metadata?.automationId === automation.id);
    assert.ok(run);
    assert.equal(
      providerCalls,
      1,
      `the second provider boundary is refused while the first call still has unknown billable output: ${JSON.stringify({
        budget,
        fixedCredits,
        attemptCredits,
        authorizedCredits: run.metadata?.authorizedCredits,
        stepExecutions: run.metadata?.stepExecutions,
      })}`,
    );
    const steps = run.metadata?.stepExecutions as Array<{ stepId?: string; status?: string; error?: string }>;
    assert.equal(steps.find((step) => step.stepId === 'analysis_two'), undefined);
    assert.equal(steps.find((step) => step.stepId === 'analysis_one')?.status, 'failed');
    assert.match(steps.find((step) => step.stepId === 'analysis_one')?.error ?? '', /accounting reconciliation/i);
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

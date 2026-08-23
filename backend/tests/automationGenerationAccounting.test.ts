import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a competitive run persists every returned generation usage exactly once', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-generation-accounting-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_generation_accounting';
    process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

    const models = await import('../src/models');
    const returnedUsages = [
      { inputTokens: 800, outputTokens: 200, totalTokens: 1_000, provider: 'openrouter', model: 'analysis-model' },
      { inputTokens: 500, outputTokens: 200, totalTokens: 700, provider: 'openrouter', model: 'extraction-model' },
      { inputTokens: 1_000, outputTokens: 300, totalTokens: 1_300, provider: 'openrouter', model: 'summary-model' },
    ];
    let callIndex = 0;
    t.mock.method(models, 'generateTextDetailed', async (...args: Parameters<typeof models.generateTextDetailed>) => {
      const system = args[1];
      const usage = returnedUsages[callIndex++];
      assert.ok(usage, `unexpected generation call ${callIndex}`);
      return {
        text: system.includes('strict JSON')
          ? '{"competitors":[{"name":"Alpha","pricing_usd_month":50,"funding_musd":12},{"name":"Beta","pricing_usd_month":75,"funding_musd":20}]}'
          : '# Brief\n\nA concise evidence-backed result.',
        stopReason: 'stop',
        usage,
      };
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    assert.equal(
      server.projectedAuthorizedStepCredits({
        kind: 'analyze',
        modelTier: 'default',
        generationCalls: [],
      } as unknown as Parameters<typeof server.projectedAuthorizedStepCredits>[0]),
      40,
      'analysis authorization includes markdown, both possible charts, and its bounded duration',
    );
    store.addLedgerEntry({
      workspaceId: 'workspace_generation_accounting',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'generation_accounting_test',
    });

    const result = await server.runAutomation({
      id: 'auto_generation_accounting',
      workspaceId: 'workspace_generation_accounting',
      name: 'Competitive accounting test',
      actions: ['Analyze the competitive market', 'Summarize the findings'],
      steps: [
        {
          id: 'step_analyze',
          kind: 'analyze',
          title: 'Competitive market analysis',
          objective: 'Analyze the competitive market.',
        },
        {
          id: 'step_summary',
          kind: 'summarize',
          title: 'Founder summary',
          objective: 'Summarize the findings.',
        },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(callIndex, 3, 'analysis, structured extraction, and summary all returned usage');

    const run = store.listTaskRuns('workspace_generation_accounting')
      .find((candidate) => candidate.metadata?.automationId === 'auto_generation_accounting');
    assert.ok(run, 'the completed run is persisted');
    const generationCalls = run.metadata?.generationCalls as Array<{
      purpose?: string;
      usage?: { totalTokens?: number };
    }> | undefined;
    assert.ok(Array.isArray(generationCalls), 'first-class generation events are persisted on the run');
    assert.equal(generationCalls.length, 3);
    assert.deepEqual(
      generationCalls.map((call) => call.usage?.totalTokens),
      [1_000, 700, 1_300],
    );
    assert.deepEqual(
      generationCalls.map((call) => call.purpose),
      ['analysis', 'competitive_extraction', 'summary'],
    );
    const analyzeStep = (run.metadata?.stepExecutions as Array<{
      kind?: string;
      artifactCount?: number;
      charge?: { artifactCredits?: number };
    }> | undefined)?.find((step) => step.kind === 'analyze');
    assert.equal(analyzeStep?.artifactCount, 3, 'analysis markdown plus both charts are counted');
    assert.equal(analyzeStep?.charge?.artifactCredits, 15, 'every produced artifact is billed once');
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

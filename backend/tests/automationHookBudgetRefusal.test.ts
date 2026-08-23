import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// NF-2 (2026-08-23 re-review): a budget refusal raised inside a retry's
// `beforeAttempt` hook reaches the step wrapped in `ModelAttemptHookError`.
// The fatal-error check must still recognise it, otherwise the additive
// extraction (or the memo tier) treats it as a soft failure and the step
// carries on as if nothing had been refused.
test('a budget refusal inside a retry attempt hook still fails the step as a budget block', async (t) => {
  const originalCwd = process.cwd();
  const originalFetch = global.fetch;
  const envKeys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'MINIMAX_API_KEY',
    'ZAI_API_KEY',
    'MODEL_DEFAULT_PROVIDER',
    'MODEL_DEFAULT_MODEL',
    'MODEL_DEFAULT_API_KEY_ENV',
    'MODEL_DEFAULT_BASE_URL',
    'MODEL_RETRY_DELAYS_MS',
    'VIOLEMA_DISABLE_AUTOMATION_SCHEDULER',
    'DEMO_WORKSPACE_IDS',
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]] as const));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-hook-budget-refusal-'));

  try {
    process.chdir(tempDir);
    for (const key of envKeys) delete process.env[key];
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_hook_budget_refusal';
    process.env.MODEL_DEFAULT_PROVIDER = 'openrouter';
    process.env.MODEL_DEFAULT_MODEL = 'test/hook-budget-model';
    process.env.MODEL_DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY';
    process.env.MODEL_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-hook-budget-key';
    process.env.MODEL_RETRY_DELAYS_MS = '1';

    let providerCalls = 0;
    global.fetch = async (input) => {
      providerCalls += 1;
      assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions');
      if (providerCalls === 1) {
        // The analysis generation succeeds with a known, small usage.
        return new Response(JSON.stringify({
          choices: [{ message: { content: '# Competitive analysis\n\nTwo rivals, both priced above us.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2_000, completion_tokens: 200, total_tokens: 2_200 },
        }), { headers: { 'content-type': 'application/json' }, status: 200 });
      }
      if (providerCalls === 2) {
        // The extraction's first physical attempt dies without usage, so its
        // full authorization stays committed and the retry cannot fit.
        return new Response(JSON.stringify({ error: { message: 'upstream provider died during generation' } }), {
          headers: { 'content-type': 'application/json' },
          status: 502,
        });
      }
      throw new Error('the extraction retry must be refused before a second provider request starts');
    };

    t.mock.method(console, 'log', () => undefined);
    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_hook_budget_refusal',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'hook_budget_refusal_test',
    });

    const automation = {
      id: 'auto_hook_budget_refusal',
      workspaceId: 'workspace_hook_budget_refusal',
      name: 'Hook budget refusal',
      description: 'market context '.repeat(1_700),
      actions: [],
      credit_budget_per_run: 500,
      steps: [
        {
          id: 'analysis',
          kind: 'analyze' as const,
          title: 'Competitive market analysis',
          objective: 'Analyze the competitive market evidence.',
        },
      ],
    };
    const plan = server.buildAutomationExecutionPlan(automation);
    assert.ok(plan.estimatedCredits < 500, `fixture requires preflight below 500, got ${plan.estimatedCredits}`);

    const result = await server.runAutomation(automation);
    assert.equal(result.ok, false);
    assert.equal(providerCalls, 2, 'exactly one analysis call and one refused-on-retry extraction attempt');

    const run = store.listTaskRuns('workspace_hook_budget_refusal')
      .find((candidate) => candidate.metadata?.automationId === 'auto_hook_budget_refusal');
    assert.ok(run);
    const budgetBlock = run.metadata?.creditBudgetBlock as { purpose?: string } | undefined;
    assert.equal(budgetBlock?.purpose, 'competitive_extraction', 'the refusal happened inside the extraction retry');

    const steps = run.metadata?.stepExecutions as Array<{ stepId: string; status: string; error?: string }>;
    const analysis = steps.find((step) => step.stepId === 'analysis');
    assert.ok(analysis);
    assert.equal(analysis.status, 'failed', 'a budget refusal inside the step is a budget block, not a soft extraction miss');
    assert.match(String(analysis.error), /paused before competitive_extraction/i);
    assert.doesNotMatch(String(analysis.error), /hook failed/i, 'the operator sees the budget message, not the transport wrapper');
    assert.match(String(result.deliveryError), /paused before competitive_extraction/i);
  } finally {
    global.fetch = originalFetch;
    process.chdir(originalCwd);
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

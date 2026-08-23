import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('automation uses a configured fallback and never invents a pre-boundary provider attempt', async (t) => {
  const originalCwd = process.cwd();
  const originalFetch = global.fetch;
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const envKeys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'MINIMAX_API_KEY',
    'ZAI_API_KEY',
    'MODEL_DEFAULT_PROVIDER',
    'MODEL_DEFAULT_MODEL',
    'MODEL_DEFAULT_API_KEY_ENV',
    'MODEL_DEFAULT_FALLBACK_1_PROVIDER',
    'MODEL_DEFAULT_FALLBACK_1_MODEL',
    'MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV',
    'MODEL_DEFAULT_FALLBACK_1_BASE_URL',
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]] as const));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-automation-model-routing-'));

  try {
    process.chdir(tempDir);
    for (const key of envKeys) delete process.env[key];
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_model_routing';
    process.env.MODEL_DEFAULT_PROVIDER = 'anthropic';
    process.env.MODEL_DEFAULT_MODEL = 'claude-sonnet-5';
    process.env.MODEL_DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';
    process.env.MODEL_DEFAULT_FALLBACK_1_PROVIDER = 'openrouter';
    process.env.MODEL_DEFAULT_FALLBACK_1_MODEL = 'z-ai/glm-5.2';
    process.env.MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV = 'OPENROUTER_API_KEY';
    process.env.MODEL_DEFAULT_FALLBACK_1_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-automation-key';

    let providerCalls = 0;
    global.fetch = async (input) => {
      providerCalls += 1;
      assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '# Routed brief\n\nThe configured fallback completed the run.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      }), { headers: { 'content-type': 'application/json' }, status: 200 });
    };

    t.mock.method(console, 'log', () => undefined);
    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_model_routing',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'model_routing_test',
    });

    const routed = await server.runAutomation({
      id: 'auto_openrouter_fallback',
      workspaceId: 'workspace_model_routing',
      name: 'OpenRouter fallback automation',
      actions: ['Summarize the evidence'],
      steps: [{
        id: 'summary',
        kind: 'summarize',
        title: 'Summarize',
        objective: 'Summarize the evidence.',
      }],
    });
    assert.equal(routed.ok, true);
    assert.equal(providerCalls, 1);
    const routedRun = store.listTaskRuns('workspace_model_routing')
      .find((run) => run.metadata?.automationId === 'auto_openrouter_fallback');
    assert.ok(routedRun);
    const routedCalls = routedRun.metadata?.generationCalls as Array<{ provider?: string }>;
    assert.deepEqual(routedCalls.map((call) => call.provider), ['openrouter']);
    assert.notEqual(routedRun.metadata?.settlementReconciliationRequired, true);

    delete process.env.OPENROUTER_API_KEY;
    const unconfigured = await server.runAutomation({
      id: 'auto_no_model_route',
      workspaceId: 'workspace_model_routing',
      name: 'No model route automation',
      actions: ['Summarize the evidence'],
      steps: [{
        id: 'summary',
        kind: 'summarize',
        title: 'Summarize',
        objective: 'Summarize the evidence.',
      }],
    });
    assert.equal(unconfigured.ok, false);
    assert.equal(providerCalls, 1, 'no provider boundary is crossed after the last key is removed');
    const unconfiguredRun = store.listTaskRuns('workspace_model_routing')
      .find((run) => run.metadata?.automationId === 'auto_no_model_route');
    assert.ok(unconfiguredRun);
    assert.deepEqual(unconfiguredRun.metadata?.generationCalls ?? [], []);
    assert.notEqual(unconfiguredRun.metadata?.settlementReconciliationRequired, true);
    assert.doesNotMatch(unconfiguredRun.error ?? '', /physical provider attempt/i);
  } finally {
    global.fetch = originalFetch;
    process.chdir(originalCwd);
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('configured credentials do not make an unsupported text provider executable', async () => {
  const envKeys = [
    'ANTHROPIC_API_KEY',
    'MINIMAX_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'ZAI_API_KEY',
    'MISTRAL_API_KEY',
    'MODEL_DEFAULT_PROVIDER',
    'MODEL_DEFAULT_MODEL',
    'MODEL_DEFAULT_API_KEY_ENV',
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]] as const));

  try {
    for (const key of envKeys) delete process.env[key];
    process.env.MODEL_DEFAULT_PROVIDER = 'mistral';
    process.env.MODEL_DEFAULT_MODEL = 'mistral-large-latest';
    process.env.MODEL_DEFAULT_API_KEY_ENV = 'MISTRAL_API_KEY';
    process.env.MISTRAL_API_KEY = 'test-mistral-key';
    const models = await import('../src/models');

    assert.equal(
      models.hasConfiguredTextGenerationRoute('default', 'workspace_unsupported_text_provider'),
      false,
      'readiness must use the same executable-provider set as generation',
    );
    await assert.rejects(
      models.generateTextDetailed(
        'default',
        'Return a summary.',
        [{ role: 'user', content: 'Evidence' }],
        100,
        'workspace_unsupported_text_provider',
      ),
      /No configured text generation route/i,
    );
  } finally {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a timed-out generation aborts the provider request and records the failed attempt', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalTimeout = process.env.AUTOMATION_STEP_TIMEOUT_MS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-generation-timeout-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_generation_timeout';
    process.env.AUTOMATION_STEP_TIMEOUT_MS = '25';
    process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

    const models = await import('../src/models');
    t.mock.method(console, 'log', () => undefined);
    let modelCalls = 0;
    let providerAborted = false;
    let lateProviderCompletion = false;
    t.mock.method(models, 'generateTextDetailed', async (...args: Parameters<typeof models.generateTextDetailed>) => {
      modelCalls += 1;
      const hooks = args[5];
      assert.ok(hooks?.signal && hooks.beforeAttempt && hooks.onAttemptStart && hooks.onAttemptFailure && hooks.onAttemptSuccess);
      const attempt = {
        routeIndex: 0,
        attemptNumber: 1,
        provider: 'openrouter' as const,
        model: modelCalls === 1 ? 'analysis-model' : 'summary-model',
        baseUrl: 'https://provider.example/v1',
      };
      await hooks.beforeAttempt(attempt);
      await hooks.onAttemptStart(attempt);

      if (modelCalls > 1) {
        const result = {
          text: '# Timeout summary\n\nThe analysis provider timed out.',
          stopReason: 'stop',
          usage: {
            inputTokens: 50,
            outputTokens: 20,
            totalTokens: 70,
            provider: 'openrouter' as const,
            model: 'summary-model',
          },
        };
        await hooks.onAttemptSuccess(attempt, result);
        return result;
      }

      return await new Promise<never>((resolve, reject) => {
        const lateTimer = setTimeout(() => {
          lateProviderCompletion = true;
          resolve(undefined as never);
        }, 200);
        hooks.signal?.addEventListener('abort', () => {
          clearTimeout(lateTimer);
          providerAborted = true;
          const reason = hooks.signal?.reason instanceof Error
            ? hooks.signal.reason
            : new Error('generation aborted');
          void Promise.resolve(hooks.onAttemptFailure?.(attempt, reason)).finally(() => reject(reason));
        }, { once: true });
      });
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_generation_timeout',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'generation_timeout_test',
    });

    const result = await server.runAutomation({
      id: 'auto_generation_timeout',
      workspaceId: 'workspace_generation_timeout',
      name: 'Generation timeout test',
      actions: ['Analyze the evidence'],
      steps: [{
        id: 'analysis',
        kind: 'analyze',
        title: 'Evidence analysis',
        objective: 'Analyze the evidence.',
      }],
    });

    assert.equal(result.ok, false);
    assert.equal(providerAborted, true, 'the timeout must reach the provider request signal');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(lateProviderCompletion, false, 'the timed-out provider operation must not keep running');

    const run = store.listTaskRuns('workspace_generation_timeout')
      .find((candidate) => candidate.metadata?.automationId === 'auto_generation_timeout');
    assert.ok(run);
    const calls = run.metadata?.generationCalls as Array<{ purpose?: string; status?: string; error?: string }>;
    assert.ok(calls.length >= 1);
    assert.equal(calls[0].purpose, 'analysis');
    assert.equal(calls[0].status, 'failed');
    assert.match(calls[0].error ?? '', /timed out/i);
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    if (typeof originalTimeout === 'string') process.env.AUTOMATION_STEP_TIMEOUT_MS = originalTimeout;
    else delete process.env.AUTOMATION_STEP_TIMEOUT_MS;
    if (typeof originalOpenRouter === 'string') process.env.OPENROUTER_API_KEY = originalOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

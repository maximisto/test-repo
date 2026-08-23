import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('failed pre-boundary journals never become physical tool or provider attempts', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-pre-boundary-journal-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_tool_journal,workspace_generation_journal';
    process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

    const integrations = await import('../src/integrations');
    const models = await import('../src/models');
    const scheduler = await import('../src/scheduler');
    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    const updateTaskRun = store.updateTaskRun;
    let rejectGenerationJournals = false;
    let rejectedToolJournal = false;
    let toolBoundaryCalls = 0;
    let providerBoundaryCalls = 0;

    t.mock.method(console, 'log', () => undefined);
    t.mock.method(integrations, 'searchWeb', async () => {
      toolBoundaryCalls += 1;
      return { query: 'test', results: [], provider: 'test' };
    });
    t.mock.method(models, 'generateTextDetailed', async (...args: Parameters<typeof models.generateTextDetailed>) => {
      const hooks = args[5];
      if (rejectGenerationJournals) {
        assert.ok(hooks?.beforeAttempt);
        await hooks.beforeAttempt({
          routeIndex: 0,
          attemptNumber: 1,
          provider: 'openrouter',
          model: 'journal-test-model',
          baseUrl: 'https://provider.example/v1',
        });
        providerBoundaryCalls += 1;
      }
      return {
        text: '# Recovery summary\n\nNo external boundary was crossed.',
        stopReason: 'stop',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          provider: 'openrouter' as const,
          model: 'journal-test-model',
        },
      };
    });
    t.mock.method(store, 'updateTaskRun', (id: string, patch: Parameters<typeof store.updateTaskRun>[1]) => {
      const steps = Array.isArray(patch.metadata?.stepExecutions)
        ? patch.metadata.stepExecutions as Array<{
            toolAttempts?: Array<{ status?: string }>;
            generationCalls?: Array<{ status?: string }>;
          }>
        : [];
      const hasStartedTool = steps.some((step) => step.toolAttempts?.some((attempt) => attempt.status === 'started'));
      const hasRunningGeneration = steps.some((step) => step.generationCalls?.some((call) =>
        call.status === 'prepared' || call.status === 'running'));
      if (hasStartedTool && !rejectedToolJournal) {
        rejectedToolJournal = true;
        throw new Error('tool attempt journal unavailable');
      }
      if (rejectGenerationJournals && hasRunningGeneration) {
        throw new Error('generation attempt journal unavailable');
      }
      return updateTaskRun(id, patch);
    });

    await t.test('tool journal rejection', async () => {
      const workspaceId = 'workspace_tool_journal';
      store.addLedgerEntry({
        workspaceId,
        source: 'manual_adjustment',
        deltaCredits: 5_000,
        referenceType: 'manual',
        referenceId: 'tool_journal_balance',
      });
      const automation = scheduler.createAutomation({
        workspaceId,
        name: 'Tool journal boundary',
        schedule: 'every monday at 9am',
        actions: ['Search for evidence'],
        steps: [{
          id: 'search',
          kind: 'search',
          title: 'Search for evidence',
          objective: 'Search for current evidence.',
        }],
      }, server.runAutomation);

      await server.runAutomation(automation);
      assert.equal(toolBoundaryCalls, 0, 'the external tool callback never starts when its journal fails');
      const run = store.listTaskRuns(workspaceId)
        .find((candidate) => candidate.metadata?.automationId === automation.id);
      assert.ok(run);
      const searchStep = (run.metadata?.stepExecutions as Array<{
        kind?: string;
        toolAttempts?: unknown[];
        charge?: { toolCredits?: number };
      }>).find((step) => step.kind === 'search');
      assert.deepEqual(searchStep?.toolAttempts ?? [], []);
      assert.equal(searchStep?.charge?.toolCredits ?? 0, 0, 'no tool charge is certified before the boundary');
      assert.notEqual(scheduler.getAutomationById(automation.id)?.status, 'paused');
    });

    await t.test('generation journal rejection', async () => {
      rejectGenerationJournals = true;
      const workspaceId = 'workspace_generation_journal';
      store.addLedgerEntry({
        workspaceId,
        source: 'manual_adjustment',
        deltaCredits: 5_000,
        referenceType: 'manual',
        referenceId: 'generation_journal_balance',
      });
      const automation = scheduler.createAutomation({
        workspaceId,
        name: 'Generation journal boundary',
        schedule: 'every tuesday at 9am',
        actions: ['Summarize the evidence'],
        steps: [{
          id: 'summary',
          kind: 'summarize',
          title: 'Summarize evidence',
          objective: 'Summarize the evidence.',
        }],
      }, server.runAutomation);

      await server.runAutomation(automation);
      assert.equal(providerBoundaryCalls, 0, 'the provider callback never starts when its journal fails');
      const run = store.listTaskRuns(workspaceId)
        .find((candidate) => candidate.metadata?.automationId === automation.id);
      assert.ok(run);
      assert.deepEqual(run.metadata?.generationCalls ?? [], []);
      assert.equal(run.metadata?.settlementReconciliationRequired ?? false, false);
      assert.notEqual(scheduler.getAutomationById(automation.id)?.status, 'paused');
    });
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

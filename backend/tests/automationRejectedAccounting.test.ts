import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('an over-limit summary and its fallback are both charged and persisted', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-rejected-accounting-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_rejected_accounting';
    process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

    const models = await import('../src/models');
    let modelCall = 0;
    t.mock.method(models, 'generateTextDetailed', async () => {
      modelCall += 1;
      if (modelCall === 1) {
        return {
          text: Array.from({ length: 651 }, (_, index) => `word${index + 1}`).join(' '),
          stopReason: 'stop',
          usage: {
            inputTokens: 800,
            outputTokens: 200,
            totalTokens: 1_000,
            provider: 'openrouter' as const,
            model: 'rejected-summary-model',
          },
        };
      }
      return {
        text: '# Deterministic recovery\n\nThe rejected draft was withheld.',
        stopReason: 'stop',
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          totalTokens: 600,
          provider: 'openrouter' as const,
          model: 'fallback-model',
        },
      };
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_rejected_accounting',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'rejected_accounting_test',
    });

    const result = await server.runAutomation({
      id: 'auto_rejected_accounting',
      workspaceId: 'workspace_rejected_accounting',
      name: 'Rejected generation accounting test',
      actions: [],
      steps: [{
        id: 'summary',
        kind: 'summarize',
        title: 'Draft founder brief',
        objective: 'Draft a founder brief.',
      }],
    });

    assert.equal(result.ok, false, 'the critical over-limit summary keeps the run failed');
    assert.equal(modelCall, 2, 'the rejected result is followed by one fallback generation');
    const run = store.listTaskRuns('workspace_rejected_accounting')
      .find((candidate) => candidate.metadata?.automationId === 'auto_rejected_accounting');
    assert.ok(run);
    const calls = run.metadata?.generationCalls as Array<{
      status: string;
      purpose: string;
      usage?: { totalTokens?: number };
    }>;
    assert.deepEqual(calls.map((call) => call.purpose), ['summary', 'fallback_summary']);
    assert.deepEqual(calls.map((call) => call.status), ['rejected', 'succeeded']);
    assert.deepEqual(calls.map((call) => call.usage?.totalTokens), [1_000, 600]);

    const stepCharges = run.metadata?.stepCharges as Array<{
      charge?: { tokenCredits?: number };
      generationCalls?: unknown[];
    }>;
    assert.equal(stepCharges.length, 1);
    assert.equal(stepCharges[0].generationCalls?.length, 2);
    assert.equal(stepCharges[0].charge?.tokenCredits, 8, 'both default-tier calls are billed');

    const settlement = store.listLedgerEntries('workspace_rejected_accounting').find((entry) =>
      entry.metadata?.holdStatus === 'settled' && entry.referenceId === 'auto_rejected_accounting'
    );
    assert.ok(settlement);
    assert.equal((settlement.metadata?.generationCalls as unknown[]).length, 2);

    const telemetry = server.summarizeTaskRunProviderUsage(run);
    assert.equal(telemetry.totalTokens, 1_600);
    assert.deepEqual(telemetry.modelRoutes.sort(), [
      'openrouter/fallback-model',
      'openrouter/rejected-summary-model',
    ]);
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

test('a baseline rejected after provider success is charged and labeled rejected', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-baseline-rejected-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_baseline_rejected';
    process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

    const models = await import('../src/models');
    const accountLibrary = await import('../src/integrationGateway/accountLibrary');
    const libraryBaseline = await import('../src/integrationGateway/libraryBaseline');
    let modelCall = 0;
    t.mock.method(models, 'generateTextDetailed', async () => {
      modelCall += 1;
      return {
        text: modelCall === 1 ? 'A valid full brief.' : 'x'.repeat(8_000),
        stopReason: 'stop',
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          totalTokens: 600,
          provider: 'openrouter' as const,
          model: modelCall === 1 ? 'summary-model' : 'baseline-model',
        },
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
      await deps.generate(
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
          ok: false as const,
          message: 'The baseline merge produced 8000 bytes and was not recorded.',
          generationRejected: true,
        },
      };
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_baseline_rejected',
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'baseline_rejected_test',
    });
    const result = await server.runAutomation({
      id: 'auto_baseline_rejected',
      workspaceId: 'workspace_baseline_rejected',
      name: 'Rejected baseline telemetry test',
      actions: [],
      steps: [
        { id: 'summary', kind: 'summarize', title: 'Draft brief', objective: 'Draft the brief.' },
        {
          id: 'library',
          kind: 'query',
          title: 'Record brief',
          objective: 'Record the brief.',
          inputs: {
            source: 'account_library',
            query_type: 'write',
            section: accountLibrary.COMPETITIVE_INTELLIGENCE_SECTION,
            entry_title: 'Brief',
          },
        },
      ],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(modelCall, 2);
    const run = store.listTaskRuns('workspace_baseline_rejected')
      .find((candidate) => candidate.metadata?.automationId === 'auto_baseline_rejected');
    assert.ok(run);
    const calls = run.metadata?.generationCalls as Array<{
      purpose?: string;
      status?: string;
      usage?: { totalTokens?: number };
    }>;
    assert.deepEqual(calls.map((call) => call.purpose), ['summary', 'library_baseline']);
    assert.deepEqual(calls.map((call) => call.status), ['succeeded', 'rejected']);
    assert.deepEqual(calls.map((call) => call.usage?.totalTokens), [600, 600]);
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

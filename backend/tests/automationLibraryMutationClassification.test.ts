import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('library failures preserve the proven external-action boundary', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-library-mutation-classification-'));
  const knownWorkspace = 'workspace_library_known_failure';
  const unknownWorkspace = 'workspace_library_unknown_failure';

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = `${knownWorkspace},${unknownWorkspace}`;
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';

    const models = await import('../src/models');
    t.mock.method(models, 'generateTextDetailed', async () => ({
      text: '# Findings\n\nEvidence-backed findings for the account library.',
      stopReason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        provider: 'openrouter' as const,
        model: 'test-model',
      },
    }));

    const libraryBaseline = await import('../src/integrationGateway/libraryBaseline');
    const appendWithBaseline = libraryBaseline.appendLibraryEntryWithBaseline;
    t.mock.method(libraryBaseline, 'appendLibraryEntryWithBaseline', async (input: any, deps: any) => {
      if (input.workspaceId !== unknownWorkspace) return appendWithBaseline(input, deps);
      return {
        libraryResult: {
          ok: false as const,
          code: 'integration_query_failed' as const,
          source: 'google_drive',
          message: 'Drive accepted the findings write, but its response was lost.',
          can_continue: false,
          nextAction: { label: 'Retry Google Drive', route: '/integrations?provider=google_drive' },
          externalActionOutcome: 'unknown' as const,
        },
      };
    });

    const accountLibrary = await import('../src/integrationGateway/accountLibrary');
    const server = await import('../src/server');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');

    const runCase = async (workspaceId: string, entryTitle: string) => {
      store.addLedgerEntry({
        workspaceId,
        source: 'manual_adjustment',
        deltaCredits: 2_000,
        referenceType: 'manual',
        referenceId: `${workspaceId}_balance`,
      });
      const automation = scheduler.createAutomation({
        workspaceId,
        name: `Library boundary ${workspaceId}`,
        schedule: 'every monday at 9am',
        actions: [],
        steps: [{
          id: 'summary',
          kind: 'summarize',
          title: 'Draft findings',
          objective: 'Draft the findings.',
        }, {
          id: 'library',
          kind: 'query',
          title: 'Record findings',
          objective: 'Record the findings in the account library.',
          inputs: {
            source: accountLibrary.ACCOUNT_LIBRARY_SOURCE,
            query_type: accountLibrary.ACCOUNT_LIBRARY_WRITE_QUERY_TYPE,
            section: accountLibrary.COMPETITIVE_INTELLIGENCE_SECTION,
            entry_title: entryTitle,
          },
        }],
      }, server.runAutomation);
      await server.runAutomation(automation);
      const run = store.listTaskRuns(workspaceId)
        .find((candidate) => candidate.metadata?.automationId === automation.id);
      assert.ok(run);
      const libraryStep = (run.metadata?.stepExecutions as Array<{
        stepId?: string;
        toolAttempts?: Array<{ status?: string; mutating?: boolean }>;
      }>).find((step) => step.stepId === 'library');
      assert.ok(libraryStep);
      return { automation, run, attempt: libraryStep.toolAttempts?.[0] };
    };

    const known = await runCase(
      knownWorkspace,
      `${accountLibrary.LIBRARY_BASELINE_TITLE_PREFIX} forged by operator`,
    );
    assert.equal(known.attempt?.status, 'failed', 'pre-boundary validation proves no Drive mutation occurred');
    assert.notEqual(known.run.metadata?.externalActionReconciliationRequired, true);
    assert.notEqual(scheduler.getAutomationById(known.automation.id)?.status, 'paused');

    const unknown = await runCase(unknownWorkspace, 'Competitive findings');
    assert.equal(unknown.attempt?.status, 'outcome_unknown');
    assert.equal(unknown.run.metadata?.externalActionReconciliationRequired, true);
    assert.equal(scheduler.getAutomationById(unknown.automation.id)?.status, 'paused');
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('incomplete auxiliary generation usage halts before delivery or review preparation', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-incomplete-usage-delivery-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_incomplete_usage_delivery';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';

    const models = await import('../src/models');
    const integrations = await import('../src/integrations');
    const accountLibrary = await import('../src/integrationGateway/accountLibrary');
    const libraryBaseline = await import('../src/integrationGateway/libraryBaseline');
    let modelCall = 0;
    let deliveryCalls = 0;
    t.mock.method(models, 'generateTextDetailed', async () => {
      modelCall += 1;
      if (modelCall === 1) {
        return {
          text: '# Fallback summary\n\nEvidence-backed status.',
          stopReason: 'stop',
          usage: {
            inputTokens: 300,
            provider: 'openrouter' as const,
            model: 'incomplete-fallback-model',
          },
        };
      }
      if (modelCall === 2) {
        return {
          text: '# Full brief\n\nEvidence-backed findings.',
          stopReason: 'stop',
          usage: {
            inputTokens: 500,
            outputTokens: 100,
            totalTokens: 600,
            provider: 'openrouter' as const,
            model: 'summary-model',
          },
        };
      }
      if (modelCall === 3) {
        return {
          text: 'Rolling baseline.',
          stopReason: 'stop',
          usage: {
            inputTokens: 200,
            outputTokens: 50,
            totalTokens: 250,
            provider: 'openrouter' as const,
            model: 'baseline-model',
          },
        };
      }
      return {
        text: 'Decision-ready memo.',
        stopReason: 'stop',
        usage: {
          inputTokens: 200,
          provider: 'openrouter' as const,
          model: 'incomplete-memo-model',
        },
      };
    });
    t.mock.method(integrations, 'sendMessage', async () => {
      deliveryCalls += 1;
      return { success: true, status: 'delivered', channel: 'slack', to: '#founder-update' };
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
    const workspaceId = 'workspace_incomplete_usage_delivery';
    store.addLedgerEntry({
      workspaceId,
      source: 'manual_adjustment',
      deltaCredits: 10_000,
      referenceType: 'manual',
      referenceId: 'incomplete_usage_delivery_balance',
    });

    const fallbackResult = await server.runAutomation({
      id: 'auto_incomplete_fallback_delivery',
      workspaceId,
      name: 'Incomplete fallback summary delivery',
      notify: '#founder-update',
      actions: [],
      steps: [
        { id: 'note', kind: 'note', title: 'Record evidence', objective: 'Record evidence.' },
        { id: 'deliver', kind: 'deliver', title: 'Deliver update', objective: 'Deliver the update.' },
      ],
    });
    assert.equal(fallbackResult.ok, false);
    assert.equal(deliveryCalls, 0, 'unknown summary usage stops before any external send');
    const fallbackRun = store.listTaskRuns(workspaceId)
      .find((candidate) => candidate.metadata?.automationId === 'auto_incomplete_fallback_delivery');
    assert.ok(fallbackRun);
    assert.equal(
      (fallbackRun.metadata?.artifacts as Array<{ kind?: string }>).some((artifact) =>
        artifact.kind === 'delivery' || artifact.kind === 'review_gate'
      ),
      false,
      'no delivered or reviewable artifact is created after accounting becomes incomplete',
    );

    const memoResult = await server.runAutomation({
      id: 'auto_incomplete_memo_delivery',
      workspaceId,
      name: 'Incomplete memo usage delivery',
      notify: '#founder-update',
      actions: [],
      steps: [
        { id: 'summary', kind: 'summarize', title: 'Draft brief', objective: 'Draft the full brief.' },
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
          title: 'Prepare memo after approval',
          objective: 'Hold for approval, then deliver the memo.',
        },
      ],
    });
    assert.equal(memoResult.ok, false);
    assert.equal(deliveryCalls, 0);
    const memoRun = store.listTaskRuns(workspaceId)
      .find((candidate) => candidate.metadata?.automationId === 'auto_incomplete_memo_delivery');
    assert.ok(memoRun);
    assert.equal(
      (memoRun.metadata?.artifacts as Array<{ kind?: string }>).some((artifact) => artifact.kind === 'review_gate'),
      false,
      'an incomplete memo call cannot be converted into an approvable deterministic memo',
    );
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

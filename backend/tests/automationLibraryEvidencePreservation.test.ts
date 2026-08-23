import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a complete account-library read preserves every entry through the summary prompt', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-library-evidence-preservation-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_library_preservation';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';

    const sentinel = 'SECOND_ENTRY_TAIL_SENTINEL_MUST_REACH_THE_MODEL';
    const queryData = await import('../src/integrationGateway/queryData');
    const models = await import('../src/models');
    let modelPrompt = '';
    t.mock.method(queryData, 'executeQueryData', async () => ({
      ok: true as const,
      source: 'google_drive',
      query_type: 'account_library_read',
      data: {
        section: 'Competitive Intelligence',
        rootFolderName: 'Violema Library',
        libraryInitialized: true,
        folderId: 'folder-1',
        entryCount: 2,
        appEntryHistoryComplete: true,
        entries: [
          {
            fileId: 'entry-1',
            fileName: '2026-08-21 — First findings.md',
            content: `FIRST_ENTRY ${'a'.repeat(7_000)}`,
            truncated: false,
            origin: 'app_entry',
          },
          {
            fileId: 'entry-2',
            fileName: '2026-08-22 — Second findings.md',
            content: `SECOND_ENTRY ${'b'.repeat(7_000)} ${sentinel}`,
            truncated: false,
            origin: 'app_entry',
          },
        ],
        sweep: { laneState: 'active', warnings: [] },
      },
      fetched_at: '2026-08-22T12:00:00.000Z',
      latency_ms: 5,
      cache_hit: false,
      live: true,
    }));
    t.mock.method(models, 'generateTextDetailed', async (...args: Parameters<typeof models.generateTextDetailed>) => {
      const messages = args[2];
      modelPrompt = messages.map((message) => message.content).join('\n');
      return {
        text: '# Complete brief\n\nBoth entries were preserved.',
        stopReason: 'stop',
        usage: {
          inputTokens: 4_000,
          outputTokens: 40,
          totalTokens: 4_040,
          provider: 'openrouter' as const,
          model: 'test-model',
        },
      };
    });

    const server = await import('../src/server');
    const store = await import('../src/platform/store');
    const workspaceId = 'workspace_library_preservation';
    store.addLedgerEntry({
      workspaceId,
      source: 'manual_adjustment',
      deltaCredits: 5_000,
      referenceType: 'manual',
      referenceId: 'library_preservation_balance',
    });

    const result = await server.runAutomation({
      id: 'auto_library_preservation',
      workspaceId,
      name: 'Preserve complete library evidence',
      actions: [],
      steps: [
        {
          id: 'library_read',
          kind: 'query',
          title: 'Read the account library',
          objective: 'Read the complete evidence history.',
          inputs: { source: 'account_library', query_type: 'read' },
        },
        { id: 'summary', kind: 'summarize', title: 'Draft brief', objective: 'Summarize every entry.' },
      ],
    });

    assert.equal(result.ok, true);
    assert.match(modelPrompt, new RegExp(sentinel), 'the tail of the second complete entry reaches generation');
    const run = store.listTaskRuns(workspaceId)
      .find((candidate) => candidate.metadata?.automationId === 'auto_library_preservation');
    assert.ok(run);
    const artifact = (run.metadata?.artifacts as Array<{ kind?: string; payload?: Record<string, unknown> }>)
      .find((candidate) => candidate.kind === 'query_data');
    assert.equal(artifact?.payload?.truncated, undefined, 'a complete library snapshot is not replaced by an 8 KB preview');
    assert.match(JSON.stringify(artifact?.payload), new RegExp(sentinel));
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

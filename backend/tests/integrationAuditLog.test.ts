import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('workflow ledger persists and filters run events', async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-ledger-'));
  process.chdir(tempDir);

  try {
    const audit = await import('../src/integrationGateway/auditLog');
    const first = audit.appendWorkflowLedgerEvent({
      workspaceId: 'workspace_test',
      workflowId: 'revenue-watch',
      automationId: 'auto_revenue',
      taskId: 'task_revenue',
      taskRunId: 'run_revenue',
      type: 'data_read',
      summary: 'Read Stripe revenue summary.',
      metadata: { source: 'stripe', queryType: 'revenue_summary' },
      now: () => '2026-06-29T12:00:00.000Z',
    });
    audit.appendWorkflowLedgerEvent({
      workspaceId: 'workspace_test',
      workflowId: 'revenue-watch',
      taskRunId: 'run_other',
      type: 'draft_created',
      summary: 'Other run.',
      now: () => '2026-06-29T12:01:00.000Z',
    });

    const items = audit.listWorkflowLedgerEvents({
      workspaceId: 'workspace_test',
      taskRunId: 'run_revenue',
    });

    assert.equal(first.id, 'ledger_run_revenue_data_read_2026-06-29T12-00-00-000Z');
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'data_read');
    assert.equal(items[0].metadata?.source, 'stripe');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('integration query ledger events support every live source without storing payload data', async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-integration-ledger-'));
  process.chdir(tempDir);

  try {
    const audit = await import('../src/integrationGateway/auditLog');
    const success = audit.appendIntegrationQueryLedgerEvent({
      workspaceId: 'purpleorangehq',
      workflowId: 'weekly-founder-update',
      automationId: 'auto_weekly_founder_update',
      taskId: 'task_weekly',
      taskRunId: 'run_weekly',
      source: 'github',
      queryType: 'delivery_risk',
      ok: true,
      live: true,
      message: 'private provider data must not be stored',
      now: () => '2026-07-19T12:00:00.000Z',
    });
    const failure = audit.appendIntegrationQueryLedgerEvent({
      workspaceId: 'purpleorangehq',
      workflowId: 'weekly-founder-update',
      taskRunId: 'run_weekly',
      source: 'google_drive',
      queryType: 'recent_files',
      ok: false,
      live: false,
      message: 'Google Drive needs read access.',
      now: () => '2026-07-19T12:01:00.000Z',
    });

    assert.equal(success.type, 'data_read');
    assert.equal(success.summary, 'Read live GitHub data.');
    assert.deepEqual(success.metadata, {
      source: 'github',
      queryType: 'delivery_risk',
      ok: true,
      live: true,
    });
    assert.equal(failure.type, 'connector_failed');
    assert.equal(failure.summary, 'Google Drive read blocked: Google Drive needs read access.');
    assert.deepEqual(failure.metadata, {
      source: 'google_drive',
      queryType: 'recent_files',
      ok: false,
      live: false,
    });
    assert.doesNotMatch(JSON.stringify([success, failure]), /private provider data/);

    const privateToken = 'sk_live_PRIVATE_LEDGER_TOKEN';
    const hostileFailure = audit.appendIntegrationQueryLedgerEvent({
      workspaceId: 'purpleorangehq',
      workflowId: 'weekly-founder-update',
      taskRunId: 'run_weekly_hostile',
      source: 'stripe',
      queryType: 'revenue_summary',
      ok: false,
      message: `Authorization: Bearer ${privateToken} request_body={"input_text":"CUSTOMER_SENTINEL_PRIVATE_PLAN"} ${'\\'.repeat(100_000)}`,
      now: () => '2026-07-19T12:02:00.000Z',
    });
    assert.doesNotMatch(hostileFailure.summary, /PRIVATE_LEDGER_TOKEN|CUSTOMER_SENTINEL/);
    assert.ok(Buffer.byteLength(hostileFailure.summary, 'utf8') <= 600);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

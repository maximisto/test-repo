import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a failed mutating delivery is quarantined when a remote send may have completed', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-external-action-reconciliation-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_partial_delivery';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-partial-delivery';

    const models = await import('../src/models');
    t.mock.method(models, 'generateTextDetailed', async () => ({
      text: '# Delivery status\n\nThe Slack delivery did not finish cleanly.',
      stopReason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        provider: 'openrouter' as const,
        model: 'test-model',
      },
    }));
    const integrations = await import('../src/integrations');
    t.mock.method(integrations, 'sendMessage', async (input: Parameters<typeof integrations.sendMessage>[0]) => {
      await input.onExternalRequestStart?.();
      throw new Error('Slack part 2 failed after part 1 was accepted.');
    });
    const server = await import('../src/server');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const workspaceId = 'workspace_partial_delivery';
    store.addLedgerEntry({
      workspaceId,
      source: 'manual_adjustment',
      deltaCredits: 1_000,
      referenceType: 'manual',
      referenceId: 'partial_delivery_balance',
    });
    const automation = scheduler.createAutomation({
      workspaceId,
      name: 'Partial Slack delivery',
      schedule: 'every monday at 9am',
      actions: ['Deliver the prepared update'],
      notify: 'C0123456789',
      steps: [{
        id: 'deliver',
        kind: 'deliver',
        title: 'Deliver the update',
        objective: 'Send the prepared update.',
      }],
    }, server.runAutomation);

    const result = await server.runAutomation(automation);
    assert.equal(result.ok, false);
    const run = store.listTaskRuns(workspaceId)
      .find((candidate) => candidate.metadata?.automationId === automation.id);
    assert.ok(run);
    const deliveryStep = (run.metadata?.stepExecutions as Array<{
      kind?: string;
      toolAttempts?: Array<{ status?: string; mutating?: boolean }>;
    }>).find((step) => step.kind === 'deliver');
    assert.equal(deliveryStep?.toolAttempts?.[0]?.status, 'outcome_unknown');
    assert.equal(run.metadata?.externalActionReconciliationRequired, true);
    assert.match(run.error ?? '', /remote outcome must be verified/i);
    assert.equal(store.listTasks(workspaceId).find((task) => task.id === run.taskId)?.status, 'blocked');
    assert.equal(scheduler.getAutomationById(automation.id)?.status, 'paused');
    assert.equal(
      scheduler.triggerAutomationNow(automation.id, server.runAutomation).status,
      'paused',
      'a blind rerun cannot duplicate a potentially delivered message',
    );
    const settlement = store.listLedgerEntries(workspaceId).find((entry) =>
      entry.referenceId === automation.id && entry.metadata?.holdStatus === 'settled'
    );
    assert.ok(settlement, 'the known fixed tool minimum is settled before quarantine');
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    if (typeof originalOpenRouter === 'string') process.env.OPENROUTER_API_KEY = originalOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (typeof originalSlackBotToken === 'string') process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
    else delete process.env.SLACK_BOT_TOKEN;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a successful send followed by a local ledger failure cannot become replayable', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-post-send-ledger-failure-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_post_send_failure';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-post-send';

    const models = await import('../src/models');
    t.mock.method(models, 'generateTextDetailed', async () => ({
      text: '# Delivery status\n\nThe delivery was accepted.',
      stopReason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        provider: 'openrouter' as const,
        model: 'test-model',
      },
    }));
    let sends = 0;
    const integrations = await import('../src/integrations');
    t.mock.method(integrations, 'sendMessage', async (input: Parameters<typeof integrations.sendMessage>[0]) => {
      await input.onExternalRequestStart?.();
      sends += 1;
      return { success: true, status: 'delivered', channel: 'slack', to: '#founder-update' };
    });
    const auditLog = await import('../src/integrationGateway/auditLog');
    const appendLedger = auditLog.appendWorkflowLedgerEvent;
    t.mock.method(auditLog, 'appendWorkflowLedgerEvent', (event: Parameters<typeof appendLedger>[0]) => {
      if (event.type === 'external_action_executed') {
        throw new Error('local workflow ledger write failed after Slack accepted the send');
      }
      return appendLedger(event);
    });

    const server = await import('../src/server');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const workspaceId = 'workspace_post_send_failure';
    store.addLedgerEntry({
      workspaceId,
      source: 'manual_adjustment',
      deltaCredits: 1_000,
      referenceType: 'manual',
      referenceId: 'post_send_balance',
    });
    const automation = scheduler.createAutomation({
      workspaceId,
      name: 'Post-send closeout failure',
      schedule: 'every monday at 9am',
      actions: ['Deliver the prepared update'],
      notify: 'C0123456789',
      steps: [{
        id: 'deliver',
        kind: 'deliver',
        title: 'Deliver the update',
        objective: 'Send the prepared update.',
      }],
    }, server.runAutomation);

    const result = await server.runAutomation(automation);
    assert.equal(result.ok, false);
    assert.equal(sends, 1, 'the remote delivery completed once');
    const run = store.listTaskRuns(workspaceId)
      .find((candidate) => candidate.metadata?.automationId === automation.id);
    assert.ok(run);
    const deliveryStep = (run.metadata?.stepExecutions as Array<{
      kind?: string;
      status?: string;
      toolAttempts?: Array<{ status?: string; mutating?: boolean }>;
    }>).find((step) => step.kind === 'deliver');
    assert.equal(deliveryStep?.status, 'failed', 'the local closeout error remains visible');
    assert.equal(deliveryStep?.toolAttempts?.[0]?.status, 'succeeded', 'the remote send result remains truthful');
    assert.equal(run.metadata?.externalActionReconciliationRequired, true);
    assert.equal(scheduler.getAutomationById(automation.id)?.status, 'paused');
    assert.equal(
      scheduler.triggerAutomationNow(automation.id, server.runAutomation).status,
      'paused',
      'the failed local closeout cannot turn the successful send into a replayable action',
    );
    assert.equal(sends, 1);
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    if (typeof originalOpenRouter === 'string') process.env.OPENROUTER_API_KEY = originalOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (typeof originalSlackBotToken === 'string') process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
    else delete process.env.SLACK_BOT_TOKEN;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a normal delivery refused before the provider boundary is retryable and unbilled', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const originalPostmarkKey = process.env.POSTMARK_API_KEY;
  const originalPostmarkFrom = process.env.POSTMARK_FROM_EMAIL;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-pre-send-refusal-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_pre_send_refusal';
    process.env.OPENROUTER_API_KEY = 'test-model-readiness-key';
    process.env.POSTMARK_API_KEY = 'test-postmark-key';
    process.env.POSTMARK_FROM_EMAIL = 'violema@example.com';

    const models = await import('../src/models');
    t.mock.method(models, 'generateTextDetailed', async () => ({
      text: '# Prepared update\n\nA concise update that is ready to deliver.',
      stopReason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        provider: 'openrouter' as const,
        model: 'test-model',
      },
    }));
    const integrations = await import('../src/integrations');
    t.mock.method(integrations, 'sendMessage', async () => {
      throw new Error('Recipient is suppressed before the Postmark request.');
    });
    const server = await import('../src/server');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const workspaceId = 'workspace_pre_send_refusal';
    store.addLedgerEntry({
      workspaceId,
      source: 'manual_adjustment',
      deltaCredits: 1_000,
      referenceType: 'manual',
      referenceId: 'pre_send_refusal_balance',
    });
    const automation = scheduler.createAutomation({
      workspaceId,
      name: 'Pre-send deterministic refusal',
      schedule: 'every tuesday at 9am',
      actions: ['Deliver the prepared update'],
      notify: 'operator@example.com',
      steps: [{
        id: 'deliver',
        kind: 'deliver',
        title: 'Deliver the update',
        objective: 'Send the prepared update.',
      }],
    }, server.runAutomation);

    const result = await server.runAutomation(automation);
    assert.equal(result.ok, false);
    const run = store.listTaskRuns(workspaceId)
      .find((candidate) => candidate.metadata?.automationId === automation.id);
    assert.ok(run);
    const deliveryStep = (run.metadata?.stepExecutions as Array<{
      kind?: string;
      toolCalls?: number;
      toolAttempts?: unknown[];
      charge?: { toolCredits?: number };
    }>).find((step) => step.kind === 'deliver');
    assert.equal(deliveryStep?.toolCalls, 0);
    assert.deepEqual(deliveryStep?.toolAttempts ?? [], []);
    assert.equal(deliveryStep?.charge?.toolCredits ?? 0, 0);
    assert.notEqual(run.metadata?.externalActionReconciliationRequired, true);
    assert.notEqual(scheduler.getAutomationById(automation.id)?.status, 'paused');
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    if (typeof originalOpenRouter === 'string') process.env.OPENROUTER_API_KEY = originalOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (typeof originalPostmarkKey === 'string') process.env.POSTMARK_API_KEY = originalPostmarkKey;
    else delete process.env.POSTMARK_API_KEY;
    if (typeof originalPostmarkFrom === 'string') process.env.POSTMARK_FROM_EMAIL = originalPostmarkFrom;
    else delete process.env.POSTMARK_FROM_EMAIL;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

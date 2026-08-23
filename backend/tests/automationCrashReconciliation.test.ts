import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('boot reconciliation preserves unknown-spend quarantine through orphan sweeping', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-crash-accounting-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    t.mock.method(console, 'log', () => undefined);

    // Import the server against an empty store so its real boot hooks do not
    // consume the deliberately constructed crash snapshot below.
    const server = await import('../src/server');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const workspaceId = 'workspace_crash_accounting';
    const onTrigger = async () => ({ ok: true });
    const automation = scheduler.createAutomation({
      workspaceId,
      name: 'Crash accounting test',
      schedule: 'every monday at 9am',
      actions: ['Summarize the evidence'],
      steps: [{
        id: 'summary',
        kind: 'summarize',
        title: 'Summarize evidence',
        objective: 'Produce a concise brief.',
      }],
    }, onTrigger);

    store.addLedgerEntry({
      workspaceId,
      source: 'manual_adjustment',
      deltaCredits: 1_000,
      referenceType: 'manual',
      referenceId: 'crash_accounting_balance',
    });
    const hold = store.acquireCreditHold({
      workspaceId,
      amountCredits: 100,
      referenceType: 'automation',
      referenceId: automation.id,
      ttlMs: 60 * 60 * 1_000,
    });
    const task = store.createTask({
      workspaceId,
      title: automation.name,
      kind: 'automation',
      metadata: { automationId: automation.id },
    });
    store.updateTask(task.id, { status: 'running', delegationState: 'in_progress' });
    const run = store.createTaskRun({
      workspaceId,
      taskId: task.id,
      agentRole: 'operator',
      modelTier: 'default',
      estimatedCredits: 25,
      metadata: {
        automationId: automation.id,
        title: automation.name,
        creditHoldId: hold.holdId,
        authorizedCredits: hold.heldCredits,
        stepExecutions: [{
          stepId: 'summary',
          kind: 'summarize',
          title: 'Summarize evidence',
          assignedRole: 'writer',
          modelTier: 'default',
          status: 'running',
          toolCalls: 0,
          artifactCount: 0,
          generationCalls: [{
            id: 'attempt-before-crash',
            stepId: 'summary',
            purpose: 'summary',
            modelTier: 'default',
            routeIndex: 0,
            attemptNumber: 1,
            provider: 'openrouter',
            model: 'provider-model',
            status: 'failed',
            maxOutputTokens: 600,
            promptBytes: 2_000,
            authorizedTokenCredits: 50,
          }, {
            id: 'successful-attempt-before-closeout-crash',
            stepId: 'summary',
            purpose: 'summary',
            modelTier: 'default',
            routeIndex: 1,
            attemptNumber: 1,
            provider: 'openrouter',
            model: 'provider-model',
            status: 'succeeded',
            maxOutputTokens: 600,
            promptBytes: 2_000,
            authorizedTokenCredits: 50,
            usage: {
              inputTokens: 120,
              outputTokens: 30,
              totalTokens: 150,
              provider: 'openrouter',
              model: 'provider-model',
            },
          }],
        }],
      },
    });
    const toolAutomation = scheduler.createAutomation({
      workspaceId,
      name: 'Crash after completed search',
      schedule: 'every tuesday at 9am',
      actions: ['Search for evidence', 'Summarize the evidence'],
      steps: [
        {
          id: 'search',
          kind: 'search',
          title: 'Search for evidence',
          objective: 'Gather current evidence.',
        },
        {
          id: 'summary',
          kind: 'summarize',
          title: 'Summarize evidence',
          objective: 'Produce a concise brief.',
        },
      ],
    }, onTrigger);
    const toolHold = store.acquireCreditHold({
      workspaceId,
      amountCredits: 100,
      referenceType: 'automation',
      referenceId: toolAutomation.id,
      ttlMs: 60 * 60 * 1_000,
    });
    const toolTask = store.createTask({
      workspaceId,
      title: toolAutomation.name,
      kind: 'automation',
      metadata: { automationId: toolAutomation.id },
    });
    store.updateTask(toolTask.id, { status: 'running', delegationState: 'in_progress' });
    const toolRun = store.createTaskRun({
      workspaceId,
      taskId: toolTask.id,
      agentRole: 'operator',
      modelTier: 'default',
      estimatedCredits: 40,
      metadata: {
        automationId: toolAutomation.id,
        title: toolAutomation.name,
        creditHoldId: toolHold.holdId,
        authorizedCredits: toolHold.heldCredits,
        stepExecutions: [{
          stepId: 'search',
          kind: 'search',
          title: 'Search for evidence',
          assignedRole: 'researcher',
          modelTier: 'micro',
          status: 'succeeded',
          toolCalls: 1,
          artifactCount: 1,
          actualCredits: 29,
          charge: {
            actualCredits: 29,
            baseCredits: 18,
            tokenCredits: 0,
            toolCredits: 4,
            artifactCredits: 5,
            durationCredits: 2,
            complexityCredits: 0,
            rationale: [],
          },
          generationCalls: [],
        }],
      },
    });
    const startedSearchAutomation = scheduler.createAutomation({
      workspaceId,
      name: 'Crash after search starts',
      schedule: 'every wednesday at 9am',
      actions: ['Search for evidence'],
      steps: [{
        id: 'search',
        kind: 'search',
        title: 'Search for evidence',
        objective: 'Gather current evidence.',
      }],
    }, onTrigger);
    const startedSearchHold = store.acquireCreditHold({
      workspaceId,
      amountCredits: 100,
      referenceType: 'automation',
      referenceId: startedSearchAutomation.id,
      ttlMs: 60 * 60 * 1_000,
    });
    const startedSearchTask = store.createTask({
      workspaceId,
      title: startedSearchAutomation.name,
      kind: 'automation',
      metadata: { automationId: startedSearchAutomation.id },
    });
    store.updateTask(startedSearchTask.id, { status: 'running', delegationState: 'in_progress' });
    const startedSearchRun = store.createTaskRun({
      workspaceId,
      taskId: startedSearchTask.id,
      agentRole: 'operator',
      modelTier: 'micro',
      estimatedCredits: 30,
      metadata: {
        automationId: startedSearchAutomation.id,
        title: startedSearchAutomation.name,
        creditHoldId: startedSearchHold.holdId,
        authorizedCredits: startedSearchHold.heldCredits,
        stepExecutions: [{
          stepId: 'search',
          kind: 'search',
          title: 'Search for evidence',
          assignedRole: 'researcher',
          modelTier: 'micro',
          status: 'running',
          toolCalls: 1,
          artifactCount: 0,
          toolAttempts: [{
            id: 'search-attempt-before-crash',
            operation: 'web_search',
            mutating: false,
            status: 'started',
            startedAt: new Date().toISOString(),
          }],
          generationCalls: [],
        }],
      },
    });
    const deliveredAutomation = scheduler.createAutomation({
      workspaceId,
      name: 'Crash after delivery returns',
      schedule: 'every thursday at 9am',
      actions: ['Deliver the brief'],
      steps: [{
        id: 'deliver',
        kind: 'deliver',
        title: 'Deliver the brief',
        objective: 'Send the completed brief.',
      }],
    }, onTrigger);
    const deliveredHold = store.acquireCreditHold({
      workspaceId,
      amountCredits: 100,
      referenceType: 'automation',
      referenceId: deliveredAutomation.id,
      ttlMs: 60 * 60 * 1_000,
    });
    const deliveredTask = store.createTask({
      workspaceId,
      title: deliveredAutomation.name,
      kind: 'automation',
      metadata: { automationId: deliveredAutomation.id },
    });
    store.updateTask(deliveredTask.id, { status: 'running', delegationState: 'in_progress' });
    const deliveredRun = store.createTaskRun({
      workspaceId,
      taskId: deliveredTask.id,
      agentRole: 'operator',
      modelTier: 'micro',
      estimatedCredits: 20,
      metadata: {
        automationId: deliveredAutomation.id,
        title: deliveredAutomation.name,
        creditHoldId: deliveredHold.holdId,
        authorizedCredits: deliveredHold.heldCredits,
        stepExecutions: [{
          stepId: 'deliver',
          kind: 'deliver',
          title: 'Deliver the brief',
          assignedRole: 'operator',
          modelTier: 'micro',
          status: 'running',
          toolCalls: 1,
          artifactCount: 0,
          toolAttempts: [{
            id: 'delivery-attempt-before-crash',
            operation: 'message_delivery',
            mutating: true,
            status: 'succeeded',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          }],
          generationCalls: [],
        }],
      },
    });
    const failedLibraryAutomation = scheduler.createAutomation({
      workspaceId,
      name: 'Crash after known library refusal',
      schedule: 'every friday at 9am',
      actions: [],
      steps: [{
        id: 'library',
        kind: 'query',
        title: 'Record findings',
        objective: 'Record the findings in the account library.',
      }],
    }, onTrigger);
    const failedLibraryHold = store.acquireCreditHold({
      workspaceId,
      amountCredits: 100,
      referenceType: 'automation',
      referenceId: failedLibraryAutomation.id,
      ttlMs: 60 * 60 * 1_000,
    });
    const failedLibraryTask = store.createTask({
      workspaceId,
      title: failedLibraryAutomation.name,
      kind: 'automation',
      metadata: { automationId: failedLibraryAutomation.id },
    });
    store.updateTask(failedLibraryTask.id, { status: 'running', delegationState: 'in_progress' });
    const failedLibraryRun = store.createTaskRun({
      workspaceId,
      taskId: failedLibraryTask.id,
      agentRole: 'operator',
      modelTier: 'micro',
      estimatedCredits: 30,
      metadata: {
        automationId: failedLibraryAutomation.id,
        title: failedLibraryAutomation.name,
        creditHoldId: failedLibraryHold.holdId,
        authorizedCredits: failedLibraryHold.heldCredits,
        stepExecutions: [{
          stepId: 'library',
          kind: 'query',
          title: 'Record findings',
          assignedRole: 'operator',
          modelTier: 'micro',
          status: 'failed',
          toolCalls: 1,
          artifactCount: 0,
          actualCredits: 22,
          charge: {
            actualCredits: 22,
            baseCredits: 18,
            tokenCredits: 0,
            toolCredits: 4,
            artifactCredits: 0,
            durationCredits: 0,
            complexityCredits: 0,
            rationale: [],
          },
          toolAttempts: [{
            id: 'known-library-refusal-before-crash',
            operation: 'account_library_append',
            mutating: true,
            status: 'failed',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            error: 'Reserved library title was refused before Drive.',
          }],
          generationCalls: [],
        }],
      },
    });
    const preparedDeliveryAutomation = scheduler.createAutomation({
      workspaceId,
      name: 'Crash before delivery starts',
      schedule: 'every saturday at 9am',
      actions: ['Deliver the brief'],
      steps: [{
        id: 'deliver-prepared',
        kind: 'deliver',
        title: 'Deliver the brief',
        objective: 'Send the completed brief.',
      }],
    }, onTrigger);
    const preparedDeliveryHold = store.acquireCreditHold({
      workspaceId,
      amountCredits: 100,
      referenceType: 'automation',
      referenceId: preparedDeliveryAutomation.id,
      ttlMs: 60 * 60 * 1_000,
    });
    const preparedDeliveryTask = store.createTask({
      workspaceId,
      title: preparedDeliveryAutomation.name,
      kind: 'automation',
      metadata: { automationId: preparedDeliveryAutomation.id },
    });
    store.updateTask(preparedDeliveryTask.id, { status: 'running', delegationState: 'in_progress' });
    const preparedDeliveryRun = store.createTaskRun({
      workspaceId,
      taskId: preparedDeliveryTask.id,
      agentRole: 'operator',
      modelTier: 'micro',
      estimatedCredits: 20,
      metadata: {
        automationId: preparedDeliveryAutomation.id,
        title: preparedDeliveryAutomation.name,
        creditHoldId: preparedDeliveryHold.holdId,
        authorizedCredits: preparedDeliveryHold.heldCredits,
        stepExecutions: [{
          stepId: 'deliver-prepared',
          kind: 'deliver',
          title: 'Deliver the brief',
          assignedRole: 'operator',
          modelTier: 'micro',
          status: 'running',
          toolCalls: 1,
          artifactCount: 0,
          toolAttempts: [{
            id: 'prepared-delivery-before-crash',
            operation: 'message_delivery',
            mutating: true,
            status: 'prepared',
            startedAt: new Date().toISOString(),
          }],
          generationCalls: [],
        }],
      },
    });
    const preparedGenerationAutomation = scheduler.createAutomation({
      workspaceId,
      name: 'Crash before generation starts',
      schedule: 'every sunday at 9am',
      actions: ['Summarize the evidence'],
      steps: [{
        id: 'summary-prepared',
        kind: 'summarize',
        title: 'Summarize the evidence',
        objective: 'Produce a concise brief.',
      }],
    }, onTrigger);
    const preparedGenerationHold = store.acquireCreditHold({
      workspaceId,
      amountCredits: 100,
      referenceType: 'automation',
      referenceId: preparedGenerationAutomation.id,
      ttlMs: 60 * 60 * 1_000,
    });
    const preparedGenerationTask = store.createTask({
      workspaceId,
      title: preparedGenerationAutomation.name,
      kind: 'automation',
      metadata: { automationId: preparedGenerationAutomation.id },
    });
    store.updateTask(preparedGenerationTask.id, { status: 'running', delegationState: 'in_progress' });
    const preparedGenerationRun = store.createTaskRun({
      workspaceId,
      taskId: preparedGenerationTask.id,
      agentRole: 'writer',
      modelTier: 'default',
      estimatedCredits: 25,
      metadata: {
        automationId: preparedGenerationAutomation.id,
        title: preparedGenerationAutomation.name,
        creditHoldId: preparedGenerationHold.holdId,
        authorizedCredits: preparedGenerationHold.heldCredits,
        stepExecutions: [{
          stepId: 'summary-prepared',
          kind: 'summarize',
          title: 'Summarize the evidence',
          assignedRole: 'writer',
          modelTier: 'default',
          status: 'running',
          toolCalls: 0,
          artifactCount: 0,
          generationCalls: [{
            id: 'prepared-generation-before-crash',
            stepId: 'summary-prepared',
            purpose: 'summary',
            modelTier: 'default',
            routeIndex: 0,
            attemptNumber: 1,
            provider: 'openrouter',
            model: 'provider-model',
            status: 'prepared',
            maxOutputTokens: 600,
            promptBytes: 2_000,
            authorizedTokenCredits: 50,
          }],
        }],
      },
    });
    const bootTime = new Date(Date.now() + 5_000);

    const recovered = server.reconcilePendingAutomationSettlements(bootTime);
    assert.deepEqual(
      new Set(recovered.map((item) => item.taskRunId)),
      new Set([
        run.id,
        toolRun.id,
        startedSearchRun.id,
        deliveredRun.id,
        failedLibraryRun.id,
        preparedDeliveryRun.id,
        preparedGenerationRun.id,
      ]),
    );
    assert.ok(recovered.every((item) => item.status === 'failed'));

    const orphanSweep = store.sweepOrphanedTaskRuns(bootTime);
    assert.equal(orphanSweep.some((item) => item.id === run.id), false, 'the reconciled terminal run is not rewritten');
    assert.equal(orphanSweep.some((item) => item.id === toolRun.id), false, 'completed tool work is settled before orphan sweeping');
    assert.equal(orphanSweep.some((item) => item.id === startedSearchRun.id), false, 'a journaled search attempt is settled before orphan sweeping');
    assert.equal(orphanSweep.some((item) => item.id === deliveredRun.id), false, 'a returned delivery is quarantined before orphan sweeping');
    assert.equal(orphanSweep.some((item) => item.id === failedLibraryRun.id), false, 'a known-safe failed mutation is settled before orphan sweeping');
    assert.equal(orphanSweep.some((item) => item.id === preparedDeliveryRun.id), false, 'a prepared-only mutation closes its hold before orphan sweeping');
    assert.equal(orphanSweep.some((item) => item.id === preparedGenerationRun.id), false, 'a prepared-only generation closes its hold before orphan sweeping');
    store.sweepZombieTasks(bootTime);

    const persistedRun = store.listTaskRuns(workspaceId).find((item) => item.id === run.id);
    assert.equal(persistedRun?.status, 'failed');
    assert.equal(persistedRun?.metadata?.settlementReconciliationRequired, true);
    assert.equal(persistedRun?.metadata?.accountingComplete, false);
    assert.match(persistedRun?.error ?? '', /manual accounting reconciliation is required/i);
    assert.doesNotMatch(persistedRun?.error ?? '', /safe to rerun/i);
    const recoveredUsage = server.summarizeTaskRunProviderUsage(persistedRun!);
    assert.deepEqual(
      {
        inputTokens: recoveredUsage.inputTokens,
        outputTokens: recoveredUsage.outputTokens,
        totalTokens: recoveredUsage.totalTokens,
        modelRoutes: recoveredUsage.modelRoutes,
      },
      {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        modelRoutes: ['openrouter/provider-model'],
      },
      'boot settlement preserves observed provider usage for billing telemetry',
    );
    assert.ok(
      Array.isArray(persistedRun?.metadata?.stepCharges),
      'boot reconciliation normalizes recovered executions into durable step charges',
    );

    const persistedTask = store.listTasks(workspaceId).find((item) => item.id === task.id);
    assert.equal(persistedTask?.status, 'blocked');
    assert.equal(persistedTask?.metadata?.settlementReconciliationRequired, true);
    assert.equal(scheduler.getAutomationById(automation.id)?.status, 'paused');
    assert.equal(scheduler.triggerAutomationNow(automation.id, onTrigger).status, 'paused');

    const terminalHold = store.listLedgerEntries(workspaceId).find((entry) =>
      entry.metadata?.holdId === hold.holdId && entry.metadata?.holdStatus === 'settled'
    );
    assert.ok(terminalHold, 'known observed charges close the hold exactly once');
    assert.equal(terminalHold.metadata?.settlementReconciliationRequired, true);
    assert.equal(terminalHold.metadata?.accountingComplete, false);

    const persistedToolRun = store.listTaskRuns(workspaceId).find((item) => item.id === toolRun.id);
    assert.equal(persistedToolRun?.status, 'failed');
    assert.equal(persistedToolRun?.actualCredits, 29);
    assert.equal(persistedToolRun?.metadata?.settlementReconciliationRequired, false);
    assert.equal(persistedToolRun?.metadata?.accountingComplete, true);
    const toolTerminalHold = store.listLedgerEntries(workspaceId).find((entry) =>
      entry.metadata?.holdId === toolHold.holdId && entry.metadata?.holdStatus === 'settled'
    );
    assert.ok(toolTerminalHold, 'persisted tool and artifact work closes its hold on boot');
    assert.equal(Math.abs(toolTerminalHold.deltaCredits), 29);

    const persistedStartedSearch = store.listTaskRuns(workspaceId).find((item) => item.id === startedSearchRun.id);
    assert.equal(persistedStartedSearch?.status, 'failed');
    assert.equal(persistedStartedSearch?.actualCredits, 22, 'research base plus one journaled tool attempt is recovered');
    assert.notEqual(persistedStartedSearch?.metadata?.externalActionReconciliationRequired, true);
    const startedSearchTerminal = store.listLedgerEntries(workspaceId).find((entry) =>
      entry.metadata?.holdId === startedSearchHold.holdId && entry.metadata?.holdStatus === 'settled'
    );
    assert.equal(Math.abs(startedSearchTerminal?.deltaCredits ?? 0), 22);

    const persistedDeliveredRun = store.listTaskRuns(workspaceId).find((item) => item.id === deliveredRun.id);
    assert.equal(persistedDeliveredRun?.status, 'failed');
    assert.equal(persistedDeliveredRun?.actualCredits, 8, 'message base plus the returned delivery tool call is recovered');
    assert.equal(persistedDeliveredRun?.metadata?.externalActionReconciliationRequired, true);
    assert.equal(persistedDeliveredRun?.metadata?.accountingComplete, true);
    assert.match(persistedDeliveredRun?.error ?? '', /remote outcome must be verified/i);
    assert.equal(store.listTasks(workspaceId).find((item) => item.id === deliveredTask.id)?.status, 'blocked');
    assert.equal(scheduler.getAutomationById(deliveredAutomation.id)?.status, 'paused');
    const deliveredTerminal = store.listLedgerEntries(workspaceId).find((entry) =>
      entry.metadata?.holdId === deliveredHold.holdId && entry.metadata?.holdStatus === 'settled'
    );
    assert.equal(Math.abs(deliveredTerminal?.deltaCredits ?? 0), 8);

    const persistedFailedLibraryRun = store.listTaskRuns(workspaceId).find((item) => item.id === failedLibraryRun.id);
    assert.equal(persistedFailedLibraryRun?.status, 'failed');
    assert.equal(persistedFailedLibraryRun?.actualCredits, 22);
    assert.notEqual(persistedFailedLibraryRun?.metadata?.externalActionReconciliationRequired, true);
    assert.equal(store.listTasks(workspaceId).find((item) => item.id === failedLibraryTask.id)?.status, 'failed');
    assert.notEqual(scheduler.getAutomationById(failedLibraryAutomation.id)?.status, 'paused');
    const failedLibraryTerminal = store.listLedgerEntries(workspaceId).find((entry) =>
      entry.metadata?.holdId === failedLibraryHold.holdId && entry.metadata?.holdStatus === 'settled'
    );
    assert.equal(Math.abs(failedLibraryTerminal?.deltaCredits ?? 0), 22);

    const persistedPreparedDelivery = store.listTaskRuns(workspaceId)
      .find((item) => item.id === preparedDeliveryRun.id);
    assert.equal(persistedPreparedDelivery?.status, 'failed');
    assert.equal(persistedPreparedDelivery?.actualCredits, 0, 'a prepared journal is not a physical tool call');
    assert.notEqual(persistedPreparedDelivery?.metadata?.externalActionReconciliationRequired, true);
    assert.equal(store.listTasks(workspaceId).find((item) => item.id === preparedDeliveryTask.id)?.status, 'failed');
    assert.notEqual(scheduler.getAutomationById(preparedDeliveryAutomation.id)?.status, 'paused');
    const preparedDeliveryTerminal = store.listLedgerEntries(workspaceId).find((entry) =>
      entry.metadata?.holdId === preparedDeliveryHold.holdId && entry.metadata?.holdStatus === 'settled'
    );
    assert.ok(preparedDeliveryTerminal, 'a prepared-only crash still closes the abandoned hold');
    assert.equal(Math.abs(preparedDeliveryTerminal.deltaCredits), 0);

    const persistedPreparedGeneration = store.listTaskRuns(workspaceId)
      .find((item) => item.id === preparedGenerationRun.id);
    assert.equal(persistedPreparedGeneration?.status, 'failed');
    assert.equal(persistedPreparedGeneration?.actualCredits, 0, 'authorization alone is not provider spend');
    assert.notEqual(persistedPreparedGeneration?.metadata?.settlementReconciliationRequired, true);
    assert.equal(store.listTasks(workspaceId).find((item) => item.id === preparedGenerationTask.id)?.status, 'failed');
    assert.notEqual(scheduler.getAutomationById(preparedGenerationAutomation.id)?.status, 'paused');
    const preparedGenerationTerminal = store.listLedgerEntries(workspaceId).find((entry) =>
      entry.metadata?.holdId === preparedGenerationHold.holdId && entry.metadata?.holdStatus === 'settled'
    );
    assert.ok(preparedGenerationTerminal, 'a prepared generation crash closes the abandoned hold');
    assert.equal(Math.abs(preparedGenerationTerminal.deltaCredits), 0);
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

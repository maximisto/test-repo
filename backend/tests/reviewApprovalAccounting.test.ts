import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('review approval reserves, settles, and quarantines delivery at the real send boundary', async () => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-review-approval-accounting-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';

    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const auditLog = await import('../src/integrationGateway/auditLog');
    const { executeReviewApproval, reconcilePendingReviewDeliveries } = await import('../src/reviewActions');

    const seedReview = (workspaceId: string, suffix: string) => {
      const automation = scheduler.createAutomation({
        workspaceId,
        name: `Approval ${suffix}`,
        schedule: 'every monday at 9am',
        actions: ['Deliver approved brief'],
        notify: '#founders',
      }, async () => ({ ok: true }));
      const reviewArtifact = {
        kind: 'review_gate',
        title: `Ready for review: ${suffix}`,
        payload: {
          markdown: `# ${suffix}\n\nEvidence-backed brief.`,
          deliveryTarget: '#founders',
          approvalRequired: true,
        },
      };
      const deliveryStep = {
        stepId: `deliver_${suffix}`,
        kind: 'deliver',
        title: 'Deliver approved brief',
        assignedRole: 'messenger',
        status: 'succeeded',
        output: { status: 'waiting_review', to: '#founders', channel: 'slack' },
        artifactKind: 'review_gate',
        toolCalls: 0,
        actualCredits: 9,
        charge: {
          actualCredits: 9,
          baseCredits: 4,
          toolCredits: 0,
          artifactCredits: 5,
          tokenCredits: 0,
          durationCredits: 0,
          complexityCredits: 0,
          rationale: [],
        },
      };
      const task = store.createTask({
        workspaceId,
        title: `Approval ${suffix}`,
        kind: 'automation',
        delegationState: 'review',
        metadata: {
          automationId: automation.id,
          latestArtifacts: [reviewArtifact],
          latestStepExecutions: [deliveryStep],
          reviewRequired: true,
        },
      });
      const taskRun = store.createTaskRun({
        workspaceId,
        taskId: task.id,
        agentRole: 'analyst',
        modelTier: 'default',
        estimatedCredits: 20,
        metadata: {
          automationId: automation.id,
          artifacts: [reviewArtifact],
          stepExecutions: [deliveryStep],
          reviewRequired: true,
        },
      });
      store.updateTask(task.id, { status: 'waiting_review', delegationState: 'review' });
      store.updateTaskRun(taskRun.id, { status: 'succeeded', actualCredits: 9 });
      return { automation, task, taskRun };
    };

    {
      const workspaceId = 'workspace_review_no_credits';
      const seeded = seedReview(workspaceId, 'No credits');
      let sends = 0;
      const result = await executeReviewApproval({
        workspaceId,
        automationId: seeded.automation.id,
        runId: seeded.taskRun.id,
        actor: { surface: 'dashboard', label: 'Max' },
        send: async () => {
          sends += 1;
          return { status: 'delivered' };
        },
      });

      assert.equal(result.status, 'insufficient_credits');
      assert.equal(sends, 0, 'approval cannot cross the send boundary without credits');
      assert.equal(store.listTasks(workspaceId)[0]?.status, 'waiting_review');
    }

    {
      const workspaceId = 'workspace_review_success';
      const seeded = seedReview(workspaceId, 'Success');
      store.addLedgerEntry({ workspaceId, source: 'manual_adjustment', deltaCredits: 100 });
      let sends = 0;
      const approve = () => executeReviewApproval({
        workspaceId,
        automationId: seeded.automation.id,
        runId: seeded.taskRun.id,
        actor: { surface: 'dashboard', label: 'Max' },
        send: async () => {
          sends += 1;
          return { status: 'delivered', channel: 'slack', to: '#founders', slack_ts: '123.456' };
        },
      });

      const result = await approve();
      assert.equal(result.status, 'ok');
      assert.equal(sends, 1);
      const persistedRun = store.listTaskRuns(workspaceId).find((item) => item.id === seeded.taskRun.id);
      assert.equal(persistedRun?.actualCredits, 13, 'approval adds the previously unspent four-credit tool call');
      assert.equal(store.listTasks(workspaceId).find((item) => item.id === seeded.task.id)?.status, 'completed');
      const settlement = store.listLedgerEntries(workspaceId).find((entry) =>
        entry.metadata?.reviewDeliveryAttemptId && entry.metadata?.holdStatus === 'settled'
      );
      assert.equal(settlement?.deltaCredits, -4);
      assert.equal(settlement?.metadata?.actualCredits, 4);

      const liveEvents = auditLog.listWorkflowLedgerEvents({
        workspaceId,
        taskRunId: seeded.taskRun.id,
      });
      assert.deepEqual(liveEvents.map((event) => event.type), [
        'approval_granted',
        'external_action_executed',
      ]);
      fs.writeFileSync(
        path.join(tempDir, 'workflow-ledger-events.json'),
        JSON.stringify(liveEvents.filter((event) => event.type === 'approval_granted')),
      );
      reconcilePendingReviewDeliveries();
      const recoveredEvents = auditLog.listWorkflowLedgerEvents({
        workspaceId,
        taskRunId: seeded.taskRun.id,
      });
      assert.deepEqual(
        recoveredEvents.map((event) => event.type),
        ['approval_granted', 'external_action_executed'],
        'terminal recovery backfills the missing event without duplicating its surviving sibling',
      );

      const replay = await approve();
      assert.equal(replay.status, 'invalid');
      assert.equal(sends, 1, 'a settled approval is consumed exactly once');
    }

    {
      const workspaceId = 'workspace_review_preflight_refusal';
      const seeded = seedReview(workspaceId, 'Preflight refusal');
      store.addLedgerEntry({ workspaceId, source: 'manual_adjustment', deltaCredits: 100 });
      let sends = 0;
      const result = await executeReviewApproval({
        workspaceId,
        automationId: seeded.automation.id,
        runId: seeded.taskRun.id,
        actor: { surface: 'dashboard', label: 'Max' },
        preflight: async () => {
          throw new Error('Slack is not connected, so nothing was sent. Connect Slack and try again.');
        },
        tracksExternalBoundary: true,
        send: async () => {
          sends += 1;
          return { status: 'delivered' };
        },
      });
      assert.equal(result.status, 'delivery_not_ready');
      assert.equal(sends, 0);
      assert.equal(store.listTasks(workspaceId)[0]?.status, 'waiting_review');
      assert.equal(store.listTaskRuns(workspaceId)[0]?.actualCredits, 9);
      assert.equal(
        store.listLedgerEntries(workspaceId).filter((entry) => entry.source === 'credit_hold').length,
        0,
        'route preflight happens before any approval hold is acquired',
      );
      assert.notEqual(scheduler.getAutomationById(seeded.automation.id)?.status, 'paused');
    }

    {
      const workspaceId = 'workspace_review_race_before_send';
      const seeded = seedReview(workspaceId, 'Race before send');
      store.addLedgerEntry({ workspaceId, source: 'manual_adjustment', deltaCredits: 100 });
      const result = await executeReviewApproval({
        workspaceId,
        automationId: seeded.automation.id,
        runId: seeded.taskRun.id,
        actor: { surface: 'dashboard', label: 'Max' },
        preflight: async () => undefined,
        tracksExternalBoundary: true,
        send: async () => {
          throw new Error('Slack disconnected after preflight but before the provider request.');
        },
      });
      assert.equal(result.status, 'failed');
      assert.equal(store.listTasks(workspaceId)[0]?.status, 'waiting_review');
      assert.equal(store.listTaskRuns(workspaceId)[0]?.actualCredits, 9);
      const holdEntries = store.listLedgerEntries(workspaceId).filter((entry) => entry.source === 'credit_hold');
      const holdId = holdEntries.find((entry) => entry.metadata?.holdStatus === 'active')?.metadata?.holdId;
      assert.ok(holdId);
      assert.ok(holdEntries.some((entry) =>
        entry.metadata?.holdId === holdId && entry.metadata?.holdStatus === 'released'
      ));
      assert.ok(!holdEntries.some((entry) =>
        entry.metadata?.holdId === holdId && entry.metadata?.holdStatus === 'settled'
      ));
      assert.notEqual(scheduler.getAutomationById(seeded.automation.id)?.status, 'paused');
    }

    {
      const workspaceId = 'workspace_review_ambiguous';
      const seeded = seedReview(workspaceId, 'Ambiguous');
      store.addLedgerEntry({ workspaceId, source: 'manual_adjustment', deltaCredits: 100 });
      let sends = 0;
      const approve = () => executeReviewApproval({
        workspaceId,
        automationId: seeded.automation.id,
        runId: seeded.taskRun.id,
        actor: { surface: 'dashboard', label: 'Max' },
        send: async () => {
          sends += 1;
          throw new Error(
            'Slack part 2 failed after part 1 was accepted. '
            + 'Authorization: Bearer sk_live_private request_body={"markdown_text":"CUSTOMER_PRIVATE_BRIEF"}',
          );
        },
      });

      const result = await approve();
      assert.equal(result.status, 'failed');
      assert.equal(sends, 1);
      const task = store.listTasks(workspaceId).find((item) => item.id === seeded.task.id);
      const run = store.listTaskRuns(workspaceId).find((item) => item.id === seeded.taskRun.id);
      assert.equal(task?.status, 'blocked');
      assert.equal(task?.metadata?.reviewRequired, false);
      assert.equal(run?.metadata?.externalActionReconciliationRequired, true);
      const persistedAttempt = run?.metadata?.reviewDeliveryAttempt as { error?: string };
      assert.doesNotMatch(persistedAttempt.error || '', /CUSTOMER_PRIVATE_BRIEF|sk_live_private/);
      assert.doesNotMatch(result.error, /CUSTOMER_PRIVATE_BRIEF|sk_live_private/);
      assert.ok(Buffer.byteLength(persistedAttempt.error || '', 'utf8') <= 500);
      assert.equal(run?.actualCredits, 13, 'the attempted external tool is still charged once');
      const chargedStep = (run?.metadata?.stepExecutions as Array<{
        kind?: string;
        toolCalls?: number;
        actualCredits?: number;
        charge?: { toolCredits?: number };
      }>).find((step) => step.kind === 'deliver');
      assert.equal(chargedStep?.toolCalls, 1);
      assert.equal(chargedStep?.actualCredits, 13);
      assert.equal(chargedStep?.charge?.toolCredits, 4);
      assert.equal(scheduler.getAutomationById(seeded.automation.id)?.status, 'paused');

      const replay = await approve();
      assert.equal(replay.status, 'invalid');
      assert.equal(sends, 1, 'an ambiguous partial send cannot be approved again blindly');
    }

    const seedCrashedApproval = (
      workspaceId: string,
      suffix: string,
      status: 'prepared' | 'request_started' | 'succeeded',
    ) => {
      const seeded = seedReview(workspaceId, suffix);
      store.addLedgerEntry({ workspaceId, source: 'manual_adjustment', deltaCredits: 100 });
      const attemptId = `review_delivery_crash_${status}_${suffix.replace(/\W+/g, '_').toLowerCase()}`;
      const hold = store.acquireCreditHold({
        workspaceId,
        amountCredits: 4,
        referenceType: 'automation',
        referenceId: seeded.automation.id,
        metadata: {
          approvalDelivery: true,
          reviewDeliveryAttemptId: attemptId,
          taskId: seeded.task.id,
          taskRunId: seeded.taskRun.id,
        },
      });
      const attempt = {
        id: attemptId,
        status,
        holdId: hold.holdId,
        chargeCredits: 4,
        baseActualCredits: 9,
        automationId: seeded.automation.id,
        taskId: seeded.task.id,
        taskRunId: seeded.taskRun.id,
        reviewer: 'Max',
        actor: { surface: 'dashboard', label: 'Max' },
        deliveryTarget: '#founders',
        artifactTitle: `Ready for review: ${suffix}`,
        startedAt: new Date().toISOString(),
        ...(status !== 'prepared' ? { requestStartedAt: new Date().toISOString() } : {}),
        ...(status === 'succeeded'
          ? {
              finishedAt: new Date().toISOString(),
              delivery: { status: 'delivered', to: '#founders', slack_ts: 'recovered.1' },
            }
          : {}),
      };
      store.updateTask(seeded.task.id, {
        status: 'running',
        delegationState: 'in_progress',
        metadata: {
          ...seeded.task.metadata,
          reviewDeliveryAttempt: attempt,
          deliveryClaim: { id: attemptId, by: 'Max', status },
        },
      });
      store.updateTaskRun(seeded.taskRun.id, { metadata: { reviewDeliveryAttempt: attempt } });
      return { ...seeded, attemptId, hold };
    };

    {
      const workspaceId = 'workspace_review_crash_prepared';
      const seeded = seedCrashedApproval(workspaceId, 'Crash before send', 'prepared');
      const reconciled = reconcilePendingReviewDeliveries();
      assert.ok(reconciled.some((item) => item.attemptId === seeded.attemptId && item.outcome === 'restored'));
      assert.equal(store.listTasks(workspaceId).find((item) => item.id === seeded.task.id)?.status, 'waiting_review');
      assert.equal(store.listTaskRuns(workspaceId).find((item) => item.id === seeded.taskRun.id)?.metadata?.reviewDeliveryAttempt, null);
      assert.ok(store.listLedgerEntries(workspaceId).some((entry) =>
        entry.metadata?.holdId === seeded.hold.holdId && entry.metadata?.holdStatus === 'released'
      ));
    }

    {
      const workspaceId = 'workspace_review_crash_started';
      const seeded = seedCrashedApproval(workspaceId, 'Crash during send', 'request_started');
      const reconciled = reconcilePendingReviewDeliveries();
      assert.ok(reconciled.some((item) => item.attemptId === seeded.attemptId && item.outcome === 'blocked'));
      assert.equal(store.listTasks(workspaceId).find((item) => item.id === seeded.task.id)?.status, 'blocked');
      const run = store.listTaskRuns(workspaceId).find((item) => item.id === seeded.taskRun.id);
      assert.equal(run?.status, 'failed');
      assert.equal(run?.actualCredits, 13);
      assert.equal(run?.metadata?.externalActionReconciliationRequired, true);
      assert.equal(scheduler.getAutomationById(seeded.automation.id)?.status, 'paused');
    }

    {
      const workspaceId = 'workspace_review_crash_succeeded';
      const seeded = seedCrashedApproval(workspaceId, 'Crash after send', 'succeeded');
      const reconciled = reconcilePendingReviewDeliveries();
      assert.ok(reconciled.some((item) => item.attemptId === seeded.attemptId && item.outcome === 'completed'));
      assert.equal(store.listTasks(workspaceId).find((item) => item.id === seeded.task.id)?.status, 'completed');
      const run = store.listTaskRuns(workspaceId).find((item) => item.id === seeded.taskRun.id);
      assert.equal(run?.status, 'succeeded');
      assert.equal(run?.actualCredits, 13);
      assert.ok(store.listLedgerEntries(workspaceId).some((entry) =>
        entry.metadata?.holdId === seeded.hold.holdId && entry.metadata?.holdStatus === 'settled'
      ));
      assert.deepEqual(
        auditLog.listWorkflowLedgerEvents({ workspaceId, taskRunId: seeded.taskRun.id })
          .map((event) => event.type),
        ['approval_granted', 'external_action_executed'],
        'crash recovery reconstructs both approval and external-action facts',
      );
    }

    {
      const workspaceId = 'workspace_review_crash_unsettled';
      const seeded = seedCrashedApproval(workspaceId, 'Crash after unpaid send', 'succeeded');
      store.addLedgerEntry({
        workspaceId,
        source: 'manual_adjustment',
        deltaCredits: -100,
        note: 'Simulate another recovered charge consuming the available balance first.',
      });
      const reconciled = reconcilePendingReviewDeliveries();
      assert.ok(reconciled.some((item) => item.attemptId === seeded.attemptId && item.outcome === 'blocked'));
      assert.equal(store.listTasks(workspaceId).find((item) => item.id === seeded.task.id)?.status, 'blocked');
      const run = store.listTaskRuns(workspaceId).find((item) => item.id === seeded.taskRun.id);
      assert.equal(run?.status, 'failed');
      assert.equal(run?.actualCredits, 13, 'physical delivery cost remains visible even when it could not be debited');
      assert.equal(run?.metadata?.approvalDeliveryUnsettledCredits, 4);
      assert.equal(run?.metadata?.externalActionReconciliationRequired, true);
      assert.equal(scheduler.getAutomationById(seeded.automation.id)?.status, 'paused');
      const settlement = store.listLedgerEntries(workspaceId).find((entry) =>
        entry.metadata?.holdId === seeded.hold.holdId && entry.metadata?.holdStatus === 'settled'
      );
      assert.equal(settlement?.metadata?.actualCredits, 0);
      assert.equal(settlement?.metadata?.overrunCredits, 4);
    }
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

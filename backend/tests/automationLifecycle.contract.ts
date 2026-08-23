import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approveAutomationReview,
  buildAutomationPreflightReport,
  classifyAutomationRunOutcome,
  requestAutomationChanges,
  validateAutomationDeliveryDraft,
} from '../src/platform/automationLifecycle';
import type { TaskRecord, TaskRunRecord } from '../src/platform/types';

const task = {
  id: 'task_weekly',
  workspaceId: 'purpleorangehq',
  title: 'Weekly founder update',
  description: 'Create a source-linked weekly operating brief.',
  kind: 'automation',
  status: 'waiting_review',
  priority: 'medium',
  delegationState: 'review',
  createdAt: '2026-06-18T14:00:00.000Z',
  updatedAt: '2026-06-18T14:04:00.000Z',
  metadata: {
    automationId: 'auto_weekly_founder_update',
    latestSummary: 'Weekly update is ready for review.',
    latestArtifacts: [
      {
        kind: 'review_gate',
        title: 'Ready for review: Weekly founder update',
        payload: {
          markdown: '## Weekly founder update\nRevenue is steady. One blocker needs ownership.',
          deliveryTarget: '#founders',
          approvalRequired: true,
        },
      },
    ],
    latestStepExecutions: [
      {
        stepId: 'step_deliver',
        kind: 'deliver',
        title: 'Deliver to Slack',
        assignedRole: 'messenger',
        status: 'succeeded',
        output: {
          status: 'waiting_review',
          to: '#founders',
          channel: 'slack',
        },
        artifactKind: 'review_gate',
      },
    ],
    reviewRequired: true,
  },
} satisfies TaskRecord;

const run = {
  id: 'run_weekly',
  workspaceId: 'purpleorangehq',
  taskId: 'task_weekly',
  agentRole: 'analyst',
  modelTier: 'default',
  status: 'succeeded',
  estimatedCredits: 84,
  actualCredits: 62,
  startedAt: '2026-06-18T14:00:00.000Z',
  finishedAt: '2026-06-18T14:04:00.000Z',
  metadata: {
    automationId: 'auto_weekly_founder_update',
    summary: 'Weekly update is ready for review.',
    artifacts: task.metadata.latestArtifacts,
    stepExecutions: task.metadata.latestStepExecutions,
    reviewRequired: true,
  },
} satisfies TaskRunRecord;

test('approveAutomationReview delivers waiting review content and records a run receipt', async () => {
  const result = await approveAutomationReview({
    task,
    taskRun: run,
    reviewer: 'max@purpleorange.io',
    now: () => '2026-06-18T15:00:00.000Z',
    send: async ({ to, body, subject }: { to: string; body: string; subject?: string }) => ({
      success: true,
      channel: 'slack',
      to,
      body,
      subject,
      status: 'delivered',
      slack_ts: '1718722800.000000',
    }),
  });

  assert.equal(result.taskPatch.status, 'completed');
  assert.equal(result.taskPatch.delegationState, 'completed');
  assert.equal(result.runPatch.metadata?.reviewRequired, false);
  assert.equal(result.receipt.status, 'delivered');
  assert.equal(result.receipt.reviewer, 'max@purpleorange.io');
  assert.equal(result.receipt.deliveryTarget, '#founders');
  assert.equal(result.receipt.artifactTitle, 'Ready for review: Weekly founder update');
  assert.match(String(result.delivery.body), /Revenue is steady/);
  const taskPatchMetadata = result.taskPatch.metadata as Record<string, unknown>;
  const runPatchMetadata = result.runPatch.metadata as Record<string, unknown>;
  const taskDeliverySteps = taskPatchMetadata.latestStepExecutions as Array<{ stepId?: string; output?: Record<string, unknown> }> | undefined;
  const runDeliverySteps = runPatchMetadata.stepExecutions as Array<{ stepId?: string; output?: Record<string, unknown> }> | undefined;
  const taskDeliveryStep = taskDeliverySteps?.find((step) => step.stepId === 'step_deliver');
  const runDeliveryStep = runDeliverySteps?.find((step) => step.stepId === 'step_deliver');
  assert.equal(taskDeliveryStep?.output?.status, 'delivered');
  assert.equal(taskDeliveryStep?.output?.slack_ts, '1718722800.000000');
  assert.equal(runDeliveryStep?.output?.status, 'delivered');
});

test('approval fails closed when a persisted mission contains more than one delivery gate', async () => {
  const secondArtifact = {
    kind: 'review_gate',
    title: 'Ready for review: customer update',
    payload: {
      markdown: '## Customer update\nA different brief for a different destination.',
      deliveryTarget: '#customers',
      approvalRequired: true,
    },
  };
  const multiTask = {
    ...task,
    metadata: {
      ...task.metadata,
      latestArtifacts: [...task.metadata.latestArtifacts, secondArtifact],
      latestStepExecutions: [
        ...task.metadata.latestStepExecutions,
        {
          stepId: 'step_deliver_customers',
          kind: 'deliver',
          title: 'Deliver to customers',
          assignedRole: 'messenger',
          status: 'succeeded',
          output: { status: 'waiting_review', to: '#customers', channel: 'slack' },
          artifactKind: 'review_gate',
        },
      ],
    },
  } satisfies TaskRecord;
  const multiRun = {
    ...run,
    metadata: {
      ...run.metadata,
      artifacts: multiTask.metadata.latestArtifacts,
      stepExecutions: multiTask.metadata.latestStepExecutions,
    },
  } satisfies TaskRunRecord;
  let sends = 0;

  await assert.rejects(
    approveAutomationReview({
      task: multiTask,
      taskRun: multiRun,
      reviewer: 'max@purpleorange.io',
      send: async () => {
        sends += 1;
        return { status: 'delivered' };
      },
    }),
    /one delivery step/i,
  );
  assert.equal(sends, 0);
});

test('an approved run that was not archived says so on its receipt', async () => {
  // The competitor-monitor incident, at the approval surface: the library write
  // failed, the memo is still fully evidenced, and the founder approves it. The
  // receipt must not imply everything succeeded.
  const runWarnings = [
    {
      stepId: 'step_library_record',
      title: 'Record findings in the library',
      message: 'Google Drive is connected but needs file read and write access to maintain the intelligence library.',
    },
  ];
  const notArchivedTask = {
    ...task,
    id: 'task_competitor',
    metadata: {
      ...task.metadata,
      latestArtifacts: [
        {
          kind: 'review_gate',
          title: 'Ready for review: Competitor monitor',
          payload: {
            markdown: '## Competitor monitor\nTwo competitors moved on pricing.',
            deliveryTarget: '#violema-demo',
            approvalRequired: true,
            runWarnings,
          },
        },
      ],
      runWarnings,
    },
  } satisfies TaskRecord;
  const notArchivedRun = {
    ...run,
    id: 'run_competitor',
    taskId: 'task_competitor',
    metadata: {
      ...run.metadata,
      artifacts: notArchivedTask.metadata.latestArtifacts,
      runWarnings,
    },
  } satisfies TaskRunRecord;

  const result = await approveAutomationReview({
    task: notArchivedTask,
    taskRun: notArchivedRun,
    reviewer: 'max@purpleorange.io',
    now: () => '2026-08-02T08:04:00.000Z',
    send: async ({ to, body }: { to: string; body: string }) => ({
      success: true,
      channel: 'slack',
      to,
      body,
      status: 'delivered',
    }),
  });

  // Approval still works — that is the whole fix.
  assert.equal(result.taskPatch.status, 'completed');
  assert.match(String(result.delivery.body), /Two competitors moved on pricing/);
  // And the record of it stays honest.
  assert.deepEqual(result.receipt.runWarnings, runWarnings);
});

test('a receipt for a clean run carries no warnings at all', async () => {
  const result = await approveAutomationReview({
    task,
    taskRun: run,
    reviewer: 'max@purpleorange.io',
    now: () => '2026-06-18T15:00:00.000Z',
    send: async ({ to, body }: { to: string; body: string }) => ({
      success: true,
      channel: 'slack',
      to,
      body,
      status: 'delivered',
    }),
  });

  assert.equal('runWarnings' in result.receipt, false);
});

test('requestAutomationChanges keeps delivery held and records reviewer instructions', () => {
  const result = requestAutomationChanges({
    task,
    taskRun: run,
    reviewer: 'max@purpleorange.io',
    note: 'Tighten the revenue claim and add GitHub evidence.',
    now: () => '2026-06-18T15:05:00.000Z',
  });

  assert.equal(result.taskPatch.status, 'blocked');
  assert.equal(result.taskPatch.delegationState, 'review');
  assert.equal(result.runPatch.metadata?.reviewRequired, true);
  assert.equal(result.reviewRequest.status, 'changes_requested');
  assert.match(String(result.reviewRequest.note), /GitHub evidence/);
});

test('buildAutomationPreflightReport flags missing credentials before a mission runs', () => {
  const report = buildAutomationPreflightReport({
    automation: {
      id: 'auto_weekly_founder_update',
      name: 'Weekly founder update',
      schedule: 'every monday at 9am',
      actions: [],
      notify: '#founders',
      steps: [
        {
          id: 'step_market',
          kind: 'search',
          objective: 'Scan market signals.',
        },
        {
          id: 'step_summary',
          kind: 'summarize',
          objective: 'Draft founder brief.',
        },
        {
          id: 'step_deliver',
          kind: 'deliver',
          objective: 'Deliver to Slack.',
          deliveryTarget: { channel: 'slack', target: '#founders' },
        },
      ],
    },
    env: {},
  });

  assert.equal(report.ready, false);
  assert.deepEqual(
    report.blockers.map((item: { key: string }) => item.key),
    ['TAVILY_API_KEY', 'ANTHROPIC_API_KEY or OPENROUTER_API_KEY', 'SLACK_BOT_TOKEN'],
  );
  assert.match(report.summary, /3 blockers/);
});

test('validateAutomationDeliveryDraft allows Slack names at save time but validates email shape', () => {
  const draft = validateAutomationDeliveryDraft({
    notify: '#all-purple-orange',
    steps: [
      {
        id: 'deliver',
        kind: 'deliver',
        objective: 'Send the reviewed output.',
        deliveryTarget: { channel: 'slack', target: '#private-founders' },
      },
    ],
  });

  assert.equal(draft.ok, true);
  assert.equal(draft.warnings.length, 2);
  assert.doesNotThrow(() => validateAutomationDeliveryDraft({ notify: 'max@purpleorange.io', steps: [] }));
  assert.throws(
    () => validateAutomationDeliveryDraft({ notify: 'not-an-email', steps: [{ id: 'deliver', kind: 'deliver', objective: 'Email result.', deliveryTarget: { channel: 'email', target: 'not-an-email' } }] }),
    /valid email/i,
  );
  assert.throws(
    () => validateAutomationDeliveryDraft({
      steps: [
        { id: 'deliver-a', kind: 'deliver', objective: 'Send A.', deliveryTarget: { channel: 'slack', target: '#a' } },
        { id: 'deliver-b', kind: 'deliver', objective: 'Send B.', deliveryTarget: { channel: 'slack', target: '#b' } },
      ],
    }),
    /one delivery step/i,
  );
});

test('validateAutomationDeliveryDraft deduplicates repeated Slack target warnings', () => {
  const draft = validateAutomationDeliveryDraft({
    notify: '#all-purple-orange',
    steps: [
      {
        id: 'deliver',
        kind: 'deliver',
        title: 'Deliver to Slack',
        objective: 'Send the reviewed output.',
        deliveryTarget: { channel: 'slack', target: '#all-purple-orange' },
      },
    ],
  });

  assert.equal(draft.ok, true);
  assert.equal(draft.warnings.length, 1);
  assert.equal(draft.warnings[0]?.key, 'SLACK_TARGET:#all-purple-orange');
  assert.match(draft.warnings[0]?.detail || '', /workspace destination/i);
});

test('classifyAutomationRunOutcome blocks failed delivery but preserves review gates', () => {
  const reviewOutcome = classifyAutomationRunOutcome({
    deliveryWaitingForReview: true,
    stepExecutions: [
      { kind: 'deliver', title: 'Deliver', status: 'succeeded', stepId: 'step_deliver' },
    ],
  });

  assert.equal(reviewOutcome.taskStatus, 'waiting_review');
  assert.equal(reviewOutcome.runStatus, 'succeeded');
  assert.equal(reviewOutcome.schedulerOk, true);

  const failedDeliveryOutcome = classifyAutomationRunOutcome({
    deliveryError: 'Slack target "#all-purple-orange" is not visible to Violema.',
    stepExecutions: [
      { kind: 'deliver', title: 'Deliver', status: 'failed', stepId: 'step_deliver' },
    ],
  });

  assert.equal(failedDeliveryOutcome.taskStatus, 'blocked');
  assert.equal(failedDeliveryOutcome.runStatus, 'failed');
  assert.equal(failedDeliveryOutcome.schedulerOk, false);
  assert.match(String(failedDeliveryOutcome.reviewSummary), /Slack target/);
});

test('classifyAutomationRunOutcome carries run-level extra warnings onto every outcome', () => {
  // The per-mission credit budget produces a RUN-level fact (the total
  // crossed the budget) that no single step owns. It must ride the same
  // runWarnings channel step warnings do, on success and review outcomes
  // alike, so the approver sees it on the gate.
  const overrun = {
    stepId: 'credit_budget',
    title: 'Credit budget',
    message: 'This run cost 228 credits — over the 150-credit per-run budget.',
  };

  const reviewOutcome = classifyAutomationRunOutcome({
    deliveryWaitingForReview: true,
    stepExecutions: [
      { kind: 'deliver', title: 'Deliver', status: 'succeeded', stepId: 'step_deliver' },
    ],
    extraWarnings: [overrun],
  });
  assert.deepEqual(reviewOutcome.runWarnings, [overrun]);
  assert.match(String(reviewOutcome.reviewSummary), /228 credits/);

  const cleanOutcome = classifyAutomationRunOutcome({
    stepExecutions: [
      { kind: 'summarize', title: 'Draft', status: 'succeeded', stepId: 'step_draft' },
    ],
    extraWarnings: [overrun],
  });
  assert.deepEqual(cleanOutcome.runWarnings, [overrun]);
});

test('classifyAutomationRunOutcome prioritizes failed steps over waiting review gates', () => {
  const outcome = classifyAutomationRunOutcome({
    deliveryWaitingForReview: true,
    stepExecutions: [
      {
        stepId: 'step_stripe',
        kind: 'query',
        title: 'Check Stripe revenue',
        status: 'failed',
        error: 'Stripe read access is required before Revenue Watch can run with real data.',
      },
      {
        stepId: 'step_deliver',
        kind: 'deliver',
        title: 'Deliver to Slack',
        status: 'succeeded',
      },
    ],
  });

  assert.equal(outcome.taskStatus, 'blocked');
  assert.equal(outcome.runStatus, 'failed');
  assert.equal(outcome.schedulerOk, false);
  assert.equal(outcome.reviewRequired, false);
  assert.match(String(outcome.reviewSummary), /Stripe read access is required before Revenue Watch can run with real data\./);
});

test('classifyAutomationRunOutcome lets system summary degradation wait for review', () => {
  const outcome = classifyAutomationRunOutcome({
    deliveryWaitingForReview: true,
    stepExecutions: [
      {
        stepId: 'step_stripe',
        kind: 'query',
        title: 'Check Stripe revenue',
        status: 'succeeded',
      },
      {
        stepId: 'auto_step_auto_revenue_watch_3',
        kind: 'summarize',
        title: 'Generate automation summary',
        status: 'failed',
        error: 'Model route is temporarily unavailable.',
      },
      {
        stepId: 'step_deliver',
        kind: 'deliver',
        title: 'Deliver to Slack',
        status: 'succeeded',
      },
    ],
  });

  assert.equal(outcome.taskStatus, 'waiting_review');
  assert.equal(outcome.runStatus, 'succeeded');
  assert.equal(outcome.schedulerOk, true);
  assert.equal(outcome.reviewRequired, true);
});

test('an approved send carries the evidence links and charts the run gathered', async () => {
  // Regression: the review payload was rebuilt with only markdown/target/flag,
  // so sourceLinks and visualArtifacts arrived undefined at send time and every
  // approved delivery silently shipped without its evidence.
  const evidencedTask = {
    ...task,
    metadata: {
      ...task.metadata,
      latestArtifacts: [
        {
          kind: 'review_gate',
          title: 'Ready for review: Weekly founder update',
          payload: {
            markdown: '## Weekly founder update\nRevenue is steady.',
            deliveryTarget: '#founders',
            approvalRequired: true,
            sourceLinks: [{ url: 'https://example.com/report', label: 'Source report' }],
            visualArtifacts: [{ title: 'Revenue', payload: { type: 'bar', data: [1, 2] } }],
          },
        },
      ],
    },
  } as unknown as typeof task;

  let sentEvidence: unknown;
  let sentCharts: unknown;
  await approveAutomationReview({
    task: evidencedTask,
    taskRun: { ...run, metadata: { ...run.metadata, artifacts: evidencedTask.metadata.latestArtifacts } },
    reviewer: 'max@purpleorange.io',
    now: () => '2026-06-18T15:00:00.000Z',
    send: async (input: { to: string; body: string; evidenceLinks?: unknown; chartSpecs?: unknown }) => {
      sentEvidence = input.evidenceLinks;
      sentCharts = input.chartSpecs;
      return { success: true, channel: 'slack', to: input.to, body: input.body, status: 'delivered' };
    },
  });

  assert.deepEqual(sentEvidence, [{ url: 'https://example.com/report', label: 'Source report' }]);
  assert.deepEqual(sentCharts, [{ type: 'bar', data: [1, 2] }]);
});

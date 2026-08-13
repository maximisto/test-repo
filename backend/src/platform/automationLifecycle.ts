import type {
  AutomationStepExecution,
  AutomationStepDeliveryTarget,
  PersistedAutomationStep,
  TaskRecord,
  TaskRunStatus,
  TaskRunRecord,
  TaskStatus,
} from './types';

type SendReviewMessage = (input: {
  to: string;
  body: string;
  subject?: string;
  channel?: AutomationStepDeliveryTarget['channel'];
  evidenceLinks?: Array<{ url: string; label: string }>;
  chartSpecs?: unknown[];
}) => Promise<Record<string, unknown>>;

interface ReviewArtifact {
  kind?: string;
  title?: string;
  payload?: {
    markdown?: string;
    deliveryTarget?: string;
    approvalRequired?: boolean;
    sourceLinks?: Array<{ url: string; label: string }>;
    visualArtifacts?: Array<{ title?: string; payload?: unknown }>;
    runWarnings?: AutomationRunWarning[];
  };
}

export interface AutomationRunReceipt {
  id: string;
  status: 'delivered' | 'changes_requested';
  reviewer: string;
  reviewedAt: string;
  automationId?: string;
  taskId: string;
  taskRunId: string;
  deliveryTarget?: string;
  artifactTitle?: string;
  note?: string;
  delivery?: Record<string, unknown>;
  /**
   * What the run could not finish, as shown on the review gate the approver
   * acted on. Present so a delivered receipt can still read "delivered, but not
   * archived" rather than implying everything succeeded.
   */
  runWarnings?: AutomationRunWarning[];
}

export interface AutomationPreflightBlocker {
  key: string;
  label: string;
  detail: string;
  severity: 'blocking' | 'warning';
}

export interface AutomationPreflightReport {
  ready: boolean;
  summary: string;
  blockers: AutomationPreflightBlocker[];
  warnings: AutomationPreflightBlocker[];
}

export interface AutomationDeliveryDraftValidation {
  ok: true;
  warnings: AutomationPreflightBlocker[];
}

/**
 * A step failure the run was allowed to survive.
 *
 * This is the honesty half of step severity: tolerating an auxiliary failure
 * must never mean hiding it. Every warning here corresponds to a step execution
 * still recorded as `failed`, with its error intact, and — for connector
 * failures — a `connector_failed` ledger event. The warning is the thing a UI
 * renders next to the delivery ("Delivered, but not archived: …") so nobody has
 * to open the step timeline to discover what did not happen.
 */
export interface AutomationRunWarning {
  /** The step whose failure was tolerated. */
  stepId: string;
  /** The step title, matching the run timeline. */
  title: string;
  /** Why it failed, verbatim from the step where one was recorded. */
  message: string;
}

export interface AutomationRunOutcome {
  taskStatus: TaskStatus;
  runStatus: TaskRunStatus;
  delegationState: NonNullable<TaskRecord['delegationState']>;
  schedulerOk: boolean;
  reviewRequired: boolean;
  reviewSummary?: string;
  /** Tolerated failures. Always present; empty on a clean run. */
  runWarnings: AutomationRunWarning[];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function readArtifacts(task: TaskRecord, taskRun: TaskRunRecord): ReviewArtifact[] {
  const taskMetadata = readRecord(task.metadata) || {};
  const runMetadata = readRecord(taskRun.metadata) || {};
  const source = Array.isArray(runMetadata.artifacts)
    ? runMetadata.artifacts
    : Array.isArray(taskMetadata.latestArtifacts)
      ? taskMetadata.latestArtifacts
      : [];

  return source
    .map((item) => readRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      kind: readString(item.kind),
      title: readString(item.title),
      payload: readRecord(item.payload) ? {
        markdown: readString(readRecord(item.payload)?.markdown),
        deliveryTarget: readString(readRecord(item.payload)?.deliveryTarget),
        approvalRequired: Boolean(readRecord(item.payload)?.approvalRequired),
        // The evidence travels with the draft. The run stores these on the
        // review gate; rebuilding the payload without them silently stripped
        // every approved send of its source links and charts — the opposite of
        // what this product promises.
        sourceLinks: readSourceLinks(readRecord(item.payload)?.sourceLinks),
        visualArtifacts: readVisualArtifacts(readRecord(item.payload)?.visualArtifacts),
        // What the run could not finish travels with the thing being approved,
        // so the receipt can record that the approver was shown it.
        runWarnings: readRunWarnings(readRecord(item.payload)?.runWarnings),
      } : undefined,
    }));
}

/** Re-read persisted evidence links defensively — this crosses a JSON boundary. */
function readSourceLinks(value: unknown): Array<{ url: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const links = value
    .map((item) => readRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({ url: readString(item.url), label: readString(item.label) }))
    .filter((item): item is { url: string; label: string } => Boolean(item.url));
  return links.length > 0 ? links : undefined;
}

/** Re-read persisted chart artifacts defensively — this crosses a JSON boundary. */
function readVisualArtifacts(value: unknown): Array<{ title?: string; payload?: unknown }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const visuals = value
    .map((item) => readRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({ title: readString(item.title), payload: item.payload }))
    .filter((item) => item.payload !== undefined);
  return visuals.length > 0 ? visuals : undefined;
}

/** Re-read persisted warnings defensively — this crosses a JSON boundary. */
function readRunWarnings(value: unknown): AutomationRunWarning[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const warnings = value
    .map((item) => readRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      stepId: readString(item.stepId),
      title: readString(item.title),
      message: readString(item.message),
    }))
    .filter((item) => item.stepId || item.title || item.message);

  return warnings.length > 0 ? warnings : undefined;
}

function readAutomationId(task: TaskRecord, taskRun: TaskRunRecord) {
  const taskMetadata = readRecord(task.metadata) || {};
  const runMetadata = readRecord(taskRun.metadata) || {};
  return readString(runMetadata.automationId) || readString(taskMetadata.automationId) || undefined;
}

export interface SupersedableTask {
  id: string;
  status?: string;
  delegationState?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Older review gates for the same automation, left open by earlier runs.
 *
 * Field observation (2026-08-03): every run creates its own task, and nothing
 * closed the old gates — a tenant workspace accumulated six same-named
 * "Competitor monitor" tasks, two still `waiting_review` from hours earlier.
 * After requesting changes, the operator could not tell the revised draft
 * from the stale ones, and the queue happily offered to approve outdated
 * content. When a new run parks at review, every older open gate for that
 * automation must close as superseded — one approvable draft, always the
 * newest.
 *
 * Included: `waiting_review` tasks, and `blocked` tasks parked in the review
 * lane (a changes-requested draft that the new draft answers). Excluded:
 * anything `running` — closing live work from here would race the scheduler.
 */
export function selectSupersededReviewTasks<T extends SupersedableTask>(
  tasks: readonly T[],
  input: { automationId: string; keepTaskId: string },
): T[] {
  return tasks.filter((task) => {
    if (task.id === input.keepTaskId) return false;
    if (task.metadata?.automationId !== input.automationId) return false;
    if (task.status === 'waiting_review') return true;
    return task.status === 'blocked' && task.delegationState === 'review';
  });
}

function findReviewArtifact(task: TaskRecord, taskRun: TaskRunRecord) {
  return readArtifacts(task, taskRun).find((artifact) =>
    artifact.kind === 'review_gate' &&
    artifact.payload?.approvalRequired &&
    artifact.payload?.markdown &&
    artifact.payload?.deliveryTarget
  );
}

function assertReviewable(task: TaskRecord, taskRun: TaskRunRecord) {
  if (task.status !== 'waiting_review') {
    throw new Error('This mission is not waiting for review.');
  }

  const artifact = findReviewArtifact(task, taskRun);
  if (!artifact) {
    throw new Error('No prepared review artifact is available for delivery.');
  }

  return artifact;
}

function buildReceipt(input: {
  status: AutomationRunReceipt['status'];
  task: TaskRecord;
  taskRun: TaskRunRecord;
  reviewer: string;
  reviewedAt: string;
  deliveryTarget?: string;
  artifactTitle?: string;
  note?: string;
  delivery?: Record<string, unknown>;
  runWarnings?: AutomationRunWarning[];
}): AutomationRunReceipt {
  return {
    id: `receipt_${input.taskRun.id}_${input.status}`,
    status: input.status,
    reviewer: input.reviewer,
    reviewedAt: input.reviewedAt,
    automationId: readAutomationId(input.task, input.taskRun),
    taskId: input.task.id,
    taskRunId: input.taskRun.id,
    deliveryTarget: input.deliveryTarget,
    artifactTitle: input.artifactTitle,
    note: input.note,
    delivery: input.delivery,
    ...(input.runWarnings?.length ? { runWarnings: input.runWarnings } : {}),
  };
}

function markDeliveryStepDelivered(
  value: unknown,
  delivery: Record<string, unknown>,
  reviewedAt: string,
) {
  if (!Array.isArray(value)) return undefined;

  return value.map((item) => {
    const record = readRecord(item);
    if (!record || readString(record.kind) !== 'deliver') return item;
    const output = readRecord(record.output) || {};
    return {
      ...record,
      status: 'succeeded',
      summary: `Delivered approved workflow output to ${readString(delivery.to) || readString(output.to) || 'the configured destination'}.`,
      output: {
        ...output,
        ...delivery,
        status: readString(delivery.status) || 'delivered',
        approval_required: false,
        approved_at: reviewedAt,
      },
    };
  });
}

export async function approveAutomationReview(input: {
  task: TaskRecord;
  taskRun: TaskRunRecord;
  reviewer: string;
  now?: () => string;
  send: SendReviewMessage;
}) {
  const reviewedAt = input.now ? input.now() : new Date().toISOString();
  const artifact = assertReviewable(input.task, input.taskRun);
  const body = artifact.payload?.markdown || '';
  const deliveryTarget = artifact.payload?.deliveryTarget || '';
  const delivery = await input.send({
    to: deliveryTarget,
    body,
    subject: artifact.title || input.task.title,
    channel: deliveryTarget.includes('@') ? 'email' : 'slack',
    evidenceLinks: Array.isArray(artifact.payload?.sourceLinks) ? artifact.payload.sourceLinks : undefined,
    chartSpecs: Array.isArray(artifact.payload?.visualArtifacts)
      ? artifact.payload.visualArtifacts.map((visual) => visual?.payload).filter(Boolean)
      : undefined,
  });
  const taskStepExecutions = markDeliveryStepDelivered(input.task.metadata?.latestStepExecutions, delivery, reviewedAt);
  const runStepExecutions = markDeliveryStepDelivered(input.taskRun.metadata?.stepExecutions, delivery, reviewedAt);
  const receipt = buildReceipt({
    status: 'delivered',
    task: input.task,
    taskRun: input.taskRun,
    reviewer: input.reviewer,
    reviewedAt,
    deliveryTarget,
    artifactTitle: artifact.title,
    delivery,
    runWarnings: artifact.payload?.runWarnings,
  });

  return {
    delivery: { ...delivery, body },
    receipt,
    taskPatch: {
      status: 'completed' as const,
      delegationState: 'completed' as const,
      metadata: {
        reviewRequired: false,
        reviewReceipt: receipt,
        latestDelivery: delivery,
        latestStepExecutions: taskStepExecutions,
      },
    },
    runPatch: {
      metadata: {
        reviewRequired: false,
        reviewReceipt: receipt,
        delivery,
        stepExecutions: runStepExecutions,
      },
    },
  };
}

export function requestAutomationChanges(input: {
  task: TaskRecord;
  taskRun: TaskRunRecord;
  reviewer: string;
  note: string;
  now?: () => string;
}) {
  assertReviewable(input.task, input.taskRun);
  const reviewedAt = input.now ? input.now() : new Date().toISOString();
  const reviewRequest = buildReceipt({
    status: 'changes_requested',
    task: input.task,
    taskRun: input.taskRun,
    reviewer: input.reviewer,
    reviewedAt,
    note: input.note.trim(),
  });

  return {
    reviewRequest,
    taskPatch: {
      status: 'blocked' as const,
      delegationState: 'review' as const,
      metadata: {
        reviewRequired: true,
        reviewRequest,
      },
    },
    runPatch: {
      metadata: {
        reviewRequired: true,
        reviewRequest,
      },
    },
  };
}

function hasEnv(env: Record<string, string | undefined>, key: string) {
  return Boolean(env[key]?.trim());
}

function stepNeedsSearch(step: PersistedAutomationStep) {
  return step.kind === 'search';
}

function stepNeedsModel(step: PersistedAutomationStep) {
  return step.kind === 'summarize' || step.kind === 'analyze';
}

function stepNeedsSlack(step: PersistedAutomationStep, notify?: string) {
  const target = step.deliveryTarget?.target || notify || '';
  const channel = step.deliveryTarget?.channel || (target.includes('@') ? 'email' : 'slack');
  return step.kind === 'deliver' && channel === 'slack';
}

function stepNeedsEmail(step: PersistedAutomationStep, notify?: string) {
  const target = step.deliveryTarget?.target || notify || '';
  const channel = step.deliveryTarget?.channel || (target.includes('@') ? 'email' : 'slack');
  return step.kind === 'deliver' && channel === 'email';
}

function blocker(key: string, label: string, detail: string): AutomationPreflightBlocker {
  return { key, label, detail, severity: 'blocking' };
}

function warning(key: string, label: string, detail: string): AutomationPreflightBlocker {
  return { key, label, detail, severity: 'warning' };
}

function isValidEmailTarget(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isSlackChannelId(value: string) {
  return /^[CGD][A-Z0-9]{8,}$/.test(value.trim());
}

function collectDeliveryTargets(input: {
  notify?: string | null;
  steps?: PersistedAutomationStep[];
}) {
  const targets: Array<{ channel: AutomationStepDeliveryTarget['channel']; target: string; source: string }> = [];
  const notify = readString(input.notify);
  if (notify) {
    targets.push({
      channel: notify.includes('@') ? 'email' : 'slack',
      target: notify,
      source: 'workspace destination',
    });
  }

  for (const step of input.steps || []) {
    if (step.kind !== 'deliver') continue;
    const target = readString(step.deliveryTarget?.target);
    if (!target) continue;
    targets.push({
      channel: step.deliveryTarget?.channel || (target.includes('@') ? 'email' : 'slack'),
      target,
      source: step.title || step.id || 'delivery step',
    });
  }

  return targets;
}

export function validateAutomationDeliveryDraft(input: {
  notify?: string | null;
  steps?: PersistedAutomationStep[];
}): AutomationDeliveryDraftValidation {
  const warnings: AutomationPreflightBlocker[] = [];
  const warningKeys = new Set<string>();

  for (const item of collectDeliveryTargets(input)) {
    if (item.channel === 'email') {
      if (!isValidEmailTarget(item.target)) {
        throw new Error(`${item.source} needs a valid email address before this workflow can be saved.`);
      }
      continue;
    }

    if (!isSlackChannelId(item.target)) {
      const key = `SLACK_TARGET:${item.target}`;
      if (warningKeys.has(key)) continue;
      warningKeys.add(key);
      warnings.push(warning(
        key,
        'Slack channel visibility',
        `${item.source} uses ${item.target}. Violema will verify the Slack channel at delivery time; invite the app to private channels or use a channel ID for the most reliable run.`,
      ));
    }
  }

  return { ok: true, warnings };
}

type ClassifiableStep = Pick<
  AutomationStepExecution,
  'status' | 'title' | 'error' | 'kind' | 'stepId' | 'stepSeverity' | 'warnings'
>;

/**
 * The system's own end-of-run summary step, which degrades to a deterministic
 * fallback when a model route is down. It has never blocked a run, because its
 * failure costs presentation rather than evidence.
 */
function isSystemSummaryStep(step: ClassifiableStep) {
  return (
    step.kind === 'summarize' &&
    step.title === 'Generate automation summary' &&
    /^auto_step_/.test(step.stepId)
  );
}

/**
 * Fail closed: only a failure explicitly marked `auxiliary` is tolerated.
 * A missing severity — an older persisted record, an unclassified step — blocks
 * exactly as it always has.
 */
function isBlockingStepFailure(step: ClassifiableStep) {
  if (step.status !== 'failed') return false;
  if (isSystemSummaryStep(step)) return false;
  return step.stepSeverity !== 'auxiliary';
}

/**
 * The tolerated failures of a run, in step order.
 *
 * Note this reports auxiliary failures even on a run that ends up blocked for
 * an unrelated critical reason. Two things went wrong, and the operator gets
 * told about both.
 */
export function collectAutomationRunWarnings(
  stepExecutions: ClassifiableStep[],
): AutomationRunWarning[] {
  const failureWarnings = stepExecutions
    .filter((step) => step.status === 'failed' && step.stepSeverity === 'auxiliary')
    .map((step) => ({
      stepId: step.stepId,
      title: step.title,
      message: readString(step.error) || `${step.title || 'A workflow step'} did not complete.`,
    }));

  // A step can also carry its own named warnings independent of failure — a
  // read that still succeeded but has something the operator should see
  // (e.g. a folder-drop share problem). Deduped per step so a repeated
  // message never shows up twice for the same step.
  const stepWarnings: AutomationRunWarning[] = [];
  for (const step of stepExecutions) {
    const messages = step.warnings ?? [];
    if (messages.length === 0) continue;
    const seen = new Set<string>();
    for (const message of messages) {
      if (!message || seen.has(message)) continue;
      seen.add(message);
      stepWarnings.push({ stepId: step.stepId, title: step.title, message });
    }
  }

  return [...failureWarnings, ...stepWarnings];
}

function describeRunWarnings(warnings: AutomationRunWarning[]) {
  return warnings.map((item) => `${item.title} — ${item.message}`).join('; ');
}

/**
 * Stamp the run's warnings onto the review gate artifact.
 *
 * An approver decides from the review gate, so the gate has to carry what did
 * not happen. Applied after the run finishes rather than when the gate is built
 * so the list is complete regardless of step ordering — a mission that archives
 * after delivering still shows the approver the same facts as one that archives
 * before. Mutates in place, because the caller persists these exact artifact
 * objects into both the task and the run.
 */
export function applyRunWarningsToReviewGate(
  artifacts: unknown[] | undefined | null,
  warnings: AutomationRunWarning[],
) {
  if (!Array.isArray(artifacts) || warnings.length === 0) return;

  for (const artifact of artifacts) {
    const record = readRecord(artifact);
    if (!record || readString(record.kind) !== 'review_gate') continue;
    const payload = readRecord(record.payload);
    if (!payload) continue;
    payload.runWarnings = warnings;
  }
}

export function classifyAutomationRunOutcome(input: {
  deliveryWaitingForReview?: boolean;
  deliveryError?: string | null;
  stepExecutions: ClassifiableStep[];
  /**
   * Run-level facts that belong on the review gate but were not produced by
   * any single step — e.g. the per-mission credit budget being crossed by
   * the run's total. Carried on every outcome the same way step warnings
   * are.
   */
  extraWarnings?: AutomationRunWarning[];
}): AutomationRunOutcome {
  const runWarnings = [
    ...collectAutomationRunWarnings(input.stepExecutions),
    ...(input.extraWarnings ?? []),
  ];
  const warningDetail = runWarnings.length > 0 ? ` Not everything completed: ${describeRunWarnings(runWarnings)}` : '';

  // Evidence integrity first. A critical failure means the output's truth is in
  // question, and nothing may be delivered — unchanged from day one.
  const failedStep = input.stepExecutions.find(isBlockingStepFailure);
  if (input.deliveryError || failedStep) {
    const detail = input.deliveryError || failedStep?.error || `${failedStep?.title || 'A workflow step'} failed.`;
    return {
      taskStatus: 'blocked',
      runStatus: 'failed',
      delegationState: 'review',
      schedulerOk: false,
      reviewRequired: false,
      reviewSummary: `Run needs attention before it can be trusted or delivered. ${detail}`,
      runWarnings,
    };
  }

  // Past this point only auxiliary steps failed, so the drafted output is still
  // fully evidenced. It stays deliverable and review-gated as normal.
  if (input.deliveryWaitingForReview) {
    return {
      taskStatus: 'waiting_review',
      runStatus: 'succeeded',
      delegationState: 'review',
      schedulerOk: true,
      reviewRequired: true,
      reviewSummary: `Delivery is prepared and waiting for approval.${warningDetail}`,
      runWarnings,
    };
  }

  return {
    taskStatus: 'completed',
    runStatus: 'succeeded',
    delegationState: 'completed',
    schedulerOk: true,
    reviewRequired: false,
    reviewSummary: runWarnings.length > 0
      ? `Run completed and delivered.${warningDetail}`
      : 'Run completed cleanly.',
    runWarnings,
  };
}

export function buildAutomationPreflightReport(input: {
  automation: {
    id: string;
    name: string;
    schedule: string;
    actions: string[];
    notify?: string;
    steps?: PersistedAutomationStep[];
  };
  env?: Record<string, string | undefined>;
}): AutomationPreflightReport {
  const env = input.env || process.env;
  const steps = input.automation.steps || [];
  const blockers: AutomationPreflightBlocker[] = [];

  if (steps.some(stepNeedsSearch) && !hasEnv(env, 'TAVILY_API_KEY')) {
    blockers.push(blocker(
      'TAVILY_API_KEY',
      'Search provider',
      'Search/research steps need Tavily before this mission can complete.',
    ));
  }

  if (steps.some(stepNeedsModel) && !hasEnv(env, 'ANTHROPIC_API_KEY') && !hasEnv(env, 'OPENROUTER_API_KEY')) {
    blockers.push(blocker(
      'ANTHROPIC_API_KEY or OPENROUTER_API_KEY',
      'Reasoning model',
      'Analysis and summarization steps need at least one configured model provider.',
    ));
  }

  if (steps.some((step) => stepNeedsSlack(step, input.automation.notify)) && !hasEnv(env, 'SLACK_BOT_TOKEN')) {
    blockers.push(blocker(
      'SLACK_BOT_TOKEN',
      'Slack delivery',
      'Slack delivery steps need a bot token and channel visibility before activation.',
    ));
  }

  if (steps.some((step) => stepNeedsEmail(step, input.automation.notify)) && (!hasEnv(env, 'POSTMARK_API_KEY') || !hasEnv(env, 'POSTMARK_FROM_EMAIL'))) {
    blockers.push(blocker(
      'POSTMARK_API_KEY and POSTMARK_FROM_EMAIL',
      'Email delivery',
      'Email delivery steps need Postmark credentials before activation.',
    ));
  }

  let deliveryWarnings: AutomationPreflightBlocker[] = [];
  try {
    deliveryWarnings = validateAutomationDeliveryDraft({
      notify: input.automation.notify,
      steps,
    }).warnings;
  } catch (error) {
    blockers.push(blocker(
      'DELIVERY_TARGET',
      'Delivery target',
      error instanceof Error ? error.message : 'Delivery target needs attention before this mission can complete.',
    ));
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings: deliveryWarnings,
    summary: blockers.length === 0
      ? deliveryWarnings.length > 0
        ? 'Ready to run, with delivery visibility checks deferred until send time.'
        : 'Ready to run. Required execution credentials are configured.'
      : `${blockers.length} blocker${blockers.length === 1 ? '' : 's'} must be fixed before this mission can complete.`,
  };
}

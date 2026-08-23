// The single implementation of "approve this review" and "request changes on
// this review", shared by the dashboard's HTTP routes and the Slack interactive
// card.
//
// Why this module exists: an approval is a decision to send something real. If
// Slack and the dashboard each had their own copy of that decision path, the
// provenance re-scan, the dry-run semantics, the ledger events, and the
// consumed-review guard would drift, and the two surfaces would eventually
// disagree about what has already been sent. They call the same function
// instead, and the caller's only job is to render the outcome.
//
// Outcomes are returned, not thrown, as a discriminated union. The HTTP layer
// maps them to status codes and the Slack layer maps them to a chat.update —
// from the same values, so "already approved" means the same thing on both.

import crypto from 'node:crypto';
import { getAutomationById, updateAutomation } from './scheduler';
import {
  acquireCreditHold,
  getPlatformState,
  listLedgerEntries,
  listTaskRuns,
  listTasks,
  releaseCreditHold,
  settleCreditHoldWithOverrun,
  updateTask,
  updateTaskRun,
} from './platform/store';
import {
  completeAutomationReviewDelivery,
  prepareAutomationReviewDelivery,
  requestAutomationChanges,
  type PreparedAutomationReviewDelivery,
} from './platform/automationLifecycle';
import { DEFAULT_TOOL_CREDIT_COST } from './platform/cost';
import { buildFabricatedEvidenceDeliveryError, findFabricatedEvidence } from './platform/provenance';
import { isDemoWorkspace } from './platform/demoWorkspace';
import { DEFAULT_WORKSPACE_ID } from './platform/workspace';
import { inferWorkflowIdFromAutomation } from './integrationGateway/workflowPolicy';
import { appendWorkflowLedgerEvent, listWorkflowLedgerEvents } from './integrationGateway/auditLog';
import { sanitizeIntegrationDiagnostic } from './integrationGateway/diagnostics';
import type { AutomationStepDeliveryTarget, TaskRecord, TaskRunRecord } from './platform/types';

/**
 * Who performed the action. Recorded on every ledger event so the audit trail
 * distinguishes a dashboard click from a Slack button, and names the human.
 * Identifiers only — never message content.
 */
export interface ReviewActor {
  surface: 'dashboard' | 'slack';
  /** Human-readable reviewer name stored on the receipt. */
  label: string;
  slackUserId?: string;
  email?: string;
}

export interface ReviewSendInput {
  to: string;
  body: string;
  subject?: string;
  channel?: AutomationStepDeliveryTarget['channel'];
  evidenceLinks?: Array<{ url: string; label: string }>;
  chartSpecs?: unknown[];
  /** Awaited by the sender immediately before the first physical request. */
  onExternalRequestStart?: () => void | Promise<void>;
}

export type ReviewSend = (input: ReviewSendInput) => Promise<Record<string, unknown>>;
export type ReviewDeliveryPreflight = (input: ReviewSendInput) => Promise<void>;

const REVIEW_DELIVERY_CREDIT_HOLD_TTL_MS = 30 * 60 * 1000;
const REVIEW_DELIVERY_RECONCILIATION_ERROR =
  'The approved delivery may have reached its destination, but Violema could not prove the final remote outcome. The delivery was charged once and this review is blocked from replay until it is reconciled.';

type ReviewDeliveryAttemptStatus =
  | 'prepared'
  | 'request_started'
  | 'succeeded'
  | 'settled'
  | 'outcome_unknown';

interface ReviewDeliveryAttempt {
  id: string;
  status: ReviewDeliveryAttemptStatus;
  holdId: string;
  chargeCredits: number;
  baseActualCredits: number;
  automationId: string;
  taskId: string;
  taskRunId: string;
  reviewer: string;
  actor: ReturnType<typeof actorMetadata>;
  deliveryTarget: string;
  artifactTitle?: string;
  startedAt: string;
  requestStartedAt?: string;
  finishedAt?: string;
  error?: string;
  delivery?: Record<string, unknown>;
  settledCredits?: number;
  unsettledCredits?: number;
}

/** Summary of a review that was already closed, so callers can say by whom and when. */
export interface ResolvedReviewSummary {
  status: 'delivered' | 'changes_requested';
  reviewer: string;
  reviewedAt: string;
}

/** The full automation record, so callers that also need steps/schedule (the rerun route) keep working. */
export type ReviewAutomation = NonNullable<ReturnType<typeof getAutomationById>>;

export interface ReviewActionContext {
  automation: ReviewAutomation;
  task: TaskRecord;
  taskRun: TaskRunRecord;
}

/**
 * `missionName` is present whenever the failure happened after the review was
 * resolved, so a Slack card can name the mission it is reporting on instead of
 * degrading to a generic label.
 */
export type ReviewActionFailure =
  | { status: 'not_found'; error: string; missionName?: string }
  | { status: 'invalid'; error: string; missionName?: string; resolved?: ResolvedReviewSummary }
  | { status: 'fabricated_evidence'; error: string; missionName?: string }
  | { status: 'scan_failed'; error: string; missionName?: string }
  | { status: 'delivery_not_ready'; error: string; missionName?: string }
  | { status: 'insufficient_credits'; error: string; missionName?: string }
  | { status: 'failed'; error: string; missionName?: string };

export type ApproveReviewResult =
  | {
      status: 'ok';
      dryRun: boolean;
      context: ReviewActionContext;
      receipt: Record<string, unknown>;
      delivery: Record<string, unknown>;
      task?: TaskRecord | null;
      taskRun?: TaskRunRecord | null;
      taskPatch: unknown;
      runPatch: unknown;
      ledgerEvents: Array<Record<string, unknown>>;
    }
  | ReviewActionFailure;

export type RequestChangesResult =
  | {
      status: 'ok';
      dryRun: boolean;
      context: ReviewActionContext;
      reviewRequest: Record<string, unknown>;
      task?: TaskRecord | null;
      taskRun?: TaskRunRecord | null;
      taskPatch: unknown;
      runPatch: unknown;
      ledgerEvents: Array<Record<string, unknown>>;
    }
  | ReviewActionFailure;

function getAutomationWorkspaceId(automation: { workspaceId?: string } | null | undefined) {
  return automation?.workspaceId || DEFAULT_WORKSPACE_ID;
}

function automationBelongsToWorkspace(
  automation: { workspaceId?: string } | null | undefined,
  workspaceId: string,
) {
  return getAutomationWorkspaceId(automation) === workspaceId;
}

/**
 * Resolves the automation + task + run triple for a review, scoped to the
 * workspace. Kept here rather than in server.ts so both surfaces resolve
 * reviews through identical rules.
 */
export function findAutomationReviewContext(
  workspaceId: string,
  automationId: string,
  runId: string,
): ReviewActionContext | { error: string } {
  const automation = getAutomationById(automationId);
  if (!automation || !automationBelongsToWorkspace(automation, workspaceId)) {
    return { error: 'Automation not found' };
  }

  const taskRun = listTaskRuns(workspaceId).find((run) =>
    run.id === runId &&
    typeof run.metadata?.automationId === 'string' &&
    run.metadata.automationId === automationId
  );
  if (!taskRun) return { error: 'Automation run not found' };

  const task = listTasks(workspaceId).find((item) => item.id === taskRun.taskId);
  if (!task) return { error: 'Mission task not found' };

  return { automation, task, taskRun };
}

function toFailure(error: string): ReviewActionFailure {
  return error === 'Automation not found'
    ? { status: 'not_found', error }
    : { status: 'invalid', error };
}

/**
 * Reads the receipt left behind by whichever surface closed this review first.
 * This is what turns a second click into "already approved by X at Y" instead
 * of an opaque error.
 */
export function readResolvedReviewSummary(
  task: TaskRecord,
  taskRun: TaskRunRecord,
): ResolvedReviewSummary | undefined {
  const candidates = [
    taskRun.metadata?.reviewReceipt,
    task.metadata?.reviewReceipt,
    taskRun.metadata?.reviewRequest,
    task.metadata?.reviewRequest,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const status = record.status;
    if (status !== 'delivered' && status !== 'changes_requested') continue;
    return {
      status,
      reviewer: typeof record.reviewer === 'string' ? record.reviewer : 'someone',
      reviewedAt: typeof record.reviewedAt === 'string' ? record.reviewedAt : '',
    };
  }

  return undefined;
}

function applyReviewTaskPatch(
  taskId: string,
  currentMetadata: Record<string, unknown> | undefined,
  patch: { status: 'completed' | 'blocked'; delegationState: 'completed' | 'review'; metadata?: Record<string, unknown> },
) {
  return updateTask(taskId, {
    ...patch,
    metadata: {
      ...(currentMetadata || {}),
      ...(patch.metadata || {}),
    },
  });
}

/**
 * The ledger records THAT a delivery happened — target, channel, status,
 * timestamps — never what it said.
 *
 * `approveAutomationReview` returns the send result with the rendered brief
 * appended as `body`, which is the right shape for the HTTP response but must
 * not be persisted: the repo rule is that raw bodies and full document text
 * stay out of ledger metadata. Stripped here, at the one place that writes it.
 */
function summarizeDeliveryForLedger(delivery: Record<string, unknown>) {
  const { body, text, blocks, ...rest } = delivery;
  void body;
  void text;
  void blocks;
  return rest;
}

/** Identifiers only — the audit trail records who acted, never what was written. */
function actorMetadata(actor: ReviewActor) {
  return {
    surface: actor.surface,
    ...(actor.slackUserId ? { slackUserId: actor.slackUserId } : {}),
    ...(actor.email ? { email: actor.email } : {}),
    label: actor.label,
  };
}

function safeReviewDeliveryError(error: unknown, fallback: string) {
  return sanitizeIntegrationDiagnostic(
    error instanceof Error ? error.message : typeof error === 'string' ? error : fallback,
  );
}

function readReviewDeliveryAttempt(value: unknown): ReviewDeliveryAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (
    typeof record.id !== 'string'
    || typeof record.holdId !== 'string'
    || typeof record.automationId !== 'string'
    || typeof record.taskId !== 'string'
    || typeof record.taskRunId !== 'string'
    || typeof record.reviewer !== 'string'
    || typeof record.deliveryTarget !== 'string'
    || typeof record.startedAt !== 'string'
    || typeof record.chargeCredits !== 'number'
    || !Number.isFinite(record.chargeCredits)
    || typeof record.baseActualCredits !== 'number'
    || !Number.isFinite(record.baseActualCredits)
    || !['prepared', 'request_started', 'succeeded', 'settled', 'outcome_unknown'].includes(String(status))
  ) return null;

  return record as unknown as ReviewDeliveryAttempt;
}

function findReviewDeliveryHoldTerminal(workspaceId: string, holdId: string) {
  return listLedgerEntries(workspaceId).find((entry) =>
    entry.metadata?.holdId === holdId
    && (entry.metadata?.holdStatus === 'settled' || entry.metadata?.holdStatus === 'released')
  );
}

function pauseAutomationAfterAmbiguousApproval(automationId: string) {
  const automation = getAutomationById(automationId);
  if (!automation || automation.status === 'paused') return;
  updateAutomation(
    automationId,
    { status: 'paused' },
    async () => ({ ok: false, error: 'Automation is paused for delivery reconciliation.' }),
  );
}

function addApprovedDeliveryCharge(value: unknown, chargeCredits: number, attemptId: string) {
  if (!Array.isArray(value)) return undefined;
  let charged = false;
  return value.map((item) => {
    if (charged || !item || typeof item !== 'object' || Array.isArray(item)) return item;
    const step = item as Record<string, unknown>;
    if (step.kind !== 'deliver') return item;
    charged = true;
    const currentCharge = step.charge && typeof step.charge === 'object' && !Array.isArray(step.charge)
      ? step.charge as Record<string, unknown>
      : {};
    if (
      step.approvedDeliveryAttemptId === attemptId
      || currentCharge.approvedDeliveryAttemptId === attemptId
    ) return item;
    const previousToolCredits = Number(currentCharge.toolCredits) || 0;
    const previousActualCredits = Number(step.actualCredits ?? currentCharge.actualCredits) || 0;
    return {
      ...step,
      approvedDeliveryAttemptId: attemptId,
      toolCalls: Math.max(0, Math.trunc(Number(step.toolCalls) || 0)) + 1,
      actualCredits: previousActualCredits + chargeCredits,
      charge: {
        ...currentCharge,
        approvedDeliveryAttemptId: attemptId,
        actualCredits: previousActualCredits + chargeCredits,
        toolCredits: previousToolCredits + chargeCredits,
        rationale: [
          ...(Array.isArray(currentCharge.rationale) ? currentCharge.rationale : []),
          `approved_delivery_tool:${chargeCredits}`,
        ],
      },
    };
  });
}

function persistReviewDeliveryAttempt(
  context: ReviewActionContext,
  attempt: ReviewDeliveryAttempt,
  taskPatch: Partial<TaskRecord> = {},
) {
  const currentTask = listTasks(context.task.workspaceId).find((task) => task.id === context.task.id);
  const task = updateTask(context.task.id, {
    ...taskPatch,
    metadata: {
      ...(currentTask?.metadata || context.task.metadata || {}),
      reviewDeliveryAttempt: attempt,
      deliveryClaim: {
        id: attempt.id,
        by: attempt.reviewer,
        at: attempt.startedAt,
        status: attempt.status,
      },
      ...(taskPatch.metadata || {}),
    },
  });
  const taskRun = updateTaskRun(context.taskRun.id, {
    metadata: { reviewDeliveryAttempt: attempt },
  });
  if (!task || !taskRun) throw new Error('Could not persist the approval delivery attempt.');
  return { task, taskRun };
}

function settleReviewDeliveryAttempt(workspaceId: string, attempt: ReviewDeliveryAttempt) {
  const terminal = findReviewDeliveryHoldTerminal(workspaceId, attempt.holdId);
  if (terminal?.metadata?.holdStatus === 'settled') {
    const settledCredits = Math.max(
      0,
      Math.trunc(Number(terminal.metadata.actualCredits) || Math.abs(terminal.deltaCredits)),
    );
    const unsettledCredits = Math.max(
      0,
      Math.trunc(
        Number(terminal.metadata.overrunCredits)
        || attempt.chargeCredits - settledCredits,
      ),
    );
    return { settledCredits, unsettledCredits };
  }
  if (terminal) throw new Error('The approval delivery credit hold was released before settlement.');
  const settlement = settleCreditHoldWithOverrun(attempt.holdId, {
    workspaceId,
    source: 'automation_run',
    actualCredits: attempt.chargeCredits,
    referenceType: 'automation',
    referenceId: attempt.automationId,
    note: 'Settled approved delivery tool charge',
    metadata: {
      reviewDeliveryAttemptId: attempt.id,
      taskId: attempt.taskId,
      taskRunId: attempt.taskRunId,
      approvalDelivery: true,
    },
  });
  return {
    settledCredits: settlement.settledCredits,
    unsettledCredits: settlement.overrunCredits,
  };
}

function releaseUnusedReviewDeliveryHold(workspaceId: string, attempt: ReviewDeliveryAttempt, reason: string) {
  if (findReviewDeliveryHoldTerminal(workspaceId, attempt.holdId)) return;
  releaseCreditHold(attempt.holdId, {
    workspaceId,
    referenceType: 'automation',
    referenceId: attempt.automationId,
    note: reason,
    metadata: {
      reviewDeliveryAttemptId: attempt.id,
      taskId: attempt.taskId,
      taskRunId: attempt.taskRunId,
      approvalDelivery: true,
    },
  });
}

/**
 * Backfill the two durable facts owned by one approved delivery independently.
 * The send receipt and credit settlement are persisted before the audit log;
 * a crash between those stores must not leave a delivered approval permanently
 * invisible, and one surviving event must not suppress its missing sibling.
 */
function ensureReviewDeliveryAuditEvents(input: {
  workspaceId: string;
  attempt: ReviewDeliveryAttempt;
  task?: TaskRecord;
  taskRun?: TaskRunRecord;
  receipt?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
}) {
  if (!input.task || !input.taskRun) return;
  const existing = listWorkflowLedgerEvents({
    workspaceId: input.workspaceId,
    taskRunId: input.taskRun.id,
  });
  const presentTypes = new Set(existing
    .filter((event) => event.metadata?.reviewDeliveryAttemptId === input.attempt.id)
    .map((event) => event.type));
  const storedReceipt = input.taskRun.metadata?.reviewReceipt || input.task.metadata?.reviewReceipt;
  const receipt = input.receipt
    || (storedReceipt && typeof storedReceipt === 'object' && !Array.isArray(storedReceipt)
      ? storedReceipt as Record<string, unknown>
      : {
          status: 'delivered',
          reviewer: input.attempt.reviewer,
          reviewedAt: input.attempt.finishedAt || input.attempt.startedAt,
          automationId: input.attempt.automationId,
          taskId: input.attempt.taskId,
          taskRunId: input.attempt.taskRunId,
          deliveryTarget: input.attempt.deliveryTarget,
          artifactTitle: input.attempt.artifactTitle,
          delivery: input.attempt.delivery || {},
        });
  const delivery = summarizeDeliveryForLedger(input.delivery || input.attempt.delivery || {});
  const workflowId = inferWorkflowIdFromAutomation(getAutomationById(input.attempt.automationId) || {});
  const events = [{
    type: 'approval_granted' as const,
    summary: `Recovered approval for delivery to ${input.attempt.deliveryTarget}.`,
    metadata: {
      receipt,
      actor: input.attempt.actor,
      reviewDeliveryAttemptId: input.attempt.id,
      recovered: true,
    },
  }, {
    type: 'external_action_executed' as const,
    summary: `Recovered approved delivery to ${input.attempt.deliveryTarget}.`,
    metadata: {
      delivery,
      actor: input.attempt.actor,
      reviewDeliveryAttemptId: input.attempt.id,
      recovered: true,
    },
  }];

  for (const event of events) {
    if (presentTypes.has(event.type)) continue;
    try {
      appendWorkflowLedgerEvent({
        workspaceId: input.workspaceId,
        workflowId,
        automationId: input.attempt.automationId,
        taskId: input.task.id,
        taskRunId: input.taskRun.id,
        ...event,
      });
      presentTypes.add(event.type);
    } catch (error) {
      // The send and charge remain terminal and non-replayable. A later boot
      // retries only the still-missing event for this attempt id.
      console.error(`[review] could not append recovered ${event.type} audit ${input.attempt.id}`, error);
    }
  }
}

export interface ReconciledReviewDelivery {
  attemptId: string;
  outcome: 'restored' | 'blocked' | 'completed' | 'released_orphan_hold';
}

function selectFurthestReviewDeliveryAttempt(
  current: ReviewDeliveryAttempt | undefined,
  candidate: ReviewDeliveryAttempt,
) {
  if (!current) return candidate;
  const rank: Record<ReviewDeliveryAttemptStatus, number> = {
    prepared: 0,
    request_started: 1,
    succeeded: 2,
    settled: 3,
    outcome_unknown: 4,
  };
  return rank[candidate.status] >= rank[current.status] ? candidate : current;
}

/**
 * Close approval deliveries that were durable at process shutdown.
 *
 * `prepared` proves no send boundary was crossed and is safe to restore.
 * `request_started` cannot prove whether the remote accepted the message, so
 * it is charged once and quarantined. `succeeded` proves the sender returned;
 * recovery completes the local receipt without calling the sender again.
 */
export function reconcilePendingReviewDeliveries(): ReconciledReviewDelivery[] {
  const state = getPlatformState();
  const attempts = new Map<string, ReviewDeliveryAttempt>();
  for (const task of state.tasks) {
    const attempt = readReviewDeliveryAttempt(task.metadata?.reviewDeliveryAttempt);
    if (attempt) attempts.set(attempt.id, selectFurthestReviewDeliveryAttempt(attempts.get(attempt.id), attempt));
  }
  for (const run of state.taskRuns) {
    const attempt = readReviewDeliveryAttempt(run.metadata?.reviewDeliveryAttempt);
    if (attempt) attempts.set(attempt.id, selectFurthestReviewDeliveryAttempt(attempts.get(attempt.id), attempt));
  }

  const reconciled: ReconciledReviewDelivery[] = [];
  for (const attempt of attempts.values()) {
    const task = state.tasks.find((item) => item.id === attempt.taskId);
    const taskRun = state.taskRuns.find((item) => item.id === attempt.taskRunId);
    const workspaceId = task?.workspaceId || taskRun?.workspaceId;
    if (!workspaceId) continue;

    if (attempt.status === 'prepared') {
      try {
        releaseUnusedReviewDeliveryHold(
          workspaceId,
          attempt,
          'Released credits while restoring an approval interrupted before delivery started.',
        );
      } catch (error) {
        console.error(`[review] could not release prepared approval hold ${attempt.id}`, error);
      }
      if (task) {
        const metadata = { ...(task.metadata || {}) };
        delete metadata.deliveryClaim;
        metadata.reviewDeliveryAttempt = null;
        updateTask(task.id, {
          status: 'waiting_review',
          delegationState: 'review',
          metadata,
        });
      }
      if (taskRun) updateTaskRun(taskRun.id, { metadata: { reviewDeliveryAttempt: null } });
      reconciled.push({ attemptId: attempt.id, outcome: 'restored' });
      continue;
    }

    if (
      (attempt.status === 'settled' || attempt.status === 'succeeded')
      && task?.status === 'completed'
      && taskRun?.status === 'succeeded'
    ) {
      ensureReviewDeliveryAuditEvents({ workspaceId, attempt, task, taskRun });
      continue;
    }

    let settlement = { settledCredits: 0, unsettledCredits: attempt.chargeCredits };
    try {
      settlement = settleReviewDeliveryAttempt(workspaceId, attempt);
    } catch (error) {
      console.error(`[review] could not settle recovered approval ${attempt.id}`, error);
      const terminal = findReviewDeliveryHoldTerminal(workspaceId, attempt.holdId);
      if (terminal?.metadata?.holdStatus === 'settled') {
        const settledCredits = Math.max(
          0,
          Math.trunc(Number(terminal.metadata.actualCredits) || Math.abs(terminal.deltaCredits)),
        );
        settlement = {
          settledCredits,
          unsettledCredits: Math.max(0, attempt.chargeCredits - settledCredits),
        };
      }
    }

    if (
      (attempt.status === 'succeeded' || attempt.status === 'settled')
      && settlement.unsettledCredits === 0
      && task
      && taskRun
    ) {
      const delivery = attempt.delivery || {
        status: 'delivered',
        to: attempt.deliveryTarget,
        recovered: true,
      };
      const result = completeAutomationReviewDelivery({
        task,
        taskRun,
        reviewer: attempt.reviewer,
        prepared: {
          body: '',
          deliveryTarget: attempt.deliveryTarget,
          artifactTitle: attempt.artifactTitle,
          sendInput: {
            to: attempt.deliveryTarget,
            body: '',
            subject: attempt.artifactTitle || task.title,
            channel: attempt.deliveryTarget.includes('@') ? 'email' : 'slack',
          },
        },
        delivery,
        reviewedAt: attempt.finishedAt || new Date().toISOString(),
      });
      attempt.status = 'settled';
      attempt.settledCredits = settlement.settledCredits;
      attempt.unsettledCredits = 0;
      const chargedTaskSteps = addApprovedDeliveryCharge(
        result.taskPatch.metadata.latestStepExecutions,
        attempt.chargeCredits,
        attempt.id,
      );
      const chargedRunSteps = addApprovedDeliveryCharge(
        result.runPatch.metadata.stepExecutions,
        attempt.chargeCredits,
        attempt.id,
      );
      applyReviewTaskPatch(task.id, task.metadata, {
        ...result.taskPatch,
        metadata: {
          ...result.taskPatch.metadata,
          latestStepExecutions: chargedTaskSteps,
          reviewDeliveryAttempt: attempt,
          deliveryClaim: null,
          externalActionReconciliationRequired: false,
        },
      });
      updateTaskRun(taskRun.id, {
        status: 'succeeded',
        actualCredits: attempt.baseActualCredits + attempt.chargeCredits,
        metadata: {
          ...result.runPatch.metadata,
          stepExecutions: chargedRunSteps,
          reviewDeliveryAttempt: attempt,
          externalActionReconciliationRequired: false,
        },
      });
      ensureReviewDeliveryAuditEvents({
        workspaceId,
        attempt,
        task,
        taskRun,
        receipt: result.receipt as unknown as Record<string, unknown>,
        delivery,
      });
      reconciled.push({ attemptId: attempt.id, outcome: 'completed' });
      continue;
    }

    attempt.status = 'outcome_unknown';
    attempt.settledCredits = settlement.settledCredits;
    attempt.unsettledCredits = settlement.unsettledCredits;
    attempt.finishedAt ||= new Date().toISOString();
    attempt.error ||= REVIEW_DELIVERY_RECONCILIATION_ERROR;
    if (task) {
      updateTask(task.id, {
        status: 'blocked',
        delegationState: 'review',
        metadata: {
          ...(task.metadata || {}),
          reviewRequired: false,
          reviewDeliveryAttempt: attempt,
          deliveryClaim: null,
          latestStepExecutions: addApprovedDeliveryCharge(
            task.metadata?.latestStepExecutions,
            attempt.chargeCredits,
            attempt.id,
          ),
          externalActionReconciliationRequired: true,
          settlementRecoveryError: REVIEW_DELIVERY_RECONCILIATION_ERROR,
        },
      });
    }
    if (taskRun) {
      updateTaskRun(taskRun.id, {
        status: 'failed',
        actualCredits: attempt.baseActualCredits + attempt.chargeCredits,
        error: REVIEW_DELIVERY_RECONCILIATION_ERROR,
        metadata: {
          reviewRequired: false,
          reviewDeliveryAttempt: attempt,
          stepExecutions: addApprovedDeliveryCharge(
            taskRun.metadata?.stepExecutions,
            attempt.chargeCredits,
            attempt.id,
          ),
          approvalDeliveryUnsettledCredits: settlement.unsettledCredits,
          externalActionReconciliationRequired: true,
          settlementRecoveryError: REVIEW_DELIVERY_RECONCILIATION_ERROR,
        },
      });
    }
    pauseAutomationAfterAmbiguousApproval(attempt.automationId);
    reconciled.push({ attemptId: attempt.id, outcome: 'blocked' });
  }

  const terminalHoldIds = new Set(state.ledger
    .filter((entry) => ['released', 'settled'].includes(String(entry.metadata?.holdStatus)))
    .map((entry) => String(entry.metadata?.holdId || '')));
  for (const entry of state.ledger) {
    const holdId = typeof entry.metadata?.holdId === 'string' ? entry.metadata.holdId : '';
    const attemptId = typeof entry.metadata?.reviewDeliveryAttemptId === 'string'
      ? entry.metadata.reviewDeliveryAttemptId
      : '';
    if (
      entry.source !== 'credit_hold'
      || entry.metadata?.holdStatus !== 'active'
      || entry.metadata?.approvalDelivery !== true
      || !holdId
      || !attemptId
      || terminalHoldIds.has(holdId)
      || attempts.has(attemptId)
    ) continue;
    try {
      releaseCreditHold(holdId, {
        workspaceId: entry.workspaceId,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        note: 'Released an orphaned approval hold that never acquired a delivery claim.',
        metadata: { reviewDeliveryAttemptId: attemptId, approvalDelivery: true, recovered: true },
      });
      reconciled.push({ attemptId, outcome: 'released_orphan_hold' });
    } catch (error) {
      console.error(`[review] could not release orphaned approval hold ${attemptId}`, error);
    }
  }

  return reconciled;
}

/**
 * Runs the provenance re-scan that guards the approval gate.
 *
 * The run-time scan fires at delivery; this is a second, later decision against
 * evidence stored on disk, so what is about to be sent is checked again using
 * the same artifact resolution order the delivery path uses. A scan that cannot
 * complete fails CLOSED.
 */
function scanStoredEvidence(context: ReviewActionContext, workspaceId: string): ReviewActionFailure | null {
  if (isDemoWorkspace(workspaceId)) return null;

  try {
    const storedArtifacts = (Array.isArray(context.taskRun.metadata?.artifacts)
      ? context.taskRun.metadata.artifacts
      : Array.isArray(context.task.metadata?.latestArtifacts)
        ? context.task.metadata.latestArtifacts
        : []) as Parameters<typeof findFabricatedEvidence>[0]['artifacts'];
    const storedStepExecutions = (Array.isArray(context.taskRun.metadata?.stepExecutions)
      ? context.taskRun.metadata.stepExecutions
      : Array.isArray(context.task.metadata?.latestStepExecutions)
        ? context.task.metadata.latestStepExecutions
        : []) as Parameters<typeof findFabricatedEvidence>[0]['stepExecutions'];
    const fabricated = findFabricatedEvidence({
      artifacts: storedArtifacts,
      stepExecutions: storedStepExecutions,
    });
    if (fabricated) {
      return {
        status: 'fabricated_evidence',
        error: buildFabricatedEvidenceDeliveryError(fabricated),
        missionName: context.automation.name,
      };
    }
  } catch (error) {
    console.error('[automation] provenance re-scan failed at approval', error);
    return {
      status: 'scan_failed',
      error: 'Could not verify stored run evidence before sending. Try again.',
      missionName: context.automation.name,
    };
  }

  return null;
}

export async function executeReviewApproval(input: {
  workspaceId: string;
  automationId: string;
  runId: string;
  actor: ReviewActor;
  dryRun?: boolean;
  send: ReviewSend;
  preflight?: ReviewDeliveryPreflight;
  /** The sender promises to await `onExternalRequestStart` at its send boundary. */
  tracksExternalBoundary?: boolean;
  onBroadcast?: (context: ReviewActionContext, eventType: string) => void;
}): Promise<ApproveReviewResult> {
  const context = findAutomationReviewContext(input.workspaceId, input.automationId, input.runId);
  if ('error' in context) return toFailure(context.error);

  const scanFailure = scanStoredEvidence(context, input.workspaceId);
  if (scanFailure) return scanFailure;

  let prepared: PreparedAutomationReviewDelivery;
  try {
    prepared = prepareAutomationReviewDelivery({ task: context.task, taskRun: context.taskRun });
  } catch (error) {
    return {
      status: 'invalid',
      error: error instanceof Error ? error.message : 'This mission is not ready for approval.',
      missionName: context.automation.name,
      resolved: readResolvedReviewSummary(context.task, context.taskRun),
    };
  }

  try {
    await input.preflight?.(prepared.sendInput);
  } catch (error) {
    return {
      status: 'delivery_not_ready',
      error: safeReviewDeliveryError(error, 'The delivery route is not ready.'),
      missionName: context.automation.name,
    };
  }

  const buildLedgerEvents = (result: ReturnType<typeof completeAutomationReviewDelivery>, attemptId?: string) => {
    const workflowId = inferWorkflowIdFromAutomation(context.automation);
    const actor = actorMetadata(input.actor);
    return [{
      workspaceId: input.workspaceId,
      workflowId,
      automationId: context.automation.id,
      taskId: context.task.id,
      taskRunId: context.taskRun.id,
      type: 'approval_granted' as const,
      summary: `Approved delivery to ${result.receipt.deliveryTarget || 'configured destination'}.`,
      metadata: { receipt: result.receipt, actor, ...(attemptId ? { reviewDeliveryAttemptId: attemptId } : {}) },
    }, {
      workspaceId: input.workspaceId,
      workflowId,
      automationId: context.automation.id,
      taskId: context.task.id,
      taskRunId: context.taskRun.id,
      type: 'external_action_executed' as const,
      summary: `Delivered approved workflow output to ${result.receipt.deliveryTarget || 'configured destination'}.`,
      metadata: {
        delivery: summarizeDeliveryForLedger(result.delivery),
        actor,
        ...(attemptId ? { reviewDeliveryAttemptId: attemptId } : {}),
      },
    }];
  };

  if (input.dryRun) {
    try {
      const delivery = await input.send(prepared.sendInput);
      const result = completeAutomationReviewDelivery({
        task: context.task,
        taskRun: context.taskRun,
        reviewer: input.actor.label,
        prepared,
        delivery,
      });
      return {
        status: 'ok',
        dryRun: true,
        context,
        receipt: result.receipt as unknown as Record<string, unknown>,
        delivery: result.delivery,
        taskPatch: result.taskPatch,
        runPatch: result.runPatch,
        ledgerEvents: buildLedgerEvents(result),
      };
    } catch (error) {
      return {
        status: 'invalid',
        error: error instanceof Error ? error.message : 'Could not validate approved delivery',
        missionName: context.automation.name,
        resolved: readResolvedReviewSummary(context.task, context.taskRun),
      };
    }
  }

  const attemptId = `review_delivery_${crypto.randomUUID()}`;
  let hold: ReturnType<typeof acquireCreditHold>;
  try {
    hold = acquireCreditHold({
      workspaceId: input.workspaceId,
      amountCredits: DEFAULT_TOOL_CREDIT_COST,
      referenceType: 'automation',
      referenceId: context.automation.id,
      note: `Held credits for approved delivery: ${context.automation.name}`,
      ttlMs: REVIEW_DELIVERY_CREDIT_HOLD_TTL_MS,
      metadata: {
        reviewDeliveryAttemptId: attemptId,
        taskId: context.task.id,
        taskRunId: context.taskRun.id,
        approvalDelivery: true,
      },
    });
  } catch (error) {
    return {
      status: 'insufficient_credits',
      error: error instanceof Error ? error.message : 'The workspace does not have enough credits for this delivery.',
      missionName: context.automation.name,
    };
  }

  const attempt: ReviewDeliveryAttempt = {
    id: attemptId,
    status: 'prepared',
    holdId: hold.holdId,
    chargeCredits: DEFAULT_TOOL_CREDIT_COST,
    baseActualCredits: Math.max(0, Math.trunc(context.taskRun.actualCredits || 0)),
    automationId: context.automation.id,
    taskId: context.task.id,
    taskRunId: context.taskRun.id,
    reviewer: input.actor.label,
    actor: actorMetadata(input.actor),
    deliveryTarget: prepared.deliveryTarget,
    artifactTitle: prepared.artifactTitle,
    startedAt: new Date().toISOString(),
  };

  let claim: ReturnType<typeof claimReviewForDelivery>;
  try {
    claim = claimReviewForDelivery(context, input.actor, attempt);
  } catch (error) {
    try {
      releaseUnusedReviewDeliveryHold(
        input.workspaceId,
        attempt,
        'Released credits because the approval claim could not be persisted.',
      );
    } catch (releaseError) {
      console.error(`[review] could not release failed approval claim hold ${attempt.id}`, releaseError);
    }
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Could not claim this review for delivery.',
      missionName: context.automation.name,
    };
  }
  if ('alreadyClaimed' in claim) {
    try {
      releaseUnusedReviewDeliveryHold(input.workspaceId, attempt, 'Released credits because the review was already claimed.');
    } catch (error) {
      console.error('[review] could not release an unused duplicate approval hold', error);
    }
    return {
      status: 'invalid',
      error: 'This mission is not waiting for review.',
      missionName: context.automation.name,
      resolved: readResolvedReviewSummary(context.task, context.taskRun),
    };
  }

  let sendBoundaryCrossed = false;
  try {
    // Mirror the prepared claim onto the run. The task is authoritative if the
    // process dies between these two JSON stores; boot recovery reads either.
    updateTaskRun(context.taskRun.id, { metadata: { reviewDeliveryAttempt: attempt } });

    const markExternalRequestStarted = async () => {
      if (sendBoundaryCrossed) return;
      attempt.status = 'request_started';
      attempt.requestStartedAt = new Date().toISOString();
      persistReviewDeliveryAttempt(context, attempt, {
        status: 'running',
        delegationState: 'in_progress',
      });
      sendBoundaryCrossed = true;
    };
    if (!input.tracksExternalBoundary) await markExternalRequestStarted();
    const delivery = await input.send({
      ...prepared.sendInput,
      onExternalRequestStart: markExternalRequestStarted,
    });

    attempt.status = 'succeeded';
    attempt.finishedAt = new Date().toISOString();
    attempt.delivery = summarizeDeliveryForLedger(delivery);
    persistReviewDeliveryAttempt(context, attempt, {
      status: 'running',
      delegationState: 'in_progress',
    });

    const settlement = settleReviewDeliveryAttempt(input.workspaceId, attempt);
    if (settlement.unsettledCredits > 0) {
      attempt.settledCredits = settlement.settledCredits;
      attempt.unsettledCredits = settlement.unsettledCredits;
      throw new Error(
        `The approved delivery returned, but ${settlement.unsettledCredits} delivery credit${settlement.unsettledCredits === 1 ? '' : 's'} could not be settled.`,
      );
    }
    attempt.status = 'settled';
    attempt.settledCredits = settlement.settledCredits;
    attempt.unsettledCredits = 0;

    const result = completeAutomationReviewDelivery({
      task: context.task,
      taskRun: context.taskRun,
      reviewer: input.actor.label,
      prepared,
      delivery,
    });
    const chargedTaskSteps = addApprovedDeliveryCharge(
      result.taskPatch.metadata.latestStepExecutions,
      attempt.chargeCredits,
      attempt.id,
    );
    const chargedRunSteps = addApprovedDeliveryCharge(
      result.runPatch.metadata.stepExecutions,
      attempt.chargeCredits,
      attempt.id,
    );
    const currentTask = listTasks(input.workspaceId).find((task) => task.id === context.task.id);
    const taskPatch = {
      ...result.taskPatch,
      metadata: {
        ...result.taskPatch.metadata,
        latestStepExecutions: chargedTaskSteps,
        reviewDeliveryAttempt: attempt,
        deliveryClaim: null,
        externalActionReconciliationRequired: false,
      },
    };
    const runPatch = {
      ...result.runPatch,
      metadata: {
        ...result.runPatch.metadata,
        stepExecutions: chargedRunSteps,
        reviewDeliveryAttempt: attempt,
        externalActionReconciliationRequired: false,
      },
    };
    const task = applyReviewTaskPatch(
      context.task.id,
      currentTask?.metadata || context.task.metadata,
      taskPatch,
    );
    const taskRun = updateTaskRun(context.taskRun.id, {
      status: 'succeeded',
      actualCredits: attempt.baseActualCredits + attempt.chargeCredits,
      metadata: runPatch.metadata,
    });
    if (!task || !taskRun) throw new Error('The approved delivery returned, but its local receipt could not be persisted.');

    const ledgerEvents = buildLedgerEvents(result, attempt.id);
    for (const event of ledgerEvents) {
      try {
        appendWorkflowLedgerEvent(event);
      } catch (error) {
        // Delivery, receipt, and charge are already durable. Audit storage is
        // fail-soft here because turning a delivered message back into a
        // retryable review would create a duplicate send.
        console.error(`[review] could not append ${event.type} for ${attempt.id}`, error);
      }
    }
    try {
      input.onBroadcast?.(context, 'automation_review_approved');
    } catch (error) {
      console.error(`[review] could not broadcast approved review ${attempt.id}`, error);
    }

    return {
      status: 'ok',
      dryRun: false,
      context,
      receipt: result.receipt as unknown as Record<string, unknown>,
      delivery: result.delivery,
      task,
      taskRun,
      taskPatch,
      runPatch,
      ledgerEvents,
    };
  } catch (error) {
    if (!sendBoundaryCrossed) {
      try {
        claim.release();
      } catch (releaseError) {
        console.error(`[review] could not restore pre-send review ${attempt.id}`, releaseError);
      }
      try {
        releaseUnusedReviewDeliveryHold(
          input.workspaceId,
          attempt,
          'Released credits because approval stopped before the send boundary.',
        );
      } catch (releaseError) {
        console.error(`[review] could not release pre-send approval hold ${attempt.id}`, releaseError);
      }
      return {
        status: 'failed',
        error: safeReviewDeliveryError(error, 'Could not prepare approved delivery'),
        missionName: context.automation.name,
      };
    }

    attempt.status = 'outcome_unknown';
    attempt.finishedAt = new Date().toISOString();
    attempt.error = safeReviewDeliveryError(error, 'Approved delivery outcome is unknown.');
    let settlement = { settledCredits: 0, unsettledCredits: attempt.chargeCredits };
    try {
      persistReviewDeliveryAttempt(context, attempt, {
        status: 'blocked',
        delegationState: 'review',
        metadata: {
          reviewRequired: false,
          externalActionReconciliationRequired: true,
          settlementRecoveryError: REVIEW_DELIVERY_RECONCILIATION_ERROR,
        },
      });
    } catch (persistError) {
      console.error(`[review] could not persist ambiguous approval ${attempt.id}`, persistError);
    }
    try {
      settlement = settleReviewDeliveryAttempt(input.workspaceId, attempt);
      attempt.settledCredits = settlement.settledCredits;
      attempt.unsettledCredits = settlement.unsettledCredits;
    } catch (settlementError) {
      console.error(`[review] could not settle ambiguous approval ${attempt.id}`, settlementError);
    }
    try {
      updateTaskRun(context.taskRun.id, {
        status: 'failed',
        actualCredits: attempt.baseActualCredits + attempt.chargeCredits,
        error: REVIEW_DELIVERY_RECONCILIATION_ERROR,
        metadata: {
          reviewRequired: false,
          reviewDeliveryAttempt: attempt,
          stepExecutions: addApprovedDeliveryCharge(
            context.taskRun.metadata?.stepExecutions,
            attempt.chargeCredits,
            attempt.id,
          ),
          approvalDeliveryUnsettledCredits: settlement.unsettledCredits,
          externalActionReconciliationRequired: true,
          settlementRecoveryError: REVIEW_DELIVERY_RECONCILIATION_ERROR,
        },
      });
      const currentTask = listTasks(input.workspaceId).find((task) => task.id === context.task.id);
      updateTask(context.task.id, {
        status: 'blocked',
        delegationState: 'review',
        metadata: {
          ...(currentTask?.metadata || context.task.metadata || {}),
          reviewRequired: false,
          reviewDeliveryAttempt: attempt,
          deliveryClaim: null,
          latestStepExecutions: addApprovedDeliveryCharge(
            currentTask?.metadata?.latestStepExecutions ?? context.task.metadata?.latestStepExecutions,
            attempt.chargeCredits,
            attempt.id,
          ),
          externalActionReconciliationRequired: true,
          settlementRecoveryError: REVIEW_DELIVERY_RECONCILIATION_ERROR,
        },
      });
      pauseAutomationAfterAmbiguousApproval(context.automation.id);
    } catch (closeError) {
      console.error(`[review] could not close ambiguous approval ${attempt.id}`, closeError);
    }

    return {
      status: 'failed',
      error: `${attempt.error}\n\n${REVIEW_DELIVERY_RECONCILIATION_ERROR}`,
      missionName: context.automation.name,
    };
  }
}

/**
 * Take exclusive ownership of an open review so only one approval can deliver.
 *
 * Moves the task out of `waiting_review` synchronously — the state
 * `assertReviewable` guards on — and records who claimed it. Returns a handle
 * that restores the prior state if the delivery never happens.
 */
function claimReviewForDelivery(
  context: ReviewActionContext,
  actor: ReviewActor,
  attempt: ReviewDeliveryAttempt,
): { release: () => void } | { alreadyClaimed: true } {
  const current = listTasks(context.task.workspaceId).find((task) => task.id === context.task.id);
  if (!current || current.status !== 'waiting_review') {
    return { alreadyClaimed: true };
  }

  const previousStatus = current.status;
  const previousDelegationState = current.delegationState;
  // `running` is the honest status while the delivery is in flight, and it is
  // not `waiting_review`, which is what makes the claim exclusive.
  const claimedTask = updateTask(context.task.id, {
    status: 'running',
    delegationState: 'in_progress',
    metadata: {
      ...(current.metadata || {}),
      reviewDeliveryAttempt: attempt,
      deliveryClaim: {
        id: attempt.id,
        by: actor.label,
        at: attempt.startedAt,
        status: attempt.status,
      },
    },
  });
  if (!claimedTask) throw new Error('Could not persist the approval delivery claim.');

  return {
    release: () => {
      const claimed = listTasks(context.task.workspaceId).find((task) => task.id === context.task.id);
      const claimedAttempt = readReviewDeliveryAttempt(claimed?.metadata?.reviewDeliveryAttempt);
      if (claimedAttempt && claimedAttempt.id !== attempt.id) return;
      const metadata = { ...(claimed?.metadata || current.metadata || {}) };
      delete (metadata as Record<string, unknown>).deliveryClaim;
      delete (metadata as Record<string, unknown>).reviewDeliveryAttempt;
      const restoredTask = updateTask(context.task.id, {
        status: previousStatus,
        delegationState: previousDelegationState,
        metadata,
      });
      const restoredRun = updateTaskRun(context.taskRun.id, {
        metadata: { reviewDeliveryAttempt: null },
      });
      if (!restoredTask || !restoredRun) {
        throw new Error('Could not restore the review after approval stopped before delivery.');
      }
    },
  };
}

export function executeReviewChangeRequest(input: {
  workspaceId: string;
  automationId: string;
  runId: string;
  actor: ReviewActor;
  note: string;
  dryRun?: boolean;
  onBroadcast?: (context: ReviewActionContext, eventType: string) => void;
}): RequestChangesResult {
  const context = findAutomationReviewContext(input.workspaceId, input.automationId, input.runId);
  if ('error' in context) return toFailure(context.error);

  try {
    const result = requestAutomationChanges({
      task: context.task,
      taskRun: context.taskRun,
      reviewer: input.actor.label,
      note: input.note,
    });

    const deniedLedgerEvent = {
      workspaceId: input.workspaceId,
      workflowId: inferWorkflowIdFromAutomation(context.automation),
      automationId: context.automation.id,
      taskId: context.task.id,
      taskRunId: context.taskRun.id,
      type: 'approval_denied' as const,
      summary: 'Reviewer requested changes before delivery.',
      metadata: { reviewRequest: result.reviewRequest, actor: actorMetadata(input.actor) },
    };

    if (input.dryRun) {
      return {
        status: 'ok',
        dryRun: true,
        context,
        reviewRequest: result.reviewRequest as unknown as Record<string, unknown>,
        taskPatch: result.taskPatch,
        runPatch: result.runPatch,
        ledgerEvents: [deniedLedgerEvent],
      };
    }

    const task = applyReviewTaskPatch(context.task.id, context.task.metadata, result.taskPatch);
    const taskRun = updateTaskRun(context.taskRun.id, result.runPatch);
    appendWorkflowLedgerEvent(deniedLedgerEvent);
    input.onBroadcast?.(context, 'automation_review_changes_requested');

    return {
      status: 'ok',
      dryRun: false,
      context,
      reviewRequest: result.reviewRequest as unknown as Record<string, unknown>,
      task,
      taskRun,
      taskPatch: result.taskPatch,
      runPatch: result.runPatch,
      ledgerEvents: [deniedLedgerEvent],
    };
  } catch (error) {
    return {
      status: 'invalid',
      error: error instanceof Error ? error.message : 'Could not request changes',
      missionName: context.automation.name,
      resolved: readResolvedReviewSummary(context.task, context.taskRun),
    };
  }
}

/** Shared HTTP mapping so both routes answer identically. */
export function reviewFailureStatusCode(failure: ReviewActionFailure): number {
  switch (failure.status) {
    case 'not_found': return 404;
    case 'fabricated_evidence': return 409;
    case 'scan_failed': return 500;
    case 'delivery_not_ready': return 409;
    case 'insufficient_credits': return 402;
    case 'failed': return 409;
    default: return 400;
  }
}

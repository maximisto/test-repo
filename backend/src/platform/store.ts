import path from 'path';
import { calculateAvailableCredits, createCreditLedgerEntry, normalizeCreditDelta, summarizeCreditLedger } from './ledger';
import { readJsonFile, updateJsonFile, writeJsonFile } from './jsonStore';
import type {
  AgentRole,
  CreditLedgerEntry,
  CreditSource,
  DelegationPlan,
  ModelTier,
  TaskKind,
  TaskRecord,
  TaskRunRecord,
  TaskRunStatus,
  TaskStatus,
} from './types';

const TASKS_FILE = path.join(process.cwd(), 'platform-tasks.json');
const TASK_RUNS_FILE = path.join(process.cwd(), 'platform-task-runs.json');
const LEDGER_FILE = path.join(process.cwd(), 'platform-credit-ledger.json');
const DEFAULT_CREDIT_HOLD_TTL_MS = 15 * 60 * 1000;
const TERMINAL_CREDIT_HOLD_STATUSES = new Set(['released', 'settled', 'expired']);

interface JsonStoreShape {
  tasks: TaskRecord[];
  taskRuns: TaskRunRecord[];
  ledger: CreditLedgerEntry[];
}

export function getPlatformState(): JsonStoreShape {
  return {
    tasks: readJsonFile<TaskRecord[]>(TASKS_FILE, []),
    taskRuns: readJsonFile<TaskRunRecord[]>(TASK_RUNS_FILE, []),
    ledger: readJsonFile<CreditLedgerEntry[]>(LEDGER_FILE, []),
  };
}

function savePlatformState(state: Partial<JsonStoreShape>) {
  if (state.tasks) writeJsonFile(TASKS_FILE, state.tasks);
  if (state.taskRuns) writeJsonFile(TASK_RUNS_FILE, state.taskRuns);
  if (state.ledger) writeJsonFile(LEDGER_FILE, state.ledger);
}

function createStoreId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readCreditHoldId(entry: CreditLedgerEntry) {
  const value = entry.metadata?.holdId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readCreditHoldStatus(entry: CreditLedgerEntry) {
  const value = entry.metadata?.holdStatus;
  return typeof value === 'string' ? value : undefined;
}

function readCreditHoldCredits(entry: CreditLedgerEntry) {
  const value = entry.metadata?.heldCredits;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function readCreditHoldExpiresAt(entry: CreditLedgerEntry) {
  const value = entry.metadata?.expiresAt;
  if (typeof value !== 'string') return Number.NaN;
  return Date.parse(value);
}

function listActiveHoldEntries(entries: CreditLedgerEntry[], now = new Date()) {
  const nowMs = now.getTime();
  const terminalHoldIds = new Set<string>();

  for (const entry of entries) {
    const holdId = readCreditHoldId(entry);
    if (!holdId) continue;
    if (TERMINAL_CREDIT_HOLD_STATUSES.has(readCreditHoldStatus(entry) || '')) {
      terminalHoldIds.add(holdId);
    }
  }

  return entries.filter((entry) => {
    if (entry.source !== 'credit_hold') return false;
    const holdId = readCreditHoldId(entry);
    if (!holdId || terminalHoldIds.has(holdId)) return false;
    if (readCreditHoldStatus(entry) !== 'active') return false;
    if (readCreditHoldCredits(entry) <= 0) return false;
    const expiresAt = readCreditHoldExpiresAt(entry);
    return Number.isFinite(expiresAt) && expiresAt > nowMs;
  });
}

function findCreditHold(entries: CreditLedgerEntry[], holdId: string) {
  const hold = entries.find((entry) => readCreditHoldId(entry) === holdId && entry.source === 'credit_hold');
  if (!hold) throw new Error(`Unknown credit hold: ${holdId}`);
  return hold;
}

function assertCreditHoldOpen(entries: CreditLedgerEntry[], holdId: string) {
  const terminal = entries.find((entry) =>
    readCreditHoldId(entry) === holdId &&
    TERMINAL_CREDIT_HOLD_STATUSES.has(readCreditHoldStatus(entry) || '')
  );
  if (terminal) {
    throw new Error(`Credit hold ${holdId} is already settled or released.`);
  }
}

export function ensureWorkspaceCredits(workspaceId: string) {
  const entries = getPlatformState().ledger.filter((entry) => entry.workspaceId === workspaceId);
  const summary = summarizeCreditLedger(entries);
  return { ...summary, workspaceId };
}

export function createTask(input: {
  workspaceId: string;
  title: string;
  description?: string;
  kind: TaskKind;
  priority?: TaskRecord['priority'];
  autonomyMode?: TaskRecord['autonomyMode'];
  assigneeRole?: AgentRole;
  ownerRole?: AgentRole;
  executorRole?: AgentRole;
  reviewerRole?: AgentRole;
  supportingRoles?: AgentRole[];
  delegationState?: TaskRecord['delegationState'];
  delegationPlanId?: string;
  delegationPlan?: DelegationPlan;
  budgetCredits?: number;
  metadata?: Record<string, unknown>;
}): TaskRecord {
  const now = new Date().toISOString();
  const task: TaskRecord = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: input.workspaceId,
    title: input.title,
    description: input.description,
    kind: input.kind,
    status: 'queued',
    priority: input.priority || 'medium',
    autonomyMode: input.autonomyMode,
    assigneeRole: input.assigneeRole,
    ownerRole: input.ownerRole,
    executorRole: input.executorRole,
    reviewerRole: input.reviewerRole,
    supportingRoles: input.supportingRoles,
    delegationState: input.delegationState || (input.delegationPlan ? 'planned' : undefined),
    delegationPlanId: input.delegationPlanId || input.delegationPlan?.id,
    budgetCredits: input.budgetCredits,
    createdAt: now,
    updatedAt: now,
    metadata: {
      ...input.metadata,
      delegationPlan: input.delegationPlan || undefined,
    },
  };

  updateJsonFile<TaskRecord[]>(TASKS_FILE, [], (tasks) => [task, ...tasks]);
  return task;
}

export function updateTask(taskId: string, patch: Partial<TaskRecord>) {
  let updatedTask: TaskRecord | null = null;

  updateJsonFile<TaskRecord[]>(TASKS_FILE, [], (tasks) => tasks.map((task) => {
    if (task.id !== taskId) return task;
    updatedTask = { ...task, ...patch, updatedAt: new Date().toISOString() };
    return updatedTask;
  }));

  return updatedTask;
}

export function createTaskRun(input: {
  workspaceId: string;
  taskId: string;
  agentRole: AgentRole;
  ownerRole?: AgentRole;
  executorRole?: AgentRole;
  reviewerRole?: AgentRole;
  supportingRoles?: AgentRole[];
  modelTier: ModelTier;
  estimatedCredits: number;
  delegationPlan?: DelegationPlan;
  metadata?: Record<string, unknown>;
}): TaskRunRecord {
  const taskRun: TaskRunRecord = {
    id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    agentRole: input.agentRole,
    ownerRole: input.ownerRole,
    executorRole: input.executorRole,
    reviewerRole: input.reviewerRole,
    supportingRoles: input.supportingRoles,
    modelTier: input.modelTier,
    status: 'running',
    estimatedCredits: input.estimatedCredits,
    startedAt: new Date().toISOString(),
    metadata: {
      ...input.metadata,
      delegationPlan: input.delegationPlan || undefined,
    },
  };

  updateJsonFile<TaskRunRecord[]>(TASK_RUNS_FILE, [], (taskRuns) => [taskRun, ...taskRuns]);
  return taskRun;
}

export function finalizeTaskRun(taskRunId: string, patch: {
  status: TaskRunStatus;
  actualCredits?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}) {
  let updatedRun: TaskRunRecord | null = null;

  updateJsonFile<TaskRunRecord[]>(TASK_RUNS_FILE, [], (taskRuns) => taskRuns.map((run) => {
    if (run.id !== taskRunId) return run;
    updatedRun = {
      ...run,
      ...patch,
      finishedAt: new Date().toISOString(),
      metadata: { ...run.metadata, ...patch.metadata },
    };
    return updatedRun;
  }));

  return updatedRun;
}

/**
 * In-flight runs live only in process memory, so a process death strands
 * their records in running/retrying forever. Called once at boot to fail
 * them.
 *
 * The stamped error states FACTS, never a diagnosis. The sweep knows
 * exactly one thing: the run had not finished by the time this boot found
 * it. It does not know why — a crash, a deploy, an OOM kill, or a swallowed
 * error that abandoned the run mid-uptime all look identical from here. The
 * previous message asserted "interrupted by a backend restart", which after
 * the 2026-07-30 incident read as the (long-fixed) 512MB PM2 cap and
 * dressed every stranded run in a stale explanation, including runs a code
 * bug had orphaned while the process kept running. Real causes belong where
 * they are knowable: the step that died records its own error at failure
 * time, and only a run that never got that chance lands here.
 */
export function sweepOrphanedTaskRuns(bootTime: Date) {
  const swept: TaskRunRecord[] = [];

  updateJsonFile<TaskRunRecord[]>(TASK_RUNS_FILE, [], (taskRuns) => taskRuns.map((run) => {
    if (run.status !== 'running' && run.status !== 'retrying') return run;
    if (new Date(run.startedAt).getTime() >= bootTime.getTime()) return run;
    const updated: TaskRunRecord = {
      ...run,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error:
        'This run never finished: the backend found it still marked in progress at startup. Its actual failure cause was not recorded. Safe to rerun.',
      metadata: {
        ...run.metadata,
        orphanSweptAtBoot: bootTime.toISOString(),
        orphanSweptFromStatus: run.status,
      },
    };
    swept.push(updated);
    return updated;
  }));

  return swept;
}

/**
 * Runs get failed by `sweepOrphanedTaskRuns`; this closes the tasks those runs
 * strand. Field observation (2026-08-03): two tenant tasks sat in `running`
 * forever — their runs had succeeded, but the close-out never landed, so the
 * mission surface showed live work that did not exist. A boot finding a
 * `running` task whose runs are all terminal closes it to the newest run's
 * outcome. Deliberately NOT resurrected to `waiting_review`: re-opening an old
 * gate at boot would inject a stale approvable — the exact disease
 * supersession cures. The run truth wins; nothing else.
 */
export function sweepZombieTasks(bootTime: Date) {
  const taskRuns = readJsonFile<TaskRunRecord[]>(TASK_RUNS_FILE, []);
  const runsByTask = new Map<string, TaskRunRecord[]>();
  for (const run of taskRuns) {
    const list = runsByTask.get(run.taskId);
    if (list) list.push(run);
    else runsByTask.set(run.taskId, [run]);
  }
  const activeRunStatuses = new Set<TaskRunStatus>(['queued', 'running', 'retrying']);
  const swept: TaskRecord[] = [];

  updateJsonFile<TaskRecord[]>(TASKS_FILE, [], (tasks) => tasks.map((task) => {
    if (task.status !== 'running') return task;
    if (new Date(task.updatedAt || task.createdAt).getTime() >= bootTime.getTime()) return task;
    const runs = runsByTask.get(task.id) || [];
    // A running task with no runs at all: no run will ever close it, and the
    // scheduler never resumes it, so it fails honestly rather than showing
    // live work that does not exist (operator ruling 2026-08-04).
    if (runs.length === 0) {
      const failed: TaskRecord = {
        ...task,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        metadata: {
          ...task.metadata,
          zombieSweptAt: new Date().toISOString(),
          zombieSweptReason: 'no_runs',
        },
      };
      swept.push(failed);
      return failed;
    }
    if (runs.some((run) => activeRunStatuses.has(run.status))) return task;
    const newest = runs.reduce((left, right) =>
      Date.parse(right.startedAt) >= Date.parse(left.startedAt) ? right : left,
    );
    const updated: TaskRecord = {
      ...task,
      status: mapTaskRunToStatus(newest.status),
      updatedAt: new Date().toISOString(),
      metadata: {
        ...task.metadata,
        zombieSweptAt: new Date().toISOString(),
        zombieSweptFromRun: newest.id,
      },
    };
    swept.push(updated);
    return updated;
  }));

  return swept;
}

export function updateTaskRun(taskRunId: string, patch: Partial<Omit<TaskRunRecord, 'id' | 'workspaceId' | 'taskId' | 'startedAt'>>) {
  let updatedRun: TaskRunRecord | null = null;

  updateJsonFile<TaskRunRecord[]>(TASK_RUNS_FILE, [], (taskRuns) => taskRuns.map((run) => {
    if (run.id !== taskRunId) return run;
    updatedRun = {
      ...run,
      ...patch,
      metadata: patch.metadata ? { ...run.metadata, ...patch.metadata } : run.metadata,
    };
    return updatedRun;
  }));

  return updatedRun;
}

export function addLedgerEntry(input: {
  workspaceId: string;
  source: CreditSource;
  deltaCredits: number;
  referenceType?: CreditLedgerEntry['referenceType'];
  referenceId?: string;
  note?: string;
  metadata?: Record<string, unknown>;
}): CreditLedgerEntry {
  const createdEntryRef: { value?: CreditLedgerEntry } = {};

  updateJsonFile<CreditLedgerEntry[]>(LEDGER_FILE, [], (entries) => {
    const workspaceEntries = entries.filter((entry) => entry.workspaceId === input.workspaceId);
    const summary = summarizeCreditLedger(workspaceEntries);
    const balanceAfterCredits = summary.balanceCredits + Math.trunc(input.deltaCredits);
    createdEntryRef.value = createCreditLedgerEntry({
      workspaceId: input.workspaceId,
      direction: input.deltaCredits >= 0 ? 'grant' : 'debit',
      source: input.source,
      deltaCredits: input.deltaCredits,
      balanceAfterCredits,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      note: input.note,
      metadata: input.metadata,
    });

    return [...entries, createdEntryRef.value];
  });

  if (!createdEntryRef.value) throw new Error('Could not add ledger entry.');
  return createdEntryRef.value;
}

export function getWorkspaceCreditReserve(workspaceId: string, now = new Date()) {
  const state = getPlatformState();
  const workspaceEntries = state.ledger.filter((entry) => entry.workspaceId === workspaceId);
  const summary = summarizeCreditLedger(workspaceEntries);
  const reservedCredits = listActiveHoldEntries(workspaceEntries, now)
    .reduce((total, entry) => total + readCreditHoldCredits(entry), 0);

  return calculateAvailableCredits(workspaceId, summary.balanceCredits, reservedCredits);
}

export function acquireCreditHold(input: {
  workspaceId: string;
  amountCredits: number;
  referenceType?: CreditLedgerEntry['referenceType'];
  referenceId?: string;
  note?: string;
  metadata?: Record<string, unknown>;
  holdId?: string;
  now?: Date;
  ttlMs?: number;
}) {
  const amountCredits = Math.max(0, normalizeCreditDelta(input.amountCredits));
  if (amountCredits <= 0) {
    throw new Error('Credit hold amount must be greater than zero.');
  }

  const now = input.now || new Date();
  const holdId = input.holdId || createStoreId('hold');
  const expiresAt = new Date(now.getTime() + Math.max(1, input.ttlMs || DEFAULT_CREDIT_HOLD_TTL_MS)).toISOString();
  type CreditHoldResult = {
    holdId: string;
    heldCredits: number;
    expiresAt: string;
    availableCredits: number;
    entry: CreditLedgerEntry;
  };
  const resultRef: { value?: CreditHoldResult } = {};

  updateJsonFile<CreditLedgerEntry[]>(LEDGER_FILE, [], (entries) => {
    const workspaceEntries = entries.filter((entry) => entry.workspaceId === input.workspaceId);
    const summary = summarizeCreditLedger(workspaceEntries);
    const reservedCredits = listActiveHoldEntries(workspaceEntries, now)
      .reduce((total, entry) => total + readCreditHoldCredits(entry), 0);
    const reserve = calculateAvailableCredits(input.workspaceId, summary.balanceCredits, reservedCredits);
    if (reserve.availableCredits < amountCredits) {
      throw new Error(
        `Insufficient credits. ${reserve.availableCredits} available, ${amountCredits} required.`
      );
    }

    const entry = createCreditLedgerEntry({
      workspaceId: input.workspaceId,
      direction: 'debit',
      source: 'credit_hold',
      deltaCredits: 0,
      balanceAfterCredits: summary.balanceCredits,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      note: input.note || `Held ${amountCredits} credits`,
      metadata: {
        ...(input.metadata || {}),
        holdId,
        holdStatus: 'active',
        heldCredits: amountCredits,
        expiresAt,
      },
      createdAt: now.toISOString(),
    });

    resultRef.value = {
      holdId,
      heldCredits: amountCredits,
      expiresAt,
      availableCredits: Math.max(0, reserve.availableCredits - amountCredits),
      entry,
    };

    return [...entries, entry];
  });

  if (!resultRef.value) throw new Error('Could not acquire credit hold.');
  return resultRef.value;
}

export function releaseCreditHold(
  holdId: string,
  input: {
    workspaceId: string;
    referenceType?: CreditLedgerEntry['referenceType'];
    referenceId?: string;
    note?: string;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now || new Date();
  const releasedEntryRef: { value?: CreditLedgerEntry } = {};

  updateJsonFile<CreditLedgerEntry[]>(LEDGER_FILE, [], (entries) => {
    const workspaceEntries = entries.filter((entry) => entry.workspaceId === input.workspaceId);
    const hold = findCreditHold(workspaceEntries, holdId);
    assertCreditHoldOpen(workspaceEntries, holdId);
    const summary = summarizeCreditLedger(workspaceEntries);
    const heldCredits = readCreditHoldCredits(hold);

    releasedEntryRef.value = createCreditLedgerEntry({
      workspaceId: input.workspaceId,
      direction: 'grant',
      source: 'credit_hold',
      deltaCredits: 0,
      balanceAfterCredits: summary.balanceCredits,
      referenceType: input.referenceType || hold.referenceType,
      referenceId: input.referenceId || hold.referenceId,
      note: input.note || `Released ${heldCredits} held credits`,
      metadata: {
        ...(input.metadata || {}),
        holdId,
        holdStatus: 'released',
        heldCredits,
        releasedAt: now.toISOString(),
      },
      createdAt: now.toISOString(),
    });

    return [...entries, releasedEntryRef.value];
  });

  if (!releasedEntryRef.value) throw new Error(`Could not release credit hold: ${holdId}`);
  return releasedEntryRef.value;
}

export function settleCreditHold(
  holdId: string,
  input: {
    workspaceId: string;
    actualCredits: number;
    source: Exclude<CreditSource, 'credit_hold'>;
    referenceType?: CreditLedgerEntry['referenceType'];
    referenceId?: string;
    note?: string;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
) {
  const actualCredits = Math.max(0, normalizeCreditDelta(input.actualCredits));
  const now = input.now || new Date();
  const settledEntryRef: { value?: CreditLedgerEntry } = {};

  updateJsonFile<CreditLedgerEntry[]>(LEDGER_FILE, [], (entries) => {
    const workspaceEntries = entries.filter((entry) => entry.workspaceId === input.workspaceId);
    const hold = findCreditHold(workspaceEntries, holdId);
    assertCreditHoldOpen(workspaceEntries, holdId);
    const heldCredits = readCreditHoldCredits(hold);
    const summary = summarizeCreditLedger(workspaceEntries);
    const reservedForOtherHolds = listActiveHoldEntries(workspaceEntries, now)
      .filter((entry) => readCreditHoldId(entry) !== holdId)
      .reduce((total, entry) => total + readCreditHoldCredits(entry), 0);
    const spendableCredits = Math.max(0, summary.balanceCredits - reservedForOtherHolds);
    if (actualCredits > spendableCredits) {
      throw new Error(
        `Insufficient credits. ${spendableCredits} available, ${actualCredits} required.`
      );
    }

    settledEntryRef.value = createCreditLedgerEntry({
      workspaceId: input.workspaceId,
      direction: actualCredits > 0 ? 'debit' : 'grant',
      source: input.source,
      deltaCredits: -actualCredits,
      balanceAfterCredits: summary.balanceCredits - actualCredits,
      referenceType: input.referenceType || hold.referenceType,
      referenceId: input.referenceId || hold.referenceId,
      note: input.note || `Settled ${actualCredits} credits from hold`,
      metadata: {
        ...(input.metadata || {}),
        holdId,
        holdStatus: 'settled',
        heldCredits,
        actualCredits,
        settledAt: now.toISOString(),
      },
      createdAt: now.toISOString(),
    });

    return [...entries, settledEntryRef.value];
  });

  if (!settledEntryRef.value) throw new Error(`Could not settle credit hold: ${holdId}`);
  return settledEntryRef.value;
}

/** What `settleCreditHoldWithOverrun` did, so the caller can report it honestly. */
export interface CreditHoldOverrunSettlement {
  entry: CreditLedgerEntry;
  /** What was actually debited — never more than the workspace could cover. */
  settledCredits: number;
  /** What the run's work actually cost. */
  requestedCredits: number;
  /** `requestedCredits - settledCredits`; 0 on a normal settlement. */
  overrunCredits: number;
  /** True when the run cost more than the workspace could pay for. */
  overran: boolean;
}

/**
 * Settle a hold that may have overrun its estimate, without throwing.
 *
 * `settleCreditHold` refuses an actual cost above the spendable balance. That is
 * the right rule for a caller that can still choose not to do the work — but
 * `runAutomation` calls it *after* the run has already spent the money on model
 * and tool calls, so a throw there bought nothing and cost everything: the
 * exception unwound into a catch block that re-finalised the run and replaced
 * its artifacts with a bare error note, erasing completed work the customer had
 * already paid for.
 *
 * So this variant debits `min(actualCredits, spendable)` and reports the
 * shortfall instead of rejecting. The workspace is never over-debited into a
 * negative balance, the hold is always closed exactly once, and the caller
 * still learns the run overran so it can mark it failed and say why.
 *
 * The spendable calculation stays inside `updateJsonFile` so it is read and
 * written atomically — computing it in the caller would race another hold.
 */
export function settleCreditHoldWithOverrun(
  holdId: string,
  input: {
    workspaceId: string;
    actualCredits: number;
    source: Exclude<CreditSource, 'credit_hold'>;
    referenceType?: CreditLedgerEntry['referenceType'];
    referenceId?: string;
    note?: string;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
): CreditHoldOverrunSettlement {
  const requestedCredits = Math.max(0, normalizeCreditDelta(input.actualCredits));
  const now = input.now || new Date();
  const resultRef: { value?: CreditHoldOverrunSettlement } = {};

  updateJsonFile<CreditLedgerEntry[]>(LEDGER_FILE, [], (entries) => {
    const workspaceEntries = entries.filter((entry) => entry.workspaceId === input.workspaceId);
    const hold = findCreditHold(workspaceEntries, holdId);
    assertCreditHoldOpen(workspaceEntries, holdId);
    const heldCredits = readCreditHoldCredits(hold);
    const summary = summarizeCreditLedger(workspaceEntries);
    const reservedForOtherHolds = listActiveHoldEntries(workspaceEntries, now)
      .filter((entry) => readCreditHoldId(entry) !== holdId)
      .reduce((total, entry) => total + readCreditHoldCredits(entry), 0);
    const spendableCredits = Math.max(0, summary.balanceCredits - reservedForOtherHolds);
    const settledCredits = Math.min(requestedCredits, spendableCredits);
    const overrunCredits = requestedCredits - settledCredits;

    const entry = createCreditLedgerEntry({
      workspaceId: input.workspaceId,
      direction: settledCredits > 0 ? 'debit' : 'grant',
      source: input.source,
      deltaCredits: -settledCredits,
      balanceAfterCredits: summary.balanceCredits - settledCredits,
      referenceType: input.referenceType || hold.referenceType,
      referenceId: input.referenceId || hold.referenceId,
      note:
        input.note
        || (overrunCredits > 0
          ? `Settled ${settledCredits} of ${requestedCredits} credits from hold (overran by ${overrunCredits})`
          : `Settled ${settledCredits} credits from hold`),
      metadata: {
        ...(input.metadata || {}),
        holdId,
        holdStatus: 'settled',
        heldCredits,
        actualCredits: settledCredits,
        requestedCredits,
        overrunCredits,
        settledAt: now.toISOString(),
      },
      createdAt: now.toISOString(),
    });

    resultRef.value = {
      entry,
      settledCredits,
      requestedCredits,
      overrunCredits,
      overran: overrunCredits > 0,
    };

    return [...entries, entry];
  });

  if (!resultRef.value) throw new Error(`Could not settle credit hold: ${holdId}`);
  return resultRef.value;
}

export function getWorkspaceLedgerSummary(workspaceId: string) {
  const state = getPlatformState();
  const entries = state.ledger.filter((entry) => entry.workspaceId === workspaceId);
  return summarizeCreditLedger(entries);
}

export function listTasks(workspaceId: string) {
  return getPlatformState().tasks.filter((task) => task.workspaceId === workspaceId);
}

export function listTaskRuns(workspaceId: string) {
  return getPlatformState().taskRuns.filter((run) => run.workspaceId === workspaceId);
}

export function listLedgerEntries(workspaceId: string) {
  return getPlatformState().ledger
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function mapTaskRunToStatus(status: TaskRunStatus): TaskStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'retrying':
      return 'blocked';
    default:
      return 'queued';
  }
}

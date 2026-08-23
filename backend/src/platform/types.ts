export type CreditSource =
  | 'monthly_subscription'
  | 'top_up'
  | 'referral_bonus'
  | 'task_run'
  | 'automation_run'
  | 'credit_hold'
  | 'manual_adjustment'
  | 'refund'
  | 'promo'
  | 'trial_grant';

export type CreditDirection = 'grant' | 'debit';
export type ModelTier = 'micro' | 'default' | 'hard' | 'critical' | 'ops';
export type IntelligenceBand = 'micro' | 'default' | 'hard' | 'critical';
export type WorkerLaneType = 'core' | 'elastic';
export type AutomationExecutionMode = 'recommended' | 'custom';
export type AutomationOptimizationGoal = 'balanced' | 'cost_saver' | 'quality_first';
export type AutomationReviewPolicy = 'lean' | 'standard' | 'strict';
export type AgentRole =
  | 'nexus'
  | 'researcher'
  | 'operator'
  | 'engineer'
  | 'reviewer'
  | 'analyst'
  | 'scheduler'
  | 'writer'
  | 'messenger'
  | 'monitor';
export type TaskKind = 'chat' | 'research' | 'analysis' | 'engineering' | 'automation' | 'message' | 'report' | 'review' | 'scheduling';
export type TaskStatus = 'queued' | 'running' | 'waiting_review' | 'blocked' | 'completed' | 'failed' | 'canceled';
export type TaskRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'retrying';
export type UsageEventKind =
  | 'task_created'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_reviewed'
  | 'automation_scheduled'
  | 'automation_triggered'
  | 'automation_completed'
  | 'automation_failed'
  | 'tool_called'
  | 'model_routed'
  | 'delegation_planned'
  | 'delegation_assigned'
  | 'delegation_handed_off'
  | 'delegation_reviewed'
  | 'credit_granted'
  | 'credit_spent'
  | 'credit_reserved'
  | 'credit_released'
  | 'referral_redeemed';

export interface CreditLedgerEntry {
  id: string;
  workspaceId: string;
  direction: CreditDirection;
  source: CreditSource;
  deltaCredits: number;
  balanceAfterCredits: number;
  referenceType?: 'subscription' | 'task' | 'automation' | 'referral' | 'manual' | 'promotion' | 'beta_trial';
  referenceId?: string;
  note?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface CreditLedgerSummary {
  workspaceId: string;
  balanceCredits: number;
  grantedCredits: number;
  spentCredits: number;
  netCredits: number;
  updatedAt: string;
}

export interface CreditReserve {
  workspaceId: string;
  reservedCredits: number;
  availableCredits: number;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  workspaceId: string;
  objectiveId?: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  kind: TaskKind;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  autonomyMode?: 'autonomous' | 'cautious' | 'supervised';
  budgetCredits?: number;
  assigneeRole?: AgentRole;
  ownerRole?: AgentRole;
  executorRole?: AgentRole;
  reviewerRole?: AgentRole;
  supportingRoles?: AgentRole[];
  delegationState?: 'unassigned' | 'planned' | 'delegated' | 'in_progress' | 'review' | 'completed';
  delegationPlanId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface TaskDelegationStep {
  id: string;
  role: AgentRole;
  objective: string;
  status: 'planned' | 'running' | 'completed' | 'blocked';
}

export interface TaskDelegationPlan {
  mode: 'solo' | 'delegated';
  primaryRole: AgentRole;
  supportingRoles: AgentRole[];
  rationale: string;
  steps: TaskDelegationStep[];
}

export interface WorkerDefinition {
  role: AgentRole;
  label: string;
  laneType: WorkerLaneType;
  preferredBand: IntelligenceBand;
  fallbackBands: IntelligenceBand[];
  summary: string;
}

export interface WorkerSnapshotCard {
  role: AgentRole;
  label: string;
  laneType: WorkerLaneType;
  assignedRole: AgentRole;
  band: IntelligenceBand;
  modelLabel: string;
  status: 'active' | 'standby';
  summary: string;
  reason: string;
}

export interface WorkerTopologySnapshot {
  version: 'violema-10';
  primaryRole: AgentRole;
  primaryBand: IntelligenceBand;
  coreWorkers: AgentRole[];
  elasticLanes: AgentRole[];
  activeRoles: AgentRole[];
  bandByRole: Partial<Record<AgentRole, IntelligenceBand>>;
  workers: WorkerSnapshotCard[];
  summary: string;
}

export interface AutomationExecutionPolicy {
  mode: AutomationExecutionMode;
  optimizationGoal: AutomationOptimizationGoal;
  reviewPolicy: AutomationReviewPolicy;
  maxElasticLanes: number;
}

export type AutomationStepKind = 'search' | 'query' | 'summarize' | 'deliver' | 'capture' | 'analyze' | 'note';
export type AutomationStepStatus = 'planned' | 'running' | 'succeeded' | 'failed' | 'skipped';

/**
 * How much a step's failure costs the run.
 *
 * `critical` — the step carries the run's evidence integrity. A required source
 * failed, a required query failed, or the delivery itself failed. If the truth
 * of the output is compromised, nothing may be delivered. This is the trust
 * floor and it does not move.
 *
 * `auxiliary` — the step is a side effect whose failure does not make the
 * output less true. The archival library WRITE is the canonical case: the memo
 * was drafted from live reads that succeeded, so failing to file a copy of it
 * is bookkeeping lost, not evidence lost. The run stays deliverable and the
 * failure is surfaced as a run warning instead of a block.
 *
 * The default everywhere is `critical`. A step earns `auxiliary` by being named
 * explicitly in `resolveAutomationStepSeverity`; anything unrecognised — an
 * older persisted record, a step kind nobody has classified yet — blocks.
 */
export type AutomationStepSeverity = 'critical' | 'auxiliary';

export interface AutomationStepDeliveryTarget {
  channel: 'slack' | 'email';
  target: string;
}

export interface PersistedAutomationStep {
  id: string;
  kind: AutomationStepKind;
  title?: string;
  objective: string;
  inputs?: Record<string, unknown>;
  deliveryTarget?: AutomationStepDeliveryTarget | null;
}

export interface AutomationStepDefinition {
  id: string;
  kind: AutomationStepKind;
  title: string;
  objective: string;
  assignedRole: AgentRole;
  directiveMode?: 'cheaper' | 'review' | 'promote';
  directivePhases?: AutomationStepKind[];
  modelTier?: ModelTier;
  estimatedCredits?: number;
  dependsOnStepIds?: string[];
  toolName?: 'web_search' | 'query_data' | 'browser_screenshot' | 'send_message' | 'generate_text';
  inputs?: Record<string, unknown>;
  deliveryTarget?: AutomationStepDeliveryTarget | null;
  /** Omitted means `critical`. Set by `resolveAutomationStepSeverity` at plan time. */
  stepSeverity?: AutomationStepSeverity;
}

export interface AutomationGenerationCall {
  id: string;
  stepId: string;
  purpose: string;
  modelTier: ModelTier;
  /** Physical route/retry identity; absent on records written before attempt accounting. */
  routeIndex?: number;
  attemptNumber?: number;
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** Maximum token credits authorized immediately before this provider request. */
  authorizedTokenCredits?: number;
  /** `prepared` is authorized and durable, but no provider request began. */
  status: 'prepared' | 'running' | 'succeeded' | 'rejected' | 'failed';
  maxOutputTokens: number;
  promptBytes: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    provider?: string;
    model?: string;
    baseUrl?: string;
  };
  error?: string;
}

export interface AutomationGenerationProjection {
  stepId: string;
  purpose: string;
  modelTier: ModelTier;
  /** Byte-safe authorization bound. */
  promptBytes: number;
  /** Hard provider output allowance. */
  maxOutputTokens: number;
  /** Expected serialized envelope used by the forecast, never by the guard. */
  estimatedPromptBytes?: number;
  estimatedMaxOutputTokens?: number;
  includeInEstimate?: boolean;
}

export interface AutomationToolAttempt {
  id: string;
  operation: string;
  mutating: boolean;
  /**
   * `prepared` is a durable authorization intent recorded before a mutating
   * provider request begins. The sender promotes it to `started` at the exact
   * external boundary, so crash recovery can distinguish a safe pre-send
   * journal from a request whose remote outcome may be unknown.
   */
  status: 'prepared' | 'started' | 'succeeded' | 'failed' | 'outcome_unknown';
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface AutomationStepExecution {
  stepId: string;
  kind: AutomationStepKind;
  title: string;
  assignedRole: AgentRole;
  directiveMode?: 'cheaper' | 'review' | 'promote';
  directivePhases?: AutomationStepKind[];
  modelTier?: ModelTier;
  modelSource?: 'server_default' | 'workspace_override' | 'workspace_token';
  modelSourceLabel?: string;
  status: AutomationStepStatus;
  /**
   * Stamped by the executor from the step definition, defaulting to `critical`.
   * Records written before severity existed omit it and are read as critical.
   */
  stepSeverity?: AutomationStepSeverity;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  estimatedCredits?: number;
  actualCredits?: number;
  toolCalls?: number;
  artifactCount?: number;
  durationMs?: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    provider?: string;
    model?: string;
    baseUrl?: string;
  };
  /** Every provider generation owned by this step, including rejected output. */
  generationCalls?: AutomationGenerationCall[];
  /** Durable boundary journal for non-model integrations and outward actions. */
  toolAttempts?: AutomationToolAttempt[];
  charge?: {
    actualCredits: number;
    tokenCredits: number;
    toolCredits: number;
    artifactCredits: number;
    durationCredits: number;
    complexityCredits: number;
    baseCredits: number;
    rationale: string[];
  };
  output?: Record<string, unknown>;
  artifactKind?: string;
  /**
   * Where this step's data came from. Optional and additive — older ledger
   * records simply omit it. 'none' means the step produced no external data.
   */
  dataOrigin?: 'live' | 'simulated' | 'none';
  /**
   * Named warnings from a step that still succeeded — e.g. a folder-drop
   * share problem the account library surfaced during a read. Optional and
   * additive; older ledger records simply omit it. Distinct from `error`,
   * which is reserved for a step that failed.
   */
  warnings?: string[];
}

export interface AutomationRolePlan {
  primaryRole: AgentRole;
  supportingRoles: AgentRole[];
  rationale: string;
  elasticLanes?: AgentRole[];
  primaryBand?: IntelligenceBand;
}

export interface AutomationExecutionPlan {
  primaryRole: AgentRole;
  supportingRoles: AgentRole[];
  rationale: string;
  elasticLanes?: AgentRole[];
  primaryBand?: IntelligenceBand;
  suggestedModelTier: ModelTier;
  complexity: 'low' | 'medium' | 'high';
  estimatedToolCalls: number;
  /** Expected-utilization forecast shown to operators. */
  estimatedCredits: number;
  /** Initial hold envelope. Unbudgeted runs extend it at exact call boundaries. */
  authorizationCredits: number;
  /**
   * Single-route, single-attempt hard envelope used by operator-triggered runs.
   * Reserving it before acknowledging the request makes the synchronous
   * response authoritative without multiplying every call by the background
   * retry/fallback policy.
   */
  manualAuthorizationCredits: number;
  generationProjections: AutomationGenerationProjection[];
  steps: AutomationStepDefinition[];
  topology: WorkerTopologySnapshot;
}

export type MissionStatus =
  | 'planned'
  | 'running'
  | 'waiting_review'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'canceled';

export type MissionReviewPolicy = 'none' | 'before_delivery' | 'strict';
export type MissionSource = 'chat' | 'workflow_template' | 'automation' | 'manual';
export type MissionPlanStepStatus = AutomationStepStatus | 'waiting_review';

export interface MissionReviewSettings {
  policy: MissionReviewPolicy;
  requiredRoles?: AgentRole[];
  approvalChannel?: 'slack' | 'email' | 'app' | string;
}

export interface MissionPlanStep {
  id: string;
  title: string;
  objective: string;
  kind: AutomationStepKind;
  assignedRole: AgentRole;
  toolName?: AutomationStepDefinition['toolName'];
  integrationId?: string;
  dependencies?: string[];
  condition?: string;
  inputs?: Record<string, unknown>;
  deliveryTarget?: AutomationStepDeliveryTarget | null;
  reviewGate?: boolean;
  estimatedCredits?: number;
  currentStatus: MissionPlanStepStatus;
}

export interface MissionPlan {
  steps: MissionPlanStep[];
  primaryRole: AgentRole;
  supportingRoles: AgentRole[];
  estimatedCredits?: number;
  executionPolicy?: AutomationExecutionPolicy;
  automationPlan?: AutomationExecutionPlan;
}

export interface MissionRecord {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  status: MissionStatus;
  ownerRole?: AgentRole;
  source?: MissionSource;
  sourcePrompt?: string;
  workflowTemplateId?: string;
  scheduleId?: string;
  automationId?: string;
  activeTaskId?: string;
  activeRunId?: string;
  creditBudget?: number;
  review: MissionReviewSettings;
  plan: MissionPlan;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface TaskRunRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  agentRole: AgentRole;
  ownerRole?: AgentRole;
  executorRole?: AgentRole;
  reviewerRole?: AgentRole;
  supportingRoles?: AgentRole[];
  modelTier: ModelTier;
  status: TaskRunStatus;
  estimatedCredits: number;
  actualCredits?: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface DelegationPlan {
  id: string;
  workspaceId: string;
  taskKind: TaskKind;
  ownerRole: AgentRole;
  executorRole: AgentRole;
  reviewerRole?: AgentRole;
  supportingRoles: AgentRole[];
  delegationDepth: number;
  requiresReview: boolean;
  suggestedModelTier: ModelTier;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface TaskOwnershipMetadata {
  planId: string;
  ownerRole: AgentRole;
  executorRole: AgentRole;
  reviewerRole?: AgentRole;
  supportingRoles: AgentRole[];
  delegationDepth: number;
  requiresReview: boolean;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  elasticLanes?: AgentRole[];
  primaryBand?: IntelligenceBand;
}

export interface WorkspaceBusinessContext {
  summary: string;          // one sentence: what the business is
  marketKeywords: string[]; // category terms that build search queries
  competitors: string[];    // named rivals — names or domains
  exclusions?: string[];    // topics to keep out of research
  updatedAt: string;
  updatedBy?: string;
}

export interface WorkspaceProfile {
  id: string;
  slug: string;
  name: string;
  ownerEmail?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  businessContext?: WorkspaceBusinessContext;
}

export interface UsageEvent {
  id: string;
  workspaceId: string;
  kind: UsageEventKind;
  taskId?: string;
  taskRunId?: string;
  automationId?: string;
  modelTier?: ModelTier;
  agentRole?: AgentRole;
  source?: CreditSource;
  deltaCredits?: number;
  toolName?: string;
  toolCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  success?: boolean;
  metadata?: Record<string, unknown>;
  occurredAt: string;
}

export interface PlatformPlan {
  workspaceId: string;
  subscriptionName: string;
  monthlyPriceUsd: number;
  includedCredits: number;
  autoTopUpEnabled: boolean;
  autoTopUpThresholdCredits?: number;
  autoTopUpAmountCredits?: number;
  createdAt: string;
  updatedAt: string;
}

export type BillingPlanId = 'starter' | 'pro' | 'team';

export interface PlanDefinition {
  id: BillingPlanId;
  name: string;
  stripeProductKey: string;
  monthlyPriceUsd: number;
  includedCredits: number;
  maxAutomations: number;
  includedSeats: number;
  extraSeatPriceUsd?: number;
  supportTier: 'email' | 'slack_email' | 'priority';
  supportsMultiAgent: boolean;
  supportsApprovals: boolean;
  supportsSharedWorkspace: boolean;
  supportsLongTermMemory: boolean;
  supportsAnalyticsDashboard: boolean;
  features: string[];
  topUpEnabled: boolean;
}

export interface WorkspaceBillingConfig {
  workspaceId: string;
  planId: BillingPlanId;
  seatCount: number;
  autoTopUpEnabled: boolean;
  autoTopUpThresholdCredits?: number;
  autoTopUpAmountCredits?: number;
  referralCode: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'unpaid';
  createdAt: string;
  updatedAt: string;
}

export interface TopUpOffer {
  id: string;
  stripeProductKey: string;
  credits: number;
  priceUsd: number;
  bonusCredits?: number;
}

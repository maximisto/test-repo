import type { ModelTier, TaskKind, UsageEvent } from './types';

export interface CostEstimateInput {
  taskKind: TaskKind;
  modelTier: ModelTier;
  toolCalls?: number;
  automationRuns?: number;
  reviewRequired?: boolean;
  artifactCount?: number;
  complexity?: 'low' | 'medium' | 'high';
  durationSeconds?: number;
  /**
   * Model generations the planned run will make. Without this term the
   * estimate carried no token cost at all, while the runtime charge is
   * token-DOMINATED — a talk-day run estimated at 68 credits settled at 228,
   * almost entirely token credits the estimate never mentioned.
   */
  modelCallCount?: number;
  /** Final executable-plan calls, each priced at its own tier and shape. */
  generationProjections?: GenerationCallProjectionInput[];
}

export interface GenerationCallProjectionInput {
  modelTier: ModelTier;
  /** Byte-safe upper bound for the system prompt plus serialized messages. */
  promptBytes: number;
  /** Hard provider output allowance configured for this call. */
  maxOutputTokens: number;
  /** Expected serialized prompt size used only for the operator forecast. */
  estimatedPromptBytes?: number;
  /** Expected call's output allowance before utilization is applied. */
  estimatedMaxOutputTokens?: number;
  /** False for failure-only calls that are authorized but not forecast as normal work. */
  includeInEstimate?: boolean;
}

export interface GenerationCallCreditProjection extends GenerationCallProjectionInput {
  projectedInputTokens: number;
  projectedOutputTokens: number;
  projectedTotalTokens: number;
  tokenCredits: number;
}

export interface CostEstimateBreakdown {
  baseCredits: number;
  modelCredits: number;
  toolCredits: number;
  automationCredits: number;
  reviewCredits: number;
  artifactCredits: number;
  durationCredits: number;
  complexityCredits: number;
  projectedTokenCredits: number;
}

export interface RuntimeCreditInput {
  taskKind: TaskKind;
  modelTier: ModelTier;
  toolCalls?: number;
  artifactCount?: number;
  complexity?: 'low' | 'medium' | 'high';
  durationSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Every provider generation owned by this charge, priced at its own tier. */
  generationCalls?: Array<{
    modelTier: ModelTier;
    usage: ProviderTokenUsage;
  }>;
}

export interface ProviderTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export interface RuntimeCreditResult {
  actualCredits: number;
  breakdown: {
    baseCredits: number;
    tokenCredits: number;
    toolCredits: number;
    artifactCredits: number;
    durationCredits: number;
    complexityCredits: number;
  };
  rationale: string[];
}

export interface CostEstimate {
  estimatedCredits: number;
  breakdown: CostEstimateBreakdown;
  rationale: string[];
}

const BASE_TASK_CREDITS: Record<TaskKind, number> = {
  chat: 5,
  research: 18,
  analysis: 16,
  engineering: 24,
  automation: 12,
  message: 4,
  report: 18,
  review: 10,
  scheduling: 8,
};

const MODEL_TIER_CREDITS: Record<ModelTier, number> = {
  micro: 0,
  default: 6,
  hard: 20,
  critical: 42,
  ops: 12,
};

export const DEFAULT_TOOL_CREDIT_COST = 4;
export const DEFAULT_AUTOMATION_RUN_CREDIT_COST = 15;
export const DEFAULT_REVIEW_CREDIT_COST = 8;
export const DEFAULT_ARTIFACT_CREDIT_COST = 5;
export const DEFAULT_DURATION_CREDIT_COST_PER_MINUTE = 2;
const MODEL_TIER_CREDITS_PER_1K_TOKENS: Record<ModelTier, number> = {
  micro: 1,
  default: 4,
  hard: 10,
  critical: 18,
  ops: 5,
};

/** Planning assumption only; the runtime authorization guard uses the byte-safe maximum below. */
export const PROJECTED_INPUT_BYTES_PER_TOKEN = 4;
/** Planning assumption only; output allowances remain hard provider caps at execution. */
export const PROJECTED_OUTPUT_TOKEN_UTILIZATION = 0.5;

function normalizeCount(value?: number): number {
  if (!value || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeText(value?: string): string {
  return (value || '').trim().toLowerCase();
}

function knownUsageTokenCount(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): number {
  const inputTokens = normalizeCount(usage.inputTokens);
  const outputTokens = normalizeCount(usage.outputTokens);
  const reportedTotalTokens = normalizeCount(usage.totalTokens);
  // A contradictory provider tuple is incomplete accounting, but the known
  // minimum can never be lower than the sum of its observed components.
  return Math.max(reportedTotalTokens, inputTokens + outputTokens);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Expected total tokens (prompt + completion) one automation model call
 * moves, for pre-run estimation. Calibrated against the 2026-08-11 espresso
 * runs: evidence blocks near the 24KB library ceiling plus scaled output
 * budgets put a drafting call at roughly this size. Deliberately a round
 * planning figure, not a promise — the runtime charge still bills actual
 * tokens.
 */
export const EXPECTED_TOKENS_PER_MODEL_CALL = 4000;

function generationTokenCredits(modelTier: ModelTier, totalTokens: number): number {
  const tokens = normalizeCount(totalTokens);
  if (tokens <= 0) return 0;
  return Math.max(
    1,
    Math.ceil(tokens / 1000) * (MODEL_TIER_CREDITS_PER_1K_TOKENS[modelTier] || 0),
  );
}

/**
 * Evidence-aware preflight projection. Input uses the documented 4-byte/token
 * planning ratio and output uses half the configured allowance. This is an
 * estimate for affordability/UI—not the hard authorization bound.
 */
export function estimateGenerationCallTokenCredits(
  input: GenerationCallProjectionInput,
): GenerationCallCreditProjection {
  const promptBytes = normalizeCount(input.estimatedPromptBytes ?? input.promptBytes);
  const maxOutputTokens = normalizeCount(input.estimatedMaxOutputTokens ?? input.maxOutputTokens);
  const projectedInputTokens = Math.ceil(promptBytes / PROJECTED_INPUT_BYTES_PER_TOKEN);
  const projectedOutputTokens = Math.ceil(maxOutputTokens * PROJECTED_OUTPUT_TOKEN_UTILIZATION);
  const projectedTotalTokens = projectedInputTokens + projectedOutputTokens;
  return {
    modelTier: input.modelTier,
    promptBytes,
    maxOutputTokens,
    projectedInputTokens,
    projectedOutputTokens,
    projectedTotalTokens,
    tokenCredits: generationTokenCredits(input.modelTier, projectedTotalTokens),
  };
}

/**
 * Byte-safe hard bound used before provider spend. Byte-level tokenizers
 * cannot produce more input tokens than UTF-8 bytes, and the provider cannot
 * return more than maxOutputTokens. If this bound does not fit, the call does
 * not execute without a new budget approval.
 */
export function maximumGenerationCallTokenCredits(
  input: GenerationCallProjectionInput,
): GenerationCallCreditProjection {
  const promptBytes = normalizeCount(input.promptBytes);
  const maxOutputTokens = normalizeCount(input.maxOutputTokens);
  const projectedInputTokens = promptBytes;
  const projectedOutputTokens = maxOutputTokens;
  const projectedTotalTokens = projectedInputTokens + projectedOutputTokens;
  return {
    modelTier: input.modelTier,
    promptBytes,
    maxOutputTokens,
    projectedInputTokens,
    projectedOutputTokens,
    projectedTotalTokens,
    tokenCredits: generationTokenCredits(input.modelTier, projectedTotalTokens),
  };
}

/**
 * How many model generations a planned run will make, from its steps:
 * each analyze/summarize step is one; a library write adds the baseline
 * merge; a deliver step adds the memo tier only when a library write exists
 * (the memo tier links to the persisted document, so it never runs without
 * one). Kept here, next to the estimator that consumes it, so the count and
 * the credit math cannot drift apart.
 */
export function countPlannedModelCalls(
  steps: Array<{
    kind?: string;
    title?: string;
    objective?: string;
    inputs?: Record<string, unknown>;
  } | null | undefined> | undefined | null,
): number {
  const list = (steps ?? []).filter(
    (step): step is {
      kind?: string;
      title?: string;
      objective?: string;
      inputs?: Record<string, unknown>;
    } => Boolean(step),
  );
  const draftingCalls = list.filter((step) => step.kind === 'analyze' || step.kind === 'summarize').length;
  const competitiveExtractionCalls = list.filter((step) =>
    step.kind === 'analyze' && /competitor|competitive|market/i.test(`${step.title || ''} ${step.objective || ''}`)
  ).length;
  const hasLibraryWrite = list.some((step) => {
    if (step.kind !== 'query') return false;
    const source = typeof step.inputs?.source === 'string' ? step.inputs.source.trim().toLowerCase() : '';
    const queryType = typeof step.inputs?.query_type === 'string' ? step.inputs.query_type.trim().toLowerCase() : '';
    return source === 'account_library' && queryType === 'write';
  });
  const hasDeliver = list.some((step) => step.kind === 'deliver');
  return draftingCalls + competitiveExtractionCalls + (hasLibraryWrite ? 1 : 0) + (hasLibraryWrite && hasDeliver ? 1 : 0);
}

export function estimateCreditCost(input: CostEstimateInput): CostEstimate {
  const baseCredits = BASE_TASK_CREDITS[input.taskKind] || 0;
  const modelCredits = MODEL_TIER_CREDITS[input.modelTier] || 0;
  const toolCredits = normalizeCount(input.toolCalls) * DEFAULT_TOOL_CREDIT_COST;
  const automationCredits = normalizeCount(input.automationRuns) * DEFAULT_AUTOMATION_RUN_CREDIT_COST;
  const reviewCredits = input.reviewRequired ? DEFAULT_REVIEW_CREDIT_COST : 0;
  const artifactCredits = normalizeCount(input.artifactCount) * DEFAULT_ARTIFACT_CREDIT_COST;
  const durationCredits = Math.ceil(normalizeCount(input.durationSeconds) / 60) * DEFAULT_DURATION_CREDIT_COST_PER_MINUTE;
  const complexityCredits =
    input.complexity === 'high' ? 12 : input.complexity === 'medium' ? 5 : 0;
  // The same per-1K rate the runtime charge bills, applied to the projected
  // token volume — the term whose absence made estimates read 3× low.
  const modelCallCount = normalizeCount(input.modelCallCount);
  const projectedTokenCredits = input.generationProjections?.length
    ? input.generationProjections.reduce(
        (total, call) => total + (call.includeInEstimate === false
          ? 0
          : estimateGenerationCallTokenCredits(call).tokenCredits),
        0,
      )
    : modelCallCount > 0
      ? generationTokenCredits(input.modelTier, modelCallCount * EXPECTED_TOKENS_PER_MODEL_CALL)
      : 0;

  const estimatedCredits =
    baseCredits +
    modelCredits +
    toolCredits +
    automationCredits +
    reviewCredits +
    artifactCredits +
    durationCredits +
    complexityCredits +
    projectedTokenCredits;

  const rationale = [
    `base:${baseCredits}`,
    `model:${modelCredits}`,
    `tools:${toolCredits}`,
    `automation:${automationCredits}`,
    `review:${reviewCredits}`,
    `artifacts:${artifactCredits}`,
    `duration:${durationCredits}`,
    `complexity:${complexityCredits}`,
    `projected_tokens:${projectedTokenCredits}`,
  ];

  return {
    estimatedCredits,
    breakdown: {
      baseCredits,
      modelCredits,
      toolCredits,
      automationCredits,
      reviewCredits,
      artifactCredits,
      durationCredits,
      complexityCredits,
      projectedTokenCredits,
    },
    rationale,
  };
}

export function estimateUsageEventCredits(event: UsageEvent): number {
  if (typeof event.deltaCredits === 'number') {
    return Math.trunc(event.deltaCredits);
  }

  const inferredTaskKind: TaskKind = event.kind.includes('automation')
    ? 'automation'
    : event.kind.includes('review')
      ? 'review'
      : event.kind.includes('report')
        ? 'report'
        : 'chat';

  return estimateCreditCost({
    taskKind: inferredTaskKind,
    modelTier: event.modelTier || 'default',
    toolCalls: event.toolCount,
    durationSeconds: event.durationMs ? Math.ceil(event.durationMs / 1000) : undefined,
  }).estimatedCredits;
}

// Blended provider cost in USD per 1M tokens (input-heavy 3:1 ratio weighted average).
// Used only for margin reporting; does not affect credit billing.
const PROVIDER_COST_USD_PER_1M_TOKENS: Record<ModelTier, number> = {
  micro: 0.10,
  default: 6.00,
  hard: 25.00,
  critical: 30.00,
  ops: 0.20,
};

const PROVIDER_MODEL_COST_USD_PER_1M_TOKENS: Array<{
  provider: string;
  model: string;
  input: number;
  output: number;
}> = [
  {
    provider: 'openrouter',
    model: 'z-ai/glm-5.2',
    input: 0.9086,
    output: 2.856,
  },
];

// Approximate USD value of one credit at Start-plan rates ($79 / 2000 credits).
export const CREDIT_VALUE_USD = 0.0395;

export function estimateProviderCostUsd(modelTier: ModelTier, totalTokens: number): number {
  const ratePerMillion = PROVIDER_COST_USD_PER_1M_TOKENS[modelTier] ?? 6.00;
  return roundUsd((totalTokens / 1_000_000) * ratePerMillion);
}

export function estimateProviderCostUsdForUsage(modelTier: ModelTier, usage: ProviderTokenUsage): number | null {
  const inputTokens = normalizeCount(usage.inputTokens);
  const outputTokens = normalizeCount(usage.outputTokens);
  const totalTokens = knownUsageTokenCount(usage);
  if (totalTokens <= 0) return null;

  const provider = normalizeText(usage.provider);
  const model = normalizeText(usage.model);
  const providerModelRate = PROVIDER_MODEL_COST_USD_PER_1M_TOKENS.find(
    (rate) => rate.provider === provider && rate.model === model,
  );

  if (providerModelRate) {
    const inputHeavyBlend = (providerModelRate.input * 3 + providerModelRate.output) / 4;
    if (inputTokens > 0 || outputTokens > 0) {
      const componentCost =
        (inputTokens / 1_000_000) * providerModelRate.input +
        (outputTokens / 1_000_000) * providerModelRate.output;
      // Some compatible providers return contradictory tuples. Credits and
      // token telemetry already use max(total, input + output); margin must
      // not quietly price fewer tokens than those customer-facing counters.
      const totalFloorCost = (totalTokens / 1_000_000) * inputHeavyBlend;
      return roundUsd(Math.max(componentCost, totalFloorCost));
    }
    return roundUsd((totalTokens / 1_000_000) * inputHeavyBlend);
  }

  return estimateProviderCostUsd(modelTier, totalTokens);
}

export function calculateRuntimeCredits(input: RuntimeCreditInput): RuntimeCreditResult {
  const baseCredits = BASE_TASK_CREDITS[input.taskKind] || 0;
  const toolCredits = normalizeCount(input.toolCalls) * DEFAULT_TOOL_CREDIT_COST;
  const artifactCredits = normalizeCount(input.artifactCount) * DEFAULT_ARTIFACT_CREDIT_COST;
  const durationCredits = Math.ceil(normalizeCount(input.durationSeconds) / 60) * DEFAULT_DURATION_CREDIT_COST_PER_MINUTE;
  const complexityCredits =
    input.complexity === 'high' ? 12 : input.complexity === 'medium' ? 5 : 0;

  const generationCalls = input.generationCalls ?? [];
  const tokenCredits = generationCalls.length > 0
    ? generationCalls.reduce((total, call) => {
        const callTokens = knownUsageTokenCount(call.usage);
        if (callTokens <= 0) return total;
        return total + generationTokenCredits(call.modelTier, callTokens);
      }, 0)
    : (() => {
        const totalTokens = knownUsageTokenCount(input);
        return totalTokens > 0
          ? generationTokenCredits(input.modelTier, totalTokens)
          : 0;
      })();

  const actualCredits =
    baseCredits +
    tokenCredits +
    toolCredits +
    artifactCredits +
    durationCredits +
    complexityCredits;

  return {
    actualCredits,
    breakdown: {
      baseCredits,
      tokenCredits,
      toolCredits,
      artifactCredits,
      durationCredits,
      complexityCredits,
    },
    rationale: [
      `base:${baseCredits}`,
      `tokens:${tokenCredits}`,
      `tools:${toolCredits}`,
      `artifacts:${artifactCredits}`,
      `duration:${durationCredits}`,
      `complexity:${complexityCredits}`,
    ],
  };
}

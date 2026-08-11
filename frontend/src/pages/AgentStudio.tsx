import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Activity from 'lucide-react/dist/esm/icons/activity.js';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.js';
import ArrowUpRight from 'lucide-react/dist/esm/icons/arrow-up-right.js';
import BarChart3 from 'lucide-react/dist/esm/icons/bar-chart-3.js';
import Brain from 'lucide-react/dist/esm/icons/brain.js';
import BookOpen from 'lucide-react/dist/esm/icons/book-open.js';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2.js';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.js';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3.js';
import Flame from 'lucide-react/dist/esm/icons/flame.js';
import Layers3 from 'lucide-react/dist/esm/icons/layers-3.js';
import LineChart from 'lucide-react/dist/esm/icons/line-chart.js';
import Orbit from 'lucide-react/dist/esm/icons/orbit.js';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw.js';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles.js';
import Target from 'lucide-react/dist/esm/icons/target.js';
import Workflow from 'lucide-react/dist/esm/icons/workflow.js';
import { formatCredits } from '../lib/credits';
import { resolveWorkspaceContext } from '../lib/workspace';
import type {
  AgentStudioOperationalContext,
} from '../features/agent-studio/contract';
import type {
  AgentStudioRow,
  AgentStudioSettingsPayload,
  AutomationApiRecord,
  AutomationExecutionPolicyDraft,
  AutomationStudioStateDraft,
  BranchRunFilter,
  DashboardTaskStepExecution,
  DashboardWorkerCard,
  DashboardWorkerTopology,
  ExecutionMode,
  GateLearningWindow,
  OptimizationGoal,
  PlatformTaskRecord,
  PlatformTaskRunRecord,
  ReplayPhaseOverlayEntry,
  ReviewPolicy,
  RunExperimentAttribution,
  RunScenarioTelemetry,
  ScenarioPresetId,
  StudioExperimentRecord,
  StudioOperatingPlan,
  StudioPromotionRecord,
  StudioRoleDirective,
  StudioRoom,
  TrendMetric,
  WorkflowBlockDraft,
  WorkflowBlockKind,
} from '../features/agent-studio/types';
import { LiveSupportRailSection } from '../features/agent-studio/components/LiveSupportRailSection';
import { LiveNodeInspectorSection } from '../features/agent-studio/components/LiveNodeInspectorSection';
import { LiveHandoffsSection } from '../features/agent-studio/components/LiveHandoffsSection';
import { LiveAdvancedSupportSection } from '../features/agent-studio/components/LiveAdvancedSupportSection';
import { LiveOptimizationLoopSection } from '../features/agent-studio/components/LiveOptimizationLoopSection';
import { LiveOperatorBriefSection } from '../features/agent-studio/components/LiveOperatorBriefSection';
import { LiveSystemMapSection } from '../features/agent-studio/components/LiveSystemMapSection';
import { OptimizeCurrentReleaseSection } from '../features/agent-studio/components/OptimizeCurrentReleaseSection';
import { OptimizeDecisionBriefSection } from '../features/agent-studio/components/OptimizeDecisionBriefSection';
import { OptimizeDiagnosticsSection } from '../features/agent-studio/components/OptimizeDiagnosticsSection';
import { OptimizeReleaseCandidateSection } from '../features/agent-studio/components/OptimizeReleaseCandidateSection';
import { OptimizeScenarioSimulatorSection } from '../features/agent-studio/components/OptimizeScenarioSimulatorSection';
import { OptimizeAdvancedControlsSection } from '../features/agent-studio/components/OptimizeAdvancedControlsSection';
import { AgentStudioGuidePanel } from '../features/agent-studio/components/AgentStudioGuidePanel';
import { ControlLoopHandoffStrip } from '../features/agent-studio/components/ControlLoopHandoffStrip';
import { DimaStudioAdvisorPanel } from '../features/agent-studio/components/DimaStudioAdvisorPanel';
import { OperationalContextMapSection } from '../features/agent-studio/components/OperationalContextMapSection';
import { ReplayDecisionBriefSection } from '../features/agent-studio/components/ReplayDecisionBriefSection';
import { ReplayDecisionSupportSection } from '../features/agent-studio/components/ReplayDecisionSupportSection';
import { ReplayGovernanceSection } from '../features/agent-studio/components/ReplayGovernanceSection';
import { LiveRoom } from '../features/agent-studio/rooms/LiveRoom';
import { OptimizeRoom } from '../features/agent-studio/rooms/OptimizeRoom';
import { ReplayRoom } from '../features/agent-studio/rooms/ReplayRoom';
import ViolemaLogo from '../components/ViolemaLogo';

const AGENT_STUDIO_GUIDE_DISMISSED_KEY = 'violema_agentstudio_guide_dismissed';

const DEFAULT_EXECUTION_POLICY: AutomationExecutionPolicyDraft = {
  mode: 'recommended',
  optimizationGoal: 'balanced',
  reviewPolicy: 'standard',
  maxElasticLanes: 2,
};

const POLICY_PRESETS: Array<{
  id: string;
  label: string;
  summary: string;
  policy: AutomationExecutionPolicyDraft;
}> = [
  {
    id: 'recommended',
    label: 'System recommended',
    summary: 'Best default. Lets Violema route heavy reasoning only when the run justifies it.',
    policy: { mode: 'recommended', optimizationGoal: 'balanced', reviewPolicy: 'standard', maxElasticLanes: 2 },
  },
  {
    id: 'lean_ops',
    label: 'Lean ops',
    summary: 'Prefer cheaper lanes for operational work, recurring research, and tool-heavy flows.',
    policy: { mode: 'custom', optimizationGoal: 'cost_saver', reviewPolicy: 'lean', maxElasticLanes: 1 },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    summary: 'Good middle ground when the workflow needs some parallelism without over-spending.',
    policy: { mode: 'custom', optimizationGoal: 'balanced', reviewPolicy: 'standard', maxElasticLanes: 2 },
  },
  {
    id: 'high_assurance',
    label: 'High assurance',
    summary: 'Spend more when correctness matters. Better for sensitive reporting and higher-risk outputs.',
    policy: { mode: 'custom', optimizationGoal: 'quality_first', reviewPolicy: 'strict', maxElasticLanes: 3 },
  },
];

const PROMOTION_GATE_PROFILES = [
  { id: 'conservative', label: 'Conservative', global: 85, archetype: 85, scenario: 85, summary: 'Only promote when evidence is very strong.' },
  { id: 'balanced', label: 'Balanced', global: 70, archetype: 70, scenario: 70, summary: 'Good default when you want measured adaptation.' },
  { id: 'aggressive', label: 'Aggressive', global: 55, archetype: 55, scenario: 55, summary: 'Move faster when the goal is rapid iteration.' },
] as const;

const AUTO_GRADUATION_PROFILES = [
  {
    id: 'cautious',
    label: 'Cautious',
    summary: 'Best for sensitive briefings and workflows where a weak branch should almost never replace the parent.',
    global: 85,
    archetype: 85,
    scenario: 90,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    summary: 'Good default when you want branch promotion to happen, but only after the edge is clear.',
    global: 72,
    archetype: 72,
    scenario: 78,
  },
  {
    id: 'fast_learning',
    label: 'Fast learning',
    summary: 'Use when you want the system to graduate strong child branches sooner and learn faster from ops work.',
    global: 60,
    archetype: 66,
    scenario: 60,
  },
] as const;

const WORKER_DEFINITIONS: Array<{
  role: string;
  label: string;
  laneType: 'core' | 'elastic';
  preferredBand: string;
  modelLabel: string;
  summary: string;
}> = [
  {
    role: 'nexus',
    label: 'Violema Manager',
    laneType: 'core',
    preferredBand: 'default',
    modelLabel: 'Claude Sonnet 5 / orchestration',
    summary: 'Owns decomposition, routing, quality thresholds, and worker handoffs.',
  },
  {
    role: 'researcher',
    label: 'Research Lead',
    laneType: 'core',
    preferredBand: 'default',
    modelLabel: 'Sonnet 5 / balanced reasoning',
    summary: 'Finds external evidence, current sources, and context.',
  },
  {
    role: 'analyst',
    label: 'Analysis Lead',
    laneType: 'core',
    preferredBand: 'hard',
    modelLabel: 'Opus 5 / deep reasoning',
    summary: 'Interprets tradeoffs, metrics, and patterns into decisions.',
  },
  {
    role: 'operator',
    label: 'Operations Lead',
    laneType: 'core',
    preferredBand: 'default',
    modelLabel: 'Sonnet 5 / Haiku hybrid',
    summary: 'Handles tools, delivery, and workflow orchestration.',
  },
  {
    role: 'engineer',
    label: 'Build Lead',
    laneType: 'core',
    preferredBand: 'hard',
    modelLabel: 'Opus 5 / implementation',
    summary: 'Takes technical tasks that require structured implementation.',
  },
  {
    role: 'reviewer',
    label: 'Review Lead',
    laneType: 'core',
    preferredBand: 'critical',
    modelLabel: 'Opus 5 / high-assurance review',
    summary: 'Applies final risk checks when a workflow justifies stricter review.',
  },
  {
    role: 'writer',
    label: 'Elastic lane 01',
    laneType: 'elastic',
    preferredBand: 'critical',
    modelLabel: 'Opus 5 / difficult finish work',
    summary: 'Opens for hard synthesis, difficult framing, and polished final output.',
  },
  {
    role: 'scheduler',
    label: 'Elastic lane 02',
    laneType: 'elastic',
    preferredBand: 'hard',
    modelLabel: 'Opus 5 / parallel reasoning',
    summary: 'Opens for decomposition, extra reasoning depth, and parallel analysis.',
  },
  {
    role: 'messenger',
    label: 'Elastic lane 03',
    laneType: 'elastic',
    preferredBand: 'micro',
    modelLabel: 'GPT-4.1 mini / low-cost throughput',
    summary: 'Opens for delivery, operational overflow, and tool-heavy work.',
  },
  {
    role: 'monitor',
    label: 'Elastic lane 04',
    laneType: 'elastic',
    preferredBand: 'micro',
    modelLabel: 'Low-cost memory routing',
    summary: 'Opens for watch conditions, context compaction, and background support.',
  },
];

const SCENARIO_PRESETS: Array<{
  id: ScenarioPresetId;
  label: string;
  summary: string;
  stepMultiplier: number;
  toolMultiplier: number;
  reasoningDelta: number;
}> = [
  {
    id: 'baseline',
    label: 'Current workflow',
    summary: 'Use the workflow exactly as saved right now.',
    stepMultiplier: 1,
    toolMultiplier: 1,
    reasoningDelta: 0,
  },
  {
    id: 'rush',
    label: 'Rush mode',
    summary: 'Shorter turnaround and lighter review pressure.',
    stepMultiplier: 0.85,
    toolMultiplier: 0.85,
    reasoningDelta: -1.1,
  },
  {
    id: 'deep_research',
    label: 'Deep research',
    summary: 'More search, more synthesis, more reasoning weight.',
    stepMultiplier: 1.25,
    toolMultiplier: 1.35,
    reasoningDelta: 1.8,
  },
  {
    id: 'monitoring',
    label: 'Watch loop',
    summary: 'Frequent checks, light reasoning, heavier tool usage.',
    stepMultiplier: 1.1,
    toolMultiplier: 1.45,
    reasoningDelta: -0.6,
  },
  {
    id: 'high_stakes',
    label: 'High stakes',
    summary: 'Higher review pressure and more expensive fallback tolerance.',
    stepMultiplier: 1.15,
    toolMultiplier: 1,
    reasoningDelta: 2.2,
  },
];

const DIRECTIVE_PHASE_OPTIONS: Array<{ value: 'all' | WorkflowBlockKind; label: string }> = [
  { value: 'all', label: 'All phases' },
  { value: 'search', label: 'Search' },
  { value: 'query', label: 'Query' },
  { value: 'capture', label: 'Capture' },
  { value: 'analyze', label: 'Analyze' },
  { value: 'summarize', label: 'Summarize' },
  { value: 'deliver', label: 'Deliver' },
];

const OPERATING_PLAN_INTENTS = [
  'Fast founder loop',
  'Low-cost monitoring',
  'High-assurance briefings',
  'Balanced execution',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatTime(date: Date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatRelativeTimeFromIso(iso?: string) {
  if (!iso) return '—';
  return formatTime(new Date(iso));
}

function formatAutomationRunTime(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatCompactDuration(durationMs?: number) {
  if (!durationMs || durationMs <= 0) return '—';
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTokenCount(value?: number) {
  if (!value || value <= 0) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return `${value}`;
}

function stripMarkdownPreview(value?: string) {
  if (!value) return '';
  return value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatSummaryPreview(value?: string, maxLength = 180) {
  const normalized = stripMarkdownPreview(value);
  if (!normalized) return '';
  return truncateText(normalized, maxLength);
}

function normalizeExecutionPolicy(value: unknown): AutomationExecutionPolicyDraft {
  if (!isRecord(value)) return { ...DEFAULT_EXECUTION_POLICY };
  return {
    mode: value.mode === 'custom' ? 'custom' : 'recommended',
    optimizationGoal:
      value.optimizationGoal === 'cost_saver' || value.optimizationGoal === 'quality_first'
        ? value.optimizationGoal
        : 'balanced',
    reviewPolicy:
      value.reviewPolicy === 'lean' || value.reviewPolicy === 'strict'
        ? value.reviewPolicy
        : 'standard',
    maxElasticLanes:
      typeof value.maxElasticLanes === 'number'
        ? Math.max(0, Math.min(4, Math.trunc(value.maxElasticLanes)))
        : DEFAULT_EXECUTION_POLICY.maxElasticLanes,
  };
}

function parseLegacyActionToWorkflowBlock(action: string): WorkflowBlockDraft {
  const trimmed = action.trim();
  const normalized = trimmed.toLowerCase();
  const id = `step-${Math.random().toString(36).slice(2, 8)}`;

  if (/(summary|digest|report|golden nuggets|briefing|recap)/.test(normalized)) {
    return { id, kind: 'summarize', title: trimmed, objective: trimmed };
  }
  if (/(deliver|send|slack|email|notify|message)/.test(normalized)) {
    return { id, kind: 'deliver', title: trimmed, objective: trimmed };
  }
  if (/(analy[sz]e|diagnos|compare|review|audit)/.test(normalized)) {
    return { id, kind: 'analyze', title: trimmed, objective: trimmed };
  }
  if (/(query|stripe|posthog|github|linear|notion)/.test(normalized)) {
    return { id, kind: 'query', title: trimmed, objective: trimmed };
  }
  if (/(capture|screenshot)/.test(normalized)) {
    return { id, kind: 'capture', title: trimmed, objective: trimmed };
  }
  if (/(search|scan|research|news|look up|find)/.test(normalized)) {
    return { id, kind: 'search', title: trimmed, objective: trimmed };
  }
  return { id, kind: 'note', title: trimmed, objective: trimmed };
}

function buildWorkflowBlocksFromPrompt(prompt?: string) {
  if (!prompt?.trim()) return [];
  return prompt
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseLegacyActionToWorkflowBlock(line));
}

function workflowBlockHasContent(block: WorkflowBlockDraft) {
  return Boolean(block.title?.trim() || block.objective?.trim());
}

function countWorkflowToolCalls(steps: WorkflowBlockDraft[]) {
  return steps.filter((step) => ['search', 'query', 'capture', 'deliver'].includes(step.kind)).length;
}

function estimateRecommendedElasticLanes(steps: WorkflowBlockDraft[]) {
  const weightedStepCount = steps.reduce((total, step) => {
    if (step.kind === 'analyze' || step.kind === 'capture') return total + 2;
    return total + 1;
  }, 0);
  if (weightedStepCount >= 8) return 3;
  if (weightedStepCount >= 5) return 2;
  return 1;
}

function inferExecutionPolicyMath(policy: AutomationExecutionPolicyDraft, steps: WorkflowBlockDraft[]) {
  const workflowSteps = steps.filter((step) => workflowBlockHasContent(step));
  const stepCount = workflowSteps.length;
  const toolCalls = countWorkflowToolCalls(workflowSteps);
  const recommendedElasticLanes = estimateRecommendedElasticLanes(workflowSteps);
  const activeElasticLanes = policy.mode === 'recommended'
    ? recommendedElasticLanes
    : Math.min(policy.maxElasticLanes, recommendedElasticLanes);
  const reasoningLoad =
    stepCount * 1.15 +
    toolCalls * 0.85 +
    (workflowSteps.some((step) => step.kind === 'analyze') ? 1.75 : 0) +
    (workflowSteps.some((step) => step.kind === 'summarize') ? 0.9 : 0);
  const estimatedBands =
    policy.mode === 'recommended'
      ? 'Auto'
      : policy.optimizationGoal === 'cost_saver'
        ? 'Bias lower'
        : policy.optimizationGoal === 'quality_first'
          ? 'Bias higher'
          : 'Balanced';

  return {
    stepCount,
    toolCalls,
    reasoningLoad: reasoningLoad.toFixed(1),
    recommendedElasticLanes,
    activeElasticLanes,
    estimatedBands,
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function estimatePolicySpendIndex(policy: AutomationExecutionPolicyDraft, steps: WorkflowBlockDraft[]) {
  const math = inferExecutionPolicyMath(policy, steps);
  let score =
    math.stepCount * 7 +
    math.toolCalls * 11 +
    Number(math.reasoningLoad) * 4 +
    math.activeElasticLanes * 9;

  if (policy.mode === 'recommended') score += 6;
  if (policy.optimizationGoal === 'cost_saver') score -= 16;
  if (policy.optimizationGoal === 'quality_first') score += 14;
  if (policy.reviewPolicy === 'lean') score -= 8;
  if (policy.reviewPolicy === 'strict') score += 12;

  return clampNumber(Math.round(score), 15, 95);
}

function estimatePolicyAssuranceIndex(policy: AutomationExecutionPolicyDraft, steps: WorkflowBlockDraft[]) {
  const math = inferExecutionPolicyMath(policy, steps);
  let score =
    math.stepCount * 5 +
    Number(math.reasoningLoad) * 6 +
    math.activeElasticLanes * 7;

  if (policy.mode === 'recommended') score += 8;
  if (policy.optimizationGoal === 'cost_saver') score -= 12;
  if (policy.optimizationGoal === 'quality_first') score += 18;
  if (policy.reviewPolicy === 'lean') score -= 10;
  if (policy.reviewPolicy === 'strict') score += 16;

  return clampNumber(Math.round(score), 20, 98);
}

function estimatePolicyFitIndex(policy: AutomationExecutionPolicyDraft, steps: WorkflowBlockDraft[]) {
  const math = inferExecutionPolicyMath(policy, steps);
  let score = 74 - Math.abs(math.activeElasticLanes - math.recommendedElasticLanes) * 12;

  if (policy.optimizationGoal === 'cost_saver' && math.toolCalls >= 2) score += 8;
  if (policy.optimizationGoal === 'quality_first' && steps.some((step) => step.kind === 'analyze' || step.kind === 'summarize')) score += 10;
  if (policy.reviewPolicy === 'strict' && steps.some((step) => step.kind === 'analyze')) score += 6;
  if (policy.reviewPolicy === 'strict' && math.stepCount <= 2 && math.toolCalls <= 1) score -= 8;
  if (policy.reviewPolicy === 'lean' && steps.some((step) => step.kind === 'deliver')) score += 5;

  return clampNumber(Math.round(score), 25, 96);
}

function readStepExecutions(value: unknown): DashboardTaskStepExecution[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const stepId = readString(item.stepId);
      const kind = readString(item.kind);
      const title = readString(item.title);
      const assignedRole = readString(item.assignedRole);
      const status = readString(item.status);
      if (!stepId || !kind || !title || !assignedRole || !status) return null;
      return {
        stepId,
        kind,
        title,
        assignedRole,
        status,
        summary: readString(item.summary),
        error: readString(item.error),
        startedAt: readString(item.startedAt),
        finishedAt: readString(item.finishedAt),
        modelTier: readString(item.modelTier),
        directiveMode: item.directiveMode === 'cheaper' || item.directiveMode === 'review' || item.directiveMode === 'promote' ? item.directiveMode : undefined,
        directivePhases: normalizeDirectivePhases(item.directivePhases),
        modelSource: readString(item.modelSourceLabel) || readString(item.modelSource),
        actualCredits: typeof item.actualCredits === 'number' ? item.actualCredits : undefined,
        toolCalls: typeof item.toolCalls === 'number' ? item.toolCalls : undefined,
        durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
        tokenUsage: isRecord(item.tokenUsage) ? {
          totalTokens: typeof item.tokenUsage.totalTokens === 'number' ? item.tokenUsage.totalTokens : undefined,
        } : undefined,
      } as DashboardTaskStepExecution;
    })
    .filter((item): item is DashboardTaskStepExecution => Boolean(item));
}

function readWorkerTopology(value: unknown): DashboardWorkerTopology | undefined {
  if (!isRecord(value)) return undefined;
  const version = readString(value.version);
  const primaryRole = readString(value.primaryRole);
  const primaryBand = readString(value.primaryBand);
  if (!version || !primaryRole || !primaryBand) return undefined;
  const workers = Array.isArray(value.workers)
    ? value.workers
        .map((item) => {
          if (!isRecord(item)) return null;
          const role = readString(item.role);
          const label = readString(item.label);
          const laneType = readString(item.laneType);
          const assignedRole = readString(item.assignedRole);
          const band = readString(item.band);
          const modelLabel = readString(item.modelLabel);
          const status = readString(item.status);
          const summary = readString(item.summary);
          const reason = readString(item.reason);
          if (
            !role ||
            !label ||
            (laneType !== 'core' && laneType !== 'elastic') ||
            !assignedRole ||
            !band ||
            !modelLabel ||
            (status !== 'active' && status !== 'standby') ||
            !summary ||
            !reason
          ) {
            return null;
          }
          return { role, label, laneType, assignedRole, band, modelLabel, status, summary, reason } as DashboardWorkerCard;
        })
        .filter((item): item is DashboardWorkerCard => Boolean(item))
    : [];

  return {
    version,
    primaryRole,
    primaryBand,
    workers,
    summary: readString(value.summary),
  };
}

function getTaskModelSource(task?: PlatformTaskRecord, run?: PlatformTaskRunRecord) {
  return (
    readString(run?.metadata?.modelSourceLabel) ||
    readString(run?.metadata?.modelSource) ||
    readString(task?.metadata?.modelSourceLabel) ||
    readString(task?.metadata?.modelSource)
  );
}

function getStatusTone(status: string) {
  if (status === 'failed' || status === 'alert' || status === 'paused') return 'border-red-500/18 bg-red-500/8 text-red-200';
  if (status === 'succeeded' || status === 'complete' || status === 'completed') return 'border-green-500/18 bg-green-500/8 text-green-200';
  if (status === 'running') return 'border-cyan-500/18 bg-cyan-500/8 text-cyan-200';
  return 'border-violet-500/18 bg-violet-500/8 text-violet-200';
}

function compactPresent<T>(items: Array<T | null | undefined>): T[] {
  return items.filter((item): item is T => Boolean(item));
}

function getExecutionModeLabel(value: ExecutionMode) {
  return value === 'custom' ? 'Custom policy' : 'System recommended';
}

function getOptimizationGoalLabel(value: OptimizationGoal) {
  if (value === 'cost_saver') return 'Cost Saver';
  if (value === 'quality_first') return 'Quality First';
  return 'Balanced';
}

function getReviewPolicyLabel(value: ReviewPolicy) {
  if (value === 'lean') return 'Lean review';
  if (value === 'strict') return 'Strict review';
  return 'Standard review';
}

function formatSignedDelta(value: number) {
  if (value === 0) return 'No change';
  return `${value > 0 ? '+' : ''}${value}`;
}

function getScenarioPreset(id: ScenarioPresetId) {
  return SCENARIO_PRESETS.find((scenario) => scenario.id === id) || SCENARIO_PRESETS[0];
}

function getRunStudioState(run?: PlatformTaskRunRecord) {
  return normalizeStudioState(run?.metadata?.studioState);
}

function getScenarioLabelFromId(id?: string) {
  if (!id) return 'Baseline';
  return getScenarioPreset(id as ScenarioPresetId).label;
}

function getPresetLabelFromId(id?: string) {
  if (!id) return 'System recommended';
  return POLICY_PRESETS.find((preset) => preset.id === id)?.label || id;
}

function getExperimentDisplayLabel(experiment: StudioExperimentRecord) {
  return experiment.branchName || experiment.notes || `${getScenarioLabelFromId(experiment.scenarioId)} · ${getPresetLabelFromId(experiment.previewPresetId)}`;
}

function getExperimentRootId(experiment: StudioExperimentRecord, experiments: StudioExperimentRecord[]) {
  const byId = new Map(experiments.map((item) => [item.id, item] as const));
  let current: StudioExperimentRecord | undefined = experiment;
  const visited = new Set<string>();

  while (current?.parentExperimentId && !visited.has(current.parentExperimentId)) {
    visited.add(current.id);
    const parent = byId.get(current.parentExperimentId);
    if (!parent) break;
    current = parent;
  }

  return current?.id || experiment.id;
}

function getExperimentPhaseList(experiment: StudioExperimentRecord) {
  const phases = Object.values(experiment.roleDirectives || {}).flatMap((directive) => directive.phases || []);
  return [...new Set(phases)];
}

function extractPhaseDirectiveSnapshot(
  roleDirectives: Record<string, StudioRoleDirective> | undefined,
  phase: WorkflowBlockKind,
) {
  if (!roleDirectives) return undefined;
  const next = Object.entries(roleDirectives).reduce<Record<string, StudioRoleDirective>>((acc, [role, directive]) => {
    if (!directive.phases || directive.phases.length === 0 || directive.phases.includes(phase)) {
      acc[role] = {
        mode: directive.mode,
        phases: [phase],
        updatedAt: new Date().toISOString(),
      };
    }
    return acc;
  }, {});
  return Object.keys(next).length > 0 ? next : undefined;
}

function getTrendMetricLabel(metric: TrendMetric) {
  if (metric === 'duration') return 'Duration';
  if (metric === 'success') return 'Success';
  return 'Credits';
}

function getTrendMetricValue(run: PlatformTaskRunRecord, metric: TrendMetric) {
  if (metric === 'success') return run.status === 'succeeded' ? 100 : run.status === 'failed' ? 24 : 56;
  if (metric === 'duration') {
    const started = Date.parse(run.startedAt || '');
    const finished = Date.parse(run.finishedAt || '');
    return Number.isNaN(started) || Number.isNaN(finished) ? 0 : Math.max(0, finished - started) / 1000;
  }
  return run.actualCredits || 0;
}

function formatTrendMetricValue(run: PlatformTaskRunRecord, metric: TrendMetric) {
  if (metric === 'success') return run.status === 'succeeded' ? 'Pass' : run.status === 'failed' ? 'Fail' : 'Live';
  if (metric === 'duration') return formatCompactDuration(
    Number.isNaN(Date.parse(run.startedAt || '')) || Number.isNaN(Date.parse(run.finishedAt || ''))
      ? undefined
      : Math.max(0, Date.parse(run.finishedAt || '') - Date.parse(run.startedAt || ''))
  );
  return run.actualCredits ? `${formatCredits(run.actualCredits)} cr` : '—';
}

function getExperimentTags(
  experiment: StudioExperimentRecord,
  stats?: { count: number; successRate: number; averageCredits: number },
  winning = false,
) {
  const tags = [getScenarioLabelFromId(experiment.scenarioId), getPresetLabelFromId(experiment.previewPresetId)];
  const directiveCount = Object.keys(experiment.roleDirectives || {}).length;
  if (directiveCount > 0) tags.push(`${directiveCount} directed role${directiveCount === 1 ? '' : 's'}`);
  if (winning) tags.push('Winning setup');
  if ((stats?.count || 0) >= 3) tags.push('Observed');
  if ((stats?.successRate || 0) >= 0.8 && (stats?.count || 0) >= 2) tags.push('Reliable');
  if ((stats?.averageCredits || 0) > 0 && (stats?.averageCredits || 0) <= 45) tags.push('Lean spend');
  return tags.slice(0, 4);
}

function normalizeDirectivePhases(value: unknown): WorkflowBlockKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases = value
    .filter((phase): phase is WorkflowBlockKind => (
      phase === 'search' ||
      phase === 'query' ||
      phase === 'capture' ||
      phase === 'analyze' ||
      phase === 'summarize' ||
      phase === 'deliver' ||
      phase === 'note'
    ));
  return phases.length > 0 ? [...new Set(phases)] : undefined;
}

function formatDirectivePhaseScope(phases?: WorkflowBlockKind[]) {
  if (!phases || phases.length === 0) return 'All phases';
  if (phases.length === 1) return `${phases[0][0].toUpperCase()}${phases[0].slice(1)} only`;
  return phases.map((phase) => `${phase[0].toUpperCase()}${phase.slice(1)}`).join(' + ');
}

function formatDirectivePhaseShort(phase: WorkflowBlockKind) {
  switch (phase) {
    case 'search': return 'S';
    case 'query': return 'Q';
    case 'capture': return 'C';
    case 'analyze': return 'A';
    case 'summarize': return 'Sum';
    case 'deliver': return 'D';
    case 'note': return 'N';
    default: return '';
  }
}

function getPreferredRoleForPhase(phase: WorkflowBlockKind) {
  switch (phase) {
    case 'search':
    case 'query':
    case 'capture':
      return 'researcher';
    case 'analyze':
      return 'analyst';
    case 'summarize':
      return 'reviewer';
    case 'deliver':
    case 'note':
    default:
      return 'operator';
  }
}

function matchesExperimentRun(run: PlatformTaskRunRecord, experiment: StudioExperimentRecord) {
  const attribution = getRunExperimentAttribution(run);
  if (attribution.experimentId) return attribution.experimentId === experiment.id;
  return attribution.scenarioId === experiment.scenarioId && attribution.previewPresetId === experiment.previewPresetId;
}

function summarizeRunCollection(runs: PlatformTaskRunRecord[]) {
  if (runs.length === 0) {
    return {
      count: 0,
      successRate: 0,
      averageCredits: 0,
      averageDurationMs: 0,
      latestStatus: undefined as string | undefined,
    };
  }
  const succeeded = runs.filter((run) => run.status === 'succeeded').length;
  const totalCredits = runs.reduce((sum, run) => sum + (run.actualCredits || 0), 0);
  const totalDuration = runs.reduce((sum, run) => {
    const started = Date.parse(run.startedAt || '');
    const finished = Date.parse(run.finishedAt || '');
    return sum + (Number.isNaN(started) || Number.isNaN(finished) ? 0 : Math.max(0, finished - started));
  }, 0);
  return {
    count: runs.length,
    successRate: succeeded / runs.length,
    averageCredits: totalCredits / runs.length,
    averageDurationMs: totalDuration / runs.length,
    latestStatus: runs[0]?.status,
  };
}

function scoreObservedPerformance(
  stats: ReturnType<typeof summarizeRunCollection>,
  latestAt?: string,
) {
  const sampleConfidence = clampNumber(Math.round((Math.min(stats.count, 12) / 12) * 100), 8, 100);
  const latestTime = latestAt ? Date.parse(latestAt) : Number.NaN;
  const recencyDays = Number.isNaN(latestTime) ? 30 : Math.max(0, (Date.now() - latestTime) / 86400000);
  const recencyBoost = clampNumber(Math.round(18 - recencyDays), 0, 18);
  const stalePenalty = clampNumber(Math.round(Math.max(0, recencyDays - 10) * 0.8), 0, 24);
  const confidence = clampNumber(sampleConfidence - stalePenalty, 8, 100);
  const score = clampNumber(
    Math.round(
      stats.successRate * 72 +
      confidence * 0.18 +
      recencyBoost * 0.1 -
      stalePenalty * 0.8 -
      stats.averageCredits / 4 -
      stats.averageDurationMs / 20000
    ),
    0,
    99,
  );

  return {
    score,
    confidence,
    sampleConfidence,
    recencyBoost,
    stalePenalty,
    freshness: recencyDays > 21 ? 'stale' : recencyDays > 8 ? 'warm' : 'fresh',
  };
}

function countDirectiveEntries(roleDirectives?: Record<string, StudioRoleDirective>) {
  return Object.values(roleDirectives || {}).reduce((sum, directive) => sum + (directive.phases?.length || 1), 0);
}

function cloneRoleDirectives(roleDirectives?: Record<string, StudioRoleDirective>) {
  if (!roleDirectives) return undefined;
  return Object.entries(roleDirectives).reduce<Record<string, StudioRoleDirective>>((acc, [role, directive]) => {
    acc[role] = {
      mode: directive.mode,
      phases: directive.phases ? [...directive.phases] : undefined,
      updatedAt: directive.updatedAt,
    };
    return acc;
  }, {});
}

function clonePromotionHistory(history?: StudioPromotionRecord[]) {
  if (!history) return undefined;
  return history.map((entry) => ({ ...entry }));
}

function appendPromotionHistory(
  history: StudioPromotionRecord[] | undefined,
  entry: Omit<StudioPromotionRecord, 'id' | 'appliedAt' | 'actor'>,
) {
  return [
    {
      id: `promo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      appliedAt: new Date().toISOString(),
      actor: 'manual' as const,
      ...entry,
    },
    ...(clonePromotionHistory(history) || []),
  ].slice(0, 14);
}

function buildBranchName(sourceLabel: string, index: number) {
  return `${sourceLabel} branch ${index}`;
}

function getPromotionGateProfileById(id?: string) {
  return PROMOTION_GATE_PROFILES.find((profile) => profile.id === id);
}

function getAutoGraduationProfileById(id?: string) {
  return AUTO_GRADUATION_PROFILES.find((profile) => profile.id === id);
}

function inferAutoGraduationProfileIdFromThreshold(threshold: number) {
  const nearest = AUTO_GRADUATION_PROFILES
    .map((profile) => ({ profile, delta: Math.abs(profile.archetype - threshold) }))
    .sort((left, right) => left.delta - right.delta)[0];
  return nearest?.profile.id || 'balanced';
}

function getEffectiveAutoPromotionThreshold(
  studioState: AutomationStudioStateDraft | undefined,
  scenarioId: string,
  archetypeId: string,
) {
  const scenarioThreshold = studioState?.autoPromotionScenarioThresholds?.[scenarioId];
  if (typeof scenarioThreshold === 'number') return scenarioThreshold;
  const archetypeThreshold = studioState?.autoPromotionArchetypeThresholds?.[archetypeId];
  if (typeof archetypeThreshold === 'number') return archetypeThreshold;
  return studioState?.autoPromotionMinConfidence ?? 55;
}

function inferPromotionGateProfileId(
  studioState: AutomationStudioStateDraft | undefined,
  scenarioId: string,
  archetypeId: string,
) {
  const threshold = getEffectiveAutoPromotionThreshold(studioState, scenarioId, archetypeId);
  return PROMOTION_GATE_PROFILES
    .map((profile) => ({
      profile,
      delta:
        Math.abs(profile.global - threshold) +
        Math.abs(profile.archetype - threshold) * 0.6 +
        Math.abs(profile.scenario - threshold) * 0.9,
    }))
    .sort((left, right) => left.delta - right.delta)[0]?.profile.id || 'balanced';
}

function getEffectiveAutoGraduateThreshold(
  studioState: AutomationStudioStateDraft | undefined,
  scenarioId: string,
  archetypeId: string,
) {
  const scenarioThreshold = studioState?.autoGraduateScenarioThresholds?.[scenarioId];
  if (typeof scenarioThreshold === 'number') return scenarioThreshold;
  const archetypeThreshold = studioState?.autoGraduateArchetypeThresholds?.[archetypeId];
  if (typeof archetypeThreshold === 'number') return archetypeThreshold;
  return studioState?.autoGraduateMinConfidence ?? 72;
}

function getRecommendedAutoGraduationProfileId(
  archetypeId: string,
  scenarioId: string,
  reviewPolicy: ReviewPolicy,
) {
  if (scenarioId === 'high_stakes' || reviewPolicy === 'strict' || archetypeId === 'briefing') {
    return 'cautious';
  }
  if (scenarioId === 'monitoring' || archetypeId === 'ops') {
    return 'fast_learning';
  }
  return 'balanced';
}

function readWorkspaceAutoGraduationProfilesFallback(workspaceId: string) {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(`violema_agentstudio_auto_graduation_profiles_${workspaceId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.entries(parsed).reduce<Record<string, string>>((acc, [archetypeId, profileId]) => {
      if (typeof profileId !== 'string') return acc;
      if (!getAutoGraduationProfileById(profileId)) return acc;
      acc[archetypeId] = profileId;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function readAgentStudioGuideDismissed() {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(AGENT_STUDIO_GUIDE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAgentStudioGuideDismissed(value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      localStorage.setItem(AGENT_STUDIO_GUIDE_DISMISSED_KEY, '1');
    } else {
      localStorage.removeItem(AGENT_STUDIO_GUIDE_DISMISSED_KEY);
    }
  } catch {
    // Ignore storage failures so the guide can still work in-session.
  }
}

function normalizeThresholdMap(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const next = Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>((acc, [key, raw]) => {
    if (typeof raw !== 'number') return acc;
    acc[key] = clampNumber(Math.round(raw), 40, 95);
    return acc;
  }, {});
  return Object.keys(next).length > 0 ? next : undefined;
}

function omitThresholdKey(map: Record<string, number> | undefined, key: string) {
  if (!map) return undefined;
  const next = { ...map };
  delete next[key];
  return Object.keys(next).length > 0 ? next : undefined;
}

function buildReplayPhaseOverlay(
  run: PlatformTaskRunRecord | null | undefined,
  phaseEvidence: Array<{ phase: WorkflowBlockKind; runs: number; successRate: number; averageCredits: number; averageDurationMs: number; directiveModes: string[] }>,
): ReplayPhaseOverlayEntry[] {
  if (!run) return [];
  const phaseOrder: WorkflowBlockKind[] = ['search', 'query', 'capture', 'analyze', 'summarize', 'deliver', 'note'];
  const grouped = phaseOrder
    .map((phase) => {
      const steps = readStepExecutions(run.metadata?.stepExecutions).filter((step) => step.kind === phase);
      if (steps.length === 0) return null;
      const credits = steps.reduce((sum, step) => sum + (step.actualCredits || 0), 0);
      const durationMs = steps.reduce((sum, step) => sum + (step.durationMs || 0), 0);
      const tokens = steps.reduce((sum, step) => sum + (step.tokenUsage?.totalTokens || 0), 0);
      const failed = steps.some((step) => step.status === 'failed');
      const succeeded = steps.some((step) => step.status === 'succeeded');
      const primaryStep = steps
        .slice()
        .sort((left, right) => (right.actualCredits || 0) - (left.actualCredits || 0))[0];
      const baseline = phaseEvidence.find((entry) => entry.phase === phase);
      return {
        phase,
        steps,
        credits,
        durationMs,
        tokens,
        failed,
        succeeded,
        primaryRole: primaryStep?.assignedRole || getPreferredRoleForPhase(phase),
        modelSource: primaryStep?.modelSource,
        directiveMode: primaryStep?.directiveMode,
        baselineCredits: baseline?.averageCredits || 0,
        baselineDurationMs: baseline?.averageDurationMs || 0,
        baselineSuccessRate: baseline?.successRate || 0,
      };
    })
    .filter(Boolean) as Array<Omit<ReplayPhaseOverlayEntry, 'costWidth'>>;

  const maxCredits = Math.max(...grouped.map((item) => item.credits || 0), 1);
  return grouped.map((item) => ({
    ...item,
    costWidth: `${Math.max(16, ((item.credits || 0) / maxCredits) * 100)}%`,
  }));
}

function mergeRoleDirectiveSnapshots(
  base?: Record<string, StudioRoleDirective>,
  incoming?: Record<string, StudioRoleDirective>
) {
  return {
    ...(cloneRoleDirectives(base) || {}),
    ...(cloneRoleDirectives(incoming) || {}),
  };
}

function inferOperatingPlanIntent(
  policy: AutomationExecutionPolicyDraft,
  scenarioId: string,
  steps: WorkflowBlockDraft[],
) {
  const toolCalls = countWorkflowToolCalls(steps);
  if (scenarioId === 'rush') return 'Fast founder loop';
  if (scenarioId === 'monitoring' || (policy.optimizationGoal === 'cost_saver' && toolCalls >= 2)) return 'Low-cost monitoring';
  if (scenarioId === 'high_stakes' || policy.reviewPolicy === 'strict' || policy.optimizationGoal === 'quality_first') return 'High-assurance briefings';
  return 'Balanced execution';
}

function doesRunMatchPlan(run: PlatformTaskRunRecord, plan: StudioOperatingPlan) {
  return scoreRunPlanMatch(run, plan) >= 50;
}

function scoreRunPlanMatch(run: PlatformTaskRunRecord, plan: StudioOperatingPlan) {
  const attribution = getRunExperimentAttribution(run);
  const studioState = getRunStudioState(run);
  const telemetry = getRunScenarioTelemetry(run);
  const stepExecutions = readStepExecutions(run.metadata?.stepExecutions);
  let score = 0;

  if (plan.sourceExperimentId && attribution.experimentId) {
    if (attribution.experimentId === plan.sourceExperimentId) return 140;
    return 0;
  }

  if (attribution.scenarioId === plan.scenarioId) score += 28;
  if (attribution.previewPresetId === plan.previewPresetId) score += 28;
  if (studioState.selectedPlanId === plan.id) score += 38;

  const directiveEntries = Object.entries(plan.roleDirectives || {});
  if (directiveEntries.length === 0) {
    score += 6;
  } else {
    let directiveScore = 0;
    directiveEntries.forEach(([role, directive]) => {
      const telemetryMatch = telemetry.directedRoles?.find((item) => item.role === role);
      if (telemetryMatch) {
        directiveScore += telemetryMatch.mode === directive.mode ? 12 : 4;
        const planPhases = directive.phases || [];
        const telemetryPhases = telemetryMatch.phases || [];
        if (planPhases.length === 0 || telemetryPhases.length === 0) {
          directiveScore += 4;
        } else {
          const overlap = planPhases.filter((phase) => telemetryPhases.includes(phase)).length;
          directiveScore += overlap * 4;
        }
      }

      const stepMatch = stepExecutions.some((step) => {
        if (step.assignedRole !== role || step.directiveMode !== directive.mode) return false;
        if (!directive.phases || directive.phases.length === 0) return true;
        return directive.phases.includes(step.kind as WorkflowBlockKind);
      });
      if (stepMatch) directiveScore += 8;
    });
    score += Math.min(28, directiveScore);
  }

  return score;
}

function rankRunPlanMatches(run: PlatformTaskRunRecord, plans: StudioOperatingPlan[]) {
  return plans
    .map((plan) => ({ plan, score: scoreRunPlanMatch(run, plan) }))
    .filter((entry) => entry.score >= 40)
    .sort((left, right) => right.score - left.score);
}

function deriveWorkflowStepsFromAutomation(automation: AutomationApiRecord): WorkflowBlockDraft[] {
  if (Array.isArray(automation.steps) && automation.steps.length > 0) {
    return automation.steps;
  }
  if (automation.authoring_mode === 'describe') {
    return buildWorkflowBlocksFromPrompt(automation.workflow_prompt);
  }
  return (automation.actions || []).map((action) => parseLegacyActionToWorkflowBlock(action));
}

function buildPhaseActivitySeries(runs: PlatformTaskRunRecord[], role: string) {
  const relevantRuns = runs.filter((run) => run.status === 'succeeded' || run.status === 'failed').slice(0, 8).reverse();
  const phaseOrder: WorkflowBlockKind[] = ['search', 'query', 'capture', 'analyze', 'summarize', 'deliver'];
  const series = relevantRuns.map((run, index) => {
    const stepExecutions = readStepExecutions(run.metadata?.stepExecutions).filter((step) => step.assignedRole === role);
    const phases = phaseOrder.map((phase) => {
      const phaseSteps = stepExecutions.filter((step) => step.kind === phase);
      const credits = phaseSteps.reduce((sum, step) => sum + (step.actualCredits || 0), 0);
      return {
        phase,
        count: phaseSteps.length,
        failed: phaseSteps.some((step) => step.status === 'failed'),
        succeeded: phaseSteps.some((step) => step.status === 'succeeded'),
        credits,
      };
    }).filter((phase) => phase.count > 0);
    return {
      id: run.id,
      label: `R${index + 1}`,
      phases,
    };
  });
  return series;
}

function buildTrendSeries(
  runs: PlatformTaskRunRecord[],
  metric: TrendMetric,
  width = 320,
  height = 130,
  maxPoints = 8,
) {
  const ordered = runs.slice(0, maxPoints).reverse();
  if (ordered.length === 0) return null;
  const paddingX = 18;
  const paddingY = 14;
  const values = ordered.map((run) => getTrendMetricValue(run, metric));
  const minValue = metric === 'success' ? 0 : Math.min(...values, 0);
  const maxValue = Math.max(...values, 1);
  const range = Math.max(maxValue - minValue, 1);

  const points = ordered.map((run, index) => {
    const ratio = ordered.length === 1 ? 0.5 : index / (ordered.length - 1);
    const x = paddingX + ratio * (width - paddingX * 2);
    const y = height - paddingY - (((getTrendMetricValue(run, metric) - minValue) / range) * (height - paddingY * 2));
    return {
      run,
      x,
      y,
      label: ordered.length === 1 ? 'Latest' : `R${index + 1}`,
      metricLabel: formatTrendMetricValue(run, metric),
    };
  });

  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${height - paddingY} L ${points[0].x} ${height - paddingY} Z`;

  return { width, height, points, linePath, areaPath, minValue, maxValue };
}

function getDirectiveModeLabel(mode: 'cheaper' | 'review' | 'promote') {
  if (mode === 'cheaper') return 'Cheaper bias';
  if (mode === 'review') return 'Review bias';
  return 'Promoted lane';
}

function getPromotionModeLabel(mode: StudioPromotionRecord['mode']) {
  switch (mode) {
    case 'preset':
      return 'Preset promoted';
    case 'steering':
      return 'Steering promoted';
    case 'full':
      return 'Full setup promoted';
    case 'phase':
      return 'Phase promoted';
    case 'preset_phase':
      return 'Preset + phase promoted';
    case 'learning':
    default:
      return 'Learning action';
    case 'graduation':
      return 'Branch graduated';
    case 'rollback':
      return 'Branch rolled back';
  }
}

function getPromotionModeTone(mode: StudioPromotionRecord['mode']) {
  switch (mode) {
    case 'full':
    case 'preset_phase':
      return 'border-emerald-500/18 bg-emerald-500/8 text-emerald-100';
    case 'preset':
    case 'phase':
      return 'border-cyan-500/18 bg-cyan-500/8 text-cyan-100';
    case 'steering':
      return 'border-violet-500/18 bg-violet-500/8 text-violet-100';
    case 'graduation':
      return 'border-emerald-500/18 bg-emerald-500/8 text-emerald-100';
    case 'rollback':
      return 'border-red-500/18 bg-red-500/8 text-red-100';
    case 'learning':
    default:
      return 'border-amber-500/18 bg-amber-500/8 text-amber-100';
  }
}

function getRunExperimentAttribution(run?: PlatformTaskRunRecord): RunExperimentAttribution {
  const raw = isRecord(run?.metadata?.experimentAttribution) ? run?.metadata?.experimentAttribution : undefined;
  const fallbackStudioState = getRunStudioState(run);
  const scenarioId = readString(raw?.scenarioId) || fallbackStudioState.selectedScenarioId || 'baseline';
  const previewPresetId = readString(raw?.previewPresetId) || fallbackStudioState.previewPresetId || 'recommended';
  return {
    experimentId: readString(raw?.experimentId),
    experimentCreatedAt: readString(raw?.experimentCreatedAt),
    experimentNotes: readString(raw?.experimentNotes),
    matchedSavedExperiment: raw?.matchedSavedExperiment === true,
    scenarioId,
    scenarioLabel: readString(raw?.scenarioLabel) || getScenarioLabelFromId(scenarioId),
    previewPresetId,
    previewPresetLabel: readString(raw?.previewPresetLabel) || getPresetLabelFromId(previewPresetId),
  };
}

function getRunScenarioTelemetry(run?: PlatformTaskRunRecord): RunScenarioTelemetry {
  const raw = isRecord(run?.metadata?.scenarioTelemetry) ? run?.metadata?.scenarioTelemetry : undefined;
  const attribution = getRunExperimentAttribution(run);
  const directedRoles = Array.isArray(raw?.directedRoles)
    ? raw.directedRoles
        .map((item) => {
          if (!isRecord(item)) return null;
          const role = readString(item.role);
          if (!role) return null;
          const mode = item.mode === 'cheaper' || item.mode === 'review' || item.mode === 'promote' ? item.mode : undefined;
          if (!mode) return null;
          return {
            role,
            mode: mode as 'cheaper' | 'review' | 'promote',
            phases: normalizeDirectivePhases(item.phases),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : undefined;

  return {
    scenarioId: readString(raw?.scenarioId) || attribution.scenarioId,
    scenarioLabel: readString(raw?.scenarioLabel) || attribution.scenarioLabel,
    previewPresetId: readString(raw?.previewPresetId) || attribution.previewPresetId,
    previewPresetLabel: readString(raw?.previewPresetLabel) || attribution.previewPresetLabel,
    matchedSavedExperiment: raw?.matchedSavedExperiment === true || attribution.matchedSavedExperiment,
    experimentId: readString(raw?.experimentId) || attribution.experimentId,
    workflowStepCount: typeof raw?.workflowStepCount === 'number' ? raw.workflowStepCount : undefined,
    estimatedToolCalls: typeof raw?.estimatedToolCalls === 'number' ? raw.estimatedToolCalls : undefined,
    complexity: readString(raw?.complexity),
    directedRoles,
  };
}

function buildRadarPolygon(values: number[], radius: number, cx: number, cy: number) {
  return values
    .map((value, index) => {
      const angle = (-Math.PI / 2) + (index / values.length) * Math.PI * 2;
      const scaled = (Math.max(0, Math.min(100, value)) / 100) * radius;
      const x = cx + Math.cos(angle) * scaled;
      const y = cy + Math.sin(angle) * scaled;
      return `${x},${y}`;
    })
    .join(' ');
}

function simulateScenarioMath(
  base: ReturnType<typeof inferExecutionPolicyMath>,
  scenario: (typeof SCENARIO_PRESETS)[number]
) {
  const stepCount = Math.max(1, Math.round(base.stepCount * scenario.stepMultiplier));
  const toolCalls = Math.max(0, Math.round(base.toolCalls * scenario.toolMultiplier));
  const reasoningLoad = Math.max(0.5, Number(base.reasoningLoad) + scenario.reasoningDelta);
  const recommendedElasticLanes = stepCount >= 8 || reasoningLoad >= 8 ? 3 : stepCount >= 5 || toolCalls >= 3 ? 2 : 1;
  return {
    stepCount,
    toolCalls,
    reasoningLoad: reasoningLoad.toFixed(1),
    recommendedElasticLanes,
  };
}

function classifyWorkflowArchetype(steps: WorkflowBlockDraft[]) {
  const kinds = new Set(steps.filter((step) => workflowBlockHasContent(step)).map((step) => step.kind));
  if (kinds.has('deliver') && (kinds.has('search') || kinds.has('query'))) {
    return {
      id: 'briefing',
      label: 'Briefing and delivery',
      summary: 'Research-heavy workflows that need a polished output and a final delivery step.',
    };
  }
  if (kinds.has('search') || kinds.has('query')) {
    return {
      id: 'research',
      label: 'Research and monitoring',
      summary: 'Source gathering, scanning, and current-state intelligence work.',
    };
  }
  if (kinds.has('capture') || kinds.has('analyze')) {
    return {
      id: 'analysis',
      label: 'Analysis and diagnosis',
      summary: 'Workflows that turn findings into decisions, comparisons, or technical diagnosis.',
    };
  }
  if (kinds.has('deliver')) {
    return {
      id: 'ops',
      label: 'Ops and follow-through',
      summary: 'Operational loops focused on delivery, alerts, and recurring follow-through.',
    };
  }
  return {
    id: 'general',
    label: 'General execution',
    summary: 'Mixed workflow with a blend of reasoning, coordination, and output generation.',
  };
}

function normalizeStudioState(value: unknown): AutomationStudioStateDraft {
  if (!isRecord(value)) return {};
  const savedPlans = Array.isArray(value.savedPlans)
    ? value.savedPlans
        .map((item) => {
          if (!isRecord(item)) return null;
          const id = readString(item.id);
          const name = readString(item.name);
          const createdAt = readString(item.createdAt);
          const scenarioId = readString(item.scenarioId);
          const previewPresetId = readString(item.previewPresetId);
          if (!id || !name || !createdAt || !scenarioId || !previewPresetId) return null;
          const plan: StudioOperatingPlan = {
            id,
            name,
            createdAt,
            scenarioId,
            previewPresetId,
            executionPolicy: normalizeExecutionPolicy(item.executionPolicy),
            roleDirectives: isRecord(item.roleDirectives)
              ? Object.entries(item.roleDirectives).reduce<Record<string, StudioRoleDirective>>((directiveAcc, [role, directive]) => {
                  if (!isRecord(directive)) return directiveAcc;
                  if (directive.mode !== 'cheaper' && directive.mode !== 'review' && directive.mode !== 'promote') return directiveAcc;
                  const updatedAt = readString(directive.updatedAt);
                  if (!updatedAt) return directiveAcc;
                  directiveAcc[role] = { mode: directive.mode, phases: normalizeDirectivePhases(directive.phases), updatedAt };
                  return directiveAcc;
                }, {})
              : undefined,
            intentLabel: readString(item.intentLabel),
            parentPlanId: readString(item.parentPlanId),
            sourceExperimentId: readString(item.sourceExperimentId),
            sourceExperimentLabel: readString(item.sourceExperimentLabel),
            notes: readString(item.notes),
          };
          return plan;
        })
        .filter((item): item is StudioOperatingPlan => Boolean(item))
    : undefined;

  const experimentHistory = Array.isArray(value.experimentHistory)
    ? value.experimentHistory
        .map((item) => {
          if (!isRecord(item)) return null;
          const id = readString(item.id);
          const scenarioId = readString(item.scenarioId);
          const previewPresetId = readString(item.previewPresetId);
          const createdAt = readString(item.createdAt);
          if (!id || !scenarioId || !previewPresetId || !createdAt) return null;
          return {
            id,
            scenarioId,
            previewPresetId,
            createdAt,
            notes: readString(item.notes),
            branchName: readString(item.branchName),
            parentExperimentId: readString(item.parentExperimentId),
            roleDirectives: isRecord(item.roleDirectives)
              ? Object.entries(item.roleDirectives).reduce<Record<string, StudioRoleDirective>>((directiveAcc, [role, directive]) => {
                  if (!isRecord(directive)) return directiveAcc;
                  if (directive.mode !== 'cheaper' && directive.mode !== 'review' && directive.mode !== 'promote') return directiveAcc;
                  const updatedAt = readString(directive.updatedAt);
                  if (!updatedAt) return directiveAcc;
                  directiveAcc[role] = { mode: directive.mode, phases: normalizeDirectivePhases(directive.phases), updatedAt };
                  return directiveAcc;
                }, {})
              : undefined,
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : undefined;

  const promotionHistory = Array.isArray(value.promotionHistory)
    ? value.promotionHistory
        .map((item) => {
          if (!isRecord(item)) return null;
          const id = readString(item.id);
          const appliedAt = readString(item.appliedAt);
          const summary = readString(item.summary);
          const actor = readString(item.actor);
          const mode = readString(item.mode);
          if (
            !id ||
            !appliedAt ||
            !summary ||
            actor !== 'manual' ||
            !mode ||
            !['preset', 'steering', 'full', 'phase', 'preset_phase', 'learning', 'graduation', 'rollback'].includes(mode)
          ) {
            return null;
          }
          const phaseValue = readString(item.phase);
          return {
            id,
            appliedAt,
            summary,
            actor: 'manual' as const,
            mode: mode as StudioPromotionRecord['mode'],
            sourceExperimentId: readString(item.sourceExperimentId),
            sourceExperimentLabel: readString(item.sourceExperimentLabel),
            planId: readString(item.planId),
            parentPlanId: readString(item.parentPlanId),
            autoApplied: item.autoApplied === true,
            confidence: typeof item.confidence === 'number' ? clampNumber(Math.round(item.confidence), 0, 100) : undefined,
            successDelta: typeof item.successDelta === 'number' ? Math.round(item.successDelta) : undefined,
            creditsDelta: typeof item.creditsDelta === 'number' ? Math.round(item.creditsDelta) : undefined,
            durationDelta: typeof item.durationDelta === 'number' ? Math.round(item.durationDelta) : undefined,
            phase: phaseValue && ['search', 'query', 'capture', 'analyze', 'summarize', 'deliver', 'note'].includes(phaseValue)
              ? phaseValue as WorkflowBlockKind
              : undefined,
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : undefined;

  const roleDirectives = isRecord(value.roleDirectives)
    ? Object.entries(value.roleDirectives).reduce<Record<string, StudioRoleDirective>>((acc, [role, directive]) => {
        if (!isRecord(directive)) return acc;
        if (directive.mode !== 'cheaper' && directive.mode !== 'review' && directive.mode !== 'promote') return acc;
        const updatedAt = readString(directive.updatedAt);
        if (!updatedAt) return acc;
        acc[role] = { mode: directive.mode, phases: normalizeDirectivePhases(directive.phases), updatedAt };
        return acc;
      }, {})
    : undefined;

  return {
    activeRoom: value.activeRoom === 'live' || value.activeRoom === 'optimize' || value.activeRoom === 'replay'
      ? value.activeRoom
      : undefined,
    selectedScenarioId: readString(value.selectedScenarioId),
    previewPresetId: readString(value.previewPresetId),
    selectedPlanId: readString(value.selectedPlanId),
    selectedPlanCompareId: readString(value.selectedPlanCompareId),
    selectedPlanFamilyRootId: readString(value.selectedPlanFamilyRootId),
    selectedPlanIntentFilter: readString(value.selectedPlanIntentFilter),
    selectedReplayPhase:
      value.selectedReplayPhase === 'all' ||
      value.selectedReplayPhase === 'search' ||
      value.selectedReplayPhase === 'query' ||
      value.selectedReplayPhase === 'capture' ||
      value.selectedReplayPhase === 'analyze' ||
      value.selectedReplayPhase === 'summarize' ||
      value.selectedReplayPhase === 'deliver' ||
      value.selectedReplayPhase === 'note'
        ? value.selectedReplayPhase
        : undefined,
    selectedWorkerRole: readString(value.selectedWorkerRole),
    selectedDirectivePhase:
      value.selectedDirectivePhase === 'all' ||
      value.selectedDirectivePhase === 'search' ||
      value.selectedDirectivePhase === 'query' ||
      value.selectedDirectivePhase === 'capture' ||
      value.selectedDirectivePhase === 'analyze' ||
      value.selectedDirectivePhase === 'summarize' ||
      value.selectedDirectivePhase === 'deliver' ||
      value.selectedDirectivePhase === 'note'
        ? value.selectedDirectivePhase
        : undefined,
    selectedComparisonExperimentId: readString(value.selectedComparisonExperimentId),
    selectedCohortRunId: readString(value.selectedCohortRunId),
    selectedReplayCompareRunId: readString(value.selectedReplayCompareRunId),
    selectedBranchRootId: readString(value.selectedBranchRootId),
    comparedBranchRootId: readString(value.comparedBranchRootId),
    pinnedSuggestedPlanId: readString(value.pinnedSuggestedPlanId),
    dismissedSuggestedPlanId: readString(value.dismissedSuggestedPlanId),
    autoGraduateEnabled: value.autoGraduateEnabled === true ? true : undefined,
    autoGraduateMinConfidence:
      typeof value.autoGraduateMinConfidence === 'number'
        ? clampNumber(Math.round(value.autoGraduateMinConfidence), 40, 95)
        : undefined,
    autoGraduateScenarioThresholds: normalizeThresholdMap(value.autoGraduateScenarioThresholds),
    autoGraduateArchetypeThresholds: normalizeThresholdMap(value.autoGraduateArchetypeThresholds),
    lastAutoGraduatedPlanId: readString(value.lastAutoGraduatedPlanId),
    autoRollbackEnabled: value.autoRollbackEnabled === true ? true : undefined,
    autoRollbackWeaknessThreshold:
      typeof value.autoRollbackWeaknessThreshold === 'number'
        ? clampNumber(Math.round(value.autoRollbackWeaknessThreshold), 4, 30)
        : undefined,
    lastAutoRolledBackPlanId: readString(value.lastAutoRolledBackPlanId),
    trendMetric:
      value.trendMetric === 'credits' || value.trendMetric === 'duration' || value.trendMetric === 'success'
        ? value.trendMetric
        : undefined,
    gateLearningWindow:
      value.gateLearningWindow === 'recent' || value.gateLearningWindow === 'deep' || value.gateLearningWindow === 'all'
        ? value.gateLearningWindow
        : undefined,
    branchRunFilter:
      value.branchRunFilter === 'all' || value.branchRunFilter === 'succeeded' || value.branchRunFilter === 'failed'
        ? value.branchRunFilter
        : undefined,
    phaseSimulation:
      isRecord(value.phaseSimulation) &&
      (value.phaseSimulation.phase === 'search' ||
        value.phaseSimulation.phase === 'query' ||
        value.phaseSimulation.phase === 'capture' ||
        value.phaseSimulation.phase === 'analyze' ||
        value.phaseSimulation.phase === 'summarize' ||
        value.phaseSimulation.phase === 'deliver' ||
        value.phaseSimulation.phase === 'note') &&
      (value.phaseSimulation.mode === 'cheaper' || value.phaseSimulation.mode === 'review' || value.phaseSimulation.mode === 'promote')
        ? { phase: value.phaseSimulation.phase, mode: value.phaseSimulation.mode }
        : undefined,
    experimentHistory,
    roleDirectives,
    promotionHistory,
    autoPromotionMinConfidence:
      typeof value.autoPromotionMinConfidence === 'number'
        ? clampNumber(Math.round(value.autoPromotionMinConfidence), 40, 95)
        : undefined,
    autoPromotionScenarioThresholds: normalizeThresholdMap(value.autoPromotionScenarioThresholds),
    autoPromotionArchetypeThresholds: normalizeThresholdMap(value.autoPromotionArchetypeThresholds),
    savedPlans,
  };
}

function deriveFallbackWorkerTopology(steps: WorkflowBlockDraft[], policy: AutomationExecutionPolicyDraft): DashboardWorkerTopology {
  const math = inferExecutionPolicyMath(policy, steps);
  const activeRoles = new Set<string>(['nexus', 'operator']);

  if (steps.some((step) => step.kind === 'search' || step.kind === 'query' || step.kind === 'capture')) activeRoles.add('researcher');
  if (steps.some((step) => step.kind === 'analyze')) activeRoles.add('analyst');
  if (steps.some((step) => step.kind === 'summarize')) activeRoles.add('reviewer');
  if (steps.some((step) => step.kind === 'deliver')) activeRoles.add('messenger');

  const elasticToActivate = ['writer', 'scheduler', 'messenger', 'monitor'].slice(0, math.activeElasticLanes);
  elasticToActivate.forEach((role) => activeRoles.add(role));

  const workers = WORKER_DEFINITIONS.map((worker) => ({
    role: worker.role,
    label: worker.label,
    laneType: worker.laneType,
    assignedRole: worker.role === 'nexus' ? 'manager' : worker.role,
    band: worker.preferredBand,
    modelLabel: worker.modelLabel,
    status: activeRoles.has(worker.role) ? 'active' : 'standby',
    summary: worker.summary,
    reason: activeRoles.has(worker.role)
      ? worker.laneType === 'elastic'
        ? 'Activated by the current workflow math and cost policy.'
        : 'Resident specialist engaged for this workflow.'
      : 'Standing by until the manager needs more depth or throughput.',
  })) as DashboardWorkerCard[];

  return {
    version: 'violema-10',
    primaryRole: 'nexus',
    primaryBand: 'default',
    workers,
    summary: 'Fallback topology preview based on workflow math. Live runs will replace this with actual worker activation history.',
  };
}

export default function AgentStudio() {
  const navigate = useNavigate();
  const location = useLocation();
  const workspace = useMemo(() => resolveWorkspaceContext(), []);
  const [activeRoom, setActiveRoom] = useState<StudioRoom>('live');
  const [showLiveAdvanced, setShowLiveAdvanced] = useState(false);
  const [showOptimizeAdvanced, setShowOptimizeAdvanced] = useState(false);
  const [showReplayAdvanced, setShowReplayAdvanced] = useState(false);
  const [showStudioGuide, setShowStudioGuide] = useState(() => !readAgentStudioGuideDismissed());
  const [selectedWorkerRole, setSelectedWorkerRole] = useState<string>('nexus');
  const [selectedScenarioId, setSelectedScenarioId] = useState<ScenarioPresetId>('baseline');
  const [selectedPlanId, setSelectedPlanId] = useState<string>('');
  const [selectedPlanCompareId, setSelectedPlanCompareId] = useState<string>('');
  const [selectedPlanFamilyRootId, setSelectedPlanFamilyRootId] = useState<string>('');
  const [selectedPlanIntentFilter, setSelectedPlanIntentFilter] = useState<string>('all');
  const [selectedReplayPhase, setSelectedReplayPhase] = useState<'all' | WorkflowBlockKind>('all');
  const [selectedDirectivePhase, setSelectedDirectivePhase] = useState<'all' | WorkflowBlockKind>('all');
  const [selectedComparisonExperimentId, setSelectedComparisonExperimentId] = useState<string>('');
  const [selectedBranchRootId, setSelectedBranchRootId] = useState<string>('');
  const [comparedBranchRootId, setComparedBranchRootId] = useState<string>('');
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('credits');
  const [gateLearningWindow, setGateLearningWindow] = useState<GateLearningWindow>('deep');
  const [branchRunFilter, setBranchRunFilter] = useState<BranchRunFilter>('all');
  const [selectedCohortRunId, setSelectedCohortRunId] = useState<string>('');
  const [selectedReplayCompareRunId, setSelectedReplayCompareRunId] = useState<string>('');
  const [hoveredCohortRunId, setHoveredCohortRunId] = useState<string>('');
  const [phaseSimulation, setPhaseSimulation] = useState<{ phase: WorkflowBlockKind; mode: 'cheaper' | 'review' | 'promote' } | null>(null);
  const [workspaceAutoGraduationProfiles, setWorkspaceAutoGraduationProfiles] = useState<Record<string, string>>({});
  const [workspaceAutoRollbackDefaults, setWorkspaceAutoRollbackDefaults] = useState<{ enabled: boolean; weaknessThreshold: number }>({
    enabled: false,
    weaknessThreshold: 12,
  });
  const [workspaceAutoRollbackMomentumThreshold, setWorkspaceAutoRollbackMomentumThreshold] = useState(6);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rows, setRows] = useState<AgentStudioRow[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string>('');
  const [previewPresetId, setPreviewPresetId] = useState<string>('recommended');
  const [actionBusy, setActionBusy] = useState(false);
  const [experimentSaveBusy, setExperimentSaveBusy] = useState(false);
  const [operationalContext, setOperationalContext] = useState<AgentStudioOperationalContext | null>(null);
  const [operationalContextLoading, setOperationalContextLoading] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const hydratedAutomationIdRef = useRef<string>('');

  const openStudioGuide = useCallback(() => {
    setShowStudioGuide(true);
    writeAgentStudioGuideDismissed(false);
  }, []);

  const dismissStudioGuide = useCallback(() => {
    setShowStudioGuide(false);
    writeAgentStudioGuideDismissed(true);
  }, []);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const headers = {
        'X-Workspace-Id': workspace.workspaceId,
        'X-Workspace-Name': workspace.workspaceName,
      };

      const [studioPayload, settingsPayload] = await Promise.all([
        fetch('/api/studio/workflows', { headers }).then((res) => (res.ok ? res.json() : Promise.reject(new Error('studio')))),
        fetch(`/api/settings?workspace_id=${encodeURIComponent(workspace.workspaceId)}&workspace_name=${encodeURIComponent(workspace.workspaceName)}`, { headers }).then((res) => (res.ok ? res.json() : Promise.reject(new Error('settings')))),
      ]);

      const studioItems = Array.isArray(studioPayload?.items) ? studioPayload.items as AgentStudioRow[] : [];
      const settings = settingsPayload as AgentStudioSettingsPayload;
      const backendProfiles = settings?.settings?.agentStudio?.autoGraduationProfiles || {};
      const nextWorkspaceProfiles = Object.keys(backendProfiles).length > 0
        ? backendProfiles
        : readWorkspaceAutoGraduationProfilesFallback(workspace.workspaceId);
      setWorkspaceAutoGraduationProfiles(nextWorkspaceProfiles);
      setWorkspaceAutoRollbackDefaults({
        enabled: settings?.settings?.agentStudio?.autoRollbackEnabled === true,
        weaknessThreshold: settings?.settings?.agentStudio?.autoRollbackWeaknessThreshold ?? 12,
      });
      setWorkspaceAutoRollbackMomentumThreshold(settings?.settings?.agentStudio?.autoRollbackMomentumThreshold ?? 6);

      const nextRows = studioItems
        .map((row) => ({
          ...row,
          runs: Array.isArray(row.runs) ? row.runs : [],
          stepExecutions: readStepExecutions(row.stepExecutions),
          workerTopology: readWorkerTopology(row.workerTopology),
          workflowSteps: Array.isArray(row.workflowSteps) && row.workflowSteps.length > 0
            ? row.workflowSteps
            : deriveWorkflowStepsFromAutomation(row.automation),
        } satisfies AgentStudioRow))
        .sort((a, b) => {
          const aTime = Date.parse(a.automation.next_run_at || a.latestRun?.finishedAt || a.automation.created_at || '');
          const bTime = Date.parse(b.automation.next_run_at || b.latestRun?.finishedAt || b.automation.created_at || '');
          return bTime - aTime;
        });

      setRows(nextRows);
      setSelectedAutomationId((current) => {
        const params = new URLSearchParams(location.search);
        const fromQuery = params.get('automation');
        if (fromQuery && nextRows.some((row) => row.automation.id === fromQuery)) return fromQuery;
        if (current && nextRows.some((row) => row.automation.id === current)) return current;
        return nextRows[0]?.automation.id || '';
      });
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }, [location.search, workspace.workspaceId, workspace.workspaceName]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const streamUrl = `/api/platform/stream?workspace_id=${encodeURIComponent(workspace.workspaceId)}&workspace_name=${encodeURIComponent(workspace.workspaceName)}`;
    const source = new EventSource(streamUrl);
    source.onmessage = () => {
      void loadData(true);
    };
    return () => source.close();
  }, [loadData, workspace.workspaceId, workspace.workspaceName]);

  const selectedRow = useMemo(
    () => rows.find((row) => row.automation.id === selectedAutomationId) || rows[0],
    [rows, selectedAutomationId]
  );

  const selectedPolicy = useMemo(
    () => normalizeExecutionPolicy(selectedRow?.automation.execution_policy),
    [selectedRow]
  );

  const selectedStudioState = useMemo(
    () => normalizeStudioState(selectedRow?.automation.studio_state),
    [selectedRow]
  );

  const selectedMath = useMemo(
    () => inferExecutionPolicyMath(selectedPolicy, selectedRow?.workflowSteps || []),
    [selectedPolicy, selectedRow]
  );

  const selectedTopology = useMemo(
    () => selectedRow?.workerTopology || deriveFallbackWorkerTopology(selectedRow?.workflowSteps || [], selectedPolicy),
    [selectedPolicy, selectedRow]
  );

  const workflowBenchmarks = useMemo(() => {
    const maxAverageCredits = Math.max(...rows.map((row) => row.averageCredits || 0), 1);
    const selectedId = selectedRow?.automation.id;
    const ordered = rows.slice().sort((a, b) => {
      if (a.automation.id === selectedId) return -1;
      if (b.automation.id === selectedId) return 1;
      return b.successRate - a.successRate || a.averageCredits - b.averageCredits;
    });

    return ordered.slice(0, 6).map((row) => ({
      id: row.automation.id,
      name: row.automation.name,
      successRate: Math.round(row.successRate * 100),
      costWidth: `${Math.max(8, ((row.averageCredits || 0) / maxAverageCredits) * 100)}%`,
      averageCredits: row.averageCredits,
      lastStatus: row.latestRun?.status || row.automation.last_run_status || row.automation.status,
      stepCount: row.workflowSteps.length,
      isSelected: row.automation.id === selectedId,
    }));
  }, [rows, selectedRow]);

  const selectedRunTrend = useMemo(() => {
    if (!selectedRow) return [];
    const recentRuns = selectedRow.runs.slice(0, 6).reverse();
    const maxValue = Math.max(...recentRuns.map((run) => getTrendMetricValue(run, trendMetric)), 1);

    return recentRuns.map((run, index) => ({
      id: run.id,
      label: recentRuns.length === 1 ? 'Latest' : `Run ${index + 1}`,
      credits: run.actualCredits || 0,
      metricValue: getTrendMetricValue(run, trendMetric),
      metricLabel: formatTrendMetricValue(run, trendMetric),
      height: `${Math.max(18, (getTrendMetricValue(run, trendMetric) / maxValue) * 100)}%`,
      status: run.status,
      statusTone: getStatusTone(run.status),
      duration: formatCompactDuration(
        Number.isNaN(Date.parse(run.startedAt || '')) || Number.isNaN(Date.parse(run.finishedAt || ''))
          ? undefined
          : Math.max(0, Date.parse(run.finishedAt || '') - Date.parse(run.startedAt || ''))
      ),
    }));
  }, [selectedRow, trendMetric]);


  const presetComparisons = useMemo(() => {
    const steps = selectedRow?.workflowSteps || [];
    return POLICY_PRESETS.map((preset) => {
      const math = inferExecutionPolicyMath(preset.policy, steps);
      return {
        ...preset,
        math,
        spendIndex: estimatePolicySpendIndex(preset.policy, steps),
        assuranceIndex: estimatePolicyAssuranceIndex(preset.policy, steps),
        fitIndex: estimatePolicyFitIndex(preset.policy, steps),
        isActive:
          preset.policy.mode === selectedPolicy.mode &&
          preset.policy.optimizationGoal === selectedPolicy.optimizationGoal &&
          preset.policy.reviewPolicy === selectedPolicy.reviewPolicy &&
          preset.policy.maxElasticLanes === selectedPolicy.maxElasticLanes,
      };
    });
  }, [selectedPolicy, selectedRow]);

  const activePresetId = useMemo(() => {
    const match = POLICY_PRESETS.find((preset) =>
      preset.policy.mode === selectedPolicy.mode &&
      preset.policy.optimizationGoal === selectedPolicy.optimizationGoal &&
      preset.policy.reviewPolicy === selectedPolicy.reviewPolicy &&
      preset.policy.maxElasticLanes === selectedPolicy.maxElasticLanes
    );
    return match?.id || 'custom_live';
  }, [selectedPolicy]);

  useEffect(() => {
    setPreviewPresetId(activePresetId === 'custom_live' ? 'recommended' : activePresetId);
  }, [activePresetId, selectedRow?.automation.id]);

  useEffect(() => {
    const automationId = selectedRow?.automation.id || '';
    if (!automationId) {
      hydratedAutomationIdRef.current = '';
      return;
    }
    if (hydratedAutomationIdRef.current === automationId) return;
    hydratedAutomationIdRef.current = automationId;
    setActiveRoom(selectedStudioState.activeRoom || 'live');
    setSelectedPlanId(selectedStudioState.selectedPlanId || '');
    setSelectedPlanCompareId(selectedStudioState.selectedPlanCompareId || '');
    setSelectedPlanFamilyRootId(selectedStudioState.selectedPlanFamilyRootId || '');
    setSelectedPlanIntentFilter(selectedStudioState.selectedPlanIntentFilter || 'all');
    setSelectedReplayPhase(selectedStudioState.selectedReplayPhase || 'all');
    setSelectedWorkerRole(selectedStudioState.selectedWorkerRole || 'nexus');
    setSelectedDirectivePhase(selectedStudioState.selectedDirectivePhase || 'all');
    setHoveredCohortRunId('');
    setPhaseSimulation(selectedStudioState.phaseSimulation || null);
    setSelectedComparisonExperimentId(selectedStudioState.selectedComparisonExperimentId || '');
    setSelectedCohortRunId(selectedStudioState.selectedCohortRunId || '');
    setSelectedReplayCompareRunId(selectedStudioState.selectedReplayCompareRunId || '');
    setSelectedBranchRootId(selectedStudioState.selectedBranchRootId || '');
    setComparedBranchRootId(selectedStudioState.comparedBranchRootId || '');
    setTrendMetric(selectedStudioState.trendMetric || 'credits');
    setGateLearningWindow(selectedStudioState.gateLearningWindow || 'deep');
    setBranchRunFilter(selectedStudioState.branchRunFilter || 'all');
    setSelectedScenarioId(
      selectedStudioState.selectedScenarioId && SCENARIO_PRESETS.some((scenario) => scenario.id === selectedStudioState.selectedScenarioId)
        ? selectedStudioState.selectedScenarioId as ScenarioPresetId
        : 'baseline'
    );
    if (selectedStudioState.previewPresetId && POLICY_PRESETS.some((preset) => preset.id === selectedStudioState.previewPresetId)) {
      setPreviewPresetId(selectedStudioState.previewPresetId);
    } else {
      setPreviewPresetId(activePresetId === 'custom_live' ? 'recommended' : activePresetId);
    }
  }, [activePresetId, selectedRow?.automation.id, selectedStudioState]);

  const previewPreset = useMemo(
    () => POLICY_PRESETS.find((preset) => preset.id === previewPresetId) || POLICY_PRESETS[0],
    [previewPresetId]
  );

  const selectedScenario = useMemo(
    () => getScenarioPreset(selectedScenarioId),
    [selectedScenarioId]
  );

  const runComparison = useMemo(() => {
    if (!selectedRow) return null;
    const completedRuns = selectedRow.runs.filter((run) => run.status === 'succeeded' || run.status === 'failed');
    const selectedExperiment = (selectedStudioState.experimentHistory || []).find((experiment) => experiment.id === selectedComparisonExperimentId);
    const matchesExperiment = (run: PlatformTaskRunRecord, experiment: StudioExperimentRecord) => {
      const attribution = getRunExperimentAttribution(run);
      if (attribution.experimentId) return attribution.experimentId === experiment.id;
      return attribution.scenarioId === experiment.scenarioId && attribution.previewPresetId === experiment.previewPresetId;
    };

    const current = completedRuns.find((run) => run.id === selectedCohortRunId) || completedRuns[0];
    if (!current) return null;
    const explicitComparedRun = completedRuns.find((run) => run.id === selectedReplayCompareRunId && run.id !== current.id);
    const previous = explicitComparedRun || (selectedExperiment
      ? completedRuns.find((run) => run.id !== current.id && matchesExperiment(run, selectedExperiment)) || completedRuns[1]
      : completedRuns[1]);
    const currentAttribution = getRunExperimentAttribution(current);
    const previousAttribution = previous ? getRunExperimentAttribution(previous) : undefined;
    const currentDuration = Number.isNaN(Date.parse(current.startedAt || '')) || Number.isNaN(Date.parse(current.finishedAt || ''))
      ? undefined
      : Math.max(0, Date.parse(current.finishedAt || '') - Date.parse(current.startedAt || ''));
    const previousDuration = !previous || Number.isNaN(Date.parse(previous.startedAt || '')) || Number.isNaN(Date.parse(previous.finishedAt || ''))
      ? undefined
      : Math.max(0, Date.parse(previous.finishedAt || '') - Date.parse(previous.startedAt || ''));

    return {
      comparisonMode: explicitComparedRun ? 'exact_run_pair' : selectedExperiment ? 'saved_experiment' : 'previous_run',
      comparisonLabel: selectedExperiment
        ? selectedExperiment.notes || `${getScenarioLabelFromId(selectedExperiment.scenarioId)} · ${getPresetLabelFromId(selectedExperiment.previewPresetId)}`
        : explicitComparedRun ? 'Matched replay pair' : 'Previous run',
      current: {
        id: current.id,
        status: current.status,
        credits: current.actualCredits || 0,
        durationMs: currentDuration,
        scenarioLabel: currentAttribution.scenarioLabel || getScenarioLabelFromId(selectedStudioState.selectedScenarioId || 'baseline'),
        presetLabel: currentAttribution.previewPresetLabel || getPresetLabelFromId(selectedStudioState.previewPresetId || activePresetId),
        experimentLabel: currentAttribution.experimentNotes,
      },
      previous: previous ? {
        id: previous.id,
        status: previous.status,
        credits: previous.actualCredits || 0,
        durationMs: previousDuration,
        scenarioLabel: previousAttribution?.scenarioLabel || getScenarioLabelFromId('baseline'),
        presetLabel: previousAttribution?.previewPresetLabel || getPresetLabelFromId('recommended'),
        experimentLabel: previousAttribution?.experimentNotes,
      } : null,
    };
  }, [activePresetId, selectedCohortRunId, selectedComparisonExperimentId, selectedReplayCompareRunId, selectedRow, selectedStudioState.experimentHistory, selectedStudioState.previewPresetId, selectedStudioState.selectedScenarioId]);

  const currentSpendIndex = useMemo(
    () => estimatePolicySpendIndex(selectedPolicy, selectedRow?.workflowSteps || []),
    [selectedPolicy, selectedRow]
  );

  const currentAssuranceIndex = useMemo(
    () => estimatePolicyAssuranceIndex(selectedPolicy, selectedRow?.workflowSteps || []),
    [selectedPolicy, selectedRow]
  );

  const currentFitIndex = useMemo(
    () => estimatePolicyFitIndex(selectedPolicy, selectedRow?.workflowSteps || []),
    [selectedPolicy, selectedRow]
  );

  const rolePerformance = useMemo(() => {
    const stats = new Map<string, { steps: number; failures: number; credits: number; tokens: number }>();
    (selectedRow?.runs || []).forEach((run) => {
      readStepExecutions(run.metadata?.stepExecutions).forEach((step) => {
        const current = stats.get(step.assignedRole) || { steps: 0, failures: 0, credits: 0, tokens: 0 };
        current.steps += 1;
        current.failures += step.status === 'failed' ? 1 : 0;
        current.credits += step.actualCredits || 0;
        current.tokens += step.tokenUsage?.totalTokens || 0;
        stats.set(step.assignedRole, current);
      });
    });
    return Array.from(stats.entries())
      .map(([role, value]) => ({ role, ...value }))
      .sort((a, b) => b.steps - a.steps);
  }, [selectedRow]);

  const optimizationRecommendations = useMemo(() => {
    if (!selectedRow) return [];
    const items: Array<{ title: string; body: string; action: 'lean_ops' | 'raise_review' | 'match_lanes' | 'trim_lanes' | 'none' }> = [];
    if (selectedRow.successRate > 0 && selectedRow.successRate < 0.7) {
      items.push({
        title: 'Increase review pressure',
        body: 'This workflow is missing too often. Move review toward Standard or Strict so heavier reasoning is only added where it reduces failures.',
        action: 'raise_review',
      });
    }
    if (selectedMath.toolCalls >= 3 && selectedPolicy.optimizationGoal !== 'cost_saver') {
      items.push({
        title: 'Route tool-heavy work down-market',
        body: 'Most of the work here is tool orchestration. Cost Saver keeps scheduling and delivery steps cheap without flattening the whole workflow.',
        action: 'lean_ops',
      });
    }
    if (selectedPolicy.mode === 'custom' && selectedPolicy.maxElasticLanes < selectedMath.recommendedElasticLanes) {
      items.push({
        title: 'Raise lane cap for this workflow',
        body: `The workflow math wants ${selectedMath.recommendedElasticLanes} elastic lanes. Your cap is probably slowing completion and creating avoidable queues.`,
        action: 'match_lanes',
      });
    }
    if (selectedPolicy.mode === 'custom' && selectedPolicy.maxElasticLanes > selectedMath.recommendedElasticLanes + 1) {
      items.push({
        title: 'Trim excess elastic capacity',
        body: 'The current lane cap is richer than this workflow needs. Reducing it should lower spend without hurting reliability.',
        action: 'trim_lanes',
      });
    }
    if (items.length === 0) {
      items.push({
        title: 'Current configuration is healthy',
        body: 'This workflow is aligned with its complexity. The next gains will come from tightening the workflow itself, not from adding more agent structure.',
        action: 'none',
      });
    }
    return items.slice(0, 4);
  }, [selectedMath, selectedPolicy, selectedRow]);

  const studioStats = useMemo(() => {
    const completedRuns = rows.flatMap((row) => row.runs).filter((run) => run.status === 'succeeded' || run.status === 'failed');
    const succeededRuns = completedRuns.filter((run) => run.status === 'succeeded');
    const runsWithElastic = rows.filter((row) =>
      (row.workerTopology?.workers || []).some((worker) => worker.laneType === 'elastic' && worker.status === 'active')
    ).length;
    return {
      workflowCount: rows.length,
      runSuccessRate: completedRuns.length ? succeededRuns.length / completedRuns.length : 0,
      avgRunCredits: completedRuns.length
        ? completedRuns.reduce((sum, run) => sum + (run.actualCredits || 0), 0) / completedRuns.length
        : 0,
      elasticCoverage: rows.length ? runsWithElastic / rows.length : 0,
    };
  }, [rows]);

  const liveRun = useMemo(
    () => selectedRow?.runs.find((run) => run.status === 'running') || selectedRow?.latestRun,
    [selectedRow]
  );

  const liveContextReferenceLabel = useMemo(() => {
    if (!operationalContext?.runId) return 'Waiting for completed run history';
    if (liveRun?.status === 'running') return 'Grounded in the latest completed run';
    if (liveRun) return 'Grounded in the latest available run';
    return 'Waiting for completed run history';
  }, [liveRun, operationalContext?.runId]);

  const liveActivationTrail = useMemo(() => {
    const trail = (selectedRow?.stepExecutions || []).slice(0, 8).map((step, index, source) => ({
      id: step.stepId,
      title: step.title,
      role: step.assignedRole,
      status: step.status,
      summary: step.error || formatSummaryPreview(step.summary, 120) || 'Step executed without a stored summary.',
      modelSource: step.modelSource,
      connector:
        index < source.length - 1
          ? `${step.assignedRole} -> ${source[index + 1].assignedRole}`
          : 'Final handoff',
    }));

    if (trail.length > 0) return trail;

    return (selectedTopology.workers || [])
      .filter((worker) => worker.status === 'active')
      .slice(0, 4)
      .map((worker, index, source) => ({
        id: `${worker.role}-${index}`,
        title: worker.label,
        role: worker.assignedRole,
        status: worker.status,
        summary: worker.reason,
        modelSource: worker.modelLabel,
        connector: index < source.length - 1 ? `${worker.assignedRole} -> ${source[index + 1].assignedRole}` : 'Standing by',
      }));
  }, [selectedRow, selectedTopology]);

  const workerMapNodes = useMemo(() => {
    const layout: Record<string, string> = {
      researcher: 'left-[6%] top-[14%]',
      analyst: 'right-[8%] top-[12%]',
      reviewer: 'right-[4%] top-[46%]',
      operator: 'left-[8%] top-[48%]',
      engineer: 'left-[18%] bottom-[10%]',
      writer: 'left-[44%] bottom-[4%]',
      scheduler: 'right-[28%] bottom-[7%]',
      messenger: 'right-[6%] bottom-[19%]',
      monitor: 'left-[42%] top-[8%]',
    };

    return selectedTopology.workers
      .filter((worker) => worker.role !== 'nexus')
      .map((worker) => ({
        ...worker,
        positionClass: layout[worker.role] || 'left-[8%] top-[8%]',
      }));
  }, [selectedTopology]);

  const frontierPoints = useMemo(
    () =>
      presetComparisons.map((preset) => ({
        ...preset,
        x: preset.spendIndex,
        y: preset.assuranceIndex,
        size: 16 + Math.round(preset.fitIndex / 7),
      })),
    [presetComparisons]
  );


  const replayTimeline = useMemo(() => {
    const latest = selectedRow?.runs[0];
    const runSteps = readStepExecutions(latest?.metadata?.stepExecutions);
    const fallback = selectedRow?.stepExecutions || [];
    const source = runSteps.length > 0 ? runSteps : fallback;
    return source.map((step, index) => ({
      ...step,
      marker: index + 1,
      duration: formatCompactDuration(step.durationMs),
      tokens: formatTokenCount(step.tokenUsage?.totalTokens),
    }));
  }, [selectedRow]);

  const replayInsights = useMemo(() => {
    const insights: Array<{ title: string; body: string; tone: string }> = [];
    const topCostStep = replayTimeline
      .filter((step) => typeof step.actualCredits === 'number')
      .sort((a, b) => (b.actualCredits || 0) - (a.actualCredits || 0))[0];
    const failedStep = replayTimeline.find((step) => step.status === 'failed');

    if (topCostStep) {
      insights.push({
        title: 'Highest spend step',
        body: `${topCostStep.title} consumed ${formatCredits(topCostStep.actualCredits || 0)} credits on ${topCostStep.assignedRole}. This is the first place to route down-market if quality allows.`,
        tone: 'border-amber-500/18 bg-amber-500/8 text-amber-100',
      });
    }

    if (failedStep) {
      insights.push({
        title: 'Failure choke point',
        body: `${failedStep.title} failed on ${failedStep.assignedRole}. Tighten review or move this class of work to a stronger lane before changing the whole topology.`,
        tone: 'border-red-500/18 bg-red-500/8 text-red-100',
      });
    }

    if (!failedStep && replayTimeline.length > 0) {
      insights.push({
        title: 'Stable recent execution',
        body: 'Recent handoffs completed without a visible failure. Optimize for spend or speed now rather than adding more review pressure.',
        tone: 'border-emerald-500/18 bg-emerald-500/8 text-emerald-100',
      });
    }

    if (selectedMath.toolCalls >= 2 && selectedPolicy.optimizationGoal !== 'cost_saver') {
      insights.push({
        title: 'Tool-heavy workflow',
        body: 'This run leans on tools. Leaner presets should preserve outcome quality while cutting token burn on orchestration steps.',
        tone: 'border-cyan-500/18 bg-cyan-500/8 text-cyan-100',
      });
    }

    return insights.slice(0, 3);
  }, [replayTimeline, selectedMath.toolCalls, selectedPolicy.optimizationGoal]);

  const roleHeatmap = useMemo(() => {
    const maxSteps = Math.max(...rolePerformance.map((role) => role.steps), 1);
    return rolePerformance.map((role) => ({
      ...role,
      activityWidth: `${Math.max(12, (role.steps / maxSteps) * 100)}%`,
      failureRate: role.steps ? Math.round((role.failures / role.steps) * 100) : 0,
    }));
  }, [rolePerformance]);

  const selectedWorkerDetail = useMemo(() => {
    const worker =
      selectedTopology.workers.find((item) => item.role === selectedWorkerRole || item.assignedRole === selectedWorkerRole)
      || selectedTopology.workers.find((item) => item.role === 'nexus');
    const performance = roleHeatmap.find((item) => item.role === (worker?.assignedRole || worker?.role));
    const recentSteps = (selectedRow?.stepExecutions || [])
      .filter((step) => step.assignedRole === (worker?.assignedRole || worker?.role))
      .slice(0, 3);
    return { worker, performance, recentSteps };
  }, [roleHeatmap, selectedRow, selectedTopology, selectedWorkerRole]);

  const selectedArchetype = useMemo(
    () => classifyWorkflowArchetype(selectedRow?.workflowSteps || []),
    [selectedRow]
  );

  const scenarioComparisons = useMemo(() => {
    const simulated = simulateScenarioMath(selectedMath, selectedScenario);
    return presetComparisons.map((preset) => {
      const spend = clampNumber(
        Math.round(preset.spendIndex + (simulated.toolCalls - selectedMath.toolCalls) * 6 + (simulated.stepCount - selectedMath.stepCount) * 2),
        10,
        99
      );
      const assurance = clampNumber(
        Math.round(preset.assuranceIndex + (Number(simulated.reasoningLoad) - Number(selectedMath.reasoningLoad)) * 5),
        15,
        99
      );
      const fit = clampNumber(
        Math.round(preset.fitIndex - Math.abs(simulated.recommendedElasticLanes - preset.math.activeElasticLanes) * 10 + (selectedScenario.id === 'baseline' ? 0 : 4)),
        10,
        99
      );
      return { ...preset, scenarioSpend: spend, scenarioAssurance: assurance, scenarioFit: fit, simulated };
    });
  }, [presetComparisons, selectedMath, selectedScenario]);

  const previewScenarioComparison = useMemo(
    () => scenarioComparisons.find((preset) => preset.id === previewPreset.id) || scenarioComparisons[0],
    [previewPreset.id, scenarioComparisons]
  );

  const activePresetLabel = useMemo(
    () => activePresetId === 'custom_live'
      ? 'Custom live policy'
      : POLICY_PRESETS.find((preset) => preset.id === activePresetId)?.label || 'System recommended',
    [activePresetId]
  );

  const policyRadarMetrics = useMemo(
    () => ([
      { label: 'Spend', live: currentSpendIndex, preview: previewScenarioComparison?.scenarioSpend ?? currentSpendIndex },
      { label: 'Assurance', live: currentAssuranceIndex, preview: previewScenarioComparison?.scenarioAssurance ?? currentAssuranceIndex },
      { label: 'Fit', live: currentFitIndex, preview: previewScenarioComparison?.scenarioFit ?? currentFitIndex },
    ]),
    [currentAssuranceIndex, currentFitIndex, currentSpendIndex, previewScenarioComparison?.scenarioAssurance, previewScenarioComparison?.scenarioFit, previewScenarioComparison?.scenarioSpend]
  );

  const selectedRoleDirective = useMemo(
    () => selectedStudioState.roleDirectives?.[selectedWorkerDetail.worker?.role || ''],
    [selectedStudioState.roleDirectives, selectedWorkerDetail.worker?.role]
  );

  const workerPhaseActivity = useMemo(
    () => buildPhaseActivitySeries(selectedRow?.runs || [], selectedWorkerDetail.worker?.assignedRole || selectedWorkerDetail.worker?.role || ''),
    [selectedRow?.runs, selectedWorkerDetail.worker?.assignedRole, selectedWorkerDetail.worker?.role]
  );

  const liveScenarioTelemetry = useMemo(() => {
    const telemetry = getRunScenarioTelemetry(liveRun);
    const directedRoles = telemetry.directedRoles && telemetry.directedRoles.length > 0
      ? telemetry.directedRoles
      : Object.entries(selectedStudioState.roleDirectives || {}).map(([role, directive]) => ({
          role,
          mode: directive.mode as 'cheaper' | 'review' | 'promote',
          phases: directive.phases,
        }));

    return {
      scenarioLabel: telemetry.scenarioLabel || getScenarioLabelFromId(selectedStudioState.selectedScenarioId || 'baseline'),
      presetLabel: telemetry.previewPresetLabel || getPresetLabelFromId(selectedStudioState.previewPresetId || activePresetId),
      complexity: telemetry.complexity || (Number(selectedMath.reasoningLoad) >= 8 ? 'high' : Number(selectedMath.reasoningLoad) >= 5 ? 'moderate' : 'light'),
      workflowStepCount: telemetry.workflowStepCount || selectedMath.stepCount,
      estimatedToolCalls: telemetry.estimatedToolCalls || selectedMath.toolCalls,
      matchedSavedExperiment: telemetry.matchedSavedExperiment,
      experimentId: telemetry.experimentId,
      directedRoles,
    };
  }, [activePresetId, liveRun, selectedMath.reasoningLoad, selectedMath.stepCount, selectedMath.toolCalls, selectedStudioState.previewPresetId, selectedStudioState.roleDirectives, selectedStudioState.selectedScenarioId]);

  const phaseDirectiveMatrix = useMemo(() => {
    const source = liveScenarioTelemetry.directedRoles || [];
    const phases: WorkflowBlockKind[] = ['search', 'query', 'capture', 'analyze', 'summarize', 'deliver'];
    return phases.map((phase) => ({
      phase,
      directives: source.filter((directive) => !directive.phases || directive.phases.includes(phase)),
    }));
  }, [liveScenarioTelemetry.directedRoles]);

  const experimentHistory = useMemo(
    () => (selectedStudioState.experimentHistory || []).slice().sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [selectedStudioState.experimentHistory]
  );

  const savedOperatingPlans = useMemo(
    () => (selectedStudioState.savedPlans || []).slice().sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [selectedStudioState.savedPlans]
  );

  const phaseEvidence = useMemo(() => {
    if (!selectedRow) return [] as Array<{ phase: WorkflowBlockKind; runs: number; successRate: number; averageCredits: number; averageDurationMs: number; directiveModes: string[] }>;
    const aggregate = new Map<WorkflowBlockKind, { runs: number; success: number; credits: number; durationMs: number; directiveModes: Set<string> }>();
    selectedRow.runs
      .filter((run) => run.status === 'succeeded' || run.status === 'failed')
      .forEach((run) => {
        readStepExecutions(run.metadata?.stepExecutions).forEach((step) => {
          if (!(step.kind === 'search' || step.kind === 'query' || step.kind === 'capture' || step.kind === 'analyze' || step.kind === 'summarize' || step.kind === 'deliver' || step.kind === 'note')) return;
          const current = aggregate.get(step.kind) || { runs: 0, success: 0, credits: 0, durationMs: 0, directiveModes: new Set<string>() };
          current.runs += 1;
          current.success += step.status === 'succeeded' ? 1 : 0;
          current.credits += step.actualCredits || 0;
          current.durationMs += step.durationMs || 0;
          if (step.directiveMode) current.directiveModes.add(step.directiveMode);
          aggregate.set(step.kind, current);
        });
      });

    return Array.from(aggregate.entries()).map(([phase, value]) => ({
      phase,
      runs: value.runs,
      successRate: value.runs ? value.success / value.runs : 0,
      averageCredits: value.runs ? value.credits / value.runs : 0,
      averageDurationMs: value.runs ? value.durationMs / value.runs : 0,
      directiveModes: Array.from(value.directiveModes),
    })).sort((a, b) => b.runs - a.runs);
  }, [selectedRow]);

  const workflowDiagnostics = useMemo(() => {
    const riskItems: Array<{ title: string; body: string; severity: 'low' | 'medium' | 'high'; action: 'raise_review' | 'none' }> = [];
    const wasteItems: Array<{ title: string; body: string; severity: 'low' | 'medium' | 'high'; action: 'lean_ops' | 'trim_lanes' | 'match_lanes' | 'none' }> = [];

    if (selectedRow) {
      const weakestPhase = phaseEvidence
        .filter((phase) => phase.runs >= 2)
        .sort((a, b) => a.successRate - b.successRate || b.runs - a.runs)[0];
      const costlyPhase = phaseEvidence
        .filter((phase) => phase.runs >= 2)
        .sort((a, b) => b.averageCredits - a.averageCredits || b.runs - a.runs)[0];

      if (selectedRow.successRate > 0 && selectedRow.successRate < 0.7) {
        riskItems.push({
          title: 'Reliability is below target',
          body: 'Recent runs are failing often enough that this workflow is under-protected. The fix is stricter review where the final reasoning happens, not more lanes everywhere.',
          severity: 'high',
          action: 'raise_review',
        });
      }
      if (weakestPhase && weakestPhase.successRate < 0.7) {
        riskItems.push({
          title: `${formatDirectivePhaseScope([weakestPhase.phase])} is the weak phase`,
          body: `Across ${weakestPhase.runs} recent step executions, this phase is only landing ${Math.round(weakestPhase.successRate * 100)}% of the time. Tighten review here before changing the entire workflow posture.`,
          severity: weakestPhase.successRate < 0.55 ? 'high' : 'medium',
          action: 'raise_review',
        });
      }
      if (costlyPhase && costlyPhase.averageCredits >= 18) {
        wasteItems.push({
          title: `${formatDirectivePhaseScope([costlyPhase.phase])} is burning budget`,
          body: `This phase averages ${formatCredits(costlyPhase.averageCredits)} credits across ${costlyPhase.runs} executions. That is the best candidate for cheaper routing or tighter instructions.`,
          severity: costlyPhase.averageCredits >= 28 ? 'high' : 'medium',
          action: costlyPhase.phase === 'deliver' || costlyPhase.phase === 'search' ? 'lean_ops' : 'none',
        });
      }
      if (selectedPolicy.maxElasticLanes > selectedMath.recommendedElasticLanes + 1) {
        wasteItems.push({
          title: 'Elastic capacity is over-provisioned',
          body: `Live cap is ${selectedPolicy.maxElasticLanes}, but the workflow math only justifies about ${selectedMath.recommendedElasticLanes}.`,
          severity: 'medium',
          action: 'trim_lanes',
        });
      }
      if (selectedPolicy.maxElasticLanes < selectedMath.recommendedElasticLanes) {
        riskItems.push({
          title: 'Parallel depth is constrained',
          body: 'The workflow needs more elastic headroom than the current cap allows, which can create slower runs and overloaded core roles.',
          severity: 'medium',
          action: 'none',
        });
        wasteItems.push({
          title: 'Queueing is likely hurting throughput',
          body: 'This is one of the few workflows where spending a bit more on lane capacity is likely to return better cycle time.',
          severity: 'low',
          action: 'match_lanes',
        });
      }
      if (riskItems.length === 0) {
        riskItems.push({
          title: 'No dominant risk signal',
          body: 'Nothing here is screaming for heavier review. Preserve speed and focus on workflow quality or experiment learning.',
          severity: 'low',
          action: 'none',
        });
      }
      if (wasteItems.length === 0) {
        wasteItems.push({
          title: 'Spend profile looks disciplined',
          body: 'The current setup is not obviously wasting tokens or elastic capacity. Improvements will likely come from sharper experiments, not blanket cost cutting.',
          severity: 'low',
          action: 'none',
        });
      }
    }

    return { riskItems: riskItems.slice(0, 3), wasteItems: wasteItems.slice(0, 3) };
  }, [phaseEvidence, selectedMath.recommendedElasticLanes, selectedPolicy.maxElasticLanes, selectedRow]);

  const optimizationScorecard = useMemo(() => {
    const spendPressure = clampNumber(Math.round((currentSpendIndex * 0.55) + (selectedMath.toolCalls * 6) + (selectedMath.activeElasticLanes * 5)), 10, 99);
    const riskPressure = clampNumber(Math.round((100 - Math.round(selectedRow?.successRate ? selectedRow.successRate * 100 : 72)) * 0.55 + currentAssuranceIndex * 0.35), 10, 99);
    const leverageScore = clampNumber(Math.round(currentFitIndex + Math.max(0, 18 - spendPressure / 6) + (selectedMath.recommendedElasticLanes >= selectedMath.activeElasticLanes ? 6 : -4)), 10, 99);
    const verdict = leverageScore >= 78 ? 'Strong operating setup' : leverageScore >= 58 ? 'Good with room to tune' : 'Needs a sharper policy';
    const nextMove = workflowDiagnostics.riskItems[0]?.severity === 'high'
      ? 'Tighten review around the highest-risk phase.'
      : workflowDiagnostics.wasteItems[0]?.action === 'lean_ops'
        ? 'Route more operational work down-market.'
        : workflowDiagnostics.wasteItems[0]?.action === 'trim_lanes'
          ? 'Trim elastic capacity before adding more logic.'
          : 'Keep testing saved experiments and promote only what consistently wins.';
    return { spendPressure, riskPressure, leverageScore, verdict, nextMove };
  }, [currentAssuranceIndex, currentFitIndex, currentSpendIndex, selectedMath.activeElasticLanes, selectedMath.recommendedElasticLanes, selectedMath.toolCalls, selectedRow?.successRate, workflowDiagnostics.riskItems, workflowDiagnostics.wasteItems]);

  const experimentRunMatches = useMemo(() => {
    const matches = new Map<string, PlatformTaskRunRecord | undefined>();
    if (!selectedRow) return matches;
    const completedRuns = selectedRow.runs.filter((run) => run.status === 'succeeded' || run.status === 'failed');
    for (const experiment of experimentHistory) {
      const matchingRun = completedRuns.find((run) => matchesExperimentRun(run, experiment));
      matches.set(experiment.id, matchingRun);
    }
    return matches;
  }, [experimentHistory, selectedRow]);

  const experimentPerformance = useMemo(() => {
    if (!selectedRow) return [] as Array<{
      experiment: StudioExperimentRecord;
      runs: PlatformTaskRunRecord[];
      stats: ReturnType<typeof summarizeRunCollection>;
      score: number;
      confidence: number;
      recencyBoost: number;
      latestAt?: string;
    }>;

    const completedRuns = selectedRow.runs.filter((run) => run.status === 'succeeded' || run.status === 'failed');
    return experimentHistory.map((experiment) => {
      const runs = completedRuns.filter((run) => matchesExperimentRun(run, experiment));
      const stats = summarizeRunCollection(runs);
      const latestAt = runs[0]?.finishedAt || runs[0]?.startedAt;
      const weighted = scoreObservedPerformance(stats, latestAt);
      return { experiment, runs, stats, latestAt, ...weighted };
    }).sort((left, right) => right.score - left.score || right.confidence - left.confidence || right.stats.count - left.stats.count);
  }, [experimentHistory, selectedRow]);

  const winningExperiment = useMemo(
    () => experimentPerformance.find((item) => item.stats.count > 0),
    [experimentPerformance]
  );

  const winningExperimentPhases = useMemo(
    () => (winningExperiment ? getExperimentPhaseList(winningExperiment.experiment) : []),
    [winningExperiment]
  );

  const selectedExperimentPerformance = useMemo(
    () => experimentPerformance.find((item) => item.experiment.id === selectedComparisonExperimentId),
    [experimentPerformance, selectedComparisonExperimentId]
  );

  const currentCohortPerformance = useMemo(() => {
    if (!selectedRow) return null;
    const completedRuns = selectedRow.runs.filter((run) => run.status === 'succeeded' || run.status === 'failed');
    const latest = completedRuns[0];
    if (!latest) return null;
    const attribution = getRunExperimentAttribution(latest);
    const cohortRuns = completedRuns.filter((run) => {
      const candidate = getRunExperimentAttribution(run);
      if (attribution.experimentId && candidate.experimentId) return candidate.experimentId === attribution.experimentId;
      return candidate.scenarioId === attribution.scenarioId && candidate.previewPresetId === attribution.previewPresetId;
    });
    return {
      label: attribution.experimentNotes || `${attribution.scenarioLabel} · ${attribution.previewPresetLabel}`,
      stats: summarizeRunCollection(cohortRuns),
      runs: cohortRuns,
    };
  }, [selectedRow]);

  useEffect(() => {
    setSelectedComparisonExperimentId((current) => {
      if (current && experimentHistory.some((experiment) => experiment.id === current)) return current;
      return experimentHistory[0]?.id || '';
    });
  }, [experimentHistory, selectedRow?.automation.id]);

  useEffect(() => {
    setSelectedPlanId((current) => {
      if (current && savedOperatingPlans.some((plan) => plan.id === current)) return current;
      return savedOperatingPlans[0]?.id || '';
    });
  }, [savedOperatingPlans, selectedRow?.automation.id]);

  useEffect(() => {
    setSelectedPlanCompareId((current) => {
      if (current && savedOperatingPlans.some((plan) => plan.id === current)) return current;
      return savedOperatingPlans.find((plan) => plan.id !== selectedPlanId)?.id || '';
    });
  }, [savedOperatingPlans, selectedPlanId, selectedRow?.automation.id]);

  useEffect(() => {
    const candidate = currentCohortPerformance?.runs[0]?.id || selectedExperimentPerformance?.runs[0]?.id || '';
    setSelectedCohortRunId((current) => current || candidate);
  }, [currentCohortPerformance?.runs, selectedExperimentPerformance?.runs, selectedRow?.automation.id]);

  const selectedCohortRun = useMemo(() => {
    const allRuns = [...(currentCohortPerformance?.runs || []), ...(selectedExperimentPerformance?.runs || [])];
    return allRuns.find((run) => run.id === selectedCohortRunId) || currentCohortPerformance?.runs[0] || selectedExperimentPerformance?.runs[0];
  }, [currentCohortPerformance?.runs, selectedCohortRunId, selectedExperimentPerformance?.runs]);

  const focusedCohortRun = useMemo(() => {
    const allRuns = [...(currentCohortPerformance?.runs || []), ...(selectedExperimentPerformance?.runs || [])];
    return allRuns.find((run) => run.id === hoveredCohortRunId)
      || allRuns.find((run) => run.id === selectedCohortRunId)
      || allRuns[0];
  }, [currentCohortPerformance?.runs, hoveredCohortRunId, selectedCohortRunId, selectedExperimentPerformance?.runs]);

  useEffect(() => {
    const workflowId = selectedRow?.automation.id;
    if ((activeRoom !== 'live' && activeRoom !== 'replay') || !workflowId) {
      setOperationalContext(null);
      setOperationalContextLoading(false);
      return;
    }

    const headers = {
      'X-Workspace-Id': workspace.workspaceId,
      'X-Workspace-Name': workspace.workspaceName,
    };
    const params = new URLSearchParams();
    const contextRunId = activeRoom === 'replay'
      ? selectedCohortRun?.id
      : liveRun?.status === 'running'
        ? undefined
        : liveRun?.id;
    if (contextRunId) {
      params.set('runId', contextRunId);
    }

    let cancelled = false;
    setOperationalContextLoading(true);

    fetch(`/api/studio/context/${workflowId}${params.toString() ? `?${params.toString()}` : ''}`, { headers })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('context'))))
      .then((payload) => {
        if (cancelled) return;
        setOperationalContext(payload?.item || null);
      })
      .catch(() => {
        if (cancelled) return;
        setOperationalContext(null);
      })
      .finally(() => {
        if (cancelled) return;
        setOperationalContextLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeRoom, liveRun?.id, liveRun?.status, selectedCohortRun?.id, selectedRow?.automation.id, workspace.workspaceId, workspace.workspaceName]);

  const cohortTrendSeries = useMemo(
    () => [
      {
        label: 'Current',
        tone: {
          stroke: '#22d3ee',
          fill: 'rgba(34, 211, 238, 0.14)',
          dot: 'rgba(103, 232, 249, 0.95)',
          grid: 'rgba(34, 211, 238, 0.18)',
        },
        chart: buildTrendSeries(currentCohortPerformance?.runs || [], trendMetric),
      },
      {
        label: 'Experiment',
        tone: {
          stroke: '#a78bfa',
          fill: 'rgba(167, 139, 250, 0.14)',
          dot: 'rgba(196, 181, 253, 0.95)',
          grid: 'rgba(167, 139, 250, 0.18)',
        },
        chart: buildTrendSeries(selectedExperimentPerformance?.runs || [], trendMetric),
      },
    ],
    [currentCohortPerformance?.runs, selectedExperimentPerformance?.runs, trendMetric],
  );

  const phaseSimulationPreview = useMemo(() => {
    if (!phaseSimulation) return null;
    const targetRole = getPreferredRoleForPhase(phaseSimulation.phase);
    const nextPolicy: AutomationExecutionPolicyDraft = {
      ...selectedPolicy,
      mode: 'custom',
      optimizationGoal:
        phaseSimulation.mode === 'cheaper'
          ? 'cost_saver'
          : phaseSimulation.mode === 'review'
            ? (selectedPolicy.optimizationGoal === 'cost_saver' ? 'balanced' : selectedPolicy.optimizationGoal)
            : 'quality_first',
      reviewPolicy:
        phaseSimulation.mode === 'review'
          ? 'strict'
          : phaseSimulation.mode === 'cheaper' && selectedPolicy.reviewPolicy === 'strict'
            ? 'standard'
            : selectedPolicy.reviewPolicy,
      maxElasticLanes:
        phaseSimulation.mode === 'promote'
          ? Math.min(4, Math.max(selectedPolicy.maxElasticLanes, selectedMath.recommendedElasticLanes) + 1)
          : phaseSimulation.mode === 'cheaper'
            ? Math.max(1, Math.min(selectedPolicy.maxElasticLanes, selectedMath.recommendedElasticLanes))
            : selectedPolicy.maxElasticLanes,
    };

    const nextSpend = estimatePolicySpendIndex(nextPolicy, selectedRow?.workflowSteps || []);
    const nextAssurance = estimatePolicyAssuranceIndex(nextPolicy, selectedRow?.workflowSteps || []);
    const nextFit = estimatePolicyFitIndex(nextPolicy, selectedRow?.workflowSteps || []);

    return {
      ...phaseSimulation,
      targetRole,
      nextPolicy,
      nextSpend,
      nextAssurance,
      nextFit,
      spendDelta: nextSpend - currentSpendIndex,
      assuranceDelta: nextAssurance - currentAssuranceIndex,
      fitDelta: nextFit - currentFitIndex,
    };
  }, [currentAssuranceIndex, currentFitIndex, currentSpendIndex, phaseSimulation, selectedMath.recommendedElasticLanes, selectedPolicy, selectedRow?.workflowSteps]);

  const selectedRunDelta = useMemo(() => {
    if (!selectedCohortRun) return null;
    const source = (currentCohortPerformance?.runs || []).some((run) => run.id === selectedCohortRun.id)
      ? currentCohortPerformance
      : selectedExperimentPerformance
        ? { label: getExperimentDisplayLabel(selectedExperimentPerformance.experiment), stats: selectedExperimentPerformance.stats }
        : null;
    if (!source) return null;
    const runDuration = Number.isNaN(Date.parse(selectedCohortRun.startedAt || '')) || Number.isNaN(Date.parse(selectedCohortRun.finishedAt || ''))
      ? 0
      : Math.max(0, Date.parse(selectedCohortRun.finishedAt || '') - Date.parse(selectedCohortRun.startedAt || ''));
    return {
      label: source.label,
      creditDelta: (selectedCohortRun.actualCredits || 0) - (source.stats.averageCredits || 0),
      durationDelta: runDuration - (source.stats.averageDurationMs || 0),
      successDelta: (selectedCohortRun.status === 'succeeded' ? 100 : selectedCohortRun.status === 'failed' ? 0 : 50) - Math.round((source.stats.successRate || 0) * 100),
    };
  }, [currentCohortPerformance, selectedCohortRun, selectedExperimentPerformance]);

  const policyDiffRows = useMemo(
    () => [
      {
        label: 'Optimization goal',
        current: getOptimizationGoalLabel(selectedPolicy.optimizationGoal),
        next: getOptimizationGoalLabel(previewPreset.policy.optimizationGoal),
      },
      {
        label: 'Review',
        current: getReviewPolicyLabel(selectedPolicy.reviewPolicy),
        next: getReviewPolicyLabel(previewPreset.policy.reviewPolicy),
      },
      {
        label: 'Elastic lane cap',
        current: `${selectedPolicy.maxElasticLanes}`,
        next: `${previewPreset.policy.maxElasticLanes}`,
      },
      {
        label: 'Spend score',
        current: `${currentSpendIndex}`,
        next: `${previewScenarioComparison?.scenarioSpend ?? currentSpendIndex}`,
      },
      {
        label: 'Assurance score',
        current: `${currentAssuranceIndex}`,
        next: `${previewScenarioComparison?.scenarioAssurance ?? currentAssuranceIndex}`,
      },
    ].filter((row) => row.current !== row.next),
    [
      currentAssuranceIndex,
      currentSpendIndex,
      previewPreset.policy.maxElasticLanes,
      previewPreset.policy.optimizationGoal,
      previewPreset.policy.reviewPolicy,
      previewScenarioComparison?.scenarioAssurance,
      previewScenarioComparison?.scenarioSpend,
      selectedPolicy.maxElasticLanes,
      selectedPolicy.optimizationGoal,
      selectedPolicy.reviewPolicy,
    ]
  );

  const optimizeDecisionBrief = useMemo(() => {
    const nextSpend = previewScenarioComparison?.scenarioSpend ?? currentSpendIndex;
    const nextAssurance = previewScenarioComparison?.scenarioAssurance ?? currentAssuranceIndex;
    const nextFit = previewScenarioComparison?.scenarioFit ?? currentFitIndex;
    const spendDelta = nextSpend - currentSpendIndex;
    const assuranceDelta = nextAssurance - currentAssuranceIndex;
    const fitDelta = nextFit - currentFitIndex;
    const isActiveCandidate = Boolean(previewScenarioComparison?.isActive);
    const changedPolicyCount = policyDiffRows.length;

    if (isActiveCandidate) {
      return {
        tone: 'neutral' as const,
        headline: 'Live already matches this candidate',
        body: `The current release is already operating as ${previewPreset.label} for ${selectedScenario.label.toLowerCase()}. There is nothing to ship right now.`,
        nextStep: 'Use the detailed diff below only to understand why the live setup is already the right fit, or choose a different scenario to pressure-test a new release.',
        deltas: {
          spend: spendDelta,
          assurance: assuranceDelta,
          fit: fitDelta,
        },
      };
    }

    const releaseStrength = (fitDelta * 1.2) + assuranceDelta - Math.max(0, spendDelta * 0.65);
    const liveNeedsHelp = optimizationScorecard.leverageScore < 58 || optimizationScorecard.riskPressure >= 62;

    if ((releaseStrength >= 8 && assuranceDelta >= 0 && fitDelta >= 0) || (liveNeedsHelp && (fitDelta >= 4 || assuranceDelta >= 4) && spendDelta <= 12)) {
      return {
        tone: 'positive' as const,
        headline: `Ship ${previewPreset.label} for this scenario`,
        body: `${previewPreset.label} improves the operating fit enough to justify release under ${selectedScenario.label.toLowerCase()} pressure. The candidate is earning its complexity instead of just moving knobs around.`,
        nextStep: `Before applying, confirm the policy diff once. If the lower section still looks clean, this is the right release candidate to promote from ${activePresetLabel}.`,
        deltas: {
          spend: spendDelta,
          assurance: assuranceDelta,
          fit: fitDelta,
        },
      };
    }

    if (assuranceDelta < 0 || (fitDelta < 0 && spendDelta >= 0)) {
      return {
        tone: 'warning' as const,
        headline: 'Hold this candidate for now',
        body: `${previewPreset.label} weakens the release story under ${selectedScenario.label.toLowerCase()} pressure. It is not improving the right dimensions enough to justify changing the live setup.`,
        nextStep: 'Keep the current release, then either choose a better-fitting preset or open the advanced lab only if you have a specific policy hypothesis to test.',
        deltas: {
          spend: spendDelta,
          assurance: assuranceDelta,
          fit: fitDelta,
        },
      };
    }

    return {
      tone: 'neutral' as const,
      headline: 'Promising, but not decisive yet',
      body: `${previewPreset.label} changes ${changedPolicyCount} parts of the release posture, but the net gain is still marginal. This is a candidate to inspect, not an obvious promotion yet.`,
      nextStep: 'Read the candidate diff and radar below. If the tradeoff still feels thin, keep live and save this pairing as an experiment instead of shipping it.',
      deltas: {
        spend: spendDelta,
        assurance: assuranceDelta,
        fit: fitDelta,
      },
    };
  }, [
    activePresetLabel,
    currentAssuranceIndex,
    currentFitIndex,
    currentSpendIndex,
    optimizationScorecard.leverageScore,
    optimizationScorecard.riskPressure,
    policyDiffRows.length,
    previewPreset.label,
    previewScenarioComparison?.isActive,
    previewScenarioComparison?.scenarioAssurance,
    previewScenarioComparison?.scenarioFit,
    previewScenarioComparison?.scenarioSpend,
    selectedScenario.label,
  ]);

  const phaseLearningByArchetype = useMemo(() => {
    const scopedRows = rows.filter((row) => classifyWorkflowArchetype(row.workflowSteps).id === selectedArchetype.id);
    const aggregate = new Map<string, { phase: WorkflowBlockKind; mode: string; runs: number; success: number; credits: number }>();

    scopedRows.forEach((row) => {
      row.runs
        .filter((run) => run.status === 'succeeded' || run.status === 'failed')
        .forEach((run) => {
          readStepExecutions(run.metadata?.stepExecutions).forEach((step) => {
            if (!(step.kind === 'search' || step.kind === 'query' || step.kind === 'capture' || step.kind === 'analyze' || step.kind === 'summarize' || step.kind === 'deliver' || step.kind === 'note')) return;
            const mode = step.directiveMode || 'baseline';
            const key = `${step.kind}:${mode}`;
            const current = aggregate.get(key) || { phase: step.kind, mode, runs: 0, success: 0, credits: 0 };
            current.runs += 1;
            current.success += step.status === 'succeeded' ? 1 : 0;
            current.credits += step.actualCredits || 0;
            aggregate.set(key, current);
          });
        });
    });

    return Array.from(aggregate.values())
      .filter((item) => item.runs >= 2)
      .map((item) => ({
        ...item,
        successRate: item.success / item.runs,
        averageCredits: item.credits / item.runs,
        confidence: clampNumber(Math.round((Math.min(item.runs, 10) / 10) * 100), 10, 100),
        score: clampNumber(Math.round((item.success / item.runs) * 76 + (Math.min(item.runs, 10) / 10) * 18 - (item.credits / item.runs) / 4), 0, 99),
      }))
      .sort((a, b) => b.score - a.score || b.runs - a.runs)
      .slice(0, 6);
  }, [rows, selectedArchetype.id]);

  const learnedPresetLearning = useMemo(() => {
    const scoredRuns = rows.flatMap((row) => {
      const archetype = classifyWorkflowArchetype(row.workflowSteps);
      if (archetype.id !== selectedArchetype.id) return [];
      const policy = normalizeExecutionPolicy(row.automation.execution_policy);
      const presetMatch = POLICY_PRESETS.find((preset) =>
        preset.policy.mode === policy.mode &&
        preset.policy.optimizationGoal === policy.optimizationGoal &&
        preset.policy.reviewPolicy === policy.reviewPolicy &&
        preset.policy.maxElasticLanes === policy.maxElasticLanes
      );
      const automationStudio = normalizeStudioState(row.automation.studio_state);

      return row.runs
        .filter((run) => run.status === 'succeeded' || run.status === 'failed')
        .map((run) => {
          const attribution = getRunExperimentAttribution(run);
          const scenarioId = attribution.scenarioId || automationStudio.selectedScenarioId || 'baseline';
          const presetId = attribution.previewPresetId || presetMatch?.id || 'custom_live';
          return {
            workflowId: row.automation.id,
            scenarioId,
            scenarioLabel: attribution.scenarioLabel || getScenarioLabelFromId(scenarioId),
            presetId,
            presetLabel: attribution.previewPresetLabel || presetMatch?.label || 'Custom live policy',
            run,
          };
        });
    });

    const scenarioScoped = scoredRuns.filter((item) => item.scenarioId === selectedScenario.id);
    const scopedItems = scenarioScoped.length >= 3 ? scenarioScoped : scoredRuns;
    const aggregate = new Map<string, { label: string; workflows: Set<string>; runs: PlatformTaskRunRecord[]; latestAt?: string }>();
    scopedItems.forEach((item) => {
      const current = aggregate.get(item.presetId) || { label: item.presetLabel, workflows: new Set<string>(), runs: [], latestAt: undefined };
      current.workflows.add(item.workflowId);
      current.runs.push(item.run);
      const candidateAt = item.run.finishedAt || item.run.startedAt;
      if (candidateAt && (!current.latestAt || Date.parse(candidateAt) > Date.parse(current.latestAt))) {
        current.latestAt = candidateAt;
      }
      aggregate.set(item.presetId, current);
    });

    return {
      scenarioMatched: scenarioScoped.length >= 3,
      scopeLabel: scenarioScoped.length >= 2 ? `${selectedArchetype.label.toLowerCase()} in ${selectedScenario.label.toLowerCase()}` : selectedArchetype.label.toLowerCase(),
      items: Array.from(aggregate.entries())
        .map(([presetId, value]) => ({
          ...scoreObservedPerformance(summarizeRunCollection(value.runs), value.latestAt),
          presetId,
          label: value.label,
          workflowCount: value.workflows.size,
          runCount: value.runs.length,
          averageSuccess: Math.round(summarizeRunCollection(value.runs).successRate * 100),
          averageCredits: summarizeRunCollection(value.runs).averageCredits,
        }))
        .sort((a, b) => b.score - a.score || b.runCount - a.runCount)
        .slice(0, 4),
    };
  }, [rows, selectedArchetype.id, selectedArchetype.label, selectedScenario.id, selectedScenario.label]);

  const evidenceFreshness = useMemo(() => {
    const latestRunAt = selectedRow?.runs[0]?.finishedAt || selectedRow?.runs[0]?.startedAt;
    const latestExperimentAt = experimentPerformance[0]?.latestAt || experimentHistory[0]?.createdAt;
    const runCount = selectedRow?.runs.filter((run) => run.status === 'succeeded' || run.status === 'failed').length || 0;
    const experimentCount = experimentPerformance.filter((entry) => entry.stats.count > 0).length;
    const freshnessDays = latestRunAt ? Math.max(0, (Date.now() - Date.parse(latestRunAt)) / 86400000) : 999;
    const tone = freshnessDays <= 2 && runCount >= 3 ? 'fresh' : freshnessDays <= 7 && runCount >= 2 ? 'warm' : 'stale';
    return {
      runCount,
      experimentCount,
      latestRunAt,
      latestExperimentAt,
      tone,
      confidence:
        runCount >= 6 && experimentCount >= 2
          ? 'High-confidence learning'
          : runCount >= 3
            ? 'Useful but still maturing'
            : 'Thin evidence',
    };
  }, [experimentHistory, experimentPerformance, selectedRow]);

  const winnerCausalReport = useMemo(() => {
    if (!winningExperiment) return [] as Array<{ title: string; body: string; tone: string }>;
    const insights: Array<{ title: string; body: string; tone: string }> = [];
    if (winningExperiment.stats.successRate >= 0.85) {
      insights.push({
        title: 'It is winning on reliability',
        body: `This setup is landing ${Math.round(winningExperiment.stats.successRate * 100)}% success across ${winningExperiment.stats.count} observed runs, which is strong enough to trust more than a one-off spike.`,
        tone: 'border-emerald-500/18 bg-emerald-500/8 text-emerald-100',
      });
    }
    if (winningExperiment.stats.averageCredits > 0 && currentCohortPerformance && winningExperiment.stats.averageCredits < currentCohortPerformance.stats.averageCredits) {
      insights.push({
        title: 'It is cheaper than the live cohort',
        body: `Average spend is ${formatCredits(winningExperiment.stats.averageCredits)} credits versus ${formatCredits(currentCohortPerformance.stats.averageCredits || 0)} on the live cohort, so the gain is not just cosmetic.`,
        tone: 'border-cyan-500/18 bg-cyan-500/8 text-cyan-100',
      });
    }
    const strongestPhase = phaseLearningByArchetype.find((item) => item.mode !== 'baseline');
    if (strongestPhase) {
      insights.push({
        title: `${formatDirectivePhaseScope([strongestPhase.phase])} carries the edge`,
        body: `${strongestPhase.mode} bias is the strongest observed non-baseline move for this workflow class. That is the best place to apply pressure before changing the whole policy.`,
        tone: 'border-violet-500/18 bg-violet-500/8 text-violet-100',
      });
    }
    if (insights.length === 0) {
      insights.push({
        title: 'The winner is still forming',
        body: 'There is enough signal to rank setups, but not enough to claim a single causal advantage yet. Keep running comparisons before locking the policy.',
        tone: 'border-amber-500/18 bg-amber-500/8 text-amber-100',
      });
    }
    return insights.slice(0, 3);
  }, [currentCohortPerformance, phaseLearningByArchetype, winningExperiment]);

  const phaseCostConfidenceMap = useMemo(() => {
    const maxCredits = Math.max(...phaseEvidence.map((phase) => phase.averageCredits || 0), 1);
    return phaseEvidence.map((phase) => {
      const confidence = clampNumber(Math.round(phase.successRate * 100 * Math.min(1, phase.runs / 5)), 8, 100);
      const costPressure = clampNumber(Math.round(((phase.averageCredits || 0) / maxCredits) * 100), 0, 100);
      const recommendation =
        confidence < 55
          ? 'Needs stronger review or clearer instructions'
          : costPressure > 70
            ? 'Candidate for cheaper routing'
            : 'Healthy phase economics';
      return {
        ...phase,
        confidence,
        costPressure,
        recommendation,
      };
    });
  }, [phaseEvidence]);

  const autoPromotionThreshold = useMemo(() => {
    const scenarioThreshold = selectedStudioState.autoPromotionScenarioThresholds?.[selectedScenario.id];
    if (typeof scenarioThreshold === 'number') return scenarioThreshold;
    const archetypeThreshold = selectedStudioState.autoPromotionArchetypeThresholds?.[selectedArchetype.id];
    if (typeof archetypeThreshold === 'number') return archetypeThreshold;
    return selectedStudioState.autoPromotionMinConfidence ?? 55;
  }, [
    selectedArchetype.id,
    selectedScenario.id,
    selectedStudioState.autoPromotionArchetypeThresholds,
    selectedStudioState.autoPromotionMinConfidence,
    selectedStudioState.autoPromotionScenarioThresholds,
  ]);

  const autoPromotionSuggestion = useMemo(() => {
    if (!winningExperiment || !currentCohortPerformance || winningExperiment.experiment.id === selectedComparisonExperimentId) return null;
    const beatsCurrentOnSuccess = winningExperiment.stats.successRate >= currentCohortPerformance.stats.successRate + 0.08;
    const beatsCurrentOnSpend = winningExperiment.stats.averageCredits > 0 && winningExperiment.stats.averageCredits <= currentCohortPerformance.stats.averageCredits - 6;
    const confidenceStrong = winningExperiment.confidence >= autoPromotionThreshold && evidenceFreshness.tone !== 'stale';
    if (!confidenceStrong || (!beatsCurrentOnSuccess && !beatsCurrentOnSpend)) return null;
    return {
      tone: beatsCurrentOnSuccess ? 'quality' : 'efficiency',
      title: beatsCurrentOnSuccess ? 'Auto-promotion candidate for quality' : 'Auto-promotion candidate for efficiency',
      body: beatsCurrentOnSuccess
        ? `${getExperimentDisplayLabel(winningExperiment.experiment)} is beating the live cohort on success with enough evidence to justify a promotion review.`
        : `${getExperimentDisplayLabel(winningExperiment.experiment)} is running cheaper than the live cohort without losing quality, and the evidence is now strong enough to act on.`,
      experiment: winningExperiment.experiment,
      threshold: autoPromotionThreshold,
    };
  }, [autoPromotionThreshold, currentCohortPerformance, evidenceFreshness.tone, selectedComparisonExperimentId, winningExperiment]);

  const experimentBranches = useMemo(() => {
    const branchCountByParent = new Map<string, number>();
    experimentHistory.forEach((experiment) => {
      if (experiment.parentExperimentId) {
        branchCountByParent.set(experiment.parentExperimentId, (branchCountByParent.get(experiment.parentExperimentId) || 0) + 1);
      }
    });
    return branchCountByParent;
  }, [experimentHistory]);

  const branchFamilyPerformance = useMemo(() => {
    const observedRuns = rows.flatMap((row) => row.runs);
    const families = new Map<string, {
      rootExperiment: StudioExperimentRecord;
      experiments: StudioExperimentRecord[];
      runs: PlatformTaskRunRecord[];
      latestAt?: string;
    }>();

    experimentHistory.forEach((experiment) => {
      const rootId = getExperimentRootId(experiment, experimentHistory);
      const rootExperiment = experimentHistory.find((item) => item.id === rootId) || experiment;
      const current = families.get(rootId) || {
        rootExperiment,
        experiments: [],
        runs: [],
        latestAt: undefined,
      };
      current.experiments.push(experiment);
      const matchedRuns = observedRuns.filter((run) => matchesExperimentRun(run, experiment));
      current.runs.push(...matchedRuns);
      matchedRuns.forEach((run) => {
        const candidateAt = run.finishedAt || run.startedAt;
        if (candidateAt && (!current.latestAt || Date.parse(candidateAt) > Date.parse(current.latestAt))) {
          current.latestAt = candidateAt;
        }
      });
      families.set(rootId, current);
    });

    return Array.from(families.values())
      .map((family) => {
        const uniqueRuns = Array.from(new Map(family.runs.map((run) => [run.id, run])).values());
        const stats = summarizeRunCollection(uniqueRuns);
        const scoring = scoreObservedPerformance(stats, family.latestAt);
        return {
          ...family,
          stats,
          ...scoring,
        };
      })
      .filter((family) => family.experiments.length > 0)
      .sort((a, b) => b.score - a.score || b.stats.count - a.stats.count)
      .slice(0, 6);
  }, [experimentHistory, rows]);

  const selectedBranchFamily = useMemo(() => {
    if (branchFamilyPerformance.length === 0) return undefined;
    return branchFamilyPerformance.find((family) => family.rootExperiment.id === selectedBranchRootId) || branchFamilyPerformance[0];
  }, [branchFamilyPerformance, selectedBranchRootId]);

  const comparedBranchFamily = useMemo(() => {
    if (branchFamilyPerformance.length < 2) return undefined;
    if (comparedBranchRootId) {
      const explicit = branchFamilyPerformance.find((family) => family.rootExperiment.id === comparedBranchRootId);
      if (explicit && explicit.rootExperiment.id !== selectedBranchFamily?.rootExperiment.id) return explicit;
    }
    return branchFamilyPerformance.find((family) => family.rootExperiment.id !== selectedBranchFamily?.rootExperiment.id) || undefined;
  }, [branchFamilyPerformance, comparedBranchRootId, selectedBranchFamily?.rootExperiment.id]);

  const branchTrendSeries = useMemo(() => {
    if (!selectedBranchFamily) return null;
    const orderedRuns = selectedBranchFamily.runs
      .filter((run) => run.status === 'succeeded' || run.status === 'failed')
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt || '') - Date.parse(left.finishedAt || left.startedAt || ''));
    return buildTrendSeries(orderedRuns, trendMetric, 360, 140, 12);
  }, [selectedBranchFamily, trendMetric]);

  const selectedBranchMemberPerformance = useMemo(() => {
    if (!selectedBranchFamily) return [];
    return selectedBranchFamily.experiments
      .map((experiment) => {
        const matched = experimentPerformance.find((entry) => entry.experiment.id === experiment.id);
        if (matched) return matched;
        const matchedRuns = selectedBranchFamily.runs.filter((run) => matchesExperimentRun(run, experiment));
        const stats = summarizeRunCollection(matchedRuns);
        const latestAt = matchedRuns[0]?.finishedAt || matchedRuns[0]?.startedAt;
        const scoring = scoreObservedPerformance(stats, latestAt);
        return {
          experiment,
          stats,
          latestAt,
          ...scoring,
        };
      })
      .sort((a, b) => b.score - a.score || b.stats.count - a.stats.count);
  }, [experimentPerformance, selectedBranchFamily]);

  const filteredBranchRuns = useMemo(() => {
    if (!selectedBranchFamily) return [];
    return selectedBranchFamily.runs
      .filter((run) => branchRunFilter === 'all' || run.status === branchRunFilter)
      .slice(0, 6);
  }, [branchRunFilter, selectedBranchFamily]);

  const selectedBranchCausalReport = useMemo(() => {
    if (!selectedBranchFamily) return [] as Array<{ title: string; body: string; tone: string }>;
    const items: Array<{ title: string; body: string; tone: string }> = [];
    const stats = selectedBranchFamily.stats;
    if (stats.successRate >= 0.8 && stats.count >= 3) {
      items.push({
        title: 'This branch family is reliably converting',
        body: `${getExperimentDisplayLabel(selectedBranchFamily.rootExperiment)} is holding ${Math.round(stats.successRate * 100)}% success across ${stats.count} observed runs, which is enough to treat it as a meaningful operating line.`,
        tone: 'border-emerald-500/18 bg-emerald-500/8 text-emerald-100',
      });
    }
    if ((stats.averageCredits || 0) > 0 && selectedRow?.averageCredits && stats.averageCredits < selectedRow.averageCredits) {
      items.push({
        title: 'This line is outperforming the workflow average on spend',
        body: `${formatCredits(stats.averageCredits)} credits on average versus ${formatCredits(selectedRow.averageCredits)} across the workflow means this branch is compounding more efficiently than the baseline path.`,
        tone: 'border-cyan-500/18 bg-cyan-500/8 text-cyan-100',
      });
    }
    const strongestMember = selectedBranchMemberPerformance[0];
    if (strongestMember && strongestMember.stats.count >= 2) {
      items.push({
        title: `${getExperimentDisplayLabel(strongestMember.experiment)} is carrying the line`,
        body: `This member currently leads the branch with score ${strongestMember.score}, ${Math.round(strongestMember.stats.successRate * 100)}% success, and ${strongestMember.confidence}% confidence.`,
        tone: 'border-violet-500/18 bg-violet-500/8 text-violet-100',
      });
    }
    if (items.length === 0) {
      items.push({
        title: 'This branch still needs more evidence',
        body: 'The structure is there, but there are not enough branch-specific runs yet to say what is truly compounding. Keep the line alive and compare a few more runs before promoting it.',
        tone: 'border-amber-500/18 bg-amber-500/8 text-amber-100',
      });
    }
    return items.slice(0, 3);
  }, [selectedBranchFamily, selectedBranchMemberPerformance, selectedRow?.averageCredits]);

  const branchFamilyComparison = useMemo(() => {
    if (!selectedBranchFamily || !comparedBranchFamily) return null;
    const leader = selectedBranchFamily.score >= comparedBranchFamily.score ? selectedBranchFamily : comparedBranchFamily;
    const challenger = leader.rootExperiment.id === selectedBranchFamily.rootExperiment.id ? comparedBranchFamily : selectedBranchFamily;
    return {
      leader,
      challenger,
      successDelta: Math.round((leader.stats.successRate - challenger.stats.successRate) * 100),
      creditsDelta: Math.round((leader.stats.averageCredits || 0) - (challenger.stats.averageCredits || 0)),
      confidenceDelta: leader.confidence - challenger.confidence,
    };
  }, [comparedBranchFamily, selectedBranchFamily]);

  const branchComparisonCharts = useMemo(() => {
    if (!branchFamilyComparison) return null;
    const leaderRuns = branchFamilyComparison.leader.runs
      .filter((run) => run.status === 'succeeded' || run.status === 'failed')
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt || '') - Date.parse(left.finishedAt || left.startedAt || ''));
    const challengerRuns = branchFamilyComparison.challenger.runs
      .filter((run) => run.status === 'succeeded' || run.status === 'failed')
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt || '') - Date.parse(left.finishedAt || left.startedAt || ''));
    return {
      leader: buildTrendSeries(leaderRuns, trendMetric, 260, 120, 10),
      challenger: buildTrendSeries(challengerRuns, trendMetric, 260, 120, 10),
    };
  }, [branchFamilyComparison, trendMetric]);

  const promotionAudit = useMemo(() => {
    const completedRuns = (selectedRow?.runs || [])
      .filter((run) => run.status === 'succeeded' || run.status === 'failed')
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt || '') - Date.parse(left.finishedAt || left.startedAt || ''));

    return (selectedStudioState.promotionHistory || [])
      .map((entry) => {
        const appliedAt = Date.parse(entry.appliedAt);
        if (Number.isNaN(appliedAt)) return null;
        const subsequentRuns = completedRuns
          .filter((run) => Date.parse(run.finishedAt || run.startedAt || '') >= appliedAt)
          .slice(0, 3);
        const stats = summarizeRunCollection(subsequentRuns);
        return {
          ...entry,
          subsequentRuns,
          stats,
          outcome:
            subsequentRuns.length === 0
              ? 'No evidence yet'
              : stats.successRate >= 0.8
                ? 'Positive'
                : stats.successRate >= 0.5
                  ? 'Mixed'
                  : 'Weak',
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, 8);
  }, [selectedRow?.runs, selectedStudioState.promotionHistory]);

  const gateProfileLearning = useMemo(() => {
    const scopedRows = rows.filter((row) => classifyWorkflowArchetype(row.workflowSteps).id === selectedArchetype.id);
    const now = Date.now();
    const maxAgeDays = gateLearningWindow === 'recent' ? 14 : gateLearningWindow === 'deep' ? 45 : Infinity;
    const runRecords = scopedRows.flatMap((row) => {
      const rowStudioState = normalizeStudioState(row.automation.studio_state);
      return row.runs
        .filter((run) => run.status === 'succeeded' || run.status === 'failed')
        .filter((run) => {
          if (!Number.isFinite(maxAgeDays)) return true;
          const runAt = Date.parse(run.finishedAt || run.startedAt || '');
          if (Number.isNaN(runAt)) return false;
          return ((now - runAt) / 86400000) <= maxAgeDays;
        })
        .map((run) => {
          const attribution = getRunExperimentAttribution(run);
          const scenarioId = attribution.scenarioId || rowStudioState.selectedScenarioId || 'baseline';
          const profileId = inferPromotionGateProfileId(rowStudioState, scenarioId, selectedArchetype.id);
          return {
            workflowId: row.automation.id,
            scenarioId,
            profileId,
            run,
          };
        });
    });

    const scenarioScopedRuns = runRecords.filter((item) => item.scenarioId === selectedScenario.id);
    const scopedRecords = scenarioScopedRuns.length >= 3 ? scenarioScopedRuns : runRecords;
    const aggregate = new Map<string, { runs: PlatformTaskRunRecord[]; workflows: Set<string>; latestAt?: string }>();

    scopedRecords.forEach((item) => {
      const current = aggregate.get(item.profileId) || { runs: [], workflows: new Set<string>(), latestAt: undefined };
      current.runs.push(item.run);
      current.workflows.add(item.workflowId);
      const candidateAt = item.run.finishedAt || item.run.startedAt;
      if (candidateAt && (!current.latestAt || Date.parse(candidateAt) > Date.parse(current.latestAt))) {
        current.latestAt = candidateAt;
      }
      aggregate.set(item.profileId, current);
    });

    const items = Array.from(aggregate.entries())
      .map(([profileId, value]) => {
        const profile = getPromotionGateProfileById(profileId);
        if (!profile) return null;
        const stats = summarizeRunCollection(value.runs);
        const scoring = scoreObservedPerformance(stats, value.latestAt);
        return {
          profile,
          stats,
          latestAt: value.latestAt,
          workflowCount: value.workflows.size,
          ...scoring,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => right.score - left.score || right.confidence - left.confidence || right.stats.count - left.stats.count);

    return {
      scenarioMatched: scenarioScopedRuns.length >= 3,
      scopeLabel: scenarioScopedRuns.length >= 3
        ? `${selectedArchetype.label.toLowerCase()} in ${selectedScenario.label.toLowerCase()}`
        : selectedArchetype.label.toLowerCase(),
      windowLabel: gateLearningWindow === 'recent' ? 'last 14 days' : gateLearningWindow === 'deep' ? 'last 45 days' : 'all observed history',
      items: items.slice(0, 3),
      recommendedProfile: items[0]?.profile,
    };
  }, [gateLearningWindow, rows, selectedArchetype.id, selectedArchetype.label, selectedScenario.id, selectedScenario.label]);

  const rollbackSuggestion = useMemo(() => {
    const weak = promotionAudit.find((entry) => entry.outcome === 'Weak');
    if (!weak) return null;
    const weakIndex = promotionAudit.findIndex((entry) => entry.id === weak.id);
    const priorPromotionTarget = promotionAudit
      .slice(weakIndex + 1)
      .map((entry) => experimentHistory.find((experiment) => experiment.id === entry.sourceExperimentId))
      .find((experiment): experiment is StudioExperimentRecord => Boolean(experiment));
    const alternateWinningTarget = experimentPerformance.find((entry) => entry.experiment.id !== weak.sourceExperimentId && entry.stats.count > 0)?.experiment;
    const restoreExperiment = priorPromotionTarget || alternateWinningTarget || (winningExperiment?.experiment.id !== weak.sourceExperimentId ? winningExperiment?.experiment : undefined);
    return {
      title: 'Rollback candidate detected',
      body: restoreExperiment
        ? `${weak.summary} has weak follow-through across ${weak.subsequentRuns.length} subsequent runs. Best restore target right now is ${getExperimentDisplayLabel(restoreExperiment)}.`
        : `${weak.summary} has weak follow-through across ${weak.subsequentRuns.length} subsequent runs. This is a good candidate to unwind or retest before it hardens into the live policy.`,
      entry: weak,
      restoreExperiment,
    };
  }, [experimentHistory, experimentPerformance, promotionAudit, winningExperiment]);

  const replayWeakSpot = useMemo(() => {
    const failingPhase = phaseEvidence
      .filter((phase) => phase.runs >= 2)
      .sort((left, right) => left.successRate - right.successRate || right.runs - left.runs)[0];
    if (!failingPhase) return null;
    const recommendedMode: 'review' | 'cheaper' | 'promote' =
      failingPhase.successRate < 0.65 ? 'review' : failingPhase.averageCredits > 18 ? 'cheaper' : 'promote';
    return {
      phase: failingPhase.phase,
      title: `${formatDirectivePhaseScope([failingPhase.phase])} is the weak link`,
      body: `${formatDirectivePhaseScope([failingPhase.phase])} is only landing ${Math.round(failingPhase.successRate * 100)}% of the time across ${failingPhase.runs} observed steps. Best next move is ${getDirectiveModeLabel(recommendedMode).toLowerCase()} on ${getPreferredRoleForPhase(failingPhase.phase)}.`,
      recommendedMode,
    };
  }, [phaseEvidence]);

  const nextExperimentQueue = useMemo(() => {
    const queue: Array<{
      id: string;
      title: string;
      body: string;
      sourceLabel: string;
      phase?: WorkflowBlockKind;
      mode?: 'cheaper' | 'review' | 'promote';
      action?: 'simulate_phase' | 'focus_phase' | 'apply_policy';
      policyAction?: 'lean_ops' | 'raise_review' | 'match_lanes' | 'trim_lanes' | 'none';
    }> = [];

    if (replayWeakSpot) {
      queue.push({
        id: `weak-${replayWeakSpot.phase}`,
        title: `Stress-test ${formatDirectivePhaseScope([replayWeakSpot.phase])}`,
        body: replayWeakSpot.body,
        sourceLabel: 'Replay weak spot',
        phase: replayWeakSpot.phase,
        mode: replayWeakSpot.recommendedMode,
        action: 'simulate_phase',
      });
    }

    workflowDiagnostics.wasteItems
      .filter((item) => item.action !== 'none')
      .slice(0, 1)
      .forEach((item, index) => {
        queue.push({
          id: `waste-${index}`,
          title: item.title,
          body: item.body,
          sourceLabel: 'Waste diagnostic',
          action: 'apply_policy',
          policyAction: item.action,
        });
      });

    workflowDiagnostics.riskItems
      .filter((item) => item.action !== 'none')
      .slice(0, 1)
      .forEach((item, index) => {
        queue.push({
          id: `risk-${index}`,
          title: item.title,
          body: item.body,
          sourceLabel: 'Risk diagnostic',
          action: 'apply_policy',
          policyAction: item.action,
        });
      });

    phaseLearningByArchetype
      .filter((item) => item.mode !== 'baseline')
      .slice(0, 2)
      .forEach((item) => {
        queue.push({
          id: `learn-${item.phase}-${item.mode}`,
          title: `Replay-test ${formatDirectivePhaseScope([item.phase])}`,
          body: `${getDirectiveModeLabel(item.mode as 'cheaper' | 'review' | 'promote')} is outperforming baseline for this workflow class with ${item.confidence}% confidence.`,
          sourceLabel: 'Phase learning',
          phase: item.phase,
          mode: item.mode as 'cheaper' | 'review' | 'promote',
          action: 'focus_phase',
        });
      });

    if (selectedBranchFamily && selectedBranchFamily.stats.count >= 2) {
      const weakestBranchPhase = phaseEvidence
        .filter((phase) => phase.runs >= 2)
        .sort((left, right) => left.successRate - right.successRate || right.averageCredits - left.averageCredits)[0];
      if (weakestBranchPhase) {
        queue.push({
          id: `branch-${selectedBranchFamily.rootExperiment.id}-${weakestBranchPhase.phase}`,
          title: `Fork a fix for ${formatDirectivePhaseScope([weakestBranchPhase.phase])}`,
          body: `${getExperimentDisplayLabel(selectedBranchFamily.rootExperiment)} has enough evidence to branch. Best next test is a targeted ${getDirectiveModeLabel(weakestBranchPhase.successRate < 0.68 ? 'review' : 'cheaper').toLowerCase()} on ${formatDirectivePhaseScope([weakestBranchPhase.phase])}.`,
          sourceLabel: 'Branch opportunity',
          phase: weakestBranchPhase.phase,
          mode: weakestBranchPhase.successRate < 0.68 ? 'review' : 'cheaper',
          action: 'simulate_phase',
        });
      }
    }

    return queue.slice(0, 5);
  }, [phaseEvidence, phaseLearningByArchetype, replayWeakSpot, selectedBranchFamily, workflowDiagnostics.riskItems, workflowDiagnostics.wasteItems]);

  const gateLearningComparison = useMemo(() => {
    const windows: GateLearningWindow[] = ['recent', 'deep', 'all'];
    const computeWindow = (window: GateLearningWindow) => {
      const now = Date.now();
      const maxAgeDays = window === 'recent' ? 14 : window === 'deep' ? 45 : Infinity;
      const scopedRows = rows.filter((row) => classifyWorkflowArchetype(row.workflowSteps).id === selectedArchetype.id);
      const runs = scopedRows.flatMap((row) => {
        const rowStudioState = normalizeStudioState(row.automation.studio_state);
        return row.runs
          .filter((run) => run.status === 'succeeded' || run.status === 'failed')
          .filter((run) => {
            if (!Number.isFinite(maxAgeDays)) return true;
            const runAt = Date.parse(run.finishedAt || run.startedAt || '');
            return !Number.isNaN(runAt) && ((now - runAt) / 86400000) <= maxAgeDays;
          })
          .map((run) => {
            const attribution = getRunExperimentAttribution(run);
            const scenarioId = attribution.scenarioId || rowStudioState.selectedScenarioId || 'baseline';
            const profileId = inferPromotionGateProfileId(rowStudioState, scenarioId, selectedArchetype.id);
            return { profileId, run, workflowId: row.automation.id, scenarioId };
          });
      });
      const scenarioScoped = runs.filter((item) => item.scenarioId === selectedScenario.id);
      const active = scenarioScoped.length >= 3 ? scenarioScoped : runs;
      const aggregate = new Map<string, { runs: PlatformTaskRunRecord[]; workflows: Set<string>; latestAt?: string }>();
      active.forEach((item) => {
        const current = aggregate.get(item.profileId) || { runs: [], workflows: new Set<string>(), latestAt: undefined };
        current.runs.push(item.run);
        current.workflows.add(item.workflowId);
        const candidateAt = item.run.finishedAt || item.run.startedAt;
        if (candidateAt && (!current.latestAt || Date.parse(candidateAt) > Date.parse(current.latestAt))) {
          current.latestAt = candidateAt;
        }
        aggregate.set(item.profileId, current);
      });
      const leader = Array.from(aggregate.entries())
        .map(([profileId, value]) => {
          const profile = getPromotionGateProfileById(profileId);
          if (!profile) return null;
          return {
            profile,
            workflowCount: value.workflows.size,
            stats: summarizeRunCollection(value.runs),
            ...scoreObservedPerformance(summarizeRunCollection(value.runs), value.latestAt),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((left, right) => right.score - left.score || right.confidence - left.confidence)[0];
      return {
        window,
        label: window === 'recent' ? 'Recent' : window === 'deep' ? 'Deep' : 'All',
        leader,
      };
    };

    const windowsResult = windows.map(computeWindow);
    const uniqueLeaders = [...new Set(windowsResult.map((item) => item.leader?.profile.id).filter(Boolean))];
    return {
      windows: windowsResult,
      stability: uniqueLeaders.length <= 1 ? 'Stable' : uniqueLeaders.length === 2 ? 'Mixed' : 'Diverging',
    };
  }, [rows, selectedArchetype.id, selectedScenario.id]);

  const recommendedGateProfile = useMemo(() => {
    if (gateProfileLearning.recommendedProfile && gateProfileLearning.items[0]?.stats.count >= 2) {
      return gateProfileLearning.recommendedProfile;
    }
    if (selectedScenario.id === 'high_stakes' || selectedPolicy.reviewPolicy === 'strict') {
      return PROMOTION_GATE_PROFILES.find((item) => item.id === 'conservative');
    }
    if (evidenceFreshness.tone === 'stale' || (selectedRow?.successRate || 0) < 0.65) {
      return PROMOTION_GATE_PROFILES.find((item) => item.id === 'conservative');
    }
    if (selectedScenario.id === 'monitoring' || selectedPolicy.optimizationGoal === 'cost_saver') {
      return PROMOTION_GATE_PROFILES.find((item) => item.id === 'aggressive');
    }
    return PROMOTION_GATE_PROFILES.find((item) => item.id === 'balanced');
  }, [evidenceFreshness.tone, gateProfileLearning.items, gateProfileLearning.recommendedProfile, selectedPolicy.optimizationGoal, selectedPolicy.reviewPolicy, selectedRow?.successRate, selectedScenario.id]);

  const activeGateScope = useMemo(() => {
    if (selectedStudioState.autoPromotionScenarioThresholds?.[selectedScenario.id]) {
      return { scope: 'Scenario gate', label: selectedScenario.label };
    }
    if (selectedStudioState.autoPromotionArchetypeThresholds?.[selectedArchetype.id]) {
      return { scope: 'Workflow-class gate', label: selectedArchetype.label };
    }
    return { scope: 'Global gate', label: 'All workflows' };
  }, [
    selectedArchetype.id,
    selectedArchetype.label,
    selectedScenario.id,
    selectedScenario.label,
    selectedStudioState.autoPromotionArchetypeThresholds,
    selectedStudioState.autoPromotionScenarioThresholds,
  ]);

  const replayBaseRun = focusedCohortRun || selectedCohortRun;

  const replayPhaseOverlay = useMemo(() => {
    return buildReplayPhaseOverlay(replayBaseRun, phaseEvidence);
  }, [phaseEvidence, replayBaseRun]);

  const replayComparedRun = useMemo(() => {
    if (!runComparison?.previous?.id || !selectedRow) return null;
    return selectedRow.runs.find((run) => run.id === runComparison.previous?.id) || null;
  }, [runComparison?.previous?.id, selectedRow]);

  const replayComparedTimeline = useMemo(() => {
    if (!replayComparedRun) return [] as Array<DashboardTaskStepExecution & { marker: number; duration: string; tokens: string }>;
    return readStepExecutions(replayComparedRun.metadata?.stepExecutions).map((step, index) => ({
      ...step,
      marker: index + 1,
      duration: formatCompactDuration(step.durationMs),
      tokens: formatTokenCount(step.tokenUsage?.totalTokens),
    }));
  }, [replayComparedRun]);

  const replayComparedPhaseOverlay = useMemo(
    () => buildReplayPhaseOverlay(replayComparedRun, phaseEvidence),
    [phaseEvidence, replayComparedRun],
  );

  const selectedReplayPhaseDetail = useMemo(() => {
    if (selectedReplayPhase === 'all') return replayPhaseOverlay[0];
    return replayPhaseOverlay.find((entry) => entry.phase === selectedReplayPhase) || replayPhaseOverlay[0];
  }, [replayPhaseOverlay, selectedReplayPhase]);

  const selectedReplayComparedPhaseDetail = useMemo(() => {
    if (selectedReplayPhase === 'all') return replayComparedPhaseOverlay[0];
    return replayComparedPhaseOverlay.find((entry) => entry.phase === selectedReplayPhase) || replayComparedPhaseOverlay[0];
  }, [replayComparedPhaseOverlay, selectedReplayPhase]);

  const selectedReplayPhaseDelta = useMemo(() => {
    if (!selectedReplayPhaseDetail) return null;
    return {
      creditsDelta: (selectedReplayPhaseDetail.credits || 0) - (selectedReplayPhaseDetail.baselineCredits || 0),
      durationDelta: (selectedReplayPhaseDetail.durationMs || 0) - (selectedReplayPhaseDetail.baselineDurationMs || 0),
      expectedSuccess: Math.round((selectedReplayPhaseDetail.baselineSuccessRate || 0) * 100),
      actualStatus: selectedReplayPhaseDetail.failed ? 'failed' : selectedReplayPhaseDetail.succeeded ? 'succeeded' : 'unknown',
    };
  }, [selectedReplayPhaseDetail]);

  const replayDualRunDiff = useMemo(() => {
    if (!selectedReplayPhaseDetail || !selectedReplayComparedPhaseDetail || !runComparison?.previous) return null;
    return {
      comparedRunLabel: runComparison.previous.experimentLabel || `${runComparison.previous.scenarioLabel} · ${runComparison.previous.presetLabel}`,
      creditsDelta: (selectedReplayPhaseDetail.credits || 0) - (selectedReplayComparedPhaseDetail.credits || 0),
      durationDelta: (selectedReplayPhaseDetail.durationMs || 0) - (selectedReplayComparedPhaseDetail.durationMs || 0),
      tokensDelta: (selectedReplayPhaseDetail.tokens || 0) - (selectedReplayComparedPhaseDetail.tokens || 0),
      directiveShift:
        selectedReplayPhaseDetail.directiveMode === selectedReplayComparedPhaseDetail.directiveMode
          ? null
          : {
              current: selectedReplayPhaseDetail.directiveMode,
              compared: selectedReplayComparedPhaseDetail.directiveMode,
            },
      statusPair: {
        current: selectedReplayPhaseDetail.failed ? 'failed' : selectedReplayPhaseDetail.succeeded ? 'succeeded' : 'unknown',
        compared: selectedReplayComparedPhaseDetail.failed ? 'failed' : selectedReplayComparedPhaseDetail.succeeded ? 'succeeded' : 'unknown',
      },
    };
  }, [runComparison?.previous, selectedReplayComparedPhaseDetail, selectedReplayPhaseDetail]);

  const recommendedReplayFix = useMemo(() => {
    const fallbackPhase = selectedReplayPhaseDetail?.phase || replayWeakSpot?.phase;
    if (!fallbackPhase) return null;
    const inferredMode: 'cheaper' | 'review' | 'promote' = replayWeakSpot?.recommendedMode
      || (
        selectedReplayPhaseDelta && selectedReplayPhaseDelta.creditsDelta > 10
          ? 'cheaper'
          : selectedReplayPhaseDelta?.actualStatus === 'failed'
            ? 'review'
            : 'promote'
      );
    return {
      phase: fallbackPhase,
      mode: inferredMode,
    };
  }, [replayWeakSpot, selectedReplayPhaseDelta, selectedReplayPhaseDetail?.phase]);

  const replayDecisionBrief = useMemo(() => {
    const focusPhase = recommendedReplayFix?.phase || selectedReplayPhaseDetail?.phase || replayWeakSpot?.phase;
    const fixMode = recommendedReplayFix?.mode || 'review';
    const focusLabel = focusPhase ? formatDirectivePhaseScope([focusPhase]) : 'selected phase';
    const fixModeLabel = getDirectiveModeLabel(fixMode);

    const headline = replayWeakSpot
      ? `${focusLabel} is the first fix worth testing`
      : selectedReplayPhaseDelta?.actualStatus === 'failed'
        ? `${focusLabel} likely drove the failed outcome`
        : selectedReplayPhaseDelta && selectedReplayPhaseDelta.creditsDelta > 10
          ? `${focusLabel} looks like the main cost lever`
          : `Replay points to ${focusLabel} as the next place to tighten`;

    const rationale = replayWeakSpot
      ? replayWeakSpot.body
      : selectedReplayPhaseDelta
        ? `${focusLabel} came in at ${selectedReplayPhaseDelta.expectedSuccess}% expected success and landed as ${selectedReplayPhaseDelta.actualStatus}. ${selectedReplayPhaseDelta.creditsDelta > 0 ? 'It also spent more than baseline.' : 'Its cost stayed close to or below baseline.'}`
        : replayInsights[0]?.body || 'Replay has enough signal to focus the next change, but not enough to justify a broad policy move.';

    let promotionReadiness = 'Test once more before promoting.';
    if (runComparison?.previous) {
      const creditsBetter = runComparison.current.credits <= runComparison.previous.credits;
      const durationBetter = (runComparison.current.durationMs || 0) <= (runComparison.previous.durationMs || 0);
      const outcomeBetter = runComparison.current.status === 'succeeded' && runComparison.previous.status !== 'succeeded';
      if (outcomeBetter && creditsBetter) {
        promotionReadiness = 'Promising enough to validate once more before promotion.';
      } else if (runComparison.current.status === 'failed' || (!creditsBetter && !durationBetter)) {
        promotionReadiness = 'Not promotion-worthy yet. Fix first, then replay again.';
      } else {
        promotionReadiness = 'Promising, but still better treated as a test than a live promotion.';
      }
    }

    return {
      headline,
      rationale,
      nextStep: `Test ${fixModeLabel.toLowerCase()} on ${focusLabel.toLowerCase()} first, then come back here to compare the rerun before promoting anything broader.`,
      promotionReadiness,
      focusLabel,
      fixModeLabel,
      deltas: [
        {
          label: 'Credits vs baseline',
          value: selectedReplayPhaseDelta ? `${formatSignedDelta(Math.round(selectedReplayPhaseDelta.creditsDelta))} cr` : '—',
          tone: !selectedReplayPhaseDelta ? 'neutral' : selectedReplayPhaseDelta.creditsDelta <= 0 ? 'positive' : 'negative',
        },
        {
          label: 'Duration vs baseline',
          value: selectedReplayPhaseDelta ? `${formatSignedDelta(Math.round(selectedReplayPhaseDelta.durationDelta / 1000))}s` : '—',
          tone: !selectedReplayPhaseDelta ? 'neutral' : selectedReplayPhaseDelta.durationDelta <= 0 ? 'positive' : 'negative',
        },
        {
          label: 'Expected success',
          value: selectedReplayPhaseDelta ? `${selectedReplayPhaseDelta.expectedSuccess}% -> ${selectedReplayPhaseDelta.actualStatus}` : '—',
          tone: selectedReplayPhaseDelta?.actualStatus === 'failed' ? 'negative' : 'neutral',
        },
      ] as Array<{ label: string; value: string; tone: 'positive' | 'negative' | 'neutral' }>,
    };
  }, [
    replayInsights,
    replayWeakSpot,
    recommendedReplayFix,
    runComparison,
    selectedReplayPhaseDelta,
    selectedReplayPhaseDetail?.phase,
  ]);

  const replayPhaseComparisonRows = useMemo(() => {
    if (!replayComparedPhaseOverlay.length) return [];
    const phaseOrder: WorkflowBlockKind[] = ['search', 'query', 'capture', 'analyze', 'summarize', 'deliver', 'note'];
    return phaseOrder
      .map((phase) => {
        const current = replayPhaseOverlay.find((entry) => entry.phase === phase);
        const compared = replayComparedPhaseOverlay.find((entry) => entry.phase === phase);
        if (!current && !compared) return null;
        return {
          phase,
          currentCredits: current?.credits || 0,
          comparedCredits: compared?.credits || 0,
          creditsDelta: (current?.credits || 0) - (compared?.credits || 0),
          currentDurationMs: current?.durationMs || 0,
          comparedDurationMs: compared?.durationMs || 0,
          durationDelta: (current?.durationMs || 0) - (compared?.durationMs || 0),
          currentStatus: current ? (current.failed ? 'failed' : current.succeeded ? 'succeeded' : 'unknown') : 'not_used',
          comparedStatus: compared ? (compared.failed ? 'failed' : compared.succeeded ? 'succeeded' : 'unknown') : 'not_used',
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [replayComparedPhaseOverlay, replayPhaseOverlay]);

  const pairedReplayPhaseTimeline = useMemo(() => {
    const phaseOrder: WorkflowBlockKind[] = ['search', 'query', 'capture', 'analyze', 'summarize', 'deliver', 'note'];
    return phaseOrder
      .map((phase) => {
        const currentSteps = replayTimeline.filter((step) => step.kind === phase);
        const comparedSteps = replayComparedTimeline.filter((step) => step.kind === phase);
        if (currentSteps.length === 0 && comparedSteps.length === 0) return null;
        const currentCredits = currentSteps.reduce((sum, step) => sum + (step.actualCredits || 0), 0);
        const comparedCredits = comparedSteps.reduce((sum, step) => sum + (step.actualCredits || 0), 0);
        const currentDurationMs = currentSteps.reduce((sum, step) => sum + (step.durationMs || 0), 0);
        const comparedDurationMs = comparedSteps.reduce((sum, step) => sum + (step.durationMs || 0), 0);
        const currentFailed = currentSteps.some((step) => step.status === 'failed');
        const comparedFailed = comparedSteps.some((step) => step.status === 'failed');
        const currentSucceeded = currentSteps.some((step) => step.status === 'succeeded');
        const comparedSucceeded = comparedSteps.some((step) => step.status === 'succeeded');
        let verdict = 'Both runs used this phase with similar weight.';
        if (currentFailed && !comparedFailed) {
          verdict = 'Current run regressed here. This phase introduced a failure the comparison avoided.';
        } else if (!currentFailed && comparedFailed) {
          verdict = 'Current run recovered this phase cleanly and removed a failure from the comparison.';
        } else if (currentCredits < comparedCredits && currentDurationMs <= comparedDurationMs) {
          verdict = 'Current run handled this phase more efficiently: lower spend with equal or better speed.';
        } else if (currentCredits > comparedCredits && currentDurationMs > comparedDurationMs) {
          verdict = 'Current run is heavier here on both spend and time. This phase is driving extra drag.';
        } else if (currentCredits > comparedCredits && currentSucceeded && !comparedSucceeded) {
          verdict = 'Current run is spending more here, but it may be buying reliability the comparison missed.';
        } else if (currentDurationMs > comparedDurationMs) {
          verdict = 'Current run is slower in this phase even though the result quality does not clearly improve.';
        } else if (currentCredits < comparedCredits) {
          verdict = 'Current run trimmed cost in this phase without obviously weakening the outcome.';
        }
        return {
          phase,
          currentSteps,
          comparedSteps,
          currentCredits,
          comparedCredits,
          currentDurationMs,
          comparedDurationMs,
          verdict,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [replayComparedTimeline, replayTimeline]);

  const branchOpportunityMap = useMemo(() => {
    const baselineCredits = selectedRow?.averageCredits || 0;
    return branchFamilyPerformance.slice(0, 4).map((family) => {
      const weakestPhase = phaseEvidence
        .filter((phase) => phase.runs >= 2)
        .sort((left, right) => left.successRate - right.successRate || right.averageCredits - left.averageCredits)[0];
      return {
        id: family.rootExperiment.id,
        label: getExperimentDisplayLabel(family.rootExperiment),
        score: family.score,
        confidence: family.confidence,
        successRate: Math.round(family.stats.successRate * 100),
        spendDelta: Math.round((family.stats.averageCredits || 0) - baselineCredits),
        focusPhase: weakestPhase?.phase,
      };
    });
  }, [branchFamilyPerformance, phaseEvidence, selectedRow?.averageCredits]);

  const savedPlanSummaries = useMemo(() => {
    const planPool = savedOperatingPlans;
    return savedOperatingPlans.map((plan) => {
      const spendIndex = estimatePolicySpendIndex(plan.executionPolicy, selectedRow?.workflowSteps || []);
      const assuranceIndex = estimatePolicyAssuranceIndex(plan.executionPolicy, selectedRow?.workflowSteps || []);
      const fitIndex = estimatePolicyFitIndex(plan.executionPolicy, selectedRow?.workflowSteps || []);
      const sourceExperiment = plan.sourceExperimentId
        ? experimentHistory.find((experiment) => experiment.id === plan.sourceExperimentId)
        : undefined;
      const matchedRuns = (selectedRow?.runs || [])
        .filter((run) => run.status === 'succeeded' || run.status === 'failed')
        .filter((run) => rankRunPlanMatches(run, planPool).some((entry) => entry.plan.id === plan.id && entry.score >= 50))
        .sort((left, right) => Date.parse(right.finishedAt || right.startedAt) - Date.parse(left.finishedAt || left.startedAt));
      const stats = summarizeRunCollection(matchedRuns);
      const scoring = scoreObservedPerformance(stats, matchedRuns[0]?.finishedAt || matchedRuns[0]?.startedAt);
      return {
        plan,
        spendIndex,
        assuranceIndex,
        fitIndex,
        steeringCount: countDirectiveEntries(plan.roleDirectives),
        sourceExperiment,
        stats,
        score: scoring.score,
        confidence: scoring.confidence,
        freshness: scoring.freshness,
        familyRootId: (() => {
          let current = plan;
          const visited = new Set<string>();
          const byId = new Map(savedOperatingPlans.map((item) => [item.id, item] as const));
          while (current.parentPlanId && !visited.has(current.parentPlanId)) {
            visited.add(current.id);
            const parent = byId.get(current.parentPlanId);
            if (!parent) break;
            current = parent;
          }
          return current.id;
        })(),
      };
    });
  }, [experimentHistory, savedOperatingPlans, selectedRow?.runs, selectedRow?.workflowSteps]);

  const filteredSavedPlans = useMemo(
    () => savedPlanSummaries.filter((entry) => selectedPlanIntentFilter === 'all' || entry.plan.intentLabel === selectedPlanIntentFilter),
    [savedPlanSummaries, selectedPlanIntentFilter]
  );

  const activeSavedPlan = useMemo(
    () => filteredSavedPlans.find((entry) => entry.plan.id === selectedPlanId) || filteredSavedPlans[0] || savedPlanSummaries[0],
    [filteredSavedPlans, savedPlanSummaries, selectedPlanId]
  );

  const comparedSavedPlan = useMemo(
    () =>
      filteredSavedPlans.find((entry) => entry.plan.id === selectedPlanCompareId)
      || filteredSavedPlans.find((entry) => entry.plan.id !== activeSavedPlan?.plan.id)
      || savedPlanSummaries.find((entry) => entry.plan.id === selectedPlanCompareId),
    [activeSavedPlan?.plan.id, filteredSavedPlans, savedPlanSummaries, selectedPlanCompareId]
  );

  const planFamilies = useMemo(() => {
    const grouped = new Map<string, typeof filteredSavedPlans>();
    filteredSavedPlans.forEach((entry) => {
      const bucket = grouped.get(entry.familyRootId) || [];
      bucket.push(entry);
      grouped.set(entry.familyRootId, bucket);
    });
    return Array.from(grouped.values()).map((entries) => {
      const sortedEntries = entries.slice().sort((left, right) => right.score - left.score || right.confidence - left.confidence);
      const familyRuns = (selectedRow?.runs || [])
        .filter((run) => run.status === 'succeeded' || run.status === 'failed')
        .filter((run) => sortedEntries.some((entry) => rankRunPlanMatches(run, sortedEntries.map((item) => item.plan)).some((match) => match.plan.id === entry.plan.id && match.score >= 50)));
      return {
        root: sortedEntries[0],
        entries: sortedEntries,
        runs: familyRuns,
        trend: buildTrendSeries(familyRuns, trendMetric, 220, 86, 8),
      };
    });
  }, [filteredSavedPlans, selectedRow?.runs, trendMetric]);

  const selectedPlanFamily = useMemo(
    () => planFamilies.find((family) => family.root.familyRootId === selectedPlanFamilyRootId) || planFamilies.find((family) => family.entries.some((entry) => entry.plan.id === activeSavedPlan?.plan.id)) || planFamilies[0],
    [activeSavedPlan?.plan.id, planFamilies, selectedPlanFamilyRootId]
  );

  const selectedPlanFamilyReplay = useMemo(() => {
    if (!selectedPlanFamily) return null;
    const familyRuns = selectedPlanFamily.runs
      .slice()
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt) - Date.parse(left.finishedAt || left.startedAt))
      .slice(0, 6);
    const leaderboard = selectedPlanFamily.entries
      .map((entry) => {
        const branchRuns = familyRuns.filter((run) => rankRunPlanMatches(run, selectedPlanFamily.entries.map((item) => item.plan))[0]?.plan.id === entry.plan.id);
        const stats = summarizeRunCollection(branchRuns);
        return {
          ...entry,
          stats,
        };
      })
      .sort((left, right) => right.stats.successRate - left.stats.successRate || right.stats.count - left.stats.count || left.stats.averageCredits - right.stats.averageCredits);
    return {
      family: selectedPlanFamily,
      runs: familyRuns,
      leaderboard,
      trend: buildTrendSeries(familyRuns, trendMetric, 320, 110, 12),
    };
  }, [selectedPlanFamily, trendMetric]);

  const comparedPlanFamily = useMemo(() => {
    if (!selectedPlanFamily || planFamilies.length < 2) return undefined;
    const explicit = planFamilies.find((family) => family.entries.some((entry) => entry.plan.id === selectedPlanCompareId) && family.root.familyRootId !== selectedPlanFamily.root.familyRootId);
    if (explicit) return explicit;
    return planFamilies.find((family) => family.root.familyRootId !== selectedPlanFamily.root.familyRootId);
  }, [planFamilies, selectedPlanCompareId, selectedPlanFamily]);

  const planFamilyComparison = useMemo(() => {
    if (!selectedPlanFamily || !comparedPlanFamily) return null;
    const primaryStats = summarizeRunCollection(selectedPlanFamily.runs);
    const comparedStats = summarizeRunCollection(comparedPlanFamily.runs);
    return {
      primary: selectedPlanFamily,
      compared: comparedPlanFamily,
      primaryStats,
      comparedStats,
      successDelta: Math.round((primaryStats.successRate - comparedStats.successRate) * 100),
      creditsDelta: Math.round((primaryStats.averageCredits || 0) - (comparedStats.averageCredits || 0)),
      durationDelta: Math.round(((primaryStats.averageDurationMs || 0) - (comparedStats.averageDurationMs || 0)) / 1000),
    };
  }, [comparedPlanFamily, selectedPlanFamily]);

  const planFamilyReplayComparison = useMemo(() => {
    if (!selectedPlanFamily || !comparedPlanFamily) return null;
    const primaryRun = selectedPlanFamily.runs
      .filter((run) => run.status === 'succeeded' || run.status === 'failed')
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt) - Date.parse(left.finishedAt || left.startedAt))[0];
    const comparedRun = comparedPlanFamily.runs
      .filter((run) => run.status === 'succeeded' || run.status === 'failed')
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt) - Date.parse(left.finishedAt || left.startedAt))[0];
    return {
      primaryRun,
      comparedRun,
    };
  }, [comparedPlanFamily, selectedPlanFamily]);

  const planFamilyPhaseComparison = useMemo(() => {
    if (!planFamilyReplayComparison?.primaryRun || !planFamilyReplayComparison.comparedRun) return null;
    const primarySteps = readStepExecutions(planFamilyReplayComparison.primaryRun.metadata?.stepExecutions);
    const comparedSteps = readStepExecutions(planFamilyReplayComparison.comparedRun.metadata?.stepExecutions);
    const candidatePhase = selectedReplayPhase !== 'all'
      ? selectedReplayPhase
      : (primarySteps.filter((step) => step.kind !== 'note').sort((left, right) => (right.actualCredits || 0) - (left.actualCredits || 0))[0]?.kind as WorkflowBlockKind | undefined)
        || (comparedSteps.filter((step) => step.kind !== 'note').sort((left, right) => (right.actualCredits || 0) - (left.actualCredits || 0))[0]?.kind as WorkflowBlockKind | undefined);
    if (!candidatePhase || candidatePhase === 'note') return null;
    const summarizePhase = (steps: DashboardTaskStepExecution[]) => {
      const phaseSteps = steps.filter((step) => step.kind === candidatePhase);
      return {
        phase: candidatePhase,
        count: phaseSteps.length,
        credits: phaseSteps.reduce((sum, step) => sum + (step.actualCredits || 0), 0),
        durationMs: phaseSteps.reduce((sum, step) => sum + (step.durationMs || 0), 0),
        failed: phaseSteps.some((step) => step.status === 'failed'),
        succeeded: phaseSteps.some((step) => step.status === 'succeeded'),
      };
    };
    return {
      phase: candidatePhase,
      primary: summarizePhase(primarySteps),
      compared: summarizePhase(comparedSteps),
    };
  }, [planFamilyReplayComparison, selectedReplayPhase]);

  const planComparison = useMemo(() => {
    if (!activeSavedPlan || !comparedSavedPlan) return null;
    return {
      primary: activeSavedPlan,
      compared: comparedSavedPlan,
      spendDelta: activeSavedPlan.spendIndex - comparedSavedPlan.spendIndex,
      assuranceDelta: activeSavedPlan.assuranceIndex - comparedSavedPlan.assuranceIndex,
      fitDelta: activeSavedPlan.fitIndex - comparedSavedPlan.fitIndex,
      successDelta: Math.round((activeSavedPlan.stats.successRate - comparedSavedPlan.stats.successRate) * 100),
      creditsDelta: Math.round((activeSavedPlan.stats.averageCredits || 0) - (comparedSavedPlan.stats.averageCredits || 0)),
    };
  }, [activeSavedPlan, comparedSavedPlan]);

  const savedPlanAudit = useMemo(() => {
    return savedPlanSummaries
      .map((entry) => ({
        ...entry,
        outcome:
          entry.stats.count === 0
            ? 'No evidence yet'
            : entry.stats.successRate >= 0.8
              ? 'Compounding'
              : entry.stats.successRate >= 0.6
                ? 'Promising'
                : 'Weak',
      }))
      .sort((left, right) => right.score - left.score || right.confidence - left.confidence || right.stats.count - left.stats.count)
      .slice(0, 5);
  }, [savedPlanSummaries]);

  const recommendedPlan = useMemo(
    () => savedPlanAudit.find((entry) => entry.outcome === 'Compounding') || savedPlanAudit.find((entry) => entry.outcome === 'Promising') || savedPlanAudit[0],
    [savedPlanAudit]
  );

  const pinnedSuggestedPlan = useMemo(
    () => selectedStudioState.pinnedSuggestedPlanId ? savedPlanSummaries.find((entry) => entry.plan.id === selectedStudioState.pinnedSuggestedPlanId) : undefined,
    [savedPlanSummaries, selectedStudioState.pinnedSuggestedPlanId]
  );

  const dismissedSuggestedPlanId = selectedStudioState.dismissedSuggestedPlanId;

  const planRollbackSuggestion = useMemo(() => {
    if (!activeSavedPlan) return null;
    const activeAudit = savedPlanAudit.find((entry) => entry.plan.id === activeSavedPlan.plan.id);
    if (!activeAudit || activeAudit.outcome !== 'Weak') return null;
    const restoreTarget = savedPlanAudit.find((entry) => entry.plan.id !== activeSavedPlan.plan.id && (entry.outcome === 'Compounding' || entry.outcome === 'Promising'));
    return restoreTarget ? { active: activeAudit, restoreTarget } : null;
  }, [activeSavedPlan, savedPlanAudit]);

  const selectedRunMatchedPlans = useMemo(
    () => (selectedCohortRun ? rankRunPlanMatches(selectedCohortRun, savedPlanSummaries.map((entry) => entry.plan)).slice(0, 3).map((match) => ({ ...match, summary: savedPlanSummaries.find((entry) => entry.plan.id === match.plan.id) })) : []),
    [savedPlanSummaries, selectedCohortRun]
  );

  const currentComparisonRunRecord = useMemo(
    () => [...(currentCohortPerformance?.runs || []), ...(selectedExperimentPerformance?.runs || [])].find((run) => run.id === runComparison?.current.id),
    [currentCohortPerformance?.runs, runComparison, selectedExperimentPerformance?.runs]
  );

  const previousComparisonRunRecord = useMemo(
    () => [...(currentCohortPerformance?.runs || []), ...(selectedExperimentPerformance?.runs || [])].find((run) => run.id === runComparison?.previous?.id),
    [currentCohortPerformance?.runs, runComparison?.previous?.id, selectedExperimentPerformance?.runs]
  );

  const runComparisonMatchedPlans = useMemo(() => ({
    current: currentComparisonRunRecord ? rankRunPlanMatches(currentComparisonRunRecord, savedPlanSummaries.map((entry) => entry.plan)).slice(0, 2).map((match) => ({ ...match, summary: savedPlanSummaries.find((entry) => entry.plan.id === match.plan.id) })) : [],
    previous: previousComparisonRunRecord ? rankRunPlanMatches(previousComparisonRunRecord, savedPlanSummaries.map((entry) => entry.plan)).slice(0, 2).map((match) => ({ ...match, summary: savedPlanSummaries.find((entry) => entry.plan.id === match.plan.id) })) : [],
  }), [currentComparisonRunRecord, previousComparisonRunRecord, savedPlanSummaries]);

  const activeBranchParentComparison = useMemo(() => {
    if (!activeSavedPlan?.plan.parentPlanId) return null;
    const parent = savedPlanSummaries.find((entry) => entry.plan.id === activeSavedPlan.plan.parentPlanId);
    if (!parent) return null;
    const childRuns = activeSavedPlan.stats.count > 0
      ? (selectedRow?.runs || [])
          .filter((run) => run.status === 'succeeded' || run.status === 'failed')
          .filter((run) => rankRunPlanMatches(run, [activeSavedPlan.plan, parent.plan])[0]?.plan.id === activeSavedPlan.plan.id)
          .filter((run) => Date.parse(run.finishedAt || run.startedAt) >= Date.parse(activeSavedPlan.plan.createdAt))
          .slice(0, 8)
      : [];
    const childStats = summarizeRunCollection(childRuns);
    const childScoring = scoreObservedPerformance(childStats, childRuns[0]?.finishedAt || childRuns[0]?.startedAt);
    return {
      parent,
      child: activeSavedPlan,
      childStats,
      childScoring,
      childRunCount: childRuns.length,
      successDelta: childRuns.length > 0 ? Math.round((childStats.successRate - parent.stats.successRate) * 100) : undefined,
      creditsDelta: childRuns.length > 0 ? Math.round((childStats.averageCredits || 0) - (parent.stats.averageCredits || 0)) : undefined,
      durationDelta: childRuns.length > 0 ? Math.round(((childStats.averageDurationMs || 0) - (parent.stats.averageDurationMs || 0)) / 1000) : undefined,
      outcome:
        childRuns.length === 0
          ? 'No evidence yet'
          : childStats.successRate >= parent.stats.successRate && (childStats.averageCredits || 0) <= (parent.stats.averageCredits || 0)
            ? 'Compounding'
          : childStats.successRate >= parent.stats.successRate - 0.04
              ? 'Promising'
              : 'Weak',
      graduationReady: childRuns.length >= 4 && childStats.successRate >= parent.stats.successRate + 0.08 && (childStats.averageCredits || 0) <= (parent.stats.averageCredits || 0) + 4,
    };
  }, [activeSavedPlan, savedPlanSummaries, selectedRow?.runs]);

  const archetypePlanLearning = useMemo(() => {
    const relevantRows = rows.filter((row) => classifyWorkflowArchetype(row.workflowSteps).id === selectedArchetype.id);
    const aggregate = new Map<string, { label: string; plans: number; runs: PlatformTaskRunRecord[]; latestAt?: string }>();
    relevantRows.forEach((row) => {
      const studioState = normalizeStudioState(row.automation.studio_state);
      (studioState.savedPlans || []).forEach((plan) => {
        const key = plan.intentLabel || inferOperatingPlanIntent(plan.executionPolicy, plan.scenarioId, row.workflowSteps);
        const current = aggregate.get(key) || { label: key, plans: 0, runs: [], latestAt: undefined };
        current.plans += 1;
        const matchingRuns = row.runs
          .filter((run) => run.status === 'succeeded' || run.status === 'failed')
          .filter((run) => doesRunMatchPlan(run, plan));
        current.runs.push(...matchingRuns);
        const candidateAt = matchingRuns[0]?.finishedAt || matchingRuns[0]?.startedAt;
        if (candidateAt && (!current.latestAt || Date.parse(candidateAt) > Date.parse(current.latestAt))) {
          current.latestAt = candidateAt;
        }
        aggregate.set(key, current);
      });
    });

    return Array.from(aggregate.values())
      .map((item) => {
        const stats = summarizeRunCollection(item.runs);
        const scoring = scoreObservedPerformance(stats, item.latestAt);
        return {
          ...item,
          stats,
          score: scoring.score,
          confidence: scoring.confidence,
        };
      })
      .filter((item) => item.plans > 0)
      .sort((left, right) => right.score - left.score || right.confidence - left.confidence || right.stats.count - left.stats.count)
      .slice(0, 4);
  }, [rows, selectedArchetype.id]);

  const archetypeRecommendedPlan = useMemo(() => {
    const topIntent = archetypePlanLearning[0]?.label;
    const learned = topIntent ? savedPlanAudit.find((entry) => entry.plan.intentLabel === topIntent) : undefined;
    if (pinnedSuggestedPlan) return pinnedSuggestedPlan;
    if (learned && learned.plan.id !== dismissedSuggestedPlanId) return learned;
    if (recommendedPlan && recommendedPlan.plan.id !== dismissedSuggestedPlanId) return recommendedPlan;
    return savedPlanAudit.find((entry) => entry.plan.id !== dismissedSuggestedPlanId) || recommendedPlan;
  }, [archetypePlanLearning, dismissedSuggestedPlanId, pinnedSuggestedPlan, recommendedPlan, savedPlanAudit]);

  const archetypeRecommendedPlanMode = useMemo(() => {
    if (!archetypeRecommendedPlan) return 'none' as const;
    if (archetypeRecommendedPlan.confidence < 60 || archetypeRecommendedPlan.stats.count < 2) return 'suggested' as const;
    return 'auto' as const;
  }, [archetypeRecommendedPlan]);

  const autoGraduateEnabled = selectedStudioState.autoGraduateEnabled === true;
  const workspaceAutoGraduationProfile = useMemo(
    () => getAutoGraduationProfileById(workspaceAutoGraduationProfiles[selectedArchetype.id]),
    [selectedArchetype.id, workspaceAutoGraduationProfiles]
  );

  const activeAutoGraduationProfile = useMemo(
    () => getAutoGraduationProfileById(inferAutoGraduationProfileIdFromThreshold(
      selectedStudioState.autoGraduateArchetypeThresholds?.[selectedArchetype.id]
        ?? workspaceAutoGraduationProfile?.archetype
        ?? selectedStudioState.autoGraduateMinConfidence
        ?? 72
    )) || AUTO_GRADUATION_PROFILES[1],
    [
      selectedArchetype.id,
      selectedStudioState.autoGraduateArchetypeThresholds,
      selectedStudioState.autoGraduateMinConfidence,
      workspaceAutoGraduationProfile?.archetype,
    ]
  );

  const autoGraduateMinConfidence = useMemo(() => {
    if (selectedStudioState.autoGraduateScenarioThresholds?.[selectedScenario.id]) {
      return selectedStudioState.autoGraduateScenarioThresholds[selectedScenario.id];
    }
    if (selectedStudioState.autoGraduateArchetypeThresholds?.[selectedArchetype.id]) {
      return selectedStudioState.autoGraduateArchetypeThresholds[selectedArchetype.id];
    }
    if (workspaceAutoGraduationProfile) {
      return workspaceAutoGraduationProfile.archetype;
    }
    return getEffectiveAutoGraduateThreshold(selectedStudioState, selectedScenario.id, selectedArchetype.id);
  }, [
    selectedArchetype.id,
    selectedScenario.id,
    selectedStudioState,
    workspaceAutoGraduationProfile,
  ]);

  const autoRollbackEnabled = selectedStudioState.autoRollbackEnabled ?? workspaceAutoRollbackDefaults.enabled;
  const autoRollbackWeaknessThreshold = selectedStudioState.autoRollbackWeaknessThreshold ?? workspaceAutoRollbackDefaults.weaknessThreshold;
  const autoRollbackMomentumThreshold = workspaceAutoRollbackMomentumThreshold;

  const autoGraduateScope = useMemo(() => {
    if (selectedStudioState.autoGraduateScenarioThresholds?.[selectedScenario.id]) {
      return { scope: 'Scenario gate', label: selectedScenario.label };
    }
    if (selectedStudioState.autoGraduateArchetypeThresholds?.[selectedArchetype.id]) {
      return { scope: 'Workflow-class gate', label: selectedArchetype.label };
    }
    if (workspaceAutoGraduationProfile) {
      return { scope: 'Workspace archetype default', label: workspaceAutoGraduationProfile.label };
    }
    return { scope: 'Global default', label: 'All workflows' };
  }, [
    selectedArchetype.id,
    selectedArchetype.label,
    selectedScenario.id,
    selectedScenario.label,
    selectedStudioState.autoGraduateArchetypeThresholds,
    selectedStudioState.autoGraduateScenarioThresholds,
    workspaceAutoGraduationProfile,
  ]);

  const graduationHistory = useMemo(
    () => (selectedStudioState.promotionHistory || []).filter((entry) => entry.mode === 'graduation'),
    [selectedStudioState.promotionHistory]
  );

  const rollbackHistory = useMemo(
    () => (selectedStudioState.promotionHistory || []).filter((entry) => entry.mode === 'rollback'),
    [selectedStudioState.promotionHistory]
  );

  const recommendedAutoGraduationProfile = useMemo(
    () => getAutoGraduationProfileById(
      getRecommendedAutoGraduationProfileId(selectedArchetype.id, selectedScenario.id, selectedPolicy.reviewPolicy)
    ) || AUTO_GRADUATION_PROFILES[1],
    [selectedArchetype.id, selectedPolicy.reviewPolicy, selectedScenario.id]
  );

  const graduationTimeline = useMemo(() => {
    return graduationHistory
      .map((entry) => {
        const childSummary = entry.planId ? savedPlanSummaries.find((item) => item.plan.id === entry.planId) : undefined;
        const parentSummary = entry.parentPlanId ? savedPlanSummaries.find((item) => item.plan.id === entry.parentPlanId) : undefined;
        const childLabel = childSummary?.plan.name || entry.sourceExperimentLabel || 'Graduated branch';
        const parentLabel = parentSummary?.plan.name || 'Previous parent';
        const successDelta = typeof entry.successDelta === 'number'
          ? entry.successDelta
          : childSummary && parentSummary
            ? Math.round((childSummary.stats.successRate - parentSummary.stats.successRate) * 100)
            : undefined;
        const creditsDelta = typeof entry.creditsDelta === 'number'
          ? entry.creditsDelta
          : childSummary && parentSummary
            ? Math.round((childSummary.stats.averageCredits || 0) - (parentSummary.stats.averageCredits || 0))
            : undefined;
        const durationDelta = typeof entry.durationDelta === 'number'
          ? entry.durationDelta
          : childSummary && parentSummary
            ? Math.round(((childSummary.stats.averageDurationMs || 0) - (parentSummary.stats.averageDurationMs || 0)) / 1000)
            : undefined;
        const childRun = childSummary
          ? (selectedRow?.runs || [])
              .filter((run) => run.status === 'succeeded' || run.status === 'failed')
              .find((run) => rankRunPlanMatches(run, [childSummary.plan])[0]?.plan.id === childSummary.plan.id)
          : undefined;
        const parentRun = parentSummary
          ? (selectedRow?.runs || [])
              .filter((run) => run.status === 'succeeded' || run.status === 'failed')
              .find((run) => rankRunPlanMatches(run, [parentSummary.plan])[0]?.plan.id === parentSummary.plan.id)
          : undefined;
        const dominantPhase = entry.phase
          || (readStepExecutions(childRun?.metadata?.stepExecutions)
            .filter((step) => step.kind !== 'note')
            .sort((left, right) => (right.actualCredits || 0) - (left.actualCredits || 0))[0]?.kind as WorkflowBlockKind | undefined);
        const reasons = [
          typeof successDelta === 'number'
            ? `${formatSignedDelta(successDelta)} pts success against parent`
            : null,
          typeof creditsDelta === 'number'
            ? `${formatSignedDelta(creditsDelta)} cr spend delta`
            : null,
          typeof durationDelta === 'number'
            ? `${formatSignedDelta(durationDelta)}s duration delta`
            : null,
          typeof entry.confidence === 'number'
            ? `${entry.confidence}% graduation confidence`
            : null,
          dominantPhase
            ? `${formatDirectivePhaseScope([dominantPhase])} carried the strongest signal`
            : null,
        ].filter((item): item is string => Boolean(item)).slice(0, 3);
        return {
          entry,
          childLabel,
          parentLabel,
          successDelta,
          creditsDelta,
          durationDelta,
          currentSuccessDelta: childSummary && parentSummary
            ? Math.round((childSummary.stats.successRate - parentSummary.stats.successRate) * 100)
            : undefined,
          currentCreditsDelta: childSummary && parentSummary
            ? Math.round((childSummary.stats.averageCredits || 0) - (parentSummary.stats.averageCredits || 0))
            : undefined,
          currentDurationDelta: childSummary && parentSummary
            ? Math.round(((childSummary.stats.averageDurationMs || 0) - (parentSummary.stats.averageDurationMs || 0)) / 1000)
            : undefined,
          childRun,
          parentRun,
          dominantPhase,
          reasons,
        };
      })
      .slice(0, 6);
  }, [graduationHistory, savedPlanSummaries, selectedRow?.runs]);

  const rollbackTimeline = useMemo(() => {
    return rollbackHistory
      .map((entry) => {
        const restoredSummary = entry.planId ? savedPlanSummaries.find((item) => item.plan.id === entry.planId) : undefined;
        const rolledBackSummary = entry.parentPlanId ? savedPlanSummaries.find((item) => item.plan.id === entry.parentPlanId) : undefined;
        const workflowRuns = (selectedRow?.runs || []).filter((run) => run.status === 'succeeded' || run.status === 'failed');
        const restoredRuns = restoredSummary
          ? workflowRuns
              .filter((run) => rankRunPlanMatches(run, [restoredSummary.plan])[0]?.plan.id === restoredSummary.plan.id)
              .sort((left, right) => Date.parse(right.finishedAt || right.startedAt) - Date.parse(left.finishedAt || left.startedAt))
              .slice(0, 6)
          : [];
        const rolledBackRuns = rolledBackSummary
          ? workflowRuns
              .filter((run) => rankRunPlanMatches(run, [rolledBackSummary.plan])[0]?.plan.id === rolledBackSummary.plan.id)
              .sort((left, right) => Date.parse(right.finishedAt || right.startedAt) - Date.parse(left.finishedAt || left.startedAt))
              .slice(0, 6)
          : [];
        const restoredRun = restoredSummary
          ? restoredRuns[0]
          : undefined;
        const rolledBackRun = rolledBackSummary
          ? rolledBackRuns[0]
          : undefined;
        return {
          entry,
          restoredLabel: restoredSummary?.plan.name || 'Restored parent',
          rolledBackLabel: rolledBackSummary?.plan.name || 'Rolled-back child',
          restoredRun,
          rolledBackRun,
          currentSuccessDelta: restoredSummary && rolledBackSummary
            ? Math.round((restoredSummary.stats.successRate - rolledBackSummary.stats.successRate) * 100)
            : undefined,
          currentCreditsDelta: restoredSummary && rolledBackSummary
            ? Math.round((restoredSummary.stats.averageCredits || 0) - (rolledBackSummary.stats.averageCredits || 0))
            : undefined,
          currentDurationDelta: restoredSummary && rolledBackSummary
            ? Math.round(((restoredSummary.stats.averageDurationMs || 0) - (rolledBackSummary.stats.averageDurationMs || 0)) / 1000)
            : undefined,
          recoverySeries: Array.from({
            length: Math.max(
              restoredRuns.length,
              rolledBackRuns.length,
            ),
          }, (_, index) => ({
            index,
            restored: restoredRuns[index],
            rolledBack: rolledBackRuns[index],
          })),
        };
      })
      .slice(0, 6);
  }, [rollbackHistory, savedPlanSummaries, selectedRow?.runs]);

  const autoGraduationRollbackSuggestion = useMemo(() => {
    if (!activeBranchParentComparison || selectedStudioState.lastAutoGraduatedPlanId !== activeBranchParentComparison.child.plan.id) return null;
    if (activeBranchParentComparison.outcome !== 'Weak') return null;
    const latestAutoGraduation = graduationHistory.find((entry) => entry.planId === activeBranchParentComparison.child.plan.id && entry.autoApplied);
    const parentWindowRuns = (selectedRow?.runs || [])
      .filter((run) => run.status === 'succeeded' || run.status === 'failed')
      .filter((run) => rankRunPlanMatches(run, [activeBranchParentComparison.parent.plan])[0]?.plan.id === activeBranchParentComparison.parent.plan.id)
      .slice(0, 12);
    const childWindowRuns = (selectedRow?.runs || [])
      .filter((run) => run.status === 'succeeded' || run.status === 'failed')
      .filter((run) => rankRunPlanMatches(run, [activeBranchParentComparison.child.plan])[0]?.plan.id === activeBranchParentComparison.child.plan.id)
      .slice(0, 12);
    const parentWindowStats = summarizeRunCollection(parentWindowRuns);
    const childWindowStats = summarizeRunCollection(childWindowRuns);
    const parentRecentStats = summarizeRunCollection(parentWindowRuns.slice(0, 4));
    const childRecentStats = summarizeRunCollection(childWindowRuns.slice(0, 4));
    const freshNegativeMomentum =
      childRecentStats.count >= 2 &&
      parentRecentStats.count >= 2 &&
      (parentRecentStats.successRate - childRecentStats.successRate) * 100 >= autoRollbackMomentumThreshold &&
      (
        (childRecentStats.averageCredits || 0) > (parentRecentStats.averageCredits || 0)
        || (childRecentStats.averageDurationMs || 0) > (parentRecentStats.averageDurationMs || 0)
      );
    const weaknessScore =
      Math.max(0, (parentWindowStats.successRate - childWindowStats.successRate) * 100)
      + Math.max(0, (childWindowStats.averageCredits || 0) - (parentWindowStats.averageCredits || 0))
      + Math.max(0, ((childWindowStats.averageDurationMs || 0) - (parentWindowStats.averageDurationMs || 0)) / 5000);
    return {
      child: activeBranchParentComparison.child,
      parent: activeBranchParentComparison.parent,
      childRunCount: activeBranchParentComparison.childRunCount,
      latestAutoGraduation,
      successDelta: activeBranchParentComparison.successDelta,
      creditsDelta: activeBranchParentComparison.creditsDelta,
      durationDelta: activeBranchParentComparison.durationDelta,
      parentWindowStats,
      childWindowStats,
      parentRecentStats,
      childRecentStats,
      freshNegativeMomentum,
      weaknessScore: Math.round(weaknessScore),
    };
  }, [activeBranchParentComparison, autoRollbackMomentumThreshold, graduationHistory, selectedRow?.runs, selectedStudioState.lastAutoGraduatedPlanId]);

  const planActionQueue = useMemo(() => {
    const queue: Array<{ id: string; title: string; body: string; action: 'restore_recommended' | 'rollback' | 'compare' | 'save_phase_plan' }> = [];
    if (recommendedPlan && activeSavedPlan && recommendedPlan.plan.id !== activeSavedPlan.plan.id) {
      queue.push({
        id: 'recommended-plan',
        title: `Promote ${recommendedPlan.plan.name}`,
        body: 'This is the strongest saved operating plan right now based on live evidence and confidence.',
        action: 'restore_recommended',
      });
    }
    if (planRollbackSuggestion) {
      queue.push({
        id: 'rollback-plan',
        title: `Rollback ${planRollbackSuggestion.active.plan.name}`,
        body: `Follow-through is weak. ${planRollbackSuggestion.restoreTarget.plan.name} is the best restore target right now.`,
        action: 'rollback',
      });
    }
    if (planComparison) {
      queue.push({
        id: 'compare-plans',
        title: `Compare ${planComparison.primary.plan.name} vs ${planComparison.compared.plan.name}`,
        body: 'Use the plan comparison lab to decide which operating posture should become the default.',
        action: 'compare',
      });
    }
    if (selectedReplayPhaseDelta && Math.abs(selectedReplayPhaseDelta.creditsDelta) >= 8) {
      queue.push({
        id: 'save-phase-plan',
        title: `Capture ${formatDirectivePhaseScope([selectedReplayPhaseDetail?.phase || 'analyze'])} as a plan`,
        body: 'This phase is deviating enough from baseline that it is worth saving as a named operating strategy.',
        action: 'save_phase_plan',
      });
    }
    return queue.slice(0, 4);
  }, [activeSavedPlan, planComparison, planRollbackSuggestion, recommendedPlan, selectedReplayPhaseDelta, selectedReplayPhaseDetail?.phase]);

  useEffect(() => {
    if (!selectedRow?.automation.id) return;
    if (selectedStudioState.selectedPlanId || selectedPlanId || !archetypeRecommendedPlan) return;
    if (archetypeRecommendedPlanMode === 'auto') {
      setSelectedPlanId(archetypeRecommendedPlan.plan.id);
      setSelectedPlanFamilyRootId(archetypeRecommendedPlan.familyRootId);
      if (archetypeRecommendedPlan.plan.intentLabel) {
        setSelectedPlanIntentFilter(archetypeRecommendedPlan.plan.intentLabel);
      }
      setNotice({
        tone: 'success',
        message: `Auto-loaded ${archetypeRecommendedPlan.plan.name} as the best current plan for ${selectedArchetype.label.toLowerCase()}.`,
      });
      return;
    }
    setNotice({
      tone: 'success',
      message: `Suggested ${archetypeRecommendedPlan.plan.name} for this workflow. Evidence is still thin, so Studio is recommending it without switching you automatically.`,
    });
  }, [
    archetypeRecommendedPlan,
    archetypeRecommendedPlanMode,
    selectedArchetype.label,
    selectedPlanId,
    selectedRow?.automation.id,
    selectedStudioState.selectedPlanId,
  ]);

  const patchAutomationConfig = useCallback(async (patch: {
    executionPolicy?: AutomationExecutionPolicyDraft;
    studioState?: AutomationStudioStateDraft;
  }, options?: { successMessage?: string; suppressBusy?: boolean }) => {
    if (!selectedRow) return;
    if (!options?.suppressBusy) {
      setActionBusy(true);
    }
    try {
      const response = await fetch(`/api/automations/${selectedRow.automation.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          executionPolicy: patch.executionPolicy,
          studioState: patch.studioState,
        }),
      });
      if (!response.ok) throw new Error('Could not update execution policy');
      const payload = await response.json().catch(() => null) as { item?: AutomationApiRecord } | null;
      if (payload?.item) {
        const updatedAutomation = payload.item;
        setRows((current) => current.map((row) => {
          if (row.automation.id !== updatedAutomation.id) return row;
          return {
            ...row,
            automation: updatedAutomation,
            workflowSteps: deriveWorkflowStepsFromAutomation(updatedAutomation),
          };
        }));
      } else {
        await loadData(true);
      }
      if (options?.successMessage) {
        setNotice({ tone: 'success', message: options.successMessage });
      }
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not update agent policy.' });
    } finally {
      if (!options?.suppressBusy) {
        setActionBusy(false);
      }
    }
  }, [loadData, selectedRow]);

  const patchExecutionPolicy = useCallback(async (next: AutomationExecutionPolicyDraft) => {
    await patchAutomationConfig({ executionPolicy: next }, { successMessage: 'Updated agent policy.' });
  }, [patchAutomationConfig]);

  const updateStudioState = useCallback(async (next: AutomationStudioStateDraft, successMessage?: string) => {
    await patchAutomationConfig({ studioState: next }, { successMessage, suppressBusy: !successMessage });
  }, [patchAutomationConfig]);

  useEffect(() => {
    if (!autoGraduateEnabled || !activeBranchParentComparison?.graduationReady) return;
    if (activeBranchParentComparison.childScoring.confidence < autoGraduateMinConfidence) return;
    if (selectedStudioState.lastAutoGraduatedPlanId === activeBranchParentComparison.child.plan.id) return;
    void patchAutomationConfig({
      executionPolicy: activeBranchParentComparison.child.plan.executionPolicy,
      studioState: {
        ...selectedStudioState,
        selectedPlanId: activeBranchParentComparison.child.plan.id,
        selectedPlanCompareId: activeBranchParentComparison.parent.plan.id,
        selectedPlanFamilyRootId: activeSavedPlan?.familyRootId,
        roleDirectives: cloneRoleDirectives(activeBranchParentComparison.child.plan.roleDirectives),
        lastAutoGraduatedPlanId: activeBranchParentComparison.child.plan.id,
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'graduation',
          summary: `Auto-graduated ${activeBranchParentComparison.child.plan.name} above ${activeBranchParentComparison.parent.plan.name}.`,
          sourceExperimentId: activeBranchParentComparison.child.plan.sourceExperimentId,
          sourceExperimentLabel: activeBranchParentComparison.child.plan.sourceExperimentLabel || activeBranchParentComparison.child.plan.name,
          planId: activeBranchParentComparison.child.plan.id,
          parentPlanId: activeBranchParentComparison.parent.plan.id,
          autoApplied: true,
          confidence: activeBranchParentComparison.childScoring.confidence,
          successDelta: activeBranchParentComparison.successDelta,
          creditsDelta: activeBranchParentComparison.creditsDelta,
          durationDelta: activeBranchParentComparison.durationDelta,
        }),
      },
    }, { successMessage: `Auto-graduated ${activeBranchParentComparison.child.plan.name}.`, suppressBusy: true });
  }, [
    activeBranchParentComparison,
    activeSavedPlan?.familyRootId,
    autoGraduateEnabled,
    autoGraduateMinConfidence,
    patchAutomationConfig,
    selectedStudioState,
  ]);

  useEffect(() => {
    if (!autoRollbackEnabled || !autoGraduationRollbackSuggestion) return;
    if (autoGraduationRollbackSuggestion.weaknessScore < autoRollbackWeaknessThreshold) return;
    if (!autoGraduationRollbackSuggestion.freshNegativeMomentum) return;
    if (selectedStudioState.lastAutoRolledBackPlanId === autoGraduationRollbackSuggestion.child.plan.id) return;
    void patchAutomationConfig({
      executionPolicy: autoGraduationRollbackSuggestion.parent.plan.executionPolicy,
      studioState: {
        ...selectedStudioState,
        selectedPlanId: autoGraduationRollbackSuggestion.parent.plan.id,
        selectedPlanCompareId: autoGraduationRollbackSuggestion.child.plan.id,
        selectedPlanFamilyRootId: savedPlanSummaries.find((entry) => entry.plan.id === autoGraduationRollbackSuggestion.parent.plan.id)?.familyRootId,
        roleDirectives: cloneRoleDirectives(autoGraduationRollbackSuggestion.parent.plan.roleDirectives),
        lastAutoRolledBackPlanId: autoGraduationRollbackSuggestion.child.plan.id,
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'rollback',
          summary: `Auto-rolled back ${autoGraduationRollbackSuggestion.child.plan.name} to ${autoGraduationRollbackSuggestion.parent.plan.name}.`,
          sourceExperimentId: autoGraduationRollbackSuggestion.child.plan.sourceExperimentId,
          sourceExperimentLabel: autoGraduationRollbackSuggestion.child.plan.sourceExperimentLabel || autoGraduationRollbackSuggestion.child.plan.name,
          planId: autoGraduationRollbackSuggestion.parent.plan.id,
          parentPlanId: autoGraduationRollbackSuggestion.child.plan.id,
          autoApplied: true,
          confidence: autoGraduationRollbackSuggestion.latestAutoGraduation?.confidence,
          successDelta: autoGraduationRollbackSuggestion.successDelta,
          creditsDelta: autoGraduationRollbackSuggestion.creditsDelta,
          durationDelta: autoGraduationRollbackSuggestion.durationDelta,
        }),
      },
    }, { successMessage: `Auto-rolled back to ${autoGraduationRollbackSuggestion.parent.plan.name}.`, suppressBusy: true });
  }, [
    autoGraduationRollbackSuggestion,
    autoRollbackEnabled,
    autoRollbackWeaknessThreshold,
    patchAutomationConfig,
    savedPlanSummaries,
    selectedStudioState,
  ]);

  const handleSetScopedAutoPromotionThreshold = useCallback((
    scope: 'global' | 'scenario' | 'archetype',
    threshold: number,
  ) => {
    const nextState: AutomationStudioStateDraft = { ...selectedStudioState };
    let message = `Auto-promotion gate set to ${threshold}% confidence.`;

    if (scope === 'scenario') {
      nextState.autoPromotionScenarioThresholds = {
        ...(selectedStudioState.autoPromotionScenarioThresholds || {}),
        [selectedScenario.id]: threshold,
      };
      message = `${selectedScenario.label} gate set to ${threshold}% confidence.`;
    } else if (scope === 'archetype') {
      nextState.autoPromotionArchetypeThresholds = {
        ...(selectedStudioState.autoPromotionArchetypeThresholds || {}),
        [selectedArchetype.id]: threshold,
      };
      message = `${selectedArchetype.label} gate set to ${threshold}% confidence.`;
    } else {
      nextState.autoPromotionMinConfidence = threshold;
      message = `Global auto-promotion gate set to ${threshold}% confidence.`;
    }

    void updateStudioState(nextState, message);
  }, [selectedArchetype.id, selectedArchetype.label, selectedScenario.id, selectedScenario.label, selectedStudioState, updateStudioState]);

  const handleClearScopedAutoPromotionThreshold = useCallback((scope: 'global' | 'scenario' | 'archetype') => {
    const nextState: AutomationStudioStateDraft = { ...selectedStudioState };
    let message = 'Reset auto-promotion gate.';

    if (scope === 'scenario') {
      nextState.autoPromotionScenarioThresholds = omitThresholdKey(selectedStudioState.autoPromotionScenarioThresholds, selectedScenario.id);
      message = `Reset ${selectedScenario.label} back to the inherited gate.`;
    } else if (scope === 'archetype') {
      nextState.autoPromotionArchetypeThresholds = omitThresholdKey(selectedStudioState.autoPromotionArchetypeThresholds, selectedArchetype.id);
      message = `Reset ${selectedArchetype.label} back to the inherited gate.`;
    } else {
      nextState.autoPromotionMinConfidence = undefined;
      message = 'Reset the global auto-promotion gate to the default.';
    }

    void updateStudioState(nextState, message);
  }, [
    selectedArchetype.id,
    selectedArchetype.label,
    selectedScenario.id,
    selectedScenario.label,
    selectedStudioState,
    updateStudioState,
  ]);

  const handleApplyGateProfile = useCallback((profileId: typeof PROMOTION_GATE_PROFILES[number]['id']) => {
    const profile = PROMOTION_GATE_PROFILES.find((item) => item.id === profileId);
    if (!profile) return;
    void updateStudioState({
      ...selectedStudioState,
      autoPromotionMinConfidence: profile.global,
      autoPromotionArchetypeThresholds: {
        ...(selectedStudioState.autoPromotionArchetypeThresholds || {}),
        [selectedArchetype.id]: profile.archetype,
      },
      autoPromotionScenarioThresholds: {
        ...(selectedStudioState.autoPromotionScenarioThresholds || {}),
        [selectedScenario.id]: profile.scenario,
      },
    }, `Applied the ${profile.label.toLowerCase()} gate profile.`);
  }, [selectedArchetype.id, selectedScenario.id, selectedStudioState, updateStudioState]);

  useEffect(() => {
    if (branchFamilyPerformance.length === 0) return;
    if (selectedBranchRootId && branchFamilyPerformance.some((family) => family.rootExperiment.id === selectedBranchRootId)) return;
    setSelectedBranchRootId(branchFamilyPerformance[0].rootExperiment.id);
  }, [branchFamilyPerformance, selectedBranchRootId]);

  useEffect(() => {
    if (branchFamilyPerformance.length < 2) return;
    if (comparedBranchRootId && branchFamilyPerformance.some((family) => family.rootExperiment.id === comparedBranchRootId && family.rootExperiment.id !== selectedBranchRootId)) return;
    const fallback = branchFamilyPerformance.find((family) => family.rootExperiment.id !== selectedBranchRootId);
    if (fallback) setComparedBranchRootId(fallback.rootExperiment.id);
  }, [branchFamilyPerformance, comparedBranchRootId, selectedBranchRootId]);

  const handleRouteCheaper = useCallback(() => {
    const nextLaneCap =
      selectedWorkerDetail.worker?.laneType === 'elastic'
        ? Math.max(1, Math.min(selectedPolicy.maxElasticLanes, selectedMath.recommendedElasticLanes))
        : selectedPolicy.maxElasticLanes;
    const nextPolicy: AutomationExecutionPolicyDraft = {
      ...selectedPolicy,
      mode: 'custom',
      optimizationGoal: 'cost_saver',
      reviewPolicy: selectedPolicy.reviewPolicy === 'strict' ? 'standard' : selectedPolicy.reviewPolicy,
      maxElasticLanes: nextLaneCap,
    };
    const role = selectedWorkerDetail.worker?.role;
    const directivePhases = selectedDirectivePhase === 'all' ? undefined : [selectedDirectivePhase];
    void patchAutomationConfig({
      executionPolicy: nextPolicy,
      studioState: {
        ...selectedStudioState,
        roleDirectives: role
          ? {
              ...(selectedStudioState.roleDirectives || {}),
              [role]: { mode: 'cheaper', phases: directivePhases, updatedAt: new Date().toISOString() },
            }
          : selectedStudioState.roleDirectives,
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'learning',
          summary: `Shifted ${role || 'this role'} cheaper for ${formatDirectivePhaseScope(directivePhases)}.`,
          phase: directivePhases?.[0],
        }),
      },
    }, { successMessage: `Shifted this role toward cheaper routing for ${formatDirectivePhaseScope(directivePhases)}.` });
  }, [patchAutomationConfig, selectedDirectivePhase, selectedMath.recommendedElasticLanes, selectedPolicy, selectedStudioState, selectedWorkerDetail.worker?.laneType, selectedWorkerDetail.worker?.role]);

  const handleIncreaseReview = useCallback(() => {
    const nextPolicy: AutomationExecutionPolicyDraft = {
      ...selectedPolicy,
      mode: 'custom',
      reviewPolicy: 'strict',
      optimizationGoal: selectedPolicy.optimizationGoal === 'cost_saver' ? 'balanced' : selectedPolicy.optimizationGoal,
    };
    const role = selectedWorkerDetail.worker?.role;
    const directivePhases = selectedDirectivePhase === 'all' ? undefined : [selectedDirectivePhase];
    void patchAutomationConfig({
      executionPolicy: nextPolicy,
      studioState: {
        ...selectedStudioState,
        roleDirectives: role
          ? {
              ...(selectedStudioState.roleDirectives || {}),
              [role]: { mode: 'review', phases: directivePhases, updatedAt: new Date().toISOString() },
            }
          : selectedStudioState.roleDirectives,
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'learning',
          summary: `Raised review on ${role || 'this role'} for ${formatDirectivePhaseScope(directivePhases)}.`,
          phase: directivePhases?.[0],
        }),
      },
    }, { successMessage: `Raised review pressure for ${formatDirectivePhaseScope(directivePhases)}.` });
  }, [patchAutomationConfig, selectedDirectivePhase, selectedPolicy, selectedStudioState, selectedWorkerDetail.worker?.role]);

  const handlePromoteLane = useCallback(() => {
    const nextPolicy: AutomationExecutionPolicyDraft = {
      ...selectedPolicy,
      mode: 'custom',
      optimizationGoal: 'quality_first',
      maxElasticLanes: Math.min(4, Math.max(selectedPolicy.maxElasticLanes, selectedMath.recommendedElasticLanes) + 1),
    };
    const role = selectedWorkerDetail.worker?.role;
    const directivePhases = selectedDirectivePhase === 'all' ? undefined : [selectedDirectivePhase];
    void patchAutomationConfig({
      executionPolicy: nextPolicy,
      studioState: {
        ...selectedStudioState,
        roleDirectives: role
          ? {
              ...(selectedStudioState.roleDirectives || {}),
              [role]: { mode: 'promote', phases: directivePhases, updatedAt: new Date().toISOString() },
            }
          : selectedStudioState.roleDirectives,
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'learning',
          summary: `Promoted ${role || 'this role'} for ${formatDirectivePhaseScope(directivePhases)}.`,
          phase: directivePhases?.[0],
        }),
      },
    }, { successMessage: `Promoted this lane for ${formatDirectivePhaseScope(directivePhases)}.` });
  }, [patchAutomationConfig, selectedDirectivePhase, selectedMath.recommendedElasticLanes, selectedPolicy, selectedStudioState, selectedWorkerDetail.worker?.role]);

  const handleClearRoleDirective = useCallback(() => {
    const role = selectedWorkerDetail.worker?.role;
    if (!role || !selectedStudioState.roleDirectives?.[role]) return;
    const nextDirectives = { ...(selectedStudioState.roleDirectives || {}) };
    delete nextDirectives[role];
    void updateStudioState({
      ...selectedStudioState,
      roleDirectives: Object.keys(nextDirectives).length > 0 ? nextDirectives : undefined,
      promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
        mode: 'learning',
        summary: `Cleared steering on ${role}.`,
        phase: selectedDirectivePhase === 'all' ? undefined : selectedDirectivePhase,
      }),
    }, `Cleared steering on ${role}.`);
  }, [selectedDirectivePhase, selectedStudioState, selectedWorkerDetail.worker?.role, updateStudioState]);

  const applyRecommendationAction = useCallback((action: 'lean_ops' | 'raise_review' | 'match_lanes' | 'trim_lanes' | 'none') => {
    if (action === 'none') return;
    if (action === 'lean_ops') {
      void patchExecutionPolicy({ ...selectedPolicy, mode: 'custom', optimizationGoal: 'cost_saver', reviewPolicy: selectedPolicy.reviewPolicy === 'strict' ? 'standard' : selectedPolicy.reviewPolicy, maxElasticLanes: Math.min(selectedPolicy.maxElasticLanes, Math.max(1, selectedMath.recommendedElasticLanes)) });
      return;
    }
    if (action === 'raise_review') {
      void patchExecutionPolicy({ ...selectedPolicy, mode: 'custom', optimizationGoal: selectedPolicy.optimizationGoal === 'cost_saver' ? 'balanced' : selectedPolicy.optimizationGoal, reviewPolicy: 'strict' });
      return;
    }
    if (action === 'match_lanes') {
      void patchExecutionPolicy({ ...selectedPolicy, mode: 'custom', maxElasticLanes: selectedMath.recommendedElasticLanes });
      return;
    }
    if (action === 'trim_lanes') {
      void patchExecutionPolicy({ ...selectedPolicy, mode: 'custom', maxElasticLanes: Math.max(0, selectedMath.recommendedElasticLanes) });
    }
  }, [patchExecutionPolicy, selectedMath.recommendedElasticLanes, selectedPolicy]);

  const handlePromoteExperimentPresetAndPhase = useCallback((experiment: StudioExperimentRecord, phase: WorkflowBlockKind) => {
    const preset = POLICY_PRESETS.find((item) => item.id === experiment.previewPresetId);
    const phaseDirectives = extractPhaseDirectiveSnapshot(experiment.roleDirectives, phase);
    if (!preset) {
      setNotice({ tone: 'error', message: 'This experiment no longer matches an available preset.' });
      return;
    }
    if (!phaseDirectives) {
      setNotice({ tone: 'error', message: `No saved steering for ${formatDirectivePhaseScope([phase])} in this experiment.` });
      return;
    }
    setSelectedComparisonExperimentId(experiment.id);
    void patchAutomationConfig({
      executionPolicy: preset.policy,
      studioState: {
        ...selectedStudioState,
        selectedScenarioId: experiment.scenarioId,
        previewPresetId: experiment.previewPresetId,
        roleDirectives: mergeRoleDirectiveSnapshots(selectedStudioState.roleDirectives, phaseDirectives),
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'preset_phase',
          summary: `Promoted ${formatDirectivePhaseScope([phase])} plus preset from ${getExperimentDisplayLabel(experiment)}.`,
          sourceExperimentId: experiment.id,
          sourceExperimentLabel: getExperimentDisplayLabel(experiment),
          phase,
        }),
      },
    }, { successMessage: `Promoted ${formatDirectivePhaseScope([phase])} plus the experiment preset.` });
  }, [patchAutomationConfig, selectedStudioState]);

  const handlePromoteExperimentPhase = useCallback((experiment: StudioExperimentRecord, phase: WorkflowBlockKind) => {
    const phaseDirectives = extractPhaseDirectiveSnapshot(experiment.roleDirectives, phase);
    if (!phaseDirectives) {
      setNotice({ tone: 'error', message: `No saved steering for ${formatDirectivePhaseScope([phase])} in this experiment.` });
      return;
    }
    setSelectedComparisonExperimentId(experiment.id);
    void updateStudioState({
      ...selectedStudioState,
      selectedScenarioId: experiment.scenarioId,
      previewPresetId: experiment.previewPresetId,
      roleDirectives: mergeRoleDirectiveSnapshots(selectedStudioState.roleDirectives, phaseDirectives),
      promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
        mode: 'phase',
        summary: `Promoted ${formatDirectivePhaseScope([phase])} steering from ${getExperimentDisplayLabel(experiment)}.`,
        sourceExperimentId: experiment.id,
        sourceExperimentLabel: getExperimentDisplayLabel(experiment),
        phase,
      }),
    }, `Promoted ${formatDirectivePhaseScope([phase])} steering from this experiment.`);
  }, [selectedStudioState, updateStudioState]);

  const handleApplyPhaseLearning = useCallback((phase: WorkflowBlockKind, mode: 'cheaper' | 'review' | 'promote') => {
    const role = getPreferredRoleForPhase(phase);
    setSelectedDirectivePhase(phase);
    setSelectedWorkerRole(role);
    setActiveRoom('live');

    const nextPolicy: AutomationExecutionPolicyDraft = {
      ...selectedPolicy,
      mode: 'custom',
      optimizationGoal:
        mode === 'cheaper'
          ? 'cost_saver'
          : mode === 'review'
            ? (selectedPolicy.optimizationGoal === 'cost_saver' ? 'balanced' : selectedPolicy.optimizationGoal)
            : 'quality_first',
      reviewPolicy:
        mode === 'review'
          ? 'strict'
          : mode === 'cheaper' && selectedPolicy.reviewPolicy === 'strict'
            ? 'standard'
            : selectedPolicy.reviewPolicy,
      maxElasticLanes:
        mode === 'promote'
          ? Math.min(4, Math.max(selectedPolicy.maxElasticLanes, selectedMath.recommendedElasticLanes) + 1)
          : mode === 'cheaper'
            ? Math.max(1, Math.min(selectedPolicy.maxElasticLanes, selectedMath.recommendedElasticLanes))
            : selectedPolicy.maxElasticLanes,
    };

    void patchAutomationConfig({
      executionPolicy: nextPolicy,
      studioState: {
        ...selectedStudioState,
        roleDirectives: {
          ...(selectedStudioState.roleDirectives || {}),
          [role]: { mode, phases: [phase], updatedAt: new Date().toISOString() },
        },
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'learning',
          summary: `Applied ${getDirectiveModeLabel(mode).toLowerCase()} to ${formatDirectivePhaseScope([phase])} on ${role}.`,
          phase,
        }),
      },
    }, {
      successMessage: `Applied ${getDirectiveModeLabel(mode).toLowerCase()} to ${formatDirectivePhaseScope([phase])} on ${role}.`,
    });
  }, [patchAutomationConfig, selectedMath.recommendedElasticLanes, selectedPolicy, selectedStudioState]);

  const handleExecuteNextExperiment = useCallback((item: NonNullable<typeof nextExperimentQueue[number]>) => {
    if (item.action === 'simulate_phase' && item.phase && item.mode) {
      setPhaseSimulation({ phase: item.phase, mode: item.mode });
      setActiveRoom('optimize');
      return;
    }
    if (item.action === 'focus_phase' && item.phase) {
      setSelectedDirectivePhase(item.phase);
      setSelectedWorkerRole(getPreferredRoleForPhase(item.phase));
      setActiveRoom('live');
      return;
    }
    if (item.action === 'apply_policy' && item.policyAction) {
      applyRecommendationAction(item.policyAction);
    }
  }, [applyRecommendationAction]);

  const handleSaveExperiment = useCallback(async () => {
    const nextHistory = [
      {
        id: `exp_${Date.now()}`,
        scenarioId: selectedScenarioId,
        previewPresetId,
        createdAt: new Date().toISOString(),
        notes: `${selectedScenario.label} · ${previewPreset.label}${countDirectiveEntries(selectedStudioState.roleDirectives) ? ` · ${countDirectiveEntries(selectedStudioState.roleDirectives)} steering signals` : ''}`,
        roleDirectives: cloneRoleDirectives(selectedStudioState.roleDirectives),
      },
      ...(selectedStudioState.experimentHistory || []),
    ].slice(0, 8);

    setExperimentSaveBusy(true);
    try {
      await updateStudioState({
        ...selectedStudioState,
        selectedScenarioId,
        previewPresetId,
        experimentHistory: nextHistory,
      }, 'Saved experiment snapshot.');
    } finally {
      setExperimentSaveBusy(false);
    }
  }, [previewPreset.label, previewPresetId, selectedScenario.label, selectedScenarioId, selectedStudioState, updateStudioState]);

  const handleSaveOperatingPlan = useCallback((source?: { experiment?: StudioExperimentRecord; namePrefix?: string; intentLabel?: string; parentPlan?: StudioOperatingPlan }) => {
    const experiment = source?.experiment;
    const parentPlan = source?.parentPlan;
    const policyForPlan = experiment
      ? normalizeExecutionPolicy(POLICY_PRESETS.find((preset) => preset.id === experiment.previewPresetId)?.policy || selectedPolicy)
      : { ...selectedPolicy };
    const scenarioForPlan = experiment?.scenarioId || selectedScenarioId;
    const previewPresetForPlan = experiment?.previewPresetId || previewPresetId;
    const intentLabel = source?.intentLabel || parentPlan?.intentLabel || inferOperatingPlanIntent(policyForPlan, scenarioForPlan, selectedRow?.workflowSteps || []);
    const planName = `${source?.namePrefix || 'Operating plan'} · ${experiment ? getExperimentDisplayLabel(experiment) : `${selectedScenario.label} · ${previewPreset.label}`}`;
    const nextPlans = [
      {
        id: `plan_${Date.now()}`,
        name: planName,
        createdAt: new Date().toISOString(),
        scenarioId: scenarioForPlan,
        previewPresetId: previewPresetForPlan,
        executionPolicy: policyForPlan,
        roleDirectives: cloneRoleDirectives(experiment?.roleDirectives || selectedStudioState.roleDirectives),
        intentLabel,
        parentPlanId: parentPlan?.id,
        sourceExperimentId: experiment?.id,
        sourceExperimentLabel: experiment ? getExperimentDisplayLabel(experiment) : undefined,
        notes: experiment ? `Saved from ${getExperimentDisplayLabel(experiment)}.` : `Saved from live setup with ${countDirectiveEntries(selectedStudioState.roleDirectives)} steering signals.`,
      },
      ...(selectedStudioState.savedPlans || []),
    ].slice(0, 10);

    void updateStudioState({
      ...selectedStudioState,
      selectedPlanId: nextPlans[0].id,
      selectedPlanFamilyRootId: parentPlan?.parentPlanId || parentPlan?.id || nextPlans[0].id,
      savedPlans: nextPlans,
    }, 'Saved operating plan.');
    setSelectedPlanFamilyRootId(parentPlan?.parentPlanId || parentPlan?.id || nextPlans[0].id);
  }, [previewPreset.label, previewPresetId, selectedPolicy, selectedRow?.workflowSteps, selectedScenario.label, selectedScenarioId, selectedStudioState, updateStudioState]);

  const handleForkOperatingPlan = useCallback((plan: StudioOperatingPlan) => {
    void handleSaveOperatingPlan({
      namePrefix: 'Plan branch',
      intentLabel: plan.intentLabel,
      parentPlan: plan,
      experiment: plan.sourceExperimentId
        ? experimentHistory.find((experiment) => experiment.id === plan.sourceExperimentId)
        : undefined,
    });
  }, [experimentHistory, handleSaveOperatingPlan]);

  const handleBranchPhasePlan = useCallback((phase: WorkflowBlockKind, mode: 'cheaper' | 'review' | 'promote') => {
    const role = getPreferredRoleForPhase(phase);
    const basePlan = activeSavedPlan?.plan;
    const branchedDirectives = mergeRoleDirectiveSnapshots(basePlan?.roleDirectives || selectedStudioState.roleDirectives, {
      [role]: {
        mode,
        phases: [phase],
        updatedAt: new Date().toISOString(),
      },
    });
    const nextPolicy: AutomationExecutionPolicyDraft = {
      ...selectedPolicy,
      mode: 'custom',
      optimizationGoal:
        mode === 'cheaper'
          ? 'cost_saver'
          : mode === 'review'
            ? (selectedPolicy.optimizationGoal === 'cost_saver' ? 'balanced' : selectedPolicy.optimizationGoal)
            : 'quality_first',
      reviewPolicy:
        mode === 'review'
          ? 'strict'
          : mode === 'cheaper' && selectedPolicy.reviewPolicy === 'strict'
            ? 'standard'
            : selectedPolicy.reviewPolicy,
      maxElasticLanes:
        mode === 'promote'
          ? Math.min(4, Math.max(selectedPolicy.maxElasticLanes, selectedMath.recommendedElasticLanes) + 1)
          : selectedPolicy.maxElasticLanes,
    };

    const nextPlans = [
      {
        id: `plan_${Date.now()}`,
        name: `Phase branch · ${formatDirectivePhaseScope([phase])}`,
        createdAt: new Date().toISOString(),
        scenarioId: selectedScenarioId,
        previewPresetId,
        executionPolicy: nextPolicy,
        roleDirectives: branchedDirectives,
        intentLabel: basePlan?.intentLabel || inferOperatingPlanIntent(nextPolicy, selectedScenarioId, selectedRow?.workflowSteps || []),
        parentPlanId: basePlan?.id,
        sourceExperimentId: basePlan?.sourceExperimentId,
        sourceExperimentLabel: basePlan?.sourceExperimentLabel || basePlan?.name,
        notes: `Branched from ${basePlan?.name || 'live setup'} for ${formatDirectivePhaseScope([phase])}.`,
      },
      ...(selectedStudioState.savedPlans || []),
    ].slice(0, 10);

    void updateStudioState({
      ...selectedStudioState,
      selectedPlanId: nextPlans[0].id,
      selectedPlanCompareId: basePlan?.id,
      selectedPlanFamilyRootId: basePlan?.parentPlanId || basePlan?.id || nextPlans[0].id,
      savedPlans: nextPlans,
    }, `Branched ${formatDirectivePhaseScope([phase])} into a new operating plan.`);
    setSelectedPlanCompareId(basePlan?.id || '');
    setSelectedPlanFamilyRootId(basePlan?.parentPlanId || basePlan?.id || nextPlans[0].id);
  }, [activeSavedPlan?.plan, previewPresetId, selectedMath.recommendedElasticLanes, selectedPolicy, selectedRow?.workflowSteps, selectedScenarioId, selectedStudioState, updateStudioState]);

  const handleRestoreOperatingPlan = useCallback((plan: StudioOperatingPlan) => {
    setSelectedPlanId(plan.id);
    const familyRootId = savedPlanSummaries.find((entry) => entry.plan.id === plan.id)?.familyRootId;
    if (familyRootId) setSelectedPlanFamilyRootId(familyRootId);
    setSelectedScenarioId(plan.scenarioId as ScenarioPresetId);
    setPreviewPresetId(plan.previewPresetId);
    void patchAutomationConfig({
      executionPolicy: plan.executionPolicy,
      studioState: {
        ...selectedStudioState,
        selectedPlanId: plan.id,
        selectedScenarioId: plan.scenarioId,
        previewPresetId: plan.previewPresetId,
        roleDirectives: cloneRoleDirectives(plan.roleDirectives),
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'full',
          summary: `Restored saved operating plan ${plan.name}.`,
          sourceExperimentId: plan.sourceExperimentId,
          sourceExperimentLabel: plan.sourceExperimentLabel || plan.name,
        }),
      },
    }, { successMessage: `Restored ${plan.name}.` });
  }, [patchAutomationConfig, savedPlanSummaries, selectedStudioState]);

  const handleRestorePlanPresetOnly = useCallback((plan: StudioOperatingPlan) => {
    setSelectedPlanId(plan.id);
    const familyRootId = savedPlanSummaries.find((entry) => entry.plan.id === plan.id)?.familyRootId;
    if (familyRootId) setSelectedPlanFamilyRootId(familyRootId);
    setSelectedScenarioId(plan.scenarioId as ScenarioPresetId);
    setPreviewPresetId(plan.previewPresetId);
    void patchAutomationConfig({
      executionPolicy: plan.executionPolicy,
      studioState: {
        ...selectedStudioState,
        selectedPlanId: plan.id,
        selectedScenarioId: plan.scenarioId,
        previewPresetId: plan.previewPresetId,
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'preset',
          summary: `Restored preset only from ${plan.name}.`,
          sourceExperimentId: plan.sourceExperimentId,
          sourceExperimentLabel: plan.sourceExperimentLabel || plan.name,
        }),
      },
    }, { successMessage: `Restored preset only from ${plan.name}.` });
  }, [patchAutomationConfig, savedPlanSummaries, selectedStudioState]);

  const handleRestorePlanSteeringOnly = useCallback((plan: StudioOperatingPlan) => {
    setSelectedPlanId(plan.id);
    const familyRootId = savedPlanSummaries.find((entry) => entry.plan.id === plan.id)?.familyRootId;
    if (familyRootId) setSelectedPlanFamilyRootId(familyRootId);
    void updateStudioState({
      ...selectedStudioState,
      selectedPlanId: plan.id,
      roleDirectives: cloneRoleDirectives(plan.roleDirectives),
      promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
        mode: 'steering',
        summary: `Restored steering only from ${plan.name}.`,
        sourceExperimentId: plan.sourceExperimentId,
        sourceExperimentLabel: plan.sourceExperimentLabel || plan.name,
      }),
    }, `Restored steering only from ${plan.name}.`);
  }, [savedPlanSummaries, selectedStudioState, updateStudioState]);

  const handleComparePlan = useCallback((plan: StudioOperatingPlan) => {
    setSelectedPlanCompareId(plan.id);
    const familyRootId = savedPlanSummaries.find((entry) => entry.plan.id === plan.id)?.familyRootId;
    if (familyRootId) setSelectedPlanFamilyRootId(familyRootId);
    if (plan.sourceExperimentId) {
      setSelectedComparisonExperimentId(plan.sourceExperimentId);
    }
    setActiveRoom('optimize');
    setNotice({ tone: 'success', message: `Loaded ${plan.name} for comparison.` });
  }, [savedPlanSummaries]);

  const handlePinSuggestedPlan = useCallback((plan: StudioOperatingPlan) => {
    void updateStudioState({
      ...selectedStudioState,
      pinnedSuggestedPlanId: plan.id,
      dismissedSuggestedPlanId: selectedStudioState.dismissedSuggestedPlanId === plan.id ? undefined : selectedStudioState.dismissedSuggestedPlanId,
    }, `${plan.name} is now pinned as the suggested plan for this workflow.`);
  }, [selectedStudioState, updateStudioState]);

  const handleDismissSuggestedPlan = useCallback((plan: StudioOperatingPlan) => {
    void updateStudioState({
      ...selectedStudioState,
      dismissedSuggestedPlanId: plan.id,
      pinnedSuggestedPlanId: selectedStudioState.pinnedSuggestedPlanId === plan.id ? undefined : selectedStudioState.pinnedSuggestedPlanId,
    }, `Dismissed ${plan.name} from automatic suggestion for this workflow.`);
  }, [selectedStudioState, updateStudioState]);

  const handleGraduateBranchPlan = useCallback(() => {
    if (!activeBranchParentComparison) return;
    setSelectedPlanCompareId(activeBranchParentComparison.parent.plan.id);
    void patchAutomationConfig({
      executionPolicy: activeBranchParentComparison.child.plan.executionPolicy,
      studioState: {
        ...selectedStudioState,
        selectedPlanId: activeBranchParentComparison.child.plan.id,
        selectedPlanCompareId: activeBranchParentComparison.parent.plan.id,
        selectedPlanFamilyRootId: activeSavedPlan?.familyRootId,
        roleDirectives: cloneRoleDirectives(activeBranchParentComparison.child.plan.roleDirectives),
        lastAutoGraduatedPlanId: activeBranchParentComparison.child.plan.id,
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'graduation',
          summary: `Graduated ${activeBranchParentComparison.child.plan.name} above ${activeBranchParentComparison.parent.plan.name}.`,
          sourceExperimentId: activeBranchParentComparison.child.plan.sourceExperimentId,
          sourceExperimentLabel: activeBranchParentComparison.child.plan.sourceExperimentLabel || activeBranchParentComparison.child.plan.name,
          planId: activeBranchParentComparison.child.plan.id,
          parentPlanId: activeBranchParentComparison.parent.plan.id,
          autoApplied: false,
          confidence: activeBranchParentComparison.childScoring.confidence,
          successDelta: activeBranchParentComparison.successDelta,
          creditsDelta: activeBranchParentComparison.creditsDelta,
          durationDelta: activeBranchParentComparison.durationDelta,
        }),
      },
    }, { successMessage: `Graduated ${activeBranchParentComparison.child.plan.name}.` });
  }, [activeBranchParentComparison, activeSavedPlan?.familyRootId, patchAutomationConfig, selectedStudioState]);

  const handleClearPinnedSuggestion = useCallback(() => {
    if (!selectedStudioState.pinnedSuggestedPlanId) return;
    void updateStudioState({
      ...selectedStudioState,
      pinnedSuggestedPlanId: undefined,
    }, 'Cleared the pinned suggested plan.');
  }, [selectedStudioState, updateStudioState]);

  const handleUndoDismissedSuggestion = useCallback(() => {
    if (!selectedStudioState.dismissedSuggestedPlanId) return;
    void updateStudioState({
      ...selectedStudioState,
      dismissedSuggestedPlanId: undefined,
    }, 'Restored the last dismissed suggestion.');
  }, [selectedStudioState, updateStudioState]);

  const handleUpdateAutoGraduate = useCallback((patch: { enabled?: boolean; confidence?: number }) => {
    void updateStudioState({
      ...selectedStudioState,
      autoGraduateEnabled: patch.enabled ?? autoGraduateEnabled,
      autoGraduateMinConfidence: patch.confidence ?? (selectedStudioState.autoGraduateMinConfidence ?? autoGraduateMinConfidence),
    }, patch.enabled === false ? 'Automatic branch graduation disabled.' : patch.enabled === true ? 'Automatic branch graduation enabled.' : `Automatic graduation gate set to ${patch.confidence}%.`);
  }, [autoGraduateEnabled, autoGraduateMinConfidence, selectedStudioState, updateStudioState]);

  const handleUpdateAutoRollback = useCallback((patch: { enabled?: boolean; weakness?: number }) => {
    void updateStudioState({
      ...selectedStudioState,
      autoRollbackEnabled: patch.enabled ?? autoRollbackEnabled,
      autoRollbackWeaknessThreshold: patch.weakness ?? autoRollbackWeaknessThreshold,
    }, patch.enabled === false ? 'Automatic rollback disabled.' : patch.enabled === true ? 'Automatic rollback enabled.' : `Automatic rollback threshold set to ${patch.weakness}.`);
  }, [autoRollbackEnabled, autoRollbackWeaknessThreshold, selectedStudioState, updateStudioState]);

  const handleSetScopedAutoGraduateThreshold = useCallback((scope: 'global' | 'scenario' | 'archetype', threshold: number) => {
    const nextState: AutomationStudioStateDraft = { ...selectedStudioState };
    let message = `Automatic graduation gate set to ${threshold}% confidence.`;
    if (scope === 'scenario') {
      nextState.autoGraduateScenarioThresholds = {
        ...(selectedStudioState.autoGraduateScenarioThresholds || {}),
        [selectedScenario.id]: threshold,
      };
      message = `${selectedScenario.label} graduation gate set to ${threshold}% confidence.`;
    } else if (scope === 'archetype') {
      nextState.autoGraduateArchetypeThresholds = {
        ...(selectedStudioState.autoGraduateArchetypeThresholds || {}),
        [selectedArchetype.id]: threshold,
      };
      message = `${selectedArchetype.label} graduation gate set to ${threshold}% confidence.`;
    } else {
      nextState.autoGraduateMinConfidence = threshold;
      message = `Global automatic graduation gate set to ${threshold}% confidence.`;
    }
    void updateStudioState(nextState, message);
  }, [selectedArchetype.id, selectedArchetype.label, selectedScenario.id, selectedScenario.label, selectedStudioState, updateStudioState]);

  const handleClearScopedAutoGraduateThreshold = useCallback((scope: 'global' | 'scenario' | 'archetype') => {
    const nextState: AutomationStudioStateDraft = { ...selectedStudioState };
    let message = 'Reset automatic graduation gate.';
    if (scope === 'scenario') {
      nextState.autoGraduateScenarioThresholds = omitThresholdKey(selectedStudioState.autoGraduateScenarioThresholds, selectedScenario.id);
      message = `Reset ${selectedScenario.label} graduation gate back to the inherited value.`;
    } else if (scope === 'archetype') {
      nextState.autoGraduateArchetypeThresholds = omitThresholdKey(selectedStudioState.autoGraduateArchetypeThresholds, selectedArchetype.id);
      message = `Reset ${selectedArchetype.label} graduation gate back to the inherited value.`;
    } else {
      nextState.autoGraduateMinConfidence = undefined;
      message = 'Reset the global automatic graduation gate.';
    }
    void updateStudioState(nextState, message);
  }, [selectedArchetype.id, selectedArchetype.label, selectedScenario.id, selectedScenario.label, selectedStudioState, updateStudioState]);

  const handleApplyAutoGraduationProfile = useCallback((profileId: typeof AUTO_GRADUATION_PROFILES[number]['id'], scope: 'global' | 'archetype' | 'scenario' = 'archetype') => {
    const profile = getAutoGraduationProfileById(profileId);
    if (!profile) return;
    const nextState: AutomationStudioStateDraft = { ...selectedStudioState };
    if (scope === 'scenario') {
      nextState.autoGraduateScenarioThresholds = {
        ...(selectedStudioState.autoGraduateScenarioThresholds || {}),
        [selectedScenario.id]: profile.scenario,
      };
    } else if (scope === 'archetype') {
      nextState.autoGraduateArchetypeThresholds = {
        ...(selectedStudioState.autoGraduateArchetypeThresholds || {}),
        [selectedArchetype.id]: profile.archetype,
      };
    } else {
      nextState.autoGraduateMinConfidence = profile.global;
    }
    void updateStudioState(nextState, `Applied the ${profile.label.toLowerCase()} graduation profile to the ${scope === 'global' ? 'global' : scope === 'archetype' ? 'workflow class' : 'scenario'} gate.`);
  }, [selectedArchetype.id, selectedScenario.id, selectedStudioState, updateStudioState]);

  const patchWorkspaceAutoGraduationProfiles = useCallback(async (
    nextProfiles: Record<string, string>,
    successMessage: string,
  ) => {
    setActionBusy(true);
    try {
      const response = await fetch(`/api/settings?workspace_id=${encodeURIComponent(workspace.workspaceId)}&workspace_name=${encodeURIComponent(workspace.workspaceName)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
        body: JSON.stringify({
          agentStudio: {
            autoGraduationProfiles: nextProfiles,
          },
        }),
      });
      if (!response.ok) throw new Error('Could not save workspace graduation defaults');
      setWorkspaceAutoGraduationProfiles(nextProfiles);
      setNotice({ tone: 'success', message: successMessage });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not save workspace graduation defaults.' });
    } finally {
      setActionBusy(false);
    }
  }, [workspace.workspaceId, workspace.workspaceName]);

  const handleRememberWorkspaceAutoGraduationProfile = useCallback((profileId: typeof AUTO_GRADUATION_PROFILES[number]['id']) => {
    const nextProfiles = {
      ...workspaceAutoGraduationProfiles,
      [selectedArchetype.id]: profileId,
    };
    const profile = getAutoGraduationProfileById(profileId);
    void patchWorkspaceAutoGraduationProfiles(
      nextProfiles,
      `Remembered ${profile?.label.toLowerCase() || 'this'} graduation profile as the workspace default for ${selectedArchetype.label.toLowerCase()}.`,
    );
  }, [patchWorkspaceAutoGraduationProfiles, selectedArchetype.id, selectedArchetype.label, workspaceAutoGraduationProfiles]);

  const handleClearWorkspaceAutoGraduationProfile = useCallback(() => {
    const nextProfiles = { ...workspaceAutoGraduationProfiles };
    delete nextProfiles[selectedArchetype.id];
    void patchWorkspaceAutoGraduationProfiles(
      nextProfiles,
      `Cleared the workspace graduation default for ${selectedArchetype.label.toLowerCase()}.`,
    );
  }, [patchWorkspaceAutoGraduationProfiles, selectedArchetype.id, selectedArchetype.label, workspaceAutoGraduationProfiles]);

  const handleRestoreExperiment = useCallback((experiment: StudioExperimentRecord) => {
    if (SCENARIO_PRESETS.some((scenario) => scenario.id === experiment.scenarioId)) {
      setSelectedScenarioId(experiment.scenarioId as ScenarioPresetId);
    }
    if (POLICY_PRESETS.some((preset) => preset.id === experiment.previewPresetId)) {
      setPreviewPresetId(experiment.previewPresetId);
    }
    setSelectedComparisonExperimentId(experiment.id);
    void updateStudioState({
      ...selectedStudioState,
      selectedScenarioId: experiment.scenarioId,
      previewPresetId: experiment.previewPresetId,
      roleDirectives: cloneRoleDirectives(experiment.roleDirectives) || selectedStudioState.roleDirectives,
    });
    setNotice({ tone: 'success', message: 'Restored saved experiment.' });
  }, [selectedStudioState, updateStudioState]);

  const handleCompareExperiment = useCallback((experiment: StudioExperimentRecord) => {
    setSelectedComparisonExperimentId(experiment.id);
    setActiveRoom('replay');
    setNotice({ tone: 'success', message: 'Loaded this experiment into the comparison lab.' });
  }, []);

  const handleOpenRunInReplay = useCallback((run: PlatformTaskRunRecord, sourceLabel = 'replay') => {
    const attribution = getRunExperimentAttribution(run);
    const matchedPlan = rankRunPlanMatches(run, savedPlanSummaries.map((entry) => entry.plan))[0];
    const matchedPlanSummary = matchedPlan ? savedPlanSummaries.find((entry) => entry.plan.id === matchedPlan.plan.id) : undefined;
    const dominantPhase = readStepExecutions(run.metadata?.stepExecutions)
      .filter((step) => step.kind === 'search' || step.kind === 'query' || step.kind === 'capture' || step.kind === 'analyze' || step.kind === 'summarize' || step.kind === 'deliver' || step.kind === 'note')
      .sort((left, right) => (right.actualCredits || 0) - (left.actualCredits || 0))[0]?.kind;
    if (attribution.experimentId) {
      setSelectedComparisonExperimentId(attribution.experimentId);
    }
    if (matchedPlanSummary) {
      setSelectedPlanId(matchedPlanSummary.plan.id);
      setSelectedPlanFamilyRootId(matchedPlanSummary.familyRootId);
    }
    if (dominantPhase && dominantPhase !== 'note') {
      setSelectedReplayPhase(dominantPhase as WorkflowBlockKind);
    }
    setHoveredCohortRunId(run.id);
    setSelectedCohortRunId(run.id);
    setSelectedReplayCompareRunId('');
    setActiveRoom('replay');
    setNotice({ tone: 'success', message: `Opened the exact run in replay from ${sourceLabel}.` });
  }, [savedPlanSummaries]);

  const handleOpenContextRun = useCallback((runId: string) => {
    const run = selectedRow?.runs.find((candidate) => candidate.id === runId);
    if (!run) return;
    handleOpenRunInReplay(run, 'operational context map');
  }, [handleOpenRunInReplay, selectedRow?.runs]);

  const handleFocusLiveContextPhase = useCallback((phase: WorkflowBlockKind) => {
    setSelectedDirectivePhase(phase);
    setSelectedWorkerRole(getPreferredRoleForPhase(phase));
    setNotice({ tone: 'success', message: `Focused Live on ${formatDirectivePhaseScope([phase])} for ${getPreferredRoleForPhase(phase)}.` });
  }, []);

  const handleOpenReplayFromLiveLoop = useCallback(() => {
    const contextTargetRunId = operationalContext?.recommendationEvidence[0]?.relatedRunIds?.find((runId) => runId !== operationalContext?.runId)
      || operationalContext?.runId
      || selectedRow?.runs.find((run) => run.status === 'succeeded' || run.status === 'failed')?.id;
    if (contextTargetRunId) {
      handleOpenContextRun(contextTargetRunId);
      return;
    }
    setActiveRoom('replay');
  }, [handleOpenContextRun, operationalContext, selectedRow?.runs]);

  const handleOpenOptimizeFromReplayLoop = useCallback(() => {
    if (!recommendedReplayFix) return;
    setPhaseSimulation({ phase: recommendedReplayFix.phase, mode: recommendedReplayFix.mode });
    setActiveRoom('optimize');
  }, [recommendedReplayFix]);

  const handleOpenLiveFromOptimizeLoop = useCallback(() => {
    if (phaseSimulationPreview) {
      setSelectedDirectivePhase(phaseSimulationPreview.phase);
      setSelectedWorkerRole(phaseSimulationPreview.targetRole);
    } else if (selectedDirectivePhase !== 'all') {
      setSelectedWorkerRole(getPreferredRoleForPhase(selectedDirectivePhase));
    }
    setActiveRoom('live');
  }, [phaseSimulationPreview, selectedDirectivePhase]);

  const controlLoopHandoff = useMemo(() => {
    if (activeRoom === 'live') {
      const livePhase = operationalContext?.recommendationEvidence[0]?.phase;
      return {
        currentRoom: 'live' as const,
        nextRoom: 'replay' as const,
        title: livePhase
          ? `Next: verify ${formatDirectivePhaseScope([livePhase])} in Replay`
          : 'Next: verify the strongest signal in Replay',
        body: operationalContext?.recommendationEvidence[0]?.body
          || 'Replay is the next stop when Live shows pressure but you still need to confirm what actually changed outcome.',
        signals: compactPresent([
          livePhase ? { label: 'Focus', value: formatDirectivePhaseScope([livePhase]), tone: 'accent' as const } : null,
          operationalContext?.similarRuns[0]?.label ? { label: 'Seen in', value: operationalContext.similarRuns[0].label } : null,
          operationalContext?.lastHealthyComparison?.label ? { label: 'Healthy anchor', value: operationalContext.lastHealthyComparison.label } : null,
        ]),
        actionLabel: 'Open Replay',
        onAction: handleOpenReplayFromLiveLoop,
        secondaryLabel: livePhase ? `Focus ${formatDirectivePhaseScope([livePhase])}` : undefined,
        onSecondary: livePhase ? () => handleFocusLiveContextPhase(livePhase) : undefined,
      };
    }

    if (activeRoom === 'replay') {
      if (!recommendedReplayFix) {
        return {
          currentRoom: 'replay' as const,
          nextRoom: 'live' as const,
          title: 'Next: inspect the live system before changing policy',
          body: 'Replay has signal, but not enough for a clean targeted fix yet. Use Live to inspect the active role and collect the next run before promoting or simulating broader changes.',
          signals: compactPresent([
            replayDecisionBrief.focusLabel ? { label: 'Focus', value: replayDecisionBrief.focusLabel, tone: 'accent' as const } : null,
            runComparison?.previous ? { label: 'Compared to', value: runComparison.previous.experimentLabel || `${runComparison.previous.scenarioLabel} · ${runComparison.previous.presetLabel}` } : null,
            operationalContext?.similarRuns[0]?.label ? { label: 'Closest match', value: operationalContext.similarRuns[0].label } : null,
          ]),
          actionLabel: 'Open Live',
          onAction: () => setActiveRoom('live'),
        };
      }
      return {
        currentRoom: 'replay' as const,
        nextRoom: 'optimize' as const,
        title: `Next: test ${replayDecisionBrief.fixModeLabel.toLowerCase()} in Optimize`,
        body: replayDecisionBrief.nextStep,
        signals: compactPresent([
          { label: 'Fix', value: replayDecisionBrief.fixModeLabel },
          { label: 'Phase', value: replayDecisionBrief.focusLabel, tone: 'accent' as const },
          runComparison?.previous ? { label: 'Compared to', value: runComparison.previous.experimentLabel || `${runComparison.previous.scenarioLabel} · ${runComparison.previous.presetLabel}` } : null,
        ]),
        actionLabel: 'Open Optimize',
        onAction: handleOpenOptimizeFromReplayLoop,
        secondaryLabel: `Open ${replayDecisionBrief.focusLabel} in Live`,
        onSecondary: () => {
          setSelectedDirectivePhase(recommendedReplayFix.phase);
          setSelectedWorkerRole(getPreferredRoleForPhase(recommendedReplayFix.phase));
          setActiveRoom('live');
        },
      };
    }

    return {
      currentRoom: 'optimize' as const,
      nextRoom: 'live' as const,
      title: phaseSimulationPreview
        ? `Next: validate ${formatDirectivePhaseScope([phaseSimulationPreview.phase])} in Live`
        : 'Next: inspect Live before shipping this candidate',
      body: phaseSimulationPreview
        ? `You have a concrete fix preview. Open Live to inspect the target role and watch the next run after you apply it.`
        : `${optimizeDecisionBrief.nextStep} Live is where you inspect the operating surface this release would affect before you decide to ship it.`,
      signals: compactPresent([
        { label: 'Candidate', value: previewPreset.label },
        { label: 'Scenario', value: selectedScenario.label },
        phaseSimulationPreview ? { label: 'Validate', value: formatDirectivePhaseScope([phaseSimulationPreview.phase]), tone: 'accent' as const } : null,
      ]),
      actionLabel: phaseSimulationPreview ? 'Open Live' : 'Inspect Live',
      onAction: handleOpenLiveFromOptimizeLoop,
    };
  }, [
    activeRoom,
    handleFocusLiveContextPhase,
    handleOpenOptimizeFromReplayLoop,
    handleOpenReplayFromLiveLoop,
    handleOpenLiveFromOptimizeLoop,
    operationalContext,
    previewPreset.label,
    optimizeDecisionBrief.nextStep,
    phaseSimulationPreview,
    recommendedReplayFix,
    replayDecisionBrief.fixModeLabel,
    replayDecisionBrief.focusLabel,
    replayDecisionBrief.nextStep,
    runComparison?.previous,
    selectedScenario.label,
    setActiveRoom,
  ]);

  const handleOpenRunPairInReplay = useCallback((
    primaryRun: PlatformTaskRunRecord,
    comparedRun: PlatformTaskRunRecord,
    phase: WorkflowBlockKind,
    sourceLabel = 'matched phase comparison',
  ) => {
    const comparedAttribution = getRunExperimentAttribution(comparedRun);
    const matchedPlan = rankRunPlanMatches(primaryRun, savedPlanSummaries.map((entry) => entry.plan))[0];
    const matchedPlanSummary = matchedPlan ? savedPlanSummaries.find((entry) => entry.plan.id === matchedPlan.plan.id) : undefined;
    if (matchedPlanSummary) {
      setSelectedPlanId(matchedPlanSummary.plan.id);
      setSelectedPlanFamilyRootId(matchedPlanSummary.familyRootId);
    }
    if (comparedAttribution.experimentId) {
      setSelectedComparisonExperimentId(comparedAttribution.experimentId);
    }
    setSelectedReplayPhase(phase);
    setHoveredCohortRunId(primaryRun.id);
    setSelectedCohortRunId(primaryRun.id);
    setSelectedReplayCompareRunId(comparedRun.id);
    setActiveRoom('replay');
    setNotice({ tone: 'success', message: `Opened the exact run pair in replay from ${sourceLabel}.` });
  }, [savedPlanSummaries]);

  const handleOpenPlanSourceReplay = useCallback((plan: StudioOperatingPlan) => {
    const run = (selectedRow?.runs || [])
      .filter((candidate) => candidate.status === 'succeeded' || candidate.status === 'failed')
      .find((candidate) => {
        const attribution = getRunExperimentAttribution(candidate);
        if (plan.sourceExperimentId && attribution.experimentId) return attribution.experimentId === plan.sourceExperimentId;
        return attribution.scenarioId === plan.scenarioId && attribution.previewPresetId === plan.previewPresetId;
      });
    if (run) {
      handleOpenRunInReplay(run, `plan ${plan.name}`);
    } else {
      setNotice({ tone: 'error', message: `No matching run yet for ${plan.name}.` });
    }
  }, [handleOpenRunInReplay, selectedRow?.runs]);

  const handleForkCurrentSetup = useCallback(() => {
    const sourceLabel = getPresetLabelFromId(previewPresetId);
    const siblingCount = experimentHistory.filter((experiment) => !experiment.parentExperimentId).length + 1;
    const nextHistory = [
      {
        id: `exp_${Date.now()}`,
        scenarioId: selectedScenarioId,
        previewPresetId,
        createdAt: new Date().toISOString(),
        branchName: buildBranchName(sourceLabel, siblingCount),
        notes: `Forked from live setup · ${selectedScenario.label}`,
        roleDirectives: cloneRoleDirectives(selectedStudioState.roleDirectives),
      },
      ...(selectedStudioState.experimentHistory || []),
    ].slice(0, 12);

    void updateStudioState({
      ...selectedStudioState,
      selectedScenarioId,
      previewPresetId,
      experimentHistory: nextHistory,
    }, 'Forked the current live setup into a new experiment branch.');
  }, [experimentHistory, previewPresetId, selectedScenario.label, selectedScenarioId, selectedStudioState, updateStudioState]);

  const handleForkWinningSetup = useCallback((experiment: StudioExperimentRecord) => {
    const siblingCount = (experimentBranches.get(experiment.id) || 0) + 1;
    const nextHistory = [
      {
        id: `exp_${Date.now()}`,
        scenarioId: experiment.scenarioId,
        previewPresetId: experiment.previewPresetId,
        createdAt: new Date().toISOString(),
        branchName: buildBranchName(getExperimentDisplayLabel(experiment), siblingCount),
        parentExperimentId: experiment.id,
        notes: `Forked from ${getExperimentDisplayLabel(experiment)}`,
        roleDirectives: cloneRoleDirectives(experiment.roleDirectives),
      },
      ...(selectedStudioState.experimentHistory || []),
    ].slice(0, 12);

    void updateStudioState({
      ...selectedStudioState,
      experimentHistory: nextHistory,
    }, 'Forked the winning setup into a new branch.');
  }, [experimentBranches, selectedStudioState, updateStudioState]);

  const handlePromoteExperimentPreset = useCallback((experiment: StudioExperimentRecord) => {
    const preset = POLICY_PRESETS.find((item) => item.id === experiment.previewPresetId);
    if (!preset) {
      setNotice({ tone: 'error', message: 'This experiment no longer matches an available preset.' });
      return;
    }
    setSelectedScenarioId(experiment.scenarioId as ScenarioPresetId);
    setPreviewPresetId(experiment.previewPresetId);
    setSelectedComparisonExperimentId(experiment.id);
    void patchAutomationConfig({
      executionPolicy: preset.policy,
      studioState: {
        ...selectedStudioState,
        selectedScenarioId: experiment.scenarioId,
        previewPresetId: experiment.previewPresetId,
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'preset',
          summary: `Promoted preset from ${getExperimentDisplayLabel(experiment)}.`,
          sourceExperimentId: experiment.id,
          sourceExperimentLabel: getExperimentDisplayLabel(experiment),
        }),
      },
    }, { successMessage: 'Promoted the winning preset into the live policy.' });
  }, [patchAutomationConfig, selectedStudioState]);

  const handlePromoteExperimentSteering = useCallback((experiment: StudioExperimentRecord) => {
    setSelectedScenarioId(experiment.scenarioId as ScenarioPresetId);
    setPreviewPresetId(experiment.previewPresetId);
    setSelectedComparisonExperimentId(experiment.id);
    void updateStudioState({
      ...selectedStudioState,
      selectedScenarioId: experiment.scenarioId,
      previewPresetId: experiment.previewPresetId,
      roleDirectives: mergeRoleDirectiveSnapshots(selectedStudioState.roleDirectives, experiment.roleDirectives),
      promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
        mode: 'steering',
        summary: `Promoted steering from ${getExperimentDisplayLabel(experiment)}.`,
        sourceExperimentId: experiment.id,
        sourceExperimentLabel: getExperimentDisplayLabel(experiment),
      }),
    }, 'Promoted steering from this saved experiment.');
  }, [selectedStudioState, updateStudioState]);

  const handlePromoteExperimentFull = useCallback((experiment: StudioExperimentRecord) => {
    const preset = POLICY_PRESETS.find((item) => item.id === experiment.previewPresetId);
    if (!preset) {
      setNotice({ tone: 'error', message: 'This experiment no longer matches an available preset.' });
      return;
    }
    setSelectedScenarioId(experiment.scenarioId as ScenarioPresetId);
    setPreviewPresetId(experiment.previewPresetId);
    setSelectedComparisonExperimentId(experiment.id);
    void patchAutomationConfig({
      executionPolicy: preset.policy,
      studioState: {
        ...selectedStudioState,
        selectedScenarioId: experiment.scenarioId,
        previewPresetId: experiment.previewPresetId,
        roleDirectives: mergeRoleDirectiveSnapshots(selectedStudioState.roleDirectives, experiment.roleDirectives),
        promotionHistory: appendPromotionHistory(selectedStudioState.promotionHistory, {
          mode: 'full',
          summary: `Promoted full setup from ${getExperimentDisplayLabel(experiment)}.`,
          sourceExperimentId: experiment.id,
          sourceExperimentLabel: getExperimentDisplayLabel(experiment),
        }),
      },
    }, { successMessage: 'Promoted the full winning setup into the live policy.' });
  }, [patchAutomationConfig, selectedStudioState]);

  const optimizeAdvancedContent = (
    <>
      <OptimizeDiagnosticsSection
        wasteItems={workflowDiagnostics.wasteItems}
        riskItems={workflowDiagnostics.riskItems}
        actionBusy={actionBusy}
        onApplyRecommendationAction={applyRecommendationAction}
      />
                    <div className="grid gap-6">
                      <OptimizeAdvancedControlsSection
                        workflowFingerprint={{
                          stepCount: selectedMath.stepCount,
                          toolCalls: selectedMath.toolCalls,
                          reasoningLoad: selectedMath.reasoningLoad,
                          recommendedElasticLanes: selectedMath.recommendedElasticLanes,
                          activeElasticLanes: selectedMath.activeElasticLanes,
                        }}
                        optimizationRecommendations={optimizationRecommendations}
                        selectedPolicy={selectedPolicy}
                        actionBusy={actionBusy}
                        onApplyRecommendationAction={applyRecommendationAction}
                        onSetMode={(mode) => void patchExecutionPolicy({ ...selectedPolicy, mode })}
                        onSetOptimizationGoal={(optimizationGoal) => void patchExecutionPolicy({ ...selectedPolicy, mode: 'custom', optimizationGoal })}
                        onSetReviewPolicy={(reviewPolicy) => void patchExecutionPolicy({ ...selectedPolicy, mode: 'custom', reviewPolicy })}
                        onSetMaxElasticLanes={(maxElasticLanes) => void patchExecutionPolicy({ ...selectedPolicy, mode: 'custom', maxElasticLanes })}
                        getExecutionModeLabel={getExecutionModeLabel}
                        getOptimizationGoalLabel={getOptimizationGoalLabel}
                        getReviewPolicyLabel={getReviewPolicyLabel}
                      />

                      <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                        <div className="flex items-center gap-2">
                          <Layers3 className="h-4 w-4 text-cyan-300" />
                          <div>
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Saved operating plans</p>
                            <h3 className="text-sm font-semibold text-white">Reusable setups worth keeping close</h3>
                          </div>
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-slate-400">
                          Plans let us save strong operating postures, compare them later, and restore them without rebuilding the whole Studio state by hand.
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => handleSaveOperatingPlan()}
                            className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                          >
                            Save live setup as plan
                          </button>
                          {winningExperiment ? (
                            <button
                              type="button"
                              onClick={() => handleSaveOperatingPlan({ experiment: winningExperiment.experiment, namePrefix: 'Winning plan' })}
                              className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                            >
                              Save winning setup
                            </button>
                          ) : null}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {OPERATING_PLAN_INTENTS.map((intent) => (
                            <button
                              key={intent}
                              type="button"
                              onClick={() => handleSaveOperatingPlan({ intentLabel: intent, namePrefix: intent })}
                              className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                            >
                              Save {intent}
                            </button>
                          ))}
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setSelectedPlanIntentFilter('all')}
                            className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${selectedPlanIntentFilter === 'all' ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                          >
                            All intents
                          </button>
                          {OPERATING_PLAN_INTENTS.map((intent) => (
                            <button
                              key={`filter-${intent}`}
                              type="button"
                              onClick={() => setSelectedPlanIntentFilter(intent)}
                              className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${selectedPlanIntentFilter === intent ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                            >
                              {intent}
                            </button>
                          ))}
                        </div>
                        <div className="mt-4 space-y-3">
                          {filteredSavedPlans.length > 0 ? filteredSavedPlans.map((entry) => (
                            <div
                              key={entry.plan.id}
                              className={`rounded-2xl border p-4 ${activeSavedPlan?.plan.id === entry.plan.id ? 'border-cyan-500/22 bg-cyan-500/8' : 'border-navy-700/70 bg-navy-950/45'}`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-white">{entry.plan.name}</p>
                                  <p className="mt-1 text-[11px] text-slate-500">
                                    {getScenarioLabelFromId(entry.plan.scenarioId)} · {getPresetLabelFromId(entry.plan.previewPresetId)} · saved {formatRelativeTimeFromIso(entry.plan.createdAt)}
                                  </p>
                                </div>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                  {entry.steeringCount} steering
                                </span>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {entry.plan.intentLabel ? (
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-cyan-200">
                                    {entry.plan.intentLabel}
                                  </span>
                                ) : null}
                                {entry.plan.parentPlanId ? (
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                    Branch plan
                                  </span>
                                ) : null}
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                  {entry.stats.count} observed runs
                                </span>
                                <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${entry.confidence >= 70 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                  {entry.confidence}% confidence
                                </span>
                                <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${entry.freshness === 'fresh' ? 'text-emerald-200' : entry.freshness === 'warm' ? 'text-cyan-200' : 'text-amber-200'}`}>
                                  {entry.freshness}
                                </span>
                              </div>
                              <div className="mt-3 grid gap-2 sm:grid-cols-3 text-[11px]">
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                  <p className="text-slate-500">Spend</p>
                                  <p className="mt-1 text-white">{entry.spendIndex}</p>
                                </div>
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                  <p className="text-slate-500">Assurance</p>
                                  <p className="mt-1 text-white">{entry.assuranceIndex}</p>
                                </div>
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                  <p className="text-slate-500">Fit</p>
                                  <p className="mt-1 text-white">{entry.fitIndex}</p>
                                </div>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => setSelectedPlanId(entry.plan.id)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Make active
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleComparePlan(entry.plan)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Compare
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handleRestoreOperatingPlan(entry.plan)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200 disabled:opacity-60"
                                >
                                  Restore
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handleRestorePlanPresetOnly(entry.plan)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300 disabled:opacity-60"
                                >
                                  Preset only
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handleRestorePlanSteeringOnly(entry.plan)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300 disabled:opacity-60"
                                >
                                  Steering only
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleForkOperatingPlan(entry.plan)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Branch
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleOpenPlanSourceReplay(entry.plan)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Open replay
                                </button>
                                {entry.sourceExperiment ? (
                                  <button
                                    type="button"
                                    onClick={() => handleCompareExperiment(entry.sourceExperiment!)}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                  >
                                    Open source experiment
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              Save a live setup or a winning experiment and it will show up here as a reusable operating plan.
                            </div>
                          )}
                        </div>
                        <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Plan comparison lab</p>
                              <p className="mt-1 text-sm font-medium text-white">Primary vs compared plan</p>
                            </div>
                            {comparedSavedPlan ? (
                              <select
                                value={comparedSavedPlan.plan.id}
                                onChange={(event) => setSelectedPlanCompareId(event.target.value)}
                                className="rounded-full border border-white/10 bg-navy-950/70 px-3 py-1.5 text-xs text-slate-200"
                              >
                                {filteredSavedPlans.filter((entry) => entry.plan.id !== activeSavedPlan?.plan.id).map((entry) => (
                                  <option key={`compare-plan-${entry.plan.id}`} value={entry.plan.id}>
                                    {entry.plan.name}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                          </div>
                          {planComparison ? (
                            <div className="mt-4 space-y-3">
                              <div className="grid gap-3 sm:grid-cols-2">
                                <div className="rounded-2xl border border-cyan-500/18 bg-cyan-500/8 p-3">
                                  <p className="text-[10px] uppercase tracking-[0.16em] text-cyan-100/80">Primary</p>
                                  <p className="mt-1 text-sm font-medium text-white">{planComparison.primary.plan.name}</p>
                                  <p className="mt-1 text-[11px] text-slate-300">{planComparison.primary.plan.intentLabel || 'No named intent'}</p>
                                </div>
                                <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-3">
                                  <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Compared</p>
                                  <p className="mt-1 text-sm font-medium text-white">{planComparison.compared.plan.name}</p>
                                  <p className="mt-1 text-[11px] text-slate-400">{planComparison.compared.plan.intentLabel || 'No named intent'}</p>
                                </div>
                              </div>
                              <div className="grid gap-3 sm:grid-cols-4 text-[11px]">
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Spend delta</p><p className={`mt-1 ${planComparison.spendDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(planComparison.spendDelta)}</p></div>
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Assurance delta</p><p className={`mt-1 ${planComparison.assuranceDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(planComparison.assuranceDelta)}</p></div>
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Fit delta</p><p className={`mt-1 ${planComparison.fitDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(planComparison.fitDelta)}</p></div>
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Observed success</p><p className={`mt-1 ${planComparison.successDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(planComparison.successDelta)} pts</p></div>
                              </div>
                            </div>
                          ) : (
                            <p className="mt-3 text-sm text-slate-500">Save at least two plans to compare them side by side.</p>
                          )}
                        </div>
                        <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Plan families</p>
                          <div className="mt-3 space-y-3">
                            {planFamilies.length > 0 ? planFamilies.map((family) => (
                              <div
                                key={`plan-family-${family.root.plan.id}`}
                                className={`rounded-2xl border p-3 ${selectedPlanFamily?.root.familyRootId === family.root.familyRootId ? 'border-cyan-500/24 bg-cyan-500/8' : 'border-navy-700/70 bg-navy-950/45'}`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-white">{family.root.plan.name}</p>
                                    <p className="mt-1 text-[11px] text-slate-500">{family.entries.length} plans in this line · {family.runs.length} attributed runs</p>
                                  </div>
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">score {family.root.score}</span>
                                </div>
                                {family.trend ? (
                                  <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                    <svg viewBox={`0 0 ${family.trend.width} ${family.trend.height}`} className="h-20 w-full">
                                      <path d={family.trend.areaPath} fill="rgba(34,211,238,0.12)" />
                                      <path d={family.trend.linePath} fill="none" stroke="rgba(34,211,238,0.92)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                                      {family.trend.points.map((point) => (
                                        <circle
                                          key={`plan-family-point-${family.root.plan.id}-${point.run.id}`}
                                          cx={point.x}
                                          cy={point.y}
                                          r="3.5"
                                          fill="rgba(103,232,249,1)"
                                        />
                                      ))}
                                    </svg>
                                    <p className="mt-2 text-[11px] text-slate-500">Family evidence over recent runs.</p>
                                  </div>
                                ) : null}
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setSelectedPlanFamilyRootId(family.root.familyRootId)}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                  >
                                    Inspect family replay
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedPlanFamilyRootId(family.root.familyRootId);
                                      setSelectedPlanId(family.root.plan.id);
                                      setActiveRoom('replay');
                                    }}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                  >
                                    Open family in replay
                                  </button>
                                </div>
                              </div>
                          )) : (
                            <p className="text-sm text-slate-500">Branch a plan and its family will appear here.</p>
                          )}
                        </div>
                      </div>
                        <div className="space-y-4">
                        {selectedPlanFamilyReplay ? (
                          <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Selected plan family replay</p>
                                <p className="mt-1 text-sm font-medium text-white">{selectedPlanFamilyReplay.family.root.plan.name}</p>
                                <p className="mt-1 text-[11px] text-slate-500">{selectedPlanFamilyReplay.family.entries.length} plans in this line · drill into the exact run or restore the strongest child.</p>
                              </div>
                              <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{selectedPlanFamilyReplay.runs.length} recent runs</span>
                            </div>
                            {selectedPlanFamilyReplay.trend ? (
                              <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                <svg viewBox={`0 0 ${selectedPlanFamilyReplay.trend.width} ${selectedPlanFamilyReplay.trend.height}`} className="h-24 w-full">
                                  <path d={selectedPlanFamilyReplay.trend.areaPath} fill="rgba(34,211,238,0.10)" />
                                  <path d={selectedPlanFamilyReplay.trend.linePath} fill="none" stroke="rgba(34,211,238,0.92)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                                  {selectedPlanFamilyReplay.trend.points.map((point) => (
                                    <g
                                      key={`selected-plan-family-point-${point.run.id}`}
                                      onClick={() => handleOpenRunInReplay(point.run, 'plan family replay')}
                                      className="cursor-pointer"
                                      role="button"
                                      tabIndex={0}
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                          event.preventDefault();
                                          handleOpenRunInReplay(point.run, 'plan family replay');
                                        }
                                      }}
                                    >
                                      <circle cx={point.x} cy={point.y} r="4" fill="rgba(103,232,249,1)" />
                                    </g>
                                  ))}
                                </svg>
                                <p className="mt-2 text-[11px] text-slate-500">Click any point to open the exact run in replay.</p>
                              </div>
                            ) : null}
                            <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,0.95fr),minmax(0,1.05fr)]">
                              <div className="space-y-3">
                                {selectedPlanFamilyReplay.runs.length > 0 ? selectedPlanFamilyReplay.runs.map((run) => {
                                  const topPlanMatch = rankRunPlanMatches(run, selectedPlanFamilyReplay.family.entries.map((entry) => entry.plan))[0];
                                  return (
                                    <button
                                      key={`plan-family-run-${run.id}`}
                                      type="button"
                                      onClick={() => handleOpenRunInReplay(run, 'plan family replay')}
                                      className="w-full rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3 text-left transition hover:border-cyan-500/30"
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <div>
                                          <p className="text-sm font-medium text-white">{topPlanMatch?.plan.name || 'Unassigned family run'}</p>
                                          <p className="mt-1 text-[11px] text-slate-500">{formatAutomationRunTime(run.finishedAt || run.startedAt)}</p>
                                        </div>
                                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${getStatusTone(run.status)}`}>{run.status}</span>
                                      </div>
                                      <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{run.actualCredits ? `${formatCredits(run.actualCredits)} cr` : '—'}</span>
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{formatCompactDuration(Number.isNaN(Date.parse(run.startedAt || '')) || Number.isNaN(Date.parse(run.finishedAt || '')) ? undefined : Math.max(0, Date.parse(run.finishedAt || '') - Date.parse(run.startedAt || '')))}</span>
                                        {topPlanMatch ? (
                                          <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-cyan-200">
                                            match {topPlanMatch.score}
                                          </span>
                                        ) : null}
                                      </div>
                                    </button>
                                  );
                                }) : (
                                  <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-3 text-sm text-slate-500">
                                    This family needs a few more real runs before replay becomes useful.
                                  </div>
                                )}
                              </div>
                              <div className="space-y-3">
                                {selectedPlanFamilyReplay.leaderboard.map((entry, index) => (
                                  <div key={`selected-plan-family-leader-${entry.plan.id}`} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                                    <div className="flex items-start justify-between gap-3">
                                      <div>
                                        <p className="text-sm font-medium text-white">{index + 1}. {entry.plan.name}</p>
                                        <p className="mt-1 text-[11px] text-slate-500">{entry.stats.count} family runs · {Math.round(entry.stats.successRate * 100)}% success</p>
                                      </div>
                                      <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">score {entry.score}</span>
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      <button
                                        type="button"
                                        onClick={() => handleRestoreOperatingPlan(entry.plan)}
                                        disabled={actionBusy}
                                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200 disabled:opacity-60"
                                      >
                                        Restore child
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleComparePlan(entry.plan)}
                                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                      >
                                        Compare child
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        ) : null}
                        {planFamilyComparison ? (
                          <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Plan family comparison</p>
                                <p className="mt-1 text-sm font-medium text-white">Primary family vs alternate line</p>
                              </div>
                              {comparedPlanFamily ? (
                                <select
                                  value={comparedPlanFamily.root.plan.id}
                                  onChange={(event) => setSelectedPlanCompareId(event.target.value)}
                                  className="rounded-full border border-white/10 bg-navy-950/70 px-3 py-1.5 text-xs text-slate-200"
                                >
                                  {planFamilies.filter((family) => family.root.familyRootId !== selectedPlanFamily?.root.familyRootId).map((family) => (
                                    <option key={`compare-plan-family-${family.root.plan.id}`} value={family.root.plan.id}>
                                      {family.root.plan.name}
                                    </option>
                                  ))}
                                </select>
                              ) : null}
                            </div>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              <div className="rounded-2xl border border-cyan-500/18 bg-cyan-500/8 p-3">
                                <p className="text-[10px] uppercase tracking-[0.16em] text-cyan-100/80">Primary family</p>
                                <p className="mt-1 text-sm font-medium text-white">{planFamilyComparison.primary.root.plan.name}</p>
                                <p className="mt-1 text-[11px] text-slate-300">{planFamilyComparison.primary.entries.length} plans · {planFamilyComparison.primaryStats.count} runs</p>
                              </div>
                              <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-3">
                                <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Compared family</p>
                                <p className="mt-1 text-sm font-medium text-white">{planFamilyComparison.compared.root.plan.name}</p>
                                <p className="mt-1 text-[11px] text-slate-400">{planFamilyComparison.compared.entries.length} plans · {planFamilyComparison.comparedStats.count} runs</p>
                              </div>
                            </div>
                            <div className="mt-3 grid gap-3 sm:grid-cols-3 text-[11px]">
                              <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Success delta</p><p className={`mt-1 ${planFamilyComparison.successDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(planFamilyComparison.successDelta)} pts</p></div>
                              <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Spend delta</p><p className={`mt-1 ${planFamilyComparison.creditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(planFamilyComparison.creditsDelta)} cr</p></div>
                              <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Duration delta</p><p className={`mt-1 ${planFamilyComparison.durationDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(planFamilyComparison.durationDelta)}s</p></div>
                            </div>
                            {planFamilyReplayComparison ? (
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <div className="rounded-2xl border border-cyan-500/18 bg-cyan-500/8 p-3">
                                  <p className="text-[10px] uppercase tracking-[0.16em] text-cyan-100/80">Primary replay slice</p>
                                  {planFamilyReplayComparison.primaryRun ? (
                                    <>
                                      <p className="mt-1 text-sm font-medium text-white">{formatAutomationRunTime(planFamilyReplayComparison.primaryRun.finishedAt || planFamilyReplayComparison.primaryRun.startedAt)}</p>
                                      <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                        <span className={`rounded-full border px-2 py-0.5 font-medium ${getStatusTone(planFamilyReplayComparison.primaryRun.status)}`}>{planFamilyReplayComparison.primaryRun.status}</span>
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{planFamilyReplayComparison.primaryRun.actualCredits ? `${formatCredits(planFamilyReplayComparison.primaryRun.actualCredits)} cr` : '—'}</span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => handleOpenRunInReplay(planFamilyReplayComparison.primaryRun!, 'primary plan family')}
                                        className="mt-3 ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                      >
                                        Open primary replay
                                      </button>
                                    </>
                                  ) : (
                                    <p className="mt-2 text-sm text-slate-500">No replay slice yet.</p>
                                  )}
                                </div>
                                <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-3">
                                  <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Compared replay slice</p>
                                  {planFamilyReplayComparison.comparedRun ? (
                                    <>
                                      <p className="mt-1 text-sm font-medium text-white">{formatAutomationRunTime(planFamilyReplayComparison.comparedRun.finishedAt || planFamilyReplayComparison.comparedRun.startedAt)}</p>
                                      <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                        <span className={`rounded-full border px-2 py-0.5 font-medium ${getStatusTone(planFamilyReplayComparison.comparedRun.status)}`}>{planFamilyReplayComparison.comparedRun.status}</span>
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{planFamilyReplayComparison.comparedRun.actualCredits ? `${formatCredits(planFamilyReplayComparison.comparedRun.actualCredits)} cr` : '—'}</span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => handleOpenRunInReplay(planFamilyReplayComparison.comparedRun!, 'compared plan family')}
                                        className="mt-3 ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                      >
                                        Open compared replay
                                      </button>
                                    </>
                                  ) : (
                                    <p className="mt-2 text-sm text-slate-500">No replay slice yet.</p>
                                  )}
                                </div>
                              </div>
                            ) : null}
                            {planFamilyPhaseComparison ? (
                              <div className="mt-3 rounded-2xl border border-white/6 bg-white/[0.02] p-3">
                                <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Matched phase comparison</p>
                                <p className="mt-1 text-sm font-medium text-white">{formatDirectivePhaseScope([planFamilyPhaseComparison.phase])}</p>
                                <div className="mt-3 grid gap-3 sm:grid-cols-2 text-[11px]">
                                  <div className="rounded-xl border border-cyan-500/18 bg-cyan-500/8 px-3 py-3">
                                    <p className="text-slate-400">Primary phase</p>
                                    <p className="mt-1 text-white">{planFamilyPhaseComparison.primary.count} steps · {planFamilyPhaseComparison.primary.credits ? `${formatCredits(planFamilyPhaseComparison.primary.credits)} cr` : '—'}</p>
                                    <p className="mt-1 text-slate-300">{formatCompactDuration(planFamilyPhaseComparison.primary.durationMs)}</p>
                                  </div>
                                  <div className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                                    <p className="text-slate-400">Compared phase</p>
                                    <p className="mt-1 text-white">{planFamilyPhaseComparison.compared.count} steps · {planFamilyPhaseComparison.compared.credits ? `${formatCredits(planFamilyPhaseComparison.compared.credits)} cr` : '—'}</p>
                                    <p className="mt-1 text-slate-300">{formatCompactDuration(planFamilyPhaseComparison.compared.durationMs)}</p>
                                  </div>
                                </div>
                                {planFamilyReplayComparison?.primaryRun && planFamilyReplayComparison.comparedRun ? (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleOpenRunPairInReplay(
                                        planFamilyReplayComparison.primaryRun!,
                                        planFamilyReplayComparison.comparedRun!,
                                        planFamilyPhaseComparison.phase,
                                        'matched phase comparison'
                                      )}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                    >
                                      Open both in replay
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleOpenRunInReplay(planFamilyReplayComparison.primaryRun!, 'matched phase primary')}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                    >
                                      Primary only
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleOpenRunInReplay(planFamilyReplayComparison.comparedRun!, 'matched phase compared')}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                    >
                                      Compared only
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Plan performance audit</p>
                          <div className="mt-3 space-y-3">
                            {savedPlanAudit.length > 0 ? savedPlanAudit.map((entry) => (
                              <div key={`plan-audit-${entry.plan.id}`} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-white">{entry.plan.name}</p>
                                    <p className="mt-1 text-[11px] text-slate-500">{entry.stats.count} runs · {Math.round(entry.stats.successRate * 100)}% success · {entry.stats.averageCredits ? `${formatCredits(entry.stats.averageCredits)} cr avg` : '—'}</p>
                                  </div>
                                  <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${entry.outcome === 'Compounding' ? 'text-emerald-200' : entry.outcome === 'Promising' ? 'text-cyan-200' : entry.outcome === 'Weak' ? 'text-amber-200' : 'text-slate-300'}`}>
                                    {entry.outcome}
                                  </span>
                                </div>
                              </div>
                            )) : (
                              <p className="text-sm text-slate-500">No saved-plan evidence yet. Once plans are restored and exercised in real runs, they will be audited here.</p>
                            )}
                          </div>
                        </div>
                        {recommendedPlan ? (
                          <div className="rounded-2xl border border-emerald-500/16 bg-emerald-500/8 p-4">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-100/80">Recommended plan</p>
                            <p className="mt-1 text-sm font-medium text-white">{recommendedPlan.plan.name}</p>
                            <p className="mt-2 text-sm leading-relaxed text-slate-300">
                              Best current saved operating setup for this workflow based on observed runs, confidence, and spend discipline.
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                              <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${recommendedPlan.freshness === 'fresh' ? 'text-emerald-200' : recommendedPlan.freshness === 'warm' ? 'text-cyan-200' : 'text-amber-200'}`}>
                                {recommendedPlan.freshness} evidence
                              </span>
                              <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                {recommendedPlan.stats.count} observed runs
                              </span>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => handleRestoreOperatingPlan(recommendedPlan.plan)}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-emerald-100 disabled:opacity-60"
                              >
                                Restore recommended
                              </button>
                              <button
                                type="button"
                                onClick={() => handleComparePlan(recommendedPlan.plan)}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                              >
                                Compare recommended
                              </button>
                              {archetypeRecommendedPlan && archetypeRecommendedPlan.plan.id !== recommendedPlan.plan.id ? (
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handleRestoreOperatingPlan(archetypeRecommendedPlan.plan)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-emerald-100 disabled:opacity-60"
                                >
                                  Restore archetype pick
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        </div>
                        {activeBranchParentComparison ? (
                          <div className="mt-4 rounded-2xl border border-violet-500/16 bg-violet-500/8 p-4 xl:mt-0">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-violet-100/80">Branch vs parent</p>
                            <p className="mt-1 text-sm font-medium text-white">{activeBranchParentComparison.child.plan.name} vs {activeBranchParentComparison.parent.plan.name}</p>
                            <p className="mt-2 text-sm leading-relaxed text-slate-300">
                              This branched plan is being judged against its parent over the next few attributed runs so the phase branch can prove itself quickly.
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                              <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${activeBranchParentComparison.outcome === 'Compounding' ? 'text-emerald-200' : activeBranchParentComparison.outcome === 'Promising' ? 'text-cyan-200' : activeBranchParentComparison.outcome === 'Weak' ? 'text-amber-200' : 'text-slate-300'}`}>
                                {activeBranchParentComparison.outcome}
                              </span>
                              <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${activeBranchParentComparison.childScoring.freshness === 'fresh' ? 'text-emerald-200' : activeBranchParentComparison.childScoring.freshness === 'warm' ? 'text-cyan-200' : 'text-amber-200'}`}>
                                {activeBranchParentComparison.childScoring.freshness} child evidence
                              </span>
                              {activeBranchParentComparison.graduationReady ? (
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-emerald-200">
                                  Graduation ready
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Automatic graduation gate</p>
                                  <p className="mt-1 text-sm font-medium text-white">Promote strong child branches without manual review</p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleUpdateAutoGraduate({ enabled: !autoGraduateEnabled })}
                                  className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${autoGraduateEnabled ? 'text-emerald-200' : 'text-slate-300'}`}
                                >
                                  {autoGraduateEnabled ? 'Enabled' : 'Disabled'}
                                </button>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{autoGraduateScope.scope}</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{autoGraduateScope.label}</span>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {[60, 72, 85].map((threshold) => (
                                  <button
                                    key={`auto-graduate-${threshold}`}
                                    type="button"
                                    onClick={() => handleSetScopedAutoGraduateThreshold('global', threshold)}
                                    className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${autoGraduateMinConfidence === threshold ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-200' : 'text-slate-300'}`}
                                  >
                                    {threshold}%
                                  </button>
                                ))}
                              </div>
                              <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Archetype graduation presets</p>
                                <p className="mt-1 text-sm font-medium text-white">{selectedArchetype.label} should graduate on its own terms</p>
                                <p className="mt-2 text-[12px] leading-relaxed text-slate-300">
                                  {recommendedAutoGraduationProfile.summary}
                                </p>
                                <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                    Active: {activeAutoGraduationProfile.label}
                                  </span>
                                  {workspaceAutoGraduationProfile ? (
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-cyan-200">
                                      Workspace default: {workspaceAutoGraduationProfile.label}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {AUTO_GRADUATION_PROFILES.map((profile) => (
                                    <button
                                      key={`auto-graduation-profile-${profile.id}`}
                                      type="button"
                                      onClick={() => handleApplyAutoGraduationProfile(profile.id, 'archetype')}
                                      className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${
                                        profile.id === activeAutoGraduationProfile.id ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-200' : 'text-slate-300'
                                      }`}
                                    >
                                      {profile.label}
                                    </button>
                                  ))}
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleRememberWorkspaceAutoGraduationProfile(activeAutoGraduationProfile.id)}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                  >
                                    Remember active profile for workspace
                                  </button>
                                  {workspaceAutoGraduationProfile ? (
                                    <button
                                      type="button"
                                      onClick={() => handleClearWorkspaceAutoGraduationProfile()}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                    >
                                      Clear workspace default
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleSetScopedAutoGraduateThreshold('archetype', 72)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Set workflow-class gate
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSetScopedAutoGraduateThreshold('scenario', 72)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Set scenario gate
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleClearScopedAutoGraduateThreshold('archetype')}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Clear workflow-class gate
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleClearScopedAutoGraduateThreshold('scenario')}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Clear scenario gate
                                </button>
                              </div>
                            </div>
                            <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Graduation explainer</p>
                              <p className="mt-1 text-sm font-medium text-white">Why this branch is ready</p>
                              <p className="mt-2 text-[12px] leading-relaxed text-slate-300">
                                {activeBranchParentComparison.graduationReady
                                  ? `${activeBranchParentComparison.child.plan.name} is beating its parent on success, staying within spend tolerance, and has enough evidence depth to justify graduation.`
                                  : `${activeBranchParentComparison.child.plan.name} still needs either more confidence, more evidence, or a cleaner edge over its parent before it should graduate.`}
                              </p>
                            </div>
                            <div className="mt-3 grid gap-2 sm:grid-cols-3 text-[11px]">
                              <div className="rounded-xl border border-violet-500/18 bg-violet-500/8 px-3 py-2">
                                <p className="text-slate-400">Child run count</p>
                                <p className="mt-1 text-white">{activeBranchParentComparison.childRunCount}</p>
                              </div>
                              <div className="rounded-xl border border-violet-500/18 bg-violet-500/8 px-3 py-2">
                                <p className="text-slate-400">Success vs parent</p>
                                <p className={`mt-1 ${typeof activeBranchParentComparison.successDelta === 'number' && activeBranchParentComparison.successDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{typeof activeBranchParentComparison.successDelta === 'number' ? `${formatSignedDelta(activeBranchParentComparison.successDelta)} pts` : 'Waiting for runs'}</p>
                              </div>
                              <div className="rounded-xl border border-violet-500/18 bg-violet-500/8 px-3 py-2">
                                <p className="text-slate-400">Spend vs parent</p>
                                <p className={`mt-1 ${typeof activeBranchParentComparison.creditsDelta === 'number' && activeBranchParentComparison.creditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{typeof activeBranchParentComparison.creditsDelta === 'number' ? `${formatSignedDelta(activeBranchParentComparison.creditsDelta)} cr` : 'Waiting for runs'}</p>
                              </div>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {activeBranchParentComparison.graduationReady ? (
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handleGraduateBranchPlan()}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-violet-100 disabled:opacity-60"
                                >
                                  Graduate branch
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => handleComparePlan(activeBranchParentComparison.parent.plan)}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                              >
                                Compare parent
                              </button>
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => handleRestoreOperatingPlan(activeBranchParentComparison.parent.plan)}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-violet-100 disabled:opacity-60"
                              >
                                Restore parent
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {graduationHistory.length > 0 ? (
                          <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4 xl:mt-0">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Graduation history</p>
                            <div className="mt-3 space-y-3">
                              {graduationTimeline.map((item, index) => (
                                <div key={item.entry.id} className="relative rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                                  {index < graduationTimeline.length - 1 ? (
                                    <div className="absolute left-[1.15rem] top-10 h-[calc(100%-1.1rem)] w-px bg-gradient-to-b from-emerald-400/40 to-transparent" />
                                  ) : null}
                                  <div className="flex items-start gap-3">
                                    <div className="mt-0.5 h-4 w-4 rounded-full border border-emerald-400/40 bg-emerald-400/15" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-start justify-between gap-3">
                                        <div>
                                          <p className="text-sm font-medium text-white">{item.childLabel}</p>
                                          <p className="mt-1 text-[11px] text-slate-400">from {item.parentLabel} · {formatRelativeTimeFromIso(item.entry.appliedAt)}</p>
                                        </div>
                                        <div className="flex flex-wrap justify-end gap-2">
                                          <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${getPromotionModeTone(item.entry.mode)}`}>
                                            {item.entry.autoApplied ? 'Auto graduation' : 'Manual graduation'}
                                          </span>
                                          {typeof item.entry.confidence === 'number' ? (
                                            <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                              {item.entry.confidence}% confidence
                                            </span>
                                          ) : null}
                                        </div>
                                      </div>
                                      <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                        {typeof item.successDelta === 'number' ? (
                                          <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.successDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                            {formatSignedDelta(item.successDelta)} pts success
                                          </span>
                                        ) : null}
                                        {typeof item.creditsDelta === 'number' ? (
                                          <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.creditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                            {formatSignedDelta(item.creditsDelta)} cr
                                          </span>
                                        ) : null}
                                        {typeof item.durationDelta === 'number' ? (
                                          <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.durationDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                            {formatSignedDelta(item.durationDelta)}s
                                          </span>
                                        ) : null}
                                      </div>
                                      {(typeof item.currentSuccessDelta === 'number' || typeof item.currentCreditsDelta === 'number') ? (
                                        <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                          <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Outcome drift</p>
                                          <p className="mt-1 text-sm text-white">
                                            {typeof item.currentSuccessDelta === 'number' && typeof item.successDelta === 'number' && item.currentSuccessDelta < item.successDelta
                                              ? 'This branch has weakened since it graduated.'
                                              : 'This branch is holding or improving after graduation.'}
                                          </p>
                                          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                            {typeof item.currentSuccessDelta === 'number' ? (
                                              <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.currentSuccessDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                                now {formatSignedDelta(item.currentSuccessDelta)} pts
                                              </span>
                                            ) : null}
                                            {typeof item.currentCreditsDelta === 'number' ? (
                                              <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.currentCreditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                                now {formatSignedDelta(item.currentCreditsDelta)} cr
                                              </span>
                                            ) : null}
                                            {typeof item.currentDurationDelta === 'number' ? (
                                              <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.currentDurationDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                                now {formatSignedDelta(item.currentDurationDelta)}s
                                              </span>
                                            ) : null}
                                          </div>
                                        </div>
                                      ) : null}
                                      {item.reasons.length > 0 ? (
                                        <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                          <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Why this graduated</p>
                                          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                            {item.reasons.map((reason) => (
                                              <span key={`${item.entry.id}-${reason}`} className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                                {reason}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}
                                      {(item.childRun && item.parentRun && item.dominantPhase) ? (
                                        <div className="mt-3 flex flex-wrap gap-2">
                                          <button
                                            type="button"
                                            onClick={() => handleOpenRunPairInReplay(item.childRun!, item.parentRun!, item.dominantPhase!, 'graduation timeline')}
                                            className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                          >
                                            Open before / after
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleOpenRunInReplay(item.childRun!, 'graduation child')}
                                            className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                          >
                                            Child replay
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleOpenRunInReplay(item.parentRun!, 'graduation parent')}
                                            className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                          >
                                            Parent replay
                                          </button>
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {autoGraduationRollbackSuggestion ? (
                          <div className="mt-4 rounded-2xl border border-red-500/16 bg-red-500/8 p-4 xl:mt-0">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-red-100/80">Auto-graduation rollback</p>
                            <p className="mt-1 text-sm font-medium text-white">{autoGraduationRollbackSuggestion.child.plan.name} lost momentum after auto-graduation</p>
                            <p className="mt-2 text-sm leading-relaxed text-slate-300">
                              The child branch is now grading weak against {autoGraduationRollbackSuggestion.parent.plan.name}. Best move is to restore the parent or compare the lines before the child compounds more debt.
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                              {typeof autoGraduationRollbackSuggestion.successDelta === 'number' ? (
                                <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${autoGraduationRollbackSuggestion.successDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                  {formatSignedDelta(autoGraduationRollbackSuggestion.successDelta)} pts
                                </span>
                              ) : null}
                              {typeof autoGraduationRollbackSuggestion.creditsDelta === 'number' ? (
                                <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${autoGraduationRollbackSuggestion.creditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                  {formatSignedDelta(autoGraduationRollbackSuggestion.creditsDelta)} cr
                                </span>
                              ) : null}
                              <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                {autoGraduationRollbackSuggestion.childRunCount} child runs observed
                              </span>
                              <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-red-100">
                                weakness {autoGraduationRollbackSuggestion.weaknessScore}
                              </span>
                              <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${autoGraduationRollbackSuggestion.freshNegativeMomentum ? 'text-red-100' : 'text-slate-300'}`}>
                                {autoGraduationRollbackSuggestion.freshNegativeMomentum ? 'fresh negative momentum' : 'momentum not negative enough yet'}
                              </span>
                            </div>
                            <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Automatic rollback</p>
                              <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                  Workspace default: {workspaceAutoRollbackDefaults.enabled ? `enabled at ${workspaceAutoRollbackDefaults.weaknessThreshold}` : 'disabled'}
                                </span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                  Momentum gate: {autoRollbackMomentumThreshold}+ pt recent drop
                                </span>
                                <button
                                  type="button"
                                  onClick={() => navigate('/settings')}
                                  className="ui-pill px-2 py-0.5 normal-case tracking-normal text-cyan-200"
                                >
                                  Open workspace setup
                                </button>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleUpdateAutoRollback({ enabled: !autoRollbackEnabled })}
                                  className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${autoRollbackEnabled ? 'text-red-100' : 'text-slate-300'}`}
                                >
                                  {autoRollbackEnabled ? 'Enabled' : 'Enable automatic rollback'}
                                </button>
                                {[8, 12, 16].map((threshold) => (
                                  <button
                                    key={`auto-rollback-threshold-${threshold}`}
                                    type="button"
                                    onClick={() => handleUpdateAutoRollback({ weakness: threshold })}
                                    className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${autoRollbackWeaknessThreshold === threshold ? 'border-red-500/30 bg-red-500/12 text-red-100' : 'text-slate-300'}`}
                                  >
                                    Trigger at {threshold}
                                  </button>
                                ))}
                              </div>
                              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                                If enabled, Studio will restore the parent automatically only when both signals are true: weakness clears the active threshold and the child keeps showing fresh negative momentum after auto-graduation.
                              </p>
                            </div>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2 text-[11px]">
                              <div className="rounded-xl border border-red-500/16 bg-red-500/8 px-3 py-3">
                                <p className="text-slate-400">Keep child branch</p>
                                <p className="mt-1 text-white">{Math.round(autoGraduationRollbackSuggestion.childWindowStats.successRate * 100)}% success · {autoGraduationRollbackSuggestion.childWindowStats.averageCredits ? `${formatCredits(autoGraduationRollbackSuggestion.childWindowStats.averageCredits)} cr avg` : '—'}</p>
                                <p className="mt-1 text-[10px] text-slate-400">Recent 4 runs: {Math.round(autoGraduationRollbackSuggestion.childRecentStats.successRate * 100)}% · {autoGraduationRollbackSuggestion.childRecentStats.averageCredits ? `${formatCredits(autoGraduationRollbackSuggestion.childRecentStats.averageCredits)} cr avg` : '—'}</p>
                              </div>
                              <div className="rounded-xl border border-emerald-500/16 bg-emerald-500/8 px-3 py-3">
                                <p className="text-slate-400">Restore parent</p>
                                <p className="mt-1 text-white">{Math.round(autoGraduationRollbackSuggestion.parentWindowStats.successRate * 100)}% success · {autoGraduationRollbackSuggestion.parentWindowStats.averageCredits ? `${formatCredits(autoGraduationRollbackSuggestion.parentWindowStats.averageCredits)} cr avg` : '—'}</p>
                                <p className="mt-1 text-[10px] text-slate-400">Recent 4 runs: {Math.round(autoGraduationRollbackSuggestion.parentRecentStats.successRate * 100)}% · {autoGraduationRollbackSuggestion.parentRecentStats.averageCredits ? `${formatCredits(autoGraduationRollbackSuggestion.parentRecentStats.averageCredits)} cr avg` : '—'}</p>
                              </div>
                            </div>
                            <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Guardrail</p>
                              <p className="mt-1 text-sm text-white">
                                {autoGraduationRollbackSuggestion.freshNegativeMomentum
                                  ? 'Fresh run momentum is negative enough to justify an automatic restore if the weakness threshold is also cleared.'
                                  : 'The child has weakened overall, but recent runs are not negative enough yet to justify automatic rollback.'}
                              </p>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => handleRestoreOperatingPlan(autoGraduationRollbackSuggestion.parent.plan)}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-red-100 disabled:opacity-60"
                              >
                                Restore parent now
                              </button>
                              <button
                                type="button"
                                onClick={() => handleComparePlan(autoGraduationRollbackSuggestion.parent.plan)}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                              >
                                Compare before rollback
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {rollbackTimeline.length > 0 ? (
                          <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4 xl:mt-0">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Rollback history</p>
                            <div className="mt-3 space-y-3">
                              {rollbackTimeline.map((item) => (
                                <div key={item.entry.id} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div>
                                      <p className="text-sm font-medium text-white">{item.restoredLabel}</p>
                                      <p className="mt-1 text-[11px] text-slate-400">rolled back from {item.rolledBackLabel} · {formatRelativeTimeFromIso(item.entry.appliedAt)}</p>
                                    </div>
                                    <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${getPromotionModeTone(item.entry.mode)}`}>
                                      {item.entry.autoApplied ? 'Auto rollback' : 'Manual rollback'}
                                    </span>
                                  </div>
                                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                    {typeof item.entry.successDelta === 'number' ? (
                                      <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.entry.successDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                        {formatSignedDelta(item.entry.successDelta)} pts
                                      </span>
                                    ) : null}
                                    {typeof item.entry.creditsDelta === 'number' ? (
                                      <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.entry.creditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                        {formatSignedDelta(item.entry.creditsDelta)} cr
                                      </span>
                                    ) : null}
                                  </div>
                                  {(typeof item.currentSuccessDelta === 'number' || typeof item.currentCreditsDelta === 'number' || typeof item.currentDurationDelta === 'number') ? (
                                    <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                      <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Rollback drift</p>
                                      <p className="mt-1 text-sm text-white">
                                        {typeof item.currentSuccessDelta === 'number' && item.currentSuccessDelta >= 0
                                          ? 'The restored parent is holding or improving after rollback.'
                                          : 'The restored parent is not clearly recovering yet.'}
                                      </p>
                                      <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                        {typeof item.currentSuccessDelta === 'number' ? (
                                          <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.currentSuccessDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                            now {formatSignedDelta(item.currentSuccessDelta)} pts
                                          </span>
                                        ) : null}
                                        {typeof item.currentCreditsDelta === 'number' ? (
                                          <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.currentCreditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                            now {formatSignedDelta(item.currentCreditsDelta)} cr
                                          </span>
                                        ) : null}
                                        {typeof item.currentDurationDelta === 'number' ? (
                                          <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${item.currentDurationDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                            now {formatSignedDelta(item.currentDurationDelta)}s
                                          </span>
                                        ) : null}
                                      </div>
                                    </div>
                                  ) : null}
                                  <p className="mt-3 text-sm leading-relaxed text-slate-300">{item.entry.summary}</p>
                                  {item.recoverySeries.length > 0 ? (
                                    <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                      <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Recovery window</p>
                                      <div className="mt-3 flex h-24 items-end gap-2">
                                        {item.recoverySeries.map((sample) => {
                                          const restoredCredits = sample.restored?.actualCredits || 0;
                                          const rolledBackCredits = sample.rolledBack?.actualCredits || 0;
                                          return (
                                            <div key={`rollback-recovery-${item.entry.id}-${sample.index}`} className="flex min-w-0 flex-1 items-end gap-1">
                                              <div className="flex-1 rounded-t-md bg-emerald-400/75" style={{ height: `${Math.min(Math.max(18, restoredCredits * 2), 88)}px` }} />
                                              <div className="flex-1 rounded-t-md bg-amber-400/65" style={{ height: `${Math.min(Math.max(18, rolledBackCredits * 2), 88)}px` }} />
                                            </div>
                                          );
                                        })}
                                      </div>
                                      <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-emerald-200">restored parent</span>
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-amber-200">rolled-back child</span>
                                      </div>
                                    </div>
                                  ) : null}
                                  {(item.restoredRun && item.rolledBackRun) ? (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      <button
                                        type="button"
                                        onClick={() => handleOpenRunPairInReplay(item.restoredRun!, item.rolledBackRun!, item.entry.phase || 'analyze', 'rollback timeline')}
                                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                      >
                                        Open before / after
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleOpenRunInReplay(item.restoredRun!, 'rollback restored')}
                                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                      >
                                        Restored replay
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {planRollbackSuggestion ? (
                          <div className="mt-4 rounded-2xl border border-amber-500/16 bg-amber-500/8 p-4">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-amber-100/80">Plan rollback suggestion</p>
                            <p className="mt-1 text-sm font-medium text-white">{planRollbackSuggestion.active.plan.name} is underperforming</p>
                            <p className="mt-2 text-sm leading-relaxed text-slate-300">
                              Best restore target right now is {planRollbackSuggestion.restoreTarget.plan.name}.
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => handleRestoreOperatingPlan(planRollbackSuggestion.restoreTarget.plan)}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-amber-100 disabled:opacity-60"
                              >
                                Restore target
                              </button>
                              <button
                                type="button"
                                onClick={() => handleComparePlan(planRollbackSuggestion.restoreTarget.plan)}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                              >
                                Compare rollback
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {planActionQueue.length > 0 ? (
                          <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Plan action queue</p>
                            <div className="mt-3 space-y-3">
                              {planActionQueue.map((item) => (
                                <div key={item.id} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                                  <p className="text-sm font-medium text-white">{item.title}</p>
                                  <p className="mt-1 text-[12px] leading-relaxed text-slate-400">{item.body}</p>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {item.action === 'restore_recommended' && recommendedPlan ? (
                                      <button
                                        type="button"
                                        disabled={actionBusy}
                                        onClick={() => handleRestoreOperatingPlan(recommendedPlan.plan)}
                                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200 disabled:opacity-60"
                                      >
                                        Restore recommended
                                      </button>
                                    ) : null}
                                    {item.action === 'rollback' && planRollbackSuggestion ? (
                                      <button
                                        type="button"
                                        disabled={actionBusy}
                                        onClick={() => handleRestoreOperatingPlan(planRollbackSuggestion.restoreTarget.plan)}
                                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-amber-100 disabled:opacity-60"
                                      >
                                        Roll back now
                                      </button>
                                    ) : null}
                                    {item.action === 'compare' && comparedSavedPlan ? (
                                      <button
                                        type="button"
                                        onClick={() => handleComparePlan(comparedSavedPlan.plan)}
                                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                      >
                                        Open comparison
                                      </button>
                                    ) : null}
                                    {item.action === 'save_phase_plan' && selectedReplayPhaseDetail ? (
                                      <button
                                        type="button"
                                        onClick={() => handleBranchPhasePlan(
                                          selectedReplayPhaseDetail.phase,
                                          selectedReplayPhaseDelta && selectedReplayPhaseDelta.creditsDelta > 10 ? 'cheaper' : selectedReplayPhaseDelta?.actualStatus === 'failed' ? 'review' : 'promote'
                                        )}
                                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                      >
                                        Branch phase plan
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Archetype plan learning</p>
                          <div className="mt-3 space-y-3">
                            {archetypeRecommendedPlan ? (
                              <div className="rounded-2xl border border-cyan-500/16 bg-cyan-500/8 p-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-white">{archetypeRecommendedPlanMode === 'auto' ? 'Auto-pick for this workflow' : 'Suggested plan for this workflow'}</p>
                                    <p className="mt-1 text-[11px] text-slate-300">{archetypeRecommendedPlan.plan.name}</p>
                                    <p className="mt-1 text-[11px] text-slate-500">
                                      {archetypeRecommendedPlanMode === 'auto'
                                        ? `Recommended from ${selectedArchetype.label.toLowerCase()} learning so users land on a concrete setup instead of a blank state.`
                                        : `Evidence is still thin for ${selectedArchetype.label.toLowerCase()}, so Violema is suggesting this plan without switching automatically.`}
                                    </p>
                                  </div>
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-cyan-200">{archetypeRecommendedPlan.plan.intentLabel || 'No named intent'}</span>
                                </div>
                                {archetypeRecommendedPlanMode === 'suggested' ? (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      disabled={actionBusy}
                                      onClick={() => handleRestoreOperatingPlan(archetypeRecommendedPlan.plan)}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200 disabled:opacity-60"
                                    >
                                      Try suggested plan
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleComparePlan(archetypeRecommendedPlan.plan)}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                    >
                                      Compare first
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handlePinSuggestedPlan(archetypeRecommendedPlan.plan)}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                    >
                                      Pin suggestion
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDismissSuggestedPlan(archetypeRecommendedPlan.plan)}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                    >
                                      Dismiss suggestion
                                    </button>
                                  </div>
                                ) : null}
                                <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                  {selectedStudioState.pinnedSuggestedPlanId ? (
                                    <button
                                      type="button"
                                      onClick={() => handleClearPinnedSuggestion()}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                    >
                                      Clear pinned suggestion
                                    </button>
                                  ) : null}
                                  {selectedStudioState.dismissedSuggestedPlanId ? (
                                    <button
                                      type="button"
                                      onClick={() => handleUndoDismissedSuggestion()}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                    >
                                      Undo dismissal
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}
                            {archetypePlanLearning.length > 0 ? archetypePlanLearning.map((entry, index) => (
                              <div key={`archetype-plan-${entry.label}`} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-white">{index + 1}. {entry.label}</p>
                                    <p className="mt-1 text-[11px] text-slate-500">{entry.plans} saved plans · {entry.stats.count} observed runs · {Math.round(entry.stats.successRate * 100)}% success</p>
                                  </div>
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">score {entry.score}</span>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setSelectedPlanIntentFilter(entry.label)}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                  >
                                    Filter to this intent
                                  </button>
                                  {recommendedPlan?.plan.intentLabel === entry.label ? (
                                    <button
                                      type="button"
                                      disabled={actionBusy}
                                      onClick={() => handleRestoreOperatingPlan(recommendedPlan.plan)}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200 disabled:opacity-60"
                                    >
                                      Restore top plan
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            )) : (
                              <p className="text-sm text-slate-500">As more workflows in this archetype accumulate saved plans and real runs, Violema will rank which operating intent wins here.</p>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                          <div>
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">What Violema is learning</p>
                            <h3 className="text-sm font-semibold text-white">Best presets for {learnedPresetLearning.scopeLabel}</h3>
                          </div>
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-slate-400">
                          {selectedArchetype.summary}
                        </p>
                        <div className="mt-4 space-y-3">
                          {learnedPresetLearning.items.map((item, index) => (
                            <div key={item.presetId} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-semibold text-white">{index + 1}. {item.label}</p>
                                  <p className="mt-1 text-[11px] text-slate-500">{item.runCount} observed runs across {item.workflowCount} workflows</p>
                                </div>
                                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-200">
                                  Score {item.score}
                                </span>
                              </div>
                              <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
                                <div>
                                  <p className="text-slate-500">Success</p>
                                  <p className="mt-1 text-white">{item.averageSuccess}%</p>
                                </div>
                                <div>
                                  <p className="text-slate-500">Spend</p>
                                  <p className="mt-1 text-white">{item.averageCredits ? `${formatCredits(item.averageCredits)} cr` : '—'}</p>
                                </div>
                                <div>
                                  <p className="text-slate-500">Confidence</p>
                                  <p className="mt-1 text-white">{item.confidence}%</p>
                                </div>
                                <div>
                                  <p className="text-slate-500">Position</p>
                                  <p className="mt-1 text-white">{index === 0 ? 'Best current fit' : 'Observed alternative'}</p>
                                </div>
                              </div>
                            </div>
                          ))}
                          {learnedPresetLearning.items.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              Not enough live history yet to rank presets for this workflow class.
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                        <div className="flex items-center gap-2">
                          <Brain className="h-4 w-4 text-cyan-300" />
                          <div>
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Phase learning</p>
                            <h3 className="text-sm font-semibold text-white">What wins by phase for this workflow class</h3>
                          </div>
                        </div>
                        <div className="mt-4 space-y-3">
                          {phaseLearningByArchetype.length > 0 ? phaseLearningByArchetype.map((item) => (
                            <div key={`${item.phase}-${item.mode}`} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-white">{formatDirectivePhaseScope([item.phase])} · {item.mode === 'baseline' ? 'Baseline' : item.mode}</p>
                                  <p className="mt-1 text-[11px] text-slate-500">{item.runs} observed step runs in {selectedArchetype.label.toLowerCase()} · steer {getPreferredRoleForPhase(item.phase)}</p>
                                </div>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">score {item.score}</span>
                              </div>
                              <div className="mt-3 grid gap-2 sm:grid-cols-4 text-[11px]">
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Success</p><p className="mt-1 text-white">{Math.round(item.successRate * 100)}%</p></div>
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Avg credits</p><p className="mt-1 text-white">{item.averageCredits ? `${formatCredits(item.averageCredits)} cr` : '—'}</p></div>
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Best use</p><p className="mt-1 text-white">{item.mode === 'baseline' ? 'Default posture' : `${item.mode} bias`}</p></div>
                                <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2"><p className="text-slate-500">Confidence</p><p className="mt-1 text-white">{item.confidence}%</p></div>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {item.mode === 'baseline' ? (
                                  <button
                                    type="button"
                                    disabled={actionBusy}
                                    onClick={() => {
                                      setSelectedDirectivePhase(item.phase);
                                      setSelectedWorkerRole(getPreferredRoleForPhase(item.phase));
                                      setActiveRoom('live');
                                      setNotice({ tone: 'success', message: `Focused Agent Studio on ${formatDirectivePhaseScope([item.phase])} for ${getPreferredRoleForPhase(item.phase)}.` });
                                    }}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300 disabled:opacity-60"
                                  >
                                    Inspect this phase
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setPhaseSimulation({ phase: item.phase, mode: item.mode as 'cheaper' | 'review' | 'promote' })}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                    >
                                      Simulate first
                                    </button>
                                    <button
                                      type="button"
                                      disabled={actionBusy}
                                      onClick={() => handleApplyPhaseLearning(item.phase, item.mode as 'cheaper' | 'review' | 'promote')}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200 disabled:opacity-60"
                                    >
                                      Apply {item.mode} here
                                    </button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedDirectivePhase(item.phase);
                                    setSelectedWorkerRole(getPreferredRoleForPhase(item.phase));
                                    setActiveRoom('live');
                                  }}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Open in node inspector
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedDirectivePhase(item.phase);
                                    setActiveRoom('replay');
                                  }}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  View evidence in replay
                                </button>
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              Not enough phase-level history yet to say which steering wins for this workflow class.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                        <div className="flex items-center gap-2">
                          <BarChart3 className="h-4 w-4 text-amber-300" />
                          <div>
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Phase cost map</p>
                            <h3 className="text-sm font-semibold text-white">Where spend is actually buying confidence</h3>
                          </div>
                        </div>
                        <div className="mt-4 space-y-3">
                          {phaseCostConfidenceMap.length > 0 ? phaseCostConfidenceMap.map((phase) => (
                            <div key={`phase-map-${phase.phase}`} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-white">{formatDirectivePhaseScope([phase.phase])}</p>
                                  <p className="mt-1 text-[11px] text-slate-500">{phase.runs} observed executions</p>
                                </div>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{phase.recommendation}</span>
                              </div>
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <div>
                                  <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                    <span>Confidence</span>
                                    <span>{phase.confidence}%</span>
                                  </div>
                                  <div className="mt-1 h-2 rounded-full bg-navy-950/70">
                                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-300" style={{ width: `${Math.max(10, phase.confidence)}%` }} />
                                  </div>
                                </div>
                                <div>
                                  <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                    <span>Cost pressure</span>
                                    <span>{phase.costPressure}%</span>
                                  </div>
                                  <div className="mt-1 h-2 rounded-full bg-navy-950/70">
                                    <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-red-300" style={{ width: `${Math.max(10, phase.costPressure)}%` }} />
                                  </div>
                                </div>
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              Not enough phase evidence yet to map cost against confidence.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                        <div className="flex items-center gap-2">
                          <Orbit className="h-4 w-4 text-cyan-300" />
                          <div>
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Branch opportunity map</p>
                            <h3 className="text-sm font-semibold text-white">Which branch lines deserve the next experiment</h3>
                          </div>
                        </div>
                        <div className="mt-4 space-y-3">
                          {branchOpportunityMap.length > 0 ? branchOpportunityMap.map((branch) => (
                            <div key={branch.id} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-white">{branch.label}</p>
                                  <p className="mt-1 text-[11px] text-slate-500">
                                    {branch.successRate}% success · confidence {branch.confidence}% · spend {branch.spendDelta > 0 ? '+' : ''}{branch.spendDelta} cr vs workflow baseline
                                  </p>
                                </div>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">score {branch.score}</span>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedBranchRootId(branch.id);
                                    setActiveRoom('replay');
                                  }}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Inspect branch
                                </button>
                                {branch.focusPhase ? (
                                  <button
                                    type="button"
                                    onClick={() => setPhaseSimulation({ phase: branch.focusPhase!, mode: branch.successRate < 70 ? 'review' : 'cheaper' })}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                  >
                                    Simulate {formatDirectivePhaseScope([branch.focusPhase])}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              Branch opportunity mapping unlocks once there are enough saved experiments and runs to compare real branch lines.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                        <div className="flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-violet-300" />
                          <div>
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Phase simulation</p>
                            <h3 className="text-sm font-semibold text-white">Preview the move before you apply it</h3>
                          </div>
                        </div>
                        {phaseSimulationPreview ? (
                          <div className="mt-4 space-y-4">
                            <div className="rounded-2xl border border-violet-500/16 bg-violet-500/8 p-4">
                              <p className="text-sm font-medium text-white">
                                {getDirectiveModeLabel(phaseSimulationPreview.mode)} on {formatDirectivePhaseScope([phaseSimulationPreview.phase])}
                              </p>
                              <p className="mt-1 text-[12px] text-slate-400">
                                This would steer {phaseSimulationPreview.targetRole} and rebalance the workflow policy before you commit it.
                              </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-3 text-[11px]">
                              <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                <p className="text-slate-500">Spend delta</p>
                                <p className={`mt-1 ${phaseSimulationPreview.spendDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(phaseSimulationPreview.spendDelta)}</p>
                              </div>
                              <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                <p className="text-slate-500">Assurance delta</p>
                                <p className={`mt-1 ${phaseSimulationPreview.assuranceDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(phaseSimulationPreview.assuranceDelta)}</p>
                              </div>
                              <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                <p className="text-slate-500">Fit delta</p>
                                <p className={`mt-1 ${phaseSimulationPreview.fitDelta >= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(phaseSimulationPreview.fitDelta)}</p>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => handleApplyPhaseLearning(phaseSimulationPreview.phase, phaseSimulationPreview.mode)}
                                className="rounded-xl border border-cyan-500/24 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-500/14 disabled:opacity-60"
                              >
                                Apply simulated move
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedDirectivePhase(phaseSimulationPreview.phase);
                                  setSelectedWorkerRole(phaseSimulationPreview.targetRole);
                                  setActiveRoom('live');
                                }}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                              >
                                Open target role
                              </button>
                              <button
                                type="button"
                                onClick={() => setPhaseSimulation(null)}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                              >
                                Clear preview
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-4 rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                            Pick a non-baseline phase-learning move and preview it here before pushing it into the live policy.
                          </div>
                        )}
                      </div>

                      <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <RotateCcw className="h-4 w-4 text-cyan-300" />
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Saved experiments</p>
                              <h3 className="text-sm font-semibold text-white">Restore strong operating setups</h3>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={handleForkCurrentSetup}
                            className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                          >
                            Fork live policy
                          </button>
                        </div>
                        <div className="mt-4 space-y-3">
                          {experimentHistory.length > 0 ? experimentHistory.map((experiment) => {
                            const matchedRun = experimentRunMatches.get(experiment.id);
                            const matchedAttribution = matchedRun ? getRunExperimentAttribution(matchedRun) : undefined;
                            return (
                              <div
                                key={experiment.id}
                                className={`rounded-2xl border p-4 transition-colors ${selectedComparisonExperimentId === experiment.id ? 'border-cyan-500/22 bg-cyan-500/8' : 'border-navy-700/70 bg-navy-950/45'}`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-white">{getExperimentDisplayLabel(experiment)}</p>
                                    <p className="mt-1 text-[11px] text-slate-500">{POLICY_PRESETS.find((preset) => preset.id === experiment.previewPresetId)?.label || experiment.previewPresetId}</p>
                                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                      {getExperimentTags(experiment).map((tag) => (
                                        <span key={`${experiment.id}-${tag}`} className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{tag}</span>
                                      ))}
                                      {experiment.parentExperimentId ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">Branch</span> : null}
                                      {(experimentBranches.get(experiment.id) || 0) > 0 ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{experimentBranches.get(experiment.id)} child branches</span> : null}
                                    </div>
                                  </div>
                                  <span className="rounded-full border border-navy-700 bg-navy-900 px-2 py-0.5 text-[10px] text-slate-300">
                                    {formatRelativeTimeFromIso(experiment.createdAt)}
                                  </span>
                                </div>
                                {experiment.notes ? <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{experiment.notes}</p> : null}
                                <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-400">
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                    {matchedRun ? `${matchedAttribution?.previewPresetLabel || 'Observed'} observed` : 'No attributed run yet'}
                                  </span>
                                  {matchedRun ? <span className={`rounded-full border px-2 py-0.5 font-medium ${getStatusTone(matchedRun.status)}`}>{matchedRun.status}</span> : null}
                                  {matchedRun && typeof matchedRun.actualCredits === 'number' ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{formatCredits(matchedRun.actualCredits)} cr</span> : null}
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleCompareExperiment(experiment)}
                                    className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${selectedComparisonExperimentId === experiment.id ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                                  >
                                    Compare this experiment
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRestoreExperiment(experiment)}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                  >
                                    Restore setup
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleForkWinningSetup(experiment)}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                  >
                                    Branch from here
                                  </button>
                                </div>
                              </div>
                            );
                          }) : (
                            <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              Save a few strong simulations here so you can compare and restore them later.
                            </div>
                          )}
                        </div>
                      </div>
      </div>
    </>
  );

  const replayAdvancedContent = (
    <>
      <ReplayDecisionSupportSection
        winnerCausalReport={winnerCausalReport}
        experimentPerformance={experimentPerformance}
        selectedComparisonExperimentId={selectedComparisonExperimentId}
        winningExperimentId={winningExperiment?.experiment.id}
        actionBusy={actionBusy}
        formatCredits={formatCredits}
        formatRelativeTimeFromIso={formatRelativeTimeFromIso}
        getExperimentDisplayLabel={getExperimentDisplayLabel}
        getExperimentTags={getExperimentTags}
        onCompareExperiment={handleCompareExperiment}
        onPromotePreset={handlePromoteExperimentPreset}
        onPromoteSteering={handlePromoteExperimentSteering}
        onPromoteFull={handlePromoteExperimentFull}
      />

      <ReplayGovernanceSection
        rollbackSuggestion={rollbackSuggestion}
        promotionAudit={promotionAudit}
        promotionHistory={selectedStudioState.promotionHistory || []}
        roleHeatmap={roleHeatmap}
        workflowBenchmarks={workflowBenchmarks}
        actionBusy={actionBusy}
        formatCredits={formatCredits}
        formatTokenCount={formatTokenCount}
        formatRelativeTimeFromIso={formatRelativeTimeFromIso}
        formatDirectivePhaseScope={formatDirectivePhaseScope}
        getPromotionModeLabel={getPromotionModeLabel}
        getPromotionModeTone={getPromotionModeTone}
        getStatusTone={getStatusTone}
        onRestorePreset={handlePromoteExperimentPreset}
        onRestoreSteering={handlePromoteExperimentSteering}
        onRestoreFull={handlePromoteExperimentFull}
        onReviewRestoreTarget={handleCompareExperiment}
        onSelectBenchmarkWorkflow={setSelectedAutomationId}
      />
    </>
  );

  return (
    <div className="min-h-screen bg-navy-950 text-white">
      {notice && (
        <div className="pointer-events-none fixed inset-x-3 top-3 z-50 flex justify-center">
          <div
            className={`pointer-events-auto max-w-md rounded-2xl border px-4 py-3 shadow-[0_18px_50px_rgba(2,6,23,0.42)] backdrop-blur-md ${
              notice.tone === 'success'
                ? 'border-green-500/20 bg-green-500/12 text-green-100'
                : 'border-red-500/20 bg-red-500/12 text-red-100'
            }`}
          >
            <p className="text-sm font-medium">{notice.message}</p>
          </div>
        </div>
      )}

      <header className="sticky top-0 z-30 border-b border-navy-800/80 bg-gradient-to-r from-navy-950/96 via-navy-900/92 to-navy-950/96 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center justify-between gap-2 lg:hidden">
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="flex items-center gap-2 rounded-xl border border-navy-700 bg-navy-900/72 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-600/50 hover:text-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Dashboard
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={showStudioGuide ? dismissStudioGuide : openStudioGuide}
                className="flex items-center gap-2 rounded-xl border border-navy-700 bg-navy-900/72 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-600/50 hover:text-white"
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span className="max-[390px]:hidden">{showStudioGuide ? 'Hide guide' : 'Guide'}</span>
              </button>
              <button
                type="button"
                onClick={() => void loadData()}
                className="flex items-center gap-2 rounded-xl border border-navy-700 bg-navy-900/72 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-600/50 hover:text-white"
                aria-label="Refresh Agent Studio"
              >
                <RotateCcw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
          <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="hidden items-center gap-2 rounded-xl border border-navy-700 bg-navy-900/72 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-600/50 hover:text-white lg:flex"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Dashboard
            </button>
            <ViolemaLogo className="h-9 w-[11.5rem] sm:h-10 sm:w-[12.5rem]" />
            <div className="min-w-0 max-w-full sm:max-w-[34rem]">
              <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Separate control room</p>
              <h1 className="text-lg font-semibold tracking-[-0.02em] text-white">Agent Studio</h1>
              <p className="mt-1 max-w-[24rem] text-sm leading-relaxed text-slate-400 sm:max-w-none">Configure worker strategy, inspect performance, and keep the schedule view clean.</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 lg:flex">
            <button
              type="button"
              onClick={showStudioGuide ? dismissStudioGuide : openStudioGuide}
              className="flex items-center gap-2 rounded-xl border border-navy-700 bg-navy-900/72 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-600/50 hover:text-white"
            >
              <BookOpen className="h-3.5 w-3.5" />
              {showStudioGuide ? 'Hide guide' : 'How to use Studio'}
            </button>
            <button
              type="button"
              onClick={() => void loadData()}
              className="flex items-center gap-2 rounded-xl border border-navy-700 bg-navy-900/72 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-600/50 hover:text-white"
            >
              <RotateCcw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-[1.6rem] border border-violet-500/15 bg-gradient-to-br from-violet-500/10 via-navy-900/84 to-navy-950/94 p-4">
            <p className="text-[10px] uppercase tracking-[0.2em] text-violet-300/80">Workflows watched</p>
            <p className="mt-2 text-3xl font-semibold text-white">{studioStats.workflowCount}</p>
            <p className="mt-2 text-sm text-slate-400">Dedicated space for orchestration, not hidden inside the schedule rail.</p>
          </div>
          <div className="rounded-[1.6rem] border border-cyan-500/15 bg-gradient-to-br from-cyan-500/10 via-navy-900/84 to-navy-950/94 p-4">
            <p className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">Run success rate</p>
            <p className="mt-2 text-3xl font-semibold text-white">{Math.round(studioStats.runSuccessRate * 100)}%</p>
            <p className="mt-2 text-sm text-slate-400">Tracks whether the current worker policy is improving reliability or just adding noise.</p>
          </div>
          <div className="rounded-[1.6rem] border border-amber-500/15 bg-gradient-to-br from-amber-500/10 via-navy-900/84 to-navy-950/94 p-4">
            <p className="text-[10px] uppercase tracking-[0.2em] text-amber-300/80">Average run cost</p>
            <p className="mt-2 text-3xl font-semibold text-white">{studioStats.avgRunCredits ? `${formatCredits(studioStats.avgRunCredits)} cr` : '—'}</p>
            <p className="mt-2 text-sm text-slate-400">Use custom policy only when the extra spend is justified by real outcome quality.</p>
          </div>
          <div className="rounded-[1.6rem] border border-emerald-500/15 bg-gradient-to-br from-emerald-500/10 via-navy-900/84 to-navy-950/94 p-4">
            <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Elastic lane usage</p>
            <p className="mt-2 text-3xl font-semibold text-white">{Math.round(studioStats.elasticCoverage * 100)}%</p>
            <p className="mt-2 text-sm text-slate-400">Keeps extra lanes available without treating expensive reasoning as the default path.</p>
          </div>
        </div>

        <div className="mt-6 space-y-6">
          <aside className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-[19rem,minmax(0,1fr)] xl:items-start">
              <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/52 to-navy-950/84 p-4">
              <div className="flex items-center gap-2">
                <Workflow className="h-4 w-4 text-violet-300" />
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Workflow selector</p>
                  <h2 className="text-sm font-semibold text-white">Connected schedules</h2>
                </div>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">Choose a workflow here, then tune or inspect the agent system without losing the scheduling context.</p>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {loading ? (
                  <div className="rounded-[1.6rem] border border-dashed border-navy-700/70 bg-navy-950/35 px-4 py-8 text-sm text-slate-500 xl:col-span-3">
                    Loading workflows…
                  </div>
                ) : rows.length === 0 ? (
                  <div className="rounded-[1.6rem] border border-dashed border-navy-700/70 bg-navy-950/35 px-4 py-8 xl:col-span-3">
                    <p className="text-sm font-medium text-white">No scheduled workflows yet</p>
                    <p className="mt-2 text-sm text-slate-500">
                      Agent Studio becomes useful once it has one real workflow to inspect. Start with a scheduled workflow, then come back here to tune the system behind it.
                    </p>
                    <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                      <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Dashboard vs Studio</p>
                      <p className="mt-2 text-sm leading-relaxed text-slate-300">
                        Use Dashboard to create and schedule the workflow. Use Agent Studio after that to inspect runs, compare policies,
                        and improve the multi-agent system behind the workflow.
                      </p>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => navigate('/dashboard?panel=schedules&create=workflow')}
                        className="rounded-xl border border-violet-500/24 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-100 transition-colors hover:bg-violet-500/14"
                      >
                        Create test workflow
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate('/dashboard?panel=schedules')}
                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                      >
                        Open dashboard
                      </button>
                    </div>
                  </div>
                ) : rows.map((row) => {
                  const isSelected = row.automation.id === selectedRow?.automation.id;
                  const latestStatus = row.latestRun?.status || row.automation.last_run_status || row.automation.status;
                  return (
                    <button
                      key={row.automation.id}
                      type="button"
                      onClick={() => setSelectedAutomationId(row.automation.id)}
                      className={`w-full rounded-[1.4rem] border p-4 text-left transition-all ${
                        isSelected
                          ? 'border-violet-500/30 bg-gradient-to-br from-violet-500/12 to-cyan-500/6 shadow-[0_18px_44px_rgba(76,29,149,0.18)]'
                          : 'border-navy-700/80 bg-navy-950/45 hover:border-violet-500/18 hover:bg-navy-900/60'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-white">{row.automation.name}</p>
                          <p className="mt-1 text-xs text-slate-500">{row.automation.schedule}</p>
                        </div>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${getStatusTone(latestStatus)}`}>
                          {latestStatus}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-400">
                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                          {row.automation.authoring_mode === 'describe' ? 'Describe it' : 'Guided steps'}
                        </span>
                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                          {row.workflowSteps.length} steps
                        </span>
                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                          {Math.round(row.successRate * 100)}% success
                        </span>
                      </div>
                      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
                        {formatSummaryPreview(readString(row.latestRun?.metadata?.summary), 120)
                          || row.automation.description
                          || 'No recent summary yet.'}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <section className="mx-auto w-full max-w-[1180px] space-y-6">
            {selectedRow ? (
              <>
                <div className="rounded-[2.25rem] border border-navy-800/80 bg-gradient-to-br from-navy-900/84 via-navy-900/56 to-navy-950/92 p-6 md:p-7">
                  <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <p className="text-[10px] uppercase tracking-[0.22em] text-violet-300/80">Agent system for this workflow</p>
                      <h2 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-white md:text-4xl">{selectedRow.automation.name}</h2>
                      <p className="mt-3 max-w-4xl text-base leading-relaxed text-slate-400">
                        Agent Studio is now split into Live, Optimize, and Replay so users can understand the system instantly: what is running, what to change, and what actually worked.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                      <button
                        type="button"
                        onClick={() => navigate(`/dashboard?automation=${selectedRow.automation.id}&panel=schedules`)}
                        className="flex items-center gap-2 rounded-xl border border-violet-500/20 bg-violet-500/8 px-4 py-2.5 text-sm font-medium text-violet-200 transition-colors hover:bg-violet-500/12"
                      >
                        Open schedule
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate(`/dashboard?automation=${selectedRow.automation.id}&panel=schedules&edit=workflow`)}
                        className="flex items-center gap-2 rounded-xl border border-navy-700 bg-navy-900/72 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-cyan-500/30 hover:text-white"
                      >
                        Edit workflow
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-4">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Workflow shape</p>
                      <p className="mt-1 text-sm font-medium text-white">{selectedRow.automation.authoring_mode === 'describe' ? 'Natural-language brief' : 'Guided steps'}</p>
                      <p className="mt-1 text-[11px] text-slate-500">{selectedRow.workflowSteps.length} workflow blocks</p>
                    </div>
                    <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-4">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Current policy</p>
                      <p className="mt-1 text-sm font-medium text-white">
                        {activePresetId === 'custom_live' ? 'Custom live policy' : POLICY_PRESETS.find((preset) => preset.id === activePresetId)?.label || 'System recommended'}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">{getReviewPolicyLabel(selectedPolicy.reviewPolicy)}</p>
                    </div>
                    <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-4">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Next run</p>
                      <p className="mt-1 text-sm font-medium text-white">{formatAutomationRunTime(selectedRow.automation.next_run_at)}</p>
                      <p className="mt-1 text-[11px] text-slate-500">{liveRun?.status === 'running' ? 'Live run in progress' : 'Standing by'}</p>
                    </div>
                    <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-4">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Result health</p>
                      <p className="mt-1 text-sm font-medium text-white">{Math.round(selectedRow.successRate * 100)}% success</p>
                      <p className="mt-1 text-[11px] text-slate-500">{selectedRow.averageCredits ? `${formatCredits(selectedRow.averageCredits)} cr average spend` : 'No completed runs yet'}</p>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {[
                      { id: 'live' as const, label: 'Live', summary: 'Operate the current system', icon: Activity },
                      { id: 'replay' as const, label: 'Replay', summary: 'Explain the last run', icon: LineChart },
                      { id: 'optimize' as const, label: 'Optimize', summary: 'Test and release changes', icon: Target },
                    ].map((room) => {
                      const Icon = room.icon;
                      const active = activeRoom === room.id;
                      return (
                        <button
                          key={room.id}
                          type="button"
                          onClick={() => setActiveRoom(room.id)}
                          className={`rounded-2xl border px-4 py-2.5 text-left transition-all ${
                            active
                              ? 'border-violet-500/28 bg-violet-500/10 shadow-[0_18px_48px_rgba(76,29,149,0.16)]'
                              : 'border-navy-700/70 bg-navy-950/36 hover:border-violet-500/20 hover:bg-navy-900/55'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <Icon className={`h-4 w-4 ${active ? 'text-violet-200' : 'text-slate-400'}`} />
                            <p className="text-sm font-medium text-white">{room.label}</p>
                          </div>
                          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{room.summary}</p>
                        </button>
                      );
                    })}
                  </div>

                  <ControlLoopHandoffStrip
                    currentRoom={controlLoopHandoff.currentRoom}
                    nextRoom={controlLoopHandoff.nextRoom}
                    title={controlLoopHandoff.title}
                    body={controlLoopHandoff.body}
                    signals={controlLoopHandoff.signals}
                    actionLabel={controlLoopHandoff.actionLabel}
                    onAction={controlLoopHandoff.onAction}
                    secondaryLabel={controlLoopHandoff.secondaryLabel}
                    onSecondary={controlLoopHandoff.onSecondary}
                  />

                  <div className="mt-5">
                    <DimaStudioAdvisorPanel
                      activeRoom={activeRoom}
                      row={selectedRow}
                      workflow={selectedRow.automation}
                      selectedRun={selectedCohortRun || liveRun || selectedRow.latestRun}
                      operationalContext={operationalContext}
                    />
                  </div>

                  {showStudioGuide ? (
                    <div className="mt-5">
                      <AgentStudioGuidePanel
                        onDismiss={dismissStudioGuide}
                        onOpenDashboard={() => navigate(`/dashboard?automation=${selectedRow.automation.id}&panel=schedules`)}
                        onEditWorkflow={() => navigate(`/dashboard?automation=${selectedRow.automation.id}&panel=schedules&edit=workflow`)}
                      />
                    </div>
                  ) : null}

                </div>

                {activeRoom === 'live' ? (
                  <LiveRoom
                    advanced={(
                      <>
                        <LiveAdvancedSupportSection
                          livePulse={{
                            status: liveRun?.status || selectedRow.automation.last_run_status || 'Standby',
                            modelSource: getTaskModelSource(selectedRow.task, liveRun) || 'Server default',
                            currentCost: typeof liveRun?.actualCredits === 'number' ? `${formatCredits(liveRun.actualCredits)} cr` : '—',
                            elapsed: liveRun
                              ? formatCompactDuration(Number.isNaN(Date.parse(liveRun.startedAt || '')) ? undefined : Math.max(0, Date.now() - Date.parse(liveRun.startedAt || '')))
                              : '—',
                            summary: selectedTopology.summary || 'The manager is routing work based on workflow complexity, tool count, and review pressure.',
                          }}
                          scenario={{
                            scenarioLabel: liveScenarioTelemetry.scenarioLabel,
                            presetLabel: liveScenarioTelemetry.presetLabel,
                            complexity: liveScenarioTelemetry.complexity,
                            directedRoleCount: liveScenarioTelemetry.directedRoles.length,
                            workflowStepCount: liveScenarioTelemetry.workflowStepCount,
                            estimatedToolCalls: liveScenarioTelemetry.estimatedToolCalls,
                            matchedSavedExperiment: Boolean(liveScenarioTelemetry.matchedSavedExperiment),
                          }}
                          selectedRun={selectedCohortRun ? {
                            label: getRunExperimentAttribution(selectedCohortRun).experimentNotes || `${getRunExperimentAttribution(selectedCohortRun).scenarioLabel} · ${getRunExperimentAttribution(selectedCohortRun).previewPresetLabel}`,
                            timestamp: formatAutomationRunTime(selectedCohortRun.finishedAt || selectedCohortRun.startedAt),
                            status: selectedCohortRun.status,
                            credits: selectedCohortRun.actualCredits ? `${formatCredits(selectedCohortRun.actualCredits)} cr` : '—',
                            duration: formatCompactDuration(Number.isNaN(Date.parse(selectedCohortRun.startedAt || '')) || Number.isNaN(Date.parse(selectedCohortRun.finishedAt || '')) ? undefined : Math.max(0, Date.parse(selectedCohortRun.finishedAt || '') - Date.parse(selectedCohortRun.startedAt || ''))),
                            trendLabel: getTrendMetricLabel(trendMetric),
                            trendValue: String(formatTrendMetricValue(selectedCohortRun, trendMetric)),
                            matchedPlans: selectedRunMatchedPlans.map((entry) => ({
                              id: entry.plan.id,
                              name: entry.plan.name,
                              score: entry.score,
                              active: selectedPlanId === entry.plan.id,
                              onSelect: () => {
                                setSelectedPlanId(entry.plan.id);
                                if (entry.summary?.familyRootId) setSelectedPlanFamilyRootId(entry.summary.familyRootId);
                              },
                            })),
                            deltas: selectedRunDelta ? [
                              {
                                id: 'credits',
                                label: `vs ${selectedRunDelta.label}`,
                                value: `${formatSignedDelta(Math.round(selectedRunDelta.creditDelta))} cr`,
                                tone: selectedRunDelta.creditDelta <= 0 ? 'positive' : 'warning',
                              },
                              {
                                id: 'duration',
                                label: 'Duration',
                                value: `${formatSignedDelta(Math.round(selectedRunDelta.durationDelta / 1000))}s`,
                                tone: selectedRunDelta.durationDelta <= 0 ? 'positive' : 'warning',
                              },
                              {
                                id: 'outcome',
                                label: 'Outcome',
                                value: `${formatSignedDelta(selectedRunDelta.successDelta)} pts`,
                                tone: selectedRunDelta.successDelta >= 0 ? 'positive' : 'warning',
                              },
                            ] : undefined,
                            onOpenReplay: () => setActiveRoom('replay'),
                            onSyncComparison: () => {
                              const attribution = getRunExperimentAttribution(selectedCohortRun);
                              if (attribution.experimentId) setSelectedComparisonExperimentId(attribution.experimentId);
                            },
                          } : undefined}
                          phaseRows={phaseDirectiveMatrix.map((row) => ({
                            phase: formatDirectivePhaseScope([row.phase]),
                            directiveCount: row.directives.length,
                            directives: row.directives.map((directive) => `${directive.role} · ${directive.mode}`),
                          }))}
                          getStatusTone={getStatusTone}
                        />

                        <LiveHandoffsSection items={liveActivationTrail} getStatusTone={getStatusTone} />

                        <LiveOptimizationLoopSection
                          items={optimizationRecommendations}
                          actionBusy={actionBusy}
                          onApplyRecommendation={applyRecommendationAction}
                        />
                      </>
                    )}
                    showAdvanced={showLiveAdvanced}
                    onToggleAdvanced={() => setShowLiveAdvanced((current) => !current)}
                  >
                    <div className="space-y-6">
                      <LiveSystemMapSection
                        liveStatusLabel={liveRun?.status === 'running' ? 'Live now' : 'Preview from latest run'}
                        topology={selectedTopology}
                        workerMapNodes={workerMapNodes}
                        selectedWorkerRole={selectedWorkerDetail.worker?.role}
                        roleDirectives={selectedStudioState.roleDirectives}
                        optimizationBiasLabel={selectedMath.estimatedBands}
                        activeCoreCount={selectedTopology.workers.filter((worker) => worker.laneType === 'core' && worker.status === 'active').length}
                        activeElasticCount={selectedTopology.workers.filter((worker) => worker.laneType === 'elastic' && worker.status === 'active').length}
                        onSelectWorker={setSelectedWorkerRole}
                        truncateText={truncateText}
                        formatDirectivePhaseShort={formatDirectivePhaseShort}
                      />

                      <LiveOperatorBriefSection
                        context={operationalContext}
                        loading={operationalContextLoading}
                        referenceLabel={liveContextReferenceLabel}
                        onOpenRun={handleOpenContextRun}
                        onFocusPhase={handleFocusLiveContextPhase}
                        formatDirectivePhaseScope={formatDirectivePhaseScope}
                        formatRelativeTimeFromIso={formatRelativeTimeFromIso}
                        getStatusTone={getStatusTone}
                      />

                      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] xl:items-start">
                      <LiveSupportRailSection
                        workers={selectedTopology.workers}
                        nextExperimentQueue={nextExperimentQueue}
                        onExecuteNextExperiment={handleExecuteNextExperiment}
                        onViewExperimentEvidence={(phase) => {
                          setSelectedDirectivePhase(phase);
                          setActiveRoom('replay');
                        }}
                        onSavePlan={(namePrefix) => handleSaveOperatingPlan({ namePrefix })}
                      />

                      <div className="space-y-6">
                        <LiveNodeInspectorSection
                          worker={selectedWorkerDetail.worker}
                          performance={selectedWorkerDetail.performance}
                          recentSteps={selectedWorkerDetail.recentSteps}
                          selectedRoleDirective={selectedRoleDirective}
                          actionBusy={actionBusy}
                          workerPhaseActivity={workerPhaseActivity}
                          selectedDirectivePhase={selectedDirectivePhase}
                          directivePhaseOptions={DIRECTIVE_PHASE_OPTIONS}
                          phaseEvidence={phaseEvidence}
                          onClearRoleDirective={handleClearRoleDirective}
                          onSelectDirectivePhase={setSelectedDirectivePhase}
                          onFocusPhase={(phase) => {
                            setSelectedDirectivePhase(phase);
                            setSelectedWorkerRole(getPreferredRoleForPhase(phase));
                          }}
                          onRouteCheaper={handleRouteCheaper}
                          onIncreaseReview={handleIncreaseReview}
                          onPromoteLane={handlePromoteLane}
                          formatCredits={formatCredits}
                          formatTokenCount={formatTokenCount}
                          formatRelativeTimeFromIso={formatRelativeTimeFromIso}
                          formatDirectivePhaseScope={formatDirectivePhaseScope}
                        />
                      </div>
                    </div>
                    </div>
                  </LiveRoom>
                ) : null}

                {activeRoom === 'optimize' ? (
                  <OptimizeRoom
                    advanced={optimizeAdvancedContent}
                    showAdvanced={showOptimizeAdvanced}
                    onToggleAdvanced={() => setShowOptimizeAdvanced((current) => !current)}
                  >
                    <div className="grid gap-4">
                      <OptimizeCurrentReleaseSection scorecard={optimizationScorecard} />
                    </div>

                    <OptimizeScenarioSimulatorSection
                      scenarios={SCENARIO_PRESETS}
                      selectedScenarioId={selectedScenario.id}
                      selectedScenarioLabel={selectedScenario.label}
                      selectedScenarioSummary={selectedScenario.summary}
                      previewPresetLabel={previewPreset.label}
                      scenarioSnapshot={scenarioComparisons[0]?.simulated || selectedMath}
                      actionBusy={actionBusy}
                      experimentSaveBusy={experimentSaveBusy}
                      onSelectScenario={setSelectedScenarioId}
                      onSaveExperiment={handleSaveExperiment}
                    />

                    <OptimizeReleaseCandidateSection
                      candidatePresets={scenarioComparisons}
                      decisionBrief={(
                        <OptimizeDecisionBriefSection
                          scenarioLabel={selectedScenario.label}
                          previewPresetLabel={previewPreset.label}
                          activePresetLabel={activePresetLabel}
                          changedPolicyCount={policyDiffRows.length}
                          decision={optimizeDecisionBrief}
                          formatSignedDelta={formatSignedDelta}
                        />
                      )}
                      selectedPresetId={previewPreset.id}
                      previewPresetLabel={previewPreset.label}
                      activePresetLabel={activePresetLabel}
                      previewScenarioComparison={previewScenarioComparison}
                      currentIndices={{
                        spend: currentSpendIndex,
                        assurance: currentAssuranceIndex,
                        fit: currentFitIndex,
                      }}
                      policyDiffRows={policyDiffRows}
                      policyRadarMetrics={policyRadarMetrics}
                      frontierPoints={frontierPoints}
                      actionBusy={actionBusy}
                      onSelectPreset={setPreviewPresetId}
                      onApplyPreviewPreset={() => void patchExecutionPolicy(previewPreset.policy)}
                      formatSignedDelta={formatSignedDelta}
                      buildRadarPolygon={buildRadarPolygon}
                    />
                  </OptimizeRoom>
                ) : null}

                {activeRoom === 'replay' ? (
                  <ReplayRoom
                    advanced={replayAdvancedContent}
                    showAdvanced={showReplayAdvanced}
                    onToggleAdvanced={() => setShowReplayAdvanced((current) => !current)}
                  >
                    <div className="grid gap-6">
                      <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                        <div className="flex items-center gap-2">
                          <LineChart className="h-4 w-4 text-cyan-300" />
                          <div>
                            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Run replay</p>
                            <h3 className="text-sm font-semibold text-white">Step-by-step timeline</h3>
                          </div>
                        </div>
                        <div className="mt-4 space-y-4">
                          {replayTimeline.length > 0 ? replayTimeline.map((step, index) => (
                            <div key={step.stepId} className="flex gap-3">
                              <div className="flex flex-col items-center">
                                <div className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold ${step.status === 'failed' ? 'border-red-500/25 bg-red-500/10 text-red-200' : step.status === 'succeeded' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200' : 'border-violet-500/25 bg-violet-500/10 text-violet-200'}`}>
                                  {step.marker}
                                </div>
                                {index < replayTimeline.length - 1 ? <div className="mt-2 h-full w-px bg-gradient-to-b from-violet-400/50 to-transparent" /> : null}
                              </div>
                              <div className="flex-1 rounded-2xl border border-navy-700/70 bg-navy-950/45 p-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium text-white">{step.title}</p>
                                    <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">{step.assignedRole} · {step.kind}</p>
                                  </div>
                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${getStatusTone(step.status)}`}>
                                    {step.status}
                                  </span>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-400">
                                  {step.modelTier ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{step.modelTier}</span> : null}
                                  {step.modelSource ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{step.modelSource}</span> : null}
                                  {step.directiveMode ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-cyan-200">{`${step.directiveMode === 'cheaper' ? 'Cheaper bias' : step.directiveMode === 'review' ? 'Review bias' : 'Promoted lane'}${step.directivePhases?.length ? ` · ${formatDirectivePhaseScope(step.directivePhases)}` : ''}`}</span> : null}
                                  {typeof step.actualCredits === 'number' ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{formatCredits(step.actualCredits)} cr</span> : null}
                                  {step.toolCalls ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{step.toolCalls} tools</span> : null}
                                  {step.tokenUsage?.totalTokens ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{step.tokens}</span> : null}
                                  {step.duration && step.duration !== '—' ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{step.duration}</span> : null}
                                </div>
                                {step.summary || step.error ? <p className="mt-3 text-sm leading-relaxed text-slate-400">{step.error || formatSummaryPreview(step.summary, 180)}</p> : null}
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              No step history yet. Once the workflow runs, replay will show the full handoff story instead of burying it in the schedule drawer.
                            </div>
                          )}
                        </div>
                      </div>

                      {recommendedReplayFix ? (
                        <ReplayDecisionBriefSection
                          brief={replayDecisionBrief}
                          onSimulateFix={() => {
                            setPhaseSimulation({ phase: recommendedReplayFix.phase, mode: recommendedReplayFix.mode });
                            setActiveRoom('optimize');
                          }}
                          onOpenInLive={() => {
                            setSelectedDirectivePhase(recommendedReplayFix.phase);
                            setSelectedWorkerRole(getPreferredRoleForPhase(recommendedReplayFix.phase));
                            setActiveRoom('live');
                          }}
                        />
                      ) : null}

                      <div className="space-y-6">
                        <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                          <div className="flex items-center gap-2">
                            <Layers3 className="h-4 w-4 text-cyan-300" />
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Run comparison lab</p>
                              <h3 className="text-sm font-semibold text-white">
                                {runComparison?.comparisonMode === 'exact_run_pair'
                                  ? 'Selected run vs matched replay slice'
                                  : runComparison?.comparisonMode === 'saved_experiment'
                                    ? 'Latest run vs saved experiment'
                                    : 'Latest vs previous operating setup'}
                              </h3>
                            </div>
                          </div>
                          {runComparison ? (
                            <div className="mt-4 space-y-3">
                              <div className="grid gap-3 sm:grid-cols-2">
                                <div className="rounded-2xl border border-cyan-500/18 bg-cyan-500/8 p-4">
                                  <p className="text-[10px] uppercase tracking-[0.16em] text-cyan-100/80">Latest run</p>
                                  <p className="mt-2 text-sm font-semibold text-white">{runComparison.current.presetLabel}</p>
                                  <p className="mt-1 text-[12px] text-slate-300">{runComparison.current.scenarioLabel}</p>
                                  {runComparison.current.experimentLabel ? <p className="mt-1 text-[11px] text-cyan-200/85">{runComparison.current.experimentLabel}</p> : null}
                                  {runComparisonMatchedPlans.current.length > 0 ? (
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      {runComparisonMatchedPlans.current.map((entry) => (
                                        <button
                                          key={`compare-current-plan-${entry.plan.id}`}
                                          type="button"
                                          onClick={() => {
                                            setSelectedPlanId(entry.plan.id);
                                            if (entry.summary?.familyRootId) setSelectedPlanFamilyRootId(entry.summary.familyRootId);
                                          }}
                                          className="ui-pill px-2 py-0.5 normal-case tracking-normal text-cyan-200"
                                        >
                                          {entry.plan.name} <span className="ml-1 text-[10px] text-cyan-100/70">({entry.score})</span>
                                        </button>
                                      ))}
                                    </div>
                                  ) : null}
                                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-200">
                                    <span className={`rounded-full border px-2 py-0.5 font-medium ${getStatusTone(runComparison.current.status)}`}>{runComparison.current.status}</span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-200">{formatCredits(runComparison.current.credits)} cr</span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-200">{formatCompactDuration(runComparison.current.durationMs)}</span>
                                  </div>
                                </div>
                                <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                                  <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{runComparison?.comparisonMode === 'exact_run_pair' ? 'Matched run' : runComparison?.comparisonMode === 'saved_experiment' ? 'Saved experiment' : 'Previous run'}</p>
                                  {runComparison.previous ? (<>
                                    <p className="mt-2 text-sm font-semibold text-white">{runComparison.previous.presetLabel}</p>
                                    <p className="mt-1 text-[12px] text-slate-400">{runComparison.previous.scenarioLabel}</p>
                                    <p className="mt-1 text-[11px] text-cyan-200/75">{runComparison.previous.experimentLabel || runComparison.comparisonLabel}</p>
                                    {runComparisonMatchedPlans.previous.length > 0 ? (
                                      <div className="mt-2 flex flex-wrap gap-2">
                                        {runComparisonMatchedPlans.previous.map((entry) => (
                                          <button
                                            key={`compare-previous-plan-${entry.plan.id}`}
                                            type="button"
                                            onClick={() => {
                                              setSelectedPlanId(entry.plan.id);
                                              if (entry.summary?.familyRootId) setSelectedPlanFamilyRootId(entry.summary.familyRootId);
                                            }}
                                            className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300"
                                          >
                                            {entry.plan.name} <span className="ml-1 text-[10px] text-slate-500">({entry.score})</span>
                                          </button>
                                        ))}
                                      </div>
                                    ) : null}
                                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                      <span className={`rounded-full border px-2 py-0.5 font-medium ${getStatusTone(runComparison.previous.status)}`}>{runComparison.previous.status}</span>
                                      <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{formatCredits(runComparison.previous.credits)} cr</span>
                                      <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{formatCompactDuration(runComparison.previous.durationMs)}</span>
                                    </div>
                                  </>) : <p className="mt-2 text-sm text-slate-500">No comparable run yet for this setup.</p>}
                                </div>
                              </div>
                              {runComparison.previous ? (
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                                    <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Credit delta</p>
                                    <p className={`mt-1 text-lg font-semibold ${runComparison.current.credits <= runComparison.previous.credits ? 'text-emerald-300' : 'text-amber-300'}`}>
                                      {formatSignedDelta(Math.round(runComparison.current.credits - runComparison.previous.credits))} cr
                                    </p>
                                  </div>
                                  <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                                    <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Duration delta</p>
                                    <p className={`mt-1 text-lg font-semibold ${((runComparison.current.durationMs || 0) <= (runComparison.previous.durationMs || 0)) ? 'text-emerald-300' : 'text-amber-300'}`}>
                                      {formatSignedDelta(Math.round(((runComparison.current.durationMs || 0) - (runComparison.previous.durationMs || 0)) / 1000))}s
                                    </p>
                                  </div>
                                </div>
                              ) : null}
                              {replayDualRunDiff && replayComparedRun ? (
                                <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                                  <div className="flex items-start justify-between gap-3">
                                    <div>
                                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Dual-run phase diff</p>
                                      <p className="mt-1 text-sm font-medium text-white">
                                        {selectedReplayPhase === 'all'
                                          ? 'Comparing the dominant phase across both runs'
                                          : `${formatDirectivePhaseScope([selectedReplayPhase])} across both runs`}
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => replayBaseRun ? handleOpenRunPairInReplay(replayBaseRun, replayComparedRun, selectedReplayPhase === 'all' ? selectedReplayPhaseDetail?.phase : selectedReplayPhase, 'dual-run diff') : undefined}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                    >
                                      Open before / after
                                    </button>
                                  </div>
                                  <div className="mt-3 grid gap-3 sm:grid-cols-3 text-[11px]">
                                    <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-3">
                                      <p className="text-slate-500">Credits vs pair</p>
                                      <p className={`mt-1 text-white ${replayDualRunDiff.creditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(Math.round(replayDualRunDiff.creditsDelta))} cr</p>
                                    </div>
                                    <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-3">
                                      <p className="text-slate-500">Duration vs pair</p>
                                      <p className={`mt-1 text-white ${replayDualRunDiff.durationDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(Math.round(replayDualRunDiff.durationDelta / 1000))}s</p>
                                    </div>
                                    <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-3">
                                      <p className="text-slate-500">Tokens vs pair</p>
                                      <p className={`mt-1 text-white ${replayDualRunDiff.tokensDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(Math.round(replayDualRunDiff.tokensDelta))}</p>
                                    </div>
                                  </div>
                                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-cyan-200">
                                      current {replayDualRunDiff.statusPair.current}
                                    </span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                      compared {replayDualRunDiff.statusPair.compared}
                                    </span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                      {replayDualRunDiff.comparedRunLabel}
                                    </span>
                                    {replayDualRunDiff.directiveShift ? (
                                      <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-violet-200">
                                        {replayDualRunDiff.directiveShift.compared || 'baseline'} {'->'} {replayDualRunDiff.directiveShift.current || 'baseline'}
                                      </span>
                                    ) : null}
                                  </div>
                                  {replayPhaseComparisonRows.length > 0 ? (
                                    <div className="mt-3 grid gap-2">
                                      {replayPhaseComparisonRows.map((row) => (
                                        <button
                                          key={`phase-compare-${row.phase}`}
                                          type="button"
                                          onClick={() => setSelectedReplayPhase(row.phase)}
                                          className={`grid w-full gap-2 rounded-xl border px-3 py-3 text-left text-[11px] transition sm:grid-cols-[minmax(0,1fr),repeat(4,minmax(0,auto))] ${selectedReplayPhase === row.phase ? 'border-cyan-500/24 bg-cyan-500/8' : 'border-navy-700/70 bg-navy-950/45 hover:border-cyan-500/16'}`}
                                        >
                                          <div>
                                            <p className="font-medium text-white">{formatDirectivePhaseScope([row.phase])}</p>
                                            <p className="mt-1 text-slate-500">{row.currentStatus} vs {row.comparedStatus}</p>
                                          </div>
                                          <div>
                                            <p className="text-slate-500">Credits</p>
                                            <p className={`mt-1 ${row.creditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(Math.round(row.creditsDelta))} cr</p>
                                          </div>
                                          <div>
                                            <p className="text-slate-500">Duration</p>
                                            <p className={`mt-1 ${row.durationDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>{formatSignedDelta(Math.round(row.durationDelta / 1000))}s</p>
                                          </div>
                                          <div>
                                            <p className="text-slate-500">Current</p>
                                            <p className="mt-1 text-white">{row.currentCredits ? `${formatCredits(row.currentCredits)} cr` : '—'}</p>
                                          </div>
                                          <div>
                                            <p className="text-slate-500">Compared</p>
                                            <p className="mt-1 text-white">{row.comparedCredits ? `${formatCredits(row.comparedCredits)} cr` : '—'}</p>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <div className="rounded-2xl border border-cyan-500/16 bg-cyan-500/8 p-3">
                                  <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-100/80">Current setup cohort</p>
                                  <p className="mt-1 text-sm font-medium text-white">{currentCohortPerformance?.label || 'No cohort yet'}</p>
                                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-200">
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-200">{currentCohortPerformance?.stats.count || 0} runs</span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-200">{Math.round((currentCohortPerformance?.stats.successRate || 0) * 100)}% success</span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-200">{currentCohortPerformance?.stats.averageCredits ? `${formatCredits(currentCohortPerformance.stats.averageCredits)} cr avg` : '—'}</span>
                                  </div>
                                </div>
                                <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-3">
                                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Compared experiment cohort</p>
                                  <p className="mt-1 text-sm font-medium text-white">{selectedExperimentPerformance ? (selectedExperimentPerformance.experiment.notes || `${getScenarioLabelFromId(selectedExperimentPerformance.experiment.scenarioId)} · ${getPresetLabelFromId(selectedExperimentPerformance.experiment.previewPresetId)}`) : 'No saved experiment selected'}</p>
                                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{selectedExperimentPerformance?.stats.count || 0} runs</span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{Math.round((selectedExperimentPerformance?.stats.successRate || 0) * 100)}% success</span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{selectedExperimentPerformance?.stats.averageCredits ? `${formatCredits(selectedExperimentPerformance.stats.averageCredits)} cr avg` : '—'}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-4 rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              Run this workflow twice and this lab will compare the operating setups side by side.
                            </div>
                          )}
                        </div>

                        <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                          <div className="flex items-center gap-2">
                            <Activity className="h-4 w-4 text-emerald-300" />
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Evidence freshness</p>
                              <h3 className="text-sm font-semibold text-white">How strong the current learning loop is</h3>
                            </div>
                          </div>
                          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Completed runs</p>
                              <p className="mt-1 text-lg font-semibold text-white">{evidenceFreshness.runCount}</p>
                            </div>
                            <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Observed experiments</p>
                              <p className="mt-1 text-lg font-semibold text-white">{evidenceFreshness.experimentCount}</p>
                            </div>
                            <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Latest run</p>
                              <p className="mt-1 text-sm font-medium text-white">{formatRelativeTimeFromIso(evidenceFreshness.latestRunAt)}</p>
                            </div>
                            <div className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Learning strength</p>
                              <p className={`mt-1 text-sm font-medium ${evidenceFreshness.tone === 'fresh' ? 'text-emerald-200' : evidenceFreshness.tone === 'warm' ? 'text-cyan-200' : 'text-amber-200'}`}>
                                {evidenceFreshness.confidence}
                              </p>
                            </div>
                          </div>
                          <p className="mt-3 text-sm leading-relaxed text-slate-400">
                            Fresh, repeated evidence is what makes promotion decisions trustworthy. Thin or stale evidence means simulate more before locking policy.
                          </p>
                        </div>

                        <OperationalContextMapSection
                          context={operationalContext}
                          loading={operationalContextLoading}
                          onOpenRun={handleOpenContextRun}
                          onFocusPhase={(phase) => setSelectedReplayPhase(phase)}
                          formatCredits={formatCredits}
                          formatCompactDuration={formatCompactDuration}
                          formatRelativeTimeFromIso={formatRelativeTimeFromIso}
                          formatDirectivePhaseScope={formatDirectivePhaseScope}
                          formatSignedDelta={formatSignedDelta}
                          getStatusTone={getStatusTone}
                        />

                        {replayComparedRun ? (
                          <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                            <div className="flex items-center gap-2">
                              <Layers3 className="h-4 w-4 text-cyan-300" />
                              <div>
                                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Dual-run replay canvas</p>
                                <h3 className="text-sm font-semibold text-white">Compare both runs phase by phase</h3>
                              </div>
                            </div>
                            <p className="mt-2 text-sm leading-relaxed text-slate-400">
                              This is the cleanest exact comparison surface in Studio. Same phases, same metrics, and a direct before/after jump when you want to inspect the pair in full replay.
                            </p>
                            <div className="mt-4 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => replayBaseRun ? handleOpenRunPairInReplay(replayBaseRun, replayComparedRun, selectedReplayPhase === 'all' ? selectedReplayPhaseDetail?.phase : selectedReplayPhase, 'dual-run replay canvas') : undefined}
                                className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                              >
                                Open paired replay
                              </button>
                              {runComparison?.previous ? (
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                  {runComparison.current.presetLabel} vs {runComparison.previous.presetLabel}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-4 grid gap-4 xl:grid-cols-2 xl:items-start">
                              <div className="rounded-2xl border border-cyan-500/16 bg-cyan-500/8 p-4">
                                <p className="text-[10px] uppercase tracking-[0.16em] text-cyan-100/80">Current run</p>
                                <div className="mt-3 space-y-2">
                                  {replayPhaseOverlay.map((phase) => (
                                    <button
                                      key={`dual-current-${phase.phase}`}
                                      type="button"
                                      onClick={() => setSelectedReplayPhase(phase.phase)}
                                      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-3 text-left ${selectedReplayPhase === phase.phase ? 'border-cyan-500/24 bg-cyan-500/10' : 'border-white/6 bg-white/[0.03]'}`}
                                    >
                                      <div>
                                        <p className="text-sm font-medium text-white">{formatDirectivePhaseScope([phase.phase])}</p>
                                        <p className="mt-1 text-[11px] text-slate-400">{phase.primaryRole} · {phase.directiveMode ? getDirectiveModeLabel(phase.directiveMode) : 'Baseline'}</p>
                                      </div>
                                      <div className="text-right text-[11px] text-slate-300">
                                        <p>{phase.credits ? `${formatCredits(phase.credits)} cr` : '—'}</p>
                                        <p className="mt-1">{formatCompactDuration(phase.durationMs)}</p>
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                                <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Compared run</p>
                                <div className="mt-3 space-y-2">
                                  {replayComparedPhaseOverlay.map((phase) => (
                                    <button
                                      key={`dual-compared-${phase.phase}`}
                                      type="button"
                                      onClick={() => setSelectedReplayPhase(phase.phase)}
                                      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-3 text-left ${selectedReplayPhase === phase.phase ? 'border-cyan-500/24 bg-cyan-500/8' : 'border-white/6 bg-white/[0.03]'}`}
                                    >
                                      <div>
                                        <p className="text-sm font-medium text-white">{formatDirectivePhaseScope([phase.phase])}</p>
                                        <p className="mt-1 text-[11px] text-slate-400">{phase.primaryRole} · {phase.directiveMode ? getDirectiveModeLabel(phase.directiveMode) : 'Baseline'}</p>
                                      </div>
                                      <div className="text-right text-[11px] text-slate-300">
                                        <p>{phase.credits ? `${formatCredits(phase.credits)} cr` : '—'}</p>
                                        <p className="mt-1">{formatCompactDuration(phase.durationMs)}</p>
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                            {pairedReplayPhaseTimeline.length > 0 ? (
                              <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Paired replay timeline</p>
                                <p className="mt-1 text-sm text-white">A causal phase-by-phase view of the current run and its paired comparison.</p>
                                <div className="mt-4 space-y-3">
                                  {pairedReplayPhaseTimeline.map((row) => (
                                    <div key={`paired-phase-${row.phase}`} className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                          <p className="text-sm font-medium text-white">{formatDirectivePhaseScope([row.phase])}</p>
                                          <p className="mt-1 text-[11px] text-slate-500">
                                            {row.currentSteps.length} current steps · {row.comparedSteps.length} compared steps
                                          </p>
                                        </div>
                                      <div className="flex flex-wrap gap-2 text-[10px] text-slate-300">
                                        <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${row.currentCredits <= row.comparedCredits ? 'text-emerald-200' : 'text-amber-200'}`}>
                                          {formatSignedDelta(Math.round(row.currentCredits - row.comparedCredits))} cr
                                        </span>
                                        <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${row.currentDurationMs <= row.comparedDurationMs ? 'text-emerald-200' : 'text-amber-200'}`}>
                                          {formatSignedDelta(Math.round((row.currentDurationMs - row.comparedDurationMs) / 1000))}s
                                        </span>
                                      </div>
                                    </div>
                                    <p className="mt-2 text-sm leading-relaxed text-slate-400">{row.verdict}</p>
                                    <div className="mt-4 grid gap-3 xl:grid-cols-2 xl:items-start">
                                        <div className="rounded-2xl border border-cyan-500/16 bg-cyan-500/8 p-4">
                                          <p className="text-[10px] uppercase tracking-[0.16em] text-cyan-100/80">Current run</p>
                                          <div className="mt-3 space-y-2">
                                            {row.currentSteps.length > 0 ? row.currentSteps.map((step) => (
                                              <div key={`phase-current-${row.phase}-${step.stepId}`} className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                                                <div className="flex items-start justify-between gap-3">
                                                  <div>
                                                    <p className="text-sm font-medium text-white">{step.title}</p>
                                                    <p className="mt-1 text-[11px] text-slate-500">{step.assignedRole}</p>
                                                  </div>
                                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${getStatusTone(step.status)}`}>{step.status}</span>
                                                </div>
                                              </div>
                                            )) : <p className="text-sm text-slate-500">Phase not used in the current run.</p>}
                                          </div>
                                        </div>
                                        <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                                          <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Compared run</p>
                                          <div className="mt-3 space-y-2">
                                            {row.comparedSteps.length > 0 ? row.comparedSteps.map((step) => (
                                              <div key={`phase-compared-${row.phase}-${step.stepId}`} className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                                                <div className="flex items-start justify-between gap-3">
                                                  <div>
                                                    <p className="text-sm font-medium text-white">{step.title}</p>
                                                    <p className="mt-1 text-[11px] text-slate-500">{step.assignedRole}</p>
                                                  </div>
                                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${getStatusTone(step.status)}`}>{step.status}</span>
                                                </div>
                                              </div>
                                            )) : <p className="text-sm text-slate-500">Phase not used in the compared run.</p>}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                          <div className="flex items-center gap-2">
                            <Workflow className="h-4 w-4 text-violet-300" />
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Phase overlay</p>
                              <h3 className="text-sm font-semibold text-white">Where this exact run spent time, credits, and confidence</h3>
                            </div>
                          </div>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => setSelectedReplayPhase('all')}
                              className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${selectedReplayPhase === 'all' ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                            >
                              All phases
                            </button>
                            {replayPhaseOverlay.map((phase) => (
                              <button
                                key={`replay-phase-${phase.phase}`}
                                type="button"
                                onClick={() => setSelectedReplayPhase(phase.phase)}
                                className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${selectedReplayPhase === phase.phase ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                              >
                                {formatDirectivePhaseScope([phase.phase])}
                              </button>
                            ))}
                          </div>
                          <div className="mt-4 space-y-3">
                            {replayPhaseOverlay.length > 0 ? replayPhaseOverlay.map((phase) => (
                              <button
                                key={`overlay-${phase.phase}`}
                                type="button"
                                onClick={() => setSelectedReplayPhase(phase.phase)}
                                className={`block w-full rounded-2xl border p-4 text-left ${selectedReplayPhaseDetail?.phase === phase.phase ? 'border-cyan-500/22 bg-cyan-500/8' : 'border-navy-700/70 bg-navy-950/45'}`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-white">{formatDirectivePhaseScope([phase.phase])}</p>
                                    <p className="mt-1 text-[11px] text-slate-500">{phase.primaryRole} · {phase.steps.length} steps · {phase.modelSource || 'Server default'}</p>
                                  </div>
                                  <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${phase.failed ? 'text-red-200' : phase.succeeded ? 'text-emerald-200' : 'text-slate-300'}`}>
                                    {phase.failed ? 'Failure surfaced' : phase.succeeded ? 'Landed cleanly' : 'No result'}
                                  </span>
                                </div>
                                <div className="mt-3">
                                  <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                    <span>Credit weight</span>
                                    <span>{phase.credits ? `${formatCredits(phase.credits)} cr` : '—'}</span>
                                  </div>
                                  <div className="mt-1 h-2 rounded-full bg-navy-950/70">
                                    <div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-cyan-300" style={{ width: phase.costWidth }} />
                                  </div>
                                </div>
                              </button>
                            )) : (
                              <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                                Replay overlay appears once the selected run has phase-level step evidence.
                              </div>
                            )}
                          </div>
                          {selectedReplayPhaseDetail ? (
                            <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Selected phase</p>
                              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                                <div>
                                  <p className="text-[11px] text-slate-500">Credits</p>
                                  <p className="mt-1 text-sm font-medium text-white">{selectedReplayPhaseDetail.credits ? `${formatCredits(selectedReplayPhaseDetail.credits)} cr` : '—'}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-slate-500">Duration</p>
                                  <p className="mt-1 text-sm font-medium text-white">{formatCompactDuration(selectedReplayPhaseDetail.durationMs)}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-slate-500">Tokens</p>
                                  <p className="mt-1 text-sm font-medium text-white">{formatTokenCount(selectedReplayPhaseDetail.tokens)}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-slate-500">Directive</p>
                                  <p className="mt-1 text-sm font-medium text-white">{selectedReplayPhaseDetail.directiveMode ? getDirectiveModeLabel(selectedReplayPhaseDetail.directiveMode) : 'Baseline'}</p>
                                </div>
                              </div>
                              {selectedReplayPhaseDelta ? (
                                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                                  <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                    <p className="text-[11px] text-slate-500">Credits vs baseline</p>
                                    <p className={`mt-1 text-sm font-medium ${selectedReplayPhaseDelta.creditsDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                      {formatSignedDelta(Math.round(selectedReplayPhaseDelta.creditsDelta))} cr
                                    </p>
                                  </div>
                                  <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                    <p className="text-[11px] text-slate-500">Duration vs baseline</p>
                                    <p className={`mt-1 text-sm font-medium ${selectedReplayPhaseDelta.durationDelta <= 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                                      {formatSignedDelta(Math.round(selectedReplayPhaseDelta.durationDelta / 1000))}s
                                    </p>
                                  </div>
                                  <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                    <p className="text-[11px] text-slate-500">Expected success</p>
                                    <p className="mt-1 text-sm font-medium text-white">
                                      {selectedReplayPhaseDelta.expectedSuccess}% · {selectedReplayPhaseDelta.actualStatus}
                                    </p>
                                  </div>
                                </div>
                              ) : null}
                              <div className="mt-4 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedDirectivePhase(selectedReplayPhaseDetail.phase);
                                    setSelectedWorkerRole(getPreferredRoleForPhase(selectedReplayPhaseDetail.phase));
                                    setActiveRoom('live');
                                  }}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Open phase in node inspector
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPhaseSimulation({
                                    phase: selectedReplayPhaseDetail.phase,
                                    mode: selectedReplayPhaseDelta && selectedReplayPhaseDelta.creditsDelta > 10 ? 'cheaper' : selectedReplayPhaseDelta?.actualStatus === 'failed' ? 'review' : 'promote',
                                  })}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                >
                                  Simulate best fix
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handleApplyPhaseLearning(
                                    selectedReplayPhaseDetail.phase,
                                    selectedReplayPhaseDelta && selectedReplayPhaseDelta.creditsDelta > 10 ? 'cheaper' : selectedReplayPhaseDelta?.actualStatus === 'failed' ? 'review' : 'promote'
                                  )}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300 disabled:opacity-60"
                                >
                                  Apply best fix
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleBranchPhasePlan(
                                    selectedReplayPhaseDetail.phase,
                                    selectedReplayPhaseDelta && selectedReplayPhaseDelta.creditsDelta > 10 ? 'cheaper' : selectedReplayPhaseDelta?.actualStatus === 'failed' ? 'review' : 'promote'
                                  )}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Branch into plan
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>

                        <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                          <div className="flex items-center gap-2">
                            <BarChart3 className="h-4 w-4 text-cyan-300" />
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Cohort trend</p>
                              <h3 className="text-sm font-semibold text-white">Current vs selected experiment over time</h3>
                            </div>
                          </div>
                          <div className="mt-4 flex flex-wrap gap-2">
                            {(['credits', 'duration', 'success'] as TrendMetric[]).map((metric) => (
                              <button
                                key={metric}
                                type="button"
                                onClick={() => setTrendMetric(metric)}
                                className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${trendMetric === metric ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                              >
                                {getTrendMetricLabel(metric)}
                              </button>
                            ))}
                          </div>
                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            {cohortTrendSeries.map((series) => (
                              <div key={series.label} className="rounded-2xl border border-navy-700/70 bg-navy-950/45 p-3">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-sm font-medium text-white">{series.label}</p>
                                  <span className="text-[11px] text-slate-500">{series.chart?.points.length || 0} runs</span>
                                </div>
                                {series.chart ? (() => {
                                  const chart = series.chart;
                                  const highlightedPoint = focusedCohortRun ? chart.points.find((point) => point.run.id === focusedCohortRun.id) : undefined;
                                  return (
                                    <div className="mt-3">
                                      <div className="relative overflow-hidden rounded-2xl border border-white/6 bg-white/[0.02] px-2 py-3">
                                        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} className="h-32 w-full">
                                          {[0.25, 0.5, 0.75].map((ratio) => {
                                            const y = chart.height - 14 - (ratio * (chart.height - 28));
                                            return <line key={`${series.label}-${ratio}`} x1="18" x2={chart.width - 18} y1={y} y2={y} stroke={series.tone.grid} strokeDasharray="4 6" />;
                                          })}
                                          <path d={chart.areaPath} fill={series.tone.fill} />
                                          <path d={chart.linePath} fill="none" stroke={series.tone.stroke} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                                          {chart.points.map((point) => (
                                            <circle
                                              key={`${series.label}-${point.run.id}`}
                                              cx={point.x}
                                              cy={point.y}
                                              r={selectedCohortRunId === point.run.id ? 6 : 4}
                                              fill={series.tone.dot}
                                              stroke={selectedCohortRunId === point.run.id ? '#e2e8f0' : 'rgba(15,23,42,0.9)'}
                                              strokeWidth={selectedCohortRunId === point.run.id ? 2 : 1.5}
                                              onMouseEnter={() => setHoveredCohortRunId(point.run.id)}
                                              onMouseLeave={() => setHoveredCohortRunId('')}
                                            />
                                          ))}
                                        </svg>
                                        {highlightedPoint ? (
                                          <div
                                            className="pointer-events-none absolute z-10 w-56 -translate-x-1/2 -translate-y-full rounded-2xl border border-white/10 bg-navy-950/96 px-3 py-3 text-left shadow-[0_16px_40px_rgba(2,6,23,0.42)]"
                                            style={{
                                              left: `${(highlightedPoint.x / chart.width) * 100}%`,
                                              top: `${Math.max(12, ((highlightedPoint.y / chart.height) * 100) - 4)}%`,
                                            }}
                                          >
                                            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{highlightedPoint.label}</p>
                                            <p className="mt-1 text-sm font-medium text-white">{highlightedPoint.metricLabel}</p>
                                            <p className="mt-1 text-[11px] text-slate-400">{series.label}</p>
                                            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                              <span className={`rounded-full border px-2 py-0.5 font-medium ${getStatusTone(highlightedPoint.run.status)}`}>
                                                {highlightedPoint.run.status}
                                              </span>
                                              <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                                {highlightedPoint.run.actualCredits ? `${formatCredits(highlightedPoint.run.actualCredits)} cr` : '—'}
                                              </span>
                                              <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                                {formatAutomationRunTime(highlightedPoint.run.finishedAt || highlightedPoint.run.startedAt)}
                                              </span>
                                            </div>
                                            <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                                              {getRunExperimentAttribution(highlightedPoint.run).experimentNotes || `${getRunExperimentAttribution(highlightedPoint.run).scenarioLabel} · ${getRunExperimentAttribution(highlightedPoint.run).previewPresetLabel}`}
                                            </p>
                                          </div>
                                        ) : null}
                                        <div className="mt-3 flex items-start justify-between gap-2">
                                          {chart.points.map((point) => (
                                            <button
                                              key={`${series.label}-${point.run.id}-label`}
                                              type="button"
                                              onClick={() => handleOpenRunInReplay(point.run, `${series.label.toLowerCase()} cohort`)}
                                              onMouseEnter={() => setHoveredCohortRunId(point.run.id)}
                                              onMouseLeave={() => setHoveredCohortRunId('')}
                                              className={`flex flex-1 min-w-0 flex-col rounded-xl border px-2 py-2 text-left transition-colors ${
                                                selectedCohortRunId === point.run.id
                                                  ? 'border-cyan-500/30 bg-cyan-500/10'
                                                  : 'border-transparent bg-white/[0.02] hover:border-white/8'
                                              }`}
                                            >
                                              <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{point.label}</span>
                                              <span className="mt-1 text-[11px] text-white">{point.metricLabel}</span>
                                            </button>
                                          ))}
                                        </div>
                                      </div>
                                      <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                                        <span>Older → newer evidence on the left-to-right curve</span>
                                        <span>{getTrendMetricLabel(trendMetric)} window</span>
                                      </div>
                                      {focusedCohortRun ? (
                                        <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.03] px-3 py-2 text-[11px] text-slate-300">
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="font-medium text-white">
                                              Focus run: {getRunExperimentAttribution(focusedCohortRun).experimentNotes || `${getRunExperimentAttribution(focusedCohortRun).scenarioLabel} · ${getRunExperimentAttribution(focusedCohortRun).previewPresetLabel}`}
                                            </span>
                                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${getStatusTone(focusedCohortRun.status)}`}>
                                              {focusedCohortRun.status}
                                            </span>
                                          </div>
                                          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-400">
                                            <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{formatTrendMetricValue(focusedCohortRun, trendMetric)}</span>
                                            <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{focusedCohortRun.actualCredits ? `${formatCredits(focusedCohortRun.actualCredits)} cr` : '—'}</span>
                                            <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{formatAutomationRunTime(focusedCohortRun.finishedAt || focusedCohortRun.startedAt)}</span>
                                          </div>
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })() : (
                                  <div className="mt-3 rounded-xl border border-dashed border-navy-700/70 bg-navy-950/35 p-3 text-sm text-slate-500">
                                    No run cohort yet for this setup.
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                          <div className="flex items-center gap-2">
                            <Clock3 className="h-4 w-4 text-amber-300" />
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Experiment history</p>
                              <h3 className="text-sm font-semibold text-white">Recent cost and outcome trend</h3>
                            </div>
                          </div>
                          {selectedRunTrend.length > 0 ? (
                            <>
                              <div className="mt-4 flex h-36 items-end gap-2">
                                {selectedRunTrend.map((run) => (
                                  <div key={run.id} className="flex min-w-0 flex-1 flex-col items-center">
                                    <div className="flex h-28 w-full items-end">
                                      <div className={`w-full rounded-t-2xl border border-white/8 bg-gradient-to-t ${run.status === 'failed' ? 'from-red-500/20 to-red-400/65' : run.status === 'succeeded' ? 'from-emerald-500/18 to-cyan-400/70' : 'from-violet-500/16 to-violet-400/65'}`} style={{ height: run.height }} />
                                    </div>
                                    <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-slate-500">{run.label}</p>
                                    <p className="mt-1 text-[11px] text-white">{run.credits ? `${formatCredits(run.credits)} cr` : '—'}</p>
                                    <p className="text-[10px] text-slate-500">{run.duration}</p>
                                  </div>
                                ))}
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-400">
                                {selectedRunTrend.map((run) => (
                                  <span key={`${run.id}-pill`} className={`rounded-full border px-2 py-0.5 font-medium ${run.statusTone}`}>
                                    {run.label}: {run.status}
                                  </span>
                                ))}
                              </div>
                            </>
                          ) : (
                            <div className="mt-4 rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              No completed runs yet. Once this workflow runs, the trend will show whether the policy is buying real outcomes or just extra spend.
                            </div>
                          )}
                        </div>

                        <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                          <div className="flex items-center gap-2">
                            <Flame className="h-4 w-4 text-violet-300" />
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Replay findings</p>
                              <h3 className="text-sm font-semibold text-white">What this run teaches</h3>
                            </div>
                          </div>
                          <div className="mt-4 space-y-3">
                            {replayInsights.map((item) => (
                              <div key={item.title} className={`rounded-2xl border p-4 ${item.tone}`}>
                                <p className="text-sm font-medium text-white">{item.title}</p>
                                <p className="mt-2 text-sm leading-relaxed text-slate-200/90">{item.body}</p>
                              </div>
                            ))}
                            {replayWeakSpot ? (
                              <div className="rounded-2xl border border-cyan-500/16 bg-cyan-500/8 p-4">
                                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Weak spot spotlight</p>
                                <p className="mt-2 text-sm font-medium text-white">{replayWeakSpot.title}</p>
                                <p className="mt-2 text-sm leading-relaxed text-slate-300">{replayWeakSpot.body}</p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPhaseSimulation({ phase: replayWeakSpot.phase, mode: replayWeakSpot.recommendedMode });
                                      setActiveRoom('optimize');
                                    }}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                  >
                                    Simulate fix
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedDirectivePhase(replayWeakSpot.phase);
                                      setSelectedWorkerRole(getPreferredRoleForPhase(replayWeakSpot.phase));
                                      setActiveRoom('live');
                                    }}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                  >
                                    Open in node inspector
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-6">
                      <div className="space-y-6">
                        <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                          {autoPromotionSuggestion ? (
                            <div className={`mb-4 rounded-2xl border p-4 ${autoPromotionSuggestion.tone === 'quality' ? 'border-emerald-500/18 bg-emerald-500/8' : 'border-cyan-500/18 bg-cyan-500/8'}`}>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Automatic promotion suggestion</p>
                              <p className="mt-2 text-sm font-medium text-white">{autoPromotionSuggestion.title}</p>
                              <p className="mt-2 text-sm leading-relaxed text-slate-300">{autoPromotionSuggestion.body}</p>
                              <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">gate {autoPromotionSuggestion.threshold}% confidence</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{evidenceFreshness.confidence}</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{winningExperiment?.stats.count || 0} observed runs</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{gateProfileLearning.windowLabel}</span>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handlePromoteExperimentFull(autoPromotionSuggestion.experiment)}
                                  className="rounded-xl border border-emerald-500/24 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-emerald-500/14 disabled:opacity-60"
                                >
                                  Promote recommended winner
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleCompareExperiment(autoPromotionSuggestion.experiment)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Review in comparison lab
                                </button>
                              </div>
                            </div>
                          ) : null}
                          <div className="mb-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Promotion gate</p>
                                <p className="mt-1 text-sm font-medium text-white">Only auto-suggest winners when confidence clears this threshold</p>
                              </div>
                              <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{autoPromotionThreshold}%</span>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                              <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{activeGateScope.scope}</span>
                              <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{activeGateScope.label}</span>
                            </div>
                            {recommendedGateProfile ? (
                              <div className="mt-3 rounded-xl border border-cyan-500/16 bg-cyan-500/8 px-3 py-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Recommended profile</p>
                                    <p className="mt-1 text-sm font-medium text-white">{recommendedGateProfile.label}</p>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={actionBusy}
                                    onClick={() => handleApplyGateProfile(recommendedGateProfile.id)}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200 disabled:opacity-60"
                                  >
                                    Apply recommendation
                                  </button>
                                </div>
                                <p className="mt-2 text-[11px] leading-relaxed text-slate-300">{recommendedGateProfile.summary}</p>
                                {gateProfileLearning.items.length > 0 ? (
                                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                      Best by {gateProfileLearning.scopeLabel}
                                    </span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                      {gateProfileLearning.items[0].stats.count} observed runs
                                    </span>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                      {gateProfileLearning.items[0].confidence}% confidence
                                    </span>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                            {gateProfileLearning.items.length > 0 ? (
                              <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Gate profile learning</p>
                                    <p className="mt-1 text-sm font-medium text-white">What works best for this workflow class</p>
                                  </div>
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                    {gateProfileLearning.scopeLabel}
                                  </span>
                                </div>
                                <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-slate-300">
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                    {gateProfileLearning.windowLabel}
                                  </span>
                                  {(['recent', 'deep', 'all'] as GateLearningWindow[]).map((windowId) => (
                                    <button
                                      key={`gate-window-${windowId}`}
                                      type="button"
                                      onClick={() => setGateLearningWindow(windowId)}
                                      className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${
                                        gateLearningWindow === windowId
                                          ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200'
                                          : 'text-slate-300'
                                      }`}
                                    >
                                      {windowId === 'recent' ? 'Recent' : windowId === 'deep' ? 'Deep' : 'All'}
                                    </button>
                                  ))}
                                </div>
                                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                                  {gateProfileLearning.items.map((item) => (
                                    <div key={`gate-learning-${item.profile.id}`} className={`rounded-xl border px-3 py-3 ${recommendedGateProfile?.id === item.profile.id ? 'border-cyan-500/24 bg-cyan-500/8' : 'border-white/6 bg-white/[0.02]'}`}>
                                      <div className="flex items-start justify-between gap-3">
                                        <div>
                                          <p className="text-sm font-medium text-white">{item.profile.label}</p>
                                          <p className="mt-1 text-[11px] text-slate-500">{item.workflowCount} workflows · {item.stats.count} runs</p>
                                        </div>
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">score {item.score}</span>
                                      </div>
                                      <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{Math.round(item.stats.successRate * 100)}% success</span>
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{item.stats.averageCredits ? `${formatCredits(item.stats.averageCredits)} cr avg` : '—'}</span>
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{item.confidence}% confidence</span>
                                      </div>
                                      <div className="mt-3 flex flex-wrap gap-2">
                                        <button
                                          type="button"
                                          disabled={actionBusy}
                                          onClick={() => handleApplyGateProfile(item.profile.id)}
                                          className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200 disabled:opacity-60"
                                        >
                                          Apply {item.profile.label}
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Window comparison</p>
                                  <p className="mt-1 text-sm font-medium text-white">How stable the gate recommendation is</p>
                                </div>
                                <span className={`ui-pill px-2 py-0.5 normal-case tracking-normal ${
                                  gateLearningComparison.stability === 'Stable'
                                    ? 'text-emerald-200'
                                    : gateLearningComparison.stability === 'Mixed'
                                      ? 'text-cyan-200'
                                      : 'text-amber-200'
                                }`}>
                                  {gateLearningComparison.stability}
                                </span>
                              </div>
                              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                                {gateLearningComparison.windows.map((window) => (
                                  <div key={`window-compare-${window.window}`} className={`rounded-xl border px-3 py-3 ${gateLearningWindow === window.window ? 'border-cyan-500/24 bg-cyan-500/8' : 'border-white/6 bg-white/[0.02]'}`}>
                                    <div className="flex items-center justify-between gap-3">
                                      <p className="text-sm font-medium text-white">{window.label}</p>
                                      <button
                                        type="button"
                                        onClick={() => setGateLearningWindow(window.window)}
                                        className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                      >
                                        Use
                                      </button>
                                    </div>
                                    <p className="mt-2 text-sm text-white">{window.leader?.profile.label || 'No leader yet'}</p>
                                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                      <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{window.leader?.stats.count || 0} runs</span>
                                      <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{window.leader ? `${Math.round(window.leader.stats.successRate * 100)}% success` : '—'}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div className="mt-3 grid gap-3 sm:grid-cols-3">
                              {PROMOTION_GATE_PROFILES.map((profile) => (
                                <button
                                  key={profile.id}
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handleApplyGateProfile(profile.id)}
                                  className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3 text-left transition-colors hover:border-cyan-500/18 hover:bg-white/[0.04] disabled:opacity-60"
                                >
                                  <p className="text-sm font-medium text-white">{profile.label}</p>
                                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{profile.summary}</p>
                                </button>
                              ))}
                            </div>
                            <div className="mt-3 space-y-3">
                              {[
                                { scope: 'global' as const, label: 'Global default', value: selectedStudioState.autoPromotionMinConfidence ?? 55 },
                                { scope: 'archetype' as const, label: `${selectedArchetype.label}`, value: selectedStudioState.autoPromotionArchetypeThresholds?.[selectedArchetype.id] ?? autoPromotionThreshold },
                                { scope: 'scenario' as const, label: `${selectedScenario.label}`, value: selectedStudioState.autoPromotionScenarioThresholds?.[selectedScenario.id] ?? autoPromotionThreshold },
                              ].map((scopeItem) => (
                                <div key={`gate-${scopeItem.scope}`} className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="text-[11px] font-medium text-white">{scopeItem.label}</p>
                                    <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{scopeItem.value}%</span>
                                  </div>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {[55, 70, 85].map((threshold) => (
                                      <button
                                        key={`threshold-${scopeItem.scope}-${threshold}`}
                                        type="button"
                                        disabled={actionBusy}
                                        onClick={() => handleSetScopedAutoPromotionThreshold(scopeItem.scope, threshold)}
                                        className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${scopeItem.value === threshold ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'} disabled:opacity-60`}
                                      >
                                        {threshold}% confidence
                                      </button>
                                    ))}
                                  </div>
                                  <div className="mt-3">
                                    <button
                                      type="button"
                                      disabled={actionBusy}
                                      onClick={() => handleClearScopedAutoPromotionThreshold(scopeItem.scope)}
                                      className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300 disabled:opacity-60"
                                    >
                                      Reset {scopeItem.label}
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Target className="h-4 w-4 text-emerald-300" />
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Best operating setup</p>
                              <h3 className="text-sm font-semibold text-white">What is actually winning</h3>
                            </div>
                          </div>
                          {winningExperiment ? (
                            <>
                              <p className="mt-3 text-sm font-medium text-white">{getExperimentDisplayLabel(winningExperiment.experiment)}</p>
                              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{winningExperiment.stats.count} runs</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{Math.round(winningExperiment.stats.successRate * 100)}% success</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{winningExperiment.stats.averageCredits ? `${formatCredits(winningExperiment.stats.averageCredits)} cr avg` : '—'}</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">score {winningExperiment.score}</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{winningExperiment.confidence}% confidence</span>
                                {winningExperiment.latestAt ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">seen {formatRelativeTimeFromIso(winningExperiment.latestAt)}</span> : null}
                              </div>
                              <p className="mt-3 text-sm leading-relaxed text-slate-400">This is the strongest observed setup for this workflow right now. Promote it when you want the live policy to match what is already working in practice.</p>
                              <div className="mt-4 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleCompareExperiment(winningExperiment.experiment)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Compare winner
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handlePromoteExperimentPreset(winningExperiment.experiment)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-emerald-200"
                                >
                                  Promote preset
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handlePromoteExperimentSteering(winningExperiment.experiment)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                >
                                  Promote steering
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handlePromoteExperimentFull(winningExperiment.experiment)}
                                  className="rounded-xl border border-emerald-500/24 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-emerald-500/14 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  Promote full setup
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleForkWinningSetup(winningExperiment.experiment)}
                                  className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                >
                                  Branch winner
                                </button>
                              </div>
                              {winningExperimentPhases.length > 0 ? (
                                <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                                  <div className="flex items-center justify-between gap-3">
                                    <div>
                                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Phase-level adoption</p>
                                      <p className="mt-1 text-sm font-medium text-white">Promote only the part that is winning</p>
                                    </div>
                                    <span className="text-[11px] text-slate-500">Useful when one phase is clearly better than the rest</span>
                                  </div>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {winningExperimentPhases.map((phase) => (
                                      <div key={`winning-${phase}`} className="flex flex-wrap gap-2">
                                        <button
                                          type="button"
                                          disabled={actionBusy}
                                          onClick={() => handlePromoteExperimentPhase(winningExperiment.experiment, phase)}
                                          className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200 disabled:opacity-60"
                                        >
                                          Adopt {formatDirectivePhaseScope([phase])}
                                        </button>
                                        <button
                                          type="button"
                                          disabled={actionBusy}
                                          onClick={() => handlePromoteExperimentPresetAndPhase(winningExperiment.experiment, phase)}
                                          className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-emerald-200 disabled:opacity-60"
                                        >
                                          Add preset + {formatDirectivePhaseScope([phase])}
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <div className="mt-4 rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                              Save and run a few experiments first. This card promotes the strongest observed setup once there is evidence.
                            </div>
                          )}
                        </div>

                        <div className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                          <div className="flex items-center gap-2">
                            <Workflow className="h-4 w-4 text-cyan-300" />
                            <div>
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Branch families</p>
                              <h3 className="text-sm font-semibold text-white">Which experiment lines are compounding</h3>
                            </div>
                          </div>
                          {branchFamilyComparison ? (
                            <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Branch vs branch</p>
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                {[
                                  { slot: 'left', family: selectedBranchFamily, label: 'Primary branch' },
                                  { slot: 'right', family: comparedBranchFamily, label: 'Compare against' },
                                ].map((slot) => (
                                  <div key={`branch-slot-${slot.slot}`} className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                    <p className="text-[11px] text-slate-400">{slot.label}</p>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      {branchFamilyPerformance.map((family) => (
                                        <button
                                          key={`${slot.slot}-${family.rootExperiment.id}`}
                                          type="button"
                                          onClick={() => slot.slot === 'left' ? setSelectedBranchRootId(family.rootExperiment.id) : setComparedBranchRootId(family.rootExperiment.id)}
                                          className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${
                                            slot.family?.rootExperiment.id === family.rootExperiment.id
                                              ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200'
                                              : 'text-slate-300'
                                          }`}
                                        >
                                          {getExperimentDisplayLabel(family.rootExperiment)}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                                <div className="rounded-xl border border-emerald-500/16 bg-emerald-500/8 px-3 py-3">
                                  <p className="text-[11px] text-slate-400">Leader</p>
                                  <p className="mt-1 text-sm font-medium text-white">{getExperimentDisplayLabel(branchFamilyComparison.leader.rootExperiment)}</p>
                                </div>
                                <div className="rounded-xl border border-cyan-500/16 bg-cyan-500/8 px-3 py-3">
                                  <p className="text-[11px] text-slate-400">Challenger</p>
                                  <p className="mt-1 text-sm font-medium text-white">{getExperimentDisplayLabel(branchFamilyComparison.challenger.rootExperiment)}</p>
                                </div>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{branchFamilyComparison.successDelta >= 0 ? '+' : ''}{branchFamilyComparison.successDelta} pts success</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{branchFamilyComparison.creditsDelta <= 0 ? '' : '+'}{branchFamilyComparison.creditsDelta} credits</span>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{branchFamilyComparison.confidenceDelta >= 0 ? '+' : ''}{branchFamilyComparison.confidenceDelta}% confidence</span>
                                {selectedStudioState.selectedBranchRootId || selectedStudioState.comparedBranchRootId ? (
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">Saved compare pair</span>
                                ) : null}
                              </div>
                              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                {[
                                  { label: 'Leader line', family: branchFamilyComparison.leader, chart: branchComparisonCharts?.leader, tone: 'rgba(16,185,129,0.9)', fill: 'rgba(16,185,129,0.14)' },
                                  { label: 'Challenger line', family: branchFamilyComparison.challenger, chart: branchComparisonCharts?.challenger, tone: 'rgba(34,211,238,0.95)', fill: 'rgba(34,211,238,0.12)' },
                                ].map((item) => (
                                  <div key={`branch-compare-${item.label}`} className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                    <p className="text-[11px] font-medium text-white">{item.label}</p>
                                    <p className="mt-1 text-[11px] text-slate-500">{getExperimentDisplayLabel(item.family.rootExperiment)}</p>
                                    {item.chart ? (
                                      <svg viewBox={`0 0 ${item.chart.width} ${item.chart.height}`} className="mt-3 h-28 w-full">
                                        <path d={item.chart.areaPath} fill={item.fill} />
                                        <path d={item.chart.linePath} fill="none" stroke={item.tone} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                                        {item.chart.points.map((point) => (
                                          <circle key={`branch-compare-${item.label}-${point.run.id}`} cx={point.x} cy={point.y} r="3.5" fill={item.tone} />
                                        ))}
                                      </svg>
                                    ) : (
                                      <div className="mt-3 rounded-xl border border-dashed border-white/6 bg-white/[0.02] p-3 text-[11px] text-slate-500">
                                        Not enough runs yet for this line.
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          <div className="mt-4 space-y-3">
                            {branchFamilyPerformance.length > 0 ? branchFamilyPerformance.map((family) => (
                              <div
                                key={`branch-family-${family.rootExperiment.id}`}
                                className={`rounded-2xl border p-4 transition-colors ${selectedBranchFamily?.rootExperiment.id === family.rootExperiment.id ? 'border-cyan-500/22 bg-cyan-500/8' : 'border-navy-700/70 bg-navy-950/45'}`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-white">{getExperimentDisplayLabel(family.rootExperiment)}</p>
                                    <p className="mt-1 text-[11px] text-slate-500">
                                      {family.experiments.length} branch {family.experiments.length === 1 ? 'member' : 'members'} · {family.stats.count} observed {family.stats.count === 1 ? 'run' : 'runs'}
                                    </p>
                                  </div>
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">score {family.score}</span>
                                </div>
                                <div className="mt-3 grid gap-2 sm:grid-cols-3 text-[11px]">
                                  <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                    <p className="text-slate-500">Success</p>
                                    <p className="mt-1 text-white">{Math.round(family.stats.successRate * 100)}%</p>
                                  </div>
                                  <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                    <p className="text-slate-500">Avg credits</p>
                                    <p className="mt-1 text-white">{family.stats.averageCredits ? `${formatCredits(family.stats.averageCredits)} cr` : '—'}</p>
                                  </div>
                                  <div className="rounded-xl border border-navy-700/70 bg-navy-950/55 px-3 py-2">
                                    <p className="text-slate-500">Confidence</p>
                                    <p className="mt-1 text-white">{family.confidence}%</p>
                                  </div>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                  {family.latestAt ? <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">seen {formatRelativeTimeFromIso(family.latestAt)}</span> : null}
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                    {family.confidence >= 70 ? 'Strong branch evidence' : family.confidence >= 50 ? 'Building branch evidence' : 'Thin branch evidence'}
                                  </span>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedBranchRootId(family.rootExperiment.id);
                                      handleCompareExperiment(family.rootExperiment);
                                    }}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                  >
                                    Compare branch family
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleForkWinningSetup(family.rootExperiment)}
                                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                  >
                                    Fork this line
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setSelectedBranchRootId(family.rootExperiment.id)}
                                    className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${selectedBranchFamily?.rootExperiment.id === family.rootExperiment.id ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                                  >
                                    Inspect branch replay
                                  </button>
                                </div>
                              </div>
                            )) : (
                              <div className="rounded-2xl border border-dashed border-navy-700/70 bg-navy-950/35 p-4 text-sm text-slate-500">
                                Branch families will appear once you start forking experiments and collecting a few runs against them.
                              </div>
                            )}
                          </div>
                          {selectedBranchFamily ? (
                            <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Selected branch replay</p>
                                  <p className="mt-1 text-sm font-medium text-white">{getExperimentDisplayLabel(selectedBranchFamily.rootExperiment)}</p>
                                </div>
                                <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{selectedBranchFamily.runs.length} runs in branch line</span>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300">
                                {selectedBranchFamily.experiments.slice(0, 5).map((experiment) => (
                                  <button
                                    key={`member-${experiment.id}`}
                                    type="button"
                                    onClick={() => handleCompareExperiment(experiment)}
                                    className={`ui-pill px-2 py-0.5 text-[10px] normal-case tracking-normal ${selectedComparisonExperimentId === experiment.id ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                                  >
                                    {getExperimentDisplayLabel(experiment)}
                                  </button>
                                ))}
                                {selectedBranchFamily.experiments.length > 5 ? (
                                  <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                                    +{selectedBranchFamily.experiments.length - 5} more
                                  </span>
                                ) : null}
                                {(['all', 'succeeded', 'failed'] as BranchRunFilter[]).map((filter) => (
                                  <button
                                    key={`branch-filter-${filter}`}
                                    type="button"
                                    onClick={() => setBranchRunFilter(filter)}
                                    className={`ui-pill px-2 py-0.5 text-[10px] normal-case tracking-normal ${
                                      branchRunFilter === filter ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'
                                    }`}
                                  >
                                    {filter === 'all' ? 'All runs' : filter === 'succeeded' ? 'Succeeded' : 'Failed'}
                                  </button>
                                ))}
                              </div>
                              <div className="mt-3 space-y-2">
                                {filteredBranchRuns.slice(0, 6).map((run, index) => (
                                  <button
                                    key={`branch-run-${run.id}`}
                                    type="button"
                                    onClick={() => handleOpenRunInReplay(run, 'branch replay')}
                                    className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${selectedCohortRunId === run.id ? 'border-cyan-500/30 bg-cyan-500/10' : 'border-white/6 bg-white/[0.02] hover:border-white/10'}`}
                                  >
                                    <div>
                                      <p className="text-sm font-medium text-white">Branch run {index + 1}</p>
                                      <p className="mt-1 text-[11px] text-slate-500">
                                        {getRunExperimentAttribution(run).experimentNotes || `${getRunExperimentAttribution(run).scenarioLabel} · ${getRunExperimentAttribution(run).previewPresetLabel}`}
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap items-center justify-end gap-2 text-[10px] text-slate-300">
                                      <span className={`rounded-full border px-2 py-0.5 font-medium ${getStatusTone(run.status)}`}>{run.status}</span>
                                      <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{run.actualCredits ? `${formatCredits(run.actualCredits)} cr` : '—'}</span>
                                      <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">{formatAutomationRunTime(run.finishedAt || run.startedAt)}</span>
                                    </div>
                                  </button>
                                ))}
                                {filteredBranchRuns.length === 0 ? (
                                  <div className="rounded-xl border border-dashed border-white/6 bg-white/[0.02] px-3 py-3 text-sm text-slate-500">
                                    No branch runs match this filter yet.
                                  </div>
                                ) : null}
                              </div>
                              <div className="mt-4 grid gap-3 sm:grid-cols-3 text-[11px]">
                                <div className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                  <p className="text-slate-500">Branch score</p>
                                  <p className="mt-1 text-white">{selectedBranchFamily.score}</p>
                                </div>
                                <div className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                  <p className="text-slate-500">Avg duration</p>
                                  <p className="mt-1 text-white">{formatCompactDuration(selectedBranchFamily.stats.averageDurationMs)}</p>
                                </div>
                                <div className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                  <p className="text-slate-500">Vs workflow spend</p>
                                  <p className="mt-1 text-white">
                                    {selectedRow?.averageCredits
                                      ? `${Math.round(selectedBranchFamily.stats.averageCredits - selectedRow.averageCredits)} cr`
                                      : '—'}
                                  </p>
                                </div>
                              </div>
                              {branchTrendSeries ? (
                                <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.02] px-3 py-4">
                                  <svg viewBox={`0 0 ${branchTrendSeries.width} ${branchTrendSeries.height}`} className="h-36 w-full">
                                    {[0.25, 0.5, 0.75].map((ratio) => {
                                      const y = branchTrendSeries.height - 14 - (ratio * (branchTrendSeries.height - 28));
                                      return <line key={`branch-grid-${ratio}`} x1="18" x2={branchTrendSeries.width - 18} y1={y} y2={y} stroke="rgba(148,163,184,0.12)" strokeDasharray="4 6" />;
                                    })}
                                    <path d={branchTrendSeries.areaPath} fill="rgba(34,211,238,0.12)" />
                                    <path d={branchTrendSeries.linePath} fill="none" stroke="rgba(34,211,238,0.95)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                                    {branchTrendSeries.points.map((point) => (
                                      <circle
                                        key={`branch-point-${point.run.id}`}
                                        cx={point.x}
                                        cy={point.y}
                                        r={selectedCohortRunId === point.run.id ? 6 : 4}
                                        fill="rgba(103,232,249,1)"
                                        stroke={selectedCohortRunId === point.run.id ? '#e2e8f0' : 'rgba(15,23,42,0.9)'}
                                        strokeWidth={selectedCohortRunId === point.run.id ? 2 : 1.5}
                                        onMouseEnter={() => setHoveredCohortRunId(point.run.id)}
                                        onMouseLeave={() => setHoveredCohortRunId('')}
                                        onClick={() => handleOpenRunInReplay(point.run, 'branch trend')}
                                      />
                                    ))}
                                  </svg>
                                  <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                                    <span>Longer branch evidence window</span>
                                    <span>{getTrendMetricLabel(trendMetric)} over up to 12 runs</span>
                                  </div>
                                </div>
                              ) : null}
                              <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Branch member leaderboard</p>
                                <div className="mt-3 space-y-3">
                                  {selectedBranchMemberPerformance.slice(0, 4).map((member) => (
                                    <div key={`branch-member-${member.experiment.id}`} className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-3">
                                      <div className="flex items-start justify-between gap-3">
                                        <div>
                                          <p className="text-sm font-medium text-white">{getExperimentDisplayLabel(member.experiment)}</p>
                                          <p className="mt-1 text-[11px] text-slate-500">{member.stats.count} runs · {Math.round(member.stats.successRate * 100)}% success</p>
                                        </div>
                                        <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">score {member.score}</span>
                                      </div>
                                      <div className="mt-3 flex flex-wrap gap-2">
                                        <button
                                          type="button"
                                          onClick={() => handleCompareExperiment(member.experiment)}
                                          className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                                        >
                                          Compare member
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleRestoreExperiment(member.experiment)}
                                          className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-cyan-200"
                                        >
                                          Restore member
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Branch causal report</p>
                                <div className="mt-3 space-y-3">
                                  {selectedBranchCausalReport.map((item) => (
                                    <div key={`branch-causal-${item.title}`} className={`rounded-2xl border p-4 ${item.tone}`}>
                                      <p className="text-sm font-medium text-white">{item.title}</p>
                                      <p className="mt-2 text-sm leading-relaxed text-slate-200/90">{item.body}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                    </div>

                    </div>
                  </ReplayRoom>
                ) : null}
              </>
            ) : (
              <div className="rounded-[1.8rem] border border-dashed border-navy-700/70 bg-navy-950/35 px-5 py-12 text-center">
                <p className="text-lg font-medium text-white">No workflows available</p>
                <p className="mt-2 text-sm text-slate-500">Create a scheduled workflow first, then come back here to manage the agent system behind it.</p>
                <div className="mx-auto mt-4 max-w-2xl rounded-2xl border border-white/6 bg-white/[0.03] p-4 text-left">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">When to use each surface</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">
                    Dashboard is where you author the workflow and define the schedule. Agent Studio is where you operate the workflow&apos;s
                    multi-agent system: inspect runs, understand failures, compare candidates, and improve policy over time.
                  </p>
                </div>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => navigate('/dashboard?panel=schedules&create=workflow')}
                    className="rounded-xl border border-violet-500/24 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-100 transition-colors hover:bg-violet-500/14"
                  >
                    Create test workflow
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/dashboard?panel=schedules')}
                    className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                  >
                    Open dashboard
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      <footer className="border-t border-navy-800/70 bg-navy-950/72 px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-[1440px] flex-col items-center justify-center gap-2 text-center">
          <ViolemaLogo className="h-12 w-[14rem]" />
          <p className="text-xs text-slate-600">Violema Agent Studio</p>
        </div>
      </footer>
    </div>
  );
}

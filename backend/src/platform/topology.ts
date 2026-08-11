import type {
  AgentRole,
  AutomationStepExecution,
  IntelligenceBand,
  ModelTier,
  TaskKind,
  WorkerDefinition,
  WorkerSnapshotCard,
  WorkerTopologySnapshot,
} from './types';

export const CORE_WORKERS: AgentRole[] = [
  'nexus',
  'researcher',
  'analyst',
  'operator',
  'engineer',
  'reviewer',
];

export const ELASTIC_LANES: AgentRole[] = [
  'writer',
  'scheduler',
  'messenger',
  'monitor',
];

const WORKER_DEFINITIONS: Record<AgentRole, WorkerDefinition> = {
  nexus: {
    role: 'nexus',
    label: 'Violema Manager',
    laneType: 'core',
    preferredBand: 'default',
    fallbackBands: ['hard', 'critical'],
    summary: 'Coordinates the resident team, opens elastic lanes, and keeps the workflow coherent.',
  },
  researcher: {
    role: 'researcher',
    label: 'Research Lead',
    laneType: 'core',
    preferredBand: 'default',
    fallbackBands: ['hard'],
    summary: 'Finds external evidence and current-source context.',
  },
  analyst: {
    role: 'analyst',
    label: 'Analysis Lead',
    laneType: 'core',
    preferredBand: 'hard',
    fallbackBands: ['default', 'critical'],
    summary: 'Interprets evidence, data, and tradeoffs into decisions.',
  },
  operator: {
    role: 'operator',
    label: 'Operations Lead',
    laneType: 'core',
    preferredBand: 'default',
    fallbackBands: ['micro', 'hard'],
    summary: 'Runs workflows, tools, and delivery orchestration.',
  },
  engineer: {
    role: 'engineer',
    label: 'Build Lead',
    laneType: 'core',
    preferredBand: 'hard',
    fallbackBands: ['default', 'critical'],
    summary: 'Implements and verifies technical changes.',
  },
  reviewer: {
    role: 'reviewer',
    label: 'Review Lead',
    laneType: 'core',
    preferredBand: 'critical',
    fallbackBands: ['hard'],
    summary: 'Performs final correctness and risk checks.',
  },
  writer: {
    role: 'writer',
    label: 'Elastic lane 01',
    laneType: 'elastic',
    preferredBand: 'critical',
    fallbackBands: ['hard', 'default'],
    summary: 'Frontier elastic lane for hard synthesis, review, and difficult finish work.',
  },
  scheduler: {
    role: 'scheduler',
    label: 'Elastic lane 02',
    laneType: 'elastic',
    preferredBand: 'hard',
    fallbackBands: ['default'],
    summary: 'Reasoning elastic lane for parallel planning, decomposition, and non-trivial analysis.',
  },
  messenger: {
    role: 'messenger',
    label: 'Elastic lane 03',
    laneType: 'elastic',
    preferredBand: 'micro',
    fallbackBands: ['default'],
    summary: 'Throughput elastic lane for tool-heavy runs, delivery, and operational overflow.',
  },
  monitor: {
    role: 'monitor',
    label: 'Elastic lane 04',
    laneType: 'elastic',
    preferredBand: 'micro',
    fallbackBands: ['default'],
    summary: 'Memory elastic lane for context compaction, watch conditions, and low-cost background support.',
  },
};

const MODEL_LABEL_BY_BAND: Record<IntelligenceBand, string> = {
  critical: 'Claude Opus 5 / frontier review',
  hard: 'Claude Opus 5 / deep reasoning',
  default: 'Claude Sonnet 5 / balanced reasoning',
  micro: 'GPT-4.1 mini / low-cost routing',
};

export function getWorkerDefinition(role: AgentRole): WorkerDefinition {
  return WORKER_DEFINITIONS[role];
}

export function isElasticLane(role: AgentRole) {
  return WORKER_DEFINITIONS[role].laneType === 'elastic';
}

export function normalizeIntelligenceBand(modelTier: ModelTier): IntelligenceBand {
  switch (modelTier) {
    case 'hard':
      return 'hard';
    case 'critical':
      return 'critical';
    case 'micro':
      return 'micro';
    case 'ops':
      return 'default';
    case 'default':
    default:
      return 'default';
  }
}

export function selectPrimaryWorkerRole(input: {
  taskKind: TaskKind;
  modelTier: ModelTier;
  userText: string;
}): AgentRole {
  const text = input.userText.toLowerCase();

  if (input.taskKind === 'engineering' || /bug|code|build|deploy|typescript|react|api|server/.test(text)) return 'engineer';
  if (input.taskKind === 'review' || /review|check|verify|audit/.test(text) || input.modelTier === 'critical') return 'reviewer';
  if (input.taskKind === 'analysis' || /analy[sz]e|compare|diagnos|market|metrics|funnel|investigate/.test(text)) return 'analyst';
  if (input.taskKind === 'research' || /research|find|look up|search|news|sources/.test(text)) return 'researcher';
  if (input.taskKind === 'automation' || /schedule|monitor|watch|cron|automation/.test(text)) return 'operator';
  if (input.taskKind === 'message' || /slack|email|deliver|notify|reply/.test(text)) return 'operator';
  if (input.taskKind === 'report' || /write|draft|memo|summary|report/.test(text)) return 'nexus';
  if (input.modelTier === 'ops') return 'operator';
  return 'nexus';
}

export function buildWorkerTopologySnapshot(input: {
  primaryRole: AgentRole;
  supportingRoles?: AgentRole[];
  elasticLanes?: AgentRole[];
  modelTier: ModelTier;
  complexity?: 'low' | 'medium' | 'high';
  taskKind?: TaskKind;
}): WorkerTopologySnapshot {
  const supportingRoles = [...new Set((input.supportingRoles || []).filter((role) => role !== input.primaryRole))];
  const explicitElasticLanes = [...new Set((input.elasticLanes || []).filter((role) => role !== input.primaryRole && isElasticLane(role)))];
  const elasticLanes = [...new Set([
    ...explicitElasticLanes,
    ...(input.complexity === 'high' ? ['writer', 'scheduler'] as AgentRole[] : []),
    ...((input.taskKind === 'automation' || input.taskKind === 'message') ? ['messenger'] as AgentRole[] : []),
    ...((input.complexity !== 'low' || input.taskKind === 'automation') ? ['monitor'] as AgentRole[] : []),
  ])];
  const activeRoles = [...new Set([input.primaryRole, ...supportingRoles, ...elasticLanes])];
  const bandByRole = activeRoles.reduce<Partial<Record<AgentRole, IntelligenceBand>>>((acc, role) => {
    acc[role] = getWorkerDefinition(role).preferredBand;
    return acc;
  }, {});
  const primaryBand = normalizeIntelligenceBand(input.modelTier);
  const workers: WorkerSnapshotCard[] = [...CORE_WORKERS, ...ELASTIC_LANES].map((role) => {
    const definition = getWorkerDefinition(role);
    const status = activeRoles.includes(role) ? 'active' : 'standby';
    const band = role === input.primaryRole ? primaryBand : (bandByRole[role] || definition.preferredBand);
    const assignedRole =
      role === input.primaryRole
        ? input.primaryRole
        : supportingRoles.find((candidate) => candidate === role) || (
          role === 'writer'
            ? (input.complexity === 'high' ? 'reviewer' : 'writer')
            : role === 'scheduler'
              ? (input.taskKind === 'engineering' ? 'engineer' : 'analyst')
              : role === 'messenger'
                ? 'operator'
                : role === 'monitor'
                  ? (input.taskKind === 'automation' ? 'monitor' : 'researcher')
                  : role
        );
    const reason =
      status === 'active'
        ? role === input.primaryRole
          ? 'Leading the current workflow.'
          : definition.laneType === 'core'
            ? 'Resident specialist engaged in this run.'
            : role === 'writer'
              ? 'Opened for frontier finish work and hard synthesis.'
              : role === 'scheduler'
                ? 'Opened for deeper reasoning and parallel decomposition.'
                : role === 'messenger'
                  ? 'Opened for throughput-heavy tool work and delivery.'
                  : 'Opened to compact context and support low-cost background work.'
        : 'Standing by until the manager needs more depth or parallel capacity.';

    return {
      role,
      label: definition.label,
      laneType: definition.laneType,
      assignedRole,
      band,
      modelLabel: MODEL_LABEL_BY_BAND[band],
      status,
      summary: definition.summary,
      reason,
    };
  });

  return {
    version: 'violema-10',
    primaryRole: input.primaryRole,
    primaryBand,
    coreWorkers: CORE_WORKERS,
    elasticLanes,
    activeRoles,
    bandByRole: {
      ...bandByRole,
      [input.primaryRole]: primaryBand,
    },
    workers,
    summary: 'Six resident specialists stay online. Four elastic lanes spin up only when the manager needs more reasoning depth, throughput, or tighter memory control.',
  };
}

export function applyWorkerRuntimeActivity(
  topology: WorkerTopologySnapshot,
  stepExecutions: AutomationStepExecution[],
): WorkerTopologySnapshot {
  if (stepExecutions.length === 0) return topology;

  const completedOrRunning = stepExecutions.filter((step) =>
    step.status === 'running' || step.status === 'succeeded' || step.status === 'failed'
  );

  if (completedOrRunning.length === 0) return topology;

  const currentStep = [...completedOrRunning].reverse().find((step) => step.status === 'running');
  const lastStep = [...completedOrRunning].reverse()[0];
  const engagedRoles = new Set<AgentRole>([topology.primaryRole]);
  completedOrRunning.forEach((step) => engagedRoles.add(step.assignedRole));

  const workers = topology.workers.map((worker) => {
    const relevantSteps = completedOrRunning.filter((step) => step.assignedRole === worker.assignedRole);
    const latestStep = relevantSteps[relevantSteps.length - 1];
    const isManager = worker.role === 'nexus';
    const isCurrent = currentStep?.assignedRole === worker.assignedRole;
    const isEngaged = isManager || engagedRoles.has(worker.assignedRole);

    let reason = worker.reason;
    if (isCurrent && currentStep) {
      reason = isManager && currentStep.assignedRole !== worker.assignedRole
        ? `Routing ${currentStep.assignedRole} through "${currentStep.title}".`
        : `Executing "${currentStep.title}".`;
    } else if (latestStep?.status === 'failed') {
      reason = `Blocked on "${latestStep.title}".${latestStep.error ? ` ${latestStep.error}` : ''}`.trim();
    } else if (latestStep?.status === 'succeeded') {
      reason = `Completed "${latestStep.title}" and handed work forward.`;
    } else if (isManager) {
      reason = 'Coordinating the active workflow and worker handoffs.';
    }

    return {
      ...worker,
      status: isEngaged ? 'active' : 'standby',
      reason,
    } as WorkerSnapshotCard;
  });

  const currentLabel = currentStep
    ? workers.find((worker) => worker.assignedRole === currentStep.assignedRole)?.label || currentStep.assignedRole
    : null;
  const summary = currentStep
    ? `${currentLabel} is executing "${currentStep.title}". ${engagedRoles.size} lanes are engaged in this run.`
    : lastStep?.status === 'failed'
      ? `${engagedRoles.size} lanes engaged before the run blocked on "${lastStep.title}".`
      : `${engagedRoles.size} lanes were activated across ${completedOrRunning.length} workflow steps.`;

  return {
    ...topology,
    activeRoles: workers.filter((worker) => worker.status === 'active').map((worker) => worker.role),
    workers,
    summary,
  };
}

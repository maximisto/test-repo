import fs from 'fs';
import path from 'path';
import type { ScheduledTask } from 'node-cron';
import type { AutomationExecutionPolicy, AutomationStepKind, PersistedAutomationStep } from './platform/types';
import { createInternalDemoRoutingResolver, usesInternalDemoRouting } from './platform/tenancy';
import { getBusinessContext, setBusinessContext, DEFAULT_WORKSPACE_ID } from './platform/workspace';
import {
  PLATFORM_LEARNING_BRIEF_WORKFLOW_ID,
  PLATFORM_TELEMETRY_SOURCE,
} from './platform/platformTelemetry';
import {
  ACCOUNT_LIBRARY_READ_QUERY_TYPE,
  ACCOUNT_LIBRARY_SOURCE,
  ACCOUNT_LIBRARY_WRITE_QUERY_TYPE,
  COMPETITIVE_INTELLIGENCE_SECTION,
  FOUNDER_BRIEF_SECTION,
} from './integrationGateway/accountLibrary';

export interface AutomationRoleDirective {
  mode: 'cheaper' | 'review' | 'promote';
  phases?: AutomationStepKind[];
  updatedAt: string;
}

export interface AutomationStudioExperimentRecord {
  id: string;
  scenarioId: string;
  previewPresetId: string;
  createdAt: string;
  notes?: string;
  roleDirectives?: Record<string, AutomationRoleDirective>;
}

export interface AutomationStudioState {
  selectedScenarioId?: string;
  previewPresetId?: string;
  experimentHistory?: AutomationStudioExperimentRecord[];
  roleDirectives?: Record<string, AutomationRoleDirective>;
}

export interface AutomationRecord {
  id: string;
  version?: number;
  workspaceId?: string;
  owner_user_id?: string;
  /**
   * Explicit workflow identity. Without it `inferWorkflowIdFromAutomation`
   * falls back to 'custom-workflow', which routes the automation away from the
   * supported-workflow readiness table.
   */
  workflowId?: string;
  name: string;
  description?: string;
  authoring_mode?: 'guided' | 'describe';
  workflow_prompt?: string;
  schedule: string;
  cron_expression: string;
  timezone?: string;
  actions: string[];
  steps?: PersistedAutomationStep[];
  execution_policy?: AutomationExecutionPolicy;
  studio_state?: AutomationStudioState;
  notify?: string;
  condition?: string;
  /**
   * Operator-set ceiling on what one run of this mission may cost. A run
   * whose ESTIMATE crosses it pauses and asks instead of spending; a run
   * whose actual cost crosses it carries a named warning. Absent means no
   * per-mission bound — the workspace-level affordability gate still applies.
   */
  credit_budget_per_run?: number;
  status: 'active' | 'paused';
  last_run_at?: string;
  last_run_status?: 'succeeded' | 'failed';
  consecutive_failures?: number;
  next_run_at?: string;
  created_at: string;
}

const AUTOMATIONS_FILE = path.join(process.cwd(), 'automations.json');
const scheduledTasks = new Map<string, ScheduledTask>();
const activeAutomationExecutions = new Set<string>();
const DEFAULT_AUTOMATION_TIMEZONE = process.env.DEFAULT_AUTOMATION_TIMEZONE || 'UTC';
let cronModule: typeof import('node-cron') | null = null;

function getCron() {
  if (!cronModule) {
    // Lazy-load node-cron so read-only automation imports do not keep test workers alive.
    cronModule = require('node-cron') as typeof import('node-cron');
  }
  return cronModule;
}

function shouldScheduleAutomationTasks() {
  return process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER !== '1';
}

const LEGACY_DELIVERY_TARGETS: Record<string, string> = {
  // Raise-period reroute: stored automations pointing at the old founder
  // channels are rewritten on read so demos land in #violema-demo.
  //
  // Scoped to internal and demo workspaces only — see `usesInternalDemoRouting`.
  // Applied globally, this rewrites a TENANT's delivery into our own channel,
  // which is a cross-tenant leak rather than a demo convenience.
  '#founders': '#violema-demo',
  '#all-purple-orange': '#violema-demo',
};
type AutomationSeed = Omit<
  AutomationRecord,
  'created_at' | 'last_run_at' | 'last_run_status' | 'consecutive_failures' | 'next_run_at'
>;

const CORE_AUTOMATION_SEEDS: AutomationSeed[] = [
  {
    id: 'auto_weekly_founder_update',
    // v5: the Drive step now reads Violema's own filed briefs instead of
    // scanning the founder's Drive, which `drive.file` cannot see, and the
    // brief files itself so each week opens with the delta.
    version: 6,
    // Declared so readiness enforcement uses the weekly-founder requirements
    // table instead of inferring 'custom-workflow' from the step sources.
    workflowId: 'weekly-founder-update',
    name: 'Weekly founder update',
    description: 'A source-linked operating brief that rolls up revenue, product, customer, calendar, email, market, and decision signals for founder review.',
    authoring_mode: 'guided',
    workflow_prompt: [
      'Create the weekly founder update from connected company systems.',
      'Pull revenue, delivery, customer, calendar, email, and market signals.',
      'Draft the brief with source-backed evidence and wait for human approval before delivery.',
    ].join('\n'),
    schedule: 'every monday at 9am',
    cron_expression: '0 9 * * 1',
    timezone: 'America/Chicago',
    actions: [
      'Check Stripe revenue, churn, expansion, and failed-payment signals',
      'Scan GitHub delivery progress, blockers, and unreviewed pull requests',
      'Review Linear delivery status, active work, and blockers',
      'Review founder-critical email commitments and unanswered threads',
      'Review calendar for investor, customer, and team commitments this week',
      'Review recently changed Google Drive operating documents',
      'Scan market and competitor changes since the last update',
      'Draft the weekly founder update with key decisions, risks, and next actions',
      'Deliver latest result to #violema-demo after approval',
    ],
    steps: [
      {
        id: 'step_stripe_revenue',
        kind: 'query',
        title: 'Check Stripe revenue',
        objective: 'Pull MRR movement, failed payments, churn, expansion, and customer revenue signals from Stripe.',
        inputs: { source: 'stripe', query_type: 'revenue_summary' },
      },
      {
        id: 'step_github_delivery',
        kind: 'query',
        title: 'Scan GitHub delivery',
        objective: 'Pull merged pull requests, blocked issues, stale reviews, and release risk from GitHub.',
        inputs: {
          source: 'github',
          query_type: 'delivery_risk',
          filters: { owner: 'maximisto', repo: 'violema' },
          limit: 10,
        },
      },
      {
        id: 'step_linear_delivery',
        kind: 'query',
        title: 'Review Linear delivery',
        objective: 'Pull recently updated work, active delivery status, and blockers from Linear.',
        inputs: { source: 'linear', query_type: 'delivery_status', limit: 10 },
      },
      {
        id: 'step_email_commitments',
        kind: 'query',
        title: 'Review email commitments',
        objective: 'Find founder-critical follow-ups, investor/customer commitments, and unanswered priority threads.',
        inputs: { source: 'email', query_type: 'commitments', limit: 10 },
      },
      {
        id: 'step_calendar_commitments',
        kind: 'query',
        title: 'Review calendar commitments',
        objective: 'Review upcoming meetings, deadlines, and relationship commitments for the next seven days.',
        inputs: { source: 'calendar', query_type: 'weekly_commitments', limit: 10 },
      },
      {
        // Reads the briefs Violema itself filed, not the founder's whole Drive:
        // the `drive.file` scope deliberately cannot see documents Violema did
        // not create, and scanning an entire Drive was never worth the
        // permission it demanded. What this buys instead is continuity — the
        // brief opens with what changed since the last one.
        id: 'step_brief_history',
        kind: 'query',
        title: 'Read prior founder briefs',
        objective: 'Load the briefs already filed for this account so this week reports what changed rather than restating the standing picture.',
        inputs: {
          source: ACCOUNT_LIBRARY_SOURCE,
          query_type: ACCOUNT_LIBRARY_READ_QUERY_TYPE,
          filters: { section: FOUNDER_BRIEF_SECTION },
          limit: 2,
        },
      },
      {
        id: 'step_market_scan',
        kind: 'search',
        title: 'Scan market signals',
        objective: 'Research meaningful customer, competitor, pricing, platform, and AI automation changes since the last update.',
        inputs: { use_business_context: true, query_suffix: 'competitor pricing product launch news', num_results: 6 },
      },
      {
        id: 'step_founder_brief',
        kind: 'summarize',
        title: 'Draft founder brief',
        objective: 'Synthesize a concise founder-ready brief with revenue movement, product progress, customer signals, market context, risks, decisions needed, and next actions.',
        inputs: { use_business_context: true, instruction: 'Draft the weekly founder update with source-linked evidence, clear risks, decisions, and next actions. When prior briefs are in the evidence, lead with what changed since the last one.' },
      },
      {
        // Filed whether or not the delivery is approved: what the week showed
        // is true regardless of who read it. Auxiliary severity, so a Drive
        // failure warns instead of holding back the brief.
        id: 'step_brief_record',
        kind: 'query',
        title: 'File this brief in the library',
        objective: "Append this week's founder brief to the account library so the next run can report the delta.",
        inputs: {
          source: ACCOUNT_LIBRARY_SOURCE,
          query_type: ACCOUNT_LIBRARY_WRITE_QUERY_TYPE,
          section: FOUNDER_BRIEF_SECTION,
          entry_title: 'Weekly founder brief',
        },
      },
      {
        id: 'step_slack_delivery',
        kind: 'deliver',
        title: 'Deliver to Slack',
        objective: 'Send the reviewed weekly founder update to the founder channel after approval.',
        inputs: { approval_required: true },
        deliveryTarget: { channel: 'slack', target: '#violema-demo' },
      },
    ],
    execution_policy: {
      mode: 'recommended',
      optimizationGoal: 'balanced',
      reviewPolicy: 'standard',
      maxElasticLanes: 2,
    },
    notify: '#violema-demo',
    status: 'active',
  },
  {
    id: 'auto_platform_learning_brief',
    version: 1,
    // Internal identity. Deliberately not in SUPPORTED_READINESS_WORKFLOW_IDS,
    // so readiness runs through tier 3 and the platform_telemetry source gate
    // decides whether this automation may run at all.
    workflowId: PLATFORM_LEARNING_BRIEF_WORKFLOW_ID,
    name: 'Platform learning brief',
    description: 'Violema observing itself: a weekly read of platform operating metadata — what improved, what is blocking activation, what operators keep correcting — ending in the three changes worth building next.',
    authoring_mode: 'guided',
    workflow_prompt: [
      'Read Violema\'s own operating metadata for the trailing week.',
      'Identify what improved, what is blocking activation, and what users correct most.',
      'Recommend the three highest-leverage platform changes for the coming week, each cited to a metric.',
    ].join('\n'),
    schedule: 'every friday at 4pm',
    cron_expression: '0 16 * * 5',
    timezone: 'UTC',
    actions: [
      'Aggregate platform operating metadata across all workspaces',
      'Assess activation, reliability, review, and credit-burn movement against the prior week',
      'Draft the platform learning brief with the three changes worth building next',
      'Deliver latest result to #violema-demo after approval',
    ],
    steps: [
      {
        id: 'step_platform_telemetry',
        kind: 'query',
        title: 'Read platform telemetry',
        objective: 'Aggregate operational metadata across every workspace: activation funnel, per-workflow and per-source reliability, top readiness blockers, review outcomes, and credit burn.',
        inputs: { source: PLATFORM_TELEMETRY_SOURCE, query_type: 'platform_learning_snapshot' },
      },
      {
        id: 'step_platform_analysis',
        kind: 'analyze',
        title: 'Analyze the week',
        objective: 'Turn the telemetry snapshot into an evidence-cited read of what changed and what to do about it.',
        inputs: {
          instruction: [
            'Analyze the platform telemetry snapshot and answer four questions, in this order:',
            '1. WHAT IMPROVED — which metrics moved favorably versus the prior week, and by how much.',
            '2. WHAT IS BLOCKING ACTIVATION — where workspaces stall between signing up, connecting a source, running, and delivering; name the top readiness blockers by count.',
            '3. WHAT USERS CORRECT MOST — read changes-requested, rejected, and fabricated-evidence blocks against approvals; say which workflows and step kinds attract the most correction.',
            '4. TOP 3 RECOMMENDED PLATFORM CHANGES for the coming week, ranked by leverage.',
            'Every claim must cite the specific metric it rests on, including the numbers. If the snapshot does not support a claim, say the data is insufficient instead of inferring.',
            'This is operational metadata only — it contains no customer content, so do not speculate about what any individual workspace was working on.',
          ].join('\n'),
        },
      },
      {
        id: 'step_platform_brief',
        kind: 'summarize',
        title: 'Draft the learning brief',
        objective: 'Write the operator-ready brief: what improved, what is blocking activation, what gets corrected most, and the three changes to build next with their supporting numbers.',
        inputs: { instruction: 'Draft the platform learning brief with metric-cited findings and three ranked, concrete recommendations for the coming week.' },
      },
      {
        id: 'step_platform_delivery',
        kind: 'deliver',
        title: 'Deliver to Slack',
        objective: 'Send the reviewed platform learning brief to the operator channel after approval.',
        inputs: { approval_required: true },
        deliveryTarget: { channel: 'slack', target: '#violema-demo' },
      },
    ],
    execution_policy: {
      // quality_first, unlike the founder update's 'balanced': this brief runs
      // once a week and feeds the orchestrator's build queue, so a wrong read
      // costs far more than the extra model spend on a single run.
      mode: 'recommended',
      optimizationGoal: 'quality_first',
      reviewPolicy: 'standard',
      maxElasticLanes: 2,
    },
    notify: '#violema-demo',
    status: 'active',
    // No workspaceId on purpose: internal and unattributed, which
    // `usesInternalDemoRouting` treats as ours, and which resolves to
    // DEFAULT_WORKSPACE_ID at run time — the only workspace the
    // platform_telemetry source will answer for.
  },
  {
    id: 'auto_competitor_monitor',
    // 3, not 2: createAutomation stamps operator-authored records version 2, and the merge requires stored.version < seed.version.
    version: 3,
    // Declared so the run gate resolves a stable identity instead of inferring
    // 'custom-workflow' from the step sources. `competitor-monitor` is not on
    // the supported-workflow readiness table, so it lands in tier 3, which
    // derives requirements from the query steps below — exactly what we want:
    // the library step is what makes Google Drive required.
    workflowId: 'competitor-monitor',
    name: 'Competitor monitor',
    description:
      "A weekly memo on competitor pricing, launches, and positioning shifts, written against this account's own accumulated intelligence library rather than a cold web search.",
    authoring_mode: 'guided',
    workflow_prompt: [
      'Read the competitive intelligence library for what Violema already knows about this account.',
      'Search the web for competitor pricing, launch, and positioning changes.',
      'Report what CHANGED against the library, not what merely exists.',
      'Record the run in the library so the next run inherits it, then deliver after approval.',
    ].join('\n'),
    schedule: 'every monday at 8am',
    cron_expression: '0 8 * * 1',
    timezone: 'America/Chicago',
    actions: [
      'Read prior competitive findings from the account intelligence library',
      'Search competitor pricing, launches, and positioning changes',
      'Compare this week against the library and isolate what actually changed',
      'Draft the competitor memo with implications and recommended action',
      'Record this run in the account intelligence library',
      'Deliver latest result to #violema-demo after approval',
    ],
    steps: [
      // READ FIRST. This step runs before the search so the analysis below has
      // prior findings to compare against. On a brand-new workspace it returns
      // an empty, explicitly-uninitialized library, and the analysis says so
      // rather than inventing a history.
      {
        id: 'step_library_context',
        kind: 'query',
        title: 'Read the competitive library',
        objective:
          'Load prior competitive findings recorded for this account so this run can report changes rather than restate what is already known.',
        inputs: {
          source: ACCOUNT_LIBRARY_SOURCE,
          query_type: ACCOUNT_LIBRARY_READ_QUERY_TYPE,
          filters: { section: COMPETITIVE_INTELLIGENCE_SECTION },
          limit: 3,
        },
      },
      {
        id: 'step_competitor_search',
        kind: 'search',
        title: 'Search competitor moves',
        objective: 'Find pricing, launch, and positioning changes from key competitors.',
        inputs: {
          // Resolved at run time from the workspace's operator-owned business
          // context (platform/businessContext.ts) — the market no longer lives
          // in seed content, so a seed bump can never revert a tenant's market.
          use_business_context: true,
          query_suffix: 'competitor pricing launches positioning',
          num_results: 8,
        },
      },
      {
        id: 'step_delta_analysis',
        kind: 'analyze',
        title: 'Extract what changed',
        objective:
          'Compare this run against the prior library entries and separate genuine change from noise.',
        inputs: {
          use_business_context: true,
          instruction: [
            'Compare the search evidence against the prior library entries in the evidence block.',
            'Report NEW (absent from the library), CHANGED (present but different — say what it was and what it is now), and UNCHANGED (confirmed still true, one line).',
            'When the library is empty, say plainly that this run is the baseline and describe only what the evidence shows.',
            'Never describe a change you cannot evidence from both sides of the comparison.',
          ].join(' '),
        },
      },
      {
        id: 'step_competitor_memo',
        kind: 'summarize',
        title: 'Draft competitor memo',
        objective:
          'Create a concise founder memo leading with what changed since the last run, with implications and recommended action.',
        inputs: {
          use_business_context: true,
          instruction:
            'Draft the competitor memo. Lead with what changed since the last run, then implications, then recommended action.',
        },
      },
      // WRITE LAST, before delivery. The memo drafted above is the finding, so
      // the library records exactly what the founder is about to read — and it
      // is recorded whether or not the delivery is ultimately approved, because
      // what Violema learned is true regardless of who read it.
      {
        id: 'step_library_record',
        kind: 'query',
        title: 'Record findings in the library',
        objective:
          "Append this run's competitive findings to the account intelligence library so the next run starts from them.",
        inputs: {
          source: ACCOUNT_LIBRARY_SOURCE,
          query_type: ACCOUNT_LIBRARY_WRITE_QUERY_TYPE,
          section: COMPETITIVE_INTELLIGENCE_SECTION,
          entry_title: 'Competitor snapshot',
        },
      },
      {
        id: 'step_competitor_delivery',
        kind: 'deliver',
        title: 'Deliver competitor memo',
        objective: 'Send the reviewed competitor memo after approval.',
        inputs: { approval_required: true },
        deliveryTarget: { channel: 'slack', target: '#violema-demo' },
      },
    ],
    execution_policy: {
      mode: 'recommended',
      optimizationGoal: 'balanced',
      reviewPolicy: 'standard',
      maxElasticLanes: 2,
    },
    notify: '#violema-demo',
    status: 'active',
  },
];

function readAutomations(): AutomationRecord[] {
  try {
    if (!fs.existsSync(AUTOMATIONS_FILE)) return [];
    return JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf-8')) as AutomationRecord[];
  } catch {
    return [];
  }
}

function writeAutomations(items: AutomationRecord[]) {
  fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(items, null, 2));
}

/**
 * Snapshot the automations file before a one-shot migration rewrites it.
 *
 * The house pattern (`platform/jsonStore.ts`) keeps one rolling `.bak` sibling,
 * which the next ordinary write would overwrite. A migration edits step content
 * an operator never asked to change, so its snapshot is timestamped and
 * survives. Best effort: a failed copy must not stop the rewrite.
 */
function backupAutomationsFile(): string | null {
  if (!fs.existsSync(AUTOMATIONS_FILE)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = `${AUTOMATIONS_FILE}.bak.${stamp}`;
  try {
    fs.copyFileSync(AUTOMATIONS_FILE, destination);
    return destination;
  } catch (error) {
    console.error(`[migration] could not back up ${AUTOMATIONS_FILE} before rewrite`, error);
    return null;
  }
}

function isValidTimeZone(timezone?: string): boolean {
  if (!timezone) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeTimeZone(timezone?: string): string {
  return isValidTimeZone(timezone) ? timezone! : DEFAULT_AUTOMATION_TIMEZONE;
}

function getZonedParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    dayOfMonth: Number(values.day),
    month: Number(values.month),
    dayOfWeek: weekdayMap[values.weekday] ?? 0,
  };
}

function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (/^\*\/\d+$/.test(field)) {
    const step = Number(field.slice(2));
    return value % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some((part) => fieldMatches(part, value));
  }
  return Number(field) === value;
}

function cronMatchesDate(cronExpression: string, date: Date, timezone: string): boolean {
  const [minuteField, hourField, dayField, monthField, weekdayField] = cronExpression.trim().split(/\s+/);
  if (!minuteField || !hourField || !dayField || !monthField || !weekdayField) return false;

  const zoned = getZonedParts(date, timezone);
  return (
    fieldMatches(minuteField, zoned.minute) &&
    fieldMatches(hourField, zoned.hour) &&
    fieldMatches(dayField, zoned.dayOfMonth) &&
    fieldMatches(monthField, zoned.month) &&
    fieldMatches(weekdayField, zoned.dayOfWeek)
  );
}

function computeNextRunAt(cronExpression: string, timezone: string, fromDate = new Date()): string | undefined {
  const start = Math.floor(fromDate.getTime() / 60000) * 60000;
  const maxMinutesAhead = 60 * 24 * 32;
  for (let minuteOffset = 1; minuteOffset <= maxMinutesAhead; minuteOffset += 1) {
    const candidate = new Date(start + minuteOffset * 60000);
    if (cronMatchesDate(cronExpression, candidate, timezone)) {
      return candidate.toISOString();
    }
  }
  return undefined;
}

function updateAutomationRecord(id: string, updater: (record: AutomationRecord) => AutomationRecord): AutomationRecord | null {
  const items = readAutomations();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const next = withAutomationDefaults(updater(items[index]));
  items[index] = next;
  writeAutomations(items);
  return next;
}

function normalizeDeliveryTargetText(value: string | undefined, reroute: boolean): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!reroute) return trimmed;
  return LEGACY_DELIVERY_TARGETS[trimmed.toLowerCase()] || trimmed;
}

function normalizeAutomationText(value: string, reroute: boolean) {
  if (!reroute) return value;
  return value
    .replace(/#founders\b/gi, '#violema-demo')
    .replace(/#all-purple-orange\b/gi, '#violema-demo');
}

/**
 * Answers "does the raise-period reroute apply to this automation's workspace".
 *
 * Defaults to the single-shot predicate. `listAutomations` passes a batch
 * resolver instead, because the default re-reads the entire workspace store per
 * record — invisible with four automations, a full file read per row at scale.
 */
type InternalRoutingResolver = (workspaceId: string | null | undefined) => boolean;

function normalizeAutomationRecord(
  record: AutomationRecord,
  usesInternalRouting: InternalRoutingResolver = usesInternalDemoRouting,
): AutomationRecord {
  // Whose automation this is decides whether the raise-period reroute applies.
  // A tenant's stored channel is theirs and is left exactly as written; only
  // Max's internal workspace and demo workspaces get rewritten.
  const reroute = usesInternalRouting(record.workspaceId);

  return {
    ...record,
    actions: record.actions.map((action) => normalizeAutomationText(action, reroute)),
    workflow_prompt: record.workflow_prompt
      ? normalizeAutomationText(record.workflow_prompt, reroute)
      : record.workflow_prompt,
    notify: normalizeDeliveryTargetText(record.notify, reroute),
    steps: record.steps?.map((step) => ({
      ...step,
      objective: normalizeAutomationText(step.objective, reroute),
      deliveryTarget: step.deliveryTarget
        ? {
            ...step.deliveryTarget,
            target:
              normalizeDeliveryTargetText(step.deliveryTarget.target, reroute)
              || step.deliveryTarget.target,
          }
        : step.deliveryTarget,
    })),
  };
}

function withAutomationDefaults(
  record: AutomationRecord,
  usesInternalRouting?: InternalRoutingResolver,
): AutomationRecord {
  const normalized = normalizeAutomationRecord(record, usesInternalRouting);
  const timezone = normalizeTimeZone(normalized.timezone);
  return {
    ...normalized,
    workspaceId: normalized.workspaceId,
    timezone,
    next_run_at: normalized.status === 'paused'
      ? undefined
      : normalized.next_run_at || computeNextRunAt(normalized.cron_expression, timezone),
  };
}

function parseTime(value?: string): { hour: number; minute: number } {
  if (!value) return { hour: 9, minute: 0 };

  const trimmed = value.trim().toLowerCase();
  const ampmMatch = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampmMatch) {
    let hour = Number(ampmMatch[1]) % 12;
    if (ampmMatch[3] === 'pm') hour += 12;
    return { hour, minute: Number(ampmMatch[2] || '0') };
  }

  const twentyFourHourMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch) {
    return {
      hour: Math.min(Number(twentyFourHourMatch[1]), 23),
      minute: Math.min(Number(twentyFourHourMatch[2]), 59),
    };
  }

  throw new Error(`Unsupported time format: ${value}`);
}

export function normalizeSchedule(schedule: string): string {
  const normalized = schedule.trim().toLowerCase();

  if (getCron().validate(normalized)) {
    return normalized;
  }

  if (normalized === 'hourly' || normalized === 'every hour') {
    return '0 * * * *';
  }

  const everyHours = normalized.match(/^every\s+(\d+)\s+hours?$/);
  if (everyHours) {
    const hours = Number(everyHours[1]);
    if (hours < 1 || hours > 23) {
      throw new Error('Hour interval must be between 1 and 23.');
    }
    return `0 */${hours} * * *`;
  }

  const dailyMatch = normalized.match(/^(daily|every day)(?:\s+at\s+(.+))?$/);
  if (dailyMatch) {
    const { hour, minute } = parseTime(dailyMatch[2]);
    return `${minute} ${hour} * * *`;
  }

  const weeklyMatch = normalized.match(
    /^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/
  );
  if (weeklyMatch) {
    const dayMap: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    const { hour, minute } = parseTime(weeklyMatch[2]);
    return `${minute} ${hour} * * ${dayMap[weeklyMatch[1]]}`;
  }

  throw new Error('Unsupported schedule format. Use cron, "hourly", "every 4 hours", "daily at 6pm", or "every monday at 9am".');
}

/**
 * Evaluate a human-written condition string against the automation's current state.
 * Returns true (should run) or false (should skip this run).
 *
 * Supported patterns (case-insensitive):
 *   "only if last run failed"         → skip if last run succeeded
 *   "only if last run succeeded"      → skip if last run failed
 *   "if failure count exceeds N"      → skip if consecutive_failures <= N
 *   "only if consecutive failures > N"
 *   "skip if last run succeeded"      → same as "only if last run failed"
 */
function evaluateCondition(condition: string, record: AutomationRecord): { pass: boolean; reason: string } {
  const norm = condition.trim().toLowerCase();

  const lastStatus = record.last_run_status;
  const failures = record.consecutive_failures ?? 0;

  if (/only if last run failed|skip if last run succeeded/.test(norm)) {
    if (!lastStatus) return { pass: true, reason: 'No previous run — allowing first run.' };
    const pass = lastStatus === 'failed';
    return { pass, reason: pass ? 'Last run failed — condition met.' : `Skipped: last run succeeded.` };
  }

  if (/only if last run succeeded|skip if last run failed/.test(norm)) {
    if (!lastStatus) return { pass: true, reason: 'No previous run — allowing first run.' };
    const pass = lastStatus === 'succeeded';
    return { pass, reason: pass ? 'Last run succeeded — condition met.' : `Skipped: last run failed.` };
  }

  const failThresholdMatch = norm.match(/(?:if failure count exceeds|if consecutive failures[^>]*>)\s*(\d+)/);
  if (failThresholdMatch) {
    const threshold = Number(failThresholdMatch[1]);
    const pass = failures > threshold;
    return {
      pass,
      reason: pass
        ? `Failure count ${failures} exceeds threshold ${threshold} — condition met.`
        : `Skipped: failure count ${failures} does not exceed ${threshold}.`,
    };
  }

  // Unknown pattern — fail closed so the user notices the condition needs fixing
  return {
    pass: false,
    reason: `Condition not recognised: "${condition.trim()}". Supported patterns: "only if last run failed", "only if last run succeeded", "if consecutive failures > N". Leave blank to always run.`,
  };
}

async function executeAutomationClaimed(
  record: AutomationRecord,
  onTrigger: (record: AutomationRecord) => Promise<{ ok: boolean; error?: string } | void>,
  options: {
    conditionAlreadyChecked?: boolean;
    startedAt?: string;
    startRecorded?: boolean;
  } = {},
) {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const timezone = normalizeTimeZone(record.timezone);

  // Evaluate condition before running
  if (!options.conditionAlreadyChecked && record.condition?.trim()) {
    const { pass, reason } = evaluateCondition(record.condition, record);
    if (!pass) {
      console.log(`[scheduler] automation ${record.id} skipped: ${reason}`);
      updateAutomationRecord(record.id, (current) => ({
        ...current,
        timezone,
        next_run_at: computeNextRunAt(current.cron_expression, timezone, new Date(startedAt)),
      }));
      return;
    }
    console.log(`[scheduler] automation ${record.id} condition passed: ${reason}`);
  }

  if (!options.startRecorded) {
    updateAutomationRecord(record.id, (current) => ({
      ...current,
      timezone,
      last_run_at: startedAt,
    }));
  }

  let result: { ok: boolean; error?: string } | void;

  try {
    result = await onTrigger({ ...record, timezone, last_run_at: startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown automation error';
    console.error(`[scheduler] automation ${record.id} failed`, error);
    result = { ok: false, error: message };
  }

  const ok = typeof result === 'object' && result !== null && 'ok' in result ? Boolean(result.ok) : true;

  updateAutomationRecord(record.id, (current) => ({
    ...current,
    timezone,
    last_run_at: startedAt,
    last_run_status: ok ? 'succeeded' : 'failed',
    consecutive_failures: ok ? 0 : (current.consecutive_failures ?? 0) + 1,
    next_run_at: computeNextRunAt(current.cron_expression, timezone, new Date(startedAt)),
  }));
}

async function executeAutomation(
  record: AutomationRecord,
  onTrigger: (record: AutomationRecord) => Promise<{ ok: boolean; error?: string } | void>,
) {
  if (activeAutomationExecutions.has(record.id)) {
    console.warn(`[scheduler] automation ${record.id} is already running; duplicate trigger skipped`);
    return;
  }
  activeAutomationExecutions.add(record.id);
  try {
    await executeAutomationClaimed(record, onTrigger);
  } finally {
    activeAutomationExecutions.delete(record.id);
  }
}

export function isAutomationExecutionInFlight(id: string) {
  return activeAutomationExecutions.has(id);
}

function scheduleAutomationTask(
  record: AutomationRecord,
  onTrigger: (record: AutomationRecord) => Promise<{ ok: boolean; error?: string } | void>
) {
  const existing = scheduledTasks.get(record.id);
  existing?.stop();
  existing?.destroy();

  if (record.status === 'paused') {
    updateAutomationRecord(record.id, (current) => ({
      ...current,
      timezone: normalizeTimeZone(current.timezone),
      next_run_at: undefined,
    }));
    scheduledTasks.delete(record.id);
    return;
  }

  const timezone = normalizeTimeZone(record.timezone);
  if (shouldScheduleAutomationTasks()) {
    const task = getCron().schedule(record.cron_expression, () => {
      void executeAutomation({ ...record, timezone }, onTrigger);
    }, { timezone });

    scheduledTasks.set(record.id, task);
  } else {
    scheduledTasks.delete(record.id);
  }

  updateAutomationRecord(record.id, (current) => ({
    ...current,
    timezone,
    next_run_at: computeNextRunAt(current.cron_expression, timezone),
  }));
}

export function loadPersistedAutomations(
  onTrigger: (record: AutomationRecord) => Promise<{ ok: boolean; error?: string } | void>
) {
  const items = readAutomations().map((record) => withAutomationDefaults(record));
  writeAutomations(items);
  for (const item of items) {
    if (item.status !== 'paused') {
      scheduleAutomationTask(item, onTrigger);
      if (item.next_run_at && Date.parse(item.next_run_at) <= Date.now()) {
        void executeAutomation(item, onTrigger);
      }
    }
  }
  return items;
}

/**
 * Apply a newer seed version to an automation the operator already has.
 *
 * Seed propagation used to be `{ ...stored, ...seed }` with a handful of
 * exceptions. That reversed the ownership question: every field defaulted to
 * seed-owned, and any operator edit the exception list did not happen to
 * mention was silently reverted at the next deploy. The v3→4 bump reverted an
 * operator-chosen schedule and delivery channel in production that way.
 *
 * So ownership is now explicit and total. Every field of `AutomationRecord`
 * belongs to exactly one side:
 *
 * SEED-OWNED — what the automation DOES. Violema maintains these, and a
 * version bump is how improvements reach existing installs:
 *   version, workflowId, name, description, authoring_mode, workflow_prompt,
 *   actions, steps, execution_policy
 *
 * OPERATOR-OWNED — when it runs, where it delivers, whose it is, and what it
 * may spend. Never overwritten by a seed, because the console is the
 * authority on these and a silent revert is indistinguishable from a bug:
 *   status, schedule, cron_expression, timezone, notify, condition,
 *   credit_budget_per_run, workspaceId, owner_user_id, studio_state,
 *   created_at, and the run history
 *   (last_run_at, last_run_status, consecutive_failures, next_run_at)
 *
 * Consequence worth stating plainly: a seed can no longer change the cadence or
 * delivery target of an automation someone already has. That is deliberate — if
 * a future seed must move an existing install's schedule, do it as an explicit
 * migration, not as a side effect of shipping new steps.
 */
function mergeSeedIntoStoredAutomation(
  stored: AutomationRecord,
  seed: AutomationSeed,
): AutomationRecord {
  return {
    // ── seed-owned: the definition of the work
    version: seed.version,
    workflowId: seed.workflowId,
    name: seed.name,
    description: seed.description,
    authoring_mode: seed.authoring_mode,
    workflow_prompt: seed.workflow_prompt,
    actions: seed.actions,
    steps: seed.steps,
    execution_policy: seed.execution_policy,

    // ── operator-owned: identity, cadence, destination, and history
    id: stored.id,
    workspaceId: stored.workspaceId,
    owner_user_id: stored.owner_user_id,
    status: stored.status,
    schedule: stored.schedule,
    cron_expression: stored.cron_expression,
    timezone: stored.timezone,
    notify: stored.notify,
    condition: stored.condition,
    credit_budget_per_run: stored.credit_budget_per_run,
    studio_state: stored.studio_state,
    created_at: stored.created_at,
    last_run_at: stored.last_run_at,
    last_run_status: stored.last_run_status,
    consecutive_failures: stored.consecutive_failures,
    next_run_at: stored.next_run_at,
  };
}

export function ensureCoreAutomationSeeds(
  onTrigger: (record: AutomationRecord) => Promise<{ ok: boolean; error?: string } | void>
) {
  const current = readAutomations();
  const now = new Date().toISOString();
  const seedsById = new Map(CORE_AUTOMATION_SEEDS.map((seed) => [seed.id, seed]));
  const existingIds = new Set(current.map((item) => item.id));
  let changed = false;

  const upgraded = current.map((item) => {
    const seed = seedsById.get(item.id);
    if (!seed || (item.version || 0) >= (seed.version || 0)) return item;
    changed = true;
    return withAutomationDefaults(mergeSeedIntoStoredAutomation(item, seed));
  });
  const additions = CORE_AUTOMATION_SEEDS
    .filter((seed) => !existingIds.has(seed.id))
    .map((seed) => withAutomationDefaults({
      ...seed,
      timezone: normalizeTimeZone(seed.timezone),
      created_at: now,
    }));

  if (changed || additions.length > 0) {
    writeAutomations([...upgraded, ...additions]);
  }

  const seeded = readAutomations()
    .map((record) => withAutomationDefaults(record))
    .filter((item) => CORE_AUTOMATION_SEEDS.some((seed) => seed.id === item.id));

  for (const item of seeded) {
    if (item.status !== 'paused') {
      scheduleAutomationTask(item, onTrigger);
    }
  }

  return seeded;
}

export function listAutomations() {
  // One workspace-store read for the whole list, not one per automation.
  const usesInternalRouting = createInternalDemoRoutingResolver();
  return readAutomations()
    .map((record) => withAutomationDefaults(record, usesInternalRouting))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

export function getAutomationById(id: string) {
  const record = readAutomations().find((item) => item.id === id) || null;
  return record ? withAutomationDefaults(record) : null;
}

export function updateAutomation(
  id: string,
  patch: Partial<Omit<AutomationRecord, 'id' | 'created_at'>>,
  onTrigger: (record: AutomationRecord) => Promise<{ ok: boolean; error?: string } | void>
) {
  const items = readAutomations();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;

  const current = items[index];
  const nextSchedule = patch.schedule ?? current.schedule;
  const nextCronExpression =
    patch.cron_expression ??
    (patch.schedule && patch.schedule !== current.schedule ? normalizeSchedule(nextSchedule) : current.cron_expression);
  const timezone = normalizeTimeZone(typeof patch.timezone === 'string' ? patch.timezone : current.timezone);

  const updated: AutomationRecord = {
    ...current,
    ...patch,
    schedule: nextSchedule,
    cron_expression: nextCronExpression,
    timezone,
    status: patch.status ?? current.status,
  };

  updated.next_run_at = updated.status === 'paused'
    ? undefined
    : computeNextRunAt(updated.cron_expression, timezone);

  items[index] = updated;
  writeAutomations(items);
  scheduleAutomationTask(updated, onTrigger);
  return updated;
}

export function deleteAutomation(id: string) {
  const items = readAutomations();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;

  const [removed] = items.splice(index, 1);
  writeAutomations(items);

  const existing = scheduledTasks.get(id);
  existing?.stop();
  existing?.destroy();
  scheduledTasks.delete(id);

  return removed;
}

export function triggerAutomationNow(
  id: string,
  onTrigger: (record: AutomationRecord) => Promise<{ ok: boolean; error?: string } | void>,
  expectedRecord?: AutomationRecord,
) {
  const record = getAutomationById(id);
  if (!record) return { status: 'not_found' as const };
  if (activeAutomationExecutions.has(id)) return { status: 'already_running' as const };
  if (record.status === 'paused') return { status: 'paused' as const };

  // Manual surfaces price and reserve against one exact record. Refuse the
  // handoff if a concurrent PATCH changed any execution input while readiness
  // or billing checks were in flight; the caller releases its hold and asks
  // the operator to retry against the new revision.
  if (expectedRecord && JSON.stringify(record) !== JSON.stringify(expectedRecord)) {
    return { status: 'stale_record' as const };
  }

  if (record.condition?.trim()) {
    const condition = evaluateCondition(record.condition, record);
    if (!condition.pass) {
      const timezone = normalizeTimeZone(record.timezone);
      try {
        updateAutomationRecord(record.id, (current) => ({
          ...current,
          timezone,
          next_run_at: computeNextRunAt(current.cron_expression, timezone),
        }));
      } catch (error) {
        return { status: 'handoff_failed' as const, error };
      }
      return { status: 'condition_skipped' as const, reason: condition.reason };
    }
  }

  const startedAt = new Date().toISOString();
  const timezone = normalizeTimeZone(record.timezone);
  try {
    // This is the durable scheduler side of the handoff. Only after it lands
    // may an HTTP/Slack caller acknowledge or consume a one-shot review.
    updateAutomationRecord(record.id, (current) => ({
      ...current,
      timezone,
      last_run_at: startedAt,
    }));
  } catch (error) {
    return { status: 'handoff_failed' as const, error };
  }

  // Claim synchronously before returning. `executeAutomation` used to claim
  // only after the caller had already received success, leaving a same-tick
  // duplicate window and making condition skips leak transferred holds.
  activeAutomationExecutions.add(id);
  void executeAutomationClaimed(record, onTrigger, {
    conditionAlreadyChecked: true,
    startedAt,
    startRecorded: true,
  })
    .catch((error) => {
      console.error(`[scheduler] manual trigger failed for ${id}`, error);
    })
    .finally(() => {
      activeAutomationExecutions.delete(id);
    });
  return { status: 'started' as const, record };
}

export function createAutomation(
  input: Omit<AutomationRecord, 'id' | 'cron_expression' | 'status' | 'created_at' | 'last_run_at' | 'last_run_status' | 'next_run_at'>,
  onTrigger: (record: AutomationRecord) => Promise<{ ok: boolean; error?: string } | void>
) {
  // Starting the same mission twice (collection card, chat, editor) must not
  // spawn a second scheduled copy — reuse the workspace's active automation.
  const normalizedName = input.name.trim().toLowerCase();
  const existing = readAutomations().find(
    (item) =>
      item.workspaceId === input.workspaceId &&
      item.status === 'active' &&
      item.name.trim().toLowerCase() === normalizedName,
  );
  if (existing) return existing;

  const cronExpression = normalizeSchedule(input.schedule);
  const timezone = normalizeTimeZone(input.timezone);
  const record = withAutomationDefaults({
    id: `auto_${Date.now()}`,
    version: input.steps?.length ? 2 : undefined,
    workspaceId: input.workspaceId,
    owner_user_id: input.owner_user_id,
    name: input.name,
    description: input.description,
    authoring_mode: input.authoring_mode,
    workflow_prompt: input.workflow_prompt,
    schedule: input.schedule,
    cron_expression: cronExpression,
    timezone,
    actions: input.actions,
    steps: input.steps,
    execution_policy: input.execution_policy,
    notify: input.notify,
    condition: input.condition,
    status: 'active',
    next_run_at: computeNextRunAt(cronExpression, timezone),
    created_at: new Date().toISOString(),
  });

  const items = readAutomations();
  items.push(record);
  writeAutomations(items);
  scheduleAutomationTask(record, onTrigger);
  return record;
}

/**
 * One-shot boot migration for the 2026-08-05 wrong-business failure: move
 * business facts OUT of step content and INTO workspace business context.
 * Idempotent by construction — rewrites match exact legacy strings that no
 * longer exist after the rewrite, and backfills skip workspaces whose context
 * is already set. No stamp file needed.
 */
const LEGACY_BUSINESS_QUERY_SUFFIXES: Record<string, string> = {
  'AI agent automation platform competitor pricing launches positioning':
    'competitor pricing launches positioning',
  'AI automation platform startup competitor pricing product launch founder update':
    'competitor pricing product launch news',
  'AI-powered espresso machine competitors smart coffee machine pricing launches product announcements':
    'competitor pricing launches product announcements',
};

/** The live 2026-08-05 espresso patch, recognized so its market moves into context. */
const ESPRESSO_LEGACY_QUERY =
  'AI-powered espresso machine competitors smart coffee machine pricing launches product announcements';

const ESPRESSO_BACKFILL = {
  summary: 'An AI-powered espresso machine company.',
  marketKeywords: ['AI-powered espresso machine', 'smart coffee machine'],
  competitors: [],
};

const FOUNDER_BACKFILL = {
  summary:
    'Violema is an outcome-first AI operator that runs recurring founder and team workflows with human approval.',
  marketKeywords: ['AI agent automation platform'],
  // viktor.com: the named rival generic queries missed (vault, 2026-07-30).
  competitors: ['viktor.com'],
};

const MIGRATION_CONTEXT_STEP_TITLES = new Set([
  'Extract what changed',
  'Draft competitor memo',
  'Draft founder brief',
]);

/** Stamped on migration-authored contexts so the trail can tell them from an operator's. */
const MIGRATION_UPDATED_BY = 'migration:business-context';

export function runBusinessContextMigration(): {
  backfilled: number;
  rewrittenAutomations: number;
  /** Fed to the admin audit trail — one content-free event per rewritten record. */
  rewrittenAutomationIds: string[];
} {
  let backfilled = 0;
  const rewrittenAutomationIds: string[] = [];

  if (!getBusinessContext(DEFAULT_WORKSPACE_ID)) {
    if (setBusinessContext(DEFAULT_WORKSPACE_ID, FOUNDER_BACKFILL, MIGRATION_UPDATED_BY).ok) backfilled += 1;
  }

  const items = readAutomations();

  // Pass 1: an espresso-patched record reveals its workspace's market — capture
  // it into context BEFORE the rewrite destroys the query.
  for (const item of items) {
    const hasEspressoQuery = (item.steps || []).some(
      (step) =>
        typeof step.inputs?.query === 'string' && step.inputs.query.trim() === ESPRESSO_LEGACY_QUERY,
    );
    if (hasEspressoQuery && item.workspaceId && !getBusinessContext(item.workspaceId)) {
      if (setBusinessContext(item.workspaceId, ESPRESSO_BACKFILL, MIGRATION_UPDATED_BY).ok) backfilled += 1;
    }
  }

  // Pass 2: rewrite legacy queries to the reference form; flag the automation's
  // known context-consuming steps by title so copies get the preamble too.
  const next = items.map((item) => {
    if (!item.steps?.length) return item;
    let touched = false;
    let steps = item.steps.map((step) => {
      const query = typeof step.inputs?.query === 'string' ? step.inputs.query.trim() : '';
      // hasOwnProperty, not a bare lookup: a query of `constructor` or
      // `toString` would otherwise resolve to an inherited Object member and
      // rewrite a step nobody migrated.
      const suffix = Object.prototype.hasOwnProperty.call(LEGACY_BUSINESS_QUERY_SUFFIXES, query)
        ? LEGACY_BUSINESS_QUERY_SUFFIXES[query]
        : '';
      if (step.kind !== 'search' || !suffix) return step;
      touched = true;
      const numResults = typeof step.inputs?.num_results === 'number' ? step.inputs.num_results : 6;
      return { ...step, inputs: { use_business_context: true, query_suffix: suffix, num_results: numResults } };
    });
    if (!touched) return item;
    steps = steps.map((step) =>
      (step.kind === 'analyze' || step.kind === 'summarize') &&
      MIGRATION_CONTEXT_STEP_TITLES.has(step.title?.trim() || '') &&
      step.inputs?.use_business_context !== true
        ? { ...step, inputs: { ...(step.inputs || {}), use_business_context: true } }
        : step,
    );
    rewrittenAutomationIds.push(item.id);
    return { ...item, steps };
  });

  if (rewrittenAutomationIds.length > 0) {
    backupAutomationsFile();
    writeAutomations(next);
  }
  return { backfilled, rewrittenAutomations: rewrittenAutomationIds.length, rewrittenAutomationIds };
}

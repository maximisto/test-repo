import {
  queryStripeRevenue,
  STRIPE_REVENUE_QUERY_TYPES,
  type StripeLikeClient,
} from './adapters/nativeStripe';
import {
  PARTNER_COMPOSIO_QUERY_TYPES,
  queryPartnerComposio,
  type PartnerComposioQueryInput,
  type PartnerComposioSource,
} from './adapters/partnerComposio';
import {
  ACCOUNT_LIBRARY_BACKING_SOURCE,
  ACCOUNT_LIBRARY_READ_QUERY_TYPE,
  ACCOUNT_LIBRARY_SOURCE,
  ACCOUNT_LIBRARY_WRITE_QUERY_TYPE,
  MAX_RECOVERABLE_APP_ENTRY_CONTENT_BYTES,
  MAX_RECOVERABLE_APP_HISTORY_BYTES,
  readAccountLibrarySection,
  readLibrary,
  type AccountLibraryDeps,
  type AccountLibrarySnapshot,
} from './accountLibrary';
import type { IntegrationQueryResult, IntegrationQuerySuccess } from './types';
import type { AutomationStepExecution } from '../platform/types';
import { isDemoWorkspace } from '../platform/demoWorkspace';
import { canUseServerIntegrationCredentials } from '../platform/tenancy';
import {
  PLATFORM_TELEMETRY_SOURCE,
  buildPlatformTelemetrySnapshot,
  type PlatformTelemetrySnapshot,
} from '../platform/platformTelemetry';
import {
  sanitizeIntegrationDiagnostic,
  sanitizeIntegrationFailurePayload,
} from './diagnostics';

export interface LegacyQueryDataSuccess<T = unknown>
  extends Omit<IntegrationQuerySuccess<T>, 'live' | 'cache_hit'> {
  cache_hit: boolean;
  live: false;
  simulated: true;
  message: string;
  nextAction: {
    label: string;
    route: string;
  };
}

export interface ExecuteQueryDataInput {
  workspaceId: string;
  source: string;
  queryType: string;
  filters?: Record<string, unknown>;
  limit?: number;
  now?: Date;
  /** Cancels the live integration read when the automation step times out. */
  signal?: AbortSignal;
  clientOverrides?: {
    stripe?: StripeLikeClient;
    partner?: (input: PartnerComposioQueryInput) => Promise<IntegrationQueryResult>;
    /** Test seam for the Drive-backed account library read. */
    accountLibraryRead?: (
      workspaceId: string,
      section: string,
      options: {
        limit?: number;
        requireCompleteAppHistory?: boolean;
        maxAppEntryContentBytes?: number;
        maxAppHistoryBytes?: number;
      },
      deps?: AccountLibraryDeps,
    ) => Promise<IntegrationQueryResult<AccountLibrarySnapshot>>;
  };
  credentialOverrides?: {
    stripeSecretKey?: string;
  };
}

export interface ApplyQueryStepPayloadToExecutionInput {
  stepTitle: string;
  payload: Record<string, unknown>;
  stepExecution: AutomationStepExecution;
  stepErrors: string[];
  artifactCount: number;
}

const LEGACY_MOCK_DATA: Record<string, Record<string, unknown>> = {
  hubspot: {
    contacts: { total: 12450, new_this_month: 234, qualified_leads: 89, mql: 156, sql: 43 },
    deals: { open: 67, won_this_month: 23, lost_this_month: 8, pipeline_value: 890000, avg_deal_size: 38700, close_rate: '34%' },
    campaigns: { active: 5, total_reach: 42000, avg_open_rate: '24.3%', avg_click_rate: '3.8%' },
  },
  github: {
    open_issues: { total: 34, critical: 2, high: 8, medium: 15, low: 9 },
    pull_requests: { open: 12, merged_this_week: 28, avg_review_time_hours: 6.4, oldest_open_days: 18 },
    activity: { commits_this_week: 147, contributors_active: 8, deployments_this_week: 12 },
    delivery_risk: { open_prs: 12, merged_this_week: 28, blockers: 2, stale_reviews: 4 },
  },
  linear: {
    sprint: { name: 'Sprint 23', open: 156, in_progress: 34, completed: 42, blocked: 7 },
    velocity: { this_sprint: 84, last_sprint: 76, avg_4_sprints: 79 },
    cycle_time_days: { p50: 2.1, p90: 5.8 },
  },
  posthog: {
    pageviews: { today: 8421, this_week: 48230, this_month: 182450 },
    active_users: { dau: 1247, wau: 6832, mau: 18940 },
    conversion: { signup_rate: '4.2%', activation_rate: '67%', retention_d30: '42%' },
    top_events: [
      { event: 'chat_sent', count: 45230, change: '+12%' },
      { event: 'tool_executed', count: 28410, change: '+34%' },
      { event: 'automation_created', count: 3210, change: '+89%' },
    ],
  },
  salesforce: {
    pipeline: { total: 2340000, opportunities: 87, avg_age_days: 34 },
    forecast: { commit: 340000, best_case: 520000, pipeline: 890000 },
    top_accounts: [
      { name: 'Acme Corp', arr: 120000, health: 'green', csm: 'Sarah K.' },
      { name: 'Globex Inc', arr: 84000, health: 'yellow', csm: 'Mike T.' },
    ],
  },
  google_analytics: {
    sessions: { today: 3421, this_week: 21450, this_month: 89230 },
    acquisition: { organic: '42%', direct: '28%', paid: '18%', referral: '12%' },
    top_pages: [
      { path: '/', sessions: 12450, bounce_rate: '34%' },
      { path: '/pricing', sessions: 8230, bounce_rate: '28%' },
      { path: '/features', sessions: 6710, bounce_rate: '41%' },
    ],
  },
};

export interface QueryDataDefinitionInput {
  source: unknown;
  queryType: unknown;
  filters?: unknown;
}

/**
 * Validate an authored query against the exact dispatcher contract before a
 * manual/scheduled run can reserve credits. This is intentionally pure and
 * shares the adapters' own query-type constants so save-time and execution do
 * not drift into "accepted, then deterministically refused" behavior.
 */
export function validateQueryDataDefinition(input: QueryDataDefinitionInput): string | null {
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  const queryType = typeof input.queryType === 'string' ? input.queryType.trim() : '';
  const filters = input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters)
    ? input.filters as Record<string, unknown>
    : {};

  if (!source) return 'A query step must name a data source.';
  if (!queryType) return `The ${source} query step must name a query_type.`;

  if (source === 'stripe') {
    if (!(STRIPE_REVENUE_QUERY_TYPES as readonly string[]).includes(queryType)) {
      return `Stripe query_type "${queryType}" is not supported. Use ${STRIPE_REVENUE_QUERY_TYPES.map((item) => `"${item}"`).join(', ')}.`;
    }
    return null;
  }

  if (source === ACCOUNT_LIBRARY_SOURCE) {
    if (![ACCOUNT_LIBRARY_READ_QUERY_TYPE, ACCOUNT_LIBRARY_WRITE_QUERY_TYPE].includes(queryType)) {
      return `Account library query_type "${queryType}" is not supported. Use "${ACCOUNT_LIBRARY_READ_QUERY_TYPE}" or "${ACCOUNT_LIBRARY_WRITE_QUERY_TYPE}".`;
    }
    return null;
  }

  if (source === PLATFORM_TELEMETRY_SOURCE) {
    return queryType === 'platform_learning_snapshot'
      ? null
      : 'Platform telemetry supports only query_type "platform_learning_snapshot".';
  }

  if (isPartnerDemoSource(source)) {
    const expected = PARTNER_COMPOSIO_QUERY_TYPES[source];
    if (queryType !== expected) {
      return `${source} supports only query_type "${expected}".`;
    }
    if (source === 'github') {
      const owner = typeof filters.owner === 'string' ? filters.owner.trim() : '';
      const repo = typeof filters.repo === 'string' ? filters.repo.trim() : '';
      if (!owner || !repo) {
        return 'GitHub query steps require both filters.owner and filters.repo.';
      }
    }
    return null;
  }

  const demoQueries = LEGACY_MOCK_DATA[source];
  if (demoQueries) {
    return Object.prototype.hasOwnProperty.call(demoQueries, queryType)
      ? null
      : `${source} query_type "${queryType}" is not available.`;
  }

  return `${source} is not a supported query source.`;
}

const PARTNER_DEMO_SOURCES: PartnerComposioSource[] = [
  'github',
  'linear',
  'email',
  'calendar',
  'google_drive',
];

function isPartnerDemoSource(source: string): source is PartnerComposioSource {
  return PARTNER_DEMO_SOURCES.includes(source as PartnerComposioSource);
}

function readQueryPayloadFailureMessage(payload: Record<string, unknown>, stepTitle: string) {
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return sanitizeIntegrationDiagnostic(payload.message);
  }
  if (typeof payload.code === 'string' && payload.code.trim()) {
    return `Query step "${stepTitle}" failed with ${payload.code.trim()}.`;
  }
  return `Query step "${stepTitle}" failed.`;
}

export function applyQueryStepPayloadToExecution(
  input: ApplyQueryStepPayloadToExecutionInput,
) {
  const { stepTitle, payload, stepExecution, stepErrors, artifactCount } = input;

  const persistedPayload = payload.ok === false
    ? sanitizeIntegrationFailurePayload(payload, `Query step "${stepTitle}" failed.`)
    : payload;
  stepExecution.output = persistedPayload;
  stepExecution.artifactKind = 'query_data';
  stepExecution.toolCalls = 1;
  stepExecution.artifactCount = artifactCount;

  if (payload.ok === false) {
    const failureMessage = readQueryPayloadFailureMessage(persistedPayload, stepTitle);
    stepExecution.status = 'failed';
    stepExecution.summary = failureMessage;
    stepExecution.error = failureMessage;
    stepErrors.push(`${stepTitle}: ${failureMessage}`);
    return;
  }

  stepExecution.status = 'succeeded';
  if (payload.simulated === true || payload.live === false) {
    const source = typeof payload.source === 'string' && payload.source.trim()
      ? payload.source.trim()
      : 'integration';
    const sourceLabel = labelizeIntegrationSource(source);
    stepExecution.summary = `Pulled simulated ${sourceLabel} sample data. Connect ${sourceLabel} to query your live workspace data.`;
    stepExecution.error = undefined;
    return;
  }

  stepExecution.summary = 'Pulled the requested live data successfully.';
  stepExecution.error = undefined;
}

export async function executeQueryData(
  input: ExecuteQueryDataInput,
): Promise<IntegrationQueryResult | LegacyQueryDataSuccess> {
  const now = input.now || new Date();

  if (input.source === 'stripe') {
    return queryStripeRevenue({
      workspaceId: input.workspaceId,
      queryType: input.queryType,
      limit: input.limit,
      now,
      signal: input.signal,
      client: input.clientOverrides?.stripe,
      secretKey: input.credentialOverrides?.stripeSecretKey,
    });
  }

  // Violema's own cross-workspace operating metadata. This is the only source
  // that reads past a workspace boundary, so it is not a connectable
  // integration at all: it is refused for every workspace except the default
  // one, including demo workspaces, which get no sample stand-in either.
  if (input.source === PLATFORM_TELEMETRY_SOURCE) {
    if (!canUseServerIntegrationCredentials(input.workspaceId)) {
      return {
        ok: false,
        code: 'integration_not_connected',
        source: PLATFORM_TELEMETRY_SOURCE,
        message:
          'Platform telemetry is Violema\'s own internal operating data, not a workspace integration. It is not available to this workspace, and there is nothing to connect.',
        can_continue: false,
        nextAction: {
          label: 'See available integrations',
          route: '/integrations',
        },
      };
    }

    const startedAt = Date.now();
    const snapshot = buildPlatformTelemetrySnapshot({ now });
    const result: IntegrationQuerySuccess<PlatformTelemetrySnapshot> & { simulated: false } = {
      ok: true,
      source: PLATFORM_TELEMETRY_SOURCE,
      query_type: input.queryType || 'platform_learning_snapshot',
      data: snapshot,
      fetched_at: now.toISOString(),
      latency_ms: Math.max(0, Date.now() - startedAt),
      cache_hit: false,
      live: true,
      simulated: false,
    };
    return result;
  }

  // The account intelligence library, backed by the customer's Google Drive.
  //
  // Only reads are reachable from here. A library WRITE is an external action
  // with its own audit trail, executed by the automation step executor, so
  // routing it through the read path would log it as `data_read` and hide a
  // real write behind a query. Any non-read query type is refused rather than
  // quietly reinterpreted.
  if (input.source === ACCOUNT_LIBRARY_SOURCE) {
    if (input.queryType !== ACCOUNT_LIBRARY_READ_QUERY_TYPE) {
      return {
        ok: false,
        code: 'unsupported_query',
        source: ACCOUNT_LIBRARY_BACKING_SOURCE,
        message:
          'The account library only answers read queries here. Recording a library entry is an approved workflow action, not a data query.',
        can_continue: false,
        nextAction: {
          label: 'Review the workflow steps',
          route: '/automations',
        },
      };
    }

    const readLibrarySection = input.clientOverrides?.accountLibraryRead ?? readLibrary;
    const result = await readLibrarySection(
      input.workspaceId,
      readAccountLibrarySection(input.filters),
      {
        limit: input.limit,
        // A small workflow limit is a presentation preference, not permission
        // to hide newer unbaselined memos. Widen only Violema-owned history,
        // under the same 100-file/64 KB recovery bounds used by compaction, so
        // the later write step can safely re-establish the baseline.
        requireCompleteAppHistory: true,
        maxAppEntryContentBytes: MAX_RECOVERABLE_APP_ENTRY_CONTENT_BYTES,
        maxAppHistoryBytes: MAX_RECOVERABLE_APP_HISTORY_BYTES,
      },
      { now: () => now, signal: input.signal },
    );
    if (
      result.ok
      && result.data.appEntryHistoryComplete === false
      && result.data.appBaselineListed === false
      && result.data.appHistoryBeyondWindow === true
    ) {
      // A section that has never been compacted has no baseline to stop at,
      // so a long history can never read completely and nothing downstream
      // could ever create the first baseline if this read stopped the run.
      // Proceed with the readable window and say so; the write step
      // bootstraps a stamped baseline from the same window.
      return {
        ...result,
        data: {
          ...result.data,
          warnings: [
            ...(result.data.warnings ?? []),
            'This library section has no current-state baseline yet and holds more older findings than one read can cover. ' +
              'This run used the most recent findings only; the first baseline it records will say which older findings were not folded in.',
          ],
        },
      };
    }
    if (result.ok && result.data.appEntryHistoryComplete === false) {
      return {
        ok: false,
        code: 'integration_query_failed',
        source: ACCOUNT_LIBRARY_BACKING_SOURCE,
        message:
          'Violema could not read the account library history completely, so this run was stopped before producing a partial brief.',
        can_continue: false,
        nextAction: { label: 'Retry Google Drive', route: '/integrations?provider=google_drive' },
      };
    }
    return result;
  }

  if (isPartnerDemoSource(input.source)) {
    const partnerQuery = input.clientOverrides?.partner ?? queryPartnerComposio;
    return await partnerQuery({
      workspaceId: input.workspaceId,
      source: input.source,
      queryType: input.queryType,
      filters: input.filters,
      limit: input.limit,
      now,
      signal: input.signal,
    });
  }

  // Everything past this point is unconnected sample data. Real workspaces fail
  // closed with connect guidance; only explicitly flagged demo workspaces are
  // allowed to receive labeled simulated numbers.
  if (!isDemoWorkspace(input.workspaceId)) {
    const label = labelizeIntegrationSource(input.source);
    return {
      ok: false,
      code: 'integration_not_connected',
      source: input.source,
      message: `${label} is not connected. Connect it to query live workspace data.`,
      can_continue: false,
      nextAction: {
        label: `Connect ${label}`,
        route: `/integrations?provider=${encodeURIComponent(input.source)}`,
      },
    };
  }

  const sourceData = LEGACY_MOCK_DATA[input.source] || {};
  const result = sourceData[input.queryType] || { note: `Data for "${input.queryType}" not found in ${input.source}` };

  return {
    ok: true,
    source: input.source,
    query_type: input.queryType,
    data: result,
    fetched_at: now.toISOString(),
    latency_ms: 80,
    cache_hit: false,
    live: false,
    simulated: true,
    message: `Simulated ${labelizeIntegrationSource(input.source)} sample data. Connect ${labelizeIntegrationSource(input.source)} to query your live workspace data.`,
    nextAction: {
      label: `Connect ${labelizeIntegrationSource(input.source)}`,
      route: `/integrations?provider=${encodeURIComponent(input.source)}`,
    },
  };
}

function labelizeIntegrationSource(source: string) {
  const knownLabels: Record<string, string> = {
    github: 'GitHub',
    google_analytics: 'Google Analytics',
    hubspot: 'HubSpot',
    posthog: 'PostHog',
    salesforce: 'Salesforce',
    linear: 'Linear',
    jira: 'Jira',
    notion: 'Notion',
  };
  if (knownLabels[source]) return knownLabels[source];

  return source
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Integration';
}

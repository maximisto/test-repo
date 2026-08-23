/**
 * Run-time readiness enforcement.
 *
 * Readiness used to be advisory: the dashboard could show "connect Stripe"
 * while the scheduler happily ran the automation anyway, burned credits, and
 * produced a brief built on nothing. This module is the gate that turns that
 * advice into an enforced precondition, evaluated before a run reserves any
 * credits or calls any model.
 *
 * Enforcement is deliberately TIERED, because the readiness table only knows
 * two workflows:
 *
 *   1. Demo workspaces      → bypassed entirely. Demo surfaces are allowed to
 *                             show labeled sample data, so gating them would
 *                             break the product tour.
 *   2. Supported workflows  → the full `checkWorkflowReadiness` report.
 *   3. Everything else      → per-step source readiness derived from the
 *                             automation's own query steps. Applying the
 *                             two-workflow table here would mark every custom
 *                             automation permanently unready and brick them.
 *
 * Tier 3 is not stricter than the data layer already is: `executeQueryData`
 * fails closed for a non-demo workspace on any source outside the live-capable
 * set. The gate simply reaches that verdict before the money is spent, and
 * names the connection to fix.
 */

import type { PartnerComposioSource } from './adapters/partnerComposio';
import { ACCOUNT_LIBRARY_BACKING_SOURCE, ACCOUNT_LIBRARY_SOURCE } from './accountLibrary';
import {
  checkWorkflowReadiness,
  isConfigured,
  isWorkspaceConfigured,
  labelIntegrationId,
  type MinimalSettingsView,
  type WorkflowReadinessBlocker,
  type WorkflowRuntimeIntegrationStatus,
} from './workflowReadiness';
import type { WorkspaceSettingsView } from '../settingsStore';
import { canUseServerIntegrationCredentials } from '../platform/tenancy';
import { DEFAULT_WORKSPACE_ID } from '../platform/workspace';
import { PLATFORM_TELEMETRY_SOURCE } from '../platform/platformTelemetry';

/** Workflow ids `readWorkflowRequirements` actually has a requirements table for. */
export const SUPPORTED_READINESS_WORKFLOW_IDS = ['revenue-watch', 'weekly-founder-update'] as const;

/**
 * Partner sources a query step can read live, keyed by the Composio adapter's
 * own union. Typing this as a total Record means adding a source to
 * `PartnerComposioSource` without teaching the gate about it fails typecheck
 * rather than silently blocking every automation that uses it.
 */
const PARTNER_LIVE_QUERY_SOURCES: Record<PartnerComposioSource, true> = {
  email: true,
  calendar: true,
  google_drive: true,
  linear: true,
  github: true,
};

/** Every query source that can be backed by live data: Stripe plus the partner set. */
export const LIVE_CAPABLE_QUERY_SOURCES: string[] = [
  'stripe',
  ...Object.keys(PARTNER_LIVE_QUERY_SOURCES),
];

/**
 * Sources that are live-capable for Violema itself and for nobody else.
 *
 * `platform_telemetry` aggregates operating metadata ACROSS workspaces, so it
 * is not a connectable integration: it is absent from the integrations catalog
 * and from the chat agent's `query_data` enum, and `executeQueryData` refuses
 * it for every workspace but the default one. It is kept out of
 * `LIVE_CAPABLE_QUERY_SOURCES` on purpose — that constant describes what a
 * TENANT can reach, and widening it would make this source look connectable.
 */
const INTERNAL_ONLY_QUERY_SOURCES: string[] = [PLATFORM_TELEMETRY_SOURCE];

/**
 * The live-capable set as seen by one workspace. Identical to
 * `LIVE_CAPABLE_QUERY_SOURCES` for every workspace except the default one,
 * which additionally reaches Violema's internal telemetry.
 */
export function listLiveCapableQuerySourcesForWorkspace(
  workspaceId: string | null | undefined,
): string[] {
  return canUseServerIntegrationCredentials(workspaceId)
    ? [...LIVE_CAPABLE_QUERY_SOURCES, ...INTERNAL_ONLY_QUERY_SOURCES]
    : [...LIVE_CAPABLE_QUERY_SOURCES];
}

export interface RunReadinessStepLike {
  kind?: string;
  title?: string;
  inputs?: Record<string, unknown> | null;
  deliveryTarget?: {
    channel?: 'slack' | 'email';
    target?: string;
  } | null;
}

export interface RunReadinessDecision {
  allowed: boolean;
  /** Which tier produced the verdict — surfaced in logs and the blocked run record. */
  tier: 'demo_bypass' | 'supported_workflow' | 'step_sources';
  workflowId: string;
  summary: string;
  blockers: WorkflowReadinessBlocker[];
}

function readSource(step: RunReadinessStepLike): string {
  const value = step.inputs?.source;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isPartnerLiveSource(source: string): source is PartnerComposioSource {
  return Object.prototype.hasOwnProperty.call(PARTNER_LIVE_QUERY_SOURCES, source);
}

export function isSupportedReadinessWorkflow(workflowId: string): boolean {
  return (SUPPORTED_READINESS_WORKFLOW_IDS as readonly string[]).includes(workflowId);
}

function connectRoute(source: string) {
  return `/integrations?provider=${encodeURIComponent(source)}`;
}

function summarizeBlockers(blockers: WorkflowReadinessBlocker[]): string {
  const names = blockers.map((blocker) => blocker.label.replace(/^Connect /, ''));
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  return `This automation cannot run yet — connect ${list} first. Violema blocks runs that would read an unconnected source rather than inventing the data.`;
}

/**
 * Tier 3: readiness derived from the automation's executable steps.
 * Query, search, and delivery boundaries all need to be ready before a run can
 * be acknowledged; otherwise the operator receives a false-success response
 * and pays for upstream work before the inevitable refusal.
 */
export function evaluateStepSourceReadiness(input: {
  steps?: RunReadinessStepLike[];
  deliveryTarget?: string | null;
  settingsView?: WorkspaceSettingsView | MinimalSettingsView;
  runtimeStatus?: Record<string, WorkflowRuntimeIntegrationStatus>;
  /**
   * Whose automation this is. Stripe readiness depends on it: only the default
   * workspace may satisfy it with the server's own key. Omitted means internal,
   * preserving the pre-multi-tenant behavior.
   */
  workspaceId?: string;
}): WorkflowReadinessBlocker[] {
  const steps = input.steps || [];
  const querySteps = steps.filter((step) => step.kind === 'query');
  const blockers: WorkflowReadinessBlocker[] = [];
  const seen = new Set<string>();

  for (const step of querySteps) {
    const source = readSource(step);
    if (seen.has(source)) continue;
    seen.add(source);

    if (!source) {
      blockers.push({
        key: 'unknown_source',
        label: 'Name a data source',
        detail: `Step "${step.title || 'a query step'}" does not name a data source, so Violema cannot verify where its numbers would come from.`,
      });
      continue;
    }

    const label = labelIntegrationId(source);

    if (source === ACCOUNT_LIBRARY_SOURCE) {
      // The account library is a capability, not a connectable integration:
      // it is a folder inside the customer's Google Drive. So the blocker
      // names Drive and routes to Drive — telling a founder to "connect
      // Account library" would send them looking for something that does not
      // exist on the integrations page.
      //
      // This is also what makes Drive REQUIRED for any mission carrying a
      // library step. Drive is merely optional for the weekly founder update,
      // whose Drive step is supporting context; a library step is the mission's
      // memory, and running without it would silently reset the account's
      // accumulated knowledge.
      const status = input.runtimeStatus?.[ACCOUNT_LIBRARY_BACKING_SOURCE];
      const alreadyBlocked = blockers.some(
        (blocker) => blocker.key === ACCOUNT_LIBRARY_BACKING_SOURCE,
      );
      if (!status?.ready && !alreadyBlocked) {
        const driveLabel = labelIntegrationId(ACCOUNT_LIBRARY_BACKING_SOURCE);
        blockers.push({
          key: ACCOUNT_LIBRARY_BACKING_SOURCE,
          label: `Connect ${driveLabel}`,
          detail:
            status?.detail
            || `${driveLabel} is not connected to this workspace, so Violema cannot read or update this account's intelligence library.`,
          route: connectRoute(ACCOUNT_LIBRARY_BACKING_SOURCE),
        });
      }
      continue;
    }

    if (source === 'stripe') {
      // Mirrors `getWorkspaceScopedIntegrationCredential`: the server's key is
      // Violema's own account, so only the default workspace may pass on it.
      const stripeReadable = input.settingsView
        ? (canUseServerIntegrationCredentials(input.workspaceId ?? DEFAULT_WORKSPACE_ID)
            ? isConfigured(input.settingsView, 'stripe')
            : isWorkspaceConfigured(input.settingsView, 'stripe'))
        : false;

      if (!stripeReadable) {
        blockers.push({
          key: 'stripe',
          label: 'Connect Stripe',
          detail: 'Stripe read access is required before this automation can query live revenue data.',
          route: connectRoute('stripe'),
        });
      }
      continue;
    }

    if (source === PLATFORM_TELEMETRY_SOURCE) {
      // Internal-only, and there is nothing to connect: a tenant automation
      // naming this source is blocked with an honest explanation rather than a
      // connect link that would go nowhere. Mirrors `executeQueryData`, so the
      // gate and the data layer cannot disagree about who may read it.
      if (!canUseServerIntegrationCredentials(input.workspaceId ?? DEFAULT_WORKSPACE_ID)) {
        blockers.push({
          key: source,
          label: 'Platform telemetry is internal to Violema',
          detail:
            'Platform telemetry is Violema\'s own cross-workspace operating data. It is not a workspace integration and cannot be connected, so this automation would have no data to report.',
        });
      }
      continue;
    }

    if (isPartnerLiveSource(source)) {
      const status = input.runtimeStatus?.[source];
      // A mission may name both `google_drive` and `account_library`, which
      // resolve to the same connection. Two identical "Connect Google Drive"
      // blockers would read as two separate problems.
      const alreadyBlocked = blockers.some((blocker) => blocker.key === source);
      if (!status?.ready && !alreadyBlocked) {
        blockers.push({
          key: source,
          label: `Connect ${label}`,
          detail: status?.detail || `${label} is not connected to this workspace.`,
          route: connectRoute(source),
        });
      }
      continue;
    }

    blockers.push({
      key: source,
      label: `Connect ${label}`,
      detail: `${label} is not a source Violema can read live yet, so this step would have no real data to report.`,
      route: connectRoute(source),
    });
  }

  if (steps.some((step) => step.kind === 'search') && !input.runtimeStatus?.tavily?.ready) {
    blockers.push({
      key: 'tavily',
      label: 'Connect Web search',
      detail: input.runtimeStatus?.tavily?.detail || 'Web search is not configured on the server.',
      route: connectRoute('tavily'),
    });
  }

  for (const step of steps.filter((candidate) => candidate.kind === 'deliver')) {
    const target = step.deliveryTarget?.target?.trim() || input.deliveryTarget?.trim() || '';
    if (!target) {
      if (!blockers.some((blocker) => blocker.key === 'delivery_target')) {
        blockers.push({
          key: 'delivery_target',
          label: 'Add a delivery destination',
          detail: 'This automation has a delivery step but nowhere to send it.',
          route: '/automations',
        });
      }
      continue;
    }

    const channel = step.deliveryTarget?.channel || (target.includes('@') ? 'email' : 'slack');
    const integrationId = channel === 'email' ? 'postmark' : 'slack';
    if (input.runtimeStatus?.[integrationId]?.ready) continue;
    if (blockers.some((blocker) => blocker.key === integrationId)) continue;
    const label = labelIntegrationId(integrationId);
    blockers.push({
      key: integrationId,
      label: `Connect ${label}`,
      detail: input.runtimeStatus?.[integrationId]?.detail || `${label} delivery is not ready.`,
      route: connectRoute(integrationId),
    });
  }

  return blockers;
}

/** True when any step opted into workspace business context. */
export function stepsRequireBusinessContext(steps?: RunReadinessStepLike[]): boolean {
  return (steps || []).some((step) => step.inputs?.use_business_context === true);
}

/**
 * The honest empty state for context-requiring steps. Running anyway would
 * research a generic market and present it as this workspace's — the exact
 * 2026-08-05 demo-night failure — so the gate blocks before money is spent.
 */
export const BUSINESS_CONTEXT_BLOCKER: WorkflowReadinessBlocker = {
  key: 'business_context_missing',
  label: 'Tell Violema about your business',
  detail:
    "Violema doesn't know your business yet — tell it what you do and who you compete with, so this mission researches your market instead of a generic one.",
  route: '/settings#business',
};

/**
 * The enforcement decision for one automation run. Pure: the caller supplies
 * the settings view, the runtime status, and whether the workspace is a demo,
 * so this stays testable without a server or a Composio round trip.
 */
export function evaluateRunReadiness(input: {
  workflowId: string;
  workspaceId: string;
  isDemoWorkspace: boolean;
  steps?: RunReadinessStepLike[];
  deliveryTarget?: string | null;
  settingsView?: WorkspaceSettingsView | MinimalSettingsView;
  runtimeStatus?: Record<string, WorkflowRuntimeIntegrationStatus>;
  businessContextSet?: boolean;
}): RunReadinessDecision {
  if (input.isDemoWorkspace) {
    return {
      allowed: true,
      tier: 'demo_bypass',
      workflowId: input.workflowId,
      summary: 'Demo workspace: readiness enforcement bypassed.',
      blockers: [],
    };
  }

  let decision: RunReadinessDecision;

  if (isSupportedReadinessWorkflow(input.workflowId)) {
    const report = checkWorkflowReadiness({
      workflowId: input.workflowId,
      workspaceId: input.workspaceId,
      deliveryTarget: input.deliveryTarget,
      settingsView: input.settingsView,
      runtimeStatus: input.runtimeStatus,
    });

    const executionBlockers = evaluateStepSourceReadiness({
      steps: input.steps,
      deliveryTarget: input.deliveryTarget,
      settingsView: input.settingsView,
      runtimeStatus: input.runtimeStatus,
      workspaceId: input.workspaceId,
    });
    const blockers = [...report.blockers];
    for (const blocker of executionBlockers) {
      if (!blockers.some((existing) => existing.key === blocker.key)) blockers.push(blocker);
    }
    decision = {
      allowed: blockers.length === 0,
      tier: 'supported_workflow',
      workflowId: input.workflowId,
      summary: blockers.length === 0 ? report.summary : summarizeBlockers(blockers),
      blockers,
    };
  } else {
    const blockers = evaluateStepSourceReadiness({
      steps: input.steps,
      deliveryTarget: input.deliveryTarget,
      settingsView: input.settingsView,
      runtimeStatus: input.runtimeStatus,
      workspaceId: input.workspaceId,
    });

    decision = {
      allowed: blockers.length === 0,
      tier: 'step_sources',
      workflowId: input.workflowId,
      summary:
        blockers.length === 0
          ? 'Every data source this automation reads is connected.'
          : summarizeBlockers(blockers),
      blockers,
    };
  }

  if (stepsRequireBusinessContext(input.steps) && !input.businessContextSet) {
    return {
      ...decision,
      allowed: false,
      summary: BUSINESS_CONTEXT_BLOCKER.detail,
      blockers: [BUSINESS_CONTEXT_BLOCKER, ...decision.blockers],
    };
  }
  return decision;
}

import path from 'path';
import { readJsonFile, writeJsonFile } from '../platform/jsonStore';
import type { WorkflowLedgerEvent, WorkflowLedgerEventType } from './types';
import { sanitizeIntegrationDiagnostic } from './diagnostics';

const WORKFLOW_LEDGER_FILE = path.join(process.cwd(), 'workflow-ledger-events.json');

export interface AppendWorkflowLedgerEventInput {
  workspaceId: string;
  workflowId: string;
  automationId?: string;
  taskId?: string;
  taskRunId?: string;
  type: WorkflowLedgerEventType;
  summary: string;
  metadata?: Record<string, unknown>;
  now?: () => string;
}

export interface AppendIntegrationQueryLedgerEventInput {
  workspaceId: string;
  workflowId: string;
  automationId?: string;
  taskId?: string;
  taskRunId?: string;
  source: string;
  queryType?: string;
  ok: boolean;
  live?: boolean;
  message?: string;
  now?: () => string;
}

function labelizeSource(source: string) {
  const labels: Record<string, string> = {
    stripe: 'Stripe',
    github: 'GitHub',
    linear: 'Linear',
    email: 'Gmail',
    calendar: 'Google Calendar',
    google_drive: 'Google Drive',
  };
  if (labels[source]) return labels[source];
  return source
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Integration';
}

function safeTimestampId(value: string) {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/g, '');
}

function readEvents() {
  return readJsonFile<WorkflowLedgerEvent[]>(WORKFLOW_LEDGER_FILE, []);
}

function writeEvents(events: WorkflowLedgerEvent[]) {
  writeJsonFile(WORKFLOW_LEDGER_FILE, events);
}

export function appendWorkflowLedgerEvent(input: AppendWorkflowLedgerEventInput) {
  const createdAt = input.now ? input.now() : new Date().toISOString();
  const idBase = input.taskRunId || input.automationId || input.workflowId;
  const event: WorkflowLedgerEvent = {
    id: `ledger_${idBase}_${input.type}_${safeTimestampId(createdAt)}`,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    automationId: input.automationId,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    type: input.type,
    summary: input.summary,
    metadata: input.metadata,
    createdAt,
  };
  writeEvents([...readEvents(), event]);
  return event;
}

export function appendIntegrationQueryLedgerEvent(
  input: AppendIntegrationQueryLedgerEventInput,
) {
  const label = labelizeSource(input.source);
  const failureMessage = sanitizeIntegrationDiagnostic(input.message?.trim() || 'integration unavailable');
  return appendWorkflowLedgerEvent({
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    automationId: input.automationId,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    type: input.ok ? 'data_read' : 'connector_failed',
    summary: input.ok
      ? `Read ${input.live ? 'live ' : ''}${label} data.`
      : `${label} read blocked: ${failureMessage}`,
    metadata: {
      source: input.source,
      queryType: input.queryType,
      ok: input.ok,
      live: Boolean(input.live),
    },
    now: input.now,
  });
}

/**
 * Every ledger event, across every workspace.
 *
 * Deliberately narrow in its callers: only platform self-observation
 * (`platform/platformTelemetry`) may cross workspace boundaries, and it reads
 * an allowlist of metadata fields rather than the events themselves. Everything
 * tenant-facing must use `listWorkflowLedgerEvents`, which is workspace-scoped.
 */
export function readAllWorkflowLedgerEvents(): WorkflowLedgerEvent[] {
  return readEvents();
}

export function listWorkflowLedgerEvents(input: {
  workspaceId: string;
  workflowId?: string;
  automationId?: string;
  taskRunId?: string;
}) {
  return readEvents()
    .filter((event) => event.workspaceId === input.workspaceId)
    .filter((event) => !input.workflowId || event.workflowId === input.workflowId)
    .filter((event) => !input.automationId || event.automationId === input.automationId)
    .filter((event) => !input.taskRunId || event.taskRunId === input.taskRunId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

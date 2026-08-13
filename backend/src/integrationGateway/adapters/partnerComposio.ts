import { executeComposioAction } from '../../composioBridge';
import type {
  IntegrationQueryResult,
  IntegrationReadinessError,
} from '../types';

export type PartnerComposioSource =
  | 'email'
  | 'calendar'
  | 'google_drive'
  | 'linear'
  | 'github';

export type PartnerComposioExecutor = (
  actionName: string,
  input: Record<string, unknown>,
  ctx: { entityId: string },
) => Promise<unknown>;

export interface PartnerComposioQueryInput {
  workspaceId: string;
  source: PartnerComposioSource;
  queryType: string;
  filters?: Record<string, unknown>;
  limit?: number;
  now?: Date;
  execute?: PartnerComposioExecutor;
}

interface ComposioEnvelope {
  successful?: boolean;
  data?: unknown;
  error?: unknown;
}

interface PartnerActionFailure {
  error: unknown;
}

const SOURCE_LABELS: Record<PartnerComposioSource, string> = {
  email: 'Gmail',
  calendar: 'Google Calendar',
  google_drive: 'Google Drive',
  linear: 'Linear',
  github: 'GitHub',
};

const QUERY_TYPES: Record<PartnerComposioSource, string> = {
  email: 'commitments',
  calendar: 'weekly_commitments',
  google_drive: 'recent_files',
  linear: 'delivery_status',
  github: 'delivery_risk',
};

const ACTIONS = {
  email: 'GMAIL_FETCH_EMAILS',
  calendar: 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS',
  google_drive: 'GOOGLEDRIVE_FIND_FILE',
  linear: 'LINEAR_SEARCH_ISSUES',
  github: {
    repository: 'GITHUB_GET_A_REPOSITORY',
    pullRequests: 'GITHUB_LIST_PULL_REQUESTS',
    issues: 'GITHUB_LIST_REPOSITORY_ISSUES',
    commits: 'GITHUB_LIST_COMMITS',
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((item): item is string => Boolean(item));
  }
  const item = asString(value);
  return item ? [item] : [];
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(10, Math.max(1, Math.trunc(limit as number)));
}

function arrayFromPayload(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key] as unknown[];
  }

  if (isRecord(payload.data)) {
    for (const key of keys) {
      if (Array.isArray(payload.data[key])) return payload.data[key] as unknown[];
    }
  }

  return [];
}

function objectFromPayload(payload: unknown, keys: string[] = []): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  for (const key of keys) {
    if (isRecord(payload[key])) return payload[key] as Record<string, unknown>;
  }
  if (isRecord(payload.data)) return payload.data as Record<string, unknown>;
  return payload;
}

function readNestedString(value: unknown, key: string): string | undefined {
  return isRecord(value) ? asString(value[key]) : undefined;
}

function compactRecord(
  entries: Array<[string, unknown]>,
): Record<string, unknown> {
  return Object.fromEntries(
    entries.filter(([, value]) => value !== undefined),
  );
}

function normalizeGmail(payload: unknown) {
  const messages = arrayFromPayload(payload, ['messages', 'emails'])
    .map((item) => {
      if (!isRecord(item)) return null;
      return compactRecord([
        ['id', asString(item.id)],
        ['threadId', asString(item.threadId ?? item.thread_id)],
        ['subject', asString(item.subject)],
        ['from', asString(item.from ?? item.sender)],
        ['to', asStringArray(item.to ?? item.recipients)],
        ['date', asString(item.date ?? item.internalDate ?? item.internal_date)],
        ['labels', asStringArray(item.labels ?? item.labelIds ?? item.label_ids)],
      ]);
    })
    .filter((item): item is Record<string, unknown> => item !== null);

  return { messages, count: messages.length };
}

function normalizeCalendar(payload: unknown, start: string, end: string) {
  const events = arrayFromPayload(payload, ['events', 'items'])
    .map((item) => {
      if (!isRecord(item)) return null;
      return compactRecord([
        ['id', asString(item.id)],
        ['title', asString(item.title ?? item.summary)],
        [
          'start',
          asString(item.start)
            ?? readNestedString(item.start, 'dateTime')
            ?? readNestedString(item.start, 'date'),
        ],
        [
          'end',
          asString(item.end)
            ?? readNestedString(item.end, 'dateTime')
            ?? readNestedString(item.end, 'date'),
        ],
        ['status', asString(item.status)],
        ['link', asString(item.link ?? item.htmlLink ?? item.html_link)],
      ]);
    })
    .filter((item): item is Record<string, unknown> => item !== null);

  return {
    events,
    count: events.length,
    window: { start, end },
  };
}

function normalizeDrive(payload: unknown) {
  const files = arrayFromPayload(payload, ['files', 'items'])
    .map((item) => {
      if (!isRecord(item)) return null;
      return compactRecord([
        ['id', asString(item.id)],
        ['name', asString(item.name)],
        ['mimeType', asString(item.mimeType ?? item.mime_type)],
        ['modifiedTime', asString(item.modifiedTime ?? item.modified_time)],
        ['parents', asStringArray(item.parents)],
        ['webViewLink', asString(item.webViewLink ?? item.web_view_link)],
      ]);
    })
    .filter((item): item is Record<string, unknown> => item !== null);

  return { files, count: files.length };
}

function normalizeLinear(payload: unknown) {
  const issues = arrayFromPayload(payload, ['issues', 'nodes', 'items'])
    .map((item) => {
      if (!isRecord(item)) return null;
      return compactRecord([
        ['id', asString(item.id)],
        ['identifier', asString(item.identifier)],
        ['title', asString(item.title)],
        ['state', asString(item.state) ?? readNestedString(item.state, 'name')],
        ['priority', asNumber(item.priority)],
        ['updatedAt', asString(item.updatedAt ?? item.updated_at)],
        ['url', asString(item.url)],
      ]);
    })
    .filter((item): item is Record<string, unknown> => item !== null);

  return { issues, count: issues.length };
}

function normalizeGitHubRepository(payload: unknown) {
  const repository = objectFromPayload(payload, ['repository']);
  return compactRecord([
    ['id', asNumber(repository.id)],
    ['fullName', asString(repository.fullName ?? repository.full_name)],
    ['url', asString(repository.url ?? repository.html_url)],
    ['defaultBranch', asString(repository.defaultBranch ?? repository.default_branch)],
    ['private', asBoolean(repository.private)],
  ]);
}

function normalizeGitHubPullRequests(payload: unknown) {
  return arrayFromPayload(payload, ['pullRequests', 'pull_requests', 'items'])
    .map((item) => {
      if (!isRecord(item)) return null;
      return compactRecord([
        ['number', asNumber(item.number)],
        ['title', asString(item.title)],
        ['state', asString(item.state)],
        ['draft', asBoolean(item.draft)],
        ['url', asString(item.url ?? item.html_url)],
        ['updatedAt', asString(item.updatedAt ?? item.updated_at)],
      ]);
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

function normalizeGitHubIssues(payload: unknown) {
  return arrayFromPayload(payload, ['issues', 'items'])
    .filter((item) => !isRecord(item) || !item.pull_request)
    .map((item) => {
      if (!isRecord(item)) return null;
      return compactRecord([
        ['number', asNumber(item.number)],
        ['title', asString(item.title)],
        ['state', asString(item.state)],
        ['url', asString(item.url ?? item.html_url)],
        ['updatedAt', asString(item.updatedAt ?? item.updated_at)],
      ]);
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

function normalizeGitHubCommits(payload: unknown) {
  return arrayFromPayload(payload, ['commits', 'items'])
    .map((item) => {
      if (!isRecord(item)) return null;
      const commit = isRecord(item.commit) ? item.commit : {};
      const author = isRecord(commit.author) ? commit.author : {};
      return compactRecord([
        ['sha', asString(item.sha)],
        ['message', asString(item.message ?? commit.message)],
        ['date', asString(item.date ?? author.date)],
        ['url', asString(item.url ?? item.html_url)],
      ]);
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

function connectionRoute(source: PartnerComposioSource): string {
  return `/integrations?provider=${source}`;
}

function errorResult(
  source: PartnerComposioSource,
  code: IntegrationReadinessError['code'],
): IntegrationReadinessError {
  const label = SOURCE_LABELS[source];
  const scopeFailure = code === 'integration_scope_insufficient';
  const unsupported = code === 'unsupported_query';
  const notReady = code === 'integration_not_ready';

  return {
    ok: false,
    code,
    source,
    message: unsupported
      ? `${label} does not support this workflow query.`
      : scopeFailure
        ? `${label} is connected but needs read access for this workflow.`
        : notReady
          ? `${label} must be connected before this workflow can read live data.`
          : `Violema could not read ${label} right now. Try the connection again.`,
    can_continue: source === 'google_drive' && !unsupported,
    nextAction: {
      label: scopeFailure
        ? `Reauthorize ${label}`
        : notReady
          ? `Connect ${label}`
          : unsupported
            ? `Review ${label} setup`
            : `Retry ${label}`,
      route: connectionRoute(source),
    },
  };
}

/**
 * Exported so the account library classifies Drive failures identically. Two
 * copies of this mapping would drift, and a partner outage misread as
 * "not connected" sends the customer to reconnect something that is fine.
 */
export function classifyFailure(error: unknown): IntegrationReadinessError['code'] {
  let text = '';
  if (error instanceof Error) {
    // JSON.stringify(new Error(...)) is '{}' — Error properties are
    // non-enumerable — which silently classified every THROWN error as a
    // generic query failure no matter what its message said.
    text = `${error.name}: ${error.message}`.toLowerCase();
  } else {
    try {
      text = JSON.stringify(error).toLowerCase();
    } catch {
      text = String(error).toLowerCase();
    }
  }

  if (
    text.includes('scope') ||
    text.includes('permission') ||
    text.includes('access_denied') ||
    text.includes('403')
  ) {
    return 'integration_scope_insufficient';
  }

  if (
    text.includes('connected account') ||
    text.includes('not connected') ||
    text.includes('connection not found') ||
    // The bridge itself is off (`Composio is not configured`): the lane is
    // not ready, as opposed to a live lane whose query transiently failed.
    text.includes('not configured') ||
    text.includes('unauthorized') ||
    text.includes('401')
  ) {
    return 'integration_not_ready';
  }

  return 'integration_query_failed';
}

async function executeRead(
  execute: PartnerComposioExecutor,
  workspaceId: string,
  actionName: string,
  input: Record<string, unknown>,
): Promise<unknown | PartnerActionFailure> {
  try {
    const response = await execute(actionName, input, { entityId: workspaceId });
    if (!isRecord(response)) {
      return { error: 'invalid partner response' };
    }
    const envelope = response as ComposioEnvelope;
    if (envelope.successful !== true) {
      return { error: envelope.error ?? 'partner action failed' };
    }
    return envelope.data;
  } catch (error) {
    return { error };
  }
}

function isPartnerFailure(value: unknown): value is PartnerActionFailure {
  return isRecord(value) && 'error' in value;
}

function liveResult(
  source: PartnerComposioSource,
  queryType: string,
  data: unknown,
  fetchedAt: string,
  startedAt: number,
): IntegrationQueryResult {
  return {
    ok: true,
    source,
    query_type: queryType,
    data,
    fetched_at: fetchedAt,
    latency_ms: Math.max(0, Date.now() - startedAt),
    cache_hit: false,
    live: true,
  };
}

export async function queryPartnerComposio(
  input: PartnerComposioQueryInput,
): Promise<IntegrationQueryResult> {
  const expectedQueryType = QUERY_TYPES[input.source];
  if (input.queryType !== expectedQueryType) {
    return errorResult(input.source, 'unsupported_query');
  }

  const execute = input.execute ?? executeComposioAction;
  const now = input.now ?? new Date();
  const fetchedAt = now.toISOString();
  const limit = clampLimit(input.limit);
  const startedAt = Date.now();

  if (input.source === 'email') {
    const payload = await executeRead(execute, input.workspaceId, ACTIONS.email, {
      query: 'newer_than:7d (is:unread OR is:starred OR label:important)',
      user_id: 'me',
      verbose: false,
      ids_only: false,
      max_results: limit,
      include_payload: false,
      include_spam_trash: false,
    });
    if (isPartnerFailure(payload)) {
      return errorResult(input.source, classifyFailure(payload.error));
    }
    return liveResult(input.source, input.queryType, normalizeGmail(payload), fetchedAt, startedAt);
  }

  if (input.source === 'calendar') {
    const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const payload = await executeRead(execute, input.workspaceId, ACTIONS.calendar, {
      time_min: fetchedAt,
      time_max: windowEnd,
      show_deleted: false,
      single_events: true,
      response_detail: 'minimal',
      max_results_per_calendar: limit,
    });
    if (isPartnerFailure(payload)) {
      return errorResult(input.source, classifyFailure(payload.error));
    }
    return liveResult(
      input.source,
      input.queryType,
      normalizeCalendar(payload, fetchedAt, windowEnd),
      fetchedAt,
      startedAt,
    );
  }

  if (input.source === 'google_drive') {
    const payload = await executeRead(execute, input.workspaceId, ACTIONS.google_drive, {
      q: 'trashed = false',
      fields: 'files(id,name,mimeType,modifiedTime,parents,webViewLink),nextPageToken',
      orderBy: 'modifiedTime desc',
      pageSize: limit,
      spaces: 'drive',
    });
    if (isPartnerFailure(payload)) {
      return errorResult(input.source, classifyFailure(payload.error));
    }
    return liveResult(input.source, input.queryType, normalizeDrive(payload), fetchedAt, startedAt);
  }

  if (input.source === 'linear') {
    const payload = await executeRead(execute, input.workspaceId, ACTIONS.linear, {
      query: 'updated in the last 7 days',
      first: limit,
      include_archived: false,
    });
    if (isPartnerFailure(payload)) {
      return errorResult(input.source, classifyFailure(payload.error));
    }
    return liveResult(input.source, input.queryType, normalizeLinear(payload), fetchedAt, startedAt);
  }

  const owner = asString(input.filters?.owner);
  const repo = asString(input.filters?.repo);
  if (!owner || !repo) {
    return errorResult(input.source, 'unsupported_query');
  }
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const shared = { owner, repo };
  const [repository, pullRequests, issues, commits] = await Promise.all([
    executeRead(execute, input.workspaceId, ACTIONS.github.repository, shared),
    executeRead(execute, input.workspaceId, ACTIONS.github.pullRequests, {
      ...shared,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      page: 1,
      per_page: limit,
    }),
    executeRead(execute, input.workspaceId, ACTIONS.github.issues, {
      ...shared,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      page: 1,
      per_page: limit,
    }),
    executeRead(execute, input.workspaceId, ACTIONS.github.commits, {
      ...shared,
      page: 1,
      per_page: limit,
      since,
    }),
  ]);

  const failedPayload = [repository, pullRequests, issues, commits].find(isPartnerFailure);
  if (failedPayload) {
    return errorResult(input.source, classifyFailure(failedPayload.error));
  }

  const normalizedPullRequests = normalizeGitHubPullRequests(pullRequests);
  const normalizedIssues = normalizeGitHubIssues(issues);
  const normalizedCommits = normalizeGitHubCommits(commits);
  return liveResult(
    input.source,
    input.queryType,
    {
      repository: normalizeGitHubRepository(repository),
      pullRequests: normalizedPullRequests,
      issues: normalizedIssues,
      commits: normalizedCommits,
      counts: {
        openPullRequests: normalizedPullRequests.length,
        openIssues: normalizedIssues.length,
        recentCommits: normalizedCommits.length,
      },
    },
    fetchedAt,
    startedAt,
  );
}

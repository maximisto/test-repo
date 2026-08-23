/**
 * Per-workspace Slack delivery through Composio.
 *
 * Violema's native Slack sender authenticates with `SLACK_BOT_TOKEN` — our bot,
 * in our Slack. That is correct for Max's internal workspace and for demo
 * surfaces, and wrong for every tenant: a customer's weekly update must arrive
 * in THEIR Slack, posted by an app THEY authorized.
 *
 * So tenant Slack sends route here instead, executing a Composio action with
 * `entityId = workspaceId` so Composio resolves that workspace's own OAuth
 * credentials. There is deliberately no fallback to the native bot: if the
 * tenant has not connected Slack, the delivery FAILS and names the connection
 * to make. Silently sending from our bot would either leak the message into our
 * workspace or post into theirs under an identity they never approved.
 *
 * Action schema (verified against Composio's toolkit docs, version 20260721_00):
 *
 *   SLACK_SEND_MESSAGE / SLACKBOT_SEND_MESSAGE
 *     channel        string   required
 *     markdown_text  string   optional  ← what we send
 *     blocks         array    optional  (mutually exclusive with markdown_text)
 *     fallback_text  string   optional  (only valid alongside blocks)
 *     thread_ts      string   optional  ← threaded continuations
 *
 * Note there is NO `text` parameter — only the deprecated
 * `SLACK_CHAT_POST_MESSAGE` had one. We send `markdown_text` because our
 * delivery bodies are already markdown, and because `blocks` changed type
 * (string → array) between the deprecated and current action in a way we could
 * not verify a coercion for.
 */

import { executeComposioAction, listConnectedAppsDetailed, readConnectionInventory } from '../composioBridge';
import { normalizeAppName } from './partnerAppMap';
import {
  buildPartnerCapabilityReport,
  hasCapability,
  PARTNER_CAPABILITIES,
} from './partnerCapability';
import { sanitizeIntegrationDiagnostic } from './diagnostics';

/**
 * Composio ships two Slack toolkits and both can send. They differ only in
 * identity: `slackbot` posts as the connected app, `slack` posts as the
 * connected user. `slackbot` is listed first because it matches how Violema
 * already appears in Slack, but a workspace that connected either one can
 * deliver, so detection accepts both.
 */
export const SLACK_PARTNER_TOOLKITS = ['slackbot', 'slack'] as const;
export type SlackPartnerToolkit = (typeof SLACK_PARTNER_TOOLKITS)[number];

/** The toolkit the connect flow offers when a workspace has no Slack yet. */
export const PREFERRED_SLACK_PARTNER_TOOLKIT: SlackPartnerToolkit = 'slackbot';

const SLACK_SEND_ACTIONS: Record<SlackPartnerToolkit, string> = {
  slackbot: 'SLACKBOT_SEND_MESSAGE',
  slack: 'SLACK_SEND_MESSAGE',
};

export const SLACK_CONNECT_ROUTE = '/integrations?provider=slack';

/**
 * Slack accepts 40k characters in one message, but a wall that size is unusable.
 * The native path splits briefs across threaded messages at ~45 blocks; this is
 * the character-budget equivalent, and long briefs continue in a thread rather
 * than being truncated.
 */
const MAX_CHARS_PER_MESSAGE = 3500;

/** Backstop against a pathological body fanning out into hundreds of sends. */
const MAX_MESSAGES_PER_DELIVERY = 12;

export type TenantSlackConnectionStatus = 'connected' | 'not_connected' | 'unavailable';

export interface TenantSlackConnection {
  status: TenantSlackConnectionStatus;
  toolkit?: SlackPartnerToolkit;
  actionName?: string;
}

export type TenantSlackFailureCode = 'slack_not_connected' | 'slack_lookup_unavailable';

/**
 * A tenant Slack send that could not be routed. Carries the connect route so
 * the delivery step, the readiness blocker, and the run ledger all say the same
 * actionable thing.
 */
export class TenantSlackUnroutedError extends Error {
  readonly code: TenantSlackFailureCode;
  readonly workspaceId: string;
  readonly nextAction = { label: 'Connect Slack', route: SLACK_CONNECT_ROUTE };

  constructor(input: { code: TenantSlackFailureCode; workspaceId: string; message: string }) {
    super(input.message);
    this.name = 'TenantSlackUnroutedError';
    this.code = input.code;
    this.workspaceId = input.workspaceId;
  }
}

export interface TenantSlackDeps {
  listConnectedApps?: (ctx: { entityId: string; signal?: AbortSignal }) => Promise<{ apps: string[]; ok: boolean }>;
  execute?: (
    actionName: string,
    input: Record<string, unknown>,
    ctx: { entityId: string; signal?: AbortSignal },
  ) => Promise<unknown>;
  /** Injected in tests. Defaults to the cached Composio inventory read. */
  readIdentityCapability?: (workspaceId: string, signal?: AbortSignal) => Promise<'yes' | 'no' | 'unknown'>;
  /** Injected in tests. Defaults to `resolveSlackIconUrl()`. */
  iconUrl?: string;
}

// ── Posting as Violema ────────────────────────────────────────────────────────
//
// Tenant messages were arriving in customers' Slack under Composio's app name
// and icon. `SLACKBOT_SEND_MESSAGE` accepts `username`, `icon_url` and
// `icon_emoji`, but Slack only honours them when the token carries
// `chat:write.customize`. Without that scope Slack rejects the call outright —
// so a naive override would convert working deliveries into failures.
//
// The rule here is therefore: brand the message when we can, and never let
// branding be the reason a customer's update did not arrive.

export const VIOLEMA_SLACK_USERNAME = 'Violema';

/**
 * Default Slack avatar.
 *
 * `violema-mark.png` does not exist; the real square assets under
 * `frontend/public/brand/` are `violema-slack-avatar.png` (512×512, added for
 * exactly this purpose) and `purple-orange-hero-mark.png` (430×430). Slack
 * renders the icon at 48px and wants a square, so a wordmark would not do.
 *
 * Override with `VIOLEMA_SLACK_ICON_URL` — which is also the escape hatch if
 * the avatar has not shipped to production yet, since an unreachable icon just
 * falls back to the app's default rather than failing the send.
 */
export const DEFAULT_VIOLEMA_SLACK_ICON_URL =
  'https://violema.com/brand/violema-slack-avatar.png';

/**
 * Resolve the icon URL, refusing anything that is not plain `https`.
 *
 * A misconfigured env must not put an arbitrary scheme or an internal address
 * into an outbound payload; an empty result simply omits the icon.
 */
export function resolveSlackIconUrl(raw = process.env.VIOLEMA_SLACK_ICON_URL): string | undefined {
  const candidate = raw?.trim() || DEFAULT_VIOLEMA_SLACK_ICON_URL;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does this workspace's Slack connection carry `chat:write.customize`?
 *
 * `unknown` is a real and common answer — a connection that does not expose its
 * scopes tells us nothing — and it is treated optimistically: we attempt the
 * branded send and fall back if Slack objects. Guessing "no" would silently
 * strip Violema's identity from every such workspace.
 */
async function readIdentityCapability(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<'yes' | 'no' | 'unknown'> {
  const inventory = await readConnectionInventory({ entityId: workspaceId, signal });
  if (!inventory.ok) return 'unknown';

  const report = buildPartnerCapabilityReport(inventory.connections);
  for (const toolkit of SLACK_PARTNER_TOOLKITS) {
    const verdict = hasCapability(report, toolkit, PARTNER_CAPABILITIES.SLACK_CUSTOMIZE_IDENTITY);
    if (verdict !== 'no') return verdict;
  }
  return 'no';
}

/**
 * Did Slack reject this call *because* of the identity override?
 *
 * Deliberately narrow. Slack validates scope before delivering, so retrying
 * these is safe; retrying a generic failure could double-post a message that
 * actually went out.
 */
function isIdentityScopeRejection(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('missing_scope')
    || normalized.includes('chat:write.customize')
    || normalized.includes('cannot_customize')
    || normalized.includes('not_allowed_token_type')
    // Composio's tool schema can reject the identity fields outright before
    // Slack ever sees them ("Extra inputs are not permitted on parameter
    // `username`"). Same meaning, different mouth: branding unavailable,
    // deliver unbranded. Field-caught 2026-08-04 — it failed an approve.
    || (normalized.includes('extra inputs are not permitted')
      && (normalized.includes('username') || normalized.includes('icon_url')))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Which Slack toolkit this workspace can send through, if any.
 *
 * An unreachable Composio reports `unavailable` rather than `not_connected`:
 * "we cannot tell" and "you have not connected" are different facts, and only
 * one of them is fixed by connecting Slack.
 */
export async function resolveTenantSlackConnection(
  workspaceId: string,
  deps: TenantSlackDeps = {},
  signal?: AbortSignal,
): Promise<TenantSlackConnection> {
  const read = deps.listConnectedApps ?? listConnectedAppsDetailed;
  const result = await read({ entityId: workspaceId, signal });

  if (!result.ok) return { status: 'unavailable' };

  const connected = new Set(result.apps.map(normalizeAppName));
  const toolkit = SLACK_PARTNER_TOOLKITS.find((slug) => connected.has(normalizeAppName(slug)));
  if (!toolkit) return { status: 'not_connected' };

  return { status: 'connected', toolkit, actionName: SLACK_SEND_ACTIONS[toolkit] };
}

function unroutedError(workspaceId: string, status: TenantSlackConnectionStatus) {
  if (status === 'unavailable') {
    return new TenantSlackUnroutedError({
      code: 'slack_lookup_unavailable',
      workspaceId,
      message:
        "Violema could not verify this workspace's Slack connection, so the delivery was not sent. "
        + 'Try again in a moment, or reconnect Slack.',
    });
  }

  return new TenantSlackUnroutedError({
    code: 'slack_not_connected',
    workspaceId,
    message:
      'Slack is not connected for this workspace, so Violema did not send the delivery. '
      + 'Connect Slack to deliver here — Violema will not post from its own Slack workspace on your behalf.',
  });
}

/**
 * Compose the message text. The native path renders a Block Kit brief with a
 * header; `markdown_text` cannot carry blocks, so the subject becomes a bold
 * first line instead of being dropped.
 */
export function composeTenantSlackText(input: { subject?: string; body: string }): string {
  const subject = input.subject?.trim();
  const body = input.body.trim();
  if (!subject) return body;
  if (!body) return `**${subject}**`;
  return `**${subject}**\n\n${body}`;
}

/**
 * Split on line boundaries so markdown structure survives the break. A single
 * line longer than the budget is hard-split — losing a line break beats
 * truncating a brief.
 */
export function chunkSlackText(text: string, limit = MAX_CHARS_PER_MESSAGE): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const line of text.split('\n')) {
    if (line.length > limit) {
      flush();
      for (let index = 0; index < line.length; index += limit) {
        chunks.push(line.slice(index, index + limit));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      flush();
      current = line;
      continue;
    }
    current = candidate;
  }

  flush();
  return chunks.length > 0 ? chunks : [text.slice(0, limit)];
}

function readEnvelope(response: unknown, actionName: string): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new Error(`${actionName} returned an unreadable response.`);
  }

  if (response.successful !== true) {
    const detail = response.error;
    const text = typeof detail === 'string'
      ? sanitizeIntegrationDiagnostic(detail)
      : isRecord(detail)
        ? sanitizeIntegrationDiagnostic(
            [detail.code, detail.error, detail.message, detail.detail]
              .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
              || 'provider rejected the Slack request',
          )
        : 'provider rejected the Slack request';
    throw new Error(`Slack send failed via Composio (${actionName}): ${text}`);
  }

  return isRecord(response.data) ? response.data : {};
}

export async function preflightTenantSlackMessage(
  input: {
    workspaceId: string;
    to: string;
    body: string;
    subject?: string;
    signal?: AbortSignal;
  },
  deps: TenantSlackDeps = {},
) {
  const connection = await resolveTenantSlackConnection(input.workspaceId, deps, input.signal);
  if (connection.status !== 'connected' || !connection.actionName || !connection.toolkit) {
    throw unroutedError(input.workspaceId, connection.status);
  }

  const channel = input.to.trim().replace(/^#/, '');
  if (!channel) throw new Error('Slack target is required.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(channel)) {
    throw new Error(
      'Slack target must be a channel name such as #project-nexus or a Slack channel ID.',
    );
  }
  const chunks = chunkSlackText(
    composeTenantSlackText({ subject: input.subject, body: input.body }),
  );
  if (chunks.length > MAX_MESSAGES_PER_DELIVERY) {
    throw new Error(
      `Slack delivery is too long (${chunks.length} parts; maximum ${MAX_MESSAGES_PER_DELIVERY}). `
      + 'Shorten the brief before sending it so no content is silently dropped.',
    );
  }

  return {
    connection: {
      status: 'connected' as const,
      toolkit: connection.toolkit,
      actionName: connection.actionName,
    },
    channel,
    chunks,
  };
}

function readTimestamp(data: Record<string, unknown>): string | null {
  const direct = data.ts;
  if (typeof direct === 'string' && direct) return direct;
  const nested = isRecord(data.message) ? data.message.ts : undefined;
  return typeof nested === 'string' && nested ? nested : null;
}

/**
 * Send one workspace's Slack delivery through its own Composio connection.
 * Throws `TenantSlackUnroutedError` when the workspace has no usable
 * connection — the caller surfaces that as a failed step naming "Connect Slack".
 */
export async function sendTenantSlackMessage(
  input: {
    workspaceId: string;
    to: string;
    body: string;
    subject?: string;
    threadTs?: string;
    signal?: AbortSignal;
    onExternalRequestStart?: () => void | Promise<void>;
  },
  deps: TenantSlackDeps = {},
) {
  const { connection, channel, chunks } = await preflightTenantSlackMessage(input, deps);
  const execute = deps.execute ?? executeComposioAction;

  // Decided once per delivery, not per chunk: a multi-part brief must not
  // change identity halfway through.
  const readCapability = deps.readIdentityCapability ?? readIdentityCapability;
  let identityVerdict: 'yes' | 'no' | 'unknown';
  try {
    identityVerdict = await readCapability(input.workspaceId, input.signal);
  } catch (error) {
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error('Slack delivery was aborted.');
    }
    // Capability is a nicety; delivery is not. An unreadable verdict behaves
    // like `unknown` — attempt branding, fall back if Slack objects.
    identityVerdict = 'unknown';
  }

  const iconUrl = deps.iconUrl ?? resolveSlackIconUrl();
  let applyIdentity = identityVerdict !== 'no';
  const identityFields = () =>
    applyIdentity
      ? { username: VIOLEMA_SLACK_USERNAME, ...(iconUrl ? { icon_url: iconUrl } : {}) }
      : {};

  let rootTs: string | null = input.threadTs ?? null;
  let firstTs: string | null = null;
  let identityDowngraded = false;

  for (const [index, markdownText] of chunks.entries()) {
    const payload = () => ({
      channel,
      markdown_text: markdownText,
      // Continuations thread under the first message so a long brief stays
      // one conversation rather than N top-level posts.
      ...(rootTs ? { thread_ts: rootTs } : {}),
      ...identityFields(),
    });

    let response: unknown;
    try {
      await input.onExternalRequestStart?.();
      response = await execute(connection.actionName, payload(), {
        entityId: input.workspaceId,
        signal: input.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The one retry we allow, and only for a scope rejection Slack raises
      // before the message is delivered. Branding must never cost a send.
      if (!applyIdentity || !isIdentityScopeRejection(message)) throw error;
      applyIdentity = false;
      identityDowngraded = true;
      await input.onExternalRequestStart?.();
      response = await execute(connection.actionName, payload(), {
        entityId: input.workspaceId,
        signal: input.signal,
      });
    }

    let data: Record<string, unknown>;
    try {
      data = readEnvelope(response, connection.actionName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!applyIdentity || !isIdentityScopeRejection(message)) throw error;
      applyIdentity = false;
      identityDowngraded = true;
      await input.onExternalRequestStart?.();
      const retry = await execute(connection.actionName, payload(), {
        entityId: input.workspaceId,
        signal: input.signal,
      });
      data = readEnvelope(retry, connection.actionName);
    }

    if (index === 0) {
      firstTs = readTimestamp(data);
      if (!rootTs) rootTs = firstTs;
    }
  }

  return {
    success: true,
    channel: 'slack',
    to: input.to,
    status: 'delivered',
    sent_at: new Date().toISOString(),
    slack_channel: channel,
    slack_ts: firstTs,
    transport: 'composio' as const,
    partner_toolkit: connection.toolkit,
    // Reported so a run's record shows whether the message actually carried
    // Violema's identity, rather than leaving it to be guessed from Slack.
    posted_as_violema: applyIdentity,
    ...(identityDowngraded
      ? { identity_downgraded: true as const, identity_downgrade_reason: 'chat:write.customize' }
      : {}),
    ...(chunks.length > 1 ? { slack_parts: chunks.length } : {}),
  };
}

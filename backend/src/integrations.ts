import { isEmailSuppressed } from './emailSuppressions';
import { buildSlackMessagePayload, chunkSlackBlocks } from './slackBlocks';
import { collectLinkImageBlocks } from './linkPreviews';
import { usesInternalDemoRouting } from './platform/tenancy';
import {
  preflightTenantSlackMessage,
  sendTenantSlackMessage,
  type TenantSlackDeps,
} from './integrationGateway/slackDelivery';
import { sanitizeIntegrationDiagnostic } from './integrationGateway/diagnostics';

export interface SendMessageInput {
  to: string;
  subject?: string;
  body: string;
  channel?: string;
  threadTs?: string;
  evidenceLinks?: Array<{ url: string; label: string }>;
  attachedImages?: Array<{ url: string; alt: string }>;
  /**
   * Whose workspace this send belongs to.
   *
   * Two cross-tenant safety properties depend on it:
   *   - the raise-period `#violema-demo` channel aliases apply only to our own
   *     and demo workspaces, never to a tenant's channel names;
   *   - a tenant's Slack delivery routes through THEIR Composio connection
   *     rather than Violema's bot token.
   *
   * Omitted means "unattributed / internal", which preserves the behavior every
   * existing call site had before multi-tenancy.
   */
  workspaceId?: string;
  /** Test seam for the tenant Composio Slack path; never set in production. */
  tenantSlackDeps?: TenantSlackDeps;
  /** Cancels provider lookup/send requests at the automation step deadline. */
  signal?: AbortSignal;
  /** Durable journal hook awaited immediately before each physical send. */
  onExternalRequestStart?: () => void | Promise<void>;
}

// Teams stays out of this union until a real connector exists — the enum is
// model-facing, and an advertised channel with a stub sender fails live runs.
type MessageChannel = 'slack' | 'email';

interface ValidatedMessageTarget {
  channel: MessageChannel;
  target: string;
  normalizedTarget: string;
}

interface SlackConversation {
  id?: string;
  name?: string;
  name_normalized?: string;
}

interface SlackConversationListResponse {
  ok?: boolean;
  error?: string;
  needed?: string;
  channels?: SlackConversation[];
  response_metadata?: {
    next_cursor?: string;
  };
}

const DEFAULT_SLACK_CHANNEL_ALIASES: Record<string, string> = {
  // Raise-period reroute: every founder-report send lands in the demo channel
  // until the pre-seed closes. Revert both entries to '#all-purple-orange' after.
  //
  // Applied only to our own and demo workspaces — see `usesInternalDemoRouting`.
  // A tenant's '#founders' means THEIR channel, and must never be rewritten
  // into ours.
  '#founders': '#violema-demo',
  '#all-purple-orange': '#violema-demo',
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function readBoundedResponseText(response: Response, maxBytes = 4_096): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes - total;
      const bounded = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(Buffer.from(bounded));
      total += bounded.byteLength;
      if (value.byteLength > remaining) {
        truncated = true;
        break;
      }
    }
    if (total >= maxBytes) truncated = true;
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseErrorResponse(response: Response): Promise<string> {
  const text = await readBoundedResponseText(response);
  if (!text) return `HTTP ${response.status}`;

  try {
    const data = JSON.parse(text) as {
      error?: string;
      detail?: string;
      errors?: Array<{ message?: string }>;
    };

    if (data.error) return sanitizeIntegrationDiagnostic(data.error);
    if (data.detail) return sanitizeIntegrationDiagnostic(data.detail);
    if (data.errors?.length) {
      return sanitizeIntegrationDiagnostic(
        data.errors.map((item) => item.message).filter(Boolean).join('; '),
      );
    }
  } catch {
    return sanitizeIntegrationDiagnostic(text);
  }

  return sanitizeIntegrationDiagnostic(text);
}

export async function searchWeb(query: string, numResults = 5, signal?: AbortSignal) {
  const apiKey = getRequiredEnv('TAVILY_API_KEY');
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      topic: 'general',
      include_answer: false,
      include_raw_content: false,
      include_favicon: true,
      max_results: Math.min(Math.max(numResults || 5, 1), 10),
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed: ${await parseErrorResponse(response)}`);
  }

  const data = await response.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      score?: number;
      favicon?: string;
    }>;
    response_time?: string;
  };

  const results = (data.results || []).map((item) => ({
    title: item.title || 'Untitled result',
    url: item.url || '',
    snippet: item.content || '',
    score: item.score ?? null,
    favicon: item.favicon || null,
  }));

  return {
    query,
    results,
    total_results: results.length,
    search_time_ms: data.response_time ? Math.round(Number(data.response_time) * 1000) : null,
    provider: 'tavily',
  };
}

function inferMessageChannel(input: SendMessageInput): MessageChannel {
  if (input.channel === 'slack' || input.channel === 'email') {
    return input.channel;
  }

  if (input.to.includes('@') && !input.to.startsWith('@')) {
    return 'email';
  }

  return 'slack';
}

function isSlackChannelId(value: string) {
  return /^[CGD][A-Z0-9]{8,}$/.test(value);
}

function isSlackUserId(value: string) {
  return /^U[A-Z0-9]{8,}$/.test(value);
}

function toSlackAliasEnvName(target: string) {
  const normalized = target
    .trim()
    .replace(/^#/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized ? `SLACK_CHANNEL_${normalized}` : '';
}

function normalizeSlackChannelName(target: string) {
  return target.trim().replace(/^#/, '').toLowerCase();
}

function readSlackAliasMap(workspaceId?: string) {
  // The hardcoded raise-period reroutes are ours; the SLACK_CHANNEL_ALIASES env
  // var is an admin escape hatch and stays server-wide, since the error text
  // below tells admins to set it.
  const defaults = usesInternalDemoRouting(workspaceId)
    ? { ...DEFAULT_SLACK_CHANNEL_ALIASES }
    : {};
  const raw = process.env.SLACK_CHANNEL_ALIASES?.trim();
  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return {
      ...defaults,
      ...Object.fromEntries(
        Object.entries(parsed)
          .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
          .map(([key, value]) => [key.trim().toLowerCase(), value.trim()])
          .filter(([, value]) => Boolean(value)),
      ),
    };
  } catch {
    return defaults;
  }
}

async function findSlackChannelIdByName(target: string, signal?: AbortSignal) {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  const targetName = normalizeSlackChannelName(target);
  if (!token || !targetName) return null;

  let cursor = '';
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);

    const response = await fetch(`https://slack.com/api/conversations.list?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal,
    });
    const payload = await response.json().catch(() => null) as SlackConversationListResponse | null;

    if (!response.ok || !payload?.ok) {
      if (payload?.error === 'missing_scope') {
        const needed = payload.needed ? ` Missing scope: ${payload.needed}.` : '';
        throw new Error(`Slack channel names need channels:read/groups:read access, or use a channel ID like C0123456789.${needed}`);
      }
      return null;
    }

    const match = (payload.channels || []).find((channel) => {
      const names = [channel.name, channel.name_normalized].filter((name): name is string => Boolean(name));
      return names.some((name) => normalizeSlackChannelName(name) === targetName);
    });

    if (match?.id && isSlackChannelId(match.id)) {
      return match.id;
    }

    cursor = payload.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }

  return null;
}

async function resolveSlackTarget(target: string, workspaceId?: string, signal?: AbortSignal) {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    throw new Error('Slack target is required.');
  }

  if (isSlackChannelId(normalizedTarget) || isSlackUserId(normalizedTarget)) {
    return normalizedTarget;
  }

  const aliasKey = normalizedTarget.startsWith('#') ? normalizedTarget.toLowerCase() : `#${normalizedTarget.toLowerCase()}`;
  const aliasMap = readSlackAliasMap(workspaceId);
  const mappedTarget = aliasMap[aliasKey];
  if (mappedTarget) {
    if (isSlackChannelId(mappedTarget) || isSlackUserId(mappedTarget)) {
      return mappedTarget;
    }

    const resolvedMappedChannelId = await findSlackChannelIdByName(mappedTarget, signal);
    if (resolvedMappedChannelId) {
      return resolvedMappedChannelId;
    }
  }

  const aliasEnv = process.env[toSlackAliasEnvName(aliasKey)];
  if (aliasEnv && (isSlackChannelId(aliasEnv.trim()) || isSlackUserId(aliasEnv.trim()))) {
    return aliasEnv.trim();
  }

  const resolvedChannelId = await findSlackChannelIdByName(normalizedTarget, signal);
  if (resolvedChannelId) {
    return resolvedChannelId;
  }

  throw new Error(
    `Slack target "${normalizedTarget}" is not visible to Violema. Use a visible channel name like #project-nexus, a channel ID like C0123456789, or invite the Violema Slack app to private channels. ` +
    `Admins can also set ${toSlackAliasEnvName(aliasKey)} or SLACK_CHANNEL_ALIASES.`,
  );
}

export async function validateMessageTarget(input: {
  to: string;
  channel?: string;
  workspaceId?: string;
  signal?: AbortSignal;
}) {
  const channel = inferMessageChannel({ ...input, body: '' });
  const target = input.to.trim();

  if (!target) {
    throw new Error('Message target is required.');
  }

  if (channel === 'email') {
    if (!/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(target)) {
      throw new Error('Email target must be a valid email address.');
    }

    return {
      channel,
      target,
      normalizedTarget: target.toLowerCase(),
    } satisfies ValidatedMessageTarget;
  }

  if (channel === 'slack') {
    return {
      channel,
      target,
      normalizedTarget: await resolveSlackTarget(target, input.workspaceId, input.signal),
    } satisfies ValidatedMessageTarget;
  }

  return {
    channel,
    target,
    normalizedTarget: target,
  } satisfies ValidatedMessageTarget;
}

async function sendSlackMessage(input: SendMessageInput) {
  const token = getRequiredEnv('SLACK_BOT_TOKEN');
  const payload = buildSlackMessagePayload({ subject: input.subject, body: input.body });
  if (payload.blocks && input.subject) {
    // Rendered run charts lead, then evidence-article previews; both sit above
    // the branded footer. Fail-soft — misses never block the send.
    const chartBlocks = (input.attachedImages ?? [])
      .filter((image) => /^https:\/\//.test(image.url))
      .map((image) => ({ type: 'image' as const, image_url: image.url, alt_text: image.alt || 'Run chart' }));
    // Generated intelligence outranks publisher art: with real charts attached,
    // at most one article preview rides along.
    const articleBlocks = await collectLinkImageBlocks(input.body, {
      candidates: input.evidenceLinks,
      limit: chartBlocks.length > 0 ? 1 : 3,
      signal: input.signal,
    });
    const extraBlocks = [...chartBlocks, ...articleBlocks];
    if (extraBlocks.length > 0) {
      payload.blocks.splice(payload.blocks.length - 1, 0, ...extraBlocks);
    }
  }
  const validated = await validateMessageTarget({
    to: input.to,
    channel: 'slack',
    workspaceId: input.workspaceId,
    signal: input.signal,
  });

  const post = async (body: Record<string, unknown>) => {
    await input.onExternalRequestStart?.();
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    const data = await response.json() as {
      ok?: boolean;
      error?: string;
      ts?: string;
      channel?: string;
    };
    if (!response.ok || !data.ok) {
      throw new Error(`Slack send failed: ${data.error || response.statusText}`);
    }
    return data;
  };

  // Briefs larger than one Slack message split into threaded continuations
  // under the first message instead of truncating.
  const chunks = payload.blocks ? chunkSlackBlocks(payload.blocks) : [null];
  let first: { ts?: string; channel?: string } | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const data = await post({
      channel: validated.normalizedTarget,
      text: index === 0 ? payload.text : '…continued',
      mrkdwn: true,
      ...(chunk ? { blocks: chunk, unfurl_links: false, unfurl_media: false } : {}),
      ...(index === 0 && input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(index > 0 && first?.ts ? { thread_ts: first.ts } : {}),
    });
    if (index === 0) first = data;
  }

  return {
    success: true,
    channel: 'slack',
    to: validated.target,
    status: 'delivered',
    sent_at: new Date().toISOString(),
    slack_channel: first?.channel || validated.normalizedTarget,
    slack_ts: first?.ts || null,
    ...(chunks.length > 1 ? { slack_parts: chunks.length } : {}),
  };
}

/**
 * A bare address makes inboxes display its local part as the sender — Max's
 * first tester email arrived "from hello". Every send goes out as
 * `Violema <address>` unless the operator already configured a display name.
 */
export function formatEmailFrom(fromEmail: string): string {
  const trimmed = fromEmail.trim();
  if (trimmed.includes('<')) return trimmed;
  return `Violema <${trimmed}>`;
}

function readEmailDeliveryConfig(target: string) {
  // The promise made to Postmark at account approval: bounced and complained
  // addresses stop receiving mail. Checked before any provider call so a
  // suppressed recipient fails honestly instead of burning sender reputation.
  const suppression = isEmailSuppressed(target);
  if (suppression) {
    throw new Error(
      `Email to ${target} is blocked: the address ${
        suppression.reason === 'spam_complaint' ? 'marked our mail as spam' : 'hard-bounced'
      } on ${suppression.suppressedAt.slice(0, 10)}. Remove it from email-suppressions.json only if the mailbox is confirmed working again.`,
    );
  }

  const apiKey = getRequiredEnv('POSTMARK_API_KEY');
  const fromEmail = getRequiredEnv('POSTMARK_FROM_EMAIL');
  return { apiKey, fromEmail };
}

async function sendEmailMessage(input: SendMessageInput) {
  const { apiKey, fromEmail } = readEmailDeliveryConfig(input.to);

  await input.onExternalRequestStart?.();
  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Postmark-Server-Token': apiKey,
    },
    body: JSON.stringify({
      From: formatEmailFrom(fromEmail),
      To: input.to,
      Subject: input.subject || 'Message from Violema',
      TextBody: input.body,
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error(`Postmark send failed: ${await parseErrorResponse(response)}`);
  }

  return {
    success: true,
    channel: 'email',
    to: input.to,
    subject: input.subject || 'Message from Violema',
    status: 'delivered',
    sent_at: new Date().toISOString(),
    provider: 'postmark',
  };
}

/** Validate the exact route without crossing a message-send boundary. */
export async function preflightMessageDelivery(input: SendMessageInput) {
  const channel = inferMessageChannel(input);
  if (channel === 'slack') {
    if (!usesInternalDemoRouting(input.workspaceId)) {
      await preflightTenantSlackMessage({
        workspaceId: input.workspaceId as string,
        to: input.to,
        body: input.body,
        subject: input.subject,
        signal: input.signal,
      }, input.tenantSlackDeps ?? {});
      return;
    }
    getRequiredEnv('SLACK_BOT_TOKEN');
    await validateMessageTarget({
      to: input.to,
      channel: 'slack',
      workspaceId: input.workspaceId,
      signal: input.signal,
    });
    return;
  }
  if (channel === 'email') {
    await validateMessageTarget({ to: input.to, channel: 'email', workspaceId: input.workspaceId });
    readEmailDeliveryConfig(input.to);
    return;
  }
  throw new Error(`Unsupported delivery channel: ${channel}`);
}

export async function sendMessage(input: SendMessageInput) {
  const channel = inferMessageChannel(input);

  if (channel === 'slack') {
    // A tenant's Slack delivery goes through the tenant's own Composio
    // connection. There is no fallback to `SLACK_BOT_TOKEN`: our bot is not in
    // their Slack, and using it would either misdeliver into our workspace or
    // post under an identity they never authorized. No connection means the
    // send fails and names "Connect Slack".
    if (!usesInternalDemoRouting(input.workspaceId)) {
      return sendTenantSlackMessage(
        {
          workspaceId: input.workspaceId as string,
          to: input.to,
          body: input.body,
          subject: input.subject,
          threadTs: input.threadTs,
          signal: input.signal,
          onExternalRequestStart: input.onExternalRequestStart,
        },
        input.tenantSlackDeps ?? {},
      );
    }

    return sendSlackMessage({ ...input, channel });
  }

  if (channel === 'email') {
    return sendEmailMessage({ ...input, channel });
  }

  throw new Error(`Unsupported delivery channel: ${channel}`);
}

export function getIntegrationStatus() {
  return {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    tavily: Boolean(process.env.TAVILY_API_KEY),
    postmark: Boolean(process.env.POSTMARK_API_KEY && process.env.POSTMARK_FROM_EMAIL),
    slack: Boolean(process.env.SLACK_BOT_TOKEN),
  };
}

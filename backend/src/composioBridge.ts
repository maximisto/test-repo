/**
 * Composio Bridge — turns Composio's pre-built integrations into tools
 * Claude can call. Activated by setting COMPOSIO_API_KEY in the environment.
 *
 * When inactive, every helper here returns false / null gracefully so the rest
 * of the backend keeps working with native + mock tools.
 *
 * See docs/INTEGRATIONS_ARCHITECTURE.md for the full strategy.
 */

import {
  describeAuthConfigChoice,
  selectComposioAuthConfig,
  type ComposioAuthConfigChoice,
  type ComposioAuthConfigSummary,
} from './composioAuthConfig';

export interface ComposioClientAdapter {
  tools: {
    execute(
      slug: string,
      body: {
        userId: string;
        arguments: Record<string, unknown>;
        dangerouslySkipVersionCheck: true;
      },
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
  authConfigs: {
    /**
     * Items carry more than an id: the SDK returns `name`, `status`, and the
     * camelCase `isComposioManaged` that decides which config a connection is
     * opened against. See `composioAuthConfig.ts` for why that choice matters.
     */
    list(query: { toolkit: string }): Promise<{ items: ComposioAuthConfigSummary[] }>;
    create(
      toolkitSlug: string,
      options: {
        type: 'use_composio_managed_auth';
        name: string;
      },
    ): Promise<{ id: string }>;
  };
  connectedAccounts: {
    link(
      userId: string,
      authConfigId: string,
      options: { allowMultiple: true; callbackUrl?: string },
    ): Promise<{ id?: string | null; redirectUrl?: string | null }>;
    list(query: {
      userIds: string[];
      statuses: ComposioConnectionStatus[];
      /** Page token from the previous response's `nextCursor`. Omit for page 1. */
      cursor?: string;
    }, options?: { signal?: AbortSignal }): Promise<{
      items: Array<{
        id?: string | null;
        toolkit?: { slug?: string } | null;
        status?: string | null;
        createdAt?: string | null;
        /**
         * The live credential blob. It carries `access_token`, `refresh_token`,
         * `api_key`, and friends alongside `scope`, so it is NEVER spread or
         * logged — `readGrantedScopes` lifts the one field we need by name.
         */
        state?: unknown;
      }>;
      /** Present while more pages remain (`ConnectedAccountListResponseSchema`). */
      nextCursor?: string | null;
      totalPages?: number;
    }>;
    delete(nanoid: string): Promise<unknown>;
  };
}

/**
 * Composio's connected-account lifecycle, verified against the installed SDK
 * (`ConnectedAccountListParamsSchema.statuses`) rather than documentation.
 *
 * Only `ACTIVE` means usable. `EXPIRED`, `FAILED`, `INACTIVE`, and `REVOKED` are
 * all "not connected" — a workspace holding one of those can no more run a
 * mission than one holding nothing.
 */
export const COMPOSIO_CONNECTION_STATUSES = [
  'INITIALIZING',
  'INITIATED',
  'ACTIVE',
  'FAILED',
  'EXPIRED',
  'INACTIVE',
  'REVOKED',
] as const;

export type ComposioConnectionStatus = (typeof COMPOSIO_CONNECTION_STATUSES)[number];

/**
 * Statuses that mean "the user started an OAuth flow and never finished it".
 *
 * A tenant abandoned a Drive consent tab twice and left two connections parked
 * here forever. The UI showed nothing at all, so they had no way to tell that a
 * retry would just add a third.
 */
export const COMPOSIO_PENDING_STATUSES: ComposioConnectionStatus[] = ['INITIATED', 'INITIALIZING'];

/** One connection as Composio reports it, with credentials deliberately absent. */
export interface ComposioConnectionRecord {
  id: string;
  toolkit: string;
  status: ComposioConnectionStatus;
  /** When Composio created the connection record. Used as `initiatedAt`. */
  createdAt?: string;
  /**
   * OAuth scopes the provider actually granted, or `null` when the connection
   * does not expose them. `null` means "cannot tell" and must never be rendered
   * as "no scopes" — the difference decides whether we can honestly claim a
   * capability is missing.
   */
  grantedScopes: string[] | null;
}

/** A workspace's live connection to one toolkit, as Composio reports it. */
export interface ComposioConnectedAccount {
  id: string;
  toolkit: string;
}

/** What `link()` hands back: where to send the user, and the request to poll. */
export interface ComposioConnectionInit {
  redirectUrl: string | null;
  connectionRequestId?: string;
  /**
   * Which auth config this connection was opened against. Ids, names and flags
   * only — never credentials. Present so an operator can tell from the response
   * (or the ledger) *which* of an account's several auth configs a user just
   * authorised against, instead of discovering it days later as a scope error.
   */
  authConfig?: ComposioAuthConfigChoice;
}

/**
 * Connected apps plus whether the lookup actually succeeded. An empty list with
 * `ok: false` means Composio was unreachable, which the UI must render as
 * "temporarily unavailable" rather than "nothing connected".
 */
export interface ComposioConnectedAppsResult {
  apps: string[];
  ok: boolean;
}

export type ComposioDisconnectResult =
  | { status: 'disconnected'; toolkit: string; removed: number }
  | { status: 'not_connected'; toolkit: string }
  | { status: 'failed'; toolkit: string; message: string };

export interface ComposioBridge {
  isEnabled(): boolean;
  /**
   * Every connection this entity holds, in any lifecycle state, with granted
   * scopes where the provider exposes them. Superset of
   * `listConnectedAccounts`, which only ever reports `ACTIVE`.
   */
  listConnectionInventory(ctx: ComposioExecutionContext): Promise<ComposioConnectionRecord[]>;
  /**
   * Delete this entity's stranded (INITIATED / INITIALIZING) connections for one
   * toolkit. Never touches an ACTIVE connection — cancelling a half-finished
   * OAuth attempt must not disconnect a working integration.
   */
  deletePendingConnections(
    appName: string,
    ctx: ComposioExecutionContext,
  ): Promise<{ toolkit: string; removed: number }>;
  executeAction(
    actionName: string,
    input: Record<string, unknown>,
    ctx: ComposioExecutionContext,
  ): Promise<unknown>;
  startConnection(
    appName: string,
    ctx: ComposioExecutionContext,
    options?: { callbackUrl?: string },
  ): Promise<ComposioConnectionInit>;
  listConnectedAccounts(
    ctx: ComposioExecutionContext,
  ): Promise<ComposioConnectedAccount[]>;
  listConnectedApps(ctx: ComposioExecutionContext): Promise<string[]>;
  disconnectApp(
    appName: string,
    ctx: ComposioExecutionContext,
  ): Promise<ComposioDisconnectResult>;
}

/** Composio toolkit slugs are lowercase alphanumeric; normalize loosely to match. */
function toToolkitSlug(appName: string): string {
  return appName.trim().toLowerCase();
}

/**
 * Upper bound on cursor pages walked for one connected-accounts read.
 *
 * A real workspace holds tens of accounts, not thousands, so this only trips on
 * a cursor that never terminates. Exceeding it throws rather than returning a
 * partial list: a truncated read is exactly the bug this pagination fixes —
 * it would let "disconnect all" leave an account behind while reporting
 * success, and would under-report readiness. Every caller already treats a
 * thrown lookup as fail-closed (degraded / `failed` / no connections).
 */
const MAX_CONNECTED_ACCOUNT_PAGES = 25;

/**
 * Lift the granted OAuth scopes out of a connection's `state`, and nothing else.
 *
 * `state` is the live credential blob. On an ACTIVE OAuth2 connection the SDK's
 * `Oauth2ActiveConnectionDataSchema` puts `access_token`, `refresh_token`,
 * `id_token`, `api_key`, `bearer_token` and `proxy_password` right next to
 * `scope`. So this reads `scope` by name and returns strings — the object is
 * never spread, copied, returned, or logged, the same rule
 * `describeAuthConfigChoice` follows for auth configs.
 *
 * Two shapes are accepted because two are real: the SDK normalises to
 * `state.scope`, while the raw REST wire wraps credentials as
 * `state.val.scope`. Slack also reports the *user* grant separately under
 * `authed_user.scope`, which is where a user-token connection's scopes live.
 *
 * Returns `null` — never `[]` — when no scope field is present. "The provider
 * did not tell us" and "the provider granted nothing" are different facts, and
 * only the second one justifies telling a customer a capability is missing.
 */
export function readGrantedScopes(state: unknown): string[] | null {
  if (!state || typeof state !== 'object') return null;
  const container = state as Record<string, unknown>;
  const nested = container.val && typeof container.val === 'object'
    ? (container.val as Record<string, unknown>)
    : container;

  const authedUser = nested.authed_user && typeof nested.authed_user === 'object'
    ? (nested.authed_user as Record<string, unknown>)
    : undefined;

  const scopes = new Set<string>();
  let sawScopeField = false;

  for (const raw of [nested.scope, authedUser?.scope]) {
    if (raw === undefined || raw === null) continue;
    sawScopeField = true;
    // Providers are inconsistent: Google returns a space-delimited string,
    // Slack a comma-delimited one, and some connections an array.
    const parts = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string')
      : typeof raw === 'string'
        ? raw.split(/[\s,]+/)
        : [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) scopes.add(trimmed);
    }
  }

  if (!sawScopeField) return null;
  return Array.from(scopes);
}

/** Coerce Composio's status string, defaulting unknown values to fail-closed. */
function readConnectionStatus(raw: unknown): ComposioConnectionStatus {
  const value = typeof raw === 'string' ? raw.toUpperCase() : '';
  return (COMPOSIO_CONNECTION_STATUSES as readonly string[]).includes(value)
    ? (value as ComposioConnectionStatus)
    // An unrecognised status is treated as failed rather than active: a new
    // Composio lifecycle state must never silently count as "connected".
    : 'FAILED';
}

export function createComposioBridge(
  client: ComposioClientAdapter | null,
): ComposioBridge {
  // Shared by listConnectedApps and disconnectApp. A free function rather than
  // `this.listConnectedAccounts` so a destructured method still works.
  //
  // Walks the cursor to exhaustion. `connectedAccounts.list` is paginated, and
  // reading only page one silently drops accounts: with `allowMultiple: true`
  // a second Gmail account can sit on page two, survive a "disconnect all",
  // and still authorise runs while the route answers `ok: true`.
  async function readConnectedAccounts(
    ctx: ComposioExecutionContext,
  ): Promise<ComposioConnectedAccount[]> {
    if (!client) return [];

    const accounts: ComposioConnectedAccount[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
      const connections = await client.connectedAccounts.list({
        userIds: [ctx.entityId],
        statuses: ['ACTIVE'],
        ...(cursor ? { cursor } : {}),
      }, ctx.signal ? { signal: ctx.signal } : undefined);

      for (const connection of connections.items) {
        const toolkit = connection.toolkit?.slug ?? '';
        if (!toolkit) continue;
        accounts.push({ id: connection.id ?? '', toolkit });
      }

      const nextCursor = connections.nextCursor ?? undefined;
      if (!nextCursor) return accounts;
      cursor = nextCursor;
    }

    throw new Error(
      `Composio returned more than ${MAX_CONNECTED_ACCOUNT_PAGES} pages of connected accounts; refusing to act on a partial list.`,
    );
  }

  /**
   * The same paginated walk, but across every lifecycle state and keeping the
   * status, creation time, and granted scopes. Separate from
   * `readConnectedAccounts` so the hot readiness path keeps asking Composio the
   * narrow `ACTIVE`-only question it always has.
   */
  async function readConnectionInventoryPages(
    ctx: ComposioExecutionContext,
  ): Promise<ComposioConnectionRecord[]> {
    if (!client) return [];

    const records: ComposioConnectionRecord[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
      const connections = await client.connectedAccounts.list({
        userIds: [ctx.entityId],
        statuses: [...COMPOSIO_CONNECTION_STATUSES],
        ...(cursor ? { cursor } : {}),
      }, ctx.signal ? { signal: ctx.signal } : undefined);

      for (const connection of connections.items) {
        const toolkit = connection.toolkit?.slug ?? '';
        if (!toolkit) continue;
        records.push({
          id: connection.id ?? '',
          toolkit,
          status: readConnectionStatus(connection.status),
          ...(connection.createdAt ? { createdAt: connection.createdAt } : {}),
          grantedScopes: readGrantedScopes(connection.state),
        });
      }

      const nextCursor = connections.nextCursor ?? undefined;
      if (!nextCursor) return records;
      cursor = nextCursor;
    }

    throw new Error(
      `Composio returned more than ${MAX_CONNECTED_ACCOUNT_PAGES} pages of connected accounts; refusing to act on a partial list.`,
    );
  }

  return {
    isEnabled() {
      return client !== null;
    },

    listConnectionInventory: readConnectionInventoryPages,

    async deletePendingConnections(appName, ctx) {
      const toolkit = toToolkitSlug(appName);
      if (!client) return { toolkit, removed: 0 };

      const stranded = (await readConnectionInventoryPages(ctx)).filter(
        (connection) =>
          connection.toolkit === toolkit
          && connection.id
          && COMPOSIO_PENDING_STATUSES.includes(connection.status),
      );

      let removed = 0;
      for (const connection of stranded) {
        // One failure must not strand the rest — a half-cleaned list is still
        // better than none, and the count reported stays truthful either way.
        try {
          await client.connectedAccounts.delete(connection.id);
          removed += 1;
        } catch (err) {
          console.error(
            `[composio] could not delete pending ${toolkit} connection:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      return { toolkit, removed };
    },

    async executeAction(actionName, input, ctx) {
      if (!client) {
        throw new Error('Composio is not configured. Set COMPOSIO_API_KEY to enable.');
      }

      return await client.tools.execute(actionName, {
        userId: ctx.entityId,
        arguments: input,
        // Violema accepts dynamic partner-tool names, so there is no single
        // toolkit version to pin at this boundary.
        dangerouslySkipVersionCheck: true,
      }, ctx.signal ? { signal: ctx.signal } : undefined);
    },

    async startConnection(appName, ctx, options) {
      if (!client) return { redirectUrl: null };

      const toolkitSlug = toToolkitSlug(appName);
      const authConfigs = await client.authConfigs.list({ toolkit: toolkitSlug });

      // Never `items[0]`: an account can hold several auth configs per toolkit,
      // and picking the wrong one silently yields a connection with the wrong
      // scopes — or one only allowlisted accounts can authorise against.
      let choice = selectComposioAuthConfig(toolkitSlug, authConfigs.items);

      if (!choice) {
        const createdName = `${toolkitSlug} Auth Config`;
        const created = await client.authConfigs.create(toolkitSlug, {
          type: 'use_composio_managed_auth',
          name: createdName,
        });
        // Managed by construction — that is the type we ask for above.
        choice = { id: created.id, name: createdName, managed: true, reason: 'created' };
      }

      // Ids, names and flags only. The SDK's list items carry a `credentials`
      // object (OAuth client id/secret for custom configs), so the payload is
      // built field by field in `describeAuthConfigChoice`, never spread.
      console.log('[composio] auth config selected', describeAuthConfigChoice(toolkitSlug, choice));

      const connection = await client.connectedAccounts.link(ctx.entityId, choice.id, {
        allowMultiple: true,
        // Where Composio returns the user after their OAuth round trip. Always
        // a server-derived origin — never anything taken from the request.
        ...(options?.callbackUrl ? { callbackUrl: options.callbackUrl } : {}),
      });
      return {
        redirectUrl: connection.redirectUrl ?? null,
        ...(connection.id ? { connectionRequestId: connection.id } : {}),
        authConfig: choice,
      };
    },

    listConnectedAccounts: readConnectedAccounts,

    async listConnectedApps(ctx) {
      return (await readConnectedAccounts(ctx)).map((connection) => connection.toolkit);
    },

    async disconnectApp(appName, ctx) {
      const toolkit = toToolkitSlug(appName);
      if (!client) {
        return { status: 'failed', toolkit, message: 'Composio is not configured.' };
      }

      const matches = (await readConnectedAccounts(ctx)).filter(
        (connection) => connection.toolkit === toolkit && connection.id,
      );
      if (matches.length === 0) {
        return { status: 'not_connected', toolkit };
      }

      // A workspace can hold more than one active account per toolkit
      // (`allowMultiple: true` on link), so disconnect means all of them —
      // leaving one behind would keep the workflow silently readable.
      for (const match of matches) {
        await client.connectedAccounts.delete(match.id);
      }
      return { status: 'disconnected', toolkit, removed: matches.length };
    },
  };
}

type ComposioModule = {
  Composio: new (config: { apiKey: string }) => unknown;
};

// The backend compiles to CommonJS while the supported Composio SDK is
// ESM-only. Using native import here preserves lazy loading without converting
// the entire backend module system.
const importEsmModule = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<ComposioModule>;

let clientPromise: Promise<ComposioClientAdapter | null> | null = null;
let clientLoadFailed = false;

async function getClient(): Promise<ComposioClientAdapter | null> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return null;
  if (clientPromise) return await clientPromise;

  clientPromise = (async () => {
    try {
      const { Composio } = await importEsmModule('@composio/core');
      const client = new Composio({ apiKey }) as ComposioClientAdapter;
      console.log('[composio] enabled');
      return client;
    } catch (err) {
      clientLoadFailed = true;
      console.error('[composio] failed to initialise:', err instanceof Error ? err.message : err);
      return null;
    }
  })();

  return await clientPromise;
}

export function isComposioEnabled(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY) && !clientLoadFailed;
}

/**
 * Composio actions are namespaced like `SLACK_SEND_MESSAGE`, `GITHUB_CREATE_ISSUE`,
 * etc. We treat any tool whose name matches this convention as a Composio call.
 */
export function isComposioToolName(name: string): boolean {
  return /^[A-Z][A-Z_]*_[A-Z][A-Z_]*$/.test(name);
}

export interface ComposioExecutionContext {
  /** Stable per-workspace identifier — Composio uses this to look up OAuth credentials. */
  entityId: string;
  /** Cancels the upstream HTTP request when an automation deadline expires. */
  signal?: AbortSignal;
}

/**
 * Execute a Composio action on behalf of the entity (user/workspace).
 * The entity must have already connected the relevant integration via Composio's
 * hosted OAuth flow.
 */
export async function executeComposioAction(
  actionName: string,
  input: Record<string, unknown>,
  ctx: ComposioExecutionContext,
): Promise<unknown> {
  const bridge = createComposioBridge(await getClient());
  return await bridge.executeAction(actionName, input, ctx);
}

/**
 * Start a Composio OAuth flow for this entity. Composio hosts the consent UI —
 * we hand the caller the redirect plus the connection request id so a caller
 * that wants to can poll for completion.
 *
 * `callbackUrl` must always be derived from server configuration. Deriving it
 * from request headers would turn this endpoint into an open redirect.
 */
export async function startComposioConnection(
  appName: string,
  ctx: ComposioExecutionContext,
  options?: { callbackUrl?: string },
): Promise<ComposioConnectionInit> {
  try {
    const bridge = createComposioBridge(await getClient());
    return await bridge.startConnection(appName, ctx, options);
  } catch (err) {
    console.error(`[composio] connection init failed for ${appName}:`, err);
    return { redirectUrl: null };
  } finally {
    // The workspace's connection set is about to change. Drop the memos now so
    // the refetch that follows the OAuth round trip reads Composio, not a
    // snapshot taken before the user ever left for the consent screen. The
    // inventory memo matters most here: a connection is about to appear as
    // INITIATED, and that is exactly what the pending list needs to show.
    invalidatePartnerConnectionCache(ctx.entityId);
    invalidateConnectionInventoryCache(ctx.entityId);
  }
}

const DEFAULT_PARTNER_CONNECTION_CACHE_MS = 20_000;

type PartnerConnectionCacheEntry = { apps: string[]; expiresAt: number };

/**
 * Per-workspace memo of the connected-toolkit read, keyed by `entityId`.
 *
 * The Dashboard editor refires `GET /api/workflows/:id/readiness` on every
 * keystroke of a mission name, and each of those used to become a live
 * Composio call on one shared API key. A few seconds of memoisation collapses
 * a burst of typing into one upstream request.
 *
 * Deliberately small in scope:
 * - only successful reads are stored; an outage is never memoised, so a
 *   `degraded` response cannot outlive the outage that caused it
 * - `disconnectApp` enumerates accounts through the bridge directly, so a
 *   revocation always acts on a fresh list
 * - connect and disconnect both invalidate the entry they affect
 *
 * `COMPOSIO_STATUS_CACHE_MS=0` disables it entirely.
 */
const partnerConnectionCache = new Map<string, PartnerConnectionCacheEntry>();

function partnerConnectionCacheTtlMs(): number {
  const raw = process.env.COMPOSIO_STATUS_CACHE_MS?.trim();
  if (!raw) return DEFAULT_PARTNER_CONNECTION_CACHE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PARTNER_CONNECTION_CACHE_MS;
  return parsed;
}

/** Drop one workspace's memo, or every workspace's when called with no id. */
export function invalidatePartnerConnectionCache(entityId?: string): void {
  if (entityId === undefined) partnerConnectionCache.clear();
  else partnerConnectionCache.delete(entityId);
}

/**
 * Returns the apps this entity has currently connected (active integrations).
 * Swallows failures to `[]` for runtime callers that treat "not connected" and
 * "cannot tell" the same way — the run gate fails closed on both.
 *
 * The run gate reads through the same short-lived memo as the preview surfaces.
 * That is a deliberate judgment: the only staleness it can admit is a
 * connection revoked in the last `COMPOSIO_STATUS_CACHE_MS` (20s by default)
 * *from another session*, since a disconnect made through this server
 * invalidates the entry synchronously. A run that slips through that window
 * still fails at execution — Composio rejects the revoked credential — so the
 * cache can delay a block by seconds, never convert one into a completed send.
 */
export async function listConnectedApps(ctx: ComposioExecutionContext): Promise<string[]> {
  return (await listConnectedAppsDetailed(ctx)).apps;
}

/**
 * Same lookup, but surfaces whether Composio actually answered. Endpoints that
 * render connection state use this so an outage shows as degraded instead of
 * as a workspace that disconnected everything.
 */
export async function listConnectedAppsDetailed(
  ctx: ComposioExecutionContext,
): Promise<ComposioConnectedAppsResult> {
  return await readConnectedAppsWithCache(ctx, async (entity) => {
    const bridge = createComposioBridge(await getClient());
    return await bridge.listConnectedApps(entity);
  });
}

/**
 * The memo policy itself, with the underlying read injected — exported so the
 * caching rules can be exercised against a counting fake, the same way
 * `createComposioBridge` is exercised against a fake client adapter.
 */
export async function readConnectedAppsWithCache(
  ctx: ComposioExecutionContext,
  read: (ctx: ComposioExecutionContext) => Promise<string[]>,
): Promise<ComposioConnectedAppsResult> {
  const ttlMs = partnerConnectionCacheTtlMs();
  const cached = ttlMs > 0 ? partnerConnectionCache.get(ctx.entityId) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return { apps: [...cached.apps], ok: true };
  }

  try {
    const apps = await read(ctx);
    if (ttlMs > 0) {
      partnerConnectionCache.set(ctx.entityId, { apps: [...apps], expiresAt: Date.now() + ttlMs });
    }
    return { apps, ok: true };
  } catch (err) {
    console.error('[composio] listConnectedApps failed:', err);
    // An outage is never memoised — a cached "unreachable" would keep the UI
    // degraded after Composio recovered.
    invalidatePartnerConnectionCache(ctx.entityId);
    return { apps: [], ok: false };
  }
}

/**
 * Full connection inventory for one workspace: every toolkit, every lifecycle
 * state, with granted scopes where exposed.
 *
 * `ok: false` means Composio could not be reached — the caller must render that
 * as "cannot check right now", never as "nothing connected". Uses the same
 * short-lived memo as the connected-apps read (`COMPOSIO_STATUS_CACHE_MS`), so
 * a catalog load costs one upstream call rather than one per surface.
 */
export interface ComposioConnectionInventoryResult {
  connections: ComposioConnectionRecord[];
  ok: boolean;
}

type InventoryCacheEntry = { connections: ComposioConnectionRecord[]; expiresAt: number };

const connectionInventoryCache = new Map<string, InventoryCacheEntry>();

/** Drop one workspace's inventory memo, or every workspace's when called bare. */
export function invalidateConnectionInventoryCache(entityId?: string): void {
  if (entityId === undefined) connectionInventoryCache.clear();
  else connectionInventoryCache.delete(entityId);
}

export async function readConnectionInventory(
  ctx: ComposioExecutionContext,
): Promise<ComposioConnectionInventoryResult> {
  const ttlMs = partnerConnectionCacheTtlMs();
  const cached = ttlMs > 0 ? connectionInventoryCache.get(ctx.entityId) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return { connections: cached.connections.map((record) => ({ ...record })), ok: true };
  }

  try {
    const bridge = createComposioBridge(await getClient());
    const connections = await bridge.listConnectionInventory(ctx);
    if (ttlMs > 0) {
      connectionInventoryCache.set(ctx.entityId, {
        connections: connections.map((record) => ({ ...record })),
        expiresAt: Date.now() + ttlMs,
      });
    }
    return { connections, ok: true };
  } catch (err) {
    console.error('[composio] connection inventory read failed:', err);
    // An outage is never memoised — a cached "unreachable" would keep the UI
    // degraded after Composio recovered.
    invalidateConnectionInventoryCache(ctx.entityId);
    return { connections: [], ok: false };
  }
}

/**
 * Delete this workspace's stranded OAuth attempts for one toolkit so the user
 * can retry from a clean slate. ACTIVE connections are never touched.
 */
export async function cancelPendingComposioConnections(
  appName: string,
  ctx: ComposioExecutionContext,
): Promise<{ ok: boolean; toolkit: string; removed: number; message?: string }> {
  const toolkit = toToolkitSlug(appName);
  try {
    const bridge = createComposioBridge(await getClient());
    const result = await bridge.deletePendingConnections(appName, ctx);
    return { ok: true, ...result };
  } catch (err) {
    console.error(`[composio] cancel-pending failed for ${toolkit}:`, err);
    return {
      ok: false,
      toolkit,
      removed: 0,
      message: err instanceof Error ? err.message : 'Composio cancel failed.',
    };
  } finally {
    // The connection set just changed (or may have partially changed), so both
    // memos are stale either way.
    invalidateConnectionInventoryCache(ctx.entityId);
    invalidatePartnerConnectionCache(ctx.entityId);
  }
}

/**
 * Revoke this entity's active connection(s) to one toolkit. Reports
 * `not_connected` and `failed` distinctly so the caller can answer 404 vs 502
 * rather than claiming a disconnect that never happened.
 */
export async function disconnectComposioApp(
  appName: string,
  ctx: ComposioExecutionContext,
): Promise<ComposioDisconnectResult> {
  try {
    const bridge = createComposioBridge(await getClient());
    return await bridge.disconnectApp(appName, ctx);
  } catch (err) {
    console.error(`[composio] disconnect failed for ${appName}:`, err);
    return {
      status: 'failed',
      toolkit: toToolkitSlug(appName),
      message: err instanceof Error ? err.message : 'Composio disconnect failed.',
    };
  } finally {
    // Unconditional: even a failed disconnect may have deleted some accounts
    // before it threw, so the memos can no longer be trusted either way.
    invalidatePartnerConnectionCache(ctx.entityId);
    invalidateConnectionInventoryCache(ctx.entityId);
  }
}

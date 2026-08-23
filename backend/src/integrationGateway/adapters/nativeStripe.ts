import { getWorkspaceScopedIntegrationCredential } from '../../settingsStore';
import type { IntegrationQueryResult, IntegrationReadinessError } from '../types';

type StripeInterval = 'day' | 'week' | 'month' | 'year';

export interface StripeLikePrice {
  unit_amount?: number | null;
  recurring?: {
    interval?: StripeInterval | null;
    interval_count?: number | null;
  } | null;
}

export interface StripeLikeSubscription {
  id: string;
  status?: string | null;
  created?: number | null;
  canceled_at?: number | null;
  currency?: string | null;
  items?: {
    data?: Array<{
      quantity?: number | null;
      price?: StripeLikePrice | null;
    }>;
  } | null;
}

export interface StripeLikeInvoice {
  id: string;
  status?: string | null;
  amount_remaining?: number | null;
  currency?: string | null;
  created?: number | null;
  attempt_count?: number | null;
  next_payment_attempt?: number | null;
}

export interface StripeLikeCharge {
  id: string;
  status?: string | null;
  amount?: number | null;
  currency?: string | null;
  created?: number | null;
  invoice?: string | { id?: string | null } | null;
}

interface StripeListResponse<T extends { id: string }> {
  data: T[];
  has_more?: boolean;
}

export interface StripeLikeClient {
  subscriptions: {
    list(
      params: Record<string, unknown>,
      options?: { timeout?: number; maxNetworkRetries?: number },
    ): Promise<StripeListResponse<StripeLikeSubscription>>;
  };
  invoices: {
    list(
      params: Record<string, unknown>,
      options?: { timeout?: number; maxNetworkRetries?: number },
    ): Promise<StripeListResponse<StripeLikeInvoice>>;
  };
  charges: {
    list(
      params: Record<string, unknown>,
      options?: { timeout?: number; maxNetworkRetries?: number },
    ): Promise<StripeListResponse<StripeLikeCharge>>;
  };
}

export interface StripeRevenueSummary {
  period: 'last_30_days';
  currency: string;
  mrr: number;
  arr: number;
  active_subscriptions: number;
  new_subscriptions: number;
  churned: number;
  upgrades: number | null;
  downgrades: number | null;
  failed_payments: {
    count: number;
    at_risk_revenue: number;
    invoice_count: number;
    charge_count: number;
  };
  generated_at: string;
  notes: string[];
}

export interface QueryStripeRevenueInput {
  workspaceId: string;
  queryType: string;
  limit?: number;
  now?: Date;
  client?: StripeLikeClient;
  secretKey?: string;
  signal?: AbortSignal;
}

const STRIPE_PAGE_TIMEOUT_MS = 30_000;
export const STRIPE_REVENUE_QUERY_TYPES = [
  'revenue_summary',
  'monthly_revenue',
  'failed_payments',
] as const;

async function awaitStripePage<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Stripe read aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function readinessError(): IntegrationReadinessError {
  return {
    ok: false,
    code: 'integration_not_ready',
    source: 'stripe',
    workflowId: 'revenue-watch',
    message: 'Stripe read access is required before Revenue Watch can run with real data.',
    nextAction: {
      label: 'Connect Stripe',
      route: '/integrations?provider=stripe&workflow=revenue-watch',
    },
  };
}

function unsupportedQuery(queryType: string): IntegrationReadinessError {
  return {
    ok: false,
    code: 'unsupported_query',
    source: 'stripe',
    workflowId: 'revenue-watch',
    message: `Stripe query "${queryType}" is not supported yet. Use "revenue_summary".`,
    nextAction: {
      label: 'Review Revenue Watch setup',
      route: '/integrations?provider=stripe&workflow=revenue-watch',
    },
  };
}

function centsToDollars(value?: number | null) {
  return Math.round(((value || 0) / 100) * 100) / 100;
}

function monthlyMultiplier(interval?: StripeInterval | null, intervalCount?: number | null) {
  const count = Math.max(1, intervalCount || 1);
  if (interval === 'year') return 1 / (12 * count);
  if (interval === 'week') return 52 / (12 * count);
  if (interval === 'day') return 365 / (12 * count);
  return 1 / count;
}

function subscriptionMonthlyRevenue(subscription: StripeLikeSubscription) {
  return (subscription.items?.data || []).reduce((sum, item) => {
    const unitAmount = item.price?.unit_amount || 0;
    const quantity = item.quantity ?? 1;
    const recurring = item.price?.recurring;
    return sum + unitAmount * quantity * monthlyMultiplier(recurring?.interval, recurring?.interval_count);
  }, 0);
}

function createStripeClient(secretKey: string): StripeLikeClient {
  // Delay runtime loading until we actually have credentials and need live Stripe reads.
  const loaded = require('stripe') as { default?: new (secretKey: string) => unknown };
  const StripeCtor = loaded.default || (loaded as new (secretKey: string) => unknown);
  return new StripeCtor(secretKey) as StripeLikeClient;
}

async function listAllPages<T extends { id: string }>(
  list: (
    params: Record<string, unknown>,
    options?: { timeout?: number; maxNetworkRetries?: number },
  ) => Promise<StripeListResponse<T>>,
  baseParams: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T[]> {
  const results: T[] = [];
  let startingAfter: string | undefined;
  let pageCount = 0;

  while (true) {
    signal?.throwIfAborted();
    pageCount += 1;
    const page = await awaitStripePage(
      list({
        ...baseParams,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      }, {
        timeout: STRIPE_PAGE_TIMEOUT_MS,
        // One automation step owns the retry/deadline policy. Hidden SDK
        // retries would outlive that accounting envelope.
        maxNetworkRetries: 0,
      }),
      signal,
    );
    signal?.throwIfAborted();

    results.push(...page.data);

    if (!page.has_more) return results;

    const lastId = page.data[page.data.length - 1]?.id;
    if (!lastId) {
      throw new Error('Stripe pagination signaled more results but returned no cursor anchor.');
    }
    if (lastId === startingAfter) {
      throw new Error('Stripe pagination cursor did not advance.');
    }

    startingAfter = lastId;

    if (pageCount >= 10000) {
      throw new Error('Stripe pagination exceeded emergency page bound.');
    }
  }
}

function normalizeCurrency(values: Array<string | null | undefined>) {
  return (values.find(Boolean) || 'usd').toUpperCase();
}

function chargeInvoiceId(charge: StripeLikeCharge) {
  if (!charge.invoice) return undefined;
  if (typeof charge.invoice === 'string') return charge.invoice;
  return charge.invoice.id || undefined;
}

export async function queryStripeRevenue(
  input: QueryStripeRevenueInput,
): Promise<IntegrationQueryResult<StripeRevenueSummary>> {
  if (!(STRIPE_REVENUE_QUERY_TYPES as readonly string[]).includes(input.queryType)) {
    return unsupportedQuery(input.queryType);
  }

  // Workspace-scoped on purpose: the server's STRIPE_SECRET_KEY is Violema's
  // own account, so only the default workspace may fall back to it. A tenant —
  // or a demo workspace — without its own key gets the readiness error and the
  // connect route, never a live read of our revenue relabeled as theirs.
  const secretKey =
    input.secretKey
    || getWorkspaceScopedIntegrationCredential(input.workspaceId, 'stripe', 'secretKey');
  if (!secretKey && !input.client) return readinessError();

  const startedAt = Date.now();
  const now = input.now || new Date();
  const windowStartSeconds = Math.floor((now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const limit = Math.min(Math.max(input.limit || 100, 1), 100);

  try {
    const client = input.client || createStripeClient(secretKey as string);
    const [subscriptions, invoices, charges] = await Promise.all([
      listAllPages(client.subscriptions.list.bind(client.subscriptions), {
        limit,
        status: 'all',
        expand: ['data.items.data.price'],
      }, input.signal),
      listAllPages(client.invoices.list.bind(client.invoices), {
        limit,
        created: { gte: windowStartSeconds },
      }, input.signal),
      listAllPages(client.charges.list.bind(client.charges), {
        limit,
        created: { gte: windowStartSeconds },
      }, input.signal),
    ]);

    const activeStatuses = new Set(['active', 'trialing', 'past_due']);
    const activeSubscriptions = subscriptions.filter((subscription) => activeStatuses.has(subscription.status || ''));
    const newSubscriptions = subscriptions.filter((subscription) => (subscription.created || 0) >= windowStartSeconds);
    const churned = subscriptions.filter((subscription) =>
      subscription.status === 'canceled' &&
      Boolean(subscription.canceled_at && subscription.canceled_at >= windowStartSeconds),
    );
    const failedInvoices = invoices.filter((invoice) => ['open', 'uncollectible'].includes(invoice.status || ''));
    const failedInvoiceIds = new Set(failedInvoices.map((invoice) => invoice.id));
    const failedCharges = charges.filter((charge) =>
      charge.status === 'failed' && !failedInvoiceIds.has(chargeInvoiceId(charge) || ''),
    );
    const mrr = Math.round(activeSubscriptions.reduce((sum, subscription) => sum + subscriptionMonthlyRevenue(subscription), 0) * 100) / 100;
    const atRiskRevenue = Math.round((
      failedInvoices.reduce((sum, invoice) => sum + centsToDollars(invoice.amount_remaining), 0) +
      failedCharges.reduce((sum, charge) => sum + centsToDollars(charge.amount), 0)
    ) * 100) / 100;

    return {
      ok: true,
      source: 'stripe',
      query_type: 'revenue_summary',
      data: {
        period: 'last_30_days',
        currency: normalizeCurrency([
          activeSubscriptions[0]?.currency,
          failedInvoices[0]?.currency,
          failedCharges[0]?.currency,
        ]),
        mrr,
        arr: Math.round(mrr * 12 * 100) / 100,
        active_subscriptions: activeSubscriptions.length,
        new_subscriptions: newSubscriptions.length,
        churned: churned.length,
        upgrades: null,
        downgrades: null,
        failed_payments: {
          count: failedInvoices.length + failedCharges.length,
          at_risk_revenue: atRiskRevenue,
          invoice_count: failedInvoices.length,
          charge_count: failedCharges.length,
        },
        generated_at: now.toISOString(),
        notes: [
          'Stripe read is live and read-only.',
          'Upgrades and downgrades are not inferred until subscription-change event history is added.',
        ],
      },
      fetched_at: now.toISOString(),
      latency_ms: Date.now() - startedAt,
      cache_hit: false,
      live: true,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'integration_query_failed',
      source: 'stripe',
      workflowId: 'revenue-watch',
      message: error instanceof Error ? error.message : 'Stripe revenue query failed.',
      nextAction: {
        label: 'Check Stripe connection',
        route: '/integrations?provider=stripe&workflow=revenue-watch',
      },
    };
  }
}

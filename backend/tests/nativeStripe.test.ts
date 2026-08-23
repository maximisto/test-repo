import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import {
  queryStripeRevenue,
  type StripeLikeClient,
} from '../src/integrationGateway/adapters/nativeStripe';
import { executeQueryData } from '../src/integrationGateway/queryData';

const now = new Date('2026-06-29T12:00:00.000Z');

function fakeStripeClient(): StripeLikeClient {
  return {
    subscriptions: {
      async list() {
        return {
          data: [
            {
              id: 'sub_active_month',
              status: 'active',
              created: Math.floor(Date.parse('2026-06-15T12:00:00.000Z') / 1000),
              canceled_at: null,
              currency: 'usd',
              items: {
                data: [
                  {
                    quantity: 2,
                    price: {
                      unit_amount: 5000,
                      recurring: { interval: 'month', interval_count: 1 },
                    },
                  },
                ],
              },
            },
            {
              id: 'sub_active_year',
              status: 'active',
              created: Math.floor(Date.parse('2026-03-01T12:00:00.000Z') / 1000),
              canceled_at: null,
              currency: 'usd',
              items: {
                data: [
                  {
                    quantity: 1,
                    price: {
                      unit_amount: 120000,
                      recurring: { interval: 'year', interval_count: 1 },
                    },
                  },
                ],
              },
            },
            {
              id: 'sub_churned',
              status: 'canceled',
              created: Math.floor(Date.parse('2026-01-01T12:00:00.000Z') / 1000),
              canceled_at: Math.floor(Date.parse('2026-06-20T12:00:00.000Z') / 1000),
              currency: 'usd',
              items: {
                data: [
                  {
                    quantity: 1,
                    price: {
                      unit_amount: 2500,
                      recurring: { interval: 'month', interval_count: 1 },
                    },
                  },
                ],
              },
            },
          ],
        };
      },
    },
    invoices: {
      async list() {
        return {
          data: [
            {
              id: 'in_failed_1',
              status: 'open',
              amount_remaining: 4200,
              currency: 'usd',
              created: Math.floor(Date.parse('2026-06-28T12:00:00.000Z') / 1000),
              attempt_count: 2,
              next_payment_attempt: Math.floor(Date.parse('2026-06-30T12:00:00.000Z') / 1000),
            },
          ],
        };
      },
    },
    charges: {
      async list() {
        return {
          data: [
            {
              id: 'ch_failed_1',
              status: 'failed',
              amount: 1800,
              currency: 'usd',
              created: Math.floor(Date.parse('2026-06-27T12:00:00.000Z') / 1000),
            },
          ],
        };
      },
    },
  };
}

test('queryStripeRevenue normalizes live Stripe revenue signals', async () => {
  const result = await queryStripeRevenue({
    workspaceId: 'workspace_test',
    queryType: 'revenue_summary',
    now,
    client: fakeStripeClient(),
    secretKey: 'sk_test_injected',
  });

  if (!result.ok) throw new Error(result.message);
  assert.equal(result.ok, true);

  assert.equal(result.source, 'stripe');
  assert.equal(result.query_type, 'revenue_summary');
  assert.equal(result.live, true);
  assert.equal(result.cache_hit, false);
  assert.equal(result.data.currency, 'USD');
  assert.equal(result.data.mrr, 20000);
  assert.equal(result.data.arr, 240000);
  assert.equal(result.data.active_subscriptions, 2);
  assert.equal(result.data.new_subscriptions, 1);
  assert.equal(result.data.churned, 1);
  assert.equal(result.data.failed_payments.count, 2);
  assert.equal(result.data.failed_payments.at_risk_revenue, 60);
});

test('queryStripeRevenue returns readiness error instead of fake data when credentials are missing', async () => {
  const result = await queryStripeRevenue({
    workspaceId: 'workspace_missing',
    queryType: 'revenue_summary',
    now,
  });

  if (result.ok) throw new Error('expected readiness error');
  assert.equal(result.ok, false);

  assert.equal(result.code, 'integration_not_ready');
  assert.equal(result.source, 'stripe');
  assert.equal(result.workflowId, 'revenue-watch');
  assert.match(result.message, /Stripe read access is required/);
  assert.equal(result.nextAction.route, '/integrations?provider=stripe&workflow=revenue-watch');
});

test('queryStripeRevenue paginates Stripe list responses instead of stopping after one page', async () => {
  const subscriptionPages = [
    {
      data: [
        {
          id: 'sub_page_1',
          status: 'active',
          created: Math.floor(Date.parse('2026-06-14T12:00:00.000Z') / 1000),
          canceled_at: null,
          currency: 'usd',
          items: {
            data: [
              {
                quantity: 1,
                price: {
                  unit_amount: 5000,
                  recurring: { interval: 'month', interval_count: 1 },
                },
              },
            ],
          },
        },
      ],
      has_more: true,
    },
    {
      data: [
        {
          id: 'sub_page_2',
          status: 'active',
          created: Math.floor(Date.parse('2026-06-10T12:00:00.000Z') / 1000),
          canceled_at: null,
          currency: 'usd',
          items: {
            data: [
              {
                quantity: 1,
                price: {
                  unit_amount: 120000,
                  recurring: { interval: 'year', interval_count: 1 },
                },
              },
            ],
          },
        },
      ],
      has_more: false,
    },
  ] as const;

  const invoicePages = [
    {
      data: [
        {
          id: 'in_page_1',
          status: 'open',
          amount_remaining: 4200,
          currency: 'usd',
          created: Math.floor(Date.parse('2026-06-28T12:00:00.000Z') / 1000),
        },
      ],
      has_more: true,
    },
    {
      data: [
        {
          id: 'in_page_2',
          status: 'uncollectible',
          amount_remaining: 2100,
          currency: 'usd',
          created: Math.floor(Date.parse('2026-06-26T12:00:00.000Z') / 1000),
        },
      ],
      has_more: false,
    },
  ] as const;

  const chargePages = [
    {
      data: [
        {
          id: 'ch_page_1',
          status: 'failed',
          amount: 800,
          currency: 'usd',
          created: Math.floor(Date.parse('2026-06-27T12:00:00.000Z') / 1000),
        },
      ],
      has_more: true,
    },
    {
      data: [
        {
          id: 'ch_page_2',
          status: 'failed',
          amount: 700,
          currency: 'usd',
          created: Math.floor(Date.parse('2026-06-25T12:00:00.000Z') / 1000),
        },
      ],
      has_more: false,
    },
  ] as const;

  const subscriptionCalls: Array<Record<string, unknown>> = [];
  const invoiceCalls: Array<Record<string, unknown>> = [];
  const chargeCalls: Array<Record<string, unknown>> = [];

  const client: StripeLikeClient = {
    subscriptions: {
      async list(params) {
        subscriptionCalls.push(params);
        const page = subscriptionPages[subscriptionCalls.length - 1];
        if (!page) throw new Error('unexpected subscription page request');
        if (subscriptionCalls.length === 2) {
          assert.equal(params.starting_after, 'sub_page_1');
        }
        return page as unknown as Awaited<ReturnType<StripeLikeClient['subscriptions']['list']>>;
      },
    },
    invoices: {
      async list(params) {
        invoiceCalls.push(params);
        const page = invoicePages[invoiceCalls.length - 1];
        if (!page) throw new Error('unexpected invoice page request');
        if (invoiceCalls.length === 2) {
          assert.equal(params.starting_after, 'in_page_1');
        }
        return page as unknown as Awaited<ReturnType<StripeLikeClient['invoices']['list']>>;
      },
    },
    charges: {
      async list(params) {
        chargeCalls.push(params);
        const page = chargePages[chargeCalls.length - 1];
        if (!page) throw new Error('unexpected charge page request');
        if (chargeCalls.length === 2) {
          assert.equal(params.starting_after, 'ch_page_1');
        }
        return page as unknown as Awaited<ReturnType<StripeLikeClient['charges']['list']>>;
      },
    },
  };

  const result = await queryStripeRevenue({
    workspaceId: 'workspace_pagination',
    queryType: 'revenue_summary',
    now,
    client,
    limit: 1,
  });

  if (!result.ok) throw new Error(result.message);

  assert.equal(subscriptionCalls.length, 2);
  assert.equal(invoiceCalls.length, 2);
  assert.equal(chargeCalls.length, 2);
  assert.equal(result.data.active_subscriptions, 2);
  assert.equal(result.data.new_subscriptions, 2);
  assert.equal(result.data.mrr, 15000);
  assert.equal(result.data.arr, 180000);
  assert.equal(result.data.failed_payments.invoice_count, 2);
  assert.equal(result.data.failed_payments.charge_count, 2);
  assert.equal(result.data.failed_payments.count, 4);
  assert.equal(result.data.failed_payments.at_risk_revenue, 78);
});

test('queryStripeRevenue continues past 25 pages instead of silently truncating results', async () => {
  const subscriptionCalls: Array<Record<string, unknown>> = [];

  const client: StripeLikeClient = {
    subscriptions: {
      async list(params) {
        subscriptionCalls.push(params);
        const pageNumber = subscriptionCalls.length;
        const id = `sub_page_${pageNumber}`;

        if (pageNumber > 1) {
          assert.equal(params.starting_after, `sub_page_${pageNumber - 1}`);
        }

        return {
          data: [
            {
              id,
              status: 'active',
              created: Math.floor(Date.parse('2026-06-20T12:00:00.000Z') / 1000),
              canceled_at: null,
              currency: 'usd',
              items: {
                data: [
                  {
                    quantity: pageNumber === 26 ? 0 : 1,
                    price: {
                      unit_amount: 1000,
                      recurring: { interval: 'month', interval_count: 1 },
                    },
                  },
                ],
              },
            },
          ],
          has_more: pageNumber < 26,
        };
      },
    },
    invoices: {
      async list() {
        return { data: [], has_more: false };
      },
    },
    charges: {
      async list() {
        return { data: [], has_more: false };
      },
    },
  };

  const result = await queryStripeRevenue({
    workspaceId: 'workspace_many_pages',
    queryType: 'revenue_summary',
    now,
    client,
    limit: 1,
  });

  if (!result.ok) throw new Error(result.message);

  assert.equal(subscriptionCalls.length, 26);
  assert.equal(result.data.active_subscriptions, 26);
  assert.equal(result.data.new_subscriptions, 26);
  assert.equal(result.data.mrr, 25000);
});

test('queryStripeRevenue returns integration_query_failed when Stripe pagination cursor does not advance', async () => {
  let subscriptionCalls = 0;

  const client: StripeLikeClient = {
    subscriptions: {
      async list() {
        subscriptionCalls += 1;
        return {
          data: [
            {
              id: 'sub_stuck_cursor',
              status: 'active',
              created: Math.floor(Date.parse('2026-06-20T12:00:00.000Z') / 1000),
              canceled_at: null,
              currency: 'usd',
              items: {
                data: [
                  {
                    quantity: 1,
                    price: {
                      unit_amount: 5000,
                      recurring: { interval: 'month', interval_count: 1 },
                    },
                  },
                ],
              },
            },
          ],
          has_more: true,
        };
      },
    },
    invoices: {
      async list() {
        return { data: [], has_more: false };
      },
    },
    charges: {
      async list() {
        return { data: [], has_more: false };
      },
    },
  };

  const result = await queryStripeRevenue({
    workspaceId: 'workspace_stuck_cursor',
    queryType: 'revenue_summary',
    now,
    client,
    limit: 1,
  });

  if (result.ok) throw new Error('expected integration_query_failed');

  assert.equal(result.code, 'integration_query_failed');
  assert.match(result.message, /cursor did not advance/i);
  assert.equal(subscriptionCalls, 2);
});

test('an automation query abort stops hung Stripe pages and supplies bounded SDK request options', async () => {
  const controller = new AbortController();
  const requestOptions: Array<{ timeout?: number; maxNetworkRetries?: number } | undefined> = [];
  let enteredCount = 0;
  let allEntered!: () => void;
  const allEnteredPromise = new Promise<void>((resolve) => { allEntered = resolve; });
  const hungList = async (
    _params: Record<string, unknown>,
    options?: { timeout?: number; maxNetworkRetries?: number },
  ): Promise<never> => {
    requestOptions.push(options);
    enteredCount += 1;
    if (enteredCount === 3) allEntered();
    return new Promise<never>(() => undefined);
  };
  const client: StripeLikeClient = {
    subscriptions: { list: hungList },
    invoices: { list: hungList },
    charges: { list: hungList },
  };

  const query = executeQueryData({
    workspaceId: 'workspace_stripe_abort',
    source: 'stripe',
    queryType: 'revenue_summary',
    signal: controller.signal,
    clientOverrides: { stripe: client },
  });
  await allEnteredPromise;
  controller.abort(new Error('stripe step deadline expired'));
  const result = await query;

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'integration_query_failed');
  assert.match(result.message, /stripe step deadline expired/i);
  assert.equal(requestOptions.length, 3);
  for (const options of requestOptions) {
    assert.equal(options?.timeout, 30_000);
    assert.equal(options?.maxNetworkRetries, 0);
  }
});

test('queryStripeRevenue excludes failed charges linked to already-counted failed invoices', async () => {
  const client: StripeLikeClient = {
    subscriptions: {
      async list() {
        return { data: [], has_more: false };
      },
    },
    invoices: {
      async list() {
        return {
          data: [
            {
              id: 'in_failed_linked',
              status: 'open',
              amount_remaining: 4200,
              currency: 'usd',
              created: Math.floor(Date.parse('2026-06-28T12:00:00.000Z') / 1000),
            },
          ],
          has_more: false,
        };
      },
    },
    charges: {
      async list() {
        return {
          data: [
            {
              id: 'ch_failed_linked',
              status: 'failed',
              amount: 1800,
              currency: 'usd',
              created: Math.floor(Date.parse('2026-06-27T12:00:00.000Z') / 1000),
              invoice: 'in_failed_linked',
            },
            {
              id: 'ch_failed_unlinked',
              status: 'failed',
              amount: 900,
              currency: 'usd',
              created: Math.floor(Date.parse('2026-06-26T12:00:00.000Z') / 1000),
            },
          ],
          has_more: false,
        };
      },
    },
  };

  const result = await queryStripeRevenue({
    workspaceId: 'workspace_dedupe',
    queryType: 'revenue_summary',
    now,
    client,
  });

  if (!result.ok) throw new Error(result.message);

  assert.equal(result.data.failed_payments.invoice_count, 1);
  assert.equal(result.data.failed_payments.charge_count, 1);
  assert.equal(result.data.failed_payments.count, 2);
  assert.equal(result.data.failed_payments.at_risk_revenue, 51);
});

test('queryStripeRevenue returns unsupported_query for unsupported Stripe query types', async () => {
  const result = await queryStripeRevenue({
    workspaceId: 'workspace_unsupported',
    queryType: 'customer_export',
    now,
    secretKey: 'sk_test_injected',
  });

  if (result.ok) throw new Error('expected unsupported query error');

  assert.equal(result.code, 'unsupported_query');
  assert.equal(result.source, 'stripe');
  assert.match(result.message, /customer_export/);
});

test('queryStripeRevenue returns integration_query_failed when live Stripe client creation fails', async () => {
  const moduleInternals = Module as unknown as {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;

  moduleInternals._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === 'stripe') {
      throw new Error('stripe module load failed');
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const result = await queryStripeRevenue({
      workspaceId: 'workspace_client_failure',
      queryType: 'revenue_summary',
      now,
      secretKey: 'sk_test_injected',
    });

    if (result.ok) throw new Error('expected integration_query_failed');

    assert.equal(result.code, 'integration_query_failed');
    assert.equal(result.source, 'stripe');
    assert.match(result.message, /stripe module load failed/);
  } finally {
    moduleInternals._load = originalLoad;
  }
});

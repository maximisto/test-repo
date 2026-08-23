import assert from 'node:assert/strict';
import test from 'node:test';
import { applyQueryStepPayloadToExecution, executeQueryData } from '../src/integrationGateway/queryData';
import type { StripeLikeClient } from '../src/integrationGateway/adapters/nativeStripe';
import type { PartnerComposioQueryInput } from '../src/integrationGateway/adapters/partnerComposio';
import type { IntegrationQueryResult } from '../src/integrationGateway/types';
import type { AutomationStepExecution } from '../src/platform/types';

interface StripeRevenueLike {
  mrr: number;
}

function emptyStripeClient(): StripeLikeClient {
  return {
    subscriptions: { async list() { return { data: [] }; } },
    invoices: { async list() { return { data: [] }; } },
    charges: { async list() { return { data: [] }; } },
  };
}

function makeQueryStepExecution(): AutomationStepExecution {
  return {
    stepId: 'step_query',
    kind: 'query',
    title: 'Check Stripe revenue',
    assignedRole: 'analyst',
    status: 'running',
  };
}

test('executeQueryData routes Stripe through native adapter', async () => {
  const result = await executeQueryData({
    workspaceId: 'workspace_test',
    source: 'stripe',
    queryType: 'revenue_summary',
    clientOverrides: { stripe: emptyStripeClient() },
    credentialOverrides: { stripeSecretKey: 'sk_test_injected' },
    now: new Date('2026-06-29T12:00:00.000Z'),
  });

  if (!result.ok) throw new Error('expected Stripe success');
  assert.equal(result.source, 'stripe');
  assert.equal(result.live, true);
  assert.equal((result.data as StripeRevenueLike).mrr, 0);
});

test('executeQueryData never returns placeholder Stripe revenue when Stripe is missing', async () => {
  const result = await executeQueryData({
    workspaceId: 'workspace_missing',
    source: 'stripe',
    queryType: 'revenue_summary',
    now: new Date('2026-06-29T12:00:00.000Z'),
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected readiness error');
  assert.equal(result.code, 'integration_not_ready');
  assert.doesNotMatch(JSON.stringify(result), /12745(?:0)|10823(?:0)|15294(?:00)/);
});

test('executeQueryData routes every partner demo source through the live adapter', async () => {
  const calls: PartnerComposioQueryInput[] = [];
  const partner = async (input: PartnerComposioQueryInput): Promise<IntegrationQueryResult> => {
    calls.push(input);
    return {
      ok: true,
      source: input.source,
      query_type: input.queryType,
      data: { verified: true },
      fetched_at: input.now?.toISOString() || '2026-07-19T12:00:00.000Z',
      latency_ms: 1,
      cache_hit: false,
      live: true,
    };
  };
  const now = new Date('2026-07-19T12:00:00.000Z');
  const cases = [
    { source: 'github', queryType: 'delivery_risk' },
    { source: 'linear', queryType: 'delivery_status' },
    { source: 'email', queryType: 'commitments' },
    { source: 'calendar', queryType: 'weekly_commitments' },
    { source: 'google_drive', queryType: 'recent_files' },
  ];

  for (const item of cases) {
    const result = await executeQueryData({
      workspaceId: 'purpleorangehq',
      source: item.source,
      queryType: item.queryType,
      filters: { owner: 'maximisto', repo: 'violema' },
      limit: 10,
      now,
      clientOverrides: { partner },
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(`expected ${item.source} live success`);
    assert.equal(result.live, true);
    assert.doesNotMatch(JSON.stringify(result), /"simulated":true/);
  }

  assert.deepEqual(
    calls.map(({ workspaceId, source, queryType, filters, limit, now: callNow }) => ({
      workspaceId,
      source,
      queryType,
      filters,
      limit,
      now: callNow?.toISOString(),
    })),
    cases.map((item) => ({
      workspaceId: 'purpleorangehq',
      source: item.source,
      queryType: item.queryType,
      filters: { owner: 'maximisto', repo: 'violema' },
      limit: 10,
      now: '2026-07-19T12:00:00.000Z',
    })),
  );
});

test('executeQueryData never substitutes demo sample data after a partner failure', async () => {
  const result = await executeQueryData({
    workspaceId: 'purpleorangehq',
    source: 'github',
    queryType: 'delivery_risk',
    filters: { owner: 'maximisto', repo: 'violema' },
    clientOverrides: {
      partner: async () => ({
        ok: false,
        code: 'integration_not_ready',
        source: 'github',
        message: 'GitHub must be connected before this workflow can read live data.',
        can_continue: false,
        nextAction: {
          label: 'Connect GitHub',
          route: '/integrations?provider=github',
        },
      }),
    },
  });

  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /simulated|open_issues|34/);
});

test('applyQueryStepPayloadToExecution marks readiness errors as failed automation steps', () => {
  const stepExecution = makeQueryStepExecution();
  const stepErrors: string[] = [];

  applyQueryStepPayloadToExecution({
    stepTitle: 'Check Stripe revenue',
    payload: {
      ok: false,
      code: 'integration_not_ready',
      source: 'stripe',
      message: 'Stripe read access is required before Revenue Watch can run with real data.',
    },
    stepExecution,
    stepErrors,
    artifactCount: 1,
  });

  assert.equal(stepExecution.status, 'failed');
  assert.equal(stepExecution.summary, 'Stripe read access is required before Revenue Watch can run with real data.');
  assert.equal(stepExecution.error, 'Stripe read access is required before Revenue Watch can run with real data.');
  assert.equal(stepExecution.artifactKind, 'query_data');
  assert.equal(stepExecution.toolCalls, 1);
  assert.equal(stepExecution.artifactCount, 1);
  assert.deepEqual(stepExecution.output, {
    ok: false,
    code: 'integration_not_ready',
    source: 'stripe',
    message: 'Stripe read access is required before Revenue Watch can run with real data.',
  });
  assert.deepEqual(stepErrors, [
    'Check Stripe revenue: Stripe read access is required before Revenue Watch can run with real data.',
  ]);
});

test('query failure diagnostics are byte-bounded and redact credentials before step persistence', () => {
  const stepExecution = makeQueryStepExecution();
  const stepErrors: string[] = [];
  const privateToken = 'sk_live_PRIVATE_QUERY_TOKEN';
  const privateCustomerText = 'CUSTOMER_SENTINEL_PRIVATE_PLAN';

  applyQueryStepPayloadToExecution({
    stepTitle: 'Check Stripe revenue',
    payload: {
      ok: false,
      code: 'integration_query_failed',
      source: 'stripe',
      message: `Authorization: Bearer ${privateToken} request_body={"input_text":"${privateCustomerText}"} ${'\\'.repeat(100_000)}`,
      raw_provider_response: { request_body: privateCustomerText },
    },
    stepExecution,
    stepErrors,
    artifactCount: 1,
  });

  assert.equal(stepExecution.status, 'failed');
  assert.ok(Buffer.byteLength(stepExecution.error || '', 'utf8') <= 500);
  assert.doesNotMatch(stepExecution.error || '', /PRIVATE_QUERY_TOKEN/);
  assert.doesNotMatch(stepExecution.error || '', /CUSTOMER_SENTINEL/);
  assert.doesNotMatch(stepErrors.join('\n'), /PRIVATE_QUERY_TOKEN/);
  assert.doesNotMatch(JSON.stringify(stepExecution.output), /PRIVATE_QUERY_TOKEN|CUSTOMER_SENTINEL|raw_provider_response/);
  assert.ok(Buffer.byteLength(JSON.stringify(stepExecution.output), 'utf8') <= 1_000);
});

test('applyQueryStepPayloadToExecution keeps successful live query payloads successful', () => {
  const stepExecution = makeQueryStepExecution();
  const stepErrors: string[] = [];

  applyQueryStepPayloadToExecution({
    stepTitle: 'Check GitHub delivery',
    payload: {
      ok: true,
      source: 'github',
      query_type: 'delivery_risk',
      data: { counts: { openIssues: 2 } },
      live: true,
    },
    stepExecution,
    stepErrors,
    artifactCount: 1,
  });

  assert.equal(stepExecution.status, 'succeeded');
  assert.equal(stepExecution.summary, 'Pulled the requested live data successfully.');
  assert.equal(stepExecution.error, undefined);
  assert.equal(stepExecution.artifactKind, 'query_data');
  assert.equal(stepExecution.toolCalls, 1);
  assert.equal(stepExecution.artifactCount, 1);
  assert.deepEqual(stepExecution.output, {
    ok: true,
    source: 'github',
    query_type: 'delivery_risk',
    data: { counts: { openIssues: 2 } },
    live: true,
  });
  assert.deepEqual(stepErrors, []);
});

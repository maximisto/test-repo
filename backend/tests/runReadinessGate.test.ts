import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_CAPABLE_QUERY_SOURCES,
  evaluateRunReadiness,
  evaluateStepSourceReadiness,
  isSupportedReadinessWorkflow,
} from '../src/integrationGateway/runReadinessGate';

// These fixtures describe a tenant workspace ('workspace_real'), so "connected"
// has to mean the TENANT connected Stripe. A server-configured key is Violema's
// own account and no longer satisfies readiness for anyone but the default
// workspace — see SERVER_ONLY_STRIPE below.
const CONNECTED_STRIPE = {
  integrations: { stripe: { configured: true, workspaceConfigured: true } },
};
const DISCONNECTED_STRIPE = { integrations: { stripe: { configured: false } } };
/** What a tenant sees when only Violema's env STRIPE_SECRET_KEY is set. */
const SERVER_ONLY_STRIPE = {
  integrations: {
    stripe: { configured: true, workspaceConfigured: false, serverConfigured: true },
  },
};

function partnerReady(...sources: string[]) {
  const status: Record<string, { ready: boolean; detail?: string }> = {};
  for (const source of ['email', 'calendar', 'google_drive', 'linear', 'github', 'tavily', 'slack', 'postmark']) {
    status[source] = sources.includes(source)
      ? { ready: true, detail: `${source} is connected.` }
      : { ready: false, detail: `${source} is not connected to this workspace.` };
  }
  return status;
}

test('demo workspaces bypass readiness enforcement entirely', () => {
  const decision = evaluateRunReadiness({
    workflowId: 'weekly-founder-update',
    workspaceId: 'demo_workspace',
    isDemoWorkspace: true,
    // Nothing is connected, and the workflow is the strictest one there is.
    settingsView: DISCONNECTED_STRIPE,
    runtimeStatus: partnerReady(),
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.tier, 'demo_bypass');
  assert.deepEqual(decision.blockers, []);
});

test('supported workflow is blocked when its required integrations are missing', () => {
  const decision = evaluateRunReadiness({
    workflowId: 'revenue-watch',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    deliveryTarget: '#violema-demo',
    settingsView: DISCONNECTED_STRIPE,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.tier, 'supported_workflow');
  assert.deepEqual(decision.blockers.map((blocker) => blocker.key), ['stripe']);
  assert.match(decision.summary, /connect Stripe/i);
});

test('supported workflow is allowed once its required integrations are configured', () => {
  const decision = evaluateRunReadiness({
    workflowId: 'revenue-watch',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    deliveryTarget: '#violema-demo',
    settingsView: CONNECTED_STRIPE,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.tier, 'supported_workflow');
  assert.deepEqual(decision.blockers, []);
});

test('custom automation is blocked on a source Violema cannot read live, naming that source', () => {
  const decision = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    settingsView: CONNECTED_STRIPE,
    runtimeStatus: partnerReady('github'),
    steps: [
      { kind: 'query', title: 'Pull Stripe revenue', inputs: { source: 'stripe' } },
      { kind: 'query', title: 'Pull Notion roadmap', inputs: { source: 'notion' } },
      { kind: 'summarize', title: 'Draft brief', inputs: {} },
    ],
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.tier, 'step_sources');
  // Stripe is configured, so only the unreadable source blocks.
  assert.deepEqual(decision.blockers.map((blocker) => blocker.key), ['notion']);
  assert.equal(decision.blockers[0].label, 'Connect Notion');
  assert.equal(decision.blockers[0].route, '/integrations?provider=notion');
  assert.match(decision.summary, /connect Notion/i);
});

test('custom automation with only stripe steps passes when Stripe is configured', () => {
  const decision = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    settingsView: CONNECTED_STRIPE,
    runtimeStatus: partnerReady(),
    steps: [
      { kind: 'query', title: 'Revenue', inputs: { source: 'stripe', query_type: 'revenue_summary' } },
      { kind: 'query', title: 'Failed payments', inputs: { source: 'stripe', query_type: 'failed_payments' } },
    ],
  });

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.blockers, []);
});

test('custom automation with only stripe steps is blocked when Stripe is not configured', () => {
  const decision = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    settingsView: DISCONNECTED_STRIPE,
    steps: [{ kind: 'query', title: 'Revenue', inputs: { source: 'stripe' } }],
  });

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.blockers.map((blocker) => blocker.key), ['stripe']);
  assert.equal(decision.blockers[0].route, '/integrations?provider=stripe');
});

test('a tenant automation is blocked when only Violema\'s own Stripe key is configured', () => {
  const decision = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    settingsView: SERVER_ONLY_STRIPE,
    steps: [{ kind: 'query', title: 'Revenue', inputs: { source: 'stripe' } }],
  });

  // The server key is OUR Stripe account. A tenant reading it would be shown
  // Violema's revenue as their own, so readiness must fail closed and ask them
  // to connect their own account.
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.blockers.map((blocker) => blocker.key), ['stripe']);
  assert.equal(decision.blockers[0].route, '/integrations?provider=stripe');
});

test('the default workspace may still satisfy Stripe readiness with the server key', () => {
  const decision = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'purpleorangehq',
    isDemoWorkspace: false,
    settingsView: SERVER_ONLY_STRIPE,
    runtimeStatus: partnerReady(),
    steps: [{ kind: 'query', title: 'Revenue', inputs: { source: 'stripe' } }],
  });

  // The server key IS the default workspace's own account — Max's internal
  // missions must keep running exactly as before.
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.blockers, []);
});

test('a demo workspace may not satisfy Stripe readiness with the server key', () => {
  const blockers = evaluateStepSourceReadiness({
    workspaceId: 'workspace_demo',
    settingsView: SERVER_ONLY_STRIPE,
    steps: [{ kind: 'query', title: 'Revenue', inputs: { source: 'stripe' } }],
  });

  // Demo workspaces may render labeled sample data, never a real read against
  // Violema's Stripe account.
  assert.deepEqual(blockers.map((blocker) => blocker.key), ['stripe']);
});

test('custom search and delivery require the providers they will actually call', () => {
  const steps = [
    { kind: 'search', title: 'Scan the market', inputs: { query: 'competitors' } },
    { kind: 'summarize', title: 'Write it up', inputs: {} },
    { kind: 'deliver', title: 'Send it', inputs: {} },
  ];
  const blocked = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    settingsView: DISCONNECTED_STRIPE,
    runtimeStatus: partnerReady(),
    deliveryTarget: '#ops',
    steps,
  });

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.tier, 'step_sources');
  assert.deepEqual(blocked.blockers.map((blocker) => blocker.key), ['tavily', 'slack']);

  const allowed = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    settingsView: DISCONNECTED_STRIPE,
    runtimeStatus: partnerReady('tavily', 'slack'),
    deliveryTarget: '#ops',
    steps,
  });

  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.blockers, []);
});

test('an explicit step delivery target takes precedence over the workflow notify target', () => {
  const steps = [{
    kind: 'deliver',
    title: 'Email the founder',
    inputs: {},
    deliveryTarget: { channel: 'email' as const, target: 'founder@example.com' },
  }];
  const allowed = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    runtimeStatus: partnerReady('postmark'),
    deliveryTarget: '#wrong-channel',
    steps,
  });

  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.blockers, []);

  const blocked = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    runtimeStatus: partnerReady('slack'),
    deliveryTarget: '#wrong-channel',
    steps,
  });
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.blockers.map((blocker) => blocker.key), ['postmark']);
});

test('custom automation with no steps at all passes', () => {
  const decision = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
  });

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.blockers, []);
});

test('partner source blocks when disconnected and passes when connected', () => {
  const steps = [{ kind: 'query', title: 'Delivery risk', inputs: { source: 'github' } }];

  const blocked = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    runtimeStatus: partnerReady(),
    steps,
  });
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.blockers.map((blocker) => blocker.key), ['github']);
  assert.equal(blocked.blockers[0].route, '/integrations?provider=github');

  const allowed = evaluateRunReadiness({
    workflowId: 'custom-workflow',
    workspaceId: 'workspace_real',
    isDemoWorkspace: false,
    runtimeStatus: partnerReady('github'),
    steps,
  });
  assert.equal(allowed.allowed, true);
});

test('repeated sources produce one blocker, and a nameless source is called out', () => {
  const blockers = evaluateStepSourceReadiness({
    runtimeStatus: partnerReady(),
    steps: [
      { kind: 'query', title: 'First', inputs: { source: 'linear' } },
      { kind: 'query', title: 'Second', inputs: { source: 'linear' } },
      { kind: 'query', title: 'Mystery step', inputs: {} },
    ],
  });

  assert.deepEqual(blockers.map((blocker) => blocker.key), ['linear', 'unknown_source']);
  assert.match(blockers[1].detail, /Mystery step/);
});

test('live-capable source set is Stripe plus the partner Composio sources', () => {
  assert.deepEqual(
    [...LIVE_CAPABLE_QUERY_SOURCES].sort(),
    ['calendar', 'email', 'github', 'google_drive', 'linear', 'stripe'],
  );
  assert.equal(isSupportedReadinessWorkflow('revenue-watch'), true);
  assert.equal(isSupportedReadinessWorkflow('weekly-founder-update'), true);
  assert.equal(isSupportedReadinessWorkflow('custom-workflow'), false);
});

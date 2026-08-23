import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('authoritative runtime readiness rejects legacy multi-delivery missions before demo bypass', async () => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalDemoIds = process.env.DEMO_WORKSPACE_IDS;
  const originalTavilyKey = process.env.TAVILY_API_KEY;
  const originalPostmarkKey = process.env.POSTMARK_API_KEY;
  const originalPostmarkFrom = process.env.POSTMARK_FROM_EMAIL;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-structural-readiness-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    process.env.DEMO_WORKSPACE_IDS = 'workspace_legacy_multi_delivery,workspace_demo_delivery';
    delete process.env.TAVILY_API_KEY;
    delete process.env.POSTMARK_API_KEY;
    delete process.env.POSTMARK_FROM_EMAIL;
    const server = await import('../src/server');
    const emailSuppressions = await import('../src/emailSuppressions');

    const decision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_legacy_multi_delivery',
      workflowId: 'custom-workflow',
      steps: [
        {
          id: 'deliver-a',
          kind: 'deliver',
          objective: 'Deliver the first brief.',
          deliveryTarget: { channel: 'slack', target: '#a' },
        },
        {
          id: 'deliver-b',
          kind: 'deliver',
          objective: 'Deliver the second brief.',
          deliveryTarget: { channel: 'slack', target: '#b' },
        },
      ],
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.blockers[0]?.key, 'AUTOMATION_STRUCTURE');
    assert.match(decision.summary, /one delivery step/i);

    const actionsOnlyDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_legacy_multi_delivery',
      workflowId: 'custom-workflow',
      actions: [
        'Send the founder brief to Slack.',
        'Email the founder brief to the board.',
      ],
    });
    assert.equal(actionsOnlyDecision.allowed, false);
    assert.equal(actionsOnlyDecision.blockers[0]?.key, 'AUTOMATION_STRUCTURE');
    assert.match(actionsOnlyDecision.summary, /one delivery step/i);

    const oversizedLegacyDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_legacy_multi_delivery',
      workflowId: 'custom-workflow',
      actions: Array.from({ length: 25 }, (_, index) => `Inspect source ${index + 1}.`),
    });
    assert.equal(oversizedLegacyDecision.allowed, false);
    assert.equal(oversizedLegacyDecision.blockers[0]?.key, 'AUTOMATION_STRUCTURE');
    assert.match(oversizedLegacyDecision.summary, /at most 24/i);

    const invalidStripeDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_legacy_multi_delivery',
      workflowId: 'custom-workflow',
      steps: [{
        id: 'stripe-typo',
        kind: 'query',
        objective: 'Read Stripe revenue.',
        inputs: { source: 'stripe', query_type: 'typo' },
      }],
    });
    assert.equal(invalidStripeDecision.allowed, false);
    assert.equal(invalidStripeDecision.blockers[0]?.key, 'AUTOMATION_STRUCTURE');
    assert.match(invalidStripeDecision.summary, /query_type "typo" is not supported/i);

    const missingCaptureUrlDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_legacy_multi_delivery',
      workflowId: 'custom-workflow',
      steps: [{
        id: 'capture-missing-url',
        kind: 'capture',
        objective: 'Capture the pricing page.',
        inputs: {},
      }],
    });
    assert.equal(missingCaptureUrlDecision.allowed, false);
    assert.equal(missingCaptureUrlDecision.blockers[0]?.key, 'AUTOMATION_STRUCTURE');
    assert.match(missingCaptureUrlDecision.summary, /needs a public http or https URL/i);

    const invalidCaptureUrlDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_legacy_multi_delivery',
      workflowId: 'custom-workflow',
      steps: [{
        id: 'capture-invalid-url',
        kind: 'capture',
        objective: 'Capture the pricing page.',
        inputs: { url: 'file:///etc/passwd' },
      }],
    });
    assert.equal(invalidCaptureUrlDecision.allowed, false);
    assert.equal(invalidCaptureUrlDecision.blockers[0]?.key, 'AUTOMATION_STRUCTURE');
    assert.match(invalidCaptureUrlDecision.summary, /valid public http or https URL/i);

    const privateCaptureUrlDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_legacy_multi_delivery',
      workflowId: 'custom-workflow',
      steps: [{
        id: 'capture-instance-metadata',
        kind: 'capture',
        objective: 'Capture instance metadata.',
        inputs: { url: 'http://169.254.169.254/latest/meta-data' },
      }],
    });
    assert.equal(privateCaptureUrlDecision.allowed, false);
    assert.equal(privateCaptureUrlDecision.blockers[0]?.key, 'AUTOMATION_STRUCTURE');
    assert.match(privateCaptureUrlDecision.summary, /private network targets are blocked/i);

    for (const steps of [
      [
        { id: 'deliver-first', kind: 'deliver' as const, objective: 'Deliver the brief.', deliveryTarget: { channel: 'slack' as const, target: '#ops' } },
        { id: 'search-late', kind: 'search' as const, objective: 'Research the evidence.' },
      ],
      [
        {
          id: 'write-first',
          kind: 'query' as const,
          objective: 'Archive the brief.',
          inputs: { source: 'account_library', query_type: 'write', section: 'Competitive Intelligence' },
        },
        { id: 'search-late', kind: 'search' as const, objective: 'Research the evidence.' },
      ],
      [
        { id: 'deliver-first', kind: 'deliver' as const, objective: 'Deliver the brief.', deliveryTarget: { channel: 'slack' as const, target: '#ops' } },
        { id: 'search-late', kind: 'search' as const, objective: 'Research the evidence.' },
        { id: 'summary-late', kind: 'summarize' as const, objective: 'Summarize the evidence.' },
      ],
    ]) {
      const invalidOrderingDecision = await server.evaluateAutomationRunReadiness({
        workspaceId: 'workspace_legacy_multi_delivery',
        workflowId: 'custom-workflow',
        steps,
      });
      assert.equal(invalidOrderingDecision.allowed, false);
      assert.equal(invalidOrderingDecision.blockers[0]?.key, 'AUTOMATION_STRUCTURE');
      assert.match(invalidOrderingDecision.summary, /workflow step order/i);
    }

    const store = await import('../src/platform/store');
    store.addLedgerEntry({
      workspaceId: 'workspace_legacy_multi_delivery',
      source: 'manual_adjustment',
      deltaCredits: 500,
      referenceType: 'manual',
      referenceId: 'invalid-argument-readiness-funding',
    });
    const invalidRun = await server.runAutomation({
      id: 'invalid-stripe-run',
      workspaceId: 'workspace_legacy_multi_delivery',
      name: 'Invalid Stripe query',
      actions: ['Read Stripe revenue.'],
      steps: [{
        id: 'stripe-typo',
        kind: 'query',
        objective: 'Read Stripe revenue.',
        inputs: { source: 'stripe', query_type: 'typo' },
      }],
    });
    assert.equal(invalidRun.ok, false);
    assert.equal(store.getWorkspaceCreditReserve('workspace_legacy_multi_delivery').reservedCredits, 0);
    assert.deepEqual(
      store.listLedgerEntries('workspace_legacy_multi_delivery')
        .filter((entry) => entry.referenceType === 'automation'),
      [],
      'invalid executable arguments cannot acquire or settle an automation hold',
    );
    const invalidBlockedRun = store.listTaskRuns('workspace_legacy_multi_delivery')
      .find((item) => item.metadata?.automationId === 'invalid-stripe-run');
    assert.equal(invalidBlockedRun?.actualCredits, 0);

    const actionStripeDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_action_requirements',
      workflowId: 'custom-workflow',
      automationId: 'action-stripe',
      automationName: 'Action Stripe mission',
      actions: ['Check Stripe failed payments.'],
    });
    assert.equal(actionStripeDecision.allowed, false);
    assert.deepEqual(actionStripeDecision.blockers.map((blocker) => blocker.key), ['stripe']);

    const actionSearchDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_action_requirements',
      workflowId: 'custom-workflow',
      automationId: 'action-search',
      automationName: 'Action search mission',
      actions: ['Research competitors.'],
    });
    assert.equal(actionSearchDecision.allowed, false);
    assert.deepEqual(actionSearchDecision.blockers.map((blocker) => blocker.key), ['tavily']);

    const actionDeliveryDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_action_requirements',
      workflowId: 'custom-workflow',
      automationId: 'action-delivery',
      automationName: 'Action delivery mission',
      actions: ['Send the brief to #ops.'],
    });
    assert.equal(actionDeliveryDecision.allowed, false);
    assert.deepEqual(actionDeliveryDecision.blockers.map((blocker) => blocker.key), ['slack']);

    process.env.POSTMARK_API_KEY = 'test-postmark-key';
    process.env.POSTMARK_FROM_EMAIL = 'violema@example.com';
    const explicitEmailDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_action_requirements',
      workflowId: 'custom-workflow',
      automationId: 'explicit-email',
      automationName: 'Explicit email mission',
      actions: [],
      deliveryTarget: '#wrong-channel',
      steps: [{
        id: 'deliver-email',
        kind: 'deliver',
        objective: 'Email the founder.',
        deliveryTarget: { channel: 'email', target: 'founder@example.com' },
      }],
    });
    assert.equal(explicitEmailDecision.allowed, true);
    assert.deepEqual(explicitEmailDecision.blockers, []);

    emailSuppressions.recordEmailSuppression({
      action: 'suppress',
      email: 'founder@example.com',
      reason: 'hard_bounce',
      recordType: 'Bounce',
      bounceType: 'HardBounce',
    }, { now: () => '2026-08-22T12:00:00.000Z' });
    const suppressedEmailDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_action_requirements',
      workflowId: 'custom-workflow',
      automationId: 'suppressed-email',
      automationName: 'Suppressed email mission',
      actions: [],
      steps: [{
        id: 'deliver-email',
        kind: 'deliver',
        objective: 'Email the founder.',
        deliveryTarget: { channel: 'email', target: 'founder@example.com' },
      }],
    });
    assert.equal(suppressedEmailDecision.allowed, false);
    assert.deepEqual(suppressedEmailDecision.blockers.map((blocker) => blocker.key), ['delivery_target']);
    assert.match(suppressedEmailDecision.summary, /hard-bounced/i);

    emailSuppressions.recordEmailSuppression({
      action: 'suppress',
      email: 'demo-suppressed@example.com',
      reason: 'hard_bounce',
      recordType: 'Bounce',
      bounceType: 'HardBounce',
    }, { now: () => '2026-08-22T12:00:00.000Z' });
    const suppressedDemoDecision = await server.evaluateAutomationRunReadiness({
      workspaceId: 'workspace_demo_delivery',
      workflowId: 'custom-workflow',
      automationId: 'suppressed-demo-email',
      automationName: 'Suppressed demo email',
      actions: [],
      steps: [{
        id: 'deliver-email',
        kind: 'deliver',
        objective: 'Email the founder.',
        deliveryTarget: { channel: 'email', target: 'demo-suppressed@example.com' },
      }],
    });
    assert.equal(suppressedDemoDecision.allowed, false);
    assert.deepEqual(suppressedDemoDecision.blockers.map((blocker) => blocker.key), ['delivery_target']);
    assert.match(suppressedDemoDecision.summary, /hard-bounced/i);
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalDemoIds === 'string') process.env.DEMO_WORKSPACE_IDS = originalDemoIds;
    else delete process.env.DEMO_WORKSPACE_IDS;
    if (typeof originalTavilyKey === 'string') process.env.TAVILY_API_KEY = originalTavilyKey;
    else delete process.env.TAVILY_API_KEY;
    if (typeof originalPostmarkKey === 'string') process.env.POSTMARK_API_KEY = originalPostmarkKey;
    else delete process.env.POSTMARK_API_KEY;
    if (typeof originalPostmarkFrom === 'string') process.env.POSTMARK_FROM_EMAIL = originalPostmarkFrom;
    else delete process.env.POSTMARK_FROM_EMAIL;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

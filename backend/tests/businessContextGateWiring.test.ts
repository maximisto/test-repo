// The seam between the workspace business-context store and the run gate.
//
// `businessContextGate.test.ts` pins the pure rule and `businessContextStore.ts`
// pins the store. Neither notices if `evaluateAutomationRunReadiness` passes the
// wrong boolean — inverting that one comparison in server.ts left the whole
// suite green. This test drives the real store through the real gate so the
// wiring itself is covered.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-business-context-gate-wiring-'));
process.chdir(tempDir);
process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';

const WORKSPACE_ID = 'workspace_gate_wiring';

const CONTEXT_STEPS = [
  {
    id: 'step_contextual_summary',
    kind: 'summarize' as const,
    title: 'Summarize against company context',
    objective: 'Interpret the findings against this workspace business context.',
    inputs: { use_business_context: true },
  },
];

test('the run gate reads business-context state from the real workspace store', async () => {
  const serverModule = await import('../src/server');
  const workspace = await import('../src/platform/workspace');

  assert.equal(workspace.getBusinessContext(WORKSPACE_ID), null, 'precondition: no context yet');

  const blocked = await serverModule.evaluateAutomationRunReadiness({
    workspaceId: WORKSPACE_ID,
    workflowId: 'competitor-monitor',
    steps: CONTEXT_STEPS,
  });
  assert.equal(blocked.allowed, false, 'a flagged step with no context cannot run');
  assert.ok(
    blocked.blockers.some((blocker) => blocker.key === 'business_context_missing'),
    'the blocker names the missing business context',
  );

  const saved = workspace.setBusinessContext(WORKSPACE_ID, {
    summary: 'An AI-powered espresso machine company.',
    marketKeywords: ['AI-powered espresso machine'],
    competitors: ['decentespresso.com'],
  });
  assert.ok(saved.ok, 'precondition: the context saved');

  const unblocked = await serverModule.evaluateAutomationRunReadiness({
    workspaceId: WORKSPACE_ID,
    workflowId: 'competitor-monitor',
    steps: CONTEXT_STEPS,
  });
  assert.ok(
    !unblocked.blockers.some((blocker) => blocker.key === 'business_context_missing'),
    'setting the context clears the blocker through the same seam',
  );
});

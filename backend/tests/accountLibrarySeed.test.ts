import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// `AUTOMATIONS_FILE` is bound from `process.cwd()` when the scheduler is first
// imported, so this file owns its own store: chdir at module scope, then import
// dynamically. (`automationSeedMerge.test.ts` and `automationSeeds.contract.ts`
// each claim their own temp dir the same way.)
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-library-seed-'));
process.chdir(tempDir);

const AUTOMATIONS_FILE = path.join(tempDir, 'automations.json');
const COMPETITOR_SEED_ID = 'auto_competitor_monitor';

function writeAutomations(records: unknown[]) {
  fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(records, null, 2));
}

test('the competitor monitor seed reads the library before searching and records after drafting', async () => {
  const scheduler = await import('../src/scheduler');
  const {
    ACCOUNT_LIBRARY_SOURCE,
    ACCOUNT_LIBRARY_READ_QUERY_TYPE,
    ACCOUNT_LIBRARY_WRITE_QUERY_TYPE,
    COMPETITIVE_INTELLIGENCE_SECTION,
  } = await import('../src/integrationGateway/accountLibrary');

  scheduler.ensureCoreAutomationSeeds(async () => ({ ok: true }));
  scheduler.ensureCoreAutomationSeeds(async () => ({ ok: true }));

  const automations = scheduler.listAutomations();
  const competitor = automations.find((item) => item.id === COMPETITOR_SEED_ID);

  assert.ok(competitor, 'Expected the competitor monitor seed.');
  assert.equal(
    automations.filter((item) => item.id === COMPETITOR_SEED_ID).length,
    1,
    'Seeding twice must not create two missions.',
  );
  assert.equal(competitor.name, 'Competitor monitor');
  assert.equal(competitor.version, 3);
  assert.equal(competitor.workflowId, 'competitor-monitor');
  assert.equal(competitor.status, 'active');

  // The ordering IS the feature: read prior findings, then search, then reason
  // about the delta, then draft, then record, then deliver.
  assert.deepEqual(
    competitor.steps?.map((step) => step.kind),
    ['query', 'search', 'analyze', 'summarize', 'query', 'deliver'],
  );

  const librarySteps = competitor.steps?.filter(
    (step) => step.inputs?.source === ACCOUNT_LIBRARY_SOURCE,
  );
  assert.equal(librarySteps?.length, 2);
  assert.deepEqual(
    librarySteps?.map((step) => step.inputs?.query_type),
    [ACCOUNT_LIBRARY_READ_QUERY_TYPE, ACCOUNT_LIBRARY_WRITE_QUERY_TYPE],
  );

  const stepIds = competitor.steps?.map((step) => step.id) || [];
  assert.ok(
    stepIds.indexOf('step_library_context') < stepIds.indexOf('step_competitor_search'),
    'The library must be read before the web search.',
  );
  assert.ok(
    stepIds.indexOf('step_competitor_memo') < stepIds.indexOf('step_library_record'),
    'Findings are recorded from the drafted memo, so the draft must come first.',
  );
  assert.ok(
    stepIds.indexOf('step_library_record') < stepIds.indexOf('step_competitor_delivery'),
    'The library must be updated before delivery.',
  );

  // Both library steps name the same section, or the mission would read one
  // folder and write to another.
  assert.equal(
    librarySteps?.[0].inputs?.filters
      && (librarySteps[0].inputs.filters as Record<string, unknown>).section,
    COMPETITIVE_INTELLIGENCE_SECTION,
  );
  assert.equal(librarySteps?.[1].inputs?.section, COMPETITIVE_INTELLIGENCE_SECTION);

  // The analysis has to be delta-aware, otherwise the library is decoration.
  const analyze = competitor.steps?.find((step) => step.kind === 'analyze');
  const instruction = String(analyze?.inputs?.instruction || '');
  assert.match(instruction, /NEW/);
  assert.match(instruction, /CHANGED/);
  assert.match(instruction, /baseline/);
  assert.match(instruction, /prior library entries/);

  // Nothing sends without approval, matching the other seeded missions.
  assert.ok(
    competitor.steps?.some(
      (step) =>
        step.kind === 'deliver'
        && step.inputs?.approval_required === true
        && step.deliveryTarget?.channel === 'slack',
    ),
    'Expected an approval-gated delivery step.',
  );
});

test('the competitor seed is blocked on Google Drive until the library is reachable', async () => {
  const scheduler = await import('../src/scheduler');
  const { evaluateRunReadiness } = await import('../src/integrationGateway/runReadinessGate');

  scheduler.ensureCoreAutomationSeeds(async () => ({ ok: true }));
  const competitor = scheduler.listAutomations().find((item) => item.id === COMPETITOR_SEED_ID);
  assert.ok(competitor);

  const blocked = evaluateRunReadiness({
    workflowId: competitor.workflowId || 'competitor-monitor',
    workspaceId: 'ws_tenant',
    isDemoWorkspace: false,
    steps: competitor.steps,
    runtimeStatus: {},
  });

  assert.equal(blocked.allowed, false, 'The library mission must not run without its memory.');
  assert.deepEqual(
    blocked.blockers.map((blocker) => blocker.key),
    ['business_context_missing', 'google_drive', 'tavily', 'slack'],
  );
  assert.equal(blocked.blockers[1].label, 'Connect Google Drive');

  const ready = evaluateRunReadiness({
    workflowId: competitor.workflowId || 'competitor-monitor',
    workspaceId: 'ws_tenant',
    isDemoWorkspace: false,
    steps: competitor.steps,
    runtimeStatus: {
      google_drive: { ready: true },
      tavily: { ready: true },
      slack: { ready: true },
    },
    businessContextSet: true,
  });
  assert.equal(ready.allowed, true);
});

test('only the library WRITE step of the shipped competitor seed is auxiliary', async () => {
  const scheduler = await import('../src/scheduler');
  const { resolveAutomationStepSeverity } = await import('../src/platform/stepSeverity');

  scheduler.ensureCoreAutomationSeeds(async () => ({ ok: true }));
  const competitor = scheduler.listAutomations().find((item) => item.id === COMPETITOR_SEED_ID);
  assert.ok(competitor);

  // Classified against the real shipped step inputs, not a hand-written double,
  // so a seed edit that renames a source or drops a query type is caught here.
  assert.deepEqual(
    competitor.steps?.map((step) => [step.id, resolveAutomationStepSeverity(step)]),
    [
      // The delta baseline. A run that cannot read the library cannot claim
      // what CHANGED, so its failure still blocks delivery.
      ['step_library_context', 'critical'],
      ['step_competitor_search', 'critical'],
      ['step_delta_analysis', 'critical'],
      ['step_competitor_memo', 'critical'],
      // Archival bookkeeping, run after the memo is already drafted from
      // evidence that stands on its own. This is the incident step.
      ['step_library_record', 'auxiliary'],
      ['step_competitor_delivery', 'critical'],
    ],
  );
});

test('upgrading the competitor seed preserves operator-owned cadence and destination', async () => {
  const scheduler = await import('../src/scheduler');

  scheduler.ensureCoreAutomationSeeds(async () => ({ ok: true }));
  const seeded = scheduler.listAutomations().find((item) => item.id === COMPETITOR_SEED_ID);
  assert.ok(seeded);

  // An operator who paused the mission, moved it off the seed cadence, and
  // redirected delivery — on a pre-library version, so the next boot upgrades.
  writeAutomations([
    {
      ...seeded,
      version: 0,
      status: 'paused',
      schedule: 'every friday at 6pm',
      cron_expression: '0 18 * * 5',
      timezone: 'America/New_York',
      notify: '#operator-picked',
      condition: 'only when a competitor moves',
      created_at: '2026-06-01T12:00:00.000Z',
      last_run_at: '2026-07-18T12:00:00.000Z',
      last_run_status: 'succeeded',
      consecutive_failures: 0,
      next_run_at: undefined,
      // The pre-library step list, so the upgrade has something to propagate.
      steps: seeded.steps?.filter((step) => step.inputs?.source !== 'account_library'),
    },
  ]);

  scheduler.ensureCoreAutomationSeeds(async () => ({ ok: true }));
  const upgraded = scheduler.listAutomations().find((item) => item.id === COMPETITOR_SEED_ID);
  assert.ok(upgraded);

  // Operator-owned: untouched. A paused mission that silently resumes on
  // deploy is the bug this guards.
  assert.equal(upgraded.status, 'paused');
  assert.equal(upgraded.next_run_at, undefined);
  assert.equal(upgraded.schedule, 'every friday at 6pm');
  assert.equal(upgraded.cron_expression, '0 18 * * 5');
  assert.equal(upgraded.timezone, 'America/New_York');
  assert.equal(upgraded.notify, '#operator-picked');
  assert.equal(upgraded.condition, 'only when a competitor moves');
  assert.equal(upgraded.created_at, '2026-06-01T12:00:00.000Z');
  assert.equal(upgraded.last_run_at, '2026-07-18T12:00:00.000Z');
  assert.equal(upgraded.last_run_status, 'succeeded');

  // Seed-owned: the library steps did reach the existing install.
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.workflowId, 'competitor-monitor');
  assert.deepEqual(
    upgraded.steps
      ?.filter((step) => step.inputs?.source === 'account_library')
      .map((step) => step.inputs?.query_type),
    ['read', 'write'],
  );
});

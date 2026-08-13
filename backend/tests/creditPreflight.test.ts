import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * The credit cliff, both halves.
 *
 * A tenant ran a mission with 105 credits available against a 200-credit plan.
 * The run did all its expensive work and only then threw at `settleCreditHold`,
 * and the resulting failure path replaced the run's artifacts with a bare error
 * note. Two separate defects: nothing asked whether the run was affordable
 * before spending, and the settlement treated an overrun as fatal.
 *
 * ── Why this file chdirs before it imports anything ──────────────────────────
 *
 * `src/platform/store.ts` resolves its data files at MODULE LOAD time:
 *
 *     const LEDGER_FILE = path.join(process.cwd(), 'platform-credit-ledger.json');
 *
 * So the very first import of the store — including a transitive one through
 * `creditPreflight` — permanently binds these tests to whatever the cwd was at
 * that moment. Importing before `process.chdir` therefore does not merely leak
 * between tests; it writes synthetic ledger entries into the REAL
 * `backend/platform-credit-ledger.json`, which holds live customer credit
 * records.
 *
 * Hence: one temp directory, entered before the first import, and every test
 * scoped by a unique workspace id rather than by a fresh directory. The
 * `assertSandboxed` guard below fails loudly if that invariant is ever broken
 * by a future edit.
 */

const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-credit-preflight-'));
const originalCwd = process.cwd();
process.chdir(sandboxDir);

test.after(() => {
  process.chdir(originalCwd);
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

/**
 * Proof that the store bound itself to the sandbox and not to the repo. If this
 * ever fails, a test is one assertion away from mutating production data.
 */
function assertSandboxed() {
  assert.equal(
    process.cwd(),
    fs.realpathSync(sandboxDir),
    'platform store tests must run inside the mkdtemp sandbox, never the repo',
  );
  assert.equal(
    fs.existsSync(path.join(originalCwd, 'src')),
    true,
    'sanity: originalCwd should still be the backend package root',
  );
}

// ── A. Pre-flight affordability ───────────────────────────────────────────────

test('affordability compares the plan estimate against spendable credits', async () => {
  assertSandboxed();
  const { checkRunAffordability } = await import('../src/platform/creditPreflight');

  const short = checkRunAffordability({
    workspaceId: 'workspace_synthetic',
    estimatedCredits: 200,
    readAvailableCredits: () => 105,
  });
  assert.equal(short.affordable, false);
  assert.equal(short.availableCredits, 105);
  assert.equal(short.requiredCredits, 200);
  assert.equal(short.shortfallCredits, 95);

  // Exactly enough is enough — the gate must not be off by one.
  const exact = checkRunAffordability({
    workspaceId: 'workspace_synthetic',
    estimatedCredits: 200,
    readAvailableCredits: () => 200,
  });
  assert.equal(exact.affordable, true);
  assert.equal(exact.shortfallCredits, 0);
});

test('the insufficient-credits block names all three numbers and what to do', async () => {
  assertSandboxed();
  const { buildInsufficientCreditsBlock, checkRunAffordability, INSUFFICIENT_CREDITS_CODE } =
    await import('../src/platform/creditPreflight');

  const block = buildInsufficientCreditsBlock({
    automationName: 'Competitor Watch',
    affordability: checkRunAffordability({
      workspaceId: 'workspace_synthetic',
      estimatedCredits: 200,
      readAvailableCredits: () => 105,
    }),
    readTopUpCredits: () => 500,
  });

  assert.equal(block.code, INSUFFICIENT_CREDITS_CODE);
  assert.equal(block.availableCredits, 105);
  assert.equal(block.requiredCredits, 200);
  assert.equal(block.shortfallCredits, 95);
  assert.equal(block.suggestedTopUpCredits, 500);

  // The summary is what a founder reads on the blocked run, so it has to carry
  // the real numbers rather than a generic "insufficient credits".
  assert.match(block.summary, /105 available/);
  assert.match(block.summary, /200 required/);
  assert.match(block.summary, /95 short/);
  assert.match(block.summary, /Nothing was spent and nothing was sent/);
  assert.match(block.summary, /Add 500 credits/);

  const [blocker] = block.blockers;
  assert.equal(blocker.can_continue, false);
  assert.equal(blocker.nextAction.label, 'Add credits');
});

test('a missing top-up catalog degrades to a block without a suggestion, never a crash', async () => {
  assertSandboxed();
  const { buildInsufficientCreditsBlock, checkRunAffordability } =
    await import('../src/platform/creditPreflight');

  const block = buildInsufficientCreditsBlock({
    automationName: 'Competitor Watch',
    affordability: checkRunAffordability({
      workspaceId: 'workspace_synthetic',
      estimatedCredits: 200,
      readAvailableCredits: () => 105,
    }),
    readTopUpCredits: () => undefined,
  });

  assert.equal(block.suggestedTopUpCredits, undefined);
  assert.match(block.summary, /95 short/);
  assert.match(block.summary, /Add credits or upgrade the plan/);
});

test('affordability reads the live reserve, so an active hold makes a run unaffordable', async () => {
  assertSandboxed();
  const store = await import('../src/platform/store');
  const { checkRunAffordability } = await import('../src/platform/creditPreflight');
  const workspaceId = 'workspace_preflight_reserve';
  const now = new Date('2099-03-01T10:00:00.000Z');

  store.addLedgerEntry({
    workspaceId,
    source: 'manual_adjustment',
    deltaCredits: 200,
    referenceType: 'manual',
    referenceId: 'test_preflight_grant',
  });

  assert.equal(
    checkRunAffordability({ workspaceId, estimatedCredits: 200, now }).affordable,
    true,
  );

  // Another run is already holding most of the balance.
  store.acquireCreditHold({
    workspaceId,
    amountCredits: 95,
    referenceType: 'automation',
    referenceId: 'auto_concurrent',
    now,
    ttlMs: 60_000,
  });

  const afterHold = checkRunAffordability({ workspaceId, estimatedCredits: 200, now });
  assert.equal(afterHold.affordable, false);
  assert.equal(afterHold.availableCredits, 105);
  assert.equal(afterHold.shortfallCredits, 95);
});

// ── B. Settlement overrun must not erase the run ──────────────────────────────

test('settling an overrun charges what it can and reports the shortfall instead of throwing', async () => {
  assertSandboxed();
  const store = await import('../src/platform/store');
  const workspaceId = 'workspace_overrun_settle';
  const now = new Date('2099-03-02T10:00:00.000Z');

  store.addLedgerEntry({
    workspaceId,
    source: 'manual_adjustment',
    deltaCredits: 105,
    referenceType: 'manual',
    referenceId: 'test_overrun_grant',
  });

  const hold = store.acquireCreditHold({
    workspaceId,
    amountCredits: 105,
    referenceType: 'automation',
    referenceId: 'auto_overrun',
    now,
    ttlMs: 60_000,
  });

  // The old `settleCreditHold` is still strict — that is what threw in prod.
  assert.throws(
    () => store.settleCreditHold(hold.holdId, {
      workspaceId,
      source: 'automation_run',
      actualCredits: 200,
      now,
    }),
    /Insufficient credits/,
  );

  const settlement = store.settleCreditHoldWithOverrun(hold.holdId, {
    workspaceId,
    source: 'automation_run',
    actualCredits: 200,
    referenceType: 'automation',
    referenceId: 'auto_overrun',
    now,
  });

  assert.equal(settlement.overran, true);
  assert.equal(settlement.requestedCredits, 200);
  assert.equal(settlement.settledCredits, 105);
  assert.equal(settlement.overrunCredits, 95);

  // Charged to zero, never below it, and the hold is closed exactly once.
  const reserve = store.getWorkspaceCreditReserve(workspaceId, now);
  assert.equal(reserve.availableCredits, 0);
  assert.equal(reserve.reservedCredits, 0);
  assert.equal(store.getWorkspaceLedgerSummary(workspaceId).balanceCredits, 0);
});

test('a settlement within budget reports no overrun and debits the full amount', async () => {
  assertSandboxed();
  const store = await import('../src/platform/store');
  const workspaceId = 'workspace_normal_settle';
  const now = new Date('2099-03-03T10:00:00.000Z');

  store.addLedgerEntry({
    workspaceId,
    source: 'manual_adjustment',
    deltaCredits: 200,
    referenceType: 'manual',
    referenceId: 'test_normal_grant',
  });

  const hold = store.acquireCreditHold({
    workspaceId,
    amountCredits: 200,
    referenceType: 'automation',
    referenceId: 'auto_normal',
    now,
    ttlMs: 60_000,
  });

  const settlement = store.settleCreditHoldWithOverrun(hold.holdId, {
    workspaceId,
    source: 'automation_run',
    actualCredits: 60,
    now,
  });

  assert.equal(settlement.overran, false);
  assert.equal(settlement.settledCredits, 60);
  assert.equal(settlement.overrunCredits, 0);
  assert.equal(store.getWorkspaceCreditReserve(workspaceId, now).availableCredits, 140);
});

test('a blocked-for-credits run costs zero: no hold is taken and the balance is untouched', async () => {
  assertSandboxed();
  const store = await import('../src/platform/store');
  const { checkRunAffordability } = await import('../src/platform/creditPreflight');
  const workspaceId = 'workspace_blocked_costs_zero';
  const now = new Date('2099-03-04T10:00:00.000Z');

  store.addLedgerEntry({
    workspaceId,
    source: 'manual_adjustment',
    deltaCredits: 105,
    referenceType: 'manual',
    referenceId: 'test_blocked_grant',
  });

  const before = store.getWorkspaceCreditReserve(workspaceId, now);
  assert.equal(checkRunAffordability({ workspaceId, estimatedCredits: 200, now }).affordable, false);

  // The gate is a pure read: refusing must not reserve, debit, or grant anything.
  const after = store.getWorkspaceCreditReserve(workspaceId, now);
  assert.equal(after.availableCredits, before.availableCredits);
  assert.equal(after.reservedCredits, 0);
  assert.equal(store.getWorkspaceLedgerSummary(workspaceId).balanceCredits, 105);
  assert.equal(
    store.listLedgerEntries(workspaceId).filter((entry) => entry.source === 'credit_hold').length,
    0,
    'a blocked run must never open a credit hold',
  );
});

test('the per-run budget sanitizer accepts only positive integers', async () => {
  assertSandboxed();
  const { readPerRunCreditBudget } = await import('../src/platform/creditPreflight');

  assert.equal(readPerRunCreditBudget(150), 150);
  assert.equal(readPerRunCreditBudget(150.9), 150);
  assert.equal(readPerRunCreditBudget(0), null);
  assert.equal(readPerRunCreditBudget(-20), null);
  assert.equal(readPerRunCreditBudget(Number.NaN), null);
  assert.equal(readPerRunCreditBudget('150'), null);
  assert.equal(readPerRunCreditBudget(undefined), null);
  assert.equal(readPerRunCreditBudget(null), null);
});

test('the budget block pauses with both numbers and spends nothing by construction', async () => {
  assertSandboxed();
  const { buildCreditBudgetBlock, CREDIT_BUDGET_EXCEEDED_CODE } = await import('../src/platform/creditPreflight');

  const block = buildCreditBudgetBlock({
    automationName: 'Competitor monitor',
    estimatedCredits: 228,
    budgetCredits: 150,
    now: new Date('2026-08-13T09:00:00.000Z'),
  });

  assert.equal(block.code, CREDIT_BUDGET_EXCEEDED_CODE);
  assert.match(block.summary, /paused before running/);
  assert.match(block.summary, /Estimated 228 credits against a 150-credit budget/);
  assert.match(block.summary, /Nothing was spent and nothing was sent/);
  assert.equal(block.blockers.length, 1);
  assert.equal(block.blockers[0].code, CREDIT_BUDGET_EXCEEDED_CODE);
  assert.equal(block.blockers[0].can_continue, false);
  assert.ok(block.blockers[0].nextAction.route, 'the pause must point somewhere actionable');
  assert.equal(block.estimatedCredits, 228);
  assert.equal(block.budgetCredits, 150);
  assert.equal(block.blockedAt, '2026-08-13T09:00:00.000Z');
});

test('the budget overrun warning names both numbers and keeps the work', async () => {
  assertSandboxed();
  const { buildCreditBudgetOverrunWarning } = await import('../src/platform/creditPreflight');

  const warning = buildCreditBudgetOverrunWarning({
    automationName: 'Competitor monitor',
    actualCredits: 228,
    budgetCredits: 150,
  });

  assert.match(warning, /228 credits/);
  assert.match(warning, /150-credit per-run budget/);
  assert.match(warning, /kept/);
});

test('the overrun reason keeps the run readable rather than blaming the customer', async () => {
  assertSandboxed();
  const { buildCreditOverrunReason } = await import('../src/platform/creditPreflight');

  const reason = buildCreditOverrunReason({
    automationName: 'Competitor Watch',
    settledCredits: 105,
    requestedCredits: 200,
    overrunCredits: 95,
  });

  assert.match(reason, /finished its work/);
  assert.match(reason, /200 credits were used/);
  assert.match(reason, /105 could be charged/);
  assert.match(reason, /95 short/);
  assert.match(reason, /kept below/);
});

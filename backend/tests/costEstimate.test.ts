import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_TOKENS_PER_MODEL_CALL,
  countPlannedModelCalls,
  estimateCreditCost,
} from '../src/platform/cost';

/**
 * The estimate gap (talk day, 2026-08-11): a run estimated at 68 credits
 * settled at 228, because the runtime charge is token-dominated and the
 * estimate carried no token term at all. These tests pin the projected-token
 * term and the model-call count it needs.
 */

// The espresso mission's shape: searches, a library read, drafting, a
// library write, and a delivery.
const ESPRESSO_STEPS = [
  { kind: 'web_search', inputs: {} },
  { kind: 'web_search', inputs: {} },
  { kind: 'query', inputs: { source: 'account_library', query_type: 'read' } },
  { kind: 'analyze', inputs: {} },
  { kind: 'summarize', inputs: {} },
  { kind: 'query', inputs: { source: 'account_library', query_type: 'write' } },
  { kind: 'deliver', inputs: {} },
];

test('countPlannedModelCalls counts drafting, the baseline merge, and the memo tier', () => {
  // analyze + summarize + baseline merge (library write) + memo tier
  // (deliver AND library write present).
  assert.equal(countPlannedModelCalls(ESPRESSO_STEPS), 4);

  // No library write: no baseline merge, and no memo tier either — the memo
  // only exists to link to a persisted document.
  assert.equal(
    countPlannedModelCalls(ESPRESSO_STEPS.filter((step) => step.inputs.query_type !== 'write')),
    2,
  );

  assert.equal(countPlannedModelCalls([]), 0);
  assert.equal(countPlannedModelCalls(undefined), 0);
  assert.equal(countPlannedModelCalls(null), 0);
});

test('the projected token term uses the runtime per-1K rate on the expected volume', () => {
  const withCalls = estimateCreditCost({
    taskKind: 'automation',
    modelTier: 'hard',
    automationRuns: 1,
    modelCallCount: 4,
  });
  // hard bills 10 credits per 1K tokens at runtime; 4 calls × the expected
  // volume must be priced at that same rate — the whole point is that the
  // estimate and the bill speak the same arithmetic.
  const expectedTokenCredits = Math.ceil((4 * EXPECTED_TOKENS_PER_MODEL_CALL) / 1000) * 10;
  assert.equal(withCalls.breakdown.projectedTokenCredits, expectedTokenCredits);
  assert.ok(withCalls.rationale.includes(`projected_tokens:${expectedTokenCredits}`));

  const withoutCalls = estimateCreditCost({
    taskKind: 'automation',
    modelTier: 'hard',
    automationRuns: 1,
  });
  assert.equal(withoutCalls.breakdown.projectedTokenCredits, 0);
  assert.equal(
    withCalls.estimatedCredits - withoutCalls.estimatedCredits,
    expectedTokenCredits,
    'the token term is additive on top of the old estimate',
  );
});

test('the talk-day run shape no longer estimates 3× under its measured cost', () => {
  // Measured 2026-08-11: 228 actual credits against a 68-credit estimate.
  const estimate = estimateCreditCost({
    taskKind: 'automation',
    modelTier: 'hard',
    automationRuns: 1,
    toolCalls: 3,
    complexity: 'medium',
    modelCallCount: countPlannedModelCalls(ESPRESSO_STEPS),
  });
  assert.ok(
    estimate.estimatedCredits >= 150,
    `an espresso-shaped run must estimate in the measured cost's magnitude, got ${estimate.estimatedCredits}`,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_TOKENS_PER_MODEL_CALL,
  calculateRuntimeCredits,
  countPlannedModelCalls,
  estimateGenerationCallTokenCredits,
  estimateCreditCost,
  maximumGenerationCallTokenCredits,
} from '../src/platform/cost';
import { automationSummaryTokenBudget } from '../src/platform/automationSummaryPolicy';

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

  assert.equal(
    countPlannedModelCalls([
      { kind: 'analyze', title: 'Competitive landscape', objective: 'Compare competitors' },
    ]),
    2,
    'competitive analysis includes its structured extraction generation',
  );
});

test('summary projections include evidence-sized input and the runtime output allowance', () => {
  const evidenceSizes = [0, 20_000, 100_000];
  const previousMaxOutputs: number[] = [];

  for (const evidenceBytes of evidenceSizes) {
    const evidence = 'e'.repeat(evidenceBytes);
    const maxOutputTokens = automationSummaryTokenBudget(evidence.length);
    const projection = estimateGenerationCallTokenCredits({
      modelTier: 'default',
      promptBytes: Buffer.byteLength(evidence, 'utf8'),
      maxOutputTokens,
    });
    const maximum = maximumGenerationCallTokenCredits({
      modelTier: 'default',
      promptBytes: Buffer.byteLength(evidence, 'utf8'),
      maxOutputTokens,
    });

    assert.equal(projection.promptBytes, evidenceBytes);
    assert.ok(projection.projectedInputTokens >= Math.ceil(evidenceBytes / 4));
    assert.ok(projection.projectedOutputTokens > 0);
    assert.equal(projection.maxOutputTokens, maxOutputTokens);
    assert.ok(maximum.tokenCredits >= projection.tokenCredits);
    previousMaxOutputs.push(maxOutputTokens);
  }

  assert.deepEqual(previousMaxOutputs, [2_200, 3_450, 6_000]);
});

test('a cost estimate prices heterogeneous per-call projections at their own tiers', () => {
  const calls = [
    { modelTier: 'hard' as const, promptBytes: 4_000, maxOutputTokens: 500 },
    { modelTier: 'ops' as const, promptBytes: 1_000, maxOutputTokens: 900 },
  ];
  const expected = calls.reduce(
    (sum, call) => sum + estimateGenerationCallTokenCredits(call).tokenCredits,
    0,
  );
  const estimate = estimateCreditCost({
    taskKind: 'automation',
    modelTier: 'hard',
    generationProjections: calls,
  });
  assert.equal(estimate.breakdown.projectedTokenCredits, expected);
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

test('runtime credits include every generation owned by a step at its own tier', () => {
  const charge = calculateRuntimeCredits({
    taskKind: 'automation',
    modelTier: 'hard',
    generationCalls: [
      {
        modelTier: 'hard',
        usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
      },
      {
        modelTier: 'ops',
        usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      },
    ],
  } as Parameters<typeof calculateRuntimeCredits>[0] & {
    generationCalls: Array<{
      modelTier: 'hard' | 'ops';
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }>;
  });

  // Hard: ceil(1,200 / 1,000) × 10 = 20. Ops: ceil(700 / 1,000) × 5 = 5.
  assert.equal(charge.breakdown.tokenCredits, 25);
  assert.equal(charge.actualCredits, 37, '12 automation base credits plus both generation charges');
});

test('a contradictory usage total never undercuts its observed token components', () => {
  const charge = calculateRuntimeCredits({
    taskKind: 'automation',
    modelTier: 'ops',
    generationCalls: [{
      modelTier: 'ops',
      usage: { inputTokens: 800, outputTokens: 300, totalTokens: 900 },
    }],
  });

  assert.equal(charge.breakdown.tokenCredits, 10, 'the known minimum is 1,100 tokens, not the contradictory 900 total');
});

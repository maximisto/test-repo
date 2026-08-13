import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_MEMO_MAX_TOKENS,
  AUTOMATION_MEMO_WORD_LIMIT,
  AUTOMATION_SUMMARY_BASE_TOKENS,
  AUTOMATION_SUMMARY_TOKEN_CEILING,
  AUTOMATION_SUMMARY_WORD_LIMIT,
  appendFullAnalysisLink,
  automationSummaryTokenBudget,
  requireCompleteAutomationSummary,
} from '../src/platform/automationSummaryPolicy';

test('automation summaries have enough output budget for a complete founder brief', () => {
  assert.ok(AUTOMATION_SUMMARY_BASE_TOKENS >= 1400);
  assert.ok(automationSummaryTokenBudget(0) >= 1400);
});

test('the summary token budget scales with evidence size and is bounded on both ends', () => {
  // Talk-day regression (2026-08-11): the library grew every run, evidence
  // got richer, table-heavy drafts crossed the fixed 2,200-token cap, and
  // the truncation guard refused two runs in a row. The budget now grows
  // with the evidence the model is asked to compress.
  assert.equal(automationSummaryTokenBudget(0), AUTOMATION_SUMMARY_BASE_TOKENS, 'tiny evidence keeps the base budget');
  assert.ok(
    automationSummaryTokenBudget(24_000) >= 3_500,
    'a full evidence block (~24KB, the library read ceiling) earns real headroom over the base',
  );
  assert.equal(
    automationSummaryTokenBudget(10_000_000),
    AUTOMATION_SUMMARY_TOKEN_CEILING,
    'the ceiling bounds cost no matter how large the evidence grows',
  );
  // Monotonic: more evidence never shrinks the budget.
  let previous = -1;
  for (const chars of [0, 1_000, 8_000, 24_000, 64_000, 1_000_000]) {
    const budget = automationSummaryTokenBudget(chars);
    assert.ok(budget >= previous, `budget must not shrink as evidence grows (at ${chars})`);
    previous = budget;
  }
  // Garbage in, base out — never NaN into a provider request.
  assert.equal(automationSummaryTokenBudget(Number.NaN), AUTOMATION_SUMMARY_BASE_TOKENS);
  assert.equal(automationSummaryTokenBudget(-50), AUTOMATION_SUMMARY_BASE_TOKENS);
});

test('requireCompleteAutomationSummary rejects provider-truncated drafts', () => {
  assert.throws(
    () => requireCompleteAutomationSummary({
      text: '# Weekly Founder Update\n\nIncomplete table row |',
      stopReason: 'length',
    }),
    /output limit/i,
  );
  assert.throws(
    () => requireCompleteAutomationSummary({
      text: '# Weekly Founder Update\n\nIncomplete',
      stopReason: 'max_tokens',
    }),
    /output limit/i,
  );
});

test('the memo tier is a real condensation with room to finish', () => {
  // Two tiers only make sense if the memo is meaningfully shorter than the
  // brief it condenses, and the token bound must leave the word limit
  // reachable — a memo refused for truncation on every run would just be
  // the 2026-08-11 failure with extra steps.
  assert.equal(AUTOMATION_MEMO_WORD_LIMIT, 350);
  assert.ok(AUTOMATION_MEMO_WORD_LIMIT < AUTOMATION_SUMMARY_WORD_LIMIT);
  assert.ok(AUTOMATION_MEMO_MAX_TOKENS >= AUTOMATION_MEMO_WORD_LIMIT * 2);
  assert.ok(AUTOMATION_MEMO_MAX_TOKENS < AUTOMATION_SUMMARY_BASE_TOKENS);
});

test('appendFullAnalysisLink points the memo at the persisted document', () => {
  const linked = appendFullAnalysisLink('## Memo\n- Rival at $179.\n', 'https://drive.google.com/file/d/abc123/view');
  assert.equal(
    linked,
    '## Memo\n- Rival at $179.\n\n_Full analysis: [open in your Violema Library](https://drive.google.com/file/d/abc123/view)_',
  );
});

test('requireCompleteAutomationSummary accepts and trims completed drafts', () => {
  assert.equal(
    requireCompleteAutomationSummary({
      text: '  # Weekly Founder Update\n\n## Next actions\n- Ship.  ',
      stopReason: 'stop',
    }),
    '# Weekly Founder Update\n\n## Next actions\n- Ship.',
  );
});

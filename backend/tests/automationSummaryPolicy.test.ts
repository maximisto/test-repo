import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_MEMO_MAX_TOKENS,
  AUTOMATION_MEMO_MAX_BYTES,
  AUTOMATION_MEMO_BODY_WORD_LIMIT,
  AUTOMATION_MEMO_WORD_LIMIT,
  AUTOMATION_SUMMARY_BASE_TOKENS,
  AUTOMATION_SUMMARY_TOKEN_CEILING,
  AUTOMATION_SUMMARY_MAX_BYTES,
  AUTOMATION_SUMMARY_WORD_LIMIT,
  appendFullAnalysisLink,
  buildBoundedAutomationSummaryFallback,
  buildDeterministicAutomationMemo,
  countAutomationWords,
  automationSummaryTokenBudget,
  requireCompleteAutomationMemo,
  requireCompleteAutomationMemoWithLink,
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

test('the final rendered memo keeps its library footer inside the 350-word limit', () => {
  const words = Array.from(
    { length: AUTOMATION_MEMO_BODY_WORD_LIMIT },
    (_, index) => `word${index + 1}`,
  ).join(' ');
  const linked = requireCompleteAutomationMemoWithLink(
    { text: words, stopReason: 'stop' },
    'https://drive.google.com/file/d/abc123/view',
  );
  assert.equal(countAutomationWords(linked), AUTOMATION_MEMO_WORD_LIMIT);
  assert.throws(
    () => requireCompleteAutomationMemo({ text: `${words} overflow`, stopReason: 'stop' }),
    new RegExp(`${AUTOMATION_MEMO_BODY_WORD_LIMIT}-word limit`, 'i'),
  );
});

test('an invalid model memo falls back to a deterministic bounded slice of the full brief', () => {
  const fullBrief = Array.from({ length: 500 }, (_, index) => `fact${index + 1}`).join(' ');
  const memo = buildDeterministicAutomationMemo(
    fullBrief,
    'https://drive.google.com/file/d/abc123/view',
  );
  assert.equal(countAutomationWords(memo), AUTOMATION_MEMO_WORD_LIMIT);
  assert.match(memo, /fact1/);
  assert.doesNotMatch(memo, /fact500/);
  assert.match(memo, /Full analysis/);
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

test('generated outputs accept only complete provider terminal reasons', () => {
  for (const stopReason of ['stop', 'end_turn', 'stop_sequence']) {
    assert.equal(
      requireCompleteAutomationSummary({ text: 'Complete founder brief.', stopReason }),
      'Complete founder brief.',
      `${stopReason} is a complete text-generation terminal`,
    );
  }

  for (const stopReason of ['content_filter', 'tool_calls', 'function_call']) {
    assert.throws(
      () => requireCompleteAutomationSummary({
        text: 'A nonempty but incomplete provider draft.',
        stopReason,
      }),
      /incomplete provider stop reason/i,
      `${stopReason} cannot be mistaken for a finished brief`,
    );
    assert.throws(
      () => requireCompleteAutomationMemo({
        text: 'A nonempty but incomplete delivery memo.',
        stopReason,
      }),
      /incomplete provider stop reason/i,
      `${stopReason} cannot be mistaken for a finished memo`,
    );
  }
});

test('a deterministic fallback stays bounded when a full prior brief is followed by step errors', () => {
  const priorBrief = Array.from(
    { length: AUTOMATION_SUMMARY_WORD_LIMIT },
    (_, index) => `résultat${index + 1}`,
  ).join('\u2003');
  const stepLines = Array.from(
    { length: 24 },
    (_, index) => `FAILED step ${index + 1}: provider detail ${index + 1}`,
  ).join('\n');
  const bounded = buildBoundedAutomationSummaryFallback(`${priorBrief}\n\n${stepLines}`);

  assert.equal(countAutomationWords(bounded), AUTOMATION_SUMMARY_WORD_LIMIT);
  assert.match(bounded, /résultat1/);
  assert.doesNotMatch(bounded, /FAILED/);
});

test('summary and memo word limits are deterministic across markdown and Unicode whitespace', () => {
  const validateWithLimit = requireCompleteAutomationSummary;
  const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index + 1}`).join(' ');

  assert.equal(
    validateWithLimit({ text: words(AUTOMATION_SUMMARY_WORD_LIMIT), stopReason: 'stop' }, AUTOMATION_SUMMARY_WORD_LIMIT),
    words(AUTOMATION_SUMMARY_WORD_LIMIT),
    'an exact-limit full brief is accepted',
  );
  assert.throws(
    () => validateWithLimit(
      { text: words(AUTOMATION_SUMMARY_WORD_LIMIT + 1), stopReason: 'stop' },
      AUTOMATION_SUMMARY_WORD_LIMIT,
    ),
    /650-word limit/i,
  );

  assert.equal(
    validateWithLimit({ text: words(AUTOMATION_MEMO_WORD_LIMIT), stopReason: 'stop' }, AUTOMATION_MEMO_WORD_LIMIT),
    words(AUTOMATION_MEMO_WORD_LIMIT),
    'an exact-limit memo is accepted',
  );
  assert.throws(
    () => validateWithLimit(
      { text: words(AUTOMATION_MEMO_WORD_LIMIT + 1), stopReason: 'stop' },
      AUTOMATION_MEMO_WORD_LIMIT,
    ),
    /350-word limit/i,
  );

  const linked = `${words(648)} [Purple Orange](https://example.com/source)`;
  assert.equal(
    validateWithLimit({ text: linked, stopReason: 'stop' }, AUTOMATION_SUMMARY_WORD_LIMIT),
    linked,
    'a markdown link counts its visible label, not its URL',
  );

  const table = `${words(646)}\n| Rival | Move |\n| --- | --- |\n| Alpha | Launched |`;
  assert.equal(
    validateWithLimit({ text: table, stopReason: 'stop' }, AUTOMATION_SUMMARY_WORD_LIMIT),
    table,
    'table delimiters and separator dashes are not words',
  );

  const unicodeWhitespace = Array.from({ length: AUTOMATION_MEMO_WORD_LIMIT }, (_, index) => `u${index + 1}`)
    .join('\u2003');
  assert.equal(
    validateWithLimit({ text: unicodeWhitespace, stopReason: 'stop' }, AUTOMATION_MEMO_WORD_LIMIT),
    unicodeWhitespace,
    'Unicode whitespace separates words consistently',
  );
});

// NF-7 (2026-08-23 re-review): scripts written without spaces must not count
// as one word. Each CJK character is counted, which overcounts and so fails
// closed, consistent with the rest of the counter.
test('unspaced CJK text cannot bypass the word limit', () => {
  const han = '市场竞争分析'.repeat(400); // 2,400 Han characters, no spaces
  assert.ok(countAutomationWords(han) >= 2_000, 'each Han character counts, not the whole run as one word');
  assert.throws(
    () => requireCompleteAutomationSummary({ text: han, stopReason: 'stop' }),
    /over the 650-word limit/i,
  );

  const mixed = '竞争对手 Alpha 提价 10%';
  assert.equal(countAutomationWords(mixed), 4 + 1 + 2 + 1, 'Han characters, a Latin word, Han characters, a number');

  const kana = 'きょうそうぶんせき'.repeat(100);
  assert.ok(countAutomationWords(kana) >= 900, 'kana are counted per character too');
  const hangul = '경쟁분석'.repeat(200);
  assert.ok(countAutomationWords(hangul) >= 800, 'Hangul syllables are counted per character');
});

test('the memo validator enforces the 350-word delivery contract', () => {
  const words = (count: number) => Array.from({ length: count }, (_, index) => `memo${index + 1}`).join(' ');

  assert.equal(
    requireCompleteAutomationMemo({ text: words(AUTOMATION_MEMO_BODY_WORD_LIMIT), stopReason: 'stop' }),
    words(AUTOMATION_MEMO_BODY_WORD_LIMIT),
  );
  assert.throws(
    () => requireCompleteAutomationMemo({ text: words(AUTOMATION_MEMO_BODY_WORD_LIMIT + 1), stopReason: 'stop' }),
    new RegExp(`${AUTOMATION_MEMO_BODY_WORD_LIMIT}-word limit`, 'i'),
  );
});

test('long URLs and giant tokens cannot bypass generated-output byte ceilings', () => {
  const longSummaryUrl = `https://example.com/${'a'.repeat(AUTOMATION_SUMMARY_MAX_BYTES)}`;
  assert.throws(
    () => requireCompleteAutomationSummary({
      text: `One visible fact [source](${longSummaryUrl})`,
      stopReason: 'stop',
    }),
    new RegExp(`${AUTOMATION_SUMMARY_MAX_BYTES}-byte limit`, 'i'),
  );

  const longMemoUrl = `https://example.com/${'b'.repeat(AUTOMATION_MEMO_MAX_BYTES)}`;
  assert.throws(
    () => requireCompleteAutomationMemo({
      text: `One visible fact [source](${longMemoUrl})`,
      stopReason: 'stop',
    }),
    new RegExp(`${AUTOMATION_MEMO_MAX_BYTES}-byte limit`, 'i'),
  );

  const fallback = buildBoundedAutomationSummaryFallback('ü'.repeat(AUTOMATION_SUMMARY_MAX_BYTES));
  assert.ok(Buffer.byteLength(fallback, 'utf8') <= AUTOMATION_SUMMARY_MAX_BYTES);
});

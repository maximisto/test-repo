import type { TextGenerationResult } from '../models';

// Sized for the current brief shape on the hard tier: up to the word limit of
// prose plus a competitor table and inline source links, with headroom so
// complete drafts never trip the truncation rejection.
export const AUTOMATION_SUMMARY_BASE_TOKENS = 2200;
export const AUTOMATION_SUMMARY_WORD_LIMIT = 650;
/** Downstream prompt projections and validators share this exact byte cap. */
export const AUTOMATION_SUMMARY_MAX_BYTES = 32_000;

/**
 * Hard cost bound on any single summary generation, however rich the
 * evidence. The truncation guard below still refuses a draft that hits it —
 * the ceiling bounds spend, never honesty.
 */
export const AUTOMATION_SUMMARY_TOKEN_CEILING = 6000;

/**
 * The delivery tier of the two-tier deliverable. The FULL brief (word limit
 * above) is what gets persisted to the account library; what lands in Slack
 * is a memo condensed to this limit, linking back to the full document. On
 * 2026-08-11 the operator had to choose between a rich brief that tripped
 * output caps and a short one that lost the analysis — the two tiers remove
 * that trade: depth persists, delivery stays scannable.
 */
export const AUTOMATION_MEMO_WORD_LIMIT = 350;
export const AUTOMATION_MEMO_MAX_BYTES = 16_000;
export const AUTOMATION_ANALYSIS_MAX_BYTES = 16_000;
export const AUTOMATION_EXTRACTION_MAX_BYTES = 16_000;

/** The fixed library footer consumes seven visible words inside that limit. */
export const AUTOMATION_MEMO_LINK_WORDS = 7;
export const AUTOMATION_MEMO_BODY_WORD_LIMIT =
  AUTOMATION_MEMO_WORD_LIMIT - AUTOMATION_MEMO_LINK_WORDS;

/** Output bound for the memo tier — sized for the word limit plus links, with headroom. */
export const AUTOMATION_MEMO_MAX_TOKENS = 900;

/** The delivery memo's pointer at the persisted full document. */
export function appendFullAnalysisLink(memoMarkdown: string, link: string): string {
  return `${memoMarkdown.trimEnd()}\n\n_Full analysis: [open in your Violema Library](${link})_`;
}

/**
 * Deterministic, evidence-only fallback when the memo model fails or returns
 * an invalid body. It uses words already present in the reviewed full brief,
 * strips fragile markdown syntax, and reserves the footer inside 350 words.
 */
export function buildDeterministicAutomationMemo(summaryMarkdown: string, link: string): string {
  const visible = summaryMarkdown
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))+\)/gu, '$1')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[`*_>#|~]+/gu, ' ');
  const words = visible.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? [];
  const body = boundUtf8Bytes(
    words.slice(0, AUTOMATION_MEMO_BODY_WORD_LIMIT).join(' '),
    Math.max(1, AUTOMATION_MEMO_MAX_BYTES - Buffer.byteLength(appendFullAnalysisLink('', link), 'utf8')),
  );
  const linked = appendFullAnalysisLink(body || 'Full analysis is available in the library.', link);
  // Defense in depth for future footer-copy changes.
  return requireCompleteAutomationSummary({ text: linked }, AUTOMATION_MEMO_WORD_LIMIT);
}

/** Evidence characters that earn one extra output token (~¼ token of output headroom per evidence token). */
const EVIDENCE_CHARS_PER_EXTRA_TOKEN = 16;

/**
 * Output budget for a summary generation, scaled to the evidence it must
 * compress.
 *
 * A fixed cap could not survive a growing library: every run enriched the
 * evidence, richer evidence produced more tables, rows, and links per word,
 * and on 2026-08-11 two consecutive runs crossed the fixed 2,200-token cap
 * and were (correctly) refused by the truncation guard. The word limit in
 * the prompt still bounds the PROSE; this budget grants markdown structure
 * room proportional to what the model was handed, so an evidence-rich draft
 * is not refused for the crime of citing its evidence.
 */
export function automationSummaryTokenBudget(evidenceCharCount: number): number {
  const evidenceChars = Number.isFinite(evidenceCharCount) ? Math.max(0, Math.floor(evidenceCharCount)) : 0;
  return Math.min(
    AUTOMATION_SUMMARY_TOKEN_CEILING,
    AUTOMATION_SUMMARY_BASE_TOKENS + Math.floor(evidenceChars / EVIDENCE_CHARS_PER_EXTRA_TOKEN),
  );
}

const TRUNCATION_STOP_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
]);

// These are the only terminal reasons emitted by the supported text routes
// that mean the provider finished a normal text response. Reasons such as
// content_filter/tool_calls/function_call can carry nonempty partial text, but
// that text is not a completed operator-facing brief.
const COMPLETE_TEXT_STOP_REASONS = new Set([
  'stop',
  'end_turn',
  'stop_sequence',
]);

function boundUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bounded = '';
  let used = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    bounded += character;
    used += bytes;
  }
  return bounded.trimEnd();
}

export function requireBoundedAutomationOutput(
  result: TextGenerationResult,
  byteLimit: number,
  label = 'output',
) {
  const stopReason = result.stopReason?.trim().toLowerCase();
  if (stopReason && TRUNCATION_STOP_REASONS.has(stopReason)) {
    throw new Error(`Generated ${label} exceeded the output limit and was withheld from review.`);
  }
  if (stopReason && !COMPLETE_TEXT_STOP_REASONS.has(stopReason)) {
    throw new Error(
      `Generated ${label} ended with incomplete provider stop reason "${stopReason}" and was withheld from review.`,
    );
  }
  const text = result.text.trim();
  if (!text) {
    throw new Error(`Generated ${label} was empty and was withheld from review.`);
  }
  const byteCount = Buffer.byteLength(text, 'utf8');
  if (byteCount > byteLimit) {
    throw new Error(`Generated ${label} contains ${byteCount} bytes, over the ${byteLimit}-byte limit.`);
  }
  return text;
}

export function countAutomationWords(text: string): number {
  const visibleMarkdown = text
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))+\)/gu, '$1')
    .replace(/https?:\/\/\S+/giu, ' ');
  return visibleMarkdown.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/**
 * Last-resort summaries are assembled from stored evidence, so they can grow
 * past the model-facing contract without ever touching a provider validator.
 * Convert that exceptional path to bounded visible text using the exact same
 * Unicode word definition as the final validator.
 */
export function buildBoundedAutomationSummaryFallback(
  summaryText: string,
  wordLimit = AUTOMATION_SUMMARY_WORD_LIMIT,
): string {
  const visible = summaryText
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))+\)/gu, '$1')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[`*_>#|~]+/gu, ' ');
  const words = visible.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? [];
  const bounded = boundUtf8Bytes(
    words.slice(0, wordLimit).join(' '),
    AUTOMATION_SUMMARY_MAX_BYTES,
  ) || 'Automation summary unavailable.';
  return requireCompleteAutomationSummary({ text: bounded }, wordLimit);
}

export function requireCompleteAutomationSummary(
  result: TextGenerationResult,
  wordLimit = AUTOMATION_SUMMARY_WORD_LIMIT,
  byteLimit = AUTOMATION_SUMMARY_MAX_BYTES,
) {
  const text = requireBoundedAutomationOutput(result, byteLimit, 'summary');
  const wordCount = countAutomationWords(text);
  if (wordCount > wordLimit) {
    throw new Error(`Generated summary contains ${wordCount} words, over the ${wordLimit}-word limit.`);
  }
  return text;
}

export function requireCompleteAutomationMemo(result: TextGenerationResult) {
  return requireCompleteAutomationSummary(
    result,
    AUTOMATION_MEMO_BODY_WORD_LIMIT,
    AUTOMATION_MEMO_MAX_BYTES,
  );
}

export function requireCompleteAutomationMemoWithLink(
  result: TextGenerationResult,
  link: string,
) {
  const linked = appendFullAnalysisLink(requireCompleteAutomationMemo(result), link);
  return requireCompleteAutomationSummary(
    { ...result, text: linked },
    AUTOMATION_MEMO_WORD_LIMIT,
    AUTOMATION_MEMO_MAX_BYTES,
  );
}

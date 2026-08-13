import type { TextGenerationResult } from '../models';

// Sized for the current brief shape on the hard tier: up to the word limit of
// prose plus a competitor table and inline source links, with headroom so
// complete drafts never trip the truncation rejection.
export const AUTOMATION_SUMMARY_BASE_TOKENS = 2200;
export const AUTOMATION_SUMMARY_WORD_LIMIT = 650;

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

/** Output bound for the memo tier — sized for the word limit plus links, with headroom. */
export const AUTOMATION_MEMO_MAX_TOKENS = 900;

/** The delivery memo's pointer at the persisted full document. */
export function appendFullAnalysisLink(memoMarkdown: string, link: string): string {
  return `${memoMarkdown.trimEnd()}\n\n_Full analysis: [open in your Violema Library](${link})_`;
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

export function requireCompleteAutomationSummary(result: TextGenerationResult) {
  const stopReason = result.stopReason?.trim().toLowerCase();
  if (stopReason && TRUNCATION_STOP_REASONS.has(stopReason)) {
    throw new Error('Generated summary exceeded the output limit and was withheld from review.');
  }

  const text = result.text.trim();
  if (!text) {
    throw new Error('Generated summary was empty and was withheld from review.');
  }
  return text;
}

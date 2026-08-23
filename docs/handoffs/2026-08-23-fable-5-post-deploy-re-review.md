# Fable 5 re-review of the repair set (post-deploy)

**Repository:** `/Users/maximisto/Documents/New project`
**Reviewed:** `main` @ `f77acc4` (merge of PR #5, repair commit `103efbf`)
**Against:** `docs/handoffs/2026-08-16-fable-5-adversarial-review.md` (11 findings, F5-01..F5-11)
**Review date:** 2026-08-23
**Production state:** `f77acc4` is LIVE on violema.com since 2026-08-22 ~20:55 CT (vault dashboard). This is a post-deploy audit; every defect below is in production.
**Verdict on the original handoff:** **CLOSED** (8 FIXED, 3 PARTIAL, zero fail-open budget paths, zero evidence-loss paths).
**Verdict on the repair set as shipped:** **HOTFIX REQUIRED.** The fix introduced one live product regression (manual Run unusable on trial and Start plans), one latent correctness bug (budget refusal on a retry swallowed as a soft failure, delivery proceeds), and one latent liveness trap (library sections without a baseline can become permanently unreadable and unwritable).
**Deployment authority:** none. No deploy, approve, rerun, or external send was performed or is authorized by this document.

## How this was verified

- Deterministic gates on `f77acc4`: backend `tsc --noEmit` clean; backend suite **832/832**; frontend lint (0 warnings), build, and contract tests all pass; `git diff --check 83e7895..103efbf` clean.
- Fail-before/pass-after: HEAD's test files were copied into a detached worktree at pre-fix `83e7895` and run with `TS_NODE_TRANSPILE_ONLY=1`. All 15 regression files fail there and pass on HEAD. Spot-checked failure reasons are semantic, not missing exports: the ceiling test ran both model calls without pausing (`deliveryError` undefined, second attempt executed), and the manual route returned 200 where 409 is expected.
- Four independent production-path traces (not test reading) across accounting, evidence, truth-state, and API/deliverable surfaces, each instructed to refute the fix and hunt for new defects.
- Numbers below were measured by executing `buildAutomationExecutionPlan` and the credit projections against the three seeded missions, and by driving `POST /api/automations/:id/run` in the test harness.

## Finding-by-finding

| # | Finding | Verdict | Production evidence |
|---|---|---|---|
| F5-01 | Per-run ceiling fails open | **FIXED** | `assertRuntimeBudget` (`server.ts:5376-5402`) gates every call with the byte-safe maximum (`cost.ts:214-231`, 1 token/byte + full `maxOutputTokens`) both before the call (`:5536`) and inside `beforeAttempt` (`:5596`). Settlement is `min(actual, authorized)` (`:8250`). `extendCreditAuthorization` is only wired when `perRunBudget === null` (`:8213-8231`), so an operator-set budget cannot be raised silently. Non-generation charges are pre-committed per step (`:5734`, `projectedAuthorizedStepCredits` `:4414-4438`); worst-case post-gate overrun under normal provider semantics is 0. Boot recovery settles `min(authorized, recoverable)` (`:7045-7120`). |
| F5-02 | Preflight priced raw steps | **FIXED** | `buildAutomationExecutionPlan` (`:4585-4620`) builds the plan once and derives `generationProjections` from plan steps (`:4986-5172`) with the same branch conditions as the runtime. `countPlannedModelCalls` has zero production callers. Manual route, runtime preflight, and scheduler all consume the plan. |
| F5-03 | Usage dropped from accounting | **FIXED** | Single accounted wrapper `runGeneration` (`:5510-5696`); every run-path model call uses it, including baseline (`:5805-5817` injects it into `libraryBaseline.ts`), memo (`:6276`), fallback (`:5256`), extraction (`:6105`). Usage is stored in `onAttemptSuccess`/`onAttemptFailure` before any validator can throw; rejection only flips `status`. Settlement, overrun warning, metadata, recovery, and telemetry all read the same `generationCalls`. Unreported usage fails closed (`RuntimeGenerationAccountingError`). |
| F5-04 | Same-minute baseline collision | **FIXED** (single-instance) | Title is `HH.MM.SS.mmm <taskRunId>` (`libraryBaseline.ts:494-509`); merge folds all entries above the prior readable baseline (`:422-431`); per-(workspace, section) in-process lock (`:113-137`). Drive write is still check-then-create (`accountLibrary.ts:1327-1374`); safe only while `instances: 1` (`deploy/ecosystem.config.cjs:7`). |
| F5-05 | Unreadable baseline discards history | **FIXED** | Cut is content-validated, not filename-trusted (`accountLibrary.ts:1100-1193`); unreadable baseline disables the limit break and continues to the next readable one; `appEntryHistoryComplete=false` fails the read closed in `queryData.ts:352-362`. |
| F5-06 | Output budget absent from preflight | **PARTIAL** | Per-call input and output now enter the estimate (`cost.ts:189-206`). But preflight and the runtime gate use different rules (see NF-1). |
| F5-07 | Disconnected Drive reported as fresh | **PARTIAL** | `findLibraryRootFolderId` returns `ok:false` for every failed lookup; `folderId:null` only after a successful empty query (`accountLibrary.ts:503-512, 557-566`). Routes flatten every failure class, including "never connected", into HTTP 502 `folder_drop_lookup_failed` (`server.ts:10455-10522`) and the Settings page fires a global error toast on mount (`SettingsPage.tsx:494-504`). Latent until the reader key ships. |
| F5-08 | Drive 429/5xx blamed on sharing | **FIXED** | `laneStateForDriveReaderError` (`librarySweep.ts:278-295`): `needs_share` only for 404 and four file-permission 403 reasons; 429/5xx/timeout/transport/malformed → `unavailable` with a warning that says re-sharing will not help (`accountLibrary.ts:879-883`). |
| F5-09 | Retryable errors lose provider cause | **PARTIAL** | OpenAI-compatible path reads a bounded, redacted body and throws a route-aware `ModelRequestError` (`models.ts:178-247, 1095-1099`). The Anthropic/MiniMax SDK path still goes through `sanitizeModelAttemptError` with no route (`:150-176`), and the default profile's primary is `anthropic/claude-sonnet-5` (`:589-597`), so an exhausted 529 surfaces as `529 Overloaded` with no provider or model named. |
| F5-10 | Manual run 200 for a budget-blocked run | **FIXED** | `acquireManualRunCreditAuthorization` (`server.ts:7489-7572`) decides synchronously from the plan; route returns 409 `credit_budget_exceeded` and broadcasts nothing (`:11525-11529`). Slack `run` and rerun use the same helper. New regression in the unbudgeted branch, see NF-1. |
| F5-11 | Word limits prompt-only | **FIXED** | `requireCompleteAutomationSummary` / `...Memo` / `...MemoWithLink` enforce 650/343/350 after generation (`automationSummaryPolicy.ts:181-201`); over-limit is withheld (one accounted fallback generation for the summary, deterministic slice for the memo), never truncated to success. CJK bypass, see NF-7. |

Acceptance checklist from the original handoff: all 17 boxes hold on production paths, with the three PARTIALs noted above as residuals that cannot overspend, omit evidence, or mark a failure as success.

## New defects introduced by the repair (ranked)

### NF-1 — Manual Run reserves the hard envelope; trial and Start plans cannot run any seeded mission

**Severity:** High. **Live in production.**
**Evidence:** `server.ts:4645-4652` (`manualAuthorizationCredits` sums `maximumGenerationCallTokenCredits` over all projections, including the `includeInEstimate:false` fallback summary), `:7532-7545` (hold = `perRunBudget ?? max(authorizationCredits, manualAuthorizationCredits)`), `:7562` (affordability checked against that hold), `:431-432` + `:7555-7556` (manual runs get 1 attempt × 1 route). `betaTrialCredits.ts:4` (`BETA_TRIAL_CREDITS = 500`). Pricing ladder: Start 2,000, Pro 7,500.

Measured on the three seeded missions (local `automations.json` shapes):

| Mission | Estimate shown on the card | Manual hold | Ratio |
|---|---|---|---|
| Weekly founder update | 605 | 4,169 | 6.9x |
| Platform learning brief | 172 | 2,483 | 14.4x |
| Competitor monitor | 776 | 5,007 | 6.5x |

Largest single-call maxima: summary 996 (242 KB prompt ceiling + 6,000 out), library baseline 1,320, fallback summary 1,205 (reserved even though it only runs if the main summary fails).

**Failure sequence:**
1. A beta tester holds the 500-credit trial grant. A Start customer holds 2,000.
2. They press Run on Competitor monitor (card says ~776 credits), or type `run` in Slack.
3. Route answers 409 `insufficient_credits`: `"500 available, 5007 required — 4507 short. Add ... credits or upgrade the plan"` (`creditPreflight.ts:138-145`).
4. The scheduler fires the same mission, reserves the estimate, extends at call boundaries, and succeeds.
5. On Pro, one manual Competitor monitor holds 67% of a full month; any concurrent run is refused; mid-month the button stops working while the card still shows ~776.

The demo guidance in the vault ("press Run, gate parks in <1 min") is no longer true for any tester. `tests/serverMissionBudgetPreflight.test.ts:131-176` asserts this behaviour as intended; it tests the implementation's assumption, which is the pattern the original handoff criticized under F5-07.

Secondary effects on the same path: a single transient provider 5xx fails a manual run with no retry (1×1 vs 2×2 for scheduled), and a runtime block on an unbudgeted manual run prints "Raise the budget" (`:4473-4476`) to an operator who never set one.

**Required repair (choose one, recommendation first):**
- Reserve the estimate for unbudgeted manual runs and extend at call boundaries exactly like the scheduled path (`:8213-8231`), keeping 2×2 attempts. The runtime gate already guarantees no call outspends the hold; the manual path does not need a different envelope.
- Or keep the hard envelope but show it: return `manualAuthorizationCredits` in the plan payload, render "estimated ~776, reserves up to 5,007" on the card, and validate `credit_budget_per_run` against the hard envelope at save time so a budget set from the estimate cannot produce a run that always pauses.

**Acceptance test:** a 500-credit workspace POSTs a manual run of a search→analyze→summarize→deliver mission whose estimate is under 500. Assert 200, a run record, and settlement ≤ actual usage. Repeat via the Slack `run` intent. Rewrite `serverMissionBudgetPreflight.test.ts:131-176` to assert the new contract, not the hard-envelope refusal.

### NF-2 — A budget refusal raised inside `beforeAttempt` is swallowed as a soft generation failure

**Severity:** High, latent (needs a budgeted mission with retries, or an unbudgeted manual run whose authorization matched). **Correctness and contract.**
**Evidence:** `models.ts:378-388` (`runModelAttemptHook` wraps every hook throw in `ModelAttemptHookError`, `instanceof` lost, `.cause` preserved); `models.ts:444` (`beforeAttempt` runs through it); `server.ts:5594-5596` (`beforeAttempt` calls `assertRuntimeBudget`, which throws `RuntimeCreditBudgetError` and sets `creditBudgetBlock` as a side effect at `:5401`); `server.ts:4408-4412` (`isFatalAutomationGenerationError` checks `instanceof` only, never `.cause`); non-fatal catch sites `:5273` (fallback summary), `:6160` (intel extraction), `:6287` (memo).

**Failure sequence:**
1. Memo generation attempt 1 fails with 502 and no usage; its full authorization stays committed.
2. Attempt 2 `beforeAttempt` → `assertRuntimeBudget` refuses → arrives at `:6287` as `ModelAttemptHookError`.
3. Not fatal → "memo tier failed" warning → `buildDeterministicAutomationMemo` → delivery proceeds to the review gate or a live send (`:6305-6365`).
4. After the step, `creditBudgetBlock` breaks the loop; the run reports `deliveryError = creditBudgetBlock.summary` (`:8294`) although the delivery went out.

No billable call executes, so the ceiling holds, but a budget-blocked run can deliver and then misreport. Same shape produces a deterministic summary under a budget block at `:5273`.

**Required repair:** make `isFatalAutomationGenerationError` walk `error.cause` (or have `runGeneration` unwrap `ModelAttemptHookError` before rethrowing). Five lines.
**Acceptance test:** mock `generateTextDetailed` to fail attempt 1 with a 502, have attempt 2's `beforeAttempt` refuse on budget, and assert the memo step throws `RuntimeCreditBudgetError`, no delivery tool call runs, and the run ends `credit_budget_exceeded` with no `deliveryError` contradiction.

### NF-3 — Library sections with no baseline and >72 KB of memos become permanently unreadable and unwritable

**Severity:** Medium-High, latent. **Liveness, not evidence loss.**
**Evidence:** `accountLibrary.ts:164-165` (`MAX_RECOVERABLE_APP_HISTORY_BYTES` = 32,001×2 + 8,000 = 72,002), `:147` (100-file recovery cap), `:159` (32,001 per-entry cap); `queryData.ts:346-362` (every mission read fails closed on `appEntryHistoryComplete=false`); `libraryBaseline.ts:270-279, 414-420` (append and bootstrap refuse under the same condition). No code path creates a first baseline for such a section.

**Failure sequence:** a section that has never had a baseline written (any mission that has not recorded a run since the 2026-08-13 baseline deploy; the paused `auto_weekly_founder_update` is the known candidate) holds three or more full memos. On resume, the read hits the byte window, marks history incomplete, the run stops at the read step, the write lane refuses to append, and every later run repeats this. Evidence is preserved; the feature is dead for that section until someone edits Drive by hand.

**Required repair:** a one-time bootstrap path that baselines the bounded window with an explicit `history_truncated` warning when no baseline exists, or a larger recovery window for the no-baseline case only.
**Prod check before the next scheduled mission:** list each workspace section, count memos above the newest baseline, and sum their sizes. Any section with no baseline and >72 KB is blocked on its next run.

### NF-4 — `listingHasMore` falls open when Drive omits `nextPageToken`

**Severity:** Medium. **Evidence completeness.**
**Evidence:** `accountLibrary.ts:1061, 1079-1080`; the completeness proof rests on Composio `GOOGLEDRIVE_FIND_FILE` echoing `nextPageToken`, which the verified-actions note (`:76-77`) does not document, and the test fake always supplies (`tests/libraryBaseline.test.ts:84`).
**Failure sequence:** a section with more than `pageSize` files returns exactly one full page with no token. `appEntryHistoryComplete` = true, recovery never loads, and the next baseline merge silently omits every memo beyond page 1 while certifying the history complete. This is the F5-04(b) omission again, now with a completeness stamp.
**Required repair:** treat `files.length >= pageSize` as "may have more". One line each site.

### NF-5 — F5-09 residual: Anthropic/MiniMax SDK errors are route-blind, and that is the default primary route

**Severity:** Medium. `models.ts:150-176`. Pass the route into `sanitizeModelAttemptError` and wrap SDK errors in `ModelRequestError` the same way the HTTP path does.

### NF-6 — F5-07 residual: "never connected" answers 502 and an error toast

**Severity:** Low-Medium, latent until the reader key ships. `server.ts:10455-10522` discard the `LibraryFailure.code`/`nextAction` the lookup already returns ("Connect Google Drive", "Reauthorize", "Retry"). Map `integration_not_ready` to a 200 lane state `not_connected` with that CTA; keep 502 for transport and query failures.

### NF-7 — CJK and unspaced scripts bypass the word validator

**Severity:** Low. `automationSummaryPolicy.ts:141-146` counts `[\p{L}\p{N}]+` runs, so a 9,000-character Chinese brief counts as ~500 words and passes; only the byte caps bound it. Count CJK code points (e.g. `\p{Script=Han}` per character) or add a per-script character budget.

### NF-8 — Minor residuals (log, do not block)

- Permanent one-behind repair mode after any soft merge failure (`libraryBaseline.ts:333-335`): each later transaction repairs the previous memo and never returns to same-transaction merging. Cost only.
- A mid-life platform 401 or unknown 403 drops operator files silently as `not_configured` with no warning (`accountLibrary.ts:876-878`).
- A caller abort (cancel, step timeout) is classified `timeout` → `unavailable`, so a cancelled run carries a "Drive temporarily unavailable" warning (`nativeDriveReader.ts:216`).
- Unbudgeted runs that fail `extendCreditHold` surface a plain "Insufficient credits" step error rather than a budget block (`store.ts:590-594` → `server.ts:5388-5392`). Fail-closed; classification only.
- `runToolOperation` is ungated; correctness relies on every step kind issuing at most one tool call, which holds today and is unasserted.
- Not covered by tests: rerun route and Slack `run` under a budget block; the `stale_record` race; budget refusal raised inside `beforeAttempt`.

## Process notes

- The repair landed as one 4,674-line change to `server.ts` inside a single commit, and widened beyond the 11 findings (review-delivery reconciliation in `reviewActions.ts` +946, crash reconciliation, screenshot SSRF hardening, workspace model-override routing). The additions are real safety work and the SSRF change is a clear improvement (fails closed on unparseable IPv6, blocks 6to4/Teredo), but the size defeated review: NF-1 and NF-2 are both inside that commit and both have tests that encode the defect as intended behaviour.
- `composioBridge.ts` was touched only to thread an `AbortSignal`; no auth-surface change.
- Vault Update Contract was honoured for the repair (run note + dashboard).

## Recommended order

1. **Hotfix PR, three small commits, one per defect:** NF-1 (manual hold = estimate + call-boundary extension, 2×2 attempts, rewrite the enshrining test), NF-2 (`.cause` walk), NF-4 (`files.length >= pageSize`). Each with the acceptance test above. Typecheck + 832 + new tests green, then Max's separate deploy word.
2. **Read-only prod probe** for NF-3 before `auto_weekly_founder_update` or any dormant section is resumed. Then decide bootstrap vs larger window.
3. **Product decision for Max:** what `credit_budget_per_run` means to an operator. Recommendation: validate it at save time against the hard envelope and show both numbers in the editor when that UI ships.
4. NF-5, NF-6, NF-7 as a follow-up PR; NF-8 to the backlog.
5. The 83(b) deadline (~2026-08-26) still outranks all of the above.

# Fable 5 handoff — adversarial review of `25a780d..main`

**Repository:** `/Users/maximisto/Documents/New project`
**Branch reviewed:** `main`
**Reviewed HEAD:** `83e789558ce31af237527aa014d80c0e799e87a7`
**Review date:** 2026-08-16
**Verdict:** **DO NOT SHIP**
**Confidence:** All findings below are **CONFIRMED** by tracing the production code path.
**Deployment authority:** None. This handoff does not authorize a deploy, approval, rerun, or external send.

## Mission for Fable 5

Repair the confirmed defects in this handoff without broadening the change set. The stop condition is not “the existing tests pass”; it is:

1. Every failure sequence below has a regression test that fails on reviewed HEAD and passes after the repair.
2. Per-mission credit limits cannot spend beyond the operator-approved amount without a new explicit approval.
3. Every provider generation that returns usage is represented in actual-credit accounting, including auxiliary and rejected generations.
4. Library compaction cannot omit evidence because a baseline collided, was unreadable, or was never successfully persisted.
5. Integration and provider failures report the actual owner and cause instead of onboarding or sharing success states.
6. Manual run routes return the synchronous refusal that the asynchronous run will enforce.
7. Backend typecheck and the relevant full test suite pass, and the final diff contains no unrelated edits.

Do not change the verdict to `SHIP` merely because the nine commits’ current tests remain green. Those tests pass on the broken paths described below.

## Exact review scope

The review scope was exactly `25a780d..main`:

```text
83e7895 feat: per-mission credit budget pauses and asks, and estimates stop lying 3x low
caa505b feat: two-tier deliverable — 350-word memo delivers, full brief persists
183a545 feat: rolling current-state baseline compacts the library out of prompts
350ed3e feat: the summary output budget scales with evidence size
b4065ee fix: a provider dying mid-generation surfaces its real cause, retried
40a2679 fix: the orphan sweep records facts, not the stale restart diagnosis
720376c fix: a failed library-root lookup stops masquerading as a fresh workspace
ac929c2 fix: classifyFailure reads thrown Errors instead of stringifying them to '{}'
09cc8fd fix: the sweep's lane verdict outranks the stale pre-read probe
```

Range size:

```text
22 files changed, 1678 insertions(+), 92 deletions(-)
```

The five claims attacked were:

1. A later sweep verdict outranks a stale active pre-read probe.
2. Failed library-root lookup is distinct from a genuinely fresh workspace.
3. Provider death during generation surfaces its real cause.
4. Summary output budget scales with evidence size.
5. Per-mission credit budget pauses and asks, while estimates no longer run roughly 3x low.

## Executive risk

The highest-risk failure is not cosmetic. The code calls an operator-set value a “ceiling,” but it can spend and settle more than that value. At the same time, the estimator can omit synthesized model calls and the actual-credit path can omit successful auxiliary model calls, making both the preflight decision and post-run ledger understate reality.

The second cluster is evidence integrity. Rolling baselines can collide within the same minute, and the read path discards older evidence before proving the selected baseline is readable. Both paths can remove real findings from future prompts while the run still looks successful.

The remaining failures are truth-state defects: a disconnected Drive can be called a fresh workspace, a Drive platform outage can be called a sharing problem, a structured provider failure can become a generic retry error, and a manual budget refusal can return HTTP success.

---

## F5-01 — The per-run credit “ceiling” fails open after execution

**Severity:** High
**Status:** CONFIRMED
**Primary evidence:** `backend/src/server.ts:5560-5561`, `backend/src/server.ts:5790-5802`, `backend/src/server.ts:5920-5923`
**Contract evidence:** `backend/src/scheduler.ts:65-71`

### Defect

`credit_budget_per_run` blocks only when the estimate is already above the budget. If actual cost crosses the budget, the code adds a warning and then settles the full actual amount. That is an alert threshold, not the “operator-set ceiling” promised by the public type contract.

### Concrete failure sequence

1. Mission budget is `150` credits.
2. Preflight estimate is `149`, so `estimatedCredits > perRunBudget` is false.
3. The run executes model and tool work.
4. Accounted actual cost is `228` credits.
5. `buildCreditBudgetOverrunWarning` adds a review warning.
6. `settleCreditHoldWithOverrun` is called with `actualCredits: 228`.
7. The operator authorized 150 but the system spends and attempts to settle 228.

The review warning occurs after the provider spend. It is not a pause-and-ask gate.

### Why the current tests miss it

`backend/tests/creditPreflight.test.ts` tests the block builder and the overrun-warning text as separate helpers. It does not execute a run whose estimate is below budget and whose actual cost exceeds budget, then assert on settlement.

### Required repair

Choose and enforce one honest contract:

- Preferred: reserve the full approved budget and gate each billable operation against remaining authorized credits. Derive token ceilings from remaining credits before each generation. Pause before the next call would exceed the budget.
- If a strict ceiling is intentionally impossible, rename the field and UI to an estimate threshold and obtain explicit approval before settling an overrun.

Do not preserve the word “ceiling” while retaining warning-only behavior.

### Acceptance test

An integration test must configure `budget=150`, force `estimate=149`, force a first set of calls to consume near the limit, and prove that the next billable call does not execute without approval. The settled amount must never exceed 150 in the no-approval path.

---

## F5-02 — Preflight prices raw persisted steps instead of the executable plan

**Severity:** High
**Status:** CONFIRMED
**Primary evidence:** `backend/src/server.ts:4089-4094`, `backend/src/server.ts:5420`, `backend/src/server.ts:5527`
**Estimator evidence:** `backend/src/platform/cost.ts:137-151`

### Defect

Both manual and runtime affordability checks call:

```ts
countPlannedModelCalls(automation.steps)
```

The runtime executes `executionPlan.steps`, which can contain synthesized summary and delivery steps that do not exist in `automation.steps`.

### Concrete failure sequence

1. A legacy automation has non-empty `actions` and no `steps` array.
2. `buildAutomationExecutionPlan` converts actions into canonical steps.
3. `ensureAutomationSummaryStep` injects a model-backed summary step.
4. `countPlannedModelCalls(undefined)` returns `0`.
5. The plan executes the synthesized generation despite preflight pricing zero model calls for the token-volume term.
6. Workspace affordability and `credit_budget_per_run` can both pass on the understated estimate.

The same defect applies when persisted steps exist but plan normalization injects a missing summary.

### Why the current tests miss it

`backend/tests/costEstimate.test.ts` calls `countPlannedModelCalls` with a fully explicit synthetic step array. It never feeds a legacy/actions-only automation through `buildAutomationExecutionPlan` and then compares estimated calls with calls actually executed.

### Required repair

Build the plan once, then derive the model-call projection from `executionPlan.steps`. The counter must also include conditional model-producing branches that the plan can deterministically predict.

Avoid maintaining a raw-step estimator and a separate executable-plan model; they will drift again.

### Acceptance test

Add table-driven coverage for:

- actions-only automation with an injected summary;
- persisted evidence steps with an injected summary;
- explicit summary without duplication;
- library write plus delivery with baseline and memo calls;
- competitive analysis with its structured extraction call.

For every case, assert that the projected generation count matches the generation calls observed during execution.

---

## F5-03 — Actual-credit accounting silently drops provider generations

**Severity:** High
**Status:** CONFIRMED
**Primary evidence:** `backend/src/server.ts:3992-3994`, `backend/src/server.ts:4617-4626`, `backend/src/server.ts:4832-4843`, `backend/src/server.ts:4906-4916`
**Baseline evidence:** `backend/src/integrationGateway/libraryBaseline.ts:31`, `backend/src/integrationGateway/libraryBaseline.ts:117-124`

### Defect

`attachAutomationStepCharge` can charge only the single `step.tokenUsage` record. The new baseline refresh uses `generateText`, which discards usage, and the new memo tier receives `memoResult.usage` but never stores it. A summary rejected by `requireCompleteAutomationSummary` throws before `stepExecution.tokenUsage = summaryResult.usage` executes.

### Concrete failure sequences

**Successful auxiliary calls omitted:**

1. A newly created library entry triggers `updateLibraryBaseline`.
2. The ops model successfully generates the rolling baseline.
3. A persisted library link triggers the ops memo generation during delivery.
4. Both provider calls succeed and can incur real token spend.
5. Neither usage record reaches the step charge.
6. `actualCredits`, the budget-overrun warning, recent-usage margin telemetry, and settlement all omit those tokens.

**Rejected summary omitted:**

1. A summary generation returns text, `stopReason: "length"`, and usage.
2. `requireCompleteAutomationSummary` throws at line 4832.
3. The assignment at line 4843 never runs.
4. The failed step receives base/duration charges but no token charge for the provider work already performed.
5. The fallback summary generation is also not represented by a chargeable step usage record.

### Why the current tests miss it

The tests validate `calculateRuntimeCredits`, helper estimates, and policy rejection independently. They do not run the full automation core with instrumented model calls and reconcile provider-reported usage against the persisted `stepCharges` and credit settlement.

### Required repair

Represent model calls as first-class charge events or store an array of usage records per step. Record usage immediately after a provider result arrives, before any content validation can throw. Make `updateLibraryBaseline` return detailed generation usage, and add memo, extraction, fallback, retry, and rejected-generation usage to the owning run.

Do not solve this by assigning only the last call’s usage to the step; that still loses multiple generations.

### Acceptance test

Instrument every generation call in a library-write-and-deliver run. Sum the returned usage independently and assert exact equality with:

- persisted step charges;
- run `actualCredits` token component;
- budget-overrun calculation;
- settlement metadata;
- recent-usage provider-cost telemetry.

Repeat with a truncated main summary followed by a fallback.

---

## F5-04 — Same-minute rolling baselines collide and later erase findings

**Severity:** High
**Status:** CONFIRMED
**Primary evidence:** `backend/src/integrationGateway/libraryBaseline.ts:135-151`
**Idempotency evidence:** `backend/src/integrationGateway/accountLibrary.ts:1074-1101`

### Defect

The baseline title contains only UTC hour and minute. `appendLibraryEntry` treats an existing file with the same section, date, and title as successful idempotency and does not replace its content.

### Concrete failure sequence

1. Run A at `10:15` records findings A and writes baseline `Current-state baseline 10.15`.
2. Run B in the same section at `10:15` records findings B and generates a correct A+B merge.
3. Append finds A’s baseline filename and returns `{ ok: true, created: false }`; B’s merged baseline is discarded without a warning.
4. Run C at `10:16` reads A’s baseline plus newer entries but the merge code selects only the prior baseline and C’s `latestFindingsMarkdown`.
5. C writes a new baseline containing A+C, not B.
6. Future reads stop at C’s baseline and drop B’s now-older findings from prompt context.

Concurrent refreshes are worse: both calls can pass the check-before-create query and create same-named Drive files, leaving newest-baseline selection nondeterministic.

### Why the current tests miss it

`backend/tests/libraryBaseline.test.ts` covers one refresh at a fixed timestamp. It does not run sequential or concurrent refreshes within one minute, and it does not perform the third refresh needed to expose permanent omission.

### Required repair

Use a unique run identity in the baseline filename and protect baseline advancement with serialization, optimistic versioning, or an equivalent compare-and-append protocol. A new baseline must merge all entries newer than the prior baseline, not only the current caller’s findings.

### Acceptance test

Create A and B in the same minute, then C in the next minute. Read the section after C and assert that facts unique to A, B, and C are all present. Add a controlled concurrent variant with two refresh promises released from the same barrier.

---

## F5-05 — An unreadable baseline causes older evidence to be discarded before validation

**Severity:** High
**Status:** CONFIRMED
**Primary evidence:** `backend/src/integrationGateway/accountLibrary.ts:941-958`

### Defect

`compactFileListAroundBaseline` truncates the newest-first Drive listing at the newest baseline filename before the baseline body is downloaded. The code assumes the filename proves that all older evidence is safely represented.

### Concrete failure sequence

1. The section contains baseline B followed by several older full findings memos.
2. B still appears in the Drive listing but its export/download now fails or is unreadable.
3. The file list is compacted around B before any content fetch.
4. B is returned with `content: null` and a content error.
5. Every older memo has already been removed from the read and is never fetched.
6. The model sees neither the baseline knowledge nor the source memos it was supposed to replace.

The content error exposes that a gap exists, but it does not restore the omitted evidence. The read therefore cannot vouch for its completeness.

### Why the current tests miss it

The compaction tests use a readable baseline. Existing unreadable-entry coverage does not combine an unreadable newest baseline with older entries that would otherwise remain usable.

### Required repair

Do not cut the listing until the candidate baseline has been read and validated as non-empty. If it is unreadable, continue to the next valid baseline or return the older entries within the normal byte budget with an explicit warning.

### Acceptance test

Return a listing containing an unreadable newest baseline, a readable older baseline, and readable intervening memos. Assert that the read either falls back to the older valid baseline plus newer entries or fails closed; it must never return success after omitting all usable history.

---

## F5-06 — The evidence-scaled output budget is absent from credit estimation

**Severity:** Medium
**Status:** CONFIRMED
**Primary evidence:** `backend/src/platform/automationSummaryPolicy.ts:49-54`, `backend/src/platform/cost.ts:119-127`, `backend/src/platform/cost.ts:166-170`

### Defect

The summary call can receive up to 6,000 output tokens, but preflight still assumes exactly 4,000 total input-plus-output tokens for every model call.

### Concrete failure sequence

1. `summaryUserContent` contains at least 60,800 characters.
2. `automationSummaryTokenBudget` returns the 6,000-token ceiling.
3. The input prompt itself consumes tokens in addition to the output.
4. The model returns a valid 5,000-token completion with a non-truncation stop reason.
5. The run has moved substantially more than the 4,000 total tokens used by the preflight estimate.
6. A workspace or mission budget can pass only because the scaled call was priced using the obsolete fixed volume.

### Why the current tests miss it

The policy tests confirm that the budget scales, while the cost tests separately confirm the 4,000-token planning constant. No test requires those two pieces of math to agree for the same execution plan.

### Required repair

Estimate each generation from its actual prompt size and configured output allowance, with a documented utilization assumption or a conservative maximum appropriate to a hard operator budget. The execution plan should carry per-call token projections rather than a global constant.

### Acceptance test

Build the same evidence-rich summary input used at runtime, calculate its output allowance, and assert that preflight includes both projected input and output tokens. Include minimum, middle, and ceiling-sized evidence cases.

---

## F5-07 — A disconnected Drive is falsely reported as a fresh workspace

**Severity:** Medium
**Status:** CONFIRMED
**Primary evidence:** `backend/src/integrationGateway/accountLibrary.ts:496-510`
**Classifier evidence:** `backend/src/integrationGateway/adapters/partnerComposio.ts:350-360`
**API consequence:** `backend/src/server.ts:7716-7730`

### Defect

`findLibraryRootFolderId` converts `integration_not_ready` and `integration_not_connected` into `{ ok: true, folderId: null }`. The classifier assigns unauthorized, 401, missing connection, and disabled bridge errors to those codes.

### Concrete failure sequence

1. A workspace previously connected Drive and Violema created its library folder.
2. The OAuth grant is revoked, expires, or the Composio bridge is disabled.
3. The folder still exists in the customer’s Drive.
4. Root lookup cannot query Drive and returns `integration_not_ready`.
5. `findLibraryRootFolderId` turns the failed lookup into confirmed null.
6. `getFolderDropLaneState(null)` returns `no_library_yet`.
7. The API answers HTTP 200 with fresh-workspace onboarding state instead of connection or availability failure.

The comment that an unconnected lane “cannot have an app-created library” is false for any workspace that was connected previously.

### Why the current tests miss it

The added tests explicitly encode “no connection means confirmed absence.” They test the implementation’s assumption rather than the historical state sequence that disproves it.

### Required repair

Only a successful Drive query returning no matching folder may establish confirmed absence. Connection, authorization, bridge, and transport failures need distinct failure results and honest API status codes.

### Acceptance test

Model a previously connected workspace whose folder persists after revocation. Assert that the route returns a connection/lookup failure and never `no_library_yet`.

---

## F5-08 — Drive outages and rate limits are reported as operator sharing mistakes

**Severity:** Medium
**Status:** CONFIRMED
**Primary evidence:** `backend/src/integrationGateway/librarySweep.ts:271-275`, `backend/src/integrationGateway/librarySweep.ts:599-611`
**Reader evidence:** `backend/src/integrationGateway/adapters/nativeDriveReader.ts:298-300`

### Defect

Every `DriveReaderError` that is not auth, timeout, too-large, 401, or 403 falls through to `needs_share`. That includes Drive 429 and 5xx responses generated as `http_error`.

### Concrete failure sequence

1. The pre-read metadata probe succeeds and reports `active`.
2. The sweep’s later metadata probe receives Drive HTTP 429 or 500.
3. `timedFetch` throws `DriveReaderError('http_error', ..., status)`.
4. `laneStateForDriveReaderError` returns `needs_share`.
5. The later verdict correctly outranks the stale probe but carries the wrong cause.
6. The read returns zero operator files and tells the operator to re-share a correctly shared folder.

### Why the current tests miss it

The lane-authority tests inject a prebuilt `needs_share` or `not_configured` sweep result. They do not drive real `DriveReaderError` status codes through the classifier.

### Required repair

Reserve `needs_share` for verified access/not-found outcomes. Introduce an unavailable/error state or fail the read for 429, 5xx, malformed responses, and network failures so the operator is not blamed for a platform incident.

### Acceptance test

Cover at least 401, 403, 404, 429, 500, timeout, and network failure through both `getFolderDropLaneState` and `sweepOperatorFiles`. Assert the exact owner/action communicated for each class.

---

## F5-09 — Retryable HTTP errors discard the provider’s structured cause

**Severity:** Medium
**Status:** CONFIRMED
**Primary evidence:** `backend/src/models.ts:51-57`, `backend/src/models.ts:657-680`

### Defect

For HTTP 429 or 5xx, `generateWithOpenAI` throws `RetryableModelStatusError` before reading the response body. That error stores only status and status text and omits route identity.

### Concrete failure sequence

1. OpenRouter or another compatible route returns HTTP 502.
2. The JSON body contains `{"error":{"message":"upstream provider died during generation"}}`.
3. Line 663 throws before `response.json()`.
4. Retries and fallbacks exhaust.
5. The surfaced error is `Retryable model request failed with 502 ...`, not the provider, model, or supplied cause.

The new handling fixes HTTP 200 error envelopes and connection death while reading a body, but not ordinary retryable error responses with useful bodies.

### Why the current tests miss it

`backend/tests/modelProviderErrors.test.ts` covers a 200 error envelope, malformed/truncated body, and `finish_reason: error`. It does not cover a non-200 retryable response with a structured error payload.

### Required repair

Read and bound the error body inside the retry wrapper, then throw a route-aware retryable `ModelRequestError` that preserves the provider message without leaking sensitive payloads.

### Acceptance test

Mock repeated HTTP 502 responses with a JSON error message. Assert that retries occur and the final error names provider, model, status, and the bounded provider cause.

---

## F5-10 — Manual run returns success for a run the mission-budget gate rejects

**Severity:** Medium
**Status:** CONFIRMED
**Primary evidence:** `backend/src/server.ts:5407-5427`, `backend/src/server.ts:8683-8704`
**Asynchronous trigger evidence:** `backend/src/scheduler.ts:1044-1053`

### Defect

The manual request path synchronously checks workspace affordability but not `credit_budget_per_run`. It then launches the run fire-and-forget and immediately returns `{ ok: true, message: "Triggered ..." }`.

### Concrete failure sequence

1. Workspace balance can cover the estimate.
2. The mission’s per-run budget is below that estimate.
3. `checkManualRunAffordability` returns null because it checks only workspace credits.
4. `triggerAutomationNow` starts asynchronous execution.
5. The HTTP request returns 200 success and broadcasts `automation_triggered`.
6. `runAutomation` later creates a `credit_budget_exceeded` blocked run without executing work.

The request surface and authoritative run surface report opposite outcomes for the same preflight facts.

### Why the current tests miss it

There is no route-level integration test combining a sufficient workspace balance with an insufficient mission budget. The helper tests do not observe the HTTP response or emitted task-panel event.

### Required repair

Run both workspace affordability and mission-budget checks synchronously from the same normalized execution plan. Return the budget block as HTTP 409 and do not emit a triggered event.

### Acceptance test

POST a manual run with sufficient workspace credits and an estimate above the mission budget. Assert HTTP 409 `credit_budget_exceeded`, no trigger event, and no asynchronous execution invocation.

---

## F5-11 — Summary and memo word limits are not enforced

**Severity:** Medium
**Status:** CONFIRMED
**Primary evidence:** `backend/src/platform/automationSummaryPolicy.ts:7`, `backend/src/platform/automationSummaryPolicy.ts:24`, `backend/src/platform/automationSummaryPolicy.ts:63-73`
**Prompt-only evidence:** `backend/src/server.ts:4286`, `backend/src/server.ts:4297`

### Defect

The 650-word full-summary and 350-word delivery-memo limits exist only in prompts. `requireCompleteAutomationSummary` rejects recognized truncation stop reasons and empty text, but accepts any non-empty completion with a normal stop reason regardless of word count.

### Concrete failure sequence

1. The provider returns an 800-word summary with `finish_reason: "stop"`.
2. The completion is non-empty and has no recognized truncation reason.
3. The guard accepts and persists it as the full brief.
4. The memo model returns 500 words with `finish_reason: "stop"`.
5. The guard accepts and delivers it despite the advertised 350-word tier.

### Why the current tests miss it

The tests assert the constants and truncation behavior but never send an over-word, normally completed response through the guard.

### Required repair

Enforce the word limits deterministically after generation. Over-limit output should be retried with an explicit correction or withheld; it must not be marked successful.

### Acceptance test

Cover exact-limit, one-word-over, markdown-link, table, and Unicode whitespace cases for both summary and memo tiers.

---

## Required implementation order

The order matters because later tests should rely on one accounting model rather than patching symptoms:

1. **Define the budget contract.** Decide whether `credit_budget_per_run` is a real ceiling. The current product language says it is; implement that contract.
2. **Create one generation-call accounting primitive.** Every model call should produce a charge event with route, tier, usage, owning step, success/failure, and purpose.
3. **Derive preflight from the executable plan.** Include synthesized and conditional calls, evidence-sized prompt estimates, and output budgets.
4. **Make settlement reconcile against call events.** No silent auxiliary or rejected-generation omissions.
5. **Repair baseline advancement and read fallback.** Protect against collisions, concurrency, and unreadable baselines.
6. **Repair Drive state taxonomy.** Separate absent, disconnected, unauthorized, needs-share, and unavailable.
7. **Preserve provider error provenance across retries.** Keep bounded body detail and route identity.
8. **Align manual API preflight with runtime preflight.** One decision, one response.
9. **Enforce deliverable limits in code.** Prompts guide; validators guarantee.

## Minimum regression matrix

| Area | Required case | Expected result |
|---|---|---|
| Mission budget | Estimate below budget, next call would exceed it | Pause before call; no excess settlement |
| Plan estimate | Actions-only automation injects summary | Injected call appears in estimate |
| Plan estimate | Library write plus delivery | Baseline and memo calls appear in estimate |
| Actual credits | Successful baseline and memo | All usage included exactly once |
| Actual credits | Summary rejected for length | Returned usage still included |
| Summary scaling | Small/mid/ceiling evidence | Input and output projection match runtime policy |
| Baseline | Two refreshes in one minute, then third refresh | No findings omitted |
| Baseline | Concurrent refreshes | Deterministic complete successor baseline |
| Baseline read | Newest baseline unreadable | Fall back or fail closed; preserve usable history |
| Root lookup | Previously connected Drive becomes unauthorized | Connection/lookup failure, never fresh workspace |
| Sweep | Active probe followed by Drive 429/500 | Platform unavailable, never re-share warning |
| Provider | HTTP 502 with JSON error body | Retry plus route-aware real cause |
| Manual API | Balance sufficient, mission budget insufficient | HTTP 409; no triggered event |
| Deliverable | Normally stopped text exceeds word limit | Retry or withhold, never success |

## Existing validation performed during review

The reviewed range is mechanically clean, but that does not invalidate the findings.

```bash
git diff --check 25a780d..main
```

Result: pass.

```bash
cd backend
npm run typecheck
```

Result: pass.

Targeted changed tests:

```bash
cd backend
NODE_ENV=test VIOLEMA_DISABLE_AUTOMATION_SCHEDULER=1 \
  node --test -r ts-node/register \
  tests/automationSummaryPolicy.test.ts \
  tests/costEstimate.test.ts \
  tests/creditPreflight.test.ts \
  tests/modelProviderErrors.test.ts \
  tests/libraryBaseline.test.ts \
  tests/librarySweepRead.test.ts \
  tests/accountLibrary.test.ts
```

Result: **58 tests passed, 0 failed**.

Working tree after the review itself:

```text
## main...origin/main
```

The green tests establish that the committed helper behavior is internally consistent. They do not cover the cross-module failure sequences in this handoff.

## Re-review commands

Run the narrow checks first, then the backend suite:

```bash
git diff --check
cd backend
npm run typecheck
NODE_ENV=test VIOLEMA_DISABLE_AUTOMATION_SCHEDULER=1 node --test -r ts-node/register \
  tests/automationSummaryPolicy.test.ts \
  tests/costEstimate.test.ts \
  tests/creditPreflight.test.ts \
  tests/modelProviderErrors.test.ts \
  tests/libraryBaseline.test.ts \
  tests/librarySweepRead.test.ts \
  tests/accountLibrary.test.ts \
  tests/folderDropApi.test.ts
npm test
```

Before changing the verdict, inspect the final production paths again rather than accepting helper tests as proof:

- `backend/src/integrationGateway/librarySweep.ts`
- `backend/src/integrationGateway/accountLibrary.ts`
- `backend/src/integrationGateway/libraryBaseline.ts`
- `backend/src/models.ts`
- `backend/src/platform/automationSummaryPolicy.ts`
- `backend/src/platform/cost.ts`
- `backend/src/platform/creditPreflight.ts`
- `backend/src/scheduler.ts`
- `backend/src/server.ts`

## Final acceptance checklist

- [ ] `credit_budget_per_run` is a real enforced ceiling or is honestly renamed everywhere.
- [ ] No billable model call executes after the remaining authorized budget is insufficient.
- [ ] Estimation consumes the final executable plan, not raw persisted steps.
- [ ] Evidence-sized input and output projections feed preflight.
- [ ] Every returned usage record is charged exactly once, including auxiliary and rejected calls.
- [ ] Settlement, run metadata, budget warnings, and recent-usage telemetry reconcile.
- [ ] Same-minute and concurrent baseline refreshes preserve all findings.
- [ ] An unreadable baseline cannot suppress readable history.
- [ ] Root lookup never infers absence from inability to query.
- [ ] Drive 429/5xx states never blame folder sharing.
- [ ] Retryable provider errors preserve bounded route-aware causes.
- [ ] Manual HTTP responses match the runtime preflight decision.
- [ ] Summary and memo word limits are deterministic validators, not prompt wishes.
- [ ] New regression tests demonstrably fail on `83e7895` before the fixes.
- [ ] Typecheck and backend tests pass after the fixes.
- [ ] Final diff contains no unrelated cleanup.
- [ ] No deployment occurs without Max’s separate explicit deploy request.

## Verdict contract for the next review

Return `SHIP` only when every high-severity invariant and its regression test is satisfied. Use `SHIP-WITH-FIXES` only for residual issues that cannot overspend, omit evidence, or misreport a failure as success. Any remaining fail-open budget path, unaccounted provider call, or evidence-loss sequence keeps the verdict at `DO-NOT-SHIP`.

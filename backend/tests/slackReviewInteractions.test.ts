import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { signSlackRequest } from '../src/slack/signature';
import {
  SLACK_APPROVE_ACTION_ID,
  SLACK_REQUEST_CHANGES_ACTION_ID,
  buildReviewActionValue,
} from '../src/slack/reviewCard';
import type { TaskRecord, TaskRunRecord } from '../src/platform/types';

const SIGNING_SECRET = 'slack-test-signing-secret';
const OPERATOR_ID = 'U_OPERATOR';
const BYSTANDER_ID = 'U_BYSTANDER';
const REVIEW_CHANNEL = 'C0123456789';
const REVIEW_TS = '1712345678.000100';

interface SlackCall {
  method: string;
  body: Record<string, unknown>;
}

interface TestContext {
  baseUrl: string;
  sessionToken: string;
  workspaceId: string;
  automationId: string;
  taskId: string;
  runId: string;
  slackCalls: SlackCall[];
  /** Every outbound Slack HTTP post: brief deliveries AND control replies. */
  slackPosts: Array<Record<string, unknown>>;
  /** Only posts carrying the reviewed brief — the thing that must never double-send. */
  briefDeliveryCount: () => number;
}

/** The brief's distinctive sentence, used to tell a real delivery from a control reply. */
const BRIEF_MARKER = 'The weekly numbers are drafted';

function closeServer(server: http.Server | null) {
  if (!server) return Promise.resolve();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitFor<T>(read: () => T | undefined | null, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Boots the real server against a throwaway cwd with a review parked and
 * waiting. Slack HTTP is intercepted at two seams — the injected operator
 * transport (the review card) and a fetch stub (the approved delivery) — so
 * nothing leaves the process.
 */
async function withSlackReviewServer(
  run: (context: TestContext) => Promise<void>,
  options: { fabricatedEvidence?: boolean } = {},
) {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-slack-interactions-'));

  process.chdir(tempDir);
  process.env.VIOLEMA_APPROVED_EMAILS = 'qa@example.com';
  process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  process.env.SLACK_OPERATOR_USER_IDS = OPERATOR_ID;
  // Review cards require a dedicated channel: an unapproved draft must never be
  // posted to the channel the approved brief ships to.
  process.env.SLACK_REVIEW_CHANNEL = REVIEW_CHANNEL;
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

  const slackCalls: SlackCall[] = [];
  const slackPosts: Array<Record<string, unknown>> = [];
  const briefDeliveryCount = () =>
    slackPosts.filter((post) => JSON.stringify(post).includes(BRIEF_MARKER)).length;
  let server: http.Server | null = null;

  // The approved delivery runs through integrations.ts, which posts with fetch.
  // Slack is captured; the suite's own calls to the local server pass through;
  // anything else is a genuine escape and fails the test loudly.
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes('slack.com/api/')) {
      slackPosts.push(JSON.parse(init?.body || '{}') as Record<string, unknown>);
      return new Response(
        JSON.stringify({ ok: true, ts: REVIEW_TS, channel: REVIEW_CHANNEL }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith('http://127.0.0.1:')) {
      return originalFetch(input as string, init as RequestInit);
    }
    throw new Error(`Unexpected outbound call in test: ${url}`);
  }) as typeof globalThis.fetch;

  try {
    const { default: app } = await import('../src/server');
    const auth = await import('../src/auth');
    const consent = await import('../src/betaConsentStore');
    const betaProgram = await import('../src/betaProgram');
    const scheduler = await import('../src/scheduler');
    const store = await import('../src/platform/store');
    const transport = await import('../src/slack/transport');
    const pending = await import('../src/slack/pendingChangeRequests');

    pending.clearPendingChangeRequests();
    transport.setSlackOperatorTransport({
      postMessage: async (payload) => {
        slackCalls.push({ method: 'chat.postMessage', body: payload as unknown as Record<string, unknown> });
        return { ok: true, ts: REVIEW_TS, channel: payload.channel };
      },
      updateMessage: async (payload) => {
        slackCalls.push({ method: 'chat.update', body: payload as unknown as Record<string, unknown> });
        return { ok: true };
      },
    });

    const acceptedAt = '2026-07-11T12:01:00.000Z';
    consent.recordBetaConsent({
      email: 'qa@example.com',
      participantType: 'founder_operator',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
      acceptedAt,
      authMethod: 'email',
      acceptanceSource: 'signup',
    });

    const user = auth.upsertAuthUser({
      email: 'qa@example.com',
      name: 'QA Operator',
      role: 'admin',
      method: 'email',
      participantType: 'founder_operator',
      acceptedTerms: true,
      acceptedTermsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedTermsAt: acceptedAt,
      acceptedEducation: true,
    });
    const session = auth.createAuthSession(user.id);
    store.addLedgerEntry({
      workspaceId: user.defaultWorkspaceId,
      source: 'manual_adjustment',
      deltaCredits: 100,
      referenceType: 'manual',
      referenceId: 'slack_review_approval_test',
      note: 'Fund the real approval-delivery tool charge exercised by this fixture.',
    });

    const automation = scheduler.createAutomation({
      workspaceId: user.defaultWorkspaceId,
      owner_user_id: user.id,
      name: 'QA founder update',
      schedule: 'every monday at 9am',
      actions: ['Draft QA review'],
      notify: REVIEW_CHANNEL,
    }, async () => ({ ok: true }));

    const reviewArtifact = {
      kind: 'review_gate',
      title: 'Ready for review: QA founder update',
      payload: {
        markdown: '## QA founder update\nThe weekly numbers are drafted and ready.',
        deliveryTarget: REVIEW_CHANNEL,
        approvalRequired: true,
      },
    };
    // A payload that declares itself simulated is exactly what the provenance
    // re-scan must catch at the approval gate.
    const fabricatedArtifact = {
      kind: 'query_data',
      title: 'Stripe revenue snapshot',
      payload: { simulated: true, source: 'stripe', ok: true },
    };
    const artifacts = options.fabricatedEvidence
      ? [reviewArtifact, fabricatedArtifact]
      : [reviewArtifact];

    const task = store.createTask({
      workspaceId: user.defaultWorkspaceId,
      title: 'QA founder update',
      kind: 'automation',
      priority: 'medium',
      delegationState: 'review',
      metadata: {
        automationId: automation.id,
        latestArtifacts: artifacts,
        reviewRequired: true,
      },
    });
    const taskRun = store.createTaskRun({
      workspaceId: user.defaultWorkspaceId,
      taskId: task.id,
      agentRole: 'analyst',
      modelTier: 'default',
      estimatedCredits: 12,
      metadata: {
        automationId: automation.id,
        artifacts,
        reviewRequired: true,
        slackReviewMessage: { channel: REVIEW_CHANNEL, ts: REVIEW_TS },
      },
    });
    store.updateTask(task.id, { status: 'waiting_review', delegationState: 'review' });
    store.updateTaskRun(taskRun.id, { status: 'succeeded', actualCredits: 8 });

    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port.');

    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      sessionToken: session.token,
      workspaceId: user.defaultWorkspaceId,
      automationId: automation.id,
      taskId: task.id,
      runId: taskRun.id,
      slackCalls,
      slackPosts,
      briefDeliveryCount,
    });

    auth.clearAuthSession(session.token);
    transport.setSlackOperatorTransport(null);
    pending.clearPendingChangeRequests();
  } finally {
    globalThis.fetch = originalFetch;
    await closeServer(server);
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function postInteraction(context: TestContext, payload: Record<string, unknown>, overrides: {
  timestamp?: string;
  signature?: string;
} = {}) {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = overrides.timestamp || String(Math.floor(Date.now() / 1000));
  const signature = overrides.signature || signSlackRequest({
    rawBody: body,
    timestamp,
    signingSecret: SIGNING_SECRET,
  });

  return fetch(`${context.baseUrl}/api/slack/interactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
    },
    body,
  });
}

function blockActionsPayload(context: TestContext, actionId: string, userId: string) {
  return {
    type: 'block_actions',
    user: { id: userId },
    container: { channel_id: REVIEW_CHANNEL, message_ts: REVIEW_TS },
    actions: [{
      action_id: actionId,
      value: buildReviewActionValue({
        automationId: context.automationId,
        runId: context.runId,
        workspaceId: context.workspaceId,
      }),
    }],
  };
}

function authHeaders(sessionToken: string) {
  return { cookie: `violema_session=${sessionToken}`, 'Content-Type': 'application/json' };
}

async function readTask(context: TestContext) {
  const response = await fetch(`${context.baseUrl}/api/platform/tasks`, {
    headers: authHeaders(context.sessionToken),
  });
  const payload = await response.json() as { items: TaskRecord[] };
  return payload.items.find((item) => item.id === context.taskId);
}

async function readTaskRun(context: TestContext) {
  const response = await fetch(`${context.baseUrl}/api/platform/task-runs`, {
    headers: authHeaders(context.sessionToken),
  });
  const payload = await response.json() as { items: TaskRunRecord[] };
  return payload.items.find((item) => item.id === context.runId);
}

async function readLedger(context: TestContext) {
  const response = await fetch(`${context.baseUrl}/api/workflows/runs/${context.runId}/ledger`, {
    headers: authHeaders(context.sessionToken),
  });
  const payload = await response.json() as { items: Array<Record<string, unknown>> };
  return payload.items;
}

async function waitForTaskStatus(context: TestContext, status: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await readTask(context);
    if (current?.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task status "${status}"`);
}

test('slack interactions reject an invalid signature before doing anything', async () => withSlackReviewServer(async (context) => {
  const response = await postInteraction(
    context,
    blockActionsPayload(context, SLACK_APPROVE_ACTION_ID, OPERATOR_ID),
    { signature: 'v0=deadbeef' },
  );

  assert.equal(response.status, 401);
  const task = await readTask(context);
  assert.equal(task?.status, 'waiting_review', 'a forged request must not approve anything');
  assert.deepEqual(context.slackCalls, []);
  assert.deepEqual(await readLedger(context), []);
}));

test('slack interactions reject a stale timestamp even when correctly signed', async () => withSlackReviewServer(async (context) => {
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - (60 * 10));
  const response = await postInteraction(
    context,
    blockActionsPayload(context, SLACK_APPROVE_ACTION_ID, OPERATOR_ID),
    { timestamp: staleTimestamp },
  );

  assert.equal(response.status, 401);
  assert.match(await response.text(), /too old/);
  assert.equal((await readTask(context))?.status, 'waiting_review');
}));

test('a non-operator cannot approve from Slack', async () => withSlackReviewServer(async (context) => {
  const response = await postInteraction(
    context,
    blockActionsPayload(context, SLACK_APPROVE_ACTION_ID, BYSTANDER_ID),
  );
  assert.equal(response.status, 200);

  // Give the async path a moment; the state must remain untouched regardless.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await readTask(context))?.status, 'waiting_review', 'an unauthorized click must not approve');
  assert.equal(
    context.slackCalls.some((call) => call.method === 'chat.update'),
    false,
    'the card must not be resolved by an unauthorized click',
  );
  assert.deepEqual(await readLedger(context), []);
}));

test('an operator approval delivers, updates the card, and records the actor without bodies', async () => withSlackReviewServer(async (context) => {
  const response = await postInteraction(
    context,
    blockActionsPayload(context, SLACK_APPROVE_ACTION_ID, OPERATOR_ID),
  );
  assert.equal(response.status, 200);

  const task = await waitForTaskStatus(context, 'completed');
  assert.equal(task.delegationState, 'completed');

  const run = await readTaskRun(context);
  assert.equal((run?.metadata?.reviewReceipt as { status?: string })?.status, 'delivered');

  // The delivery actually went out through the normal send path.
  assert.equal(context.briefDeliveryCount(), 1, 'the approved brief must be sent exactly once');

  const update = context.slackCalls.find((call) => call.method === 'chat.update');
  assert.ok(update, 'the review card must be rewritten after approval');
  assert.equal(update.body.ts, REVIEW_TS, 'chat.update must target the stored message');
  assert.equal(update.body.channel, REVIEW_CHANNEL);

  const rendered = JSON.stringify(update.body.blocks);
  assert.match(rendered, /Approved and delivered/);
  assert.match(rendered, new RegExp(`<@${OPERATOR_ID}>`));
  assert.equal(
    rendered.includes('violema_review_approve'),
    false,
    'the resolved card must carry no buttons',
  );

  const ledger = await readLedger(context);
  assert.deepEqual(ledger.map((event) => event.type), ['approval_granted', 'external_action_executed']);
  for (const event of ledger) {
    const actor = (event.metadata as { actor?: Record<string, unknown> })?.actor;
    assert.equal(actor?.surface, 'slack');
    assert.equal(actor?.slackUserId, OPERATOR_ID);
    assert.equal(
      JSON.stringify(event).includes('The weekly numbers are drafted'),
      false,
      'ledger metadata must never carry the brief body',
    );
  }

  // The workflow ledger is the TENANT's record. The admin audit log is the
  // operator's, and a Slack approval used to leave nothing in it at all — so
  // the audit view could show every dashboard decision and none of the chat
  // ones, which is where most decisions are actually made.
  const access = await import('../src/adminAccessStore');
  const approvalAudit = await waitFor(
    () => access.listAdminAuditEvents(20).find((event) => event.action === 'review.approved'),
    'the admin audit event for a Slack approval',
  );
  assert.equal(approvalAudit.workspaceId, context.workspaceId);
  assert.equal(
    (approvalAudit.metadata as { slackUserId?: string })?.slackUserId,
    OPERATOR_ID,
    'the audit row names the Slack operator who clicked',
  );
  assert.equal((approvalAudit.metadata as { runId?: string })?.runId, context.runId);
  assert.equal((approvalAudit.metadata as { surface?: string })?.surface, 'slack');
  assert.ok(approvalAudit.actorEmail, 'an audit row is never anonymous');
  assert.equal(
    JSON.stringify(approvalAudit).includes(BRIEF_MARKER),
    false,
    'the admin audit row must never carry the brief body',
  );
}));

test('a second approval reports the review as already resolved and does not resend', async () => withSlackReviewServer(async (context) => {
  await postInteraction(context, blockActionsPayload(context, SLACK_APPROVE_ACTION_ID, OPERATOR_ID));
  await waitForTaskStatus(context, 'completed');

  assert.equal(context.briefDeliveryCount(), 1);
  context.slackCalls.length = 0;

  await postInteraction(context, blockActionsPayload(context, SLACK_APPROVE_ACTION_ID, OPERATOR_ID));
  const update = await waitFor(
    () => context.slackCalls.find((call) => call.method === 'chat.update'),
    'the already-resolved card update',
  );

  assert.match(JSON.stringify(update.body.blocks), /Already handled: QA founder update/);
  assert.match(JSON.stringify(update.body.blocks), /already approved by/i);
  assert.equal(context.briefDeliveryCount(), 1, 'a consumed review must never send twice');

  assert.deepEqual(
    (await readLedger(context)).map((event) => event.type),
    ['approval_granted', 'external_action_executed'],
    'the second click must add no ledger events',
  );
}));

test('fabricated evidence blocks a Slack approval with the same semantics as the HTTP 409', async () => withSlackReviewServer(async (context) => {
  // The dashboard route and the Slack card share one core, so the same stored
  // evidence must stop both.
  const httpResponse = await fetch(
    `${context.baseUrl}/api/automations/${context.automationId}/reviews/${context.runId}/approve`,
    { method: 'POST', headers: authHeaders(context.sessionToken), body: JSON.stringify({ reviewer: 'QA Operator' }) },
  );
  assert.equal(httpResponse.status, 409);
  assert.equal((await httpResponse.json() as Record<string, unknown>).code, 'fabricated_evidence');

  await postInteraction(context, blockActionsPayload(context, SLACK_APPROVE_ACTION_ID, OPERATOR_ID));
  const update = await waitFor(
    () => context.slackCalls.find((call) => call.method === 'chat.update'),
    'the blocked card update',
  );

  assert.match(JSON.stringify(update.body.blocks), /Not delivered: QA founder update/);
  assert.match(JSON.stringify(update.body.blocks), /simulated stripe data/);
  assert.equal(context.briefDeliveryCount(), 0, 'nothing may be sent when evidence is fabricated');
  assert.equal((await readTask(context))?.status, 'waiting_review', 'a blocked approval leaves the review open');
}, { fabricatedEvidence: true }));

test('request changes opens a thread prompt and captures the routing for the next reply', async () => withSlackReviewServer(async (context) => {
  const pending = await import('../src/slack/pendingChangeRequests');

  await postInteraction(context, blockActionsPayload(context, SLACK_REQUEST_CHANGES_ACTION_ID, OPERATOR_ID));
  await waitFor(
    () => pending.hasPendingChangeRequest({ channel: REVIEW_CHANNEL, threadTs: REVIEW_TS }) || undefined,
    'the pending change request',
  );

  // The click only opened the question — nothing is decided yet.
  assert.equal((await readTask(context))?.status, 'waiting_review');
  assert.equal(context.briefDeliveryCount(), 0, 'asking for a note must not deliver the brief');

  const captured = pending.consumePendingChangeRequest({ channel: REVIEW_CHANNEL, threadTs: REVIEW_TS });
  assert.equal(captured?.runId, context.runId);
  assert.equal(captured?.requestedBySlackUserId, OPERATOR_ID);
  assert.equal(captured?.workspaceId, context.workspaceId);
}));

test('an expired change-request prompt is dropped rather than applied late', async () => withSlackReviewServer(async (context) => {
  const pending = await import('../src/slack/pendingChangeRequests');

  await postInteraction(context, blockActionsPayload(context, SLACK_REQUEST_CHANGES_ACTION_ID, OPERATOR_ID));
  await waitFor(
    () => pending.hasPendingChangeRequest({ channel: REVIEW_CHANNEL, threadTs: REVIEW_TS }) || undefined,
    'the pending change request',
  );

  const wayLater = () => Date.now() + pending.SLACK_CHANGE_REQUEST_TTL_MS + 1000;
  assert.equal(
    pending.consumePendingChangeRequest({ channel: REVIEW_CHANNEL, threadTs: REVIEW_TS }, wayLater),
    null,
    'a note typed after the window must not silently request changes',
  );
  assert.equal((await readTask(context))?.status, 'waiting_review');
}));

test('two approvals racing inside the send window deliver exactly once', async () => withSlackReviewServer(async (context) => {
  // The regression this guards: the review was claimed only AFTER the delivery
  // await resolved, so a dashboard approval and a Slack button press landing in
  // the same second both passed the waiting_review check and each sent the
  // brief. Fire both without awaiting the first.
  const first = postInteraction(context, blockActionsPayload(context, SLACK_APPROVE_ACTION_ID, OPERATOR_ID));
  const second = postInteraction(context, blockActionsPayload(context, SLACK_APPROVE_ACTION_ID, OPERATOR_ID));
  await Promise.all([first, second]);
  await waitForTaskStatus(context, 'completed');

  assert.equal(context.briefDeliveryCount(), 1, 'concurrent approvals must deliver exactly once');

  const approvals = (await readLedger(context)).filter((event) => event.type === 'approval_granted');
  assert.equal(approvals.length, 1, 'only one approval may be recorded');
}));

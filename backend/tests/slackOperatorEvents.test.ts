import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { signSlackRequest } from '../src/slack/signature';
import type { TaskRecord } from '../src/platform/types';

const SIGNING_SECRET = 'slack-events-test-secret';
const OPERATOR_ID = 'U_OPERATOR';
const BYSTANDER_ID = 'U_BYSTANDER';
const TEAM_ID = 'T_INTERNAL';
const REVIEW_CHANNEL = 'C0123456789';
const REVIEW_TS = '1712345678.000100';

interface EventsTestContext {
  baseUrl: string;
  sessionToken: string;
  workspaceId: string;
  automationId: string;
  taskId: string;
  runId: string;
  /** Text of every message Violema posted back into Slack. */
  replies: () => string[];
}

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

async function waitForTaskStatus(context: EventsTestContext, status: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await readTask(context);
    if (current?.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task status "${status}"`);
}

async function withSlackEventsServer(run: (context: EventsTestContext) => Promise<void>) {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-slack-events-'));

  process.chdir(tempDir);
  process.env.VIOLEMA_APPROVED_EMAILS = 'qa@example.com';
  process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  process.env.SLACK_OPERATOR_USER_IDS = OPERATOR_ID;
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
  process.env.OPENROUTER_API_KEY = 'test-key-route-readiness';

  const posts: Array<Record<string, unknown>> = [];
  let server: http.Server | null = null;

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes('slack.com/api/')) {
      posts.push(JSON.parse(init?.body || '{}') as Record<string, unknown>);
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
    const pending = await import('../src/slack/pendingChangeRequests');

    pending.clearPendingChangeRequests();

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

    // The Slack team + channel mapping is what resolveSlackEventWorkspace uses;
    // the workspace is never taken from the message text.
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
      slackWorkspace: TEAM_ID,
      slackChannelId: REVIEW_CHANNEL,
      slackConnectedAt: acceptedAt,
    });
    const session = auth.createAuthSession(user.id);

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

    const task = store.createTask({
      workspaceId: user.defaultWorkspaceId,
      title: 'QA founder update',
      kind: 'automation',
      priority: 'medium',
      delegationState: 'review',
      metadata: { automationId: automation.id, latestArtifacts: [reviewArtifact], reviewRequired: true },
    });
    const taskRun = store.createTaskRun({
      workspaceId: user.defaultWorkspaceId,
      taskId: task.id,
      agentRole: 'analyst',
      modelTier: 'default',
      estimatedCredits: 12,
      metadata: {
        automationId: automation.id,
        artifacts: [reviewArtifact],
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
      replies: () => posts.map((post) => String(post.text ?? '')),
    });

    auth.clearAuthSession(session.token);
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

let eventCounter = 0;

function postEvent(context: EventsTestContext, event: Record<string, unknown>) {
  eventCounter += 1;
  const body = JSON.stringify({
    type: 'event_callback',
    event_id: `Ev_TEST_${eventCounter}_${Date.now()}`,
    team_id: TEAM_ID,
    event,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signSlackRequest({ rawBody: body, timestamp, signingSecret: SIGNING_SECRET });

  return fetch(`${context.baseUrl}/api/slack/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
    },
    body,
  });
}

function authHeaders(sessionToken: string) {
  return { cookie: `violema_session=${sessionToken}`, 'Content-Type': 'application/json' };
}

async function readTask(context: EventsTestContext) {
  const response = await fetch(`${context.baseUrl}/api/platform/tasks`, {
    headers: authHeaders(context.sessionToken),
  });
  const payload = await response.json() as { items: TaskRecord[] };
  return payload.items.find((item) => item.id === context.taskId);
}

test('a status mention is answered from real state without a model call', async () => withSlackEventsServer(async (context) => {
  const response = await postEvent(context, {
    type: 'app_mention',
    channel: REVIEW_CHANNEL,
    user: OPERATOR_ID,
    text: '<@U_BOT> status',
    ts: '1712345600.000100',
  });
  assert.equal(response.status, 200);

  const reply = await waitFor(
    () => context.replies().find((text) => text.includes('Violema status')),
    'the status reply',
  );
  assert.match(reply, /0 running · 1 waiting review · 0 blocked/);
  assert.match(reply, /QA founder update/);
}));

test('a non-operator asking to run a mission is refused and nothing starts', async () => withSlackEventsServer(async (context) => {
  await postEvent(context, {
    type: 'app_mention',
    channel: REVIEW_CHANNEL,
    user: BYSTANDER_ID,
    text: '<@U_BOT> run QA founder update',
    ts: '1712345601.000100',
  });

  const reply = await waitFor(
    () => context.replies().find((text) => text.includes('workspace operators')),
    'the read-only notice',
  );
  assert.match(reply, /Operating Violema from Slack/);
  assert.equal(
    context.replies().some((text) => text.includes('Started')),
    false,
    'a non-operator must not be able to start a mission',
  );
}));

// NF-1 (2026-08-23 re-review): the Slack `run` verb reserves the estimate
// like the dashboard's Run. It refuses synchronously when the workspace
// cannot afford the estimate, not when it merely cannot afford the hard
// single-attempt envelope.
test('Slack refuses before acknowledgement when the workspace cannot afford the estimate', async () => withSlackEventsServer(async (context) => {
  const store = await import('../src/platform/store');
  store.addLedgerEntry({
    workspaceId: context.workspaceId,
    source: 'manual_adjustment',
    deltaCredits: 1,
    referenceType: 'manual',
    referenceId: 'slack_unaffordable_estimate_test',
  });
  const runsBefore = store.listTaskRuns(context.workspaceId).length;

  await postEvent(context, {
    type: 'app_mention',
    channel: REVIEW_CHANNEL,
    user: OPERATOR_ID,
    text: '<@U_BOT> run QA founder update',
    ts: '1712345601.500100',
  });

  const reply = await waitFor(
    () => context.replies().find((text) => /credits/i.test(text) && /available|required/i.test(text)),
    'the credit refusal',
  );
  assert.match(reply, /does not have enough credits/i);
  assert.match(reply, /1 available, \d+ required/i);
  assert.equal(context.replies().some((text) => text.includes('Started')), false);
  assert.equal(
    store.listTaskRuns(context.workspaceId).length,
    runsBefore,
    'the Slack acknowledgement never outruns the authoritative credit gate',
  );
}));

test('an ambiguous run names the candidates and starts nothing', async () => withSlackEventsServer(async (context) => {
  const scheduler = await import('../src/scheduler');
  scheduler.createAutomation({
    workspaceId: context.workspaceId,
    name: 'QA founder update weekly',
    schedule: 'every friday at 9am',
    actions: ['Draft QA review'],
    notify: REVIEW_CHANNEL,
  }, async () => ({ ok: true }));

  // "QA founder" prefix-matches both missions and exactly matches neither, so
  // there is no defensible single answer. (A query of the full name would be an
  // exact match and must still win — that ordering is covered in the unit tests.)
  await postEvent(context, {
    type: 'app_mention',
    channel: REVIEW_CHANNEL,
    user: OPERATOR_ID,
    text: '<@U_BOT> run QA founder',
    ts: '1712345602.000100',
  });

  const reply = await waitFor(
    () => context.replies().find((text) => text.includes('matches 2 missions')),
    'the ambiguity reply',
  );
  assert.match(reply, /Nothing started/);
  assert.equal(
    context.replies().some((text) => text.includes('Started')),
    false,
    'an ambiguous name must start nothing',
  );
}));

test('an operator thread reply after Request changes applies the note and blocks the run', async () => withSlackEventsServer(async (context) => {
  const pending = await import('../src/slack/pendingChangeRequests');

  // Stand in for the button click: the card is posted and awaiting a note.
  pending.registerPendingChangeRequest({
    automationId: context.automationId,
    runId: context.runId,
    workspaceId: context.workspaceId,
    channel: REVIEW_CHANNEL,
    threadTs: REVIEW_TS,
    reviewMessageTs: REVIEW_TS,
    requestedBySlackUserId: OPERATOR_ID,
  });

  // An ordinary threaded message — no mention — is the note.
  await postEvent(context, {
    type: 'message',
    channel: REVIEW_CHANNEL,
    user: OPERATOR_ID,
    text: 'Tighten the revenue section and cite the source.',
    ts: '1712345679.000200',
    thread_ts: REVIEW_TS,
  });

  const blocked = await waitForTaskStatus(context, 'blocked');
  assert.equal(blocked.delegationState, 'review');
  assert.equal(
    (blocked.metadata?.reviewRequest as { note?: string })?.note,
    'Tighten the revenue section and cite the source.',
    'the operator note must become the change request',
  );
  assert.equal(
    pending.hasPendingChangeRequest({ channel: REVIEW_CHANNEL, threadTs: REVIEW_TS }),
    false,
    'the prompt is consumed exactly once',
  );

  // Requesting changes is a review decision taken outside the dashboard, so it
  // belongs in the operator's audit trail — with the note itself left out.
  const access = await import('../src/adminAccessStore');
  const changeAudit = access.listAdminAuditEvents(20)
    .find((event) => event.action === 'review.changes_requested');
  assert.ok(changeAudit, 'a Slack change request must leave an admin audit row');
  assert.equal(changeAudit.workspaceId, context.workspaceId);
  assert.equal((changeAudit.metadata as { slackUserId?: string })?.slackUserId, OPERATOR_ID);
  assert.equal((changeAudit.metadata as { runId?: string })?.runId, context.runId);
  assert.equal(
    JSON.stringify(changeAudit).includes('Tighten the revenue section'),
    false,
    'the reviewer note is content and must not reach the admin audit log',
  );
}));

test('a bystander thread reply is ignored and leaves the review open', async () => withSlackEventsServer(async (context) => {
  const pending = await import('../src/slack/pendingChangeRequests');

  pending.registerPendingChangeRequest({
    automationId: context.automationId,
    runId: context.runId,
    workspaceId: context.workspaceId,
    channel: REVIEW_CHANNEL,
    threadTs: REVIEW_TS,
    reviewMessageTs: REVIEW_TS,
    requestedBySlackUserId: OPERATOR_ID,
  });

  await postEvent(context, {
    type: 'message',
    channel: REVIEW_CHANNEL,
    user: BYSTANDER_ID,
    text: 'looks good to me',
    ts: '1712345680.000200',
    thread_ts: REVIEW_TS,
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await readTask(context))?.status, 'waiting_review');
  assert.equal(
    pending.hasPendingChangeRequest({ channel: REVIEW_CHANNEL, threadTs: REVIEW_TS }),
    true,
    'an unauthorized reply must not consume the operator prompt',
  );
}));

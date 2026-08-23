import assert from 'node:assert/strict';
import test from 'node:test';
import {
  queryPartnerComposio,
  type PartnerComposioExecutor,
} from '../src/integrationGateway/adapters/partnerComposio';

interface RecordedCall {
  actionName: string;
  input: Record<string, unknown>;
  entityId: string;
}

function createExecutor(
  handler: (call: RecordedCall) => unknown | Promise<unknown>,
): { calls: RecordedCall[]; execute: PartnerComposioExecutor } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    execute: async (actionName, input, ctx) => {
      const call = { actionName, input, entityId: ctx.entityId };
      calls.push(call);
      return await handler(call);
    },
  };
}

test('Gmail commitment reads are bounded and remove message bodies', async () => {
  const executor = createExecutor(() => ({
    successful: true,
    data: {
      messages: [
        {
          id: 'msg_1',
          threadId: 'thread_1',
          subject: 'Partner follow-up',
          sender: 'partner@example.com',
          to: ['max@example.com'],
          date: '2026-07-18T12:00:00.000Z',
          labelIds: ['IMPORTANT'],
          body: 'private message body',
          snippet: 'private body preview',
        },
      ],
    },
  }));

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'email',
    queryType: 'commitments',
    limit: 100,
    now: new Date('2026-07-19T12:00:00.000Z'),
    execute: executor.execute,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected Gmail success');
  assert.equal(result.live, true);
  assert.deepEqual(executor.calls, [
    {
      actionName: 'GMAIL_FETCH_EMAILS',
      entityId: 'purpleorangehq',
      input: {
        query: 'newer_than:7d (is:unread OR is:starred OR label:important)',
        user_id: 'me',
        verbose: false,
        ids_only: false,
        max_results: 10,
        include_payload: false,
        include_spam_trash: false,
      },
    },
  ]);
  assert.deepEqual(result.data, {
    messages: [
      {
        id: 'msg_1',
        threadId: 'thread_1',
        subject: 'Partner follow-up',
        from: 'partner@example.com',
        to: ['max@example.com'],
        date: '2026-07-18T12:00:00.000Z',
        labels: ['IMPORTANT'],
      },
    ],
    count: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /private message body|private body preview/);
});

test('Calendar commitment reads use a seven-day bounded window', async () => {
  const executor = createExecutor(() => ({
    successful: true,
    data: {
      events: [
        {
          id: 'event_1',
          summary: 'TechChicago demo',
          start: { dateTime: '2026-07-20T14:00:00.000Z' },
          end: { dateTime: '2026-07-20T15:00:00.000Z' },
          status: 'confirmed',
          htmlLink: 'https://calendar.google.com/event?eid=event_1',
          description: 'private meeting notes',
        },
      ],
    },
  }));

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'calendar',
    queryType: 'weekly_commitments',
    limit: 20,
    now: new Date('2026-07-19T12:00:00.000Z'),
    execute: executor.execute,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected Calendar success');
  assert.deepEqual(executor.calls[0], {
    actionName: 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS',
    entityId: 'purpleorangehq',
    input: {
      time_min: '2026-07-19T12:00:00.000Z',
      time_max: '2026-07-26T12:00:00.000Z',
      show_deleted: false,
      single_events: true,
      response_detail: 'minimal',
      max_results_per_calendar: 10,
    },
  });
  assert.deepEqual(result.data, {
    events: [
      {
        id: 'event_1',
        title: 'TechChicago demo',
        start: '2026-07-20T14:00:00.000Z',
        end: '2026-07-20T15:00:00.000Z',
        status: 'confirmed',
        link: 'https://calendar.google.com/event?eid=event_1',
      },
    ],
    count: 1,
    window: {
      start: '2026-07-19T12:00:00.000Z',
      end: '2026-07-26T12:00:00.000Z',
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /private meeting notes/);
});

test('Drive reads request and retain metadata only', async () => {
  const executor = createExecutor(() => ({
    successful: true,
    data: {
      files: [
        {
          id: 'file_1',
          name: 'Weekly operating plan',
          mimeType: 'application/vnd.google-apps.document',
          modifiedTime: '2026-07-18T16:00:00.000Z',
          parents: ['folder_1'],
          webViewLink: 'https://drive.google.com/file/file_1',
          body: 'private document body',
          permissions: [{ emailAddress: 'private@example.com' }],
        },
      ],
    },
  }));

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'google_drive',
    queryType: 'recent_files',
    limit: 25,
    now: new Date('2026-07-19T12:00:00.000Z'),
    execute: executor.execute,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected Drive success');
  assert.deepEqual(executor.calls[0], {
    actionName: 'GOOGLEDRIVE_FIND_FILE',
    entityId: 'purpleorangehq',
    input: {
      q: 'trashed = false',
      fields: 'files(id,name,mimeType,modifiedTime,parents,webViewLink),nextPageToken',
      orderBy: 'modifiedTime desc',
      pageSize: 10,
      spaces: 'drive',
    },
  });
  assert.deepEqual(result.data, {
    files: [
      {
        id: 'file_1',
        name: 'Weekly operating plan',
        mimeType: 'application/vnd.google-apps.document',
        modifiedTime: '2026-07-18T16:00:00.000Z',
        parents: ['folder_1'],
        webViewLink: 'https://drive.google.com/file/file_1',
      },
    ],
    count: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /private document body|private@example.com/);
});

test('Linear delivery reads are bounded and normalized', async () => {
  const executor = createExecutor(() => ({
    successful: true,
    data: {
      issues: [
        {
          id: 'linear_1',
          identifier: 'VIO-42',
          title: 'Prepare TechChicago demo',
          state: { name: 'In Progress' },
          priority: 1,
          updatedAt: '2026-07-19T10:00:00.000Z',
          url: 'https://linear.app/purpleorange/issue/VIO-42',
          description: 'private implementation notes',
        },
      ],
    },
  }));

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'linear',
    queryType: 'delivery_status',
    limit: 30,
    now: new Date('2026-07-19T12:00:00.000Z'),
    execute: executor.execute,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected Linear success');
  assert.deepEqual(executor.calls[0], {
    actionName: 'LINEAR_SEARCH_ISSUES',
    entityId: 'purpleorangehq',
    input: {
      query: 'updated in the last 7 days',
      first: 10,
      include_archived: false,
    },
  });
  assert.deepEqual(result.data, {
    issues: [
      {
        id: 'linear_1',
        identifier: 'VIO-42',
        title: 'Prepare TechChicago demo',
        state: 'In Progress',
        priority: 1,
        updatedAt: '2026-07-19T10:00:00.000Z',
        url: 'https://linear.app/purpleorange/issue/VIO-42',
      },
    ],
    count: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /private implementation notes/);
});

test('GitHub delivery reads use only the four curated read actions', async () => {
  const executor = createExecutor(({ actionName }) => {
    if (actionName === 'GITHUB_GET_A_REPOSITORY') {
      return {
        successful: true,
        data: {
          id: 100,
          full_name: 'maximisto/violema',
          html_url: 'https://github.com/maximisto/violema',
          default_branch: 'main',
          private: true,
        },
      };
    }
    if (actionName === 'GITHUB_LIST_PULL_REQUESTS') {
      return {
        successful: true,
        data: [{ number: 12, title: 'Live integrations', state: 'open', draft: false, html_url: 'https://github.com/maximisto/violema/pull/12', updated_at: '2026-07-19T10:00:00.000Z' }],
      };
    }
    if (actionName === 'GITHUB_LIST_REPOSITORY_ISSUES') {
      return {
        successful: true,
        data: [{ number: 33, title: 'Repair Drive scope', state: 'open', html_url: 'https://github.com/maximisto/violema/issues/33', updated_at: '2026-07-19T09:00:00.000Z', body: 'private issue body' }],
      };
    }
    return {
      successful: true,
      data: [{ sha: 'abcdef123456', html_url: 'https://github.com/maximisto/violema/commit/abcdef', commit: { message: 'Ship live adapter', author: { date: '2026-07-19T08:00:00.000Z', email: 'private@example.com' } } }],
    };
  });

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'github',
    queryType: 'delivery_risk',
    filters: { owner: 'maximisto', repo: 'violema' },
    limit: 50,
    now: new Date('2026-07-19T12:00:00.000Z'),
    execute: executor.execute,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected GitHub success');
  assert.deepEqual(
    executor.calls.map((call) => call.actionName),
    [
      'GITHUB_GET_A_REPOSITORY',
      'GITHUB_LIST_PULL_REQUESTS',
      'GITHUB_LIST_REPOSITORY_ISSUES',
      'GITHUB_LIST_COMMITS',
    ],
  );
  assert.deepEqual(executor.calls.map((call) => call.input), [
    { owner: 'maximisto', repo: 'violema' },
    { owner: 'maximisto', repo: 'violema', state: 'open', sort: 'updated', direction: 'desc', page: 1, per_page: 10 },
    { owner: 'maximisto', repo: 'violema', state: 'open', sort: 'updated', direction: 'desc', page: 1, per_page: 10 },
    { owner: 'maximisto', repo: 'violema', page: 1, per_page: 10, since: '2026-07-12T12:00:00.000Z' },
  ]);
  assert.deepEqual(result.data, {
    repository: {
      id: 100,
      fullName: 'maximisto/violema',
      url: 'https://github.com/maximisto/violema',
      defaultBranch: 'main',
      private: true,
    },
    pullRequests: [
      {
        number: 12,
        title: 'Live integrations',
        state: 'open',
        draft: false,
        url: 'https://github.com/maximisto/violema/pull/12',
        updatedAt: '2026-07-19T10:00:00.000Z',
      },
    ],
    issues: [
      {
        number: 33,
        title: 'Repair Drive scope',
        state: 'open',
        url: 'https://github.com/maximisto/violema/issues/33',
        updatedAt: '2026-07-19T09:00:00.000Z',
      },
    ],
    commits: [
      {
        sha: 'abcdef123456',
        message: 'Ship live adapter',
        date: '2026-07-19T08:00:00.000Z',
        url: 'https://github.com/maximisto/violema/commit/abcdef',
      },
    ],
    counts: {
      openPullRequests: 1,
      openIssues: 1,
      recentCommits: 1,
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /private issue body|private@example.com/);
});

test('missing connection errors become integration_not_ready', async () => {
  const executor = createExecutor(() => ({
    successful: false,
    error: 'No connected account found for toolkit github and user purpleorangehq',
    data: { access_token: 'must-not-leak' },
  }));

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'github',
    queryType: 'delivery_risk',
    filters: { owner: 'maximisto', repo: 'violema' },
    execute: executor.execute,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected connection failure');
  assert.equal(result.code, 'integration_not_ready');
  assert.equal(result.can_continue, false);
  assert.deepEqual(result.nextAction, {
    label: 'Connect GitHub',
    route: '/integrations?provider=github',
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|access_token/);
});

test('scope errors become integration_scope_insufficient and Drive may continue degraded', async () => {
  const executor = createExecutor(() => ({
    successful: false,
    error: {
      status: 403,
      code: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
      message: 'Request had insufficient authentication scopes.',
      authorization: 'must-not-leak',
    },
  }));

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'google_drive',
    queryType: 'recent_files',
    execute: executor.execute,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected scope failure');
  assert.equal(result.code, 'integration_scope_insufficient');
  assert.equal(result.can_continue, true);
  assert.deepEqual(result.nextAction, {
    label: 'Reauthorize Google Drive',
    route: '/integrations?provider=google_drive',
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|authorization/);
});

test('Drive 403 rate limits remain transient query failures instead of reauthorization prompts', async () => {
  const executor = createExecutor(() => ({
    successful: false,
    error: {
      status: 403,
      error: { errors: [{ reason: 'userRateLimitExceeded' }] },
      message: 'User rate limit exceeded.',
    },
  }));

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'google_drive',
    queryType: 'recent_files',
    execute: executor.execute,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected rate-limit failure');
  assert.equal(result.code, 'integration_query_failed');
  assert.equal(result.nextAction.label, 'Retry Google Drive');
});

test('provider exceptions become safe integration_query_failed errors', async () => {
  const executor = createExecutor(() => {
    throw new Error('upstream timeout bearer ghp_must_not_leak');
  });

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'linear',
    queryType: 'delivery_status',
    execute: executor.execute,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected provider failure');
  assert.equal(result.code, 'integration_query_failed');
  assert.equal(result.can_continue, false);
  assert.match(result.message, /could not read Linear/i);
  assert.doesNotMatch(JSON.stringify(result), /ghp_must_not_leak|bearer|upstream timeout/i);
});

test('unsupported query types fail without executing a partner action', async () => {
  const executor = createExecutor(() => ({ successful: true, data: {} }));

  const result = await queryPartnerComposio({
    workspaceId: 'purpleorangehq',
    source: 'email',
    queryType: 'send_message',
    execute: executor.execute,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected unsupported query');
  assert.equal(result.code, 'unsupported_query');
  assert.equal(result.can_continue, false);
  assert.equal(executor.calls.length, 0);
});

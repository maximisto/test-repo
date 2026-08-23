import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetryableModelError, withModelRetry } from '../src/models';

test('withModelRetry retries transient model failures and returns the eventual result', async () => {
  const originalDelays = process.env.MODEL_RETRY_DELAYS_MS;
  const originalWarn = console.warn;
  process.env.MODEL_RETRY_DELAYS_MS = '0,0,0';
  let attempts = 0;

  try {
    console.warn = () => {};
    const result = await withModelRetry('test model call', async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('rate limited') as Error & { status?: number };
        error.status = 429;
        throw error;
      }
      return 'ok';
    });

    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
  } finally {
    console.warn = originalWarn;
    process.env.MODEL_RETRY_DELAYS_MS = originalDelays;
  }
});

test('withModelRetry retries premature response closes from Anthropic fetch', async () => {
  const originalDelays = process.env.MODEL_RETRY_DELAYS_MS;
  const originalWarn = console.warn;
  process.env.MODEL_RETRY_DELAYS_MS = '0,0,0';
  let attempts = 0;

  try {
    console.warn = () => {};
    const result = await withModelRetry('test Anthropic model call', async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new TypeError('Invalid response body while trying to fetch https://api.anthropic.com/v1/messages: Premature close');
      }
      return 'ok';
    });

    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
    assert.equal(isRetryableModelError(new TypeError('Invalid response body while trying to fetch https://api.anthropic.com/v1/messages: Premature close')), true);
  } finally {
    console.warn = originalWarn;
    process.env.MODEL_RETRY_DELAYS_MS = originalDelays;
  }
});

test('withModelRetry does not retry non-transient model failures', async () => {
  const originalDelays = process.env.MODEL_RETRY_DELAYS_MS;
  process.env.MODEL_RETRY_DELAYS_MS = '0,0,0';
  let attempts = 0;

  try {
    await assert.rejects(
      () => withModelRetry('test model call', async () => {
        attempts += 1;
        const error = new Error('bad request') as Error & { status?: number };
        error.status = 400;
        throw error;
      }),
      /bad request/,
    );

    assert.equal(attempts, 1);
    assert.equal(isRetryableModelError({ status: 500 }), true);
    assert.equal(isRetryableModelError({ status: 400 }), false);
  } finally {
    process.env.MODEL_RETRY_DELAYS_MS = originalDelays;
  }
});

test('withModelRetry stops retrying as soon as its signal is aborted', async () => {
  const originalDelays = process.env.MODEL_RETRY_DELAYS_MS;
  const originalWarn = console.warn;
  process.env.MODEL_RETRY_DELAYS_MS = '1000,1000,1000';
  const controller = new AbortController();
  let attempts = 0;

  try {
    console.warn = () => {};
    const result = withModelRetry(
      'abortable model call',
      async () => {
        attempts += 1;
        const error = new Error('transient provider failure') as Error & { status?: number };
        error.status = 503;
        throw error;
      },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('automation step timed out'));

    await assert.rejects(result, /automation step timed out/);
    assert.equal(attempts, 1, 'an aborted backoff must not start another provider request');
  } finally {
    console.warn = originalWarn;
    if (typeof originalDelays === 'string') process.env.MODEL_RETRY_DELAYS_MS = originalDelays;
    else delete process.env.MODEL_RETRY_DELAYS_MS;
  }
});

test('withModelRetry separates durable authorization from the physical request boundary', async () => {
  const events: string[] = [];
  const result = await withModelRetry(
    'request boundary',
    async (onAttemptStart) => {
      events.push('operation_entered');
      await onAttemptStart();
      events.push('provider_request');
      return 'ok';
    },
    {
      beforeAttempt: () => { events.push('prepared'); },
      onAttemptStart: () => { events.push('request_started'); },
      onAttemptSuccess: () => { events.push('succeeded'); },
    },
  );

  assert.equal(result, 'ok');
  assert.deepEqual(events, [
    'prepared',
    'operation_entered',
    'request_started',
    'provider_request',
    'succeeded',
  ]);
});

test('withModelRetry reports a local pre-boundary rejection without a provider failure hook', async () => {
  const events: string[] = [];
  await assert.rejects(
    () => withModelRetry(
      'local refusal',
      async () => {
        events.push('local_validation');
        throw new Error('request could not be shaped');
      },
      {
        beforeAttempt: () => { events.push('prepared'); },
        onAttemptStart: () => { events.push('request_started'); },
        onAttemptNotStarted: () => { events.push('not_started'); },
        onAttemptFailure: () => { events.push('provider_failed'); },
      },
    ),
    /request could not be shaped/,
  );
  assert.deepEqual(events, ['prepared', 'local_validation', 'not_started']);
});

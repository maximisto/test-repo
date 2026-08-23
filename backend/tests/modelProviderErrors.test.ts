import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The 8:51 AM killer (talk morning, 2026-08-11): the summary step's provider
 * died mid-generation and the run surfaced a message about output limits —
 * the real cause was never captured anywhere. These tests pin the three ways
 * an OpenAI-compatible provider (OpenRouter especially) actually dies, and
 * require each to produce an error naming the provider, the model, and the
 * real failure:
 *
 *  1. HTTP 200 with an `error` body — OpenRouter wraps upstream provider
 *     failures this way; the old code fell through to `text: ''`.
 *  2. The connection dying while the body streams — `response.json()` threw
 *     a bare SyntaxError outside the retry wrapper.
 *  3. `finish_reason: 'error'` with no content — an upstream generation
 *     failure the old code returned as an empty string.
 */

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'MODEL_FALLBACK_API_KEY_ENV',
  'MODEL_FALLBACK_BASE_URL',
  'MODEL_DEFAULT_FALLBACK_MODEL',
  'MODEL_FALLBACK_OPENROUTER_MODEL',
  'MODEL_DEFAULT_FALLBACK_PROVIDER',
  'MODEL_FALLBACK_MODEL',
  'MODEL_FALLBACK_PROVIDER',
  'MODEL_RETRY_DELAYS_MS',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/**
 * The `micro` profile's PRIMARY route is openai/gpt-4.1-mini, and with only
 * OPENAI_API_KEY configured the fallback list dedupes to nothing — so the
 * route chain is exactly one OpenAI-compatible route whose fetch we control,
 * and its failure is the one the caller sees. No SDK mocking needed.
 */
async function withOpenAIRouteReturning(
  makeResponse: () => Response,
  run: (context: {
    generate: (options?: import('../src/models').TextGenerationOptions) => Promise<unknown>;
    fetchCalls: () => number;
  }) => Promise<void>,
) {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));
  let fetchCalls = 0;

  try {
    console.warn = () => {};
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.MODEL_RETRY_DELAYS_MS = '0';

    global.fetch = async () => {
      fetchCalls += 1;
      return makeResponse();
    };

    delete require.cache[require.resolve('../src/models')];
    const { generateTextDetailed } = require('../src/models') as typeof import('../src/models');

    await run({
      generate: (options) =>
        generateTextDetailed(
          'micro',
          'Write a concise founder brief.',
          [{ role: 'user', content: 'Summarize the run.' }],
          300,
          'test-workspace',
          options,
        ),
      fetchCalls: () => fetchCalls,
    });
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (typeof original === 'string') process.env[key] = original;
      else delete process.env[key];
    }
    delete require.cache[require.resolve('../src/models')];
  }
}

test('an HTTP 200 body carrying a provider error surfaces the real cause, not empty text', async () => {
  await withOpenAIRouteReturning(
    () =>
      new Response(
        JSON.stringify({ error: { message: 'Upstream provider exploded mid-generation', code: 502 }, choices: [] }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    async ({ generate, fetchCalls }) => {
      await assert.rejects(generate(), (error: Error) => {
        assert.match(error.message, /openai\/gpt-4\.1-mini request failed \(502\)/);
        assert.match(error.message, /Upstream provider exploded mid-generation/);
        return true;
      });
      // An upstream 5xx wrapped in a 200 is transient by nature — it must
      // retry before giving up, like any other 5xx.
      assert.ok(fetchCalls() >= 2, `expected a retry, saw ${fetchCalls()} call(s)`);
    },
  );
});

test('a connection dying mid-body surfaces a read failure naming the provider, and retries', async () => {
  await withOpenAIRouteReturning(
    () =>
      new Response('{"choices":[{"mess', {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    async ({ generate, fetchCalls }) => {
      await assert.rejects(generate(), (error: Error) => {
        assert.match(error.message, /openai\/gpt-4\.1-mini/);
        assert.match(error.message, /could not be read/i);
        return true;
      });
      assert.ok(fetchCalls() >= 2, `expected a retry, saw ${fetchCalls()} call(s)`);
    },
  );
});

test("a finish_reason of 'error' with no content surfaces the failure instead of an empty string", async () => {
  await withOpenAIRouteReturning(
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'error' }],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    async ({ generate }) => {
      const failedUsages: Array<import('../src/models').TextGenerationUsage | undefined> = [];
      await assert.rejects(generate({
        onAttemptFailure: (_attempt, _error, usage) => {
          failedUsages.push(usage);
        },
      }), (error: Error) => {
        assert.match(error.message, /openai\/gpt-4\.1-mini/);
        assert.match(error.message, /error finish/i);
        return true;
      });
      assert.ok(failedUsages.length >= 2, 'the retryable finish error should report each billed attempt');
      assert.ok(failedUsages.every((usage) => usage?.totalTokens === 10));
    },
  );
});

test('a nonempty provider response without a terminal finish reason is never accepted as complete', async () => {
  await withOpenAIRouteReturning(
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'A partial body with no terminal reason.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    async ({ generate }) => {
      const failedUsages: Array<import('../src/models').TextGenerationUsage | undefined> = [];
      await assert.rejects(generate({
        onAttemptFailure: (_attempt, _error, usage) => { failedUsages.push(usage); },
      }), /terminal finish reason/i);
      assert.ok(failedUsages.length >= 2, 'the malformed provider response remains visible per physical attempt');
      assert.ok(failedUsages.every((usage) => usage?.totalTokens === 17));
    },
  );
});

test('a retryable HTTP 502 preserves the structured provider cause and route identity', async () => {
  await withOpenAIRouteReturning(
    () =>
      new Response(
        JSON.stringify({ error: { message: 'Upstream provider died during generation' } }),
        { headers: { 'content-type': 'application/json' }, status: 502, statusText: 'Bad Gateway' },
      ),
    async ({ generate, fetchCalls }) => {
      await assert.rejects(generate(), (error: Error) => {
        assert.match(error.message, /openai\/gpt-4\.1-mini request failed \(502\)/);
        assert.match(error.message, /Upstream provider died during generation/);
        return true;
      });
      assert.ok(fetchCalls() >= 2, `expected a retry, saw ${fetchCalls()} call(s)`);
    },
  );
});

test('a retryable HTTP error reports provider-supplied usage for every billed attempt', async () => {
  await withOpenAIRouteReturning(
    () =>
      new Response(
        JSON.stringify({
          error: { message: 'Upstream billed the failed generation' },
          usage: { prompt_tokens: 19, completion_tokens: 2, total_tokens: 21 },
        }),
        { headers: { 'content-type': 'application/json' }, status: 502, statusText: 'Bad Gateway' },
      ),
    async ({ generate, fetchCalls }) => {
      const failedUsages: Array<import('../src/models').TextGenerationUsage | undefined> = [];
      await assert.rejects(generate({
        onAttemptFailure: (_attempt, _error, usage) => {
          failedUsages.push(usage);
        },
      }), /Upstream billed the failed generation/);

      assert.equal(failedUsages.length, fetchCalls());
      assert.ok(failedUsages.length >= 2, 'the transient failure should retry');
      assert.ok(failedUsages.every((usage) => usage?.totalTokens === 21));
      assert.ok(failedUsages.every((usage) => usage?.provider === 'openai'));
    },
  );
});

// NF-9 (2026-08-23 re-review): a provider HTTP error status with no usage in
// the body is a rejected request, not an unknown generation. Reporting it as
// explicit zero usage lets the retry that follows it settle instead of
// quarantining the whole automation.
test('a retryable HTTP error without a usage body reports explicit zero usage, not unknown', async () => {
  await withOpenAIRouteReturning(
    () =>
      new Response(
        JSON.stringify({ error: { message: 'upstream hiccup' } }),
        { headers: { 'content-type': 'application/json' }, status: 502, statusText: 'Bad Gateway' },
      ),
    async ({ generate, fetchCalls }) => {
      const failedUsages: Array<import('../src/models').TextGenerationUsage | undefined> = [];
      await assert.rejects(generate({
        onAttemptFailure: (_attempt, _error, usage) => {
          failedUsages.push(usage);
        },
      }), /upstream hiccup/);

      assert.equal(failedUsages.length, fetchCalls());
      assert.ok(failedUsages.length >= 2, 'the transient failure should retry');
      for (const usage of failedUsages) {
        assert.deepEqual(
          { input: usage?.inputTokens, output: usage?.outputTokens, total: usage?.totalTokens },
          { input: 0, output: 0, total: 0 },
          'a rejected request generated nothing',
        );
        assert.equal(usage?.provider, 'openai');
      }
    },
  );
});

test('an oversized retryable error preserves its bounded cause and usage fields', async () => {
  await withOpenAIRouteReturning(
    () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Upstream billed then failed',
            details: 'x'.repeat(5_000),
          },
          usage: { prompt_tokens: 19, completion_tokens: 2, total_tokens: 21 },
        }),
        { headers: { 'content-type': 'application/json' }, status: 502, statusText: 'Bad Gateway' },
      ),
    async ({ generate, fetchCalls }) => {
      const failedUsages: Array<import('../src/models').TextGenerationUsage | undefined> = [];
      await assert.rejects(generate({
        onAttemptFailure: (_attempt, _error, usage) => {
          failedUsages.push(usage);
        },
      }), /Upstream billed then failed/);
      assert.equal(failedUsages.length, fetchCalls());
      assert.ok(failedUsages.length >= 2);
      assert.ok(failedUsages.every((usage) => usage?.totalTokens === 21));
    },
  );
});

test('provider causes preserve the category while redacting credentials and echoed customer text', async () => {
  await withOpenAIRouteReturning(
    () => new Response(JSON.stringify({
      error: {
        message:
          'Upstream authentication proxy failed. Authorization: Bearer sk-live-1234567890 prompt: CUSTOMER_SENTINEL_PRIVATE_PLAN',
      },
    }), { headers: { 'content-type': 'application/json' }, status: 502, statusText: 'Bad Gateway' }),
    async ({ generate }) => {
      await assert.rejects(generate(), (error: Error) => {
        assert.match(error.message, /authentication proxy failed/i);
        assert.doesNotMatch(error.message, /sk-live|1234567890|CUSTOMER_SENTINEL_PRIVATE_PLAN/);
        assert.match(error.message, /redacted/i);
        return true;
      });
    },
  );

  await withOpenAIRouteReturning(
    () => new Response(
      'raw proxy dump Authorization: Bearer sk-raw-123456789 CUSTOMER_RAW_SENTINEL',
      { status: 502, statusText: 'Bad Gateway' },
    ),
    async ({ generate }) => {
      await assert.rejects(generate(), (error: Error) => {
        assert.match(error.message, /Bad Gateway|provider request failed/i);
        assert.doesNotMatch(error.message, /sk-raw|CUSTOMER_RAW_SENTINEL|raw proxy dump/);
        return true;
      });
    },
  );
});

test('quoted JSON request payloads are stripped from structured provider errors', async () => {
  await withOpenAIRouteReturning(
    () => new Response(JSON.stringify({
      error: {
        message:
          'Validation failed upstream: {"messages":[{"content":"CUSTOMER_SENTINEL_PRIVATE_PLAN"}]}',
      },
    }), { headers: { 'content-type': 'application/json' }, status: 502, statusText: 'Bad Gateway' }),
    async ({ generate }) => {
      await assert.rejects(generate(), (error: Error) => {
        assert.match(error.message, /Validation failed upstream/i);
        assert.match(error.message, /redacted customer content/i);
        assert.doesNotMatch(error.message, /CUSTOMER_SENTINEL_PRIVATE_PLAN|"content"/);
        return true;
      });
    },
  );
});

test('provider-specific request key variants cannot leak echoed customer payloads', async () => {
  await withOpenAIRouteReturning(
    () => new Response(JSON.stringify({
      error: {
        message:
          'Validation failed upstream: {"input_text":"CUSTOMER_INPUT_SENTINEL","request_body":{"messages":["CUSTOMER_BODY_SENTINEL"]}}',
      },
    }), { headers: { 'content-type': 'application/json' }, status: 502, statusText: 'Bad Gateway' }),
    async ({ generate }) => {
      await assert.rejects(generate(), (error: Error) => {
        assert.match(error.message, /Validation failed upstream/i);
        assert.match(error.message, /redacted customer content/i);
        assert.doesNotMatch(
          error.message,
          /CUSTOMER_INPUT_SENTINEL|CUSTOMER_BODY_SENTINEL|input_text|request_body/,
        );
        return true;
      });
    },
  );
});

test('response-read failures sanitize provider-derived parser text', async () => {
  await withOpenAIRouteReturning(
    () => ({
      status: 200,
      statusText: 'OK',
      ok: true,
      json: async () => {
        throw new Error(
          'Malformed response near "prompt":"CUSTOMER_RESPONSE_READ_SENTINEL" Authorization: Bearer sk-private-123456789',
        );
      },
    } as unknown as Response),
    async ({ generate }) => {
      await assert.rejects(generate(), (error: Error) => {
        assert.match(error.message, /response could not be read/i);
        assert.match(error.message, /redacted/i);
        assert.doesNotMatch(error.message, /CUSTOMER_RESPONSE_READ_SENTINEL|sk-private|123456789/);
        return true;
      });
    },
  );
});

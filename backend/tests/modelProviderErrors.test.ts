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
  run: (context: { generate: () => Promise<unknown>; fetchCalls: () => number }) => Promise<void>,
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
      generate: () =>
        generateTextDetailed(
          'micro',
          'Write a concise founder brief.',
          [{ role: 'user', content: 'Summarize the run.' }],
          300,
          'test-workspace',
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
      await assert.rejects(generate(), (error: Error) => {
        assert.match(error.message, /openai\/gpt-4\.1-mini/);
        assert.match(error.message, /error finish/i);
        return true;
      });
    },
  );
});

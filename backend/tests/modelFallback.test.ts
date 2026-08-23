import assert from 'node:assert/strict';
import Module = require('node:module');
import test from 'node:test';

type ModuleLoader = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };

test('generateTextDetailed falls back to OpenAI after retryable Anthropic failure', async () => {
  const originalLoad = moduleWithLoader._load;
  const originalFetch = global.fetch;
  const originalEnv = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    fallbackApiKeyEnv: process.env.MODEL_FALLBACK_API_KEY_ENV,
    fallbackBaseUrl: process.env.MODEL_FALLBACK_BASE_URL,
    fallbackModel: process.env.MODEL_DEFAULT_FALLBACK_MODEL,
    fallbackOpenRouterModel: process.env.MODEL_FALLBACK_OPENROUTER_MODEL,
    fallbackProvider: process.env.MODEL_DEFAULT_FALLBACK_PROVIDER,
    globalFallbackModel: process.env.MODEL_FALLBACK_MODEL,
    globalFallbackProvider: process.env.MODEL_FALLBACK_PROVIDER,
    modelRetryDelays: process.env.MODEL_RETRY_DELAYS_MS,
    openai: process.env.OPENAI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  };
  let anthropicCalls = 0;
  let fetchCalls = 0;
  const attemptEvents: string[] = [];

  try {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.MODEL_RETRY_DELAYS_MS = '0';
    delete process.env.MODEL_FALLBACK_API_KEY_ENV;
    delete process.env.MODEL_FALLBACK_BASE_URL;
    delete process.env.MODEL_FALLBACK_MODEL;
    delete process.env.MODEL_FALLBACK_OPENROUTER_MODEL;
    delete process.env.MODEL_FALLBACK_PROVIDER;
    delete process.env.MODEL_DEFAULT_FALLBACK_PROVIDER;
    delete process.env.MODEL_DEFAULT_FALLBACK_MODEL;
    delete process.env.OPENROUTER_API_KEY;

    moduleWithLoader._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === '@anthropic-ai/sdk') {
        return {
          default: class FakeAnthropic {
            messages = {
              create: async () => {
                anthropicCalls += 1;
                throw new TypeError('Invalid response body while trying to fetch https://api.anthropic.com/v1/messages: Premature close');
              },
            };
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    global.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      fetchCalls += 1;
      assert.equal(String(input), 'https://api.openai.com/v1/chat/completions');
      const body = JSON.parse(String(init?.body || '{}')) as { model?: string; messages?: Array<{ role: string; content: string }> };
      assert.equal(body.model, 'gpt-4.1-mini');
      assert.equal(body.messages?.[0]?.role, 'system');
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Fallback founder brief' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    };

    delete require.cache[require.resolve('../src/models')];
    const { generateTextDetailed } = require('../src/models') as typeof import('../src/models');
    const result = await generateTextDetailed(
      'default',
      'Write a concise founder brief.',
      [{ role: 'user', content: 'Summarize the run.' }],
      300,
      'test-workspace',
      {
        beforeAttempt: (attempt) => {
          attemptEvents.push(`before:${attempt.provider}:${attempt.attemptNumber}`);
        },
        onAttemptFailure: (attempt) => {
          attemptEvents.push(`failed:${attempt.provider}:${attempt.attemptNumber}`);
        },
        onAttemptSuccess: (attempt) => {
          attemptEvents.push(`succeeded:${attempt.provider}:${attempt.attemptNumber}`);
        },
      },
    );

    assert.equal(result.text, 'Fallback founder brief');
    assert.equal(result.stopReason, 'length');
    assert.equal(result.usage?.totalTokens, 18);
    assert.equal(anthropicCalls, 2);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(attemptEvents, [
      'before:anthropic:1',
      'failed:anthropic:1',
      'before:anthropic:2',
      'failed:anthropic:2',
      'before:openai:1',
      'succeeded:openai:1',
    ]);
  } finally {
    moduleWithLoader._load = originalLoad;
    global.fetch = originalFetch;
    if (typeof originalEnv.anthropic === 'string') process.env.ANTHROPIC_API_KEY = originalEnv.anthropic;
    else delete process.env.ANTHROPIC_API_KEY;
    if (typeof originalEnv.openai === 'string') process.env.OPENAI_API_KEY = originalEnv.openai;
    else delete process.env.OPENAI_API_KEY;
    if (typeof originalEnv.modelRetryDelays === 'string') process.env.MODEL_RETRY_DELAYS_MS = originalEnv.modelRetryDelays;
    else delete process.env.MODEL_RETRY_DELAYS_MS;
    if (typeof originalEnv.fallbackProvider === 'string') process.env.MODEL_DEFAULT_FALLBACK_PROVIDER = originalEnv.fallbackProvider;
    else delete process.env.MODEL_DEFAULT_FALLBACK_PROVIDER;
    if (typeof originalEnv.fallbackModel === 'string') process.env.MODEL_DEFAULT_FALLBACK_MODEL = originalEnv.fallbackModel;
    else delete process.env.MODEL_DEFAULT_FALLBACK_MODEL;
    if (typeof originalEnv.globalFallbackProvider === 'string') process.env.MODEL_FALLBACK_PROVIDER = originalEnv.globalFallbackProvider;
    else delete process.env.MODEL_FALLBACK_PROVIDER;
    if (typeof originalEnv.globalFallbackModel === 'string') process.env.MODEL_FALLBACK_MODEL = originalEnv.globalFallbackModel;
    else delete process.env.MODEL_FALLBACK_MODEL;
    if (typeof originalEnv.fallbackBaseUrl === 'string') process.env.MODEL_FALLBACK_BASE_URL = originalEnv.fallbackBaseUrl;
    else delete process.env.MODEL_FALLBACK_BASE_URL;
    if (typeof originalEnv.fallbackApiKeyEnv === 'string') process.env.MODEL_FALLBACK_API_KEY_ENV = originalEnv.fallbackApiKeyEnv;
    else delete process.env.MODEL_FALLBACK_API_KEY_ENV;
    if (typeof originalEnv.fallbackOpenRouterModel === 'string') process.env.MODEL_FALLBACK_OPENROUTER_MODEL = originalEnv.fallbackOpenRouterModel;
    else delete process.env.MODEL_FALLBACK_OPENROUTER_MODEL;
    if (typeof originalEnv.openrouter === 'string') process.env.OPENROUTER_API_KEY = originalEnv.openrouter;
    else delete process.env.OPENROUTER_API_KEY;
    delete require.cache[require.resolve('../src/models')];
  }
});

test('a successful provider response is not replayed when its accounting hook fails', async () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const envKeys = [
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'MODEL_RETRY_DELAYS_MS',
    'MODEL_DEFAULT_PROVIDER',
    'MODEL_DEFAULT_MODEL',
    'MODEL_DEFAULT_API_KEY_ENV',
    'MODEL_DEFAULT_BASE_URL',
    'MODEL_DEFAULT_FALLBACK_1_PROVIDER',
    'MODEL_DEFAULT_FALLBACK_1_MODEL',
    'MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV',
    'MODEL_DEFAULT_FALLBACK_1_BASE_URL',
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]] as const));
  const urls: string[] = [];

  try {
    console.warn = () => {};
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.MODEL_RETRY_DELAYS_MS = '0';
    process.env.MODEL_DEFAULT_PROVIDER = 'openai';
    process.env.MODEL_DEFAULT_MODEL = 'test-primary';
    process.env.MODEL_DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';
    process.env.MODEL_DEFAULT_BASE_URL = 'https://primary.invalid/v1';
    process.env.MODEL_DEFAULT_FALLBACK_1_PROVIDER = 'openrouter';
    process.env.MODEL_DEFAULT_FALLBACK_1_MODEL = 'test-fallback';
    process.env.MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV = 'OPENROUTER_API_KEY';
    process.env.MODEL_DEFAULT_FALLBACK_1_BASE_URL = 'https://fallback.invalid/v1';

    global.fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Already billed once' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
      }), { headers: { 'content-type': 'application/json' }, status: 200 });
    };

    delete require.cache[require.resolve('../src/models')];
    const { generateTextDetailed } = require('../src/models') as typeof import('../src/models');
    const hookFailure = Object.assign(new Error('journal unavailable'), { status: 503 });
    await assert.rejects(
      generateTextDetailed(
        'default',
        'system',
        [{ role: 'user', content: 'user' }],
        50,
        'workspace-hook-failure',
        { onAttemptSuccess: () => { throw hookFailure; } },
      ),
      /onAttemptSuccess hook failed: journal unavailable/,
    );

    assert.deepEqual(urls, ['https://primary.invalid/v1/chat/completions']);
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    delete require.cache[require.resolve('../src/models')];
  }
});

test('generateTextDetailed keeps walking backup route chain when the first fallback fails', async () => {
  const originalLoad = moduleWithLoader._load;
  const originalFetch = global.fetch;
  const originalEnv = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    fallbackApiKeyEnv: process.env.MODEL_FALLBACK_API_KEY_ENV,
    fallbackBaseUrl: process.env.MODEL_FALLBACK_BASE_URL,
    fallbackModel: process.env.MODEL_DEFAULT_FALLBACK_MODEL,
    fallbackOpenRouterModel: process.env.MODEL_FALLBACK_OPENROUTER_MODEL,
    fallbackProvider: process.env.MODEL_DEFAULT_FALLBACK_PROVIDER,
    globalFallbackModel: process.env.MODEL_FALLBACK_MODEL,
    globalFallbackProvider: process.env.MODEL_FALLBACK_PROVIDER,
    modelRetryDelays: process.env.MODEL_RETRY_DELAYS_MS,
    openai: process.env.OPENAI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  };
  let anthropicCalls = 0;
  let openaiCalls = 0;
  let openrouterCalls = 0;

  try {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.MODEL_RETRY_DELAYS_MS = '0';
    delete process.env.MODEL_FALLBACK_API_KEY_ENV;
    delete process.env.MODEL_FALLBACK_BASE_URL;
    delete process.env.MODEL_FALLBACK_MODEL;
    delete process.env.MODEL_FALLBACK_OPENROUTER_MODEL;
    delete process.env.MODEL_FALLBACK_PROVIDER;
    delete process.env.MODEL_DEFAULT_FALLBACK_PROVIDER;
    delete process.env.MODEL_DEFAULT_FALLBACK_MODEL;

    moduleWithLoader._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === '@anthropic-ai/sdk') {
        return {
          default: class FakeAnthropic {
            messages = {
              create: async () => {
                anthropicCalls += 1;
                throw new TypeError('Invalid response body while trying to fetch https://api.anthropic.com/v1/messages: Premature close');
              },
            };
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    global.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}')) as { model?: string; reasoning?: unknown };
      if (url === 'https://api.openai.com/v1/chat/completions') {
        openaiCalls += 1;
        assert.equal(body.model, 'gpt-4.1-mini');
        return new Response(JSON.stringify({ error: { message: 'OpenAI temporarily unavailable' } }), {
          headers: { 'content-type': 'application/json' },
          status: 503,
        });
      }
      if (url === 'https://openrouter.ai/api/v1/chat/completions') {
        openrouterCalls += 1;
        assert.equal(body.model, 'z-ai/glm-5.2');
        assert.deepEqual(body.reasoning, { enabled: false });
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'GLM fallback founder brief' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 13, completion_tokens: 8, total_tokens: 21 },
        }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
      throw new Error(`Unexpected fallback URL: ${url}`);
    };

    delete require.cache[require.resolve('../src/models')];
    const { generateTextDetailed } = require('../src/models') as typeof import('../src/models');
    const result = await generateTextDetailed(
      'default',
      'Write a concise founder brief.',
      [{ role: 'user', content: 'Summarize the run.' }],
      300,
      'test-workspace',
    );

    assert.equal(result.text, 'GLM fallback founder brief');
    assert.equal(result.usage?.totalTokens, 21);
    assert.equal(result.usage?.provider, 'openrouter');
    assert.equal(result.usage?.model, 'z-ai/glm-5.2');
    assert.equal(anthropicCalls, 2);
    assert.equal(openaiCalls, 2);
    assert.equal(openrouterCalls, 1);
  } finally {
    moduleWithLoader._load = originalLoad;
    global.fetch = originalFetch;
    if (typeof originalEnv.anthropic === 'string') process.env.ANTHROPIC_API_KEY = originalEnv.anthropic;
    else delete process.env.ANTHROPIC_API_KEY;
    if (typeof originalEnv.openai === 'string') process.env.OPENAI_API_KEY = originalEnv.openai;
    else delete process.env.OPENAI_API_KEY;
    if (typeof originalEnv.openrouter === 'string') process.env.OPENROUTER_API_KEY = originalEnv.openrouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (typeof originalEnv.modelRetryDelays === 'string') process.env.MODEL_RETRY_DELAYS_MS = originalEnv.modelRetryDelays;
    else delete process.env.MODEL_RETRY_DELAYS_MS;
    if (typeof originalEnv.fallbackProvider === 'string') process.env.MODEL_DEFAULT_FALLBACK_PROVIDER = originalEnv.fallbackProvider;
    else delete process.env.MODEL_DEFAULT_FALLBACK_PROVIDER;
    if (typeof originalEnv.fallbackModel === 'string') process.env.MODEL_DEFAULT_FALLBACK_MODEL = originalEnv.fallbackModel;
    else delete process.env.MODEL_DEFAULT_FALLBACK_MODEL;
    if (typeof originalEnv.globalFallbackProvider === 'string') process.env.MODEL_FALLBACK_PROVIDER = originalEnv.globalFallbackProvider;
    else delete process.env.MODEL_FALLBACK_PROVIDER;
    if (typeof originalEnv.globalFallbackModel === 'string') process.env.MODEL_FALLBACK_MODEL = originalEnv.globalFallbackModel;
    else delete process.env.MODEL_FALLBACK_MODEL;
    if (typeof originalEnv.fallbackBaseUrl === 'string') process.env.MODEL_FALLBACK_BASE_URL = originalEnv.fallbackBaseUrl;
    else delete process.env.MODEL_FALLBACK_BASE_URL;
    if (typeof originalEnv.fallbackApiKeyEnv === 'string') process.env.MODEL_FALLBACK_API_KEY_ENV = originalEnv.fallbackApiKeyEnv;
    else delete process.env.MODEL_FALLBACK_API_KEY_ENV;
    if (typeof originalEnv.fallbackOpenRouterModel === 'string') process.env.MODEL_FALLBACK_OPENROUTER_MODEL = originalEnv.fallbackOpenRouterModel;
    else delete process.env.MODEL_FALLBACK_OPENROUTER_MODEL;
    delete require.cache[require.resolve('../src/models')];
  }
});

test('generateTextDetailed supports Anthropic fallback after GLM primary and OpenAI fallback fail', async () => {
  const originalLoad = moduleWithLoader._load;
  const originalFetch = global.fetch;
  const originalEnv = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    defaultApiKeyEnv: process.env.MODEL_DEFAULT_API_KEY_ENV,
    defaultBaseUrl: process.env.MODEL_DEFAULT_BASE_URL,
    defaultModel: process.env.MODEL_DEFAULT_MODEL,
    defaultProvider: process.env.MODEL_DEFAULT_PROVIDER,
    fallback1ApiKeyEnv: process.env.MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV,
    fallback1Model: process.env.MODEL_DEFAULT_FALLBACK_1_MODEL,
    fallback1Provider: process.env.MODEL_DEFAULT_FALLBACK_1_PROVIDER,
    fallback2ApiKeyEnv: process.env.MODEL_DEFAULT_FALLBACK_2_API_KEY_ENV,
    fallback2Model: process.env.MODEL_DEFAULT_FALLBACK_2_MODEL,
    fallback2Provider: process.env.MODEL_DEFAULT_FALLBACK_2_PROVIDER,
    modelRetryDelays: process.env.MODEL_RETRY_DELAYS_MS,
    openai: process.env.OPENAI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  };
  let anthropicCalls = 0;
  let openaiCalls = 0;
  let openrouterCalls = 0;

  try {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.MODEL_RETRY_DELAYS_MS = '0';
    process.env.MODEL_DEFAULT_PROVIDER = 'openrouter';
    process.env.MODEL_DEFAULT_MODEL = 'z-ai/glm-5.2';
    process.env.MODEL_DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY';
    process.env.MODEL_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.MODEL_DEFAULT_FALLBACK_1_PROVIDER = 'openai';
    process.env.MODEL_DEFAULT_FALLBACK_1_MODEL = 'gpt-4.1-mini';
    process.env.MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV = 'OPENAI_API_KEY';
    process.env.MODEL_DEFAULT_FALLBACK_2_PROVIDER = 'anthropic';
    process.env.MODEL_DEFAULT_FALLBACK_2_MODEL = 'claude-sonnet-4-6';
    process.env.MODEL_DEFAULT_FALLBACK_2_API_KEY_ENV = 'ANTHROPIC_API_KEY';

    moduleWithLoader._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === '@anthropic-ai/sdk') {
        return {
          default: class FakeAnthropic {
            messages = {
              create: async (body: { model?: string }) => {
                anthropicCalls += 1;
                assert.equal(body.model, 'claude-sonnet-4-6');
                return {
                  content: [{ type: 'text', text: 'Anthropic backup founder brief' }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 17, output_tokens: 9 },
                };
              },
            };
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    global.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}')) as { model?: string };
      if (url === 'https://openrouter.ai/api/v1/chat/completions') {
        openrouterCalls += 1;
        assert.equal(body.model, 'z-ai/glm-5.2');
        return new Response(JSON.stringify({ error: { message: 'OpenRouter temporarily unavailable' } }), {
          headers: { 'content-type': 'application/json' },
          status: 503,
        });
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        openaiCalls += 1;
        assert.equal(body.model, 'gpt-4.1-mini');
        return new Response(JSON.stringify({ error: { message: 'OpenAI temporarily unavailable' } }), {
          headers: { 'content-type': 'application/json' },
          status: 503,
        });
      }
      throw new Error(`Unexpected fallback URL: ${url}`);
    };

    delete require.cache[require.resolve('../src/models')];
    const { generateTextDetailed } = require('../src/models') as typeof import('../src/models');
    const result = await generateTextDetailed(
      'default',
      'Write a concise founder brief.',
      [{ role: 'user', content: 'Summarize the run.' }],
      300,
      'test-workspace',
    );

    assert.equal(result.text, 'Anthropic backup founder brief');
    assert.equal(result.usage?.totalTokens, 26);
    assert.equal(result.usage?.provider, 'anthropic');
    assert.equal(result.usage?.model, 'claude-sonnet-4-6');
    assert.equal(openrouterCalls, 2);
    assert.equal(openaiCalls, 2);
    assert.equal(anthropicCalls, 1);
  } finally {
    moduleWithLoader._load = originalLoad;
    global.fetch = originalFetch;
    if (typeof originalEnv.anthropic === 'string') process.env.ANTHROPIC_API_KEY = originalEnv.anthropic;
    else delete process.env.ANTHROPIC_API_KEY;
    if (typeof originalEnv.openai === 'string') process.env.OPENAI_API_KEY = originalEnv.openai;
    else delete process.env.OPENAI_API_KEY;
    if (typeof originalEnv.openrouter === 'string') process.env.OPENROUTER_API_KEY = originalEnv.openrouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (typeof originalEnv.modelRetryDelays === 'string') process.env.MODEL_RETRY_DELAYS_MS = originalEnv.modelRetryDelays;
    else delete process.env.MODEL_RETRY_DELAYS_MS;
    if (typeof originalEnv.defaultProvider === 'string') process.env.MODEL_DEFAULT_PROVIDER = originalEnv.defaultProvider;
    else delete process.env.MODEL_DEFAULT_PROVIDER;
    if (typeof originalEnv.defaultModel === 'string') process.env.MODEL_DEFAULT_MODEL = originalEnv.defaultModel;
    else delete process.env.MODEL_DEFAULT_MODEL;
    if (typeof originalEnv.defaultApiKeyEnv === 'string') process.env.MODEL_DEFAULT_API_KEY_ENV = originalEnv.defaultApiKeyEnv;
    else delete process.env.MODEL_DEFAULT_API_KEY_ENV;
    if (typeof originalEnv.defaultBaseUrl === 'string') process.env.MODEL_DEFAULT_BASE_URL = originalEnv.defaultBaseUrl;
    else delete process.env.MODEL_DEFAULT_BASE_URL;
    if (typeof originalEnv.fallback1Provider === 'string') process.env.MODEL_DEFAULT_FALLBACK_1_PROVIDER = originalEnv.fallback1Provider;
    else delete process.env.MODEL_DEFAULT_FALLBACK_1_PROVIDER;
    if (typeof originalEnv.fallback1Model === 'string') process.env.MODEL_DEFAULT_FALLBACK_1_MODEL = originalEnv.fallback1Model;
    else delete process.env.MODEL_DEFAULT_FALLBACK_1_MODEL;
    if (typeof originalEnv.fallback1ApiKeyEnv === 'string') process.env.MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV = originalEnv.fallback1ApiKeyEnv;
    else delete process.env.MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV;
    if (typeof originalEnv.fallback2Provider === 'string') process.env.MODEL_DEFAULT_FALLBACK_2_PROVIDER = originalEnv.fallback2Provider;
    else delete process.env.MODEL_DEFAULT_FALLBACK_2_PROVIDER;
    if (typeof originalEnv.fallback2Model === 'string') process.env.MODEL_DEFAULT_FALLBACK_2_MODEL = originalEnv.fallback2Model;
    else delete process.env.MODEL_DEFAULT_FALLBACK_2_MODEL;
    if (typeof originalEnv.fallback2ApiKeyEnv === 'string') process.env.MODEL_DEFAULT_FALLBACK_2_API_KEY_ENV = originalEnv.fallback2ApiKeyEnv;
    else delete process.env.MODEL_DEFAULT_FALLBACK_2_API_KEY_ENV;
    delete require.cache[require.resolve('../src/models')];
  }
});

test('an OpenRouter-only deployment skips an unconfigured Anthropic primary', async () => {
  const originalFetch = global.fetch;
  const envKeys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'MINIMAX_API_KEY',
    'ZAI_API_KEY',
    'MODEL_DEFAULT_PROVIDER',
    'MODEL_DEFAULT_MODEL',
    'MODEL_DEFAULT_API_KEY_ENV',
    'MODEL_DEFAULT_BASE_URL',
    'MODEL_DEFAULT_FALLBACK_PROVIDER',
    'MODEL_DEFAULT_FALLBACK_MODEL',
    'MODEL_DEFAULT_FALLBACK_API_KEY_ENV',
    'MODEL_DEFAULT_FALLBACK_BASE_URL',
    'MODEL_DEFAULT_FALLBACK_1_PROVIDER',
    'MODEL_DEFAULT_FALLBACK_1_MODEL',
    'MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV',
    'MODEL_DEFAULT_FALLBACK_1_BASE_URL',
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]] as const));
  const urls: string[] = [];

  try {
    for (const key of envKeys) delete process.env[key];
    process.env.OPENROUTER_API_KEY = 'test-openrouter-only-key';
    process.env.MODEL_DEFAULT_PROVIDER = 'anthropic';
    process.env.MODEL_DEFAULT_MODEL = 'claude-sonnet-5';
    process.env.MODEL_DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';
    process.env.MODEL_DEFAULT_FALLBACK_1_PROVIDER = 'openrouter';
    process.env.MODEL_DEFAULT_FALLBACK_1_MODEL = 'z-ai/glm-5.2';
    process.env.MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV = 'OPENROUTER_API_KEY';
    process.env.MODEL_DEFAULT_FALLBACK_1_BASE_URL = 'https://openrouter.ai/api/v1';

    global.fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'OpenRouter-only founder brief' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      }), { headers: { 'content-type': 'application/json' }, status: 200 });
    };

    delete require.cache[require.resolve('../src/models')];
    const { generateTextDetailed, getModelRoutingStatus } = require('../src/models') as typeof import('../src/models');
    const routing = getModelRoutingStatus('workspace-openrouter-only') as {
      default: { configured: boolean; fallbacks: Array<{ provider: string; configured: boolean }> };
    };
    assert.equal(routing.default.configured, false);
    assert.ok(routing.default.fallbacks.some((route) => route.provider === 'openrouter' && route.configured));

    const result = await generateTextDetailed(
      'default',
      'Write a concise founder brief.',
      [{ role: 'user', content: 'Summarize the run.' }],
      300,
      'workspace-openrouter-only',
    );

    assert.equal(result.text, 'OpenRouter-only founder brief');
    assert.equal(result.usage?.provider, 'openrouter');
    assert.deepEqual(urls, ['https://openrouter.ai/api/v1/chat/completions']);
  } finally {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    delete require.cache[require.resolve('../src/models')];
  }
});

// NF-5 (2026-08-23 re-review): SDK-transport routes (Anthropic, MiniMax) must
// surface the same route-aware cause the HTTP routes do, and an SDK error
// that carries an HTTP status is a rejected request with explicit zero usage.
test('an exhausted Anthropic SDK failure names the provider, model, status, and cause', async () => {
  const originalLoad = moduleWithLoader._load;
  const envKeys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'MINIMAX_API_KEY',
    'ZAI_API_KEY',
    'MODEL_RETRY_DELAYS_MS',
    'MODEL_DEFAULT_PROVIDER',
    'MODEL_DEFAULT_MODEL',
    'MODEL_DEFAULT_API_KEY_ENV',
    'MODEL_DEFAULT_BASE_URL',
    'MODEL_DEFAULT_FALLBACK_PROVIDER',
    'MODEL_DEFAULT_FALLBACK_MODEL',
    'MODEL_DEFAULT_FALLBACK_API_KEY_ENV',
    'MODEL_DEFAULT_FALLBACK_BASE_URL',
    'MODEL_DEFAULT_FALLBACK_1_PROVIDER',
    'MODEL_DEFAULT_FALLBACK_1_MODEL',
    'MODEL_DEFAULT_FALLBACK_1_API_KEY_ENV',
    'MODEL_DEFAULT_FALLBACK_1_BASE_URL',
    'MODEL_FALLBACK_API_KEY_ENV',
    'MODEL_FALLBACK_BASE_URL',
    'MODEL_FALLBACK_MODEL',
    'MODEL_FALLBACK_OPENROUTER_MODEL',
    'MODEL_FALLBACK_PROVIDER',
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]] as const));
  let anthropicCalls = 0;
  const failedUsages: Array<import('../src/models').TextGenerationUsage | undefined> = [];

  try {
    for (const key of envKeys) delete process.env[key];
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.MODEL_RETRY_DELAYS_MS = '0';
    process.env.MODEL_DEFAULT_PROVIDER = 'anthropic';
    process.env.MODEL_DEFAULT_MODEL = 'claude-sonnet-5';
    process.env.MODEL_DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';

    moduleWithLoader._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === '@anthropic-ai/sdk') {
        return {
          default: class FakeAnthropic {
            messages = {
              create: async () => {
                anthropicCalls += 1;
                throw Object.assign(new Error('Overloaded'), { name: 'InternalServerError', status: 529 });
              },
            };
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[require.resolve('../src/models')];
    const { generateTextDetailed } = require('../src/models') as typeof import('../src/models');
    await assert.rejects(
      generateTextDetailed(
        'default',
        'Write a concise founder brief.',
        [{ role: 'user', content: 'Summarize the run.' }],
        300,
        'test-workspace',
        {
          maxRoutes: 1,
          onAttemptFailure: (_attempt, _error, usage) => {
            failedUsages.push(usage);
          },
        },
      ),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /anthropic\/claude-sonnet-5/, 'the route is named');
        assert.match(message, /529/, 'the status is named');
        assert.match(message, /Overloaded/, 'the provider cause is kept');
        return true;
      },
    );
    assert.ok(anthropicCalls >= 2, 'a 529 is retried');
    assert.equal(failedUsages.length, anthropicCalls);
    for (const usage of failedUsages) {
      assert.deepEqual(
        { input: usage?.inputTokens, output: usage?.outputTokens, total: usage?.totalTokens },
        { input: 0, output: 0, total: 0 },
        'a request the SDK reports as rejected generated nothing',
      );
      assert.equal(usage?.provider, 'anthropic');
    }
  } finally {
    moduleWithLoader._load = originalLoad;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    delete require.cache[require.resolve('../src/models')];
  }
});

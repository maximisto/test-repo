import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
  'MINIMAX_API_KEY',
  'MODEL_DEFAULT_PROVIDER',
  'MODEL_DEFAULT_MODEL',
  'MODEL_DEFAULT_API_KEY_ENV',
  'MODEL_DEFAULT_BASE_URL',
  'WORKSPACE_SETTINGS_SECRET',
] as const;

function clearRoutingModules() {
  delete require.cache[require.resolve('../src/models')];
  delete require.cache[require.resolve('../src/settingsStore')];
}

test('workspace provider override derives the target server credential and base URL', async () => {
  const originalCwd = process.cwd();
  const originalFetch = global.fetch;
  const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-model-override-server-'));
  const urls: string[] = [];

  try {
    process.chdir(tempDir);
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.WORKSPACE_SETTINGS_SECRET = 'test-workspace-settings-secret';
    process.env.ANTHROPIC_API_KEY = 'must-not-be-sent';
    process.env.OPENAI_API_KEY = 'openai-server-key';
    process.env.OPENAI_BASE_URL = 'https://openai-target.invalid/v1';
    process.env.MODEL_DEFAULT_PROVIDER = 'anthropic';
    process.env.MODEL_DEFAULT_MODEL = 'claude-sonnet-5';
    process.env.MODEL_DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';

    clearRoutingModules();
    const settings = require('../src/settingsStore') as typeof import('../src/settingsStore');
    settings.upsertWorkspaceSettings({
      workspaceId: 'workspace-provider-override-server',
      modelOverrides: {
        default: { provider: 'openai', model: 'gpt-override' },
      },
    });

    global.fetch = async (input, init) => {
      urls.push(String(input));
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer openai-server-key');
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Correctly routed' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }), { headers: { 'content-type': 'application/json' }, status: 200 });
    };

    const models = require('../src/models') as typeof import('../src/models');
    const routing = models.getModelRoutingStatus('workspace-provider-override-server');
    assert.equal(routing.default.provider, 'openai');
    assert.equal(routing.default.base_url, 'https://openai-target.invalid/v1');
    assert.equal(routing.default.configured, true);

    const result = await models.generateTextDetailed(
      'default',
      'Return a short answer.',
      [{ role: 'user', content: 'Route this request.' }],
      50,
      'workspace-provider-override-server',
    );
    assert.equal(result.text, 'Correctly routed');
    assert.deepEqual(urls, ['https://openai-target.invalid/v1/chat/completions']);
  } finally {
    global.fetch = originalFetch;
    process.chdir(originalCwd);
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    clearRoutingModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('workspace provider override uses the matching workspace token without inheriting the old route', async () => {
  const originalCwd = process.cwd();
  const originalFetch = global.fetch;
  const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-model-override-token-'));

  try {
    process.chdir(tempDir);
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.WORKSPACE_SETTINGS_SECRET = 'test-workspace-settings-secret';
    process.env.MODEL_DEFAULT_PROVIDER = 'anthropic';
    process.env.MODEL_DEFAULT_MODEL = 'claude-sonnet-5';
    process.env.MODEL_DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';

    clearRoutingModules();
    const settings = require('../src/settingsStore') as typeof import('../src/settingsStore');
    settings.upsertWorkspaceSettings({
      workspaceId: 'workspace-provider-override-token',
      providerTokens: { openai: 'workspace-openai-key' },
      modelOverrides: {
        default: { provider: 'openai', model: 'gpt-workspace-override' },
      },
    });

    global.fetch = async (input, init) => {
      assert.equal(String(input), 'https://api.openai.com/v1/chat/completions');
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer workspace-openai-key');
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Workspace route' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }), { headers: { 'content-type': 'application/json' }, status: 200 });
    };

    const models = require('../src/models') as typeof import('../src/models');
    assert.equal(models.hasConfiguredTextGenerationRoute('default', 'workspace-provider-override-token'), true);
    const result = await models.generateTextDetailed(
      'default',
      'Return a short answer.',
      [{ role: 'user', content: 'Use the workspace token.' }],
      50,
      'workspace-provider-override-token',
    );
    assert.equal(result.text, 'Workspace route');
  } finally {
    global.fetch = originalFetch;
    process.chdir(originalCwd);
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    clearRoutingModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

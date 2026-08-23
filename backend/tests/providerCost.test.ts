import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateProviderCostUsdForUsage } from '../src/platform/cost';

test('estimateProviderCostUsdForUsage prices OpenRouter GLM 5.2 from input and output tokens', () => {
  const cost = estimateProviderCostUsdForUsage('default', {
    provider: 'openrouter',
    model: 'z-ai/glm-5.2',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
  });

  assert.equal(cost, 3.7646);
});

test('provider USD cost never ignores an authoritative total above the observed components', () => {
  const cost = estimateProviderCostUsdForUsage('default', {
    provider: 'openrouter',
    model: 'z-ai/glm-5.2',
    inputTokens: 800,
    outputTokens: 300,
    totalTokens: 5_000,
  });
  const blendedRate = (0.9086 * 3 + 2.856) / 4;
  const totalFloor = Number(((5_000 / 1_000_000) * blendedRate).toFixed(6));

  assert.ok(cost !== null);
  assert.ok(cost >= totalFloor, `provider cost ${cost} must cover the 5,000-token total floor ${totalFloor}`);
});

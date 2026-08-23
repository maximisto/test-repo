import type AnthropicClient from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { getWorkspaceProviderToken, getWorkspaceSettings } from './settingsStore';

export type Provider = 'anthropic' | 'minimax' | 'openai' | 'openrouter' | 'mistral';
type CanonicalTextProfile = 'micro' | 'default' | 'hard' | 'critical' | 'ops';
type LegacyTextProfile = 'balanced' | 'frontier' | 'operations' | 'utility';
export type TextProfile = CanonicalTextProfile | LegacyTextProfile;
type CanonicalEmbeddingProfile = 'memory_text' | 'memory_code';
type LegacyEmbeddingProfile = 'memory';
type EmbeddingProfile = CanonicalEmbeddingProfile | LegacyEmbeddingProfile;
type AnthropicConstructor = typeof import('@anthropic-ai/sdk').default;

interface ModelRoute {
  provider: Provider;
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

export type ModelSource = 'server_default' | 'workspace_override' | 'workspace_token';
type ResolvedProfile = CanonicalTextProfile | CanonicalEmbeddingProfile;

export interface RoutingDecision {
  profile: CanonicalTextProfile;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  needsTools: boolean;
}

export interface TextGenerationUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  provider?: Provider;
  model?: string;
  baseUrl?: string;
}

export interface TextGenerationResult {
  text: string;
  stopReason?: string;
  usage?: TextGenerationUsage;
}

/** One physical request to one provider route, including retries/fallbacks. */
export interface TextGenerationAttempt {
  routeIndex: number;
  attemptNumber: number;
  provider: Provider;
  model: string;
  baseUrl?: string;
}

/**
 * Hooks around the physical provider boundary. Automation accounting uses
 * these to authorize and record every retry/fallback separately; the signal
 * lets its step timeout cancel the request instead of merely abandoning the
 * result while the provider keeps working.
 */
export interface TextGenerationOptions {
  signal?: AbortSignal;
  /** Optional caller-specific physical retry bound (including first attempt). */
  maxAttemptsPerRoute?: number;
  /** Optional caller-specific provider-route bound (including primary). */
  maxRoutes?: number;
  beforeAttempt?: (attempt: TextGenerationAttempt) => void | Promise<void>;
  onAttemptStart?: (attempt: TextGenerationAttempt) => void | Promise<void>;
  onAttemptNotStarted?: (attempt: TextGenerationAttempt, error: unknown) => void | Promise<void>;
  onAttemptSuccess?: (
    attempt: TextGenerationAttempt,
    result: TextGenerationResult,
  ) => void | Promise<void>;
  onAttemptFailure?: (
    attempt: TextGenerationAttempt,
    error: unknown,
    usage?: TextGenerationUsage,
  ) => void | Promise<void>;
}

export interface ModelRetryOptions<T> {
  signal?: AbortSignal;
  maxAttempts?: number;
  beforeAttempt?: (attemptNumber: number) => void | Promise<void>;
  onAttemptStart?: (attemptNumber: number) => void | Promise<void>;
  onAttemptNotStarted?: (attemptNumber: number, error: unknown) => void | Promise<void>;
  onAttemptSuccess?: (attemptNumber: number, result: T) => void | Promise<void>;
  onAttemptFailure?: (attemptNumber: number, error: unknown, result?: T) => void | Promise<void>;
}

let cachedAnthropicConstructor: AnthropicConstructor | null = null;
const DEFAULT_MODEL_RETRY_DELAYS_MS = [1000, 4000, 10000];
const MODEL_FALLBACK_SLOT_COUNT = 3;

class ModelRequestError extends Error {
  status: number;
  usage?: TextGenerationUsage;

  constructor(
    route: { provider: string; model: string },
    status: number,
    message: string,
    usage?: TextGenerationUsage,
  ) {
    super(`${route.provider}/${route.model} request failed (${status}): ${sanitizeModelErrorCause(message)}`);
    this.status = status;
    this.usage = usage;
  }
}

/**
 * A bookkeeping/authorization hook failed outside the provider boundary.
 * Never retry or fall back on this error: the preceding provider request may
 * already have succeeded and replaying it could bill the workspace twice.
 */
class ModelAttemptHookError extends Error {
  readonly cause: unknown;

  constructor(hookName: string, cause: unknown) {
    super(`Model attempt ${hookName} hook failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ModelAttemptHookError';
    this.cause = cause;
  }
}

const MAX_MODEL_ERROR_BODY_BYTES = 64 * 1024;
const MAX_MODEL_ERROR_MESSAGE_CHARS = 500;

function sanitizeModelErrorCause(message: string): string {
  let safe = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk|key|token)-[A-Za-z0-9._-]{8,}/giu, '[redacted credential]')
    .replace(/(["']?(?:authorization|api[_\s-]?key|access[_\s-]?token)["']?\s*[:=]\s*)(?:["'][^"']*["']|[^\s,;}]+)/giu, '$1[redacted]');
  // Provider diagnostics sometimes echo the request as quoted JSON. Once a
  // customer-content key appears, keep the bounded cause prefix but discard
  // the entire structured tail; nested arrays cannot be redacted safely with
  // a value-only regex.
  const customerPayload = /(?:^|[\s{,])["']?(prompt(?:[_\s-]?(?:text|content))?|input(?:[_\s-]?(?:text|content|messages?))?|messages|content|request[_\s-]?(?:body|payload))["']?\s*[:=]/iu.exec(safe);
  if (customerPayload) {
    safe = `${safe.slice(0, customerPayload.index).trimEnd()} customer payload: [redacted customer content]`;
  }
  safe = safe
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return safe.slice(0, MAX_MODEL_ERROR_MESSAGE_CHARS) || 'provider request failed';
}

function sanitizeModelAttemptError(error: unknown): Error {
  if (error instanceof ModelRequestError || error instanceof ModelResponseReadError) return error;
  const source = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    retryable?: unknown;
    usage?: unknown;
  };
  const safe = new Error(sanitizeModelErrorCause(
    typeof source.message === 'string' ? source.message : String(error),
  )) as Error & {
    status?: number;
    statusCode?: number;
    code?: string;
    retryable?: boolean;
    usage?: TextGenerationUsage;
  };
  safe.name = typeof source.name === 'string' ? source.name : 'ModelProviderError';
  if (typeof source.status === 'number') safe.status = source.status;
  if (typeof source.statusCode === 'number') safe.statusCode = source.statusCode;
  if (typeof source.code === 'string') safe.code = source.code;
  if (source.retryable === true || isRetryableModelError(error)) safe.retryable = true;
  if (source.usage && typeof source.usage === 'object') safe.usage = source.usage as TextGenerationUsage;
  return safe;
}

async function readBoundedModelError(
  response: Response,
  route?: ModelRoute,
): Promise<{ cause: string; usage?: TextGenerationUsage }> {
  let bodyText = '';
  try {
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let remaining = MAX_MODEL_ERROR_BODY_BYTES;
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value.subarray(0, remaining);
        bodyText += decoder.decode(chunk, { stream: true });
        remaining -= chunk.byteLength;
        if (chunk.byteLength < value.byteLength || remaining === 0) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
      bodyText += decoder.decode();
    }
  } catch {
    return { cause: response.statusText || 'provider request failed' };
  }

  let cause = '';
  let usage: TextGenerationUsage | undefined;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: unknown };
      message?: unknown;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    if (typeof parsed.error?.message === 'string') cause = parsed.error.message;
    else if (typeof parsed.message === 'string') cause = parsed.message;
    if (route) usage = openAIUsage(route, parsed.usage);
  } catch {
    // The bounded stream may end mid-envelope. Extract only the two allowlisted
    // structured fields from that prefix; never persist arbitrary raw bytes.
    const messageMatch = /"message"\s*:\s*("(?:\\.|[^"\\])*")/u.exec(bodyText);
    if (messageMatch) {
      try {
        const decoded = JSON.parse(messageMatch[1]) as unknown;
        if (typeof decoded === 'string') cause = decoded;
      } catch {
        cause = '';
      }
    }
    if (route) {
      const usageBlock = /"usage"\s*:\s*\{([\s\S]{0,2048})/u.exec(bodyText)?.[1] || '';
      const readUsageNumber = (field: string) => {
        const match = new RegExp(`"${field}"\\s*:\\s*(\\d+(?:\\.\\d+)?)`, 'u').exec(usageBlock);
        return match ? Number(match[1]) : undefined;
      };
      usage = openAIUsage(route, {
        prompt_tokens: readUsageNumber('prompt_tokens'),
        completion_tokens: readUsageNumber('completion_tokens'),
        total_tokens: readUsageNumber('total_tokens'),
      });
    }
  }
  return {
    cause: sanitizeModelErrorCause(cause || response.statusText || 'provider request failed'),
    ...(usage ? { usage } : {}),
  };
}

async function readBoundedModelErrorCause(response: Response): Promise<string> {
  return (await readBoundedModelError(response)).cause;
}

/**
 * The connection died while the response body was still streaming — the
 * 8:51 AM talk-morning failure shape. `response.json()` used to throw a bare
 * SyntaxError here, outside the retry wrapper, with no provider or model
 * named anywhere. Explicitly retryable: a mid-body death is as transient as
 * a mid-connect one.
 */
class ModelResponseReadError extends Error {
  retryable = true;

  constructor(route: { provider: Provider; model: string }, cause: unknown) {
    super(
      `${route.provider}/${route.model} response could not be read: the connection died before the reply finished (${
        sanitizeModelErrorCause(cause instanceof Error ? cause.message : String(cause))
      }).`,
    );
  }
}

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getProviderApiKeyEnv(provider: Provider): string | undefined {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'minimax') return 'MINIMAX_API_KEY';
  if (provider === 'openai') return 'OPENAI_API_KEY';
  if (provider === 'openrouter') return 'OPENROUTER_API_KEY';
  if (provider === 'mistral') return 'MISTRAL_API_KEY';
  return undefined;
}

function getProviderBaseUrl(provider: Provider): string | undefined {
  if (provider === 'anthropic') return env('ANTHROPIC_BASE_URL');
  if (provider === 'minimax') return env('MINIMAX_BASE_URL');
  if (provider === 'openai') return env('OPENAI_BASE_URL') || 'https://api.openai.com/v1';
  if (provider === 'openrouter') return env('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1';
  if (provider === 'mistral') return env('MISTRAL_BASE_URL') || 'https://api.mistral.ai/v1';
  return undefined;
}

function getProviderDefaultTextModel(provider: Provider, profile: CanonicalTextProfile): string {
  if (provider === 'openai') return 'gpt-4.1-mini';
  if (provider === 'openrouter') return 'z-ai/glm-5.2';
  if (provider === 'minimax') return 'minimax/minimax-m2.7';
  if (provider === 'mistral') return 'mistral-large-latest';
  if (profile === 'ops') return 'claude-haiku-4-5-20251001';
  if (profile === 'hard' || profile === 'critical') return 'claude-opus-5';
  return 'claude-sonnet-5';
}

function applyTextRouteOverrides(
  route: ModelRoute,
  overrides: Partial<ModelRoute> | undefined,
  profile: CanonicalTextProfile,
): ModelRoute {
  if (!overrides) return route;
  const provider = overrides.provider || route.provider;
  const providerChanged = provider !== route.provider;
  return {
    ...route,
    provider,
    model: overrides.model || (providerChanged ? getProviderDefaultTextModel(provider, profile) : route.model),
    apiKeyEnv: overrides.apiKeyEnv
      || (providerChanged ? getProviderApiKeyEnv(provider) : undefined)
      || route.apiKeyEnv,
    baseUrl: overrides.baseUrl
      || (providerChanged ? getProviderBaseUrl(provider) : route.baseUrl),
    reasoningEffort: overrides.reasoningEffort || route.reasoningEffort,
  };
}

function isOpenAICompatibleTextProvider(provider: Provider) {
  return provider === 'openai' || provider === 'openrouter';
}

function isSupportedTextGenerationProvider(provider: string): provider is Provider {
  return provider === 'anthropic' || provider === 'minimax' || provider === 'openai' || provider === 'openrouter';
}

function isRouteConfigured(route: ModelRoute, workspaceId?: string) {
  return Boolean(
    (workspaceId && getWorkspaceProviderToken(workspaceId, route.provider)) ||
    env(route.apiKeyEnv),
  );
}

function getErrorStatus(error: unknown) {
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  return undefined;
}

export function isRetryableModelError(error: unknown, depth = 0): boolean {
  if (error instanceof ModelAttemptHookError) return false;
  if ((error as { retryable?: unknown })?.retryable === true) return true;
  const status = getErrorStatus(error);
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;

  const candidate = error as { cause?: unknown; code?: unknown; name?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) return true;
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  if (/timeout|abort/i.test(name)) return true;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (/fetch failed|network|socket|timeout|temporar|premature close|invalid response body|terminated|connection (closed|reset)|body timeout|UND_ERR/i.test(message)) {
    return true;
  }

  return depth < 3 && candidate.cause ? isRetryableModelError(candidate.cause, depth + 1) : false;
}

function isFallbackableModelError(error: unknown) {
  if (error instanceof ModelAttemptHookError) return false;
  if (isRetryableModelError(error)) return true;
  const status = getErrorStatus(error);
  return status === 401 || status === 402 || status === 403 || status === 404;
}

async function runModelAttemptHook(
  hookName: 'beforeAttempt' | 'onAttemptStart' | 'onAttemptNotStarted' | 'onAttemptSuccess' | 'onAttemptFailure',
  hook: (() => void | Promise<void>) | undefined,
): Promise<void> {
  if (!hook) return;
  try {
    await hook();
  } catch (error) {
    throw new ModelAttemptHookError(hookName, error);
  }
}

function modelAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Model request aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfModelRequestAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw modelAbortReason(signal);
}

async function sleep(ms: number, signal?: AbortSignal) {
  throwIfModelRequestAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(signal ? modelAbortReason(signal) : new Error('Model request aborted.'));
    };
    timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function getModelRetryDelaysMs() {
  const configured = env('MODEL_RETRY_DELAYS_MS');
  if (!configured) return DEFAULT_MODEL_RETRY_DELAYS_MS;
  const parsed = configured
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0)
    .map((item) => Math.trunc(item));
  return parsed.length > 0 ? parsed : DEFAULT_MODEL_RETRY_DELAYS_MS;
}

export async function withModelRetry<T>(
  label: string,
  operation: (onAttemptStart: () => Promise<void>) => Promise<T>,
  options: ModelRetryOptions<T> = {},
): Promise<T> {
  let lastError: unknown;
  const retryDelays = getModelRetryDelaysMs();
  const maximumAttempts = Number.isFinite(options.maxAttempts)
    ? Math.max(1, Math.min(retryDelays.length + 1, Math.trunc(options.maxAttempts as number)))
    : retryDelays.length + 1;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const attemptNumber = attempt + 1;
    throwIfModelRequestAborted(options.signal);
    // Kept outside the provider try/catch: an authorization refusal means no
    // provider request started and must never be classified or retried as one.
    await runModelAttemptHook('beforeAttempt', () => options.beforeAttempt?.(attemptNumber));
    if (options.signal?.aborted) {
      const failure = modelAbortReason(options.signal);
      await runModelAttemptHook(
        'onAttemptNotStarted',
        () => options.onAttemptNotStarted?.(attemptNumber, failure),
      );
      throw failure;
    }

    let requestStarted = false;
    let notStartedHandled = false;
    const markAttemptStarted = async () => {
      if (requestStarted) return;
      if (options.signal?.aborted) {
        const failure = modelAbortReason(options.signal);
        notStartedHandled = true;
        await runModelAttemptHook(
          'onAttemptNotStarted',
          () => options.onAttemptNotStarted?.(attemptNumber, failure),
        );
        throw failure;
      }
      await runModelAttemptHook(
        'onAttemptStart',
        () => options.onAttemptStart?.(attemptNumber),
      );
      if (options.signal?.aborted) {
        const failure = modelAbortReason(options.signal);
        notStartedHandled = true;
        await runModelAttemptHook(
          'onAttemptNotStarted',
          () => options.onAttemptNotStarted?.(attemptNumber, failure),
        );
        throw failure;
      }
      requestStarted = true;
    };

    let result: T;
    try {
      result = await operation(markAttemptStarted);
    } catch (error) {
      // A generation transport that supports the explicit request-boundary
      // hook may still reject locally before invoking it (for example while
      // shaping a request). That is not a physical provider failure.
      if (options.onAttemptStart && !requestStarted) {
        if (!notStartedHandled && !(error instanceof ModelAttemptHookError)) {
          await runModelAttemptHook(
            'onAttemptNotStarted',
            () => options.onAttemptNotStarted?.(attemptNumber, error),
          );
        }
        throw error;
      }
      const failure = options.signal?.aborted
        ? modelAbortReason(options.signal)
        : sanitizeModelAttemptError(error);
      await runModelAttemptHook(
        'onAttemptFailure',
        () => options.onAttemptFailure?.(attemptNumber, failure),
      );
      lastError = failure;
      if (options.signal?.aborted) throw failure;
      if (attempt + 1 >= maximumAttempts || !isRetryableModelError(error)) {
        throw failure;
      }
      const delayMs = retryDelays[attempt];
      console.warn(`[models] ${label} failed; retrying in ${delayMs}ms`, {
        attempt: attemptNumber,
        error: failure.message,
      });
      await sleep(delayMs, options.signal);
      continue;
    }

    if (options.signal?.aborted) {
      const failure = modelAbortReason(options.signal);
      // The provider won the response/abort race and returned a billable
      // result. Preserve it for accounting even though the caller must still
      // observe the timeout/abort rather than consume a late answer.
      await runModelAttemptHook(
        'onAttemptFailure',
        () => options.onAttemptFailure?.(attemptNumber, failure, result),
      );
      throw failure;
    }
    // Also outside the provider try/catch: telemetry hook failures must not
    // replay a successful, already-billed provider request.
    await runModelAttemptHook(
      'onAttemptSuccess',
      () => options.onAttemptSuccess?.(attemptNumber, result),
    );
    return result;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchModelResponseWithRetry(
  label: string,
  url: string,
  init: RequestInit,
  route?: { provider: string; model: string },
): Promise<Response> {
  return withModelRetry(label, async () => {
    const response = await fetch(url, init);
    if (response.status === 429 || response.status >= 500) {
      const cause = await readBoundedModelErrorCause(response);
      if (route) {
        throw new ModelRequestError(route, response.status, cause);
      }
      const error = new Error(`Retryable model request failed with ${response.status}: ${cause}`) as Error & {
        status: number;
      };
      error.status = response.status;
      throw error;
    }
    return response;
  });
}

function getAnthropicConstructor(): AnthropicConstructor {
  if (cachedAnthropicConstructor) return cachedAnthropicConstructor;
  const loaded = require('@anthropic-ai/sdk') as { default?: AnthropicConstructor };
  cachedAnthropicConstructor = loaded.default || (loaded as AnthropicConstructor);
  return cachedAnthropicConstructor;
}

function resolveTextProfile(profile: TextProfile): CanonicalTextProfile {
  switch (profile) {
    case 'balanced':
      return 'default';
    case 'frontier':
      return 'critical';
    case 'operations':
      return 'ops';
    case 'utility':
      return 'micro';
    default:
      return profile;
  }
}

function getTextRouteDefault(profile: TextProfile): ModelRoute {
  const resolvedProfile = resolveTextProfile(profile);
  const defaults: Record<CanonicalTextProfile, ModelRoute> = {
    micro: {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKeyEnv: 'OPENAI_API_KEY',
      baseUrl: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    },
    default: {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      baseUrl: env('ANTHROPIC_BASE_URL'),
    },
    hard: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      baseUrl: env('ANTHROPIC_BASE_URL'),
    },
    critical: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      baseUrl: env('ANTHROPIC_BASE_URL'),
    },
    ops: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      baseUrl: env('ANTHROPIC_BASE_URL'),
    },
  };

  const legacyOverrides: Partial<Record<LegacyTextProfile, Partial<ModelRoute>>> = {
    balanced: {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
    frontier: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
    operations: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
    utility: {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKeyEnv: 'OPENAI_API_KEY',
      baseUrl: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    },
  };

  const prefix = `MODEL_${resolvedProfile.toUpperCase()}`;
  const route = applyTextRouteOverrides(defaults[resolvedProfile], {
    provider: env(`${prefix}_PROVIDER`) as Provider | undefined,
    model: env(`${prefix}_MODEL`),
    apiKeyEnv: env(`${prefix}_API_KEY_ENV`),
    baseUrl: env(`${prefix}_BASE_URL`),
    reasoningEffort: env(`${prefix}_REASONING_EFFORT`) as ModelRoute['reasoningEffort'] | undefined,
  }, resolvedProfile);

  if (profile === resolvedProfile) return route;

  const legacyPrefix = `MODEL_${profile.toUpperCase()}`;
  const legacyRoute = applyTextRouteOverrides(
    route,
    legacyOverrides[profile as LegacyTextProfile],
    resolvedProfile,
  );
  return applyTextRouteOverrides(legacyRoute, {
    provider: env(`${legacyPrefix}_PROVIDER`) as Provider | undefined,
    model: env(`${legacyPrefix}_MODEL`),
    apiKeyEnv: env(`${legacyPrefix}_API_KEY_ENV`),
    baseUrl: env(`${legacyPrefix}_BASE_URL`),
    reasoningEffort: env(`${legacyPrefix}_REASONING_EFFORT`) as ModelRoute['reasoningEffort'] | undefined,
  }, resolvedProfile);
}

function resolveEmbeddingProfile(profile: EmbeddingProfile): CanonicalEmbeddingProfile {
  if (profile === 'memory') return 'memory_text';
  return profile;
}

function getTextRoute(profile: TextProfile, workspaceId?: string): ModelRoute {
  const resolvedProfile = resolveTextProfile(profile);
  const route = getTextRouteDefault(profile);
  const override = workspaceId ? getWorkspaceSettings(workspaceId)?.modelOverrides?.[resolvedProfile] : undefined;
  return applyTextRouteOverrides(route, override, resolvedProfile);
}

function getTextFallbackEnv(profile: TextProfile, key: 'PROVIDER' | 'MODEL' | 'API_KEY_ENV' | 'BASE_URL' | 'REASONING_EFFORT', slot?: number) {
  const resolvedProfile = resolveTextProfile(profile);
  if (slot) {
    return env(`MODEL_${resolvedProfile.toUpperCase()}_FALLBACK_${slot}_${key}`) || env(`MODEL_FALLBACK_${slot}_${key}`);
  }
  return env(`MODEL_${resolvedProfile.toUpperCase()}_FALLBACK_${key}`) || env(`MODEL_FALLBACK_${key}`);
}

function getDefaultFallbackModel(provider: Provider) {
  if (provider === 'openai') return env('MODEL_FALLBACK_OPENAI_MODEL') || 'gpt-4.1-mini';
  if (provider === 'openrouter') return env('MODEL_FALLBACK_OPENROUTER_MODEL') || 'z-ai/glm-5.2';
  if (provider === 'anthropic') return env('MODEL_FALLBACK_ANTHROPIC_MODEL') || 'claude-sonnet-4-6';
  return undefined;
}

function routeKey(route: ModelRoute) {
  return [
    route.provider,
    route.model,
    route.baseUrl || '',
    route.apiKeyEnv,
  ].join('|');
}

function buildConfiguredTextFallbackRoute(profile: TextProfile, slot?: number): ModelRoute | null {
  const fallbackProvider = getTextFallbackEnv(profile, 'PROVIDER', slot);
  const fallbackModel = getTextFallbackEnv(profile, 'MODEL', slot);
  const fallbackApiKeyEnv = getTextFallbackEnv(profile, 'API_KEY_ENV', slot);
  const fallbackBaseUrl = getTextFallbackEnv(profile, 'BASE_URL', slot);
  const fallbackReasoningEffort = getTextFallbackEnv(profile, 'REASONING_EFFORT', slot);

  if (!fallbackProvider && !fallbackModel && !fallbackApiKeyEnv && !fallbackBaseUrl && !fallbackReasoningEffort) {
    return null;
  }

  const provider = fallbackProvider || 'openai';
  if (!isSupportedTextGenerationProvider(provider)) return null;

  const apiKeyEnv = fallbackApiKeyEnv || getProviderApiKeyEnv(provider);
  const model = fallbackModel || getDefaultFallbackModel(provider);
  if (!apiKeyEnv || !model) return null;

  return {
    provider,
    model,
    apiKeyEnv,
    baseUrl: fallbackBaseUrl || getProviderBaseUrl(provider),
    reasoningEffort: fallbackReasoningEffort as ModelRoute['reasoningEffort'] | undefined,
  };
}

function getTextFallbackRoutes(profile: TextProfile, primaryRoute: ModelRoute, workspaceId?: string): ModelRoute[] {
  const seen = new Set([routeKey(primaryRoute)]);
  const routes: ModelRoute[] = [];
  const addRoute = (route: ModelRoute | null) => {
    if (!route || !isSupportedTextGenerationProvider(route.provider)) return;
    const key = routeKey(route);
    if (seen.has(key) || !isRouteConfigured(route, workspaceId)) return;
    seen.add(key);
    routes.push(route);
  };

  addRoute(buildConfiguredTextFallbackRoute(profile));
  for (let slot = 1; slot <= MODEL_FALLBACK_SLOT_COUNT; slot += 1) {
    addRoute(buildConfiguredTextFallbackRoute(profile, slot));
  }

  addRoute({
    provider: 'openai',
    model: getDefaultFallbackModel('openai') || 'gpt-4.1-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: getProviderBaseUrl('openai'),
  });
  addRoute({
    provider: 'openrouter',
    model: getDefaultFallbackModel('openrouter') || 'z-ai/glm-5.2',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: getProviderBaseUrl('openrouter'),
  });
  addRoute({
    provider: 'anthropic',
    model: getDefaultFallbackModel('anthropic') || 'claude-sonnet-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: getProviderBaseUrl('anthropic'),
  });
  addRoute({
    provider: 'openai',
    model: env('MODEL_FALLBACK_ZAI_MODEL') || 'glm-5.2',
    apiKeyEnv: 'ZAI_API_KEY',
    baseUrl: env('ZAI_BASE_URL') || 'https://api.z.ai/api/paas/v4',
  });

  return routes;
}

/**
 * Read-only route readiness used before an automation is acknowledged.
 *
 * This deliberately uses the same primary + fallback resolution as
 * `generateTextDetailed`, including workspace tokens and profile-specific
 * overrides. Checking a generic provider key would otherwise accept a plan
 * whose `ops` or `hard` call still has no executable route.
 */
export function hasConfiguredTextGenerationRoute(profile: TextProfile, workspaceId?: string): boolean {
  const primaryRoute = getTextRoute(profile, workspaceId);
  return (isSupportedTextGenerationProvider(primaryRoute.provider) && isRouteConfigured(primaryRoute, workspaceId))
    || getTextFallbackRoutes(profile, primaryRoute, workspaceId).length > 0;
}

function getEmbeddingRoute(profile: EmbeddingProfile, workspaceId?: string): ModelRoute {
  const resolvedProfile = resolveEmbeddingProfile(profile);
  const defaults: Record<CanonicalEmbeddingProfile, ModelRoute> = {
    memory_text: {
      provider: 'mistral',
      model: env('MODEL_MEMORY_TEXT_MODEL') || env('MODEL_MEMORY_MODEL') || 'mistral-embed',
      apiKeyEnv: env('MODEL_MEMORY_TEXT_API_KEY_ENV') || env('MODEL_MEMORY_API_KEY_ENV') || 'MISTRAL_API_KEY',
      baseUrl: env('MISTRAL_BASE_URL') || 'https://api.mistral.ai/v1',
    },
    memory_code: {
      provider: 'mistral',
      model: env('MODEL_MEMORY_CODE_MODEL') || 'codestral-embed',
      apiKeyEnv: env('MODEL_MEMORY_CODE_API_KEY_ENV') || 'MISTRAL_API_KEY',
      baseUrl: env('MISTRAL_BASE_URL') || 'https://api.mistral.ai/v1',
    },
  };

  const prefix = `MODEL_${resolvedProfile.toUpperCase()}`;
  const route = {
    ...defaults[resolvedProfile],
    provider: (env(`${prefix}_PROVIDER`) as Provider | undefined) || defaults[resolvedProfile].provider,
    model: env(`${prefix}_MODEL`) || defaults[resolvedProfile].model,
    apiKeyEnv: env(`${prefix}_API_KEY_ENV`) || defaults[resolvedProfile].apiKeyEnv,
    baseUrl: env(`${prefix}_BASE_URL`) || defaults[resolvedProfile].baseUrl,
    reasoningEffort: (env(`${prefix}_REASONING_EFFORT`) as ModelRoute['reasoningEffort'] | undefined) || defaults[resolvedProfile].reasoningEffort,
  };
  const override = workspaceId ? getWorkspaceSettings(workspaceId)?.modelOverrides?.[resolvedProfile] : undefined;
  return {
    ...route,
    provider: override?.provider || route.provider,
    model: override?.model || route.model,
    baseUrl: override?.baseUrl || route.baseUrl,
    reasoningEffort: override?.reasoningEffort || route.reasoningEffort,
  };
}

function getEmbeddingRouteDefault(profile: EmbeddingProfile): ModelRoute {
  return getEmbeddingRoute(profile);
}

export function getModelSource(profile: TextProfile, workspaceId?: string): ModelSource {
  const route = getTextRoute(profile, workspaceId);
  const defaultRoute = getTextRouteDefault(profile);
  const workspaceSettings = workspaceId ? getWorkspaceSettings(workspaceId) : null;
  const resolvedProfile = resolveTextProfile(profile);
  const hasWorkspaceToken = Boolean(workspaceId && getWorkspaceProviderToken(workspaceId, route.provider));
  const hasModelOverride = Boolean(workspaceSettings?.modelOverrides?.[resolvedProfile]);

  if (hasWorkspaceToken) return 'workspace_token';
  if (hasModelOverride && (
    route.provider !== defaultRoute.provider ||
    route.model !== defaultRoute.model ||
    route.baseUrl !== defaultRoute.baseUrl ||
    route.reasoningEffort !== defaultRoute.reasoningEffort
  )) {
    return 'workspace_override';
  }
  return 'server_default';
}

function getEmbeddingSource(profile: EmbeddingProfile, workspaceId?: string): ModelSource {
  const route = getEmbeddingRoute(profile, workspaceId);
  const defaultRoute = getEmbeddingRouteDefault(profile);
  const workspaceSettings = workspaceId ? getWorkspaceSettings(workspaceId) : null;
  const resolvedProfile = resolveEmbeddingProfile(profile);
  const hasWorkspaceToken = Boolean(workspaceId && getWorkspaceProviderToken(workspaceId, route.provider));
  const hasModelOverride = Boolean(workspaceSettings?.modelOverrides?.[resolvedProfile]);

  if (hasWorkspaceToken) return 'workspace_token';
  if (hasModelOverride && (
    route.provider !== defaultRoute.provider ||
    route.model !== defaultRoute.model ||
    route.baseUrl !== defaultRoute.baseUrl ||
    route.reasoningEffort !== defaultRoute.reasoningEffort
  )) {
    return 'workspace_override';
  }
  return 'server_default';
}

export function getModelSourceLabel(source: ModelSource): string {
  if (source === 'workspace_token') return 'Workspace token';
  if (source === 'workspace_override') return 'Workspace override';
  return 'Server default';
}

function resolveProviderApiKey(route: ModelRoute, workspaceId?: string): string {
  const workspaceToken = workspaceId ? getWorkspaceProviderToken(workspaceId, route.provider) : undefined;
  if (workspaceToken) return workspaceToken;
  return requireEnv(route.apiKeyEnv);
}

function getAnthropicCompatibleClient(profile: TextProfile, workspaceId?: string) {
  const route = getTextRoute(profile, workspaceId);
  if (route.provider !== 'anthropic' && route.provider !== 'minimax') {
    throw new Error(`${profile} profile must use an Anthropic-compatible provider.`);
  }

  return {
    route,
    client: new (getAnthropicConstructor())({
      apiKey: resolveProviderApiKey(route, workspaceId),
      baseURL: route.baseUrl,
    }) as AnthropicClient,
  };
}

export function getChatModelConfig(profile: TextProfile = 'default', workspaceId?: string) {
  return getTextRoute(profile, workspaceId);
}

export function getUtilityModelConfig(workspaceId?: string) {
  return getTextRoute('micro', workspaceId);
}

export function getMicroModelConfig(workspaceId?: string) {
  return getTextRoute('micro', workspaceId);
}

export function getMemoryEmbeddingConfig(workspaceId?: string) {
  return getEmbeddingRoute('memory_text', workspaceId);
}

export function getCodeEmbeddingConfig(workspaceId?: string) {
  return getEmbeddingRoute('memory_code', workspaceId);
}

export function getModelRoutingStatus(workspaceId?: string) {
  const micro = getTextRoute('micro', workspaceId);
  const defaultRoute = getTextRoute('default', workspaceId);
  const hard = getTextRoute('hard', workspaceId);
  const critical = getTextRoute('critical', workspaceId);
  const ops = getTextRoute('ops', workspaceId);
  const memoryText = getEmbeddingRoute('memory_text', workspaceId);
  const memoryCode = getEmbeddingRoute('memory_code', workspaceId);

  const buildStatus = (
    profile: ResolvedProfile,
    route: ModelRoute,
    toolLoopCompatible: boolean,
    source: ModelSource,
  ) => ({
    provider: route.provider,
    model: route.model,
    configured: Boolean(workspaceId ? getWorkspaceProviderToken(workspaceId, route.provider) || env(route.apiKeyEnv) : env(route.apiKeyEnv)),
    tool_loop_compatible: toolLoopCompatible,
    source,
    source_label: getModelSourceLabel(source),
    base_url: route.baseUrl,
    reasoning_effort: route.reasoningEffort,
  });
  const buildTextStatus = (
    profile: CanonicalTextProfile,
    route: ModelRoute,
    toolLoopCompatible: boolean,
    source: ModelSource,
  ) => ({
    ...buildStatus(profile, route, toolLoopCompatible, source),
    fallbacks: getTextFallbackRoutes(profile, route, workspaceId).map((fallbackRoute) => ({
      provider: fallbackRoute.provider,
      model: fallbackRoute.model,
      configured: isRouteConfigured(fallbackRoute, workspaceId),
      base_url: fallbackRoute.baseUrl,
      reasoning_effort: fallbackRoute.reasoningEffort,
    })),
  });

  return {
    micro: buildTextStatus('micro', micro, isToolLoopCompatible(micro.provider), getModelSource('micro', workspaceId)),
    default: buildTextStatus('default', defaultRoute, isToolLoopCompatible(defaultRoute.provider), getModelSource('default', workspaceId)),
    hard: buildTextStatus('hard', hard, isToolLoopCompatible(hard.provider), getModelSource('hard', workspaceId)),
    critical: buildTextStatus('critical', critical, isToolLoopCompatible(critical.provider), getModelSource('critical', workspaceId)),
    ops: buildTextStatus('ops', ops, isToolLoopCompatible(ops.provider), getModelSource('ops', workspaceId)),
    memory_text: buildStatus('memory_text', memoryText, false, getEmbeddingSource('memory_text', workspaceId)),
    memory_code: buildStatus('memory_code', memoryCode, false, getEmbeddingSource('memory_code', workspaceId)),
  };
}

function isToolLoopCompatible(provider: Provider): boolean {
  return provider === 'anthropic' || provider === 'minimax' || provider === 'openrouter' || provider === 'openai';
}

function anthropicTextFromResponse(response: { content: Array<{ type: string; text?: string }> }): string {
  const parts = response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean);
  return parts.join('\n\n').trim();
}

function buildGenerationAttempt(
  route: ModelRoute,
  routeIndex: number,
  attemptNumber: number,
): TextGenerationAttempt {
  return {
    routeIndex,
    attemptNumber,
    provider: route.provider,
    model: route.model,
    ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
  };
}

function generationRetryOptions(
  route: ModelRoute,
  routeIndex: number,
  options: TextGenerationOptions,
): ModelRetryOptions<TextGenerationResult> {
  return {
    signal: options.signal,
    maxAttempts: options.maxAttemptsPerRoute,
    beforeAttempt: (attemptNumber) =>
      options.beforeAttempt?.(buildGenerationAttempt(route, routeIndex, attemptNumber)),
    onAttemptStart: (attemptNumber) =>
      options.onAttemptStart?.(buildGenerationAttempt(route, routeIndex, attemptNumber)),
    onAttemptNotStarted: (attemptNumber, error) =>
      options.onAttemptNotStarted?.(buildGenerationAttempt(route, routeIndex, attemptNumber), error),
    onAttemptSuccess: (attemptNumber, result) =>
      options.onAttemptSuccess?.(buildGenerationAttempt(route, routeIndex, attemptNumber), result),
    onAttemptFailure: (attemptNumber, error, result) =>
      options.onAttemptFailure?.(
        buildGenerationAttempt(route, routeIndex, attemptNumber),
        error,
        result?.usage ?? (error as { usage?: TextGenerationUsage })?.usage,
      ),
  };
}

function openAIUsage(
  route: ModelRoute,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): TextGenerationUsage | undefined {
  if (!usage) return undefined;
  const hasReportedTokens = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens]
    .some((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (!hasReportedTokens) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    provider: route.provider,
    model: route.model,
    baseUrl: route.baseUrl,
  };
}

async function generateWithOpenAI(
  route: ModelRoute,
  system: string,
  messages: MessageParam[],
  maxTokens: number,
  workspaceId?: string,
  routeIndex = 0,
  options: TextGenerationOptions = {},
): Promise<TextGenerationResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${resolveProviderApiKey(route, workspaceId)}`,
  };

  if (route.provider === 'openrouter') {
    headers['HTTP-Referer'] = env('OPENROUTER_SITE_URL') || 'https://violema.com';
    headers['X-Title'] = env('OPENROUTER_APP_NAME') || 'Violema';
  }

  const requestBody: Record<string, unknown> = {
    model: route.model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      ...messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string'
          ? message.content
          : message.content
              .map((item) => ('text' in item ? item.text : ''))
              .join('\n'),
      })),
    ],
  };

  if (route.provider === 'openrouter') {
    requestBody.reasoning = route.reasoningEffort && route.reasoningEffort !== 'none'
      ? { effort: route.reasoningEffort }
      : { enabled: false };
  } else if (route.reasoningEffort) {
    requestBody.reasoning_effort = route.reasoningEffort;
  }

  // The whole exchange — fetch, body read, and envelope checks — sits inside
  // ONE retry wrapper. The body read used to happen after the retry wrapper
  // had already returned, so a connection dying mid-body threw a bare
  // SyntaxError with no retry, no provider, and no model attached: the
  // 8:51 AM talk-morning step death.
  return withModelRetry('OpenAI text generation', async (onAttemptStart) => {
    await onAttemptStart();
    const response = await fetch(`${route.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
    if (response.status === 429 || response.status >= 500) {
      const failure = await readBoundedModelError(response, route);
      throw new ModelRequestError(route, response.status, failure.cause, failure.usage);
    }

    let data: {
      error?: { message?: string; code?: number };
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      data = await response.json() as typeof data;
    } catch (error) {
      throw new ModelResponseReadError(route, error);
    }

    if (!response.ok) {
      throw new ModelRequestError(
        route,
        response.status,
        data.error?.message || response.statusText,
        openAIUsage(route, data.usage),
      );
    }

    // OpenRouter wraps upstream provider failures in an HTTP 200 with an
    // `error` body. Falling through here returned `text: ''`, which callers
    // then misreported as an empty or truncated generation. The upstream
    // status code (when present) drives retry/fallback classification the
    // same way a real HTTP status would; an unlabeled failure counts as a
    // 502 so it stays transient.
    if (data.error?.message) {
      const upstreamStatus = typeof data.error.code === 'number' ? data.error.code : 502;
      throw new ModelRequestError(route, upstreamStatus, data.error.message, openAIUsage(route, data.usage));
    }

    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'error') {
      throw new ModelRequestError(
        route,
        502,
        `the provider reported an error finish${choice.message?.content?.trim() ? '' : ' with no content'}.`,
        openAIUsage(route, data.usage),
      );
    }
    if (!choice?.finish_reason?.trim()) {
      throw new ModelRequestError(
        route,
        502,
        'the provider response did not include a terminal finish reason.',
        openAIUsage(route, data.usage),
      );
    }

    return {
      text: choice?.message?.content?.trim() || '',
      stopReason: choice?.finish_reason,
      usage: data.usage
        ? openAIUsage(route, data.usage)
        : undefined,
    };
  }, generationRetryOptions(route, routeIndex, options));
}

async function generateWithAnthropicRoute(
  route: ModelRoute,
  system: string,
  messages: MessageParam[],
  maxTokens: number,
  workspaceId?: string,
  routeIndex = 0,
  options: TextGenerationOptions = {},
): Promise<TextGenerationResult> {
  const client = new (getAnthropicConstructor())({
    apiKey: resolveProviderApiKey(route, workspaceId),
    baseURL: route.baseUrl,
    // The SDK otherwise performs hidden retries inside one observable call.
    // Violema owns retries so every physical request crosses authorization.
    maxRetries: 0,
  }) as AnthropicClient;
  return withModelRetry('Anthropic text generation', async (onAttemptStart) => {
    await onAttemptStart();
    const response = await client.messages.create({
        model: route.model,
        max_tokens: maxTokens,
        system,
        messages,
      },
      { signal: options.signal },
    );

    const usage = 'usage' in response && response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens:
            (response.usage.input_tokens || 0) +
            (response.usage.output_tokens || 0),
          provider: route.provider,
          model: route.model,
          baseUrl: route.baseUrl,
        }
      : undefined;
    const stopReason = response.stop_reason?.trim();
    if (!stopReason) {
      throw new ModelRequestError(
        route,
        502,
        'the provider response did not include a terminal stop reason.',
        usage,
      );
    }

    return {
      text: anthropicTextFromResponse(response),
      stopReason,
      usage,
    };
  }, generationRetryOptions(route, routeIndex, options));
}

async function generateWithAnthropicLike(profile: TextProfile, system: string, messages: MessageParam[], maxTokens: number, workspaceId?: string): Promise<TextGenerationResult> {
  const resolvedProfile = resolveTextProfile(profile);
  if (resolvedProfile !== 'default' && resolvedProfile !== 'critical' && resolvedProfile !== 'ops') {
    throw new Error(`Unsupported Anthropic-compatible profile: ${profile}`);
  }

  const { route } = getAnthropicCompatibleClient(profile, workspaceId);
  return generateWithAnthropicRoute(route, system, messages, maxTokens, workspaceId);
}

async function generateWithTextRoute(
  route: ModelRoute,
  system: string,
  messages: MessageParam[],
  maxTokens: number,
  workspaceId?: string,
  routeIndex = 0,
  options: TextGenerationOptions = {},
): Promise<TextGenerationResult> {
  if (route.provider === 'openai' || route.provider === 'openrouter') {
    return generateWithOpenAI(route, system, messages, maxTokens, workspaceId, routeIndex, options);
  }

  if (route.provider === 'anthropic' || route.provider === 'minimax') {
    return generateWithAnthropicRoute(route, system, messages, maxTokens, workspaceId, routeIndex, options);
  }

  throw new Error(`Unsupported text provider: ${route.provider}`);
}

export async function generateTextDetailed(
  profile: TextProfile,
  system: string,
  messages: MessageParam[],
  maxTokens: number,
  workspaceId?: string,
  options: TextGenerationOptions = {},
): Promise<TextGenerationResult> {
  const primaryRoute = getTextRoute(profile, workspaceId);
  // Readiness permits a configured fallback to satisfy generation. Skip an
  // unconfigured default route before constructing its client so key lookup
  // cannot prevent a configured backup from ever being attempted.
  const configuredRoutes = [primaryRoute, ...getTextFallbackRoutes(profile, primaryRoute, workspaceId)]
    .filter((route) => isSupportedTextGenerationProvider(route.provider) && isRouteConfigured(route, workspaceId));
  if (configuredRoutes.length === 0) {
    throw new Error(`No configured text generation route is available for ${profile}.`);
  }
  const maximumRoutes = Number.isFinite(options.maxRoutes)
    ? Math.max(1, Math.min(configuredRoutes.length, Math.trunc(options.maxRoutes as number)))
    : configuredRoutes.length;
  const routes = configuredRoutes.slice(0, maximumRoutes);

  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    try {
      return await generateWithTextRoute(route, system, messages, maxTokens, workspaceId, index, options);
    } catch (error) {
      const fallbackRoute = routes[index + 1];
      if (!fallbackRoute || !isFallbackableModelError(error)) throw error;
      console.warn(`[models] ${profile} text generation failed on ${route.provider}/${route.model}; falling back to ${fallbackRoute.provider}/${fallbackRoute.model}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new Error(`Unsupported text provider for ${profile}: ${primaryRoute.provider}`);
}

export async function generateText(profile: TextProfile, system: string, messages: MessageParam[], maxTokens: number, workspaceId?: string) {
  const result = await generateTextDetailed(profile, system, messages, maxTokens, workspaceId);
  return result.text;
}

export function getChatClient(profile: TextProfile = 'default', workspaceId?: string) {
  const requestedRoute = getTextRoute(profile, workspaceId);
  if (requestedRoute.provider === 'anthropic' || requestedRoute.provider === 'minimax') {
    const resolved = getAnthropicCompatibleClient(profile, workspaceId);
    return {
      ...resolved,
      requestedRoute,
      executingRoute: resolved.route,
      fallbackApplied: false,
    };
  }

  return {
    client: null,
    route: requestedRoute,
    requestedRoute,
    executingRoute: requestedRoute,
    fallbackApplied: false,
  };
}

function truncateForRouting(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function heuristicRoute(messages: Array<{ role: string; content: string }>): RoutingDecision {
  const userText = messages
    .filter((message) => message.role === 'user')
    .map((message) => truncateForRouting(message.content))
    .join('\n\n');
  const text = userText.toLowerCase();

  const needsTools = /(search|latest|current|news|price|email|slack|screenshot|screen shot|browser|schedule|automation|report|github|jira|linear|hubspot|stripe|salesforce|ga4|google analytics|run code|write code|debug)/.test(text);
  const highRisk = /(legal|medical|financial|security|production|incident|outage|migration|contract|board|investor|customer-facing|root cause|architecture)/.test(text);
  const heavyOps = /(batch|bulk|pipeline|queue|throughput|monitor|cron|scheduler|automation|backfill|process thousands|large volume|operational)/.test(text);
  const complex = /(design|plan|strategy|compare|tradeoff|root cause|refactor|debug|implement|analyze|investigate|architecture|system prompt|multi-step)/.test(text) || userText.length > 1800;

  if (highRisk) {
    return { profile: 'critical', reason: 'high_risk_task', risk: 'high', needsTools };
  }

  if (heavyOps && needsTools) {
    return { profile: 'ops', reason: 'operational_workload', risk: 'medium', needsTools };
  }

  if (complex || (needsTools && userText.length > 600)) {
    return { profile: 'hard', reason: 'complex_multi_step_request', risk: 'medium', needsTools };
  }

  if (!needsTools && userText.length < 240) {
    return { profile: 'micro', reason: 'small_text_task', risk: 'low', needsTools: false };
  }

  return { profile: 'default', reason: needsTools ? 'tool_using_default' : 'general_default', risk: 'low', needsTools };
}

export async function routeChatProfile(messages: Array<{ role: string; content: string }>, workspaceId?: string): Promise<RoutingDecision> {
  const microRoute = getTextRoute('micro', workspaceId);
  const microConfigured = Boolean(workspaceId ? getWorkspaceProviderToken(workspaceId, microRoute.provider) || env(microRoute.apiKeyEnv) : env(microRoute.apiKeyEnv));
  const promptMessages = messages
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: truncateForRouting(message.content),
    }))
    .filter((message) => message.content);

  if (!microConfigured || promptMessages.length === 0) {
    return heuristicRoute(messages);
  }

  try {
    const response = await generateText(
      'micro',
      'Classify the task for routing. Return JSON only with keys: profile, reason, risk, needsTools. Valid profile values: micro, default, hard, critical, ops. Valid risk values: low, medium, high.',
      [{
        role: 'user',
        content: JSON.stringify({
          messages: promptMessages,
          instructions: 'Choose the cheapest model that can reliably complete the task. Use ops for long-running or operational workloads, critical for high-stakes work, hard for complex reasoning or coding, default for normal tool-using chat, micro for short low-risk text tasks.',
        }),
      }],
      120,
      workspaceId,
    );

    const parsed = JSON.parse(response) as Partial<RoutingDecision>;
    if (
      parsed.profile &&
      ['micro', 'default', 'hard', 'critical', 'ops'].includes(parsed.profile) &&
      parsed.reason &&
      parsed.risk &&
      ['low', 'medium', 'high'].includes(parsed.risk)
    ) {
      return {
        profile: parsed.profile as CanonicalTextProfile,
        reason: String(parsed.reason),
        risk: parsed.risk as RoutingDecision['risk'],
        needsTools: Boolean(parsed.needsTools),
      };
    }
  } catch {
    // Fall back to deterministic routing if the cheap router fails.
  }

  return heuristicRoute(messages);
}

export async function createMemoryEmbeddings(input: string | string[], workspaceId?: string) {
  const route = getEmbeddingRoute('memory', workspaceId);
  const response = await fetchModelResponseWithRetry('Embedding generation', `${route.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resolveProviderApiKey(route, workspaceId)}`,
    },
    body: JSON.stringify({
      model: route.model,
      input,
    }),
  }, route);

  const data = await response.json() as {
    data?: Array<{ embedding: number[]; index: number }>;
    model?: string;
    usage?: { total_tokens?: number };
    object?: string;
    message?: string;
  };

  if (!response.ok) {
    throw new Error(`Mistral embeddings request failed: ${data.message || response.statusText}`);
  }

  return data;
}

const DEFAULT_DIAGNOSTIC_MAX_BYTES = 500;

function boundUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '…';
  const bodyBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  const bounded = Buffer.alloc(bodyBytes);
  const written = bounded.write(value, 0, bodyBytes, 'utf8');
  return `${bounded.toString('utf8', 0, written).trimEnd()}${suffix}`;
}

/**
 * Provider exceptions are not tenant-safe audit data. Keep a short diagnostic
 * category while stripping credentials and any echoed request/customer body.
 */
export function sanitizeIntegrationDiagnostic(
  message: string,
  maxBytes = DEFAULT_DIAGNOSTIC_MAX_BYTES,
) {
  let safe = message
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, ' ')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]+\b/gu, '[redacted credential]')
    .replace(/\b(authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]');
  const customerPayload = /(?:^|[\s{,])["']?(?:prompt(?:[_\s-]?(?:text|content))?|input(?:[_\s-]?(?:text|content|messages?))?|messages|content|markdown[_\s-]?text|text[_\s-]?body|request[_\s-]?(?:body|payload))["']?\s*[:=]/iu.exec(safe);
  if (customerPayload) {
    safe = `${safe.slice(0, customerPayload.index).trimEnd()} customer payload: [redacted customer content]`;
  }
  safe = safe.replace(/\s+/gu, ' ').trim();
  return boundUtf8(safe || 'integration unavailable', Math.max(32, maxBytes));
}

function safeIdentifier(value: unknown, maxChars = 100) {
  if (typeof value !== 'string') return undefined;
  const safe = value.trim().replace(/[^a-zA-Z0-9._:/?=&-]+/g, '_').slice(0, maxChars);
  return safe || undefined;
}

/** Persist only the failure contract, never an arbitrary provider envelope. */
export function sanitizeIntegrationFailurePayload(
  payload: Record<string, unknown>,
  fallbackMessage: string,
) {
  const message = typeof payload.message === 'string' && payload.message.trim()
    ? sanitizeIntegrationDiagnostic(payload.message)
    : sanitizeIntegrationDiagnostic(fallbackMessage);
  const nextAction = payload.nextAction && typeof payload.nextAction === 'object' && !Array.isArray(payload.nextAction)
    ? payload.nextAction as Record<string, unknown>
    : null;
  return {
    ok: false as const,
    ...(safeIdentifier(payload.code) ? { code: safeIdentifier(payload.code) } : {}),
    ...(safeIdentifier(payload.source) ? { source: safeIdentifier(payload.source) } : {}),
    ...(safeIdentifier(payload.query_type) ? { query_type: safeIdentifier(payload.query_type) } : {}),
    message,
    ...(typeof payload.can_continue === 'boolean' ? { can_continue: payload.can_continue } : {}),
    ...(typeof payload.live === 'boolean' ? { live: payload.live } : {}),
    ...(nextAction
      ? {
          nextAction: {
            ...(typeof nextAction.label === 'string'
              ? { label: sanitizeIntegrationDiagnostic(nextAction.label, 160) }
              : {}),
            ...(safeIdentifier(nextAction.route, 240) ? { route: safeIdentifier(nextAction.route, 240) } : {}),
          },
        }
      : {}),
  };
}

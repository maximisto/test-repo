import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import net from 'net';
import type { Browser } from 'playwright';

const SCREENSHOT_DIR = path.join(process.cwd(), 'generated-screenshots');
const PRIVATE_IPV4_PATTERNS = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^0\./,
];

function isPrivateIPv4(address: string): boolean {
  if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(address))) return true;

  const match = address.match(/^172\.(\d{1,3})\./);
  if (!match) return false;

  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}

function parseIPv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase();
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
  if (net.isIP(normalized) !== 6) return null;

  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':');
    const octets = normalized.slice(separator + 1).split('.').map(Number);
    if (
      separator < 0 ||
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, separator)}:${high}:${low}`;
  }

  const compressionIndex = normalized.indexOf('::');
  if (
    compressionIndex >= 0 &&
    normalized.indexOf('::', compressionIndex + 2) >= 0
  ) {
    return null;
  }

  const left = (compressionIndex >= 0 ? normalized.slice(0, compressionIndex) : normalized)
    .split(':')
    .filter(Boolean);
  const right = compressionIndex >= 0
    ? normalized.slice(compressionIndex + 2).split(':').filter(Boolean)
    : [];
  const omittedWords = 8 - left.length - right.length;
  if (
    (compressionIndex < 0 && omittedWords !== 0) ||
    (compressionIndex >= 0 && omittedWords < 1)
  ) {
    return null;
  }

  const words = [
    ...left,
    ...Array.from({ length: Math.max(0, omittedWords) }, () => '0'),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

function isPrivateIPv6(address: string): boolean {
  const words = parseIPv6Words(address);
  if (!words) return true;

  const first = words[0];
  const isGlobalUnicast = (first & 0xe000) === 0x2000;
  const isSixToFour = first === 0x2002;
  const isTeredo = first === 0x2001 && words[1] === 0;

  // Permit normal global-unicast IPv6 only. This fails closed for unspecified,
  // loopback, IPv4-compatible/mapped/translated, NAT64, link-local, unique-local,
  // multicast, and other reserved address families. Transition tunnels that can
  // embed an IPv4 target are excluded even though their prefix is global-unicast.
  return !isGlobalUnicast || isSixToFour || isTeredo;
}

type DnsLookupResult = { address: string; family: number };

function normalizedHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
}

function isPrivateIpLiteral(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIPv4(normalized);
  if (family === 6) {
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    return isPrivateIPv6(normalized) || (mappedIpv4 ? isPrivateIPv4(mappedIpv4) : false);
  }
  return false;
}

/**
 * Synchronous save-time guard. DNS is intentionally rechecked immediately
 * before execution because hostnames can change after a mission is saved.
 */
export function validateBrowserScreenshotUrlLiteral(targetUrl: string): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new Error('A valid public http or https URL is required.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
    throw new Error('A valid public http or https URL is required.');
  }

  const hostname = normalizedHostname(parsedUrl.hostname);
  if (hostname === 'localhost') {
    throw new Error('Localhost targets are blocked.');
  }
  if (isPrivateIpLiteral(hostname)) {
    throw new Error('Private network targets are blocked.');
  }

  return parsedUrl;
}

export interface BrowserScreenshotDeps {
  lookup?: (hostname: string) => Promise<DnsLookupResult[]>;
  launch?: () => Promise<Browser>;
  /** Test seam; production cleanup is bounded to two seconds. */
  closeTimeoutMs?: number;
}

function boundedAbortSignal(parent: AbortSignal | undefined, timeoutMs: number, label: string) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(
    parent?.reason instanceof Error ? parent.reason : new Error(`${label} was aborted.`),
  );
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();
  const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out.`)), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

async function awaitAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onLateResult?: (value: T) => void | Promise<void>,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason instanceof Error ? signal.reason : new Error('Operation was aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) {
          void onLateResult?.(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

async function closeBrowserBounded(browser: Browser, timeoutMs = 2_000) {
  const guard = boundedAbortSignal(undefined, Math.max(1, timeoutMs), 'Screenshot browser cleanup');
  try {
    await awaitAbortable(browser.close(), guard.signal);
  } catch {
    // Cleanup is best effort and must never keep the automation/credit hold
    // open after the screenshot deadline. The browser process is already
    // asked to close above; timeout only releases the workflow waiter.
  } finally {
    guard.cleanup();
  }
}

async function assertPublicUrl(
  targetUrl: string,
  signal: AbortSignal | undefined,
  lookup: (hostname: string) => Promise<DnsLookupResult[]>,
): Promise<URL> {
  const parsedUrl = validateBrowserScreenshotUrlLiteral(targetUrl);
  const hostname = normalizedHostname(parsedUrl.hostname);

  const guard = boundedAbortSignal(signal, 10_000, 'Screenshot DNS lookup');
  let lookupResults: DnsLookupResult[];
  try {
    lookupResults = await awaitAbortable(lookup(hostname), guard.signal);
  } finally {
    guard.cleanup();
  }
  for (const result of lookupResults) {
    if (
      (result.family === 4 && isPrivateIPv4(result.address)) ||
      (result.family === 6 && isPrivateIPv6(result.address))
    ) {
      throw new Error('Private network targets are blocked.');
    }
  }

  return parsedUrl;
}

/** Authoritative non-sending readiness check, including DNS rebinding guard. */
export async function preflightBrowserScreenshotUrl(
  targetUrl: string,
  signal?: AbortSignal,
  deps: Pick<BrowserScreenshotDeps, 'lookup'> = {},
) {
  const lookup = deps.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true }));
  return assertPublicUrl(targetUrl, signal, lookup);
}

export interface BrowserScreenshotInput {
  url: string;
  full_page?: boolean;
  width?: number;
  height?: number;
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle';
}

export async function takeBrowserScreenshot(
  input: BrowserScreenshotInput,
  signal?: AbortSignal,
  deps: BrowserScreenshotDeps = {},
) {
  signal?.throwIfAborted();
  const lookup = deps.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true }));
  const parsedUrl = await assertPublicUrl(input.url, signal, lookup);
  signal?.throwIfAborted();
  const width = Math.min(Math.max(Number(input.width) || 1440, 320), 2400);
  const height = Math.min(Math.max(Number(input.height) || 900, 320), 2400);
  const fullPage = input.full_page !== false;
  const waitUntil = input.wait_until || 'networkidle';

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const fileName = `shot-${Date.now()}.png`;
  const filePath = path.join(SCREENSHOT_DIR, fileName);

  const launch = deps.launch ?? (async () => {
    const { chromium } = await import('playwright');
    return chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage'],
    });
  });
  const launchGuard = boundedAbortSignal(signal, 30_000, 'Screenshot browser launch');
  let browser: Browser;
  try {
    browser = await awaitAbortable(
      launch(),
      launchGuard.signal,
      (lateBrowser) => closeBrowserBounded(lateBrowser, deps.closeTimeoutMs),
    );
  } finally {
    launchGuard.cleanup();
  }
  const closeOnAbort = () => { void browser.close().catch(() => undefined); };
  signal?.addEventListener('abort', closeOnAbort, { once: true });

  try {
    signal?.throwIfAborted();
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(parsedUrl.toString(), {
      waitUntil,
      timeout: 30_000,
    });

    await page.screenshot({
      path: filePath,
      fullPage,
      type: 'png',
    });
    signal?.throwIfAborted();

    return {
      success: true,
      url: parsedUrl.toString(),
      title: await page.title(),
      width,
      height,
      full_page: fullPage,
      screenshot_path: filePath,
      screenshot_url: `/api/generated-screenshots/${fileName}`,
      captured_at: new Date().toISOString(),
    };
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    await closeBrowserBounded(browser, deps.closeTimeoutMs);
  }
}

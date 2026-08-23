// Pulls preview images (og:image / twitter:image) from the evidence links in a
// delivered brief so Slack shows real article graphics without Violema hosting
// anything. Fail-soft by design: any fetch or parse miss just means the brief
// ships without that image.

import type { SlackBlock } from './slackBlocks';

const MAX_HTML_BYTES = 400_000;

export interface BriefLink {
  url: string;
  label: string;
}

// SSRF guard: only public https hosts — no IP literals, localhost, or internal suffixes.
export function isFetchableHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.includes(':') || /^\[/.test(host)) return false;
  return host.includes('.');
}

export function extractBriefLinks(markdown: string, limit: number): BriefLink[] {
  const links: BriefLink[] = [];
  const seenHosts = new Set<string>();
  const pattern = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) && links.length < limit) {
    try {
      const parsed = new URL(match[2]);
      if (!isFetchableHost(parsed.hostname) || seenHosts.has(parsed.hostname)) continue;
      seenHosts.add(parsed.hostname);
      links.push({ url: match[2], label: match[1].trim() || parsed.hostname });
    } catch {
      continue;
    }
  }

  return links;
}

/** og:image content arrives HTML-escaped; undecoded &amp; breaks signed CDN URLs. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;|&#x0*26;/gi, '&')
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function parseOgImageFromHtml(html: string): string | null {
  const metaTags = html.match(/<meta\s[^>]*>/gi) || [];
  let fallback: string | null = null;

  for (const tag of metaTags) {
    const nameMatch = tag.match(/(?:property|name)\s*=\s*["'](og:image|twitter:image)(?::src)?["']/i);
    if (!nameMatch) continue;
    const contentMatch = tag.match(/content\s*=\s*["']([^"']+)["']/i);
    if (!contentMatch) continue;
    const url = decodeHtmlEntities(contentMatch[1].trim());
    if (!/^https:\/\//.test(url)) continue;
    if (nameMatch[1].toLowerCase() === 'og:image') return url;
    fallback = fallback || url;
  }

  return fallback;
}

async function fetchOgImage(
  link: BriefLink,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  parentSignal?: AbortSignal,
): Promise<{ link: BriefLink; imageUrl: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(link.url, {
      signal: parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal,
      headers: {
        Accept: 'text/html',
        // Browser-like UA: many publishers 403 unknown bots, which starves the
        // brief of images. The product name stays present for transparency.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 ViolemaBriefBot/1.0',
      },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('html')) return null;
    const html = (await response.text()).slice(0, MAX_HTML_BYTES);
    const imageUrl = parseOgImageFromHtml(html);
    return imageUrl ? { link, imageUrl } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function collectLinkImageBlocks(
  markdown: string,
  options?: {
    limit?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    candidates?: BriefLink[];
    signal?: AbortSignal;
  },
): Promise<SlackBlock[]> {
  const limit = options?.limit ?? 3;
  const timeoutMs = options?.timeoutMs ?? 3500;
  const fetchImpl = options?.fetchImpl ?? fetch;

  // Explicit evidence links (from the run's own search results) come first so
  // images never depend on the model formatting markdown links in the memo.
  const links: BriefLink[] = [];
  const seenHosts = new Set<string>();
  for (const candidate of [...(options?.candidates ?? []), ...extractBriefLinks(markdown, limit)]) {
    if (links.length >= limit) break;
    try {
      const parsed = new URL(candidate.url);
      if (parsed.protocol !== 'https:' || !isFetchableHost(parsed.hostname) || seenHosts.has(parsed.hostname)) continue;
      seenHosts.add(parsed.hostname);
      links.push({ url: candidate.url, label: candidate.label?.trim() || parsed.hostname });
    } catch {
      continue;
    }
  }
  if (links.length === 0) return [];

  const results = await Promise.all(
    links.map((link) => fetchOgImage(link, timeoutMs, fetchImpl, options?.signal)),
  );
  const candidates = results.filter((result): result is { link: BriefLink; imageUrl: string } => result !== null);
  // Slack downloads image_url server-side at post time; one unfetchable image
  // (signed/expiring CDN, hotlink protection) fails the whole message as
  // invalid_blocks. Probe first and drop anything Slack couldn't pull.
  const probed = await Promise.all(
    candidates.map(async (candidate) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const signal = options?.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal;
        const response = await fetchImpl(candidate.imageUrl, { signal });
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        return response.ok && contentType.startsWith('image/') ? candidate : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }),
  );
  const found = probed.filter((result): result is { link: BriefLink; imageUrl: string } => result !== null);
  if (found.length === 0) return [];

  const blocks: SlackBlock[] = [{ type: 'divider' }];
  for (const { link, imageUrl } of found) {
    blocks.push({ type: 'image', image_url: imageUrl, alt_text: link.label });
  }
  return blocks;
}

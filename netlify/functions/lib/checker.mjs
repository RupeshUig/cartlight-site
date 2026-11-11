import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

export const USER_AGENT = 'CartlightCheck/1.0 (+https://cartlightlabs.com/script-tag-migration)';
export const RESULT_NOTE =
  "We checked script tags on your public storefront. Code inside your theme isn't included.";

const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB cap

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback'
]);

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
  '.arpa',
  '.onion'
];

const SHOPIFY_OWN_HOSTS = [
  'shopify.com',
  'shopifycdn.com',
  'shopifycloud.com',
  'shop.app',
  'shopifysvc.com',
  'shopifycs.com'
];

const GENERIC_HOST_PROVIDERS = [
  { match: 'amazonaws.com', provider: 'Amazon AWS' },
  { match: 'cloudfront.net', provider: 'Amazon CloudFront' },
  { match: 'storage.googleapis.com', provider: 'Google Cloud Storage' },
  { match: 'storage.cloud.google.com', provider: 'Google Cloud Storage' },
  { match: 'firebasestorage.googleapis.com', provider: 'Firebase Storage' },
  { match: 'firebasestorage.app', provider: 'Firebase Storage' },
  { match: 'ajax.googleapis.com', provider: 'Google Hosted Libraries' },
  { match: 'jsdelivr.net', provider: 'jsDelivr' },
  { match: 'unpkg.com', provider: 'unpkg' },
  { match: 'cdnjs.cloudflare.com', provider: 'Cloudflare cdnjs' },
  { match: 'r2.dev', provider: 'Cloudflare' },
  { match: 'workers.dev', provider: 'Cloudflare' },
  { match: 'pages.dev', provider: 'Cloudflare' },
  { match: 'blob.core.windows.net', provider: 'Microsoft Azure Storage' },
  { match: 'digitaloceanspaces.com', provider: 'DigitalOcean Spaces' },
  { match: 'fastly.net', provider: 'Fastly' },
  { match: 'akamaized.net', provider: 'Akamai' },
  { match: 'herokuapp.com', provider: 'Heroku' },
  { match: 'vercel.app', provider: 'Vercel' },
  { match: 'netlify.app', provider: 'Netlify' },
  { match: 'github.io', provider: 'GitHub' },
  { match: 'githubusercontent.com', provider: 'GitHub' },
  { match: 'firebaseapp.com', provider: 'Firebase Hosting' },
  { match: 'backblazeb2.com', provider: 'Backblaze B2' },
  { match: 'b-cdn.net', provider: 'Bunny CDN' },
  { match: 'bunny.net', provider: 'Bunny CDN' }
];

export function detectGenericHostProvider(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return '';
  let best = null;
  for (const rule of GENERIC_HOST_PROVIDERS) {
    if (h === rule.match || h.endsWith(`.${rule.match}`)) {
      if (!best || rule.match.length > best.match.length) {
        best = rule;
      }
    }
  }
  return best ? best.provider : '';
}

export function findMostSpecificKnownApp(scriptHost, knownApps) {
  const h = String(scriptHost || '').toLowerCase();
  if (!h || !Array.isArray(knownApps)) return null;

  let bestEntry = null;
  let bestLength = -1;

  for (const entry of knownApps) {
    if (!entry || typeof entry.match !== 'string') continue;
    const matchDomain = entry.match.trim().toLowerCase().replace(/^\.+/, '');
    if (!matchDomain) continue;
    if (h === matchDomain || h.endsWith(`.${matchDomain}`)) {
      if (matchDomain.length > bestLength) {
        bestLength = matchDomain.length;
        bestEntry = entry;
      }
    }
  }

  return bestEntry && bestEntry.verified === true ? bestEntry : null;
}

let cachedKnownApps = null;

export function loadKnownApps() {
  if (cachedKnownApps) return cachedKnownApps;
  const moduleRelativePath = fileURLToPath(
    new URL('../../../data/known-apps.json', import.meta.url)
  );
  const candidates = [path.resolve(process.cwd(), 'data/known-apps.json'), moduleRelativePath];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        cachedKnownApps = Array.isArray(parsed) ? parsed : parsed.apps || [];
        return cachedKnownApps;
      }
    } catch {
      // Try next candidate
    }
  }
  cachedKnownApps = [];
  return cachedKnownApps;
}

export function isValidPublicHostname(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.toLowerCase().replace(/\.+$/, '');
  if (h.length < 3 || h.length > 253) return false;
  if (!h.includes('.')) return false;
  if (net.isIP(h) !== 0) return false;
  if (BLOCKED_HOSTNAMES.has(h)) return false;
  if (BLOCKED_SUFFIXES.some((suffix) => h.endsWith(suffix))) return false;

  const labels = h.split('.');
  const tld = labels[labels.length - 1];
  if (!tld || /^\d+$/.test(tld)) return false;

  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    h
  );
}

export function normalizeStoreHostname(rawInput) {
  if (typeof rawInput !== 'string') return { ok: false, reason: 'invalid' };
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 512 || /[\s\\@]/.test(trimmed)) {
    return { ok: false, reason: 'invalid' };
  }

  let candidate = trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    if (!/^https?:\/\//i.test(candidate)) {
      return { ok: false, reason: 'invalid' };
    }
  } else if (candidate.includes('://')) {
    return { ok: false, reason: 'invalid' };
  } else {
    candidate = `https://${candidate.replace(/^\/+/, '')}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (parsed.username || parsed.password || parsed.port !== '') {
    return { ok: false, reason: 'invalid' };
  }
  if (/^[a-zA-Z0-9.-]+:\d+/.test(trimmed.replace(/^https?:\/\//i, ''))) {
    return { ok: false, reason: 'invalid' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!isValidPublicHostname(hostname)) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, hostname };
}

function isPrivateIPv4Parts(parts) {
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 & TEST-NET
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast & reserved
  return false;
}

export function isPrivateOrReservedIP(rawIp) {
  const ip = String(rawIp || '')
    .trim()
    .toLowerCase()
    .split('%')[0];
  const ipVersion = net.isIP(ip);
  if (ipVersion === 0) return true;

  if (ipVersion === 4) {
    return isPrivateIPv4Parts(ip.split('.').map(Number));
  }

  // IPv6 checks
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('::ffff:')) {
    const rest = ip.slice(7);
    if (net.isIP(rest) === 4) {
      return isPrivateIPv4Parts(rest.split('.').map(Number));
    }
    const hexGroups = rest.split(':');
    if (hexGroups.length === 2) {
      const hi = Number.parseInt(hexGroups[0], 16);
      const lo = Number.parseInt(hexGroups[1], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        return isPrivateIPv4Parts([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
      }
    }
    return true;
  }

  const firstGroup = Number.parseInt(ip.split(':')[0] || '0', 16);
  if ((firstGroup & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((firstGroup & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((firstGroup & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (ip.startsWith('100::')) return true; // discard
  if (ip.startsWith('2001:db8:') || ip.startsWith('2001:0db8:')) return true; // docs

  return false;
}

async function assertPublicDns(hostname, lookupImpl) {
  let records;
  try {
    records = await lookupImpl(hostname, { all: true });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: 'unreachable' };
  }
  for (const rec of records) {
    if (isPrivateOrReservedIP(rec.address)) {
      return { ok: false, reason: 'invalid' };
    }
  }
  return { ok: true };
}

function isShopifyOwnHost(host) {
  const h = host.toLowerCase();
  return SHOPIFY_OWN_HOSTS.some((base) => h === base || h.endsWith(`.${base}`));
}

function extractAsyncLoadUrls(html) {
  if (!html) return [];
  const asyncIdx = html.search(/function\s+asyncLoad\s*\(|\basyncLoad\s*=/i);
  if (asyncIdx === -1) return [];

  const snippet = html.slice(asyncIdx, asyncIdx + 65536);
  const urlsMatch = snippet.match(/\burls\s*=\s*\[/);
  if (!urlsMatch || urlsMatch.index === undefined) return [];

  let i = urlsMatch.index + urlsMatch[0].length;
  const strings = [];
  let inQuote = '';
  let current = '';
  let escaped = false;

  for (; i < snippet.length; i++) {
    const ch = snippet[i];
    if (inQuote) {
      if (escaped) {
        current += ch === '/' ? '/' : `\\${ch}`;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inQuote) {
        strings.push(current);
        current = '';
        inQuote = '';
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ']') {
      break;
    }
  }

  const urls = [];
  for (const rawStr of strings) {
    const unescaped = rawStr
      .replace(/\\u0026/gi, '&')
      .replace(/\\u003d/gi, '=')
      .trim();
    if (!unescaped) continue;
    const normalized = unescaped.startsWith('//') ? `https:${unescaped}` : unescaped;
    try {
      const u = new URL(normalized);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        urls.push(u.href);
      }
    } catch {
      // Skip malformed entry
    }
  }
  return urls;
}

function hasShopifySignals(html, headers) {
  if (headers) {
    const shopId = headers.get?.('x-shopid');
    const powered = headers.get?.('x-powered-by') || '';
    if (shopId || /shopify/i.test(powered)) return true;
  }
  if (!html) return false;
  return (
    html.includes('cdn.shopify.com') ||
    html.includes('Shopify.shop') ||
    html.includes('Shopify.theme') ||
    html.includes('shopifycloud.com') ||
    html.includes('shopify-section')
  );
}

function isPasswordTemplate(html, finalUrl) {
  if (finalUrl && /^\/password(?:\/|$)/i.test(finalUrl.pathname)) {
    return true;
  }
  if (!html) return false;
  const hasPasswordForm =
    /action=["']\/password["']/i.test(html) ||
    /template-password/i.test(html) ||
    /shopify-section-main-password/i.test(html);
  const hasStorefrontPasswordInput =
    /<input[^>]+type=["']password["']/i.test(html) &&
    (/Enter using password|Store opening soon|password page/i.test(html) ||
      html.includes('cdn.shopify.com'));
  return hasPasswordForm || hasStorefrontPasswordInput;
}

async function readBodyLimited(response, maxBytes) {
  if (!response.body) {
    const text = await response.text();
    const buf = Buffer.from(text, 'utf8');
    return buf.subarray(0, maxBytes).toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength >= maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel error
        }
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function buildResponse({ status, store, items = [], note = RESULT_NOTE }) {
  const summary = { will_break: 0, action_needed: 0, safe: 0 };
  for (const item of items) {
    if (item.status === 'will_break') summary.will_break += 1;
    else if (item.status === 'action_needed') summary.action_needed += 1;
    else if (item.status === 'safe') summary.safe += 1;
  }
  return {
    status,
    store,
    checkedAt: new Date().toISOString(),
    summary,
    items,
    note
  };
}

export async function inspectStore(rawUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const lookupImpl = opts.lookupImpl || dns.lookup;
  const knownApps = opts.knownApps || loadKnownApps();
  const timeoutMs = opts.timeoutMs || FETCH_TIMEOUT_MS;

  const norm = normalizeStoreHostname(rawUrl);
  if (!norm.ok) {
    return buildResponse({ status: 'invalid', store: '' });
  }

  const initialHost = norm.hostname;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = new URL(`https://${initialHost}/`);
    let response = null;
    let redirects = 0;

    while (true) {
      if (currentUrl.protocol !== 'https:' || currentUrl.port !== '') {
        return buildResponse({ status: 'invalid', store: initialHost });
      }
      if (!isValidPublicHostname(currentUrl.hostname)) {
        return buildResponse({ status: 'invalid', store: initialHost });
      }

      const dnsCheck = await assertPublicDns(currentUrl.hostname, lookupImpl);
      if (!dnsCheck.ok) {
        return buildResponse({
          status: dnsCheck.reason === 'invalid' ? 'invalid' : 'unreachable',
          store: initialHost
        });
      }

      response = await fetchImpl(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
        }
      });

      if (response.status >= 300 && response.status < 400) {
        try {
          await response.body?.cancel?.();
        } catch {
          // Ignore body cancel
        }
        const location = response.headers.get('location');
        if (!location) {
          return buildResponse({ status: 'unreachable', store: initialHost });
        }
        redirects += 1;
        if (redirects > MAX_REDIRECTS) {
          return buildResponse({ status: 'unreachable', store: initialHost });
        }
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          return buildResponse({ status: 'invalid', store: initialHost });
        }
        if (
          nextUrl.protocol !== 'https:' ||
          nextUrl.port !== '' ||
          nextUrl.username ||
          nextUrl.password ||
          !isValidPublicHostname(nextUrl.hostname)
        ) {
          return buildResponse({ status: 'invalid', store: initialHost });
        }
        const nextDnsCheck = await assertPublicDns(nextUrl.hostname, lookupImpl);
        if (!nextDnsCheck.ok) {
          return buildResponse({
            status: nextDnsCheck.reason === 'invalid' ? 'invalid' : 'unreachable',
            store: initialHost
          });
        }
        if (/^\/password(?:\/|$)/i.test(nextUrl.pathname)) {
          return buildResponse({ status: 'password_protected', store: initialHost });
        }
        currentUrl = nextUrl;
        continue;
      }

      break;
    }

    const html = await readBodyLimited(response, MAX_HTML_BYTES);

    if (response.status === 401 || isPasswordTemplate(html, currentUrl)) {
      return buildResponse({ status: 'password_protected', store: initialHost });
    }

    if (!response.ok) {
      return buildResponse({ status: 'unreachable', store: initialHost });
    }

    if (!hasShopifySignals(html, response.headers)) {
      return buildResponse({ status: 'not_shopify', store: initialHost });
    }

    const scriptUrls = extractAsyncLoadUrls(html);
    const items = [];
    const seenKeys = new Set();
    const unknownDomains = new Set();

    for (const scriptUrl of scriptUrls) {
      let parsedScriptUrl;
      try {
        parsedScriptUrl = new URL(scriptUrl);
      } catch {
        continue;
      }
      const scriptHost = parsedScriptUrl.hostname.toLowerCase();
      if (!scriptHost || isShopifyOwnHost(scriptHost)) continue;

      const matched = findMostSpecificKnownApp(scriptHost, knownApps);

      if (matched) {
        const dedupeKey = `app:${matched.app.toLowerCase()}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        items.push({
          app: matched.app,
          category: matched.category,
          status: matched.status === 'action_needed' ? 'action_needed' : 'will_break',
          what_breaks: matched.what_breaks
        });
      } else {
        unknownDomains.add(scriptHost);
        const dedupeKey = `host:${scriptHost}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        const provider = detectGenericHostProvider(scriptHost);
        items.push({
          app: provider
            ? `Custom or app script hosted on ${provider}`
            : `Unknown app script (${scriptHost})`,
          category: 'other',
          status: 'will_break',
          what_breaks: "This script stops loading on March 1. We'll identify it in your fix plan."
        });
      }
    }

    const resObj = buildResponse({
      status: 'ok',
      store: initialHost,
      items
    });
    if (opts.includeUnknownDomains) {
      resObj.unknownDomains = Array.from(unknownDomains);
    }
    return resObj;
  } catch {
    return buildResponse({ status: 'unreachable', store: initialHost });
  } finally {
    clearTimeout(timer);
  }
}

export function hashIdentifier(value, salt = '') {
  return crypto.createHash('sha256').update(`${salt}:${value}`).digest('hex');
}

import { inspectStore, normalizeStoreHostname, hashIdentifier } from './lib/checker.mjs';
import { openBlobStore } from './lib/blobs.mjs';

const RATE_LIMIT_MAX = 20;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHEABLE_STATUSES = new Set(['ok', 'not_shopify', 'password_protected']);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function extractClientIp(req, context) {
  if (context && context.ip) return String(context.ip).trim();
  const nfIp = req.headers.get('x-nf-client-connection-ip');
  if (nfIp) return nfIp.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'anonymous';
}

export async function handleCheckStore(req, context, deps = {}) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      {
        status: 'invalid',
        store: '',
        checkedAt: new Date().toISOString(),
        summary: { will_break: 0, action_needed: 0, safe: 0 },
        items: [],
        note: 'Please enter a valid Shopify store domain, like yourstore.com.'
      },
      400
    );
  }

  const rawUrl = body && typeof body.url === 'string' ? body.url : '';
  const norm = normalizeStoreHostname(rawUrl);

  // Rate limit: max 20 checks per hour per hashed IP (never store raw IP)
  const rlStore = deps.rateLimitStore || openBlobStore('migration-rate-limits');
  const salt = process.env.CHECK_ADMIN_TOKEN || 'cartlight-rl-salt-v2';
  const ipHash = hashIdentifier(extractClientIp(req, context), salt).slice(0, 32);
  const hourBucket = new Date().toISOString().slice(0, 13).replace(/[:]/g, '-');
  const rlKey = `rl-${ipHash}-${hourBucket}`;

  try {
    const existing = await rlStore.get(rlKey, { type: 'json', consistency: 'strong' });
    const count = existing && typeof existing.count === 'number' ? existing.count : 0;
    if (count >= RATE_LIMIT_MAX) {
      return jsonResponse(
        {
          status: 'rate_limited',
          store: norm.ok ? norm.hostname : '',
          checkedAt: new Date().toISOString(),
          summary: { will_break: 0, action_needed: 0, safe: 0 },
          items: [],
          note: 'Please wait up to an hour and try again, or email hello@cartlightlabs.com for a manual check.'
        },
        429
      );
    }
    await rlStore.setJSON(rlKey, { count: count + 1, hour: hourBucket });
  } catch {
    // Do not block legitimate checks on transient rate-limit store error
  }

  if (!norm.ok) {
    return jsonResponse({
      status: 'invalid',
      store: '',
      checkedAt: new Date().toISOString(),
      summary: { will_break: 0, action_needed: 0, safe: 0 },
      items: [],
      note: 'Please enter a valid store address, like yourstore.com.'
    });
  }

  // 10-minute store cache
  const cacheStore = deps.cacheStore || openBlobStore('migration-cache');
  const cacheKey = `store-${hashIdentifier(norm.hostname, 'cache').slice(0, 40)}`;
  try {
    const cached = await cacheStore.get(cacheKey, { type: 'json' });
    if (
      cached &&
      typeof cached.cachedAtMs === 'number' &&
      Date.now() - cached.cachedAtMs < CACHE_TTL_MS &&
      cached.payload
    ) {
      return jsonResponse(cached.payload, 200);
    }
  } catch {
    // Ignore cache miss/read errors
  }

  const runCheck = deps.inspectStore || inspectStore;
  const result = await runCheck(norm.hostname, deps.checkerOpts);

  if (CACHEABLE_STATUSES.has(result.status)) {
    try {
      await cacheStore.setJSON(cacheKey, {
        cachedAtMs: Date.now(),
        payload: result
      });
    } catch {
      // Ignore cache write errors
    }
  }

  return jsonResponse(result, 200);
}

export default async (req, context) => handleCheckStore(req, context);


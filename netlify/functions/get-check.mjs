import { openBlobStore } from './lib/blobs.mjs';

const CODE_REGEX = /^[2-9A-HJ-NP-Z]{8}$/i;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

export async function handleGetCheck(req, _context, deps = {}) {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(req.url);
  const code = (url.searchParams.get('c') || '').trim().toUpperCase();
  if (!CODE_REGEX.test(code)) {
    return jsonResponse({ error: 'Check not found' }, 404);
  }

  let checksStore;
  try {
    checksStore = deps.checksStore || openBlobStore('migration-checks', { strict: true });
  } catch {
    return jsonResponse({ error: 'Checks store unavailable' }, 503);
  }

  const saved = await checksStore.get(`check-${code}`, { type: 'json' });
  if (!saved) {
    return jsonResponse({ error: 'Check not found' }, 404);
  }

  return jsonResponse(saved, 200);
}

export default async (req, context) => handleGetCheck(req, context);


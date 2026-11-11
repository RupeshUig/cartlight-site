import crypto from 'node:crypto';
import { inspectStore } from './lib/checker.mjs';
import { openBlobStore } from './lib/blobs.mjs';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateRandomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

export async function handleSaveCheck(req, _context, deps = {}) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const adminSecret = process.env.CHECK_ADMIN_TOKEN || '';
  if (!adminSecret) {
    return jsonResponse({ error: 'CHECK_ADMIN_TOKEN is not configured' }, 503);
  }

  const headerToken = req.headers.get('x-admin-token') || '';
  const authHeader = req.headers.get('authorization') || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const supplied = headerToken || bearerToken;

  if (!constantTimeEquals(supplied, adminSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const targetStore = body && (body.store || body.url);
  if (!targetStore || typeof targetStore !== 'string') {
    return jsonResponse({ error: 'Missing store field' }, 400);
  }

  const runCheck = deps.inspectStore || inspectStore;
  const result = await runCheck(targetStore, deps.checkerOpts);

  let checksStore;
  try {
    checksStore = deps.checksStore || openBlobStore('migration-checks', { strict: true });
  } catch {
    return jsonResponse(
      { error: 'Netlify Blobs unavailable. Link the site with netlify link before calling save-check.' },
      503
    );
  }

  let code = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateRandomCode();
    const exists = await checksStore.get(`check-${candidate}`);
    if (!exists) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return jsonResponse({ error: 'Could not allocate unique code' }, 500);
  }

  await checksStore.setJSON(`check-${code}`, result);

  return jsonResponse({
    code,
    status: result.status,
    store: result.store,
    summary: result.summary
  });
}

export default async (req, context) => handleSaveCheck(req, context);


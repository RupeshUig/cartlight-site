import { getStore } from '@netlify/blobs';

const fallbackStores = new Map();

function getMemoryStore(name) {
  if (!fallbackStores.has(name)) {
    fallbackStores.set(name, new Map());
  }
  const map = fallbackStores.get(name);
  return {
    async get(key, opts) {
      if (!map.has(key)) return null;
      const val = map.get(key);
      if (opts && opts.type === 'json') {
        return typeof val === 'string' ? JSON.parse(val) : val;
      }
      return typeof val === 'string' ? val : JSON.stringify(val);
    },
    async setJSON(key, data) {
      map.set(key, structuredClone(data));
    }
  };
}

/**
 * Opens a Netlify Blobs store, falling back to an in-memory map ONLY when
 * running outside a linked Netlify Blobs context (unless strict=true).
 */
export function openBlobStore(name, { strict = false } = {}) {
  try {
    return getStore(name);
  } catch (err) {
    if (!strict && err && err.name === 'MissingBlobsEnvironmentError') {
      return getMemoryStore(name);
    }
    throw err;
  }
}


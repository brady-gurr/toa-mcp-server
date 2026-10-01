// Thin wrapper around TOA's REST API (https://app.toa.energy/api/x).
// Docs: in the TOA app under Data Layer -> API.

const TOA_BASE_URL = process.env.TOA_BASE_URL || 'https://app.toa.energy/api/x';
const TOA_API_TOKEN = process.env.TOA_API_TOKEN;

if (!TOA_API_TOKEN) {
  // Don't crash at import time (keeps `node --check` / local poking around easy),
  // but every real call below will fail loudly without it.
  console.error('[toa-mcp-wrapper] Missing TOA_API_TOKEN env var — TOA API calls will fail.');
}

/**
 * Call the TOA API.
 * @param {string} path - e.g. "/projects" or "/work/123"
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {Record<string, string|number|boolean|undefined|null>} [opts.query]
 * @param {object} [opts.body]
 * @param {Record<string,string>} [opts.headers]
 */
export async function toaRequest(path, opts = {}) {
  const { method = 'GET', query, body, headers } = opts;

  const url = new URL(TOA_BASE_URL + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOA_API_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    const err = new Error(`TOA API ${method} ${path} -> ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return {
    data,
    hasMore: res.headers.get('x-has-more') === 'true',
    nextCursor: res.headers.get('x-next-cursor') || undefined
  };
}

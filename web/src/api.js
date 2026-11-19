// Thin fetch wrapper around the Private Hire REST API (/api/v1). The same contract serves the future mobile app.
const BASE = (import.meta.env.VITE_API_URL || '') + '/api/v1';
// ID-13: the session lives in an HttpOnly cookie set by the server, so this file never sees or stores a token.
// Every request carries X-PH-Client, which the server requires for cookie-authenticated changes (CSRF guard).

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || 'Request failed');
    this.status = status;
    this.code = payload?.error?.code || 'error';
    this.fields = payload?.error?.fields || {};
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

async function request(method, path, body, { auth = true, silent = false } = {}) {
  const headers = { Accept: 'application/json', 'X-PH-Client': 'web' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      credentials: auth ? 'include' : 'omit',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: 'Cannot reach the server. Check your connection.' } });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && auth && !silent) onUnauthorized(data?.error?.code);
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
  publicGet: (p) => request('GET', p, undefined, { auth: false }),
  /** GET that does not trigger the signed-out handler (used to check for a session on page load). */
  probe: (p) => request('GET', p, undefined, { silent: true }),
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  });
  const s = p.toString();
  return s ? `?${s}` : '';
};

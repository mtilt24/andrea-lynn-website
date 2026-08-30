/* Square API helper. Server-side only, never import this into page JS.

   Env vars (Vercel > Project > Settings > Environment Variables):
     SQUARE_ACCESS_TOKEN           Developer Console > your app > Credentials
     SQUARE_LOCATION_ID            Developer Console > Locations
     SQUARE_WEBHOOK_SIGNATURE_KEY  Developer Console > Webhooks > your subscription
     SQUARE_API_VERSION            optional, see below
     SQUARE_ENV                    optional, "sandbox" to hit the sandbox host

   SQUARE_API_VERSION pins the API version. Square shows the current one on the
   Developer Console credentials page; set the env var to that value rather
   than trusting the fallback here, which only moves when someone edits it. */

const crypto = require('crypto');

const DEFAULT_API_VERSION = '2025-01-23';

class ConfigError extends Error {}

function apiBase() {
  return process.env.SQUARE_ENV === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
}

async function squareFetch(path, { method = 'GET', body } = {}) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new ConfigError('Missing SQUARE_ACCESS_TOKEN');

  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Square-Version': process.env.SQUARE_API_VERSION || DEFAULT_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    /* Square returns an errors array with category and code. Log those rather
       than the whole payload, which echoes back the request. */
    const detail = (json.errors || []).map((e) => `${e.category}/${e.code}`).join('; ');
    console.error('Square API failed', method, path, res.status, detail,
      (json.errors || []).map((e) => e.detail || '').join('; '));
    /* Carry the category/code up so a caller can report WHY without digging
       through logs. Codes only, never the detail string, which can echo back
       parts of the request. */
    const err = new Error(`Square ${method} ${path} ${res.status}`);
    err.squareStatus = res.status;
    err.squareDetail = detail || `HTTP ${res.status}`;
    throw err;
  }
  return json;
}

/* Square signs the notification URL concatenated with the raw request body,
   HMAC-SHA256 under the subscription's signature key, base64 encoded.

   The RAW body is what matters. Re-serializing a parsed object changes key
   order and whitespace, and the signature then never matches. */
function verifySignature({ rawBody, signature, notificationUrl }) {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!key) throw new ConfigError('Missing SQUARE_WEBHOOK_SIGNATURE_KEY');

  const expected = crypto
    .createHmac('sha256', key)
    .update(notificationUrl + rawBody)
    .digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  /* timingSafeEqual throws on a length mismatch, so check length first. */
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Vercel's Node runtime fills req.body and consumes the stream, so webhook
   routes must switch body parsing off (see api/square-webhook.js) or there is
   nothing left to verify. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = { squareFetch, verifySignature, readRawBody, ConfigError };

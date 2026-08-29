/* Mailchimp API helper. Server-side only — never import this into page JS.

   Env vars (Vercel > Project > Settings > Environment Variables):
     MAILCHIMP_API_KEY      e.g. abc123...-us21
     MAILCHIMP_AUDIENCE_ID  Audience > Settings > Audience name and defaults

   The data-center prefix is read off the end of the API key, so there is no
   separate MAILCHIMP_SERVER_PREFIX variable to keep in sync.
*/

const crypto = require('crypto');

/* MD5 of the lowercased, trimmed email. Mailchimp addresses members by this. */
function subscriberHash(email) {
  return crypto.createHash('md5').update(String(email).trim().toLowerCase()).digest('hex');
}

function config() {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!apiKey || !audienceId) throw new ConfigError('Missing MAILCHIMP_API_KEY or MAILCHIMP_AUDIENCE_ID');
  const dc = apiKey.split('-')[1];
  if (!dc) throw new ConfigError('MAILCHIMP_API_KEY has no -usXX data-center suffix');
  return {
    base: `https://${dc}.api.mailchimp.com/3.0/lists/${audienceId}`,
    auth: 'Basic ' + Buffer.from(`anystring:${apiKey}`).toString('base64'),
  };
}

class ConfigError extends Error {}
class ComplianceError extends Error {}

/* Add or update a contact, set merge fields, then apply tags.
   Two calls on purpose: the tags array on the member body only applies when
   Mailchimp CREATES the contact. For anyone who already exists (a lead-magnet
   subscriber who later buys), the dedicated tags endpoint is the only thing
   that reliably adds a tag. */
async function syncContact({ email, mergeFields = {}, tags = [] }) {
  const { base, auth } = config();
  const hash = subscriberHash(email);
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };

  /* PUT upserts. status_if_new only applies to new contacts, so someone who
     previously unsubscribed is never silently re-subscribed. */
  const upsert = await fetch(`${base}/members/${hash}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      email_address: String(email).trim().toLowerCase(),
      status_if_new: 'subscribed',
      merge_fields: mergeFields,
    }),
  });

  if (!upsert.ok) {
    const detail = await upsert.json().catch(() => ({}));
    console.error('Mailchimp upsert failed', upsert.status, detail.title, detail.detail);
    /* Mailchimp refuses to re-add someone who unsubscribed or marked spam.
       They have to opt back in themselves. */
    if (upsert.status === 400 && /compliance/i.test(detail.title || '')) {
      throw new ComplianceError('previously unsubscribed');
    }
    throw new Error(`Mailchimp upsert ${upsert.status}`);
  }

  if (tags.length) {
    const res = await fetch(`${base}/members/${hash}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags: tags.map((name) => ({ name, status: 'active' })) }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      console.error('Mailchimp tag failed', res.status, detail.title, detail.detail);
      throw new Error(`Mailchimp tag ${res.status}`);
    }
  }

  return { ok: true };
}

/* MM/DD/YYYY. Mailchimp stores EVENTDATE blank if the format does not match
   how the field is configured, and a blank date means the "7 days before"
   reminder journeys silently never fire.

   Date-only strings are treated as a LOCAL calendar date. Passing
   "2026-09-27" to new Date() parses it as UTC midnight, which reads back as
   Sep 26 anywhere west of Greenwich — a gathering date one day early. */
function toEventDate(value) {
  if (typeof value === 'string') {
    const ymd = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) return `${ymd[2]}/${ymd[3]}/${ymd[1]}`;
    const mdy = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (mdy) return value.trim();   // already in the format Mailchimp wants
  }
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) throw new Error(`toEventDate: unparseable date ${value}`);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

module.exports = { syncContact, subscriberHash, toEventDate, ConfigError, ComplianceError };

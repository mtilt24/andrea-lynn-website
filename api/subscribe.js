/* Public opt-in endpoint. Every front-end form on the site posts here.

   The browser sends a `source`, never a tag. The tag is chosen server-side
   from the allowlist below, so a public form can never apply a purchase-only
   tag like hive-member no matter what someone posts at it.

   Tags must match the Mailchimp tags exactly (lowercase) — they are what
   trigger the already-built Customer Journeys. A typo silently creates a new
   unused tag rather than erroring.
*/

const { syncContact, ComplianceError, ConfigError } = require('../lib/mailchimp');

const PUBLIC_TAGS = {
  optin:    'lead-magnet', // dedicated opt-in / landing page
  homepage: 'lead-magnet', // homepage free-practice section
  popup:    'lead-magnet', // exit-intent popup
  footer:   'newsletter',  // footer newsletter signup
};

/* Best-effort rate limit. Serverless instances are per-region and recycle, so
   this throttles a naive flood rather than a determined attacker; the honeypot
   below catches most bots. Upgrade to a shared store if it ever matters. */
const HITS = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;  /* generous: a real person retrying a typo must never be locked out */

function rateLimited(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (!v.some((t) => now - t < WINDOW_MS)) HITS.delete(k);
  return hits.length > MAX_PER_WINDOW;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Bad request.' }); }
  }
  body = body || {};

  /* Honeypot: the field is hidden, so a real person always leaves it empty.
     Answer 200 so a bot cannot tell it was caught. */
  if (body.website) return res.status(200).json({ ok: true });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Please try again in a minute.' });

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const tag = PUBLIC_TAGS[body.source];
  if (!tag) return res.status(400).json({ error: 'Bad request.' });

  const firstName = String(body.firstName || '').trim().slice(0, 80);

  try {
    /* Only send FNAME when we actually collected one. Sending an empty string
       would overwrite a name we already have on an existing contact, and the
       footer form (email only) posts through here too. */
    const mergeFields = firstName ? { FNAME: firstName } : {};
    await syncContact({ email, mergeFields, tags: [tag] });
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('Mailchimp not configured:', err.message);
      return res.status(500).json({ error: 'Signup is not configured yet.' });
    }
    if (err instanceof ComplianceError) {
      return res.status(400).json({
        error: 'This email was previously unsubscribed. Please email andrea@andrealynncoaching.com and she will get you signed up.',
      });
    }
    console.error('subscribe failed', err);
    return res.status(502).json({ error: 'We could not save your details. Please try again.' });
  }
};

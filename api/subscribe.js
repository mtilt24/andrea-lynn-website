/* Mailchimp subscribe endpoint.
   Adds (or updates) a contact in the audience and applies a Pending tag.

   The tags here are deliberately Pending only. This runs when the form is
   submitted, which is before the person reaches Square, so anyone who
   abandons checkout would otherwise sit in the audience tagged as a paid
   member and keep receiving member email. Payment is confirmed separately by
   the Square by Mailchimp integration, which syncs orders in as store data.
   The welcome Journeys start on "Buys a specific product" from that store,
   never on these tags. A Pending tag only means someone started the form.

   Env vars (set in Vercel > Project > Settings > Environment Variables):
     MAILCHIMP_API_KEY     e.g. abc123...-us21   (the -usXX suffix picks the server)
     MAILCHIMP_AUDIENCE_ID e.g. a1b2c3d4e5       (Audience > Settings > Audience name and defaults)
*/

const crypto = require('crypto');

/* Only these tags are accepted, so a stray request can't invent audience tags.
   Must stay in sync with PAY_LINKS in hive.html. */
const ALLOWED_TAGS = ['Hive Member Pending', 'Hive Drop-In Pending'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    console.error('Missing MAILCHIMP_API_KEY or MAILCHIMP_AUDIENCE_ID');
    return res.status(500).json({ error: 'Signup is not configured yet.' });
  }

  const dc = apiKey.split('-')[1];
  if (!dc) return res.status(500).json({ error: 'Signup is not configured yet.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Bad request.' }); }
  }
  body = body || {};

  /* Honeypot: real people leave this hidden field empty. Pretend it worked. */
  if (body.website) return res.status(200).json({ ok: true });

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const tag = ALLOWED_TAGS.includes(body.tag) ? body.tag : null;
  if (!tag) return res.status(400).json({ error: 'Bad request.' });

  const firstName = String(body.firstName || '').trim().slice(0, 80);
  const lastName = String(body.lastName || '').trim().slice(0, 80);
  const phone = String(body.phone || '').trim().slice(0, 40);

  const hash = crypto.createHash('md5').update(email).digest('hex');
  const base = `https://${dc}.api.mailchimp.com/3.0/lists/${audienceId}/members/${hash}`;
  const auth = 'Basic ' + Buffer.from(`anystring:${apiKey}`).toString('base64');

  const mergeFields = {};
  if (firstName) mergeFields.FNAME = firstName;
  if (lastName) mergeFields.LNAME = lastName;
  if (phone) mergeFields.PHONE = phone;

  try {
    /* PUT upserts: new contacts subscribe, existing ones keep their current
       status so we never re-subscribe someone who opted out. */
    const upsert = await fetch(base, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email_address: email,
        status_if_new: 'subscribed',
        merge_fields: mergeFields,
      }),
    });

    if (!upsert.ok) {
      const detail = await upsert.json().catch(() => ({}));
      console.error('Mailchimp upsert failed', upsert.status, detail.title, detail.detail);
      /* Someone who previously unsubscribed has to opt back in themselves. */
      if (upsert.status === 400 && /compliance/i.test(detail.title || '')) {
        return res.status(400).json({
          error: 'This email was previously unsubscribed. Please email andrea@andrealynncoaching.com and she will get you signed up.',
        });
      }
      return res.status(502).json({ error: 'We could not save your details. Please try again.' });
    }

    /* Tag is a separate call in the Mailchimp API. It auto-creates by name. */
    const tagRes = await fetch(`${base}/tags`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [{ name: tag, status: 'active' }] }),
    });

    if (!tagRes.ok) {
      const detail = await tagRes.json().catch(() => ({}));
      console.error('Mailchimp tag failed', tagRes.status, detail.title, detail.detail);
      /* Contact is saved; the tag is what drives the welcome email, so surface it. */
      return res.status(502).json({ error: 'We saved your email but hit a snag. Please email andrea@andrealynncoaching.com.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Mailchimp request threw', err);
    return res.status(502).json({ error: 'We could not save your details. Please try again.' });
  }
};

/* Turns a "Save my spot" click into a Square-hosted checkout page.

   Why this exists instead of four checkout links made in the Square Dashboard:
   a Dashboard link carries nothing that says WHICH gathering was bought, so a
   completed payment can never be mapped back to a date. Creating the link here
   lets us stamp the date into the order metadata, and that metadata is what
   comes back on the webhook and fills EVENTDATE / EVENTWHEN / EVENTLOC.

   It also means a new gathering never needs anything done in Square. Add the
   date to lib/gatherings.js and to the visible list on hive.html.

   Tagging still happens only on the webhook, never here. Someone who reaches
   this route has not paid yet, and the previous design tagged people before
   they got to Square, which left everyone who abandoned checkout sitting in
   the audience as a paid member.
*/

const crypto = require('crypto');
const { squareFetch, ConfigError } = require('../lib/square');
const G = require('../lib/gatherings');

const SITE = process.env.SITE_ORIGIN || 'https://www.andrealynncoaching.com';

/* The shared Dashboard link every gathering used before this route existed.
   Kept as a fallback: a buyer who cannot pay at all is a worse outcome than a
   buyer we cannot tag afterwards. */
const FALLBACK_CHECKOUT =
  'https://checkout.square.site/merchant/V4G801A2GN8BN/checkout/6DCZAWHIKKQMKLVCB5LF24TF';

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const date = String((req.query && req.query.d) || '').trim();

  /* Not on the schedule means someone edited the URL. Send them to the page
     rather than minting a checkout for a gathering that does not exist. */
  if (!G.isGathering(date)) {
    res.writeHead(302, { Location: `${SITE}/hive#gatherings` });
    return res.end();
  }

  const when = G.describe(date);

  try {
    const result = await squareFetch('/v2/online-checkout/payment-links', {
      method: 'POST',
      body: {
        idempotency_key: crypto.randomUUID(),
        /* A full order rather than quick_pay, because only an order carries
           the metadata the webhook reads back. */
        order: {
          location_id: requiredLocation(),
          line_items: [{
            name: `${G.NAME} · ${when}`,
            quantity: '1',
            base_price_money: { amount: G.PRICE_CENTS, currency: 'USD' },
          }],
          metadata: { gathering: date },
        },
        checkout_options: {
          allow_tipping: false,
          ask_for_shipping_address: false,
          redirect_url: `${SITE}/hive?booked=${encodeURIComponent(date)}`,
        },
        description: `${G.NAME}, ${when}, ${G.LOCATION}`,
      },
    });

    const url = result.payment_link && (result.payment_link.long_url || result.payment_link.url);
    if (!url) throw new Error('Square returned no payment link URL');

    /* 302 not 301: the link is one-time, nothing should cache it. */
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    return res.end();
  } catch (err) {
    if (err instanceof ConfigError) console.error('Square not configured:', err.message);
    else console.error('hive-checkout failed', err);
    res.writeHead(302, { Location: FALLBACK_CHECKOUT, 'Cache-Control': 'no-store' });
    return res.end();
  }
};

function requiredLocation() {
  const id = process.env.SQUARE_LOCATION_ID;
  if (!id) throw new ConfigError('Missing SQUARE_LOCATION_ID');
  return id;
}

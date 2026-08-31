/* Turns a "Join The Hive" click into a Square-hosted subscription checkout.

   Same shape as api/hive-checkout.js, and for the same reason: minting the
   link here lets us stamp the order so the webhook can tag the buyer. The
   difference is that Square owns the recurring billing once they subscribe, so
   this route only ever creates the FIRST charge.

   There is no fallback link. Unlike gatherings, no membership checkout URL
   exists in the dashboard, so if Square is unreachable the honest outcome is
   to send them back to the page rather than somewhere that cannot take money.
*/

const crypto = require('crypto');
const { squareFetch, ConfigError } = require('../lib/square');
const M = require('../lib/membership');

const SITE = process.env.SITE_ORIGIN || 'https://www.andrealynncoaching.com';

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const planVariationId = await M.variationId();

    const result = await squareFetch('/v2/online-checkout/payment-links', {
      method: 'POST',
      body: {
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: requiredLocation(),
          line_items: [{
            name: M.NAME,
            quantity: '1',
            base_price_money: { amount: M.PRICE_CENTS, currency: 'USD' },
          }],
          /* Only reaches the first order. Renewals are matched on the plan
             variation instead, see lib/membership.js. */
          metadata: { membership: 'hive' },
        },
        checkout_options: {
          allow_tipping: false,
          ask_for_shipping_address: false,
          subscription_plan_id: planVariationId,
          redirect_url: `${SITE}/hive?joined=1`,
        },
        description: `${M.NAME}, $55/month, Auburn, California`,
      },
    });

    const url = result.payment_link && (result.payment_link.long_url || result.payment_link.url);
    if (!url) throw new Error('Square returned no payment link URL');

    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    return res.end();
  } catch (err) {
    const reason = err instanceof ConfigError
      ? err.message
      : (err.squareDetail || err.message || 'unknown');
    console.error('hive-membership failed', err);
    res.writeHead(302, {
      Location: `${SITE}/hive#membership`,
      'Cache-Control': 'no-store',
      'X-Membership-Fallback': String(reason).replace(/[^\x20-\x7e]/g, '').slice(0, 120),
    });
    return res.end();
  }
};

function requiredLocation() {
  const id = process.env.SQUARE_LOCATION_ID;
  if (!id) throw new ConfigError('Missing SQUARE_LOCATION_ID');
  return id;
}

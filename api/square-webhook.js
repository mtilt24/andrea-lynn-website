/* Square calls this when a payment changes state. A COMPLETED gathering
   payment tags the buyer hive-gathering and fills the merge fields the
   "7 days before" reminder journey needs.

   This is the only place a purchase tag is ever applied. Everything upstream
   of Square is an intention, not a payment.

   Body parsing has to stay off: the signature covers the RAW bytes, and
   Vercel's Node runtime otherwise consumes the stream to build req.body.
*/

const { squareFetch, verifySignature, readRawBody, ConfigError } = require('../lib/square');
const { syncContact, toEventDate, ComplianceError } = require('../lib/mailchimp');
const G = require('../lib/gatherings');
const M = require('../lib/membership');

module.exports.config = { api: { bodyParser: false } };

const NOTIFICATION_URL =
  process.env.SQUARE_NOTIFICATION_URL ||
  'https://www.andrealynncoaching.com/api/square-webhook';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('square-webhook could not read body', err);
    return res.status(400).json({ error: 'Bad request' });
  }

  if (!rawBody) {
    /* Almost always means body parsing is still on and something upstream
       drained the stream. Verification cannot succeed from here. */
    console.error('square-webhook got an empty raw body; is bodyParser still enabled?');
    return res.status(400).json({ error: 'Bad request' });
  }

  try {
    const ok = verifySignature({
      rawBody,
      signature: req.headers['x-square-hmacsha256-signature'],
      notificationUrl: NOTIFICATION_URL,
    });
    if (!ok) {
      console.error('square-webhook rejected a bad signature');
      return res.status(401).json({ error: 'Bad signature' });
    }
  } catch (err) {
    console.error('Square not configured:', err.message);
    return res.status(500).json({ error: 'Not configured' });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Bad request' }); }

  /* Anything that is not a completed payment is acknowledged and dropped.
     A non-200 makes Square retry, so only real failures get one. */
  const payment = event && event.data && event.data.object && event.data.object.payment;
  if (event.type !== 'payment.updated' || !payment || payment.status !== 'COMPLETED') {
    return res.status(200).json({ ok: true, ignored: true });
  }

  try {
    const order = payment.order_id
      ? (await squareFetch(`/v2/orders/${encodeURIComponent(payment.order_id)}`)).order
      : null;

    const date = order && order.metadata && order.metadata.gathering;
    const isGathering = G.isGathering(date);
    /* Only ask Square about the plan when it is not already a gathering. */
    const isMembership = !isGathering && await M.isMembershipOrder(order);

    if (!isGathering && !isMembership) {
      /* A payment through the old shared Dashboard link, or anything else sold
         through this Square account, matches neither. Nothing to tag, and
         guessing a date would fire the wrong reminder. */
      console.log('square-webhook: payment matched no product, skipping', payment.id);
      return res.status(200).json({ ok: true, ignored: true });
    }

    const { email, firstName } = await buyer(payment, order);
    if (!email) {
      console.error('square-webhook: no buyer email on payment', payment.id);
      return res.status(200).json({ ok: true, ignored: true });
    }

    /* The EVENT* fields are gathering-specific. A membership charge leaves them
       alone rather than blanking them, since a member who also bought a
       drop-in still needs their reminder to fire. */
    const mergeFields = firstName ? { FNAME: firstName } : {};
    if (isGathering) {
      mergeFields.EVENTDATE = toEventDate(date);
      mergeFields.EVENTWHEN = G.describe(date);
      mergeFields.EVENTLOC = G.LOCATION;
    }

    /* Two tags for a gathering, on purpose.

       hive-gathering is permanent: the segment of everyone who has ever
       booked. gathering-booked is transient, and the welcome journey removes
       it as its last step so the next purchase can re-add it.

       Without the transient one a repeat buyer gets nothing. Mailchimp fires
       "tag added" only on absent -> present, and re-applying a tag that is
       already active is a silent no-op, so a second booking would update the
       EVENT* fields and send no email. */
    const tags = isGathering
      ? ['hive-gathering', 'gathering-booked']
      : ['hive-member'];

    await syncContact({ email, mergeFields, tags });

    console.log('square-webhook: tagged', tags.join('+'), isGathering ? date : 'membership', payment.id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof ComplianceError) {
      /* They unsubscribed at some point and Mailchimp refuses to re-add them.
         Retrying will never work, so acknowledge and move on. */
      console.error('square-webhook: buyer previously unsubscribed, not tagged', payment.id);
      return res.status(200).json({ ok: true, ignored: true });
    }
    if (err instanceof ConfigError) {
      console.error('square-webhook not configured:', err.message);
      return res.status(500).json({ error: 'Not configured' });
    }
    /* 500 so Square retries. syncContact is idempotent, so a replay is safe. */
    console.error('square-webhook failed', err);
    return res.status(500).json({ error: 'Failed' });
  }
};

/* Square puts the buyer's email in different places depending on how the
   checkout was completed, so try each in turn before giving up. */
async function buyer(payment, order) {
  const fromFulfillment = (order && order.fulfillments || [])
    .map((f) => (f.pickup_details || f.shipment_details || f.delivery_details || {}).recipient)
    .find((r) => r && r.email_address);

  let email = payment.buyer_email_address
    || (fromFulfillment && fromFulfillment.email_address)
    || null;
  let displayName = fromFulfillment && fromFulfillment.display_name;

  const customerId = payment.customer_id || (order && order.customer_id);
  if ((!email || !displayName) && customerId) {
    try {
      const { customer } = await squareFetch(`/v2/customers/${encodeURIComponent(customerId)}`);
      if (customer) {
        email = email || customer.email_address || null;
        displayName = displayName || [customer.given_name, customer.family_name].filter(Boolean).join(' ');
      }
    } catch (err) {
      /* A missing customer record is not worth failing the whole webhook. */
      console.error('square-webhook: customer lookup failed', err.message);
    }
  }

  return {
    email: email ? String(email).trim().toLowerCase() : null,
    /* Mailchimp's FNAME is a first name, and Square hands back a full name. */
    firstName: displayName ? String(displayName).trim().split(/\s+/)[0].slice(0, 80) : null,
  };
}

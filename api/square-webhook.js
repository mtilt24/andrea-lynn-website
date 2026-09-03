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

  /* Square delivers a membership charge and a gathering charge as different
     event types, which is why this handles three.

     A one-off payment (a gathering) fires payment.created then
     payment.updated. A subscription is billed through an INVOICE, and the
     first charge fires invoice.payment_made with no payment.* event to match,
     which is why the first membership signup tagged nobody.

     payment.created is accepted alongside payment.updated because the status
     check below is what actually gates this, not the event name. Both firing
     for one payment is harmless: syncContact is idempotent. */
  let payment = null;
  let invoice = null;

  if (event.type === 'payment.updated' || event.type === 'payment.created') {
    payment = event.data && event.data.object && event.data.object.payment;
    if (!payment || payment.status !== 'COMPLETED') {
      return res.status(200).json({ ok: true, ignored: true });
    }
  } else if (event.type === 'invoice.payment_made') {
    invoice = event.data && event.data.object && event.data.object.invoice;
    if (!invoice) return res.status(200).json({ ok: true, ignored: true });
  } else {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const ref = (payment && payment.id) || (invoice && invoice.id) || 'unknown';

  try {
    const orderId = (payment && payment.order_id) || (invoice && invoice.order_id);
    const order = orderId
      ? (await squareFetch(`/v2/orders/${encodeURIComponent(orderId)}`)).order
      : null;

    const date = order && order.metadata && order.metadata.gathering;
    const isGathering = G.isGathering(date);

    /* An invoice carrying a subscription_id IS a membership charge, first or
       renewal. That is more reliable than matching the plan variation on the
       order, so it is checked first. */
    const isMembership = !isGathering && (
      Boolean(invoice && invoice.subscription_id) || await M.isMembershipOrder(order)
    );

    if (!isGathering && !isMembership) {
      /* A payment through the old shared Dashboard link, or anything else sold
         through this Square account, matches neither. Nothing to tag, and
         guessing a date would fire the wrong reminder. */
      console.log('square-webhook: payment matched no product, skipping', ref);
      return res.status(200).json({ ok: true, ignored: true });
    }

    const { email, firstName } = await buyer(payment, order, invoice);
    if (!email) {
      console.error('square-webhook: no buyer email on', ref);
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

    /* Both products get a permanent tag plus a transient one, on purpose.

       Permanent (hive-gathering, hive-member) is the standing segment: who has
       ever booked, who is a member now. The rolling monthly sends filter on it.
       Transient (gathering-booked, hive-new) exists only while the welcome
       journey runs, and that journey removes it as its final step.

       The transient tag is what triggers the welcome, because Mailchimp fires
       "tag added" only on absent -> present and re-applying a live tag is a
       silent no-op. Trigger off the permanent tag instead and a repeat buyer,
       or someone who cancels and later rejoins, gets nothing.

       It is also the lever the permanent tag cannot give: "hive-member AND NOT
       hive-new" is every member past onboarding, so someone who joins in the
       middle of October need not also take the October content mid-welcome.

       hive-new is gated on the FIRST charge. A membership renews every month
       and every renewal comes back through here, so adding hive-new each time
       would re-fire the welcome monthly. order.metadata.membership is written
       by api/hive-membership.js on the checkout that starts the subscription,
       and Square builds renewal orders from the plan rather than cloning that
       first one, so the stamp only ever rides the first charge. That is the
       same reason lib/membership.js needs its plan-variation fallback to
       recognise a renewal at all. */
    const isFirstMembershipCharge =
      Boolean(order && order.metadata && order.metadata.membership === 'hive');

    const tags = isGathering
      ? ['hive-gathering', 'gathering-booked']
      : isFirstMembershipCharge
        ? ['hive-member', 'hive-new']
        : ['hive-member'];

    await syncContact({ email, mergeFields, tags });

    console.log('square-webhook: tagged', tags.join('+'), isGathering ? date : 'membership', ref);
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof ComplianceError) {
      /* They unsubscribed at some point and Mailchimp refuses to re-add them.
         Retrying will never work, so acknowledge and move on. */
      console.error('square-webhook: buyer previously unsubscribed, not tagged', ref);
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
async function buyer(payment, order, invoice) {
  const recipient = invoice && invoice.primary_recipient;
  const fromFulfillment = (order && order.fulfillments || [])
    .map((f) => (f.pickup_details || f.shipment_details || f.delivery_details || {}).recipient)
    .find((r) => r && r.email_address);

  let email = (payment && payment.buyer_email_address)
    || (recipient && recipient.email_address)
    || (fromFulfillment && fromFulfillment.email_address)
    || null;
  let displayName = (fromFulfillment && fromFulfillment.display_name)
    || (recipient && [recipient.given_name, recipient.family_name].filter(Boolean).join(' '))
    || null;

  const customerId = (payment && payment.customer_id)
    || (invoice && invoice.primary_recipient && invoice.primary_recipient.customer_id)
    || (order && order.customer_id);
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

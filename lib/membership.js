/* The Hive Collective monthly membership, $55/month.

   Square bills this as a subscription, so unlike a gathering we do not build
   the recurring charges ourselves. Square generates each month's order, which
   is why the metadata trick used for gatherings only covers the FIRST payment.
   Renewals are recognised by the plan variation on the order line item
   instead, which is why RESOLVED_VARIATION matters below.

   SQUARE_MEMBERSHIP_PLAN_ID is the catalog object Michelle created under
   Payments > Subscriptions > Subscription Plans. Square's Checkout API wants
   the plan VARIATION id, not the plan id, so this resolves one to the other
   and remembers the answer. */

const { squareFetch } = require('./square');

const PLAN_ID = () => process.env.SQUARE_MEMBERSHIP_PLAN_ID || 'AYNPMPRO7KG4PB25VPT4EGGP';

const NAME = 'The Hive Collective Membership';
const PRICE_CENTS = 5500;

/* Resolved once per warm instance. A cold start pays one extra Square call,
   which is cheaper than making Michelle hunt for a second id in the dashboard
   and keep it in sync with the first. */
let cached = null;

async function variationId() {
  if (cached) return cached;

  const id = PLAN_ID();
  const res = await squareFetch(
    `/v2/catalog/object/${encodeURIComponent(id)}?include_related_objects=true`
  );

  const obj = res.object;
  if (!obj) throw new Error(`membership: catalog object ${id} not found`);

  /* Michelle may have handed over either id, so accept both rather than
     assuming which one the dashboard URL exposed. */
  if (obj.type === 'SUBSCRIPTION_PLAN_VARIATION') {
    cached = obj.id;
    return cached;
  }

  if (obj.type === 'SUBSCRIPTION_PLAN') {
    const fromPlan = (obj.subscription_plan_data
      && obj.subscription_plan_data.subscription_plan_variations) || [];
    const fromRelated = (res.related_objects || [])
      .filter((o) => o.type === 'SUBSCRIPTION_PLAN_VARIATION');
    const variation = fromPlan[0] || fromRelated[0];
    if (!variation) throw new Error(`membership: plan ${id} has no variation`);
    cached = variation.id;
    return cached;
  }

  throw new Error(`membership: ${id} is a ${obj.type}, not a subscription plan`);
}

/* True when this order is a membership charge: the stamp we write on the first
   checkout, or the plan variation on any renewal Square generates. */
async function isMembershipOrder(order) {
  if (!order) return false;
  if (order.metadata && order.metadata.membership === 'hive') return true;

  const ids = (order.line_items || [])
    .map((li) => li.catalog_object_id)
    .filter(Boolean);
  if (!ids.length) return false;

  try {
    return ids.includes(await variationId());
  } catch (err) {
    console.error('membership: could not resolve variation', err.message);
    return false;
  }
}

module.exports = { NAME, PRICE_CENTS, PLAN_ID, variationId, isMembershipOrder };

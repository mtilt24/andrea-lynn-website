/* The Hive gathering schedule. Single source of truth for which dates can be
   paid for, and for how each one is written into Mailchimp.

   Two things read this: api/hive-checkout.js (is this a real gathering, and
   what should the Square line item say) and api/square-webhook.js (what goes
   into EVENTDATE / EVENTWHEN / EVENTLOC). The visible list on hive.html is
   separate markup, so adding a gathering means adding it in BOTH places.

   The allowlist is the security boundary. Without it anyone could hand
   /api/hive-checkout an arbitrary date and mint a Square checkout page for a
   gathering that does not exist. */

const DATES = [
  '2026-09-27',
  '2026-10-25',
  '2026-11-22',
  '2026-12-27',
];

const NAME = 'The Hive Gathering';
const TIME = '2–4 PM';
const LOCATION = 'East Wind Yoga · 922 Lincoln Way, Auburn, CA';

/* $22 drop-in. Square is not the source of truth here, because the checkout
   page is created per gathering rather than pulled from a catalog item, so
   this has to stay in step with the price shown on hive.html. */
const PRICE_CENTS = 2200;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday'];

function isGathering(date) {
  return DATES.includes(String(date || '').trim());
}

/* "Sunday, September 27 · 2–4 PM", built from the string parts.
   Deliberately never round-trips through a local Date: new Date('2026-09-27')
   is UTC midnight, which reads back as Sep 26 in California and would put
   every reminder a day early. Date.UTC plus getUTCDay is safe because both
   halves stay in UTC. */
function describe(date) {
  const m = String(date).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`describe: expected YYYY-MM-DD, got ${date}`);
  const [, y, mo, d] = m.map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS[mo - 1]} ${d} · ${TIME}`;
}

module.exports = { DATES, NAME, TIME, LOCATION, PRICE_CENTS, isGathering, describe };

# Mailchimp integration

Website → Mailchimp data flow. The Customer Journeys themselves are built in
Mailchimp; this code only creates/updates contacts, sets merge fields, and
applies the tags that trigger those journeys.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `MAILCHIMP_API_KEY` | Server-side only. The `-usXX` suffix is the data center, so there is no separate server-prefix variable. |
| `MAILCHIMP_AUDIENCE_ID` | Audience → Settings → Audience name and defaults → Audience ID |

One audience for everyone. Never expose the key to the browser.

## What is wired

| Capture point | `source` | Tag applied | Fields |
|---|---|---|---|
| `/free-practice` landing page (2 forms) | `optin` | `lead-magnet` | first name + email |
| Homepage free-practice section (`#free-practice`) | `homepage` | `lead-magnet` | first name + email |
| Exit-intent popup (site-wide) | `popup` | `lead-magnet` | first name + email |
| Footer newsletter (every page) | `footer` | `newsletter` | email only |

All four post to `POST /api/subscribe`. The browser sends a `source`, never a
tag: the endpoint maps source → tag from a server-side allowlist, so a public
form can never apply a purchase-only tag. An unknown or missing source is a
400 and tags nobody.

`/vitality-awakening` is the delivery page the lead-magnet journey links to.
It is noindexed and carries `data-no-popup`, since its visitors already
subscribed.

## Files

- `lib/mailchimp.js` — `syncContact()`, `subscriberHash()`, `toEventDate()`
- `api/subscribe.js` — the public endpoint, with the source→tag allowlist
- `assets/signup.js` — wires every `<form data-signup="SOURCE">`, runs the popup
- `assets/signup.css` — form and popup styling

## Why two API calls per sync

`syncContact()` does a `PUT` on the member (upsert + merge fields), then a
separate `POST` to the member's `/tags`. The `tags` array on the member body
only applies when Mailchimp *creates* the contact. For anyone who already
exists — a lead-magnet subscriber who later buys — the tags endpoint is the
only thing that reliably adds a tag.

`status_if_new` means an existing contact keeps their current status, so
someone who unsubscribed is never silently re-subscribed. Mailchimp rejects
re-adding them with a compliance error, which the endpoint turns into a
message pointing them at Andrea.

## EVENTDATE format

`EVENTDATE` must reach Mailchimp as `MM/DD/YYYY`. Any other format is stored
blank, and a blank date means the "7 days before" reminder journeys silently
never fire. Use `toEventDate()` — do not format dates by hand.

It deliberately treats a date-only string as a **local** calendar date.
`new Date('2026-09-27')` parses as UTC midnight, which reads back as Sep 26 in
US timezones and would put every gathering reminder a day early.

`EVENTDATE` (machine date) and `EVENTWHEN` (display text) are separate values
and a gathering purchase must send both.

## Popup rules

Never on page load. Desktop: exit intent. Mobile: 40 seconds or 50% scroll,
whichever is first. Shown once per visitor (30 days); a dismissal counts as a
show. Anyone who has signed up is never shown it again. Flags live in
localStorage (`al_popup_seen`, `al_subscribed`) and every access is wrapped in
try/catch, since private mode throws.

Add `data-no-popup` to a page's `<body>` to suppress it there.

## Before launch

1. **Check the audience opt-in setting.** Tag-triggered journeys only send to
   *subscribed* contacts. If the audience uses double opt-in, new contacts are
   created `pending` and get nothing until they confirm, which breaks instant
   lead-magnet delivery. Single opt-in is what this code assumes
   (`status_if_new: 'subscribed'`).
2. **Set a default value on `FNAME`** (e.g. `friend`) in Mailchimp. The footer
   form collects email only, so the newsletter welcome needs a fallback. The
   endpoint deliberately omits `FNAME` rather than sending `""`, so an existing
   contact's real name is never overwritten by a footer signup.
3. Confirm the six tags exist exactly as spelled, all lowercase:
   `lead-magnet`, `newsletter`, `hive-gathering`, `gathering-booked`,
   `hive-member`, `hive-new`. A typo silently creates a new unused tag rather
   than erroring, and the journey never fires.

## Square purchase tagging

A completed gathering payment tags the buyer `hive-gathering` and fills
`EVENTDATE`, `EVENTWHEN`, and `EVENTLOC`, which is what the "7 days before"
reminder journey needs.

The flow:

1. `hive.html` "Save my spot" points at `/api/hive-checkout?d=YYYY-MM-DD`.
2. `api/hive-checkout.js` checks the date against `lib/gatherings.js`, asks
   Square for a payment link with `metadata.gathering` set to that date, and
   302s the buyer to the Square-hosted page.
3. Square calls `api/square-webhook.js`. It verifies the
   signature, fetches the order, reads `metadata.gathering`, and syncs.

Links are created per click rather than kept in the Square Dashboard, because
a Dashboard link carries nothing that says which gathering was bought. It also
means a new gathering needs nothing done in Square.

### Adding a gathering

The date lives in **four** places, all in this repo:

1. `lib/gatherings.js` `DATES`, the allowlist. Without it the checkout route
   refuses the date.
2. The `.date-row` list in `hive.html`, the visible schedule and its CTA.
3. The footer date list in `hive.html`.
4. The schema.org `Event` JSON-LD in the `<head>` of `hive.html`, which is what
   Google reads for event rich results.

`PRICE_CENTS` in `lib/gatherings.js` is the drop-in price and has to stay in
step with the `$22` shown on `hive.html`. Square is not the source of truth
for it, because the line item is built here rather than pulled from a catalog.

### Two tags per purchase, and why

Every purchase applies **two** tags, one permanent and one transient.

| Purchase | Permanent | Transient |
|---|---|---|
| Gathering | `hive-gathering` | `gathering-booked` |
| Membership | `hive-member` | `hive-new` |

- The **permanent** tag is the standing segment: everyone who has ever booked,
  everyone who is a member. The rolling monthly sends filter on it.
- The **transient** tag exists only while the welcome journey runs. That
  journey must remove it as its final step.

Mailchimp fires a "tag added" trigger only when a tag goes from absent to
present. Re-applying a tag that is already active is a silent no-op. So with
one tag, a repeat buyer's second booking updates the `EVENT*` fields and sends
no email at all, which looks exactly like a broken integration and is not one.

Each welcome journey must therefore be set up as:

1. Trigger: the **transient** tag added (`gathering-booked`, or `hive-new`)
2. Allow contacts to re-enter the journey (off by default)
3. Final step: remove that same transient tag

**The rolling monthly sends target plain `hive-member`, with no exclusion.**
Decided 2026-09-03: someone who joins in the middle of October should still get
the October content, on top of their welcome sequence.

`hive-new` is a **subset** of `hive-member` — the first charge applies both
together, so it never exists on its own. A rolling send addressed to
`hive-member` therefore already includes everyone still in onboarding, and
adding `hive-new` to the target would select the identical set.

That leaves `hive-new` doing exactly one job: triggering the welcome journey.
Should the two ever need separating, `hive-member` AND NOT `hive-new` is every
member past onboarding, which the permanent tag alone cannot express. That
segment is available and deliberately unused.

#### `hive-new` fires on the first charge only

A membership renews every month and **every renewal comes back through the
webhook**. Adding `hive-new` on each one would re-add it after the journey
removed it and send the welcome again, monthly.

The gate is `order.metadata.membership === 'hive'`, which
`api/hive-membership.js` stamps on the checkout that starts the subscription.
Square builds renewal orders from the plan rather than cloning that first
order, so the stamp only ever rides the first charge. That is the same reason
`lib/membership.js` needs its plan-variation fallback to recognise a renewal at
all: a renewal order carries none of our metadata.

A renewal therefore re-applies `hive-member` and nothing else, which is a
silent no-op in Mailchimp and exactly what is wanted.

Someone who cancels and later rejoins goes back through
`/api/hive-membership`, so they get a fresh stamp and a fresh `hive-new`, and
the welcome runs again. `hive-member` is already on them and stays put.

### Which webhook events to subscribe to

**Three**, and all three are needed:

- `payment.updated`
- `payment.created`
- `invoice.payment_made`

A one-off purchase (a gathering) fires the `payment.*` events. **A subscription
is billed through an invoice and fires no `payment.*` event at all**, only
`invoice.payment_made`. That is why the first real membership signup took the
money and created an active subscription in Square while tagging nobody: the
only subscribed event was `payment.updated`, and Square's delivery log showed
no attempt, because it never sent one.

`payment.created` is safe to accept because the handler gates on
`status === 'COMPLETED'`, not on the event name. Both payment events firing for
a single payment is harmless: `syncContact()` is idempotent.

A membership charge is identified by `invoice.subscription_id` being present,
which covers the first charge and every renewal. The plan-variation match in
`lib/membership.js` is the fallback for an order that arrives without it.

### Why the tag is only applied on the webhook

Never tag anyone before they reach Square. That was the original design and it
was removed on purpose: everyone who abandoned checkout sat in the audience
tagged as a paid member.

### Gotchas

- **Raw body.** The signature covers the notification URL concatenated with the
  raw request bytes. `api/square-webhook.js` sets `bodyParser: false` and reads
  the stream itself. Re-serializing parsed JSON changes key order and the
  signature never matches.
- **`SQUARE_NOTIFICATION_URL` must match the subscription exactly**, including
  scheme and `www`. It is hashed, so a mismatch fails every request.
- **Signature key is per subscription.** Sandbox and production have different
  ones.
- A payment through the old shared Dashboard link has no gathering metadata.
  It is acknowledged and skipped rather than guessed at, since a wrong date
  fires the wrong reminder.
- Square retries on a non-200. `syncContact()` is idempotent, so a replay is
  safe.

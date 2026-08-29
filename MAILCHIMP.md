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
3. Confirm the four tags exist exactly as spelled, all lowercase:
   `lead-magnet`, `newsletter`, `hive-gathering`, `hive-member`. A typo silently
   creates a new unused tag rather than erroring, and the journey never fires.

## Not built: purchase tagging

`hive-gathering` and `hive-member` are **not wired**, because there is nothing
to wire them into. Hive checkout is a plain link out to a Square-hosted page
(`checkout.square.site/...`), so the buyer leaves the site entirely and this
app never learns that a purchase happened. There is no success handler to add
a call to.

Closing that needs a Square webhook: a Square Developer app, `orders.created` /
`payment.updated` subscribed to an `/api/square-webhook` route, signature
verification, and reading the buyer's email plus the gathering off the order.
That needs credentials and Square Dashboard access.

Note also that all four gathering dates currently point at the *same* Square
checkout link, so an order cannot be mapped back to a specific gathering. Each
gathering needs its own Square product before `EVENTDATE` / `EVENTWHEN` /
`EVENTLOC` can be filled in per purchase (§8 of the brief).

Do not fall back to tagging people *before* they reach Square. That was the
previous design and it was removed on purpose: anyone who abandoned checkout
sat in the audience tagged as a paid member.

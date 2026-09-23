# Vaskekjeller

Booking for the shared laundry room: washers and dryers are booked separately per time slot, with an optional
comment ("trenger bare 30 min"), a waitlist with web push notifications, and a small admin page.

Runs on Cloudflare Workers + D1. Server-rendered with Hono JSX; works without JavaScript except for
notifications and the comment dialog.

## How it works

- **Residents** pick their apartment number once per device (cookie). The honor system is the same as the
  spreadsheet: you can only cancel bookings made under your own apartment number, but nothing proves who you are.
  Admins can set a list of valid apartment numbers and an optional shared resident password.
- **Waitlist**: on a booked slot, tap "Venteliste". When the booking is cancelled, everyone on that slot's
  waitlist gets a push notification. First to book wins.
- **Push** needs the resident to tap "Slå på varsler". On iPhone this only works after "Legg til på Hjem-skjerm".
- **Admin** (`/<slug>/admin`): schedule (start, end, slot length), how many days ahead you can book, max active
  bookings per apartment, machines, access passwords, upcoming bookings, and stats.
- **Stats** are privacy friendly: only daily totals are stored. Unique visitors are counted with a salted hash that
  rotates every day and is deleted by a daily cron.
- **Multi-tenant**: every table has `tenant_id`; each building lives under `/<slug>`. `DEFAULT_TENANT` makes `/`
  redirect to one of them.

## Local development

```sh
npm install
node scripts/gen-vapid.ts --dev-vars      # writes .dev.vars (secrets); add DEFAULT_TENANT=demo to it
npm run db:migrate:local
node scripts/create-tenant.ts --slug demo --name "Borettslaget"   # prompts for admin password
npm run dev                                # also applies any new migrations first
npm run typecheck
```

## Deploy

```sh
npx wrangler login
npx wrangler deploy                        # first deploy provisions the D1 database automatically
npm run db:migrate:remote
node scripts/gen-vapid.ts                  # then:
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put SESSION_SECRET     # any long random string
node scripts/create-tenant.ts --slug <slug> --name "<navn>" --remote
```

Set `DEFAULT_TENANT` and `VAPID_SUBJECT` (a `mailto:` address push services can contact) in `wrangler.jsonc`.
Don't rotate the VAPID keys after launch: existing push subscriptions stop working.

To keep the app alive after you move out, add a second Cloudflare account member (or transfer the account),
and hand over the admin password.

## Reservation integrity

The booking endpoint accepts a washer/dryer pair as one atomic reservation. The active-booking limit
counts distinct time periods per apartment, so reserving both machines at the same time counts once.
Migration `0002_booking_overlap.sql` also prevents overlaps after an administrator changes the schedule.
Apply migrations before deploying this version.

## Verification

`npm run typecheck` checks server, client, scripts, and service-worker types.
`npm test` runs the real Hono booking routes against isolated SQLite (Node 22.13+), covering paired
reservations, atomic conflicts, household limits, ownership, comments, cancellation, and schedule overlaps.

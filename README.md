# Vaskekjeller

Booking for the shared laundry room: reserve a washer and dryer together in one tap, or select a single
machine. Includes optional comments, a waitlist with web push notifications, and a small admin page.

Runs on Cloudflare Workers + D1. Server-rendered with Hono JSX and in-place navigation and form updates.
Booking, cancellation, comments, and waitlists also work without JavaScript; push notifications require it.

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

Deploys are GitOps via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), Cloudflare's
own Git integration: every push to `main` builds and deploys to production. That includes quick fixes pushed
straight to `main`, which skip CI; everything else goes through a PR, where CI runs typecheck and tests.

Each build runs `npm ci`, then:

```sh
npx wrangler d1 migrations apply vaskekjeller --remote && npx wrangler deploy
```

Migrations run first, and the deploy only happens if they succeed, so the app never runs against an outdated
database. A failed migration leaves the previous version live. `wrangler deploy` runs the `build` hook in
`wrangler.jsonc`, which compiles `client/*.ts` into `public/`. Write migrations so the currently deployed
version keeps working until the new one is live.

Preview builds for branches and PRs are off: they would share the live database.

One-time dashboard setup (connecting the repo, build token permissions, creating the first building) is in
[docs/deploy.md](docs/deploy.md).

### Configuration

- `vars` in `wrangler.jsonc`: `VAPID_SUBJECT` (a `mailto:` address push services can contact) and
  `DEFAULT_TENANT` (where `/` redirects; empty means no redirect).
- Secrets live only in Cloudflare, never in git: `SESSION_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
  They are already set. Don't rotate the VAPID keys: existing push subscriptions stop working. To set one
  again, use `npx wrangler secret put NAME`, which prompts for the value without echoing it.
- New building: `node scripts/create-tenant.ts --slug <slug> --name "<navn>" --remote` (prompts for the admin
  password).

The production D1 database `vaskekjeller` is created with EU jurisdiction
(`wrangler d1 create vaskekjeller --jurisdiction eu`) and pinned by `database_id` in `wrangler.jsonc`, so deploy
does not auto-provision one. A database's jurisdiction can't be changed later; to recreate it, keep `--jurisdiction eu`.

`npm run deploy` does the same migrate-then-deploy from your machine (after `npx wrangler login`), for when
Workers Builds is unavailable.

To keep the app alive after you move out, add a second Cloudflare account member (or transfer the account),
and hand over the admin password.

## Resident booking experience

The default selection reserves one washer and one dryer together in a single atomic write.
Residents select a day, then tap **Reserver**; comments are added afterward under **Dine tider**.
A confirmation shows the date, time, and machines with an immediate **Angre** action.
Machine-only reservations, partial availability, and waitlists remain available.

The date strip shows Monday-to-Sunday weeks and opens on today. It reaches back 14 days and forward to the
booking horizon. Past days are read-only: each slot shows who had each machine and any comment, including
machines deactivated since then. Cancelled bookings are not shown.

Date/machine navigation and resident forms update in place with JavaScript. URLs, browser back/forward,
keyboard focus, and server-side validation are preserved. Without JavaScript, the same links and forms
work as ordinary page requests. Notification setup appears after joining a waitlist.

The active-booking limit counts distinct time periods per apartment, so reserving both machines at the
same time counts once. Migration `0002_booking_overlap.sql` also prevents overlaps with existing
reservations after an administrator changes the schedule. Apply migrations before deploying this version.

## Verification

`npm run typecheck` checks server, client, scripts, and service-worker types.
`npm test` runs the real Hono booking routes against isolated SQLite (Node 22.13+), covering paired
reservations, atomic conflicts, household limits, ownership, comments, cancellation, schedule overlaps, the
calendar-week date strip, and the read-only past-day view.
CI (`.github/workflows/ci.yml`) runs both on every pull request and push to `main`.

## License

MIT, see [LICENSE](LICENSE).

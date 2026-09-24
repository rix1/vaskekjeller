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
  The holder sees how many are waiting under "Dine tider"; adding or changing their comment pushes it to
  everyone waiting (clearing it sends nothing, and edits replace the previous notification and alert again).
- **Messages**: under "Se detaljer" on someone else's booking, "Send melding" pushes a ready-made question (plus an
  optional 140-character note) to the holder's devices. It is only offered when the holder has notifications on.
  The holder answers by updating their comment; the sender is put on that slot's waitlist to hear it, and can leave it
  again right after sending. For 2 hours after a slot ends, only "Du har glemt klær i maskinen" can be sent, without
  the waitlist. At most 3 messages per apartment and 10 in total per booking; only those counts are stored, never
  the text.
- **Push** needs the resident to tap "Slå på varsler". On iPhone this only works after "Legg til på Hjem-skjerm".
- **Calendar**: the apartment popover on the header chip has a secret feed link for Apple Calendar
  (`/<slug>/cal/<token>.ics`, subscribed via `webcal://`). It lists the apartment's own bookings (busy) and,
  with "Inkluder andres bookinger", everyone else's as free "Opptatt" events. The setting is saved on the link,
  so an existing subscription follows it. The feed needs no resident password, asks for a refresh every 15
  minutes, and covers 14 days back to the booking horizon. "Lag ny lenke" replaces the token; the old link
  returns 404. Setting, changing or removing the resident password retires every link the same way, and each
  apartment gets a new one in the popover. Google Calendar refreshes subscriptions only every several hours,
  so only Apple is offered.
- **Admin** (`/<slug>/admin`): schedule (start, end, slot length), how many days ahead you can book, max active
  bookings per apartment, machines, access passwords, upcoming bookings, and stats. Settings are split into
  cards with a table of contents; "add" actions and password changes open in a dialog (centered on desktop,
  a bottom drawer on phones) that falls back to an in-page `#anchor` target without JavaScript.
- **Passwords**: the resident password is a shared door code. It is verified against a PBKDF2 hash (which
  resident cookies are bound to) and also stored AES-GCM encrypted with a key derived from `SESSION_SECRET`,
  so admins can view and copy it. Rotating `SESSION_SECRET` makes it unreadable until an admin sets a new one.
  The admin password is only ever hashed.
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

Each build installs dependencies, then runs `npm run deploy` (defined in `package.json`), which applies pending
D1 migrations to the remote database and then runs `wrangler deploy`. Migrations run first, and the deploy only
happens if they succeed, so the app never runs against an outdated database. A failed migration leaves the
previous version live. `wrangler deploy` runs the `build` hook in `wrangler.jsonc`, which compiles `client/*.ts`
into `public/`. Write migrations so the currently deployed version keeps working until the new one is live.
`CI=true` makes the migration step skip wrangler's confirmation prompt, so `npm run deploy` behaves the same from
your machine (after `npx wrangler login`) as in Workers Builds; use it when Workers Builds is unavailable.

Previews are off because they would share the live database: preview builds for branches and PRs are disabled in
the dashboard, and per-version preview URLs by `"preview_urls": false` in `wrangler.jsonc`.

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

To keep the app alive after you move out, add a second Cloudflare account member (or transfer the account),
and hand over the admin password.

## Resident booking experience

The default selection reserves one washer and one dryer together in a single atomic write.
Residents select a day, then tap **Reserver**; comments are added afterward under **Dine tider**.
A confirmation toast shows the date, time, and machines with an **Angre** action for about 8 seconds
(paused while hovered or focused). Other status messages are toasts too: success toasts close after about
4 seconds, errors stay until closed. Without JavaScript the same toasts are server-rendered and the timed ones
fade out with CSS.
Machine-only reservations, partial availability, and waitlists remain available.
In the paired view a partly taken slot shows who holds each machine and offers the free machine in one tap,
behind a small in-place confirmation; the day strip reads "Delvis" when only single machines are left and
marks a fully booked day. The "Ett trykk reserverer" hint disappears after a device's first booking (`vk_booked` cookie).

The date strip shows Monday-to-Sunday weeks and opens on today. It reaches back 14 days and forward to the
booking horizon. Past days are read-only: each slot shows who had each machine and any comment, including
machines deactivated since then. Cancelled bookings are not shown.

Date/machine navigation and resident forms update in place with JavaScript. URLs, browser back/forward,
keyboard focus, and server-side validation are preserved. Without JavaScript, the same links and forms
work as ordinary page requests. Notification setup appears after joining a waitlist.

The active-booking limit counts distinct time periods per apartment, so reserving both machines at the
same time counts once. Migration `0002_booking_overlap.sql` also prevents overlaps with existing
reservations after an administrator changes the schedule. Migration `0003_resident_password_readable.sql`
adds the encrypted resident password column.

## Verification

`npm run typecheck` checks server, client, scripts, and service-worker types.
`npm test` runs the real Hono booking routes against isolated SQLite (Node 22.13+), covering paired
reservations, atomic conflicts, household limits, ownership, comments, cancellation, schedule overlaps, the
calendar-week date strip, the read-only past-day view, apartment selection, waitlist counts and comment
pushes, the board's partly free rows, day-strip status, and first-booking hint cookie, the server-rendered
toasts (Angre confirmation, errors), the calendar feed (`tests/calendar-feed.test.mjs`), messages to booking
holders (`tests/push-messages.test.mjs`), the admin settings, machine, and password routes, and the settings
table of contents and inline machine updates in `client/admin.ts` against a simulated page. It also compiles
the service worker and runs it as a classic script, since `/sw.js` is registered without `{ type: "module" }`.
CI (`.github/workflows/ci.yml`) runs both on every pull request and push to `main`.

## License

MIT, see [LICENSE](LICENSE).

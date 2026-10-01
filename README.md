# Vaskekjeller

Booking for the shared laundry room: reserve a washer and dryer together in one tap, or select a single
machine. Includes optional comments, a waitlist with web push notifications, and a small admin page.

Runs on Cloudflare Workers + D1. Server-rendered with Hono JSX and in-place navigation and form updates.
Booking, cancellation, comments, and waitlists also work without JavaScript; push notifications require it.

## How it works

- **Residents** pick their apartment number once per device (cookie). The honor system is the same as the
  spreadsheet: you can only cancel bookings made under your own apartment number, but nothing proves who you are.
  Admins can set a list of valid apartment numbers and an optional shared resident password.
- **Waitlist**: on a booked slot, tap "Venteliste" (a bottom sheet on phones), then "Si fra når den blir ledig",
  which joins every machine of that row in one tap. When the booking is cancelled, everyone on that slot's
  waitlist gets a push notification. First to book wins.
  The holder sees how many are waiting in their expanded reservation row; adding or changing their comment pushes it to
  everyone waiting (clearing it sends nothing, and edits replace the previous notification and alert again).
  When another household taps "Venteliste" on a holder's slot, the holder gets "Noen venter på tiden din" (or
  "N venter …", counting every machine in the reservation), linking to that day and machine. Joining again, or
  waiting on your own or a free slot, sends nothing; each new household replaces the previous notification.
  Sending a message also joins the waitlist but sends no extra push, since the message already reaches the holder.
- **Messages**: in the "Venteliste" sheet on someone else's booking, "Send melding" pushes a ready-made question (plus an
  optional 140-character note) to the holder's devices. It is only offered when the holder has notifications on.
  The holder answers by updating their comment; the sender is put on that slot's waitlist to hear it, and can leave it
  again right after sending. For 2 hours after a slot ends, only "Du har glemt klær i maskinen" can be sent, without
  the waitlist. At most 3 messages per apartment and 10 in total per booking; only those counts are stored, never
  the text.
- **Push** needs the resident to tap "Slå på varsler". On iPhone this only works after "Legg til på Hjem-skjerm".
- **Resident onboarding** (`/<slug>/velkommen`, the link in the admins' share message): apartment, then a
  Home Screen guide for the device (iPhone Safari, in-app browsers such as Messenger, Android with Chrome's own
  install prompt; left out on desktop and when opened from the icon), then "Slå på varsler" (left out where
  notifications aren't supported). Steps that don't apply are hidden, not shown disabled. The password and
  apartment steps come back to it via `?til=velkommen`. Each building has its own manifest
  (`/<slug>/manifest.webmanifest`, `start_url` = the board, open past the password gate), so the icon opens
  that building; `public/apple-touch-icon.png` is the iPhone icon. On the board, notifications are offered where they have a reason (below), not on first load.
  The device checks are in `setupPush` in `client/app.ts`, shared by the guide, the ask and the header menu row.
- **First-use tips** (`client/tour.ts`, anchors are `data-tour` attributes in `src/views.tsx`): small coach marks, one
  at a time and at most one per page view, no backdrop, the target stays tappable. Tip 1 sits on the first free
  "Reserver" for a device that has never booked (no `vk_booked` cookie, `main[data-tips="new"]`); tip 2 on the
  resident's own booking once a booking exists and no toast is showing; tip 3 on the machine choices in a later
  session. Marks wait while a toast, popover, soft keyboard or hidden tab is up, and stay clear of the bottom edge.
  "Skjønner" or using the control marks one seen, "Ikke vis flere tips" turns them all off, Escape closes one.
  A device that has booked before when it first loads the board gets no tour. State is one `localStorage` key,
  `vk-tips` (`seen`, `shown`, `off`, `askOff`, `last`), shared by every building on the origin, with memory and
  `sessionStorage` as fallback; nothing is stored on the server. The header apartment menu has a "Varsler" row (on/off,
  the way back after dismissing) and a "Tips" row that restarts the tips. The notification ask ("Slå på", or "Vis meg
  hvordan" on iPhone Safari) sits under the reservations in "Dine tider" once there is one; its × is kept in the same
  key (a closed old card, `vk-nudge-dismissed`, pre-closes it). Marks need JavaScript; the ask and menu rows too.
- **Calendar**: "Legg i kalender" downloads one reservation as a single-event `.ics`
  (`GET /<slug>/event.ics?booking_ids=1,2`, built by `buildEvent` in `src/calendar.ts`). It sits below the schedule right
  after booking and in each of your own reservation rows. The event has the machines, the comment and a link back to that day;
  it is a copy, not a subscription, so a later cancellation does not change it. The route is behind the resident password
  and only serves the apartment's own bookings.
- **Admin** (`/<slug>/admin`): schedule (start, end, slot length), how many days ahead you can book, max active
  bookings per apartment, machines, access passwords, upcoming bookings, and stats. Settings are split into
  cards with a table of contents; "add" actions and password changes open in a dialog (centered on desktop,
  a bottom drawer on phones) that falls back to an in-page `#anchor` target without JavaScript.
- **Push test** (`/<slug>/admin/debug`, linked from the admin overview): an admin-only page for checking on a phone
  that notifications arrive. It runs as the apartment chosen on the booking page on that device, shows whether the
  device has notifications on for that apartment (and can turn them on), and has two tests that go through the
  real cancel and waitlist code: "En tid blir ledig" (the test household `TEST (varsler)` books a free slot, you
  join its waitlist, and it cancels) and "Noen venter på tiden din" (you book a free slot with the comment
  "Test av varsler – slettes ved opprydding", and the test household joins its waitlist). The page reports how
  many devices got the push, and how many had expired or failed. The test household can never be a real
  apartment, since real numbers are stored without spaces. Test 1 cleans up right away; test 2 is left until
  "Rydd opp" (or the next test), which deletes the test household's rows and your booking with that comment. If that
  booking hasn't ended, it is cancelled first like any other, so a neighbour who joined its waitlist meanwhile is told
  it's free. It touches this building only (`src/debug-push.tsx`).
- **Activity log**: the "Aktivitet" section of the admin settings lists admin changes, newest first, in a
  scrollable box: resident and admin passwords turned on, changed or off; schedule and rule changes as
  before → after (e.g. "Lengde per tid: 120 → 90 min"); machines added, changed, moved or switched off;
  bookings an admin cancelled; the building closed or reopened. Residents' own bookings are not logged.
  Everyone shares one admin login, so each entry records only a coarse device label such as
  "iPhone · Safari" (derived in `src/audit.ts`), never the IP address or the raw User-Agent. Entries are
  deleted by the daily cron after 12 months.
- **Closing a building**: "Steng og slett" at the bottom of the Tilgang section needs the building's name
  typed to confirm. The booking page, every resident route then answer
  410 with "Denne vaskekjelleren er stengt". Admin login still works and shows only "Stengt – slettes
  permanent <dato>" with "Gjenåpne" and "Slett permanent nå" (which needs the name again). The daily cron
  deletes a building 7 days after it was closed. Deleting removes the tenant row; every table cascades
  from it except `visitor_hashes`, which is deleted explicitly. A new table with a `tenant_id` needs
  `REFERENCES tenants(id) ON DELETE CASCADE` or an explicit delete in `deleteTenant` (`src/index.tsx`).
- **Passwords**: the resident password is a shared door code. It is verified against a PBKDF2 hash (which
  resident cookies are bound to) and also stored AES-GCM encrypted with a key derived from `SESSION_SECRET`,
  so admins can view and copy it. Rotating `SESSION_SECRET` makes it unreadable until an admin sets a new one.
  The admin password is only ever hashed. The resident password is a 4-digit PIN (four-box input in signup, settings
  and login, centered, with a "Generer en kode" link under the boxes); buildings from before PINs keep their free-text password until an admin sets a
  PIN (`tenants.access_pin`). Resident login is rate limited in D1 (`login_attempts`): 5 tries per 15 minutes per
  building and network, 40 per hour per building, counted with salted hashes (`src/pin.ts`).
- **Stats** are privacy friendly: only daily totals are stored. Unique visitors are counted with a salted hash that
  rotates every day and is deleted by a daily cron.
- **Multi-tenant**: every table has `tenant_id`; each building lives under `/<slug>`.
- **Landing page** (`/`): what this is, a live preview, "Prøv demoen" and "Opprett vaskekjeller" (`/ny`), plus a hint
  to use the link from the board. Opening a building sets a root cookie `vk_last` (the slug only), so the landing
  page shows "Gå til <navn> →" for the last building used on the device while it exists and is not closed.
- **About page** (`/om`, `src/about.tsx`): a shared, Norwegian-only FAQ linked from the landing page footer and every
  building's footer: getting started, when each notification fires, adding a reservation to the calendar, and what data is
  stored and for how long. Its contact address is hjelp@vaskekjeller.no. `om` is in signup's `RESERVED_SLUGS`, and
  the route is registered before `/:slug`. Keep its copy in step with the behavior it describes.
- **Demo buildings** (`src/demo.ts`): `/visning` is a read-only showcase (tenant flag `read_only`: every write route
  answers 403 and the board hides its actions), seen as apartment B2 and shown in the landing page's phone frame
  through a non-interactive iframe (`?embed=1` drops the banner and footer). `/demo` is the playground behind
  "Prøv demoen": anyone can book and cancel, but apartments come from a list and comments and messages are limited
  to ready-made choices (tenant flag `presets_only`, enforced by the routes). Both are created on first visit and
  reset by the nightly cron with a month of bookings, comments and waitlists placed around today; their admin pages
  can't be logged in to, and the unused-building cleanup never closes them. Neither offers notifications: a browser
  has one push subscription for the whole site, so `/push/subscribe` refuses a demo rather than take it from a real
  building. Both slugs are in signup's `RESERVED_SLUGS`. Pages may only be framed by the site itself
  (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`).
- **Signup** (`/ny`): anyone can create a building in eight steps: name, web address, admin password, opening
  hours and slot length, machines (one washer and one dryer to start with), an optional resident password, the
  recovery code, and ready-made messages to share. The address is made from the name (æ→ae, ø→o, å→a), checked
  live against taken and reserved words (`RESERVED_SLUGS` in `src/signup.ts`), and can be edited. The first three
  steps are plain GET forms; the building is created by the third, which is guarded by a managed Cloudflare
  Turnstile check and a limit of 3 buildings per network per day. The limit counts a salted, daily-rotating hash
  of the IPv4 address or IPv6 /64, never the address itself. The later steps are admin pages under
  `/<slug>/admin/kom-i-gang`.
- **Search engines** (`src/seo.tsx`): only `/`, `/om` and `/ny` are indexable. They get their own Norwegian title
  and description, a canonical URL on https://www.vaskekjeller.no, Open Graph and Twitter card tags with
  `public/share.png` (1200×630, a screenshot of the landing page), and the landing page has `WebApplication`
  JSON-LD. Every other page the Worker serves (buildings, admin, onboarding, later signup steps, `/visning`,
  `/demo`) is noindex twice: an `X-Robots-Tag: noindex` header and a robots meta tag. The Worker serves
  `/robots.txt`, which blocks nothing so crawlers can see the noindex, and `/sitemap.xml` with the three public
  pages. A new public page needs an entry in `PUBLIC_PAGES` and a `seo` prop on its `Layout`.
- **Recovery code**: there is no email, so the only way to reset a forgotten admin password is the recovery code
  shown once at the end of signup (copy or download it). Only its SHA-256 hash is stored. It resets the password at
  `/<slug>/admin/nullstill` (linked from the admin login) and is then replaced by a new one; admins can also make a
  new one under Innstillinger → Tilgang. A freshly made code rides along for an hour in an encrypted, httpOnly
  cookie, so the page showing it survives a reload. Making a new code and resetting the password are logged in the
  activity log.
- **Unused buildings**: a building created through `/ny` that has no bookings 30 days after signup is closed by the
  daily cron, through the same 7-day close-and-delete grace period as closing it by hand (logged in the activity
  log). This happens at most once: a building its admin reopens is left alone.

## Local development

```sh
npm install
node scripts/gen-vapid.ts --dev-vars      # writes .dev.vars (secrets)
npm run db:migrate:local
node scripts/create-tenant.ts --slug hjem --name "Borettslaget"   # prompts for admin password
npm run dev                                # also applies any new migrations first
npm run typecheck
```

Local D1 data lives under `.wrangler/state`, keyed by the `database_id` in `wrangler.jsonc`. Pinning that id to the
EU database gave local dev a fresh, empty D1 file, so buildings created locally before that change no longer show up.
Recreate them with `node scripts/create-tenant.ts` (after `npm run db:migrate:local`).

Open `/visning` or `/demo` locally to create the demo buildings; run `wrangler dev --test-scheduled` and open
`/__scheduled` to trigger the nightly reset.

## Deploy

Deploys are GitOps via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), Cloudflare's
own Git integration: every push to `main` builds and deploys to production. That includes quick fixes pushed
straight to `main`, which skip CI; everything else goes through a PR, where CI runs typecheck and tests.

Each build installs dependencies, then runs `npm run deploy` (defined in `package.json`), which applies pending
D1 migrations to the remote database and then runs `wrangler deploy`. Migrations run first, and the deploy only
happens if they succeed, so the app never runs against an outdated database. A failed migration leaves the
previous version live. `wrangler deploy` runs the `build` hook in `wrangler.jsonc`, which compiles `client/*.ts`
into `public/` (and bundles the toaster with esbuild). Write migrations so the currently deployed version keeps working until the new one is live.
`CI=true` makes the migration step skip wrangler's confirmation prompt, so `npm run deploy` behaves the same from
your machine (after `npx wrangler login`) as in Workers Builds; use it when Workers Builds is unavailable.

Previews are off because they would share the live database: preview builds for branches and PRs are disabled in
the dashboard, and per-version preview URLs by `"preview_urls": false` in `wrangler.jsonc`.

### Domain

The app is served only at `https://www.vaskekjeller.no/<slug>` (for example `/lofotgata`); the `*.workers.dev`
address is off. The `routes` entry with `"custom_domain": true` in `wrangler.jsonc` makes each deploy
create and own the `www` DNS record and its certificate, so the zone must have no other `A`, `AAAA` or `CNAME`
record on `www`: never add one by hand, and delete any imported from the previous DNS host. The bare domain
`vaskekjeller.no` redirects to www via a Cloudflare Redirect Rule, not the app; see
[docs/deploy.md](docs/deploy.md#domain). All links the app builds are relative, so nothing depends on the host.

One-time dashboard setup (connecting the repo, build token permissions, creating the first building) is in
[docs/deploy.md](docs/deploy.md).

### Configuration

- `vars` in `wrangler.jsonc`: `VAPID_SUBJECT` (a `mailto:` address push services can contact,
  `mailto:hjelp@vaskekjeller.no`) and
  `TURNSTILE_SITE_KEY` (the public key of the signup bot check).
- Secrets live only in Cloudflare, never in git: `SESSION_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
  (already set) and `TURNSTILE_SECRET_KEY`. Signup at `/ny` stays closed until both Turnstile keys are set; the
  steps are in [docs/deploy.md](docs/deploy.md#turn-on-signup-turnstile). Don't rotate the VAPID keys: existing
  push subscriptions stop working. To set one again, use `npx wrangler secret put NAME`, which prompts for the
  value without echoing it.
- New building: through `/ny`, or `node scripts/create-tenant.ts --slug <slug> --name "<navn>" --remote` (prompts
  for the admin password; such a building has no recovery code until an admin makes one).

The production D1 database `vaskekjeller` is created with EU jurisdiction
(`wrangler d1 create vaskekjeller --jurisdiction eu`) and pinned by `database_id` in `wrangler.jsonc`, so deploy
does not auto-provision one. A database's jurisdiction can't be changed later; to recreate it, keep `--jurisdiction eu`.

To keep the app alive after you move out, add a second Cloudflare account member (or transfer the account),
and hand over the admin password.

## Resident booking experience

The default selection reserves one washer and one dryer together in a single atomic write.
Residents select a day, then tap **Reserver**; comments are added afterward by expanding their own reservation.
Tapping your own "Din tid" row in the slot list expands it in place with **Legg i kalender**, **Kommentar** and
**Avbestill** (real buttons, at least 44px tall). **Dine tider** lists the same reservations as compact one-line rows
(machine icons, time, chevron to expand the same actions) and is hidden while the resident has no bookings. When
someone is waiting, the note says so once, in the expanded row (`tests/compact-dine-tider.test.mjs`). A link to
`#reservation-<id>` opens the row, also for the second booking of a paired reservation (`openTargetRow` in `client/app.ts`).
Toasts are [Sonner](https://sonner.emilkowal.ski/) (bundled into `public/toaster.js` by `scripts/build-toaster.ts`,
loaded on the first toast), so they stack and pause on hover. A confirmation toast shows the date, time, and
machines with a quiet **Angre** action and a thin line that runs out with its timer, about 5 seconds. Other
status messages are toasts too: success toasts close after about 4 seconds, errors stay until closed. Without
JavaScript the same toasts are server-rendered and the timed ones fade out with CSS.
Machine-only reservations, partial availability, and waitlists remain available.
Cancelling is a two-step confirm in place ("Avbestill", then "Ja, avbestill" or "Nei") that says the slot becomes
free and how many neighbours on its waitlist are told.
In the paired view a partly taken slot shows who holds each machine and offers the free machine in one tap,
behind a small in-place confirmation; the day strip reads "Delvis" when only single machines are left and
marks a fully booked day. The first-use tips (see Resident onboarding) are skipped for devices that have booked (`vk_booked` cookie).

The date strip shows Monday-to-Sunday weeks and opens on today. It reaches back 14 days and forward to the
booking horizon. Past days are read-only: each slot shows who had each machine and any comment, including
machines deactivated since then. Cancelled bookings are not shown.
On phones the days keep a 64px minimum width, and when the week does not fit it scrolls sideways with snap
points. The strip opens scrolled to the selected day (Sunday: fully right) on page load
(`tests/day-strip-scroll.test.mjs`) and after in-page date changes.

Date/machine navigation and resident forms update in place with JavaScript. URLs, browser back/forward,
keyboard focus, and server-side validation are preserved. Without JavaScript, the same links and forms
work as ordinary page requests. Notification setup appears after joining a waitlist.

The board refreshes itself because a Home Screen app on iOS is resumed rather than reloaded and has no pull to
refresh: when the app comes back into view, and every 45 seconds while it is visible (`refreshBoard` in
`client/app.ts`). It only redraws when the server HTML changed, and never while the resident is typing or has
a popover, sheet, expanded row, confirm or action toast open. A booking lost to a concurrent resident shows
"Noen andre tok akkurat den tiden. Tidene under er oppdatert." with the current board (`tests/board-refresh.test.mjs`).

The active-booking limit counts distinct time periods per apartment, so reserving both machines at the
same time counts once. Migration `0002_booking_overlap.sql` also prevents overlaps with existing
reservations after an administrator changes the schedule. Migration `0003_resident_password_readable.sql`
adds the encrypted resident password column. Migration `0007_signup_and_recovery.sql` adds the recovery code hash,
the unused-building cleanup mark and the per-network signup counts. Migration `0008_demo_buildings.sql` adds the
`read_only` and `presets_only` flags.

## Verification

`npm run typecheck` checks server, client, scripts, and service-worker types.
`npm test` runs the real Hono booking routes against isolated SQLite (Node 22.13+), covering paired
reservations, atomic conflicts, household limits, ownership, comments, cancellation, schedule overlaps, the
calendar-week date strip, the read-only past-day view, apartment selection, waitlist counts and comment
pushes, the board's partly free rows, day-strip status, and first-booking hint cookie, the server-rendered
toasts (Angre confirmation, errors), the add-to-calendar event (`tests/calendar-event.test.mjs`), messages to booking
holders (`tests/push-messages.test.mjs`), the admin settings, machine, and password routes, the activity log and
closing/deleting a building (`tests/audit-danger.test.mjs`), the landing page, last-building cookie, read-only
showcase on every write route, presets-only playground and the nightly demo reset (`tests/landing.test.mjs`),
the about page, its footer links and the reserved `om` address (`tests/about.test.mjs`),
indexable versus noindex pages, link-preview tags, JSON-LD, robots.txt and the sitemap (`tests/seo.test.mjs`),
signup, onboarding, resident onboarding and per-building manifests, Turnstile, the signup limit, recovery codes and the cleanup of unused buildings (`tests/signup.test.mjs`),
the holder's "someone is waiting" push and the admin push test page (`tests/debug-push.test.mjs`), the Kopier buttons
(`tests/copy-buttons.test.mjs`), and the settings table of contents and inline machine updates in
`client/admin.ts` against a simulated page. It also compiles the service worker and runs it
as a classic script, since `/sw.js` is registered without `{ type: "module" }`.
CI (`.github/workflows/ci.yml`) runs both on every pull request and push to `main`.

## License

MIT, see [LICENSE](LICENSE).

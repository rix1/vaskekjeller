## UX

- [x] add icons to "kun vask" and "kun tørk" as well. (2026-09-23, #14: machine options show an icon per machine kind, both for the pair.)
- [x] Right now, it's not possible to see what machines are booked from the default (vask+tørk). Let's update the row so it clearly indicates what machines will be used during an occupied slot (right now people won't think to change it because it looks occupied.) (2026-09-23, #14: paired rows read Ledig / Delvis ledig / Reservert with per-machine holders and a one-tap confirm for the free machine.)
- [x] make the "endre leilighet" appear in a popup, similar to the "se detailjer" (2026-09-23: header chip opens a details/summary popover with the picker; first visit keeps the inline welcome.)
- [x] Add a sonner like toast instead of the banners for system status after saving/doing changes. Should be used on the tenant booking page (for all actions where it makes sense) as well as on the admin page. (2026-09-23, #17: server-rendered toasts on booking and admin pages, Angre on the booking confirmation.)
- [x] Should also be more clear to users if people are on waiting list for the spot you currently hold, and that they will be notified if you add/change the comment. (2026-09-23: card under Dine tider shows the waiter count; saving a new/changed comment pushes to waiters, tag per reservation.)
- [x] The "Ett trykk reserverer tiden. Du kan avbestille under Dine tider." doesn't provide much value. Can you remove it after the first click? (2026-09-23, #14: hidden after a device's first booking, `vk_booked` cookie.)
- [x] make it possible to see last 14 days as well (should default to this week). (2026-09-23: date strip uses Mon–Sun calendar weeks from today-14 to the horizon; past days are read-only and show who used each machine plus comments.)
- [x] make "fullt" on day-level more present/visible (2026-09-23, #14: full days get a stronger style; "Delvis" when only single machines are left.)
- [x] tone the obnoxious focus ring a bit down: mute/change the color. (2026-09-23, #14: muted 2px green ring.)

## Features

- [x] Add a Google calendar subscription feature, similar to how I did it for ~/Development/family-cal - so you can check bookings straight from your calendar. Event should contain useful info and a link to the tenant page. (2026-09-24: shipped as an Apple Calendar-only feed per apartment in the header-chip popover; Google refreshes too slowly. See README "Calendar".)
- [] Add the option for people to set name/contact details (phone number) along with their apartment and add a directory where admins can see this and a way for users to reach out to people with existing bookings to ask questions. Adding this info is optional per resident. (2026-09-23, #18: residents can reach a booking holder with a one-way push message; names, contact details and the directory are not built.)

## UI

- [x] The row background colors is off: for inactive/passert Subsequent bookings look weird together (no space but also border radius separating them). (2026-09-23, #14: tinted rows are separate rounded rows with a gap.)
- [x] there's no margin-x on the booking rows, so when a backgorund color is present (e.g. for inacive) the left and right most text looks crammed into the sides. (2026-09-23, #14: rows share side padding.)

## Admin

- [x] Improve the UX on the admin/settings page. (2026-09-23, #19: sections with a table of contents, dialogs/drawers, inline machine edits, readable resident password. 2026-09-25, #23: activity log and a close-and-delete danger zone.)

## Onboarding

- [x] Create a minimal landing page that explains what this is with a nice screenshot (full of bookings) (2026-09-25, #25: live phone-framed preview of the read-only `/visning` showcase, plus the `/demo` playground; both reset nightly.)
- [x] Create an signup and onboarding flow for new tenants. Should end with "share with tenants" with some prepared "marketing" material/copy that admins can send out to tenants + other admins (shared account): "copy this message and share it to your tenants to get them started". Slug should be auto-generated from name (and checked for conflicts) but also possible to override/customize. (2026-09-25, #24: eight-step signup at `/ny` with Turnstile, recovery codes and a share step with ready-made messages.)
- [x] Add about page explaining what this is, with FAQ on how data is stored etc. focus on: installing/getting started and how notifications work: when are you notified, how, etc. (2026-09-25: `/om`, linked from the landing and every building's footer; contact hjelp@vaskekjeller.no.)

## Devops

- [] Push repo to Github and update the project list in ~/Development/rix1.dev/ (see project skill). (2026-09-23: repo is public at https://github.com/rix1/vaskekjeller; rix1.dev project list not yet updated.)
- [] Connect the repo to Workers Builds in the Cloudflare dashboard and create the Lofotgata building (captain; checklist in docs/deploy.md).
- [x] Find suitable domain name candidates, e.g. vask.now. (2026-09-25, #22: served only at www.vaskekjeller.no; the bare domain redirects.)
- [x] Ensure D1 is set up to store data in EU. (2026-09-23: created `vaskekjeller` D1 with `--jurisdiction eu`, pinned `database_id` in wrangler.jsonc; not yet deployed or migrated remotely.)

## Log

- 2026-09-25: About/FAQ page at `/om` (`src/about.tsx`, styles in public/landing.css), linked from the landing and resident footers; `om` was already reserved. `VAPID_SUBJECT` is now `mailto:hjelp@vaskekjeller.no`. README notes that pinning the EU `database_id` gave local dev an empty D1 file. Consolidated this file: feature PRs #14–#25 left it untouched, so their items are checked off above. The /om cookie list covers every cookie the app sets (incl. `vk_booked` and the admin recovery-code cookie); keep it in step when adding one. Its data section also lists the daily signup-limit network hash (`signup_counts`). docs/deploy.md step 8: route hjelp@ in Cloudflare Email Routing (not yet confirmed).
- 2026-09-25: Shipped since the last entries (see git log for details): www.vaskekjeller.no custom domain (#22), activity log and close/delete danger zone (#23), self-service signup with recovery codes and unused-building cleanup (#24), landing page with the `/visning` and `/demo` buildings (#25).
- 2026-09-23: Shipped: board polish (#14), toasts (#17), messages to booking holders (#18), admin settings redesign (#19).
- 2026-09-24: Live-validated the calendar feed on `wrangler dev` + headless Chrome: popover (Apple button, copy link, lag note, switch, Lag ny lenke), feed content (machines, comment, waiting count, day link, OPAQUE/TRANSPARENT, PT15M), toggle on the same link, rotation 404s the old link, feed works without the resident password, and set/change/off retire every link with no revival.
- 2026-09-24: Calendar links: admin resident-password routes (set/change/off) now retire every feed of the building in the same batch (`retireFeeds`, password_key = 'retired'), so a link retired earlier can't come back when the key repeats (password off again). Feed waiting counts read the waitlist from today, so past events never say neighbours are waiting.
- 2026-09-23: GitOps deploy via Workers Builds: push to main runs remote D1 migrations, then `wrangler deploy`. Worker `vaskekjeller` created as a placeholder by `wrangler secret bulk`, with SESSION_SECRET and VAPID keys set (only in Cloudflare). VAPID_SUBJECT set. Remote DB migrations not yet applied; the first build does it. Checklist: docs/deploy.md. Dashboard: build command empty, deploy command `npm run deploy` (migrate-then-deploy lives only in package.json); `preview_urls: false` in wrangler.jsonc. Regenerated worker-configuration.d.ts for the new VAPID_SUBJECT. `npm run deploy` applies migrations with `CI=true` (no confirm prompt), so a declined prompt can't deploy.
- 2026-09-23: README documents the calendar-week strip and read-only past days.
- 2026-09-23: Past days now also show bookings on since-deactivated machines and bookings outside the current opening hours (the board loads inactive machines; only active ones are bookable).
- 2026-09-23: Calendar-week date strip with a 14-day read-only look-back (`LOOKBACK_DAYS` in src/index.tsx, `calendarWeeks` in src/time.ts). Write routes still reject past slots.
- 2026-09-23: Added GitHub Actions CI (typecheck + tests on PRs and pushes to main, Node 24) and MIT LICENSE.
- 2026-09-23: Apartment change moved into a popover on the header chip (`.apartment-menu`); popover body is sections so the calendar-subscription link can be added as another `<section>`.
- 2026-09-23: Waitlist-aware comments: reservation cards show how many households wait, comment field hints they will be told, and a changed non-empty comment pushes to waiters as "<short date> <start>–<end>: «note»" (tag `note-<date>-<start>-<apartment>` so the same holder's edits replace each other; `renotify` so a replacement still alerts). The push banner, test push, and waitlist-joined message now mention comments too.
- 2026-09-23: Fixed service worker build: client/sw.ts is now a classic script (no `export {}`), so the compiled public/sw.js registers via `register("/sw.js")`; tests/sw.test.mjs builds it and runs it as a classic script.
- 2026-09-23: Live-validated waitlist comments on `wrangler dev` + headless Chrome: waiter count/copy on the card and hint, pushes (decrypted at a fake push endpoint) only to waiters, none on clear/unchanged, and in Chrome an edit replaces the earlier notification while another reservation's comment stacks.

## UX

- [] add icons to "kun vask" and "kun tørk" as well.
- [] Right now, it's not possible to see what machines are booked from the default (vask+tørk). Let's update the row so it clearly indicates what machines will be used during an occupied slot (right now people won't think to change it because it looks occupied.)
- [x] make the "endre leilighet" appear in a popup, similar to the "se detailjer" (2026-09-23: header chip opens a details/summary popover with the picker; first visit keeps the inline welcome.)
- [x] Add a sonner like toast instead of the banners for system status after saving/doing changes. Should be used on the tenant booking page (for all actions where it makes sense) as well as on the admin page.
- [x] Should also be more clear to users if people are on waiting list for the spot you currently hold, and that they will be notified if you add/change the comment. (2026-09-23: card under Dine tider shows the waiter count; saving a new/changed comment pushes to waiters, tag per reservation.)
- [] The "Ett trykk reserverer tiden. Du kan avbestille under Dine tider." doesn't provide much value. Can you remove it after the first click?
- [x] make it possible to see last 14 days as well (should default to this week). (2026-09-23: date strip uses Mon–Sun calendar weeks from today-14 to the horizon; past days are read-only and show who used each machine plus comments.)
- [] make "fullt" on day-level more present/visible
- [] tone the obnoxious focus ring a bit down: mute/change the color. 

## Features

- [] Add a Google calendar subscription feature, similar to how I did it for ~/Development/family-cal - so you can check bookings straight from your calendar. Event should contain useful info and a link to the tenant page.
- [] Add the option for people to set name/contact details (phone number) along with their apartment and add a directory where admins can see this and a way for users to reach out to people with existing bookings to ask questions. Adding this info is optional per resident.

## UI

- [] The row background colors is off: for inactive/passert Subsequent bookings look weird together (no space but also border radius separating them).
- [] there's no margin-x on the booking rows, so when a backgorund color is present (e.g. for inacive) the left and right most text looks crammed into the sides.

## Admin

- [] Improve the UX on the admin/settings page.

## Onboarding

- [] Create a minimal landing page that explains what this is with a nice screenshot (full of bookings)
- [] Create an signup and onboarding flow for new tenants. Should end with "share with tenants" with some prepared "marketing" material/copy that admins can send out to tenants + other admins (shared account): "copy this message and share it to your tenants to get them started". Slug should be auto-generated from name (and checked for conflicts) but also possible to override/customize.
- [] Add about page explaining what this is, with FAQ on how data is stored etc. focus on: installing/getting started and how notifications work: when are you notified, how, etc.

## Devops

- [] Push repo to Github and update the project list in ~/Development/rix1.dev/ (see project skill). (2026-09-23: repo is public at https://github.com/rix1/vaskekjeller; rix1.dev project list not yet updated.)
- [] Connect the repo to Workers Builds in the Cloudflare dashboard and create the Lofotgata building (captain; checklist in docs/deploy.md).
- [] Find suitable domain name candidates, e.g. vask.now.
- [x] Ensure D1 is set up to store data in EU. (2026-09-23: created `vaskekjeller` D1 with `--jurisdiction eu`, pinned `database_id` in wrangler.jsonc; not yet deployed or migrated remotely.)

## Log

- 2026-09-23: GitOps deploy via Workers Builds: push to main runs remote D1 migrations, then `wrangler deploy`. Worker `vaskekjeller` created as a placeholder by `wrangler secret bulk`, with SESSION_SECRET and VAPID keys set (only in Cloudflare). VAPID_SUBJECT set. Remote DB migrations not yet applied; the first build does it. Checklist: docs/deploy.md. Dashboard: build command empty, deploy command `npm run deploy` (migrate-then-deploy lives only in package.json); `preview_urls: false` in wrangler.jsonc. Regenerated worker-configuration.d.ts for the new VAPID_SUBJECT. `npm run deploy` applies migrations with `CI=true` (no confirm prompt), so a declined prompt can't deploy.
- 2026-09-23: README documents the calendar-week strip and read-only past days.
- 2026-09-23: Past days now also show bookings on since-deactivated machines and bookings outside the current opening hours (the board loads inactive machines; only active ones are bookable).
- 2026-09-23: Calendar-week date strip with a 14-day read-only look-back (`LOOKBACK_DAYS` in src/index.tsx, `calendarWeeks` in src/time.ts). Write routes still reject past slots.
- 2026-09-23: Status banners replaced by in-house toasts (booking page, login, admin); Angre booking toast 8 s, success 4 s, errors stay; CSS-only fade without JS.
- 2026-09-23: Added GitHub Actions CI (typecheck + tests on PRs and pushes to main, Node 24) and MIT LICENSE.
- 2026-09-23: Apartment change moved into a popover on the header chip (`.apartment-menu`); popover body is sections so the calendar-subscription link can be added as another `<section>`.
- 2026-09-23: Waitlist-aware comments: reservation cards show how many households wait, comment field hints they will be told, and a changed non-empty comment pushes to waiters as "<short date> <start>–<end>: «note»" (tag `note-<date>-<start>-<apartment>` so the same holder's edits replace each other; `renotify` so a replacement still alerts). The push banner, test push, and waitlist-joined message now mention comments too.
- 2026-09-23: Fixed service worker build: client/sw.ts is now a classic script (no `export {}`), so the compiled public/sw.js registers via `register("/sw.js")`; tests/sw.test.mjs builds it and runs it as a classic script.
- 2026-09-23: Live-validated waitlist comments on `wrangler dev` + headless Chrome: waiter count/copy on the card and hint, pushes (decrypted at a fake push endpoint) only to waiters, none on clear/unchanged, and in Chrome an edit replaces the earlier notification while another reservation's comment stacks.

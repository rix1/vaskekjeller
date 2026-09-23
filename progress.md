## UX

- [] add icons to "kun vask" and "kun tørk" as well.
- [] Right now, it's not possible to see what machines are booked from the default (vask+tørk). Let's update the row so it clearly indicates what machines will be used during an occupied slot (right now people won't think to change it because it looks occupied.)
- [] make the "endre leilighet" appear in a popup, similar to the "se detailjer"
- [] Add a sonner like toast instead of the banners for system status after saving/doing changes. Should be used on the tenant booking page (for all actions where it makes sense) as well as on the admin page.
- [] Should also be more clear to users if people are on waiting list for the spot you currently hold, and that they will be notified if you add/change the comment.
- [] The "Ett trykk reserverer tiden. Du kan avbestille under Dine tider." doesn't provide much value. Can you remove it after the first click?
- [] make it possible to see last 14 days as well (should default to this week).
- [] make "fullt" on day-level more present/visible
- [] tone the obnoxious focus ring a bit down: mute/change the color. 

## Features

- [] Add a Google calendar subscription feature, similar to how I did it for ~/Development/family-cal - so you can check bookings straight from your calendar. Event should contain useful info and a link to the tenant page.
- [] Add the option for people to set name/contact details (phone number) along with their apartment and add a directory where admins can see this and a way for users to reach out to people with existing bookings to ask questions. Adding this info is optional per resident.

## UI

- [] The row background colors is off: for inactive/passert Subsequent bookings look weird together (no space but also border radius separating them).
- [] there's no margin-x on the booking rows, so when a backgorund color is present (e.g. for inacive) the left and right most text looks crammed into the sides.

## Admin

- [x] Improve the UX on the admin/settings page. (2026-09-23: admin redesign on branch `fm/vk-admin-redesign`: resident-style header and cards, sectioned settings with a desktop table of contents, slot-length picker with live preview, inline machine reorder/switch/rename, modal/drawer dialogs, resident password on/off toggle and readable encrypted door code (migration 0003), apartment count and duplicate flags. Toasts, audit log and danger zone are separate tasks.)

## Onboarding

- [] Create a minimal landing page that explains what this is with a nice screenshot (full of bookings)
- [] Create an signup and onboarding flow for new tenants. Should end with "share with tenants" with some prepared "marketing" material/copy that admins can send out to tenants + other admins (shared account): "copy this message and share it to your tenants to get them started". Slug should be auto-generated from name (and checked for conflicts) but also possible to override/customize.
- [] Add about page explaining what this is, with FAQ on how data is stored etc. focus on: installing/getting started and how notifications work: when are you notified, how, etc.

## Devops

- [] Push repo to Github and update the project list in ~/Development/rix1.dev/ (see project skill). (2026-09-23: repo is public at https://github.com/rix1/vaskekjeller; rix1.dev project list not yet updated.)
- [] Find suitable domain name candidates, e.g. vask.now.
- [x] Ensure D1 is set up to store data in EU. (2026-09-23: created `vaskekjeller` D1 with `--jurisdiction eu`, pinned `database_id` in wrangler.jsonc; not yet deployed or migrated remotely.)

## Log

- 2026-09-23: Docs pass for the admin redesign: README now lists the TOC script test under Verification. Typecheck is clean.
- 2026-09-23: Re-ran the live admin tests (wrangler dev + headless Chrome, desktop, phone, no-JS). All pass. The TOC marks the same section at a given scroll position from both directions on the new-tenant, demo and legacy layouts at several viewport sizes, and TOC clicks, `#section` loads, Back/Forward and inline machine edits keep the right mark. Minor, by design: after a card error, the TOC marks the card at the top of the screen ("Generelt") while focus is on the invalid field in "Tider og regler" just below it.
- 2026-09-23: Fixed: the settings TOC mark depended on scroll direction. `client/admin.ts` now works the mark out from the section positions on every scroll (the last section starting in the top 30% of the screen; the last section at the bottom of the page) instead of IntersectionObserver deltas, and a `hashchange` listener marks the section after Back/Forward. Jumps still keep their mark until the section moves. `tests/admin-toc.test.mjs` runs the script against a fake page with the new-tenant layout. Verified live in wrangler dev + headless Chrome (desktop and phone): at scrollY 917 "Leiligheter" is marked coming from both directions.
- 2026-09-23: Re-ran the live admin tests (wrangler dev + headless Chrome). TOC jumps and `#section` loads now mark the right section, and all other intent items pass. Open: on a new tenant's default layout (1280x900, empty apartment list, two machines), the TOC mark depends on scroll direction. The IntersectionObserver callback only reacts to sections entering the band, so at scrollY 917 it shows "Tilgang" coming up from the bottom and "Tider og regler" coming down, while "Leiligheter" is the section in the band. Fix idea: on scroll, work out the mark from where the sections are.
- 2026-09-23: Fixed: the settings TOC marked "Tilgang" after a jump to "Maskiner". Near the bottom, both jumps end at the same scroll position, so a section jumped to (TOC click or `#section` on load) now stays marked until it moves on screen. Verified live in wrangler dev + headless Chrome, including the inline machine update after landing on `#maskiner`. Still open: when scrolling up from the bottom, the previous mark can linger until a new section enters the observed band (the IntersectionObserver only reports changes).
- 2026-09-23: Re-ran the live admin tests (wrangler dev + headless Chrome, desktop, phone, no-JS). Everything passes except one TOC issue: clicking "Maskiner" (or landing on `#maskiner` after a machine save) now marks "Tilgang", because the page is at the bottom and the last-link rule wins. Open.
- 2026-09-23: Fixed: the settings TOC marked "Maskiner" instead of "Tilgang" at the bottom of the page (the IntersectionObserver callback overwrote the bottom-of-page scroll handler). Both now share one marker in `client/admin.ts`, and at the bottom the last link wins. Verified live in headless Chrome.
- 2026-09-23: Live-tested the admin redesign in wrangler dev + headless Chrome (desktop, phone, no-JS): all intent items work.
- 2026-09-23: Admin review fixes: inline machine changes are queued and sent in order (no aborted writes; the switch posts the state it shows); the schedule preview skips a slot length that isn't a positive integer instead of looping forever.
- 2026-09-23: Admin review fixes: changing the admin password always requires a matching confirmation; a settings card error focuses the first marked field (JS) and the error message links to the failing card (no JS).
- 2026-09-23: Admin redesign (see Admin). Admin styles and script live in `public/admin.css` and `client/admin.ts`, loaded only on admin pages. Pages render without a doctype (quirks mode); worth fixing in `Layout` separately.
- 2026-09-23: Added GitHub Actions CI (typecheck + tests on PRs and pushes to main, Node 24) and MIT LICENSE.

## UX

- [] add icons to "kun vask" and "kun tørk" as well.
- [] Right now, it's not possible to see what machines are booked from the default (vask+tørk). Let's update the row so it clearly indicates what machines will be used during an occupied slot (right now people won't think to change it because it looks occupied.)
- [] make the "endre leilighet" appear in a popup, similar to the "se detailjer"
- [] Add a sonner like toast instead of the banners for system status after saving/doing changes. Should be used on the tenant booking page (for all actions where it makes sense) as well as on the admin page.
- [] Should also be more clear to users if people are on waiting list for the spot you currently hold, and that they will be notified if you add/change the comment.
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
- [] Find suitable domain name candidates, e.g. vask.now.
- [x] Ensure D1 is set up to store data in EU. (2026-09-23: created `vaskekjeller` D1 with `--jurisdiction eu`, pinned `database_id` in wrangler.jsonc; not yet deployed or migrated remotely.)

## Log

- 2026-09-23: Calendar-week date strip with a 14-day read-only look-back (`LOOKBACK_DAYS` in src/index.tsx, `calendarWeeks` in src/time.ts). Write routes still reject past slots.
- 2026-09-23: Added GitHub Actions CI (typecheck + tests on PRs and pushes to main, Node 24) and MIT LICENSE.

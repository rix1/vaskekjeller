# Connecting the repo to Cloudflare (Workers Builds)

One-time setup. After this, every push to `main` builds and deploys the app. See the README's
[Deploy](../README.md#deploy) section for how it works.

Already done, don't redo:

- D1 database `vaskekjeller` exists in the EU jurisdiction and is pinned in `wrangler.jsonc`.
- The Worker `vaskekjeller` exists, with the secrets `SESSION_SECRET`, `VAPID_PUBLIC_KEY` and
  `VAPID_PRIVATE_KEY` already set. It is an empty placeholder until the first build deploys the app.

## Checklist

1. **Connect the repo.** Cloudflare dashboard → **Workers & Pages** → **vaskekjeller** → **Settings** →
   **Build** → **Connect**. Choose GitHub, authorize the Cloudflare app for `rix1/vaskekjeller`, and select
   the repo. Connect the existing Worker rather than using "Import a repository", which would create a new
   one. The Worker name must stay `vaskekjeller` to match `name` in `wrangler.jsonc`.
2. **Build settings:**
   - Production branch: `main`
   - Build command: leave empty (Workers Builds installs dependencies itself)
   - Deploy command: `npm run deploy`
   - Root directory: leave empty (repo root)
   - Build variables: none needed. Node comes from `.node-version`.
3. **Turn off preview builds.** **Settings** → **Build** → **Branch control**: uncheck **Enable Preview
   Builds** (builds for non-production branches). Previews would use the live database. Per-version
   preview URLs are already off via `"preview_urls": false` in `wrangler.jsonc`.
4. **Give the build token D1 and zone access.** `npm run deploy` applies migrations first, which needs **D1 Edit**.
   The token Workers Builds creates by default (**Create new token** in the connect dialog) has Workers
   Scripts, KV and R2 edit, but not D1. After connecting, go to **My Profile** → **API Tokens**, edit that
   token, and add **Account** → **D1** → **Edit**. You can also create a token with those permissions
   yourself and select it under **Settings** → **Build** → **API token**.

   The deploy then attaches the custom domain `www.vaskekjeller.no`, which needs access to the
   `vaskekjeller.no` zone: **Zone** → **Workers Routes** → **Edit**, with that zone included under **Zone
   Resources**. The default token has this for all zones; a token you create yourself must include it.
5. **Run the first build.** Push a commit to `main` (merging a PR counts). The build log
   should show every migration in `migrations/` applied, then the deploy.
6. **Create the first building** from your own machine (after `npm install` and `npx wrangler login`),
   once the first build has applied the migrations. It prompts for the admin password:

   ```sh
   node scripts/create-tenant.ts --slug lofotgata --name "Lofotgata" --remote
   ```

7. **Open it.** The app is public at `https://www.vaskekjeller.no/lofotgata`. The admin page is
   `/lofotgata/admin`.
   `/` shows a plain placeholder until a landing page exists.

## Domain

`vaskekjeller.no` is registered at Domeneshop with its nameservers pointing to Cloudflare, where the zone
is active.

- **www.vaskekjeller.no** is a Workers Custom Domain declared in `routes` in `wrangler.jsonc`. Deploy
  creates the DNS record and certificate. Never add a `www` DNS record by hand: a conflicting record makes
  the deploy fail.
- **vaskekjeller.no** (apex) redirects to www:
  1. **DNS** → **Records**: add `AAAA` `@` → `100::`, **Proxied** (a placeholder so requests reach Cloudflare).
  2. **Rules** → **Redirect Rules** → create a rule: when hostname equals `vaskekjeller.no`, dynamic
     redirect to `concat("https://www.vaskekjeller.no", http.request.uri.path)`, status **301**,
     **Preserve query string** on.

## If a build fails

- **Migration step fails** (for example, an authorization error): the deploy never runs, so the live
  app keeps running the previous version against an unchanged database. Check the token has D1 Edit.
- **Custom domain step fails** (after the upload, for example an authorization error on
  `www.vaskekjeller.no`): the build token can't reach the `vaskekjeller.no` zone. Check it has **Zone** →
  **Workers Routes** → **Edit** covering that zone (step 4). A conflicting `www` DNS record added by hand
  also fails this step; delete it and rerun the build.
- **Worker name mismatch:** the dashboard Worker name must equal `name` in `wrangler.jsonc`.

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
4. **Give the build token D1 access.** `npm run deploy` applies migrations first, which needs **D1 Edit**.
   The token Workers Builds creates by default (**Create new token** in the connect dialog) has Workers
   Scripts, KV and R2 edit, but not D1. After connecting, go to **My Profile** → **API Tokens**, edit that
   token, and add **Account** → **D1** → **Edit**. You can also create a token with those permissions
   yourself and select it under **Settings** → **Build** → **API token**.
5. **Run the first build.** Push a commit to `main` (merging a PR counts). The build log
   should show both migrations (`0001_init.sql`, `0002_booking_overlap.sql`) applied, then the deploy.
6. **Create the first building** from your own machine (after `npm install` and `npx wrangler login`),
   once the first build has applied the migrations. It prompts for the admin password:

   ```sh
   node scripts/create-tenant.ts --slug lofotgata --name "Lofotgata" --remote
   ```

7. **Open it.** The app is public at `https://vaskekjeller.<your-subdomain>.workers.dev/lofotgata`
   (the exact address is on the Worker's overview page). The admin page is `/lofotgata/admin`.
   `/` shows a plain placeholder until a landing page exists.

## If a build fails

- **Migration step fails** (for example, an authorization error): the deploy never runs, so the live
  app keeps running the previous version against an unchanged database. Check the token has D1 Edit.
- **Worker name mismatch:** the dashboard Worker name must equal `name` in `wrangler.jsonc`.

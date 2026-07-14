# muesly.ai

Marketing website for [muesly](https://github.com/afonsojramos/muesly), the privacy-first, on-device AI meeting assistant. Static site built with [Astro](https://astro.build), Tailwind CSS 4, and deployed to Cloudflare.

It is a separate project from the desktop app (`app/`) with its own dependencies and lockfile, so it stays off the Tauri build.

## Develop

```bash
nub install
nub run dev       # http://localhost:4321
```

## Build & verify

```bash
nub run build     # static output in dist/
nub run preview   # serve the production build locally
nub run check     # astro check (types)
nub run test      # vitest unit tests (detect-os, button variants, cn)
nub run build && nub run test:smoke # verify every production route and required asset
```

The whole site is prerendered to static HTML. The only client JavaScript is a small enhancement script (`src/scripts/client.ts`): scroll reveal, sticky-nav state, OS-aware download CTAs, and download-card promotion. Everything works without it.

Website download links use GitHub's `/releases/latest/download/` URLs so downloads are counted against the corresponding GitHub Release assets. The release workflow also publishes installers and updater payloads to the `muesly-downloads` R2 bucket through `downloads.muesly.ai` for application updates and stable infrastructure aliases.

Pull requests and pushes to `main` that touch the site run formatting, lint, type checks, unit tests, a production build, route smoke tests, and a high-severity dependency audit in `.github/workflows/site-check.yml`. After review, run the manual `Deploy Site` workflow; it repeats the full verification suite, validates the Wrangler bundle, and deploys through the protected `production` environment.

## Privacy page

`/privacy` and `/terms` render the repo-root legal documents so they stay the single source of truth. A prebuild step (`scripts/copy-legal-docs.mjs`) copies them into the project before each `dev`/`build`/`check`; the copies are gitignored.

## Deploy (Cloudflare)

Two supported paths:

**1. Wrangler (config-as-code, recommended).** `wrangler.jsonc` is committed. Authenticate once (`wrangler login`, or set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`), then:

```bash
nub run deploy    # astro build && wrangler deploy
```

Use a least-privilege API token (`Workers Scripts:Edit` on `muesly-web`, plus `Workers Routes:Edit` on the `muesly.ai` zone for the custom domains). Release automation additionally needs R2 object write access to `muesly-downloads`. The apex (`muesly.ai`) and `www` are attached as custom domains in `wrangler.jsonc`; `downloads.muesly.ai` is attached directly to the R2 bucket.

**2. Cloudflare dashboard Git integration (zero local setup).** Connect the repo, set the project root directory to `site/`, build command `nub run build`, output directory `dist`. Pushes deploy automatically and PRs get preview URLs. No secrets in the repo.

If you wire deploys through GitHub Actions instead, trigger the workflow `on: push` to the default branch only (never `pull_request` — a fork PR would expose the deploy secrets) and path-filter it to `site/**`.

## Stack

- Astro (static output) + TypeScript
- Tailwind CSS 4 via `@tailwindcss/vite`
- `astro-icon` with the Lucide icon set
- Inter + Lora via `@fontsource-variable/*`
- Brand tokens lifted from the desktop app (`app/src-svelte/src/app.css`)

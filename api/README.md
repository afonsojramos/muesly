# muesly API

The muesly backend on Cloudflare Workers + D1, served at `api.muesly.ai`. Routes
are feature-namespaced (`/bars/*` today) so more can be added later without new
infra. Deployed as its own Worker on the same Cloudflare account as the marketing
site (its own deploy/rollback; the site stays purely static).

The first feature is **anonymous popularity counts** for the shared bar catalog.
It only ever receives public catalog ids (`builtin:*` / `imported:*`) — never
user-created bars, meeting content, user ids, or auth. A request is just "someone
ran this public bar". Reads are public.

## Endpoints

- `POST /bars/track` — body `{ "ids": ["builtin:summary", "imported:write-tldr"] }`.
  Increments each catalog bar's count. Non-catalog ids are ignored. `204`.
- `GET /bars/popular?limit=100` — `[{ "bar_id", "uses" }]`, most-used first.

## Schema

Managed with Drizzle. Tables live in `src/db/schema.ts`; SQL migrations are
generated into `drizzle/` and applied to the shared `muesly` D1 with wrangler.

## Deploy (first time)

```bash
pnpm install
pnpm dlx wrangler login                 # or: npx wrangler login

# Create the shared D1 database, then paste the printed database_id into wrangler.jsonc
pnpm dlx wrangler d1 create muesly

pnpm db:migrate                          # applies drizzle/ migrations to remote D1
pnpm deploy                              # deploys the Worker

# Optional: serve on api.muesly.ai (uncomment the `routes` block in
# wrangler.jsonc, or add the custom domain in the Cloudflare dashboard).
```

## Changing the schema

```bash
# 1. edit src/db/schema.ts
pnpm db:generate      # writes a new migration into drizzle/
pnpm db:migrate       # applies it to remote D1  (add :local for the dev DB)
```

Never hand-edit files in `drizzle/`.

## The app

The desktop app posts catalog-bar ids to `POST /bars/track` (fire-and-forget) and
reads `GET /bars/popular` for the "Popular" counts on the Bars page. Its base URL
is `https://api.muesly.ai` by default, overridable with `VITE_BARS_API_URL` at
build time; that origin must be in the app's Tauri CSP `connect-src`.

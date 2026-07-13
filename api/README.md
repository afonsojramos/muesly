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

```bash
# after editing src/db/schema.ts:
nub run db:generate   # writes a migration into drizzle/
nub run db:migrate    # applies it to remote D1  (add :local for the dev DB)
```

Never hand-edit files in `drizzle/`.

## Deploy — GitHub Actions (primary)

Pushing changes under `api/**` to `main` runs `.github/workflows/deploy-api.yml`,
which applies migrations and deploys. It needs two repo secrets (Settings →
Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — a scoped token (Account → Workers Scripts: Edit, D1:
  Edit; Account: Read). This is the only real secret.
- `CLOUDFLARE_ACCOUNT_ID` — the account id. Kept out of the committed config on
  purpose; wrangler reads it from this env var.

The D1 `database_id` lives in `wrangler.jsonc` — it's a non-secret identifier and
is required for the binding.

## Deploy — manual / first time

```bash
nub install
nubx wrangler login                           # or export CLOUDFLARE_API_TOKEN
nubx wrangler d1 create muesly                # once; paste database_id into wrangler.jsonc

# account_id isn't in the config, so pass it for multi-account setups:
CLOUDFLARE_ACCOUNT_ID=<your-account-id> nub run db:migrate
CLOUDFLARE_ACCOUNT_ID=<your-account-id> nub run release

# Optional: serve on api.muesly.ai (uncomment `routes` in wrangler.jsonc, or add
# the custom domain in the dashboard).
```

`release` is `wrangler deploy` under a non-`deploy` name (bare `pnpm deploy` is a
built-in pnpm command and won't run this script).

## The app

The desktop app posts catalog-bar ids to `POST /bars/track` (fire-and-forget) and
reads `GET /bars/popular` for the "Popular" counts on the Bars page. Its base URL
is `https://api.muesly.ai` by default, overridable with `VITE_BARS_API_URL` at
build time; that origin must be in the app's Tauri CSP `connect-src`.

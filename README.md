# Private life

Capture pages, selections, notes, and bookmarks into one ClickHouse table. A Cloudflare Worker is the only process that inserts. A Chrome extension and a command-line client send the same schema.

Nothing in this repository is deployed. No real credential belongs in git.

## Layout

```
packages/schema          versioned item contract and error bodies
apps/worker              ingress Worker
apps/cli                 private-life ingest
apps/extension           Manifest V3 popup
infra/alchemy.run.ts     Worker, secrets, and rate-limit binding
clickhouse/migrations    items table
clickhouse/grants.sql    INSERT grant for user ingest
```

## Checks

```sh
bun install
bun run typecheck
bun run test
bun run extension:build
```

## ClickHouse Cloud

1. Create a service on the [ClickHouse Cloud](https://clickhouse.cloud) free tier.
2. Leave the IP allowlist empty. Cloudflare Workers have no stable egress range, so an allowlist blocks every insert. The `ingest` password is the control.
3. Run `clickhouse/migrations/001_items.sql` in the SQL console.
4. Create a user named `ingest` in the console and set its password there. `clickhouse/grants.sql` has no password.
5. Run `clickhouse/grants.sql`. That user can `INSERT` into `private_life.items` and cannot `SELECT`.

`ReplacingMergeTree` keeps the newest `ingested_at` for one `id` inside one month, and only after a merge. The same `id` with `ts` in another month stays as two rows. A later read should use `SELECT ... FINAL`. This scaffold has no read API.

## Secrets

Copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars` for local `wrangler dev`. `.dev.vars` is gitignored.

| Name | Value |
| --- | --- |
| `AUTH_TOKENS` | JSON object from client name to bearer token, for example `{"chrome":"...","cli":"..."}` |
| `CLICKHOUSE_URL` | HTTPS endpoint from the Cloud console, including the port |
| `CLICKHOUSE_USER` | `ingest` |
| `CLICKHOUSE_PASSWORD` | password from the console |
| `CLICKHOUSE_DATABASE` | `private_life` |

Alchemy reads those same names from the environment at deploy time and stores them as Worker secrets.

## Worker

Local:

```sh
bun run --filter @private-life/worker dev
```

Deploy is yours to run:

```sh
bun run --filter @private-life/infra deploy
```

The stack file is `infra/alchemy.run.ts`. It creates the Worker `private-life-ingress`, the five secrets, and the rate-limit binding `INGEST_RATE_LIMITER` (namespace `1001`, 60 requests per 60 seconds). One HTTP request counts as one call, including a batch. The rate-limit key is the client name, never the token. Bun runs that CLI, so `infra` depends on `@effect/platform-bun` 4.0.4 next to Effect 4. The app packages stay on Effect 3.

After the first deploy, send more than 60 requests in a minute and confirm the Worker returns 429. This binding has failed open in production.

`POST /v1/items` with `Authorization: Bearer <token>`. `GET /health` needs no token. Clients should generate `id` before the first POST and reuse that `id` and `ts` on retry. The Worker mints an id only when the body omits one, and a failed insert then cannot be retried as the same row.

## Extension

```sh
bun run extension:build
```

In Chrome, open `chrome://extensions`, turn on Developer mode, and load `apps/extension/dist`. Open the extension options and set the worker URL plus the `chrome` token.

`host_permissions` is `https://*/*` plus localhost because the worker hostname does not exist until you deploy. Narrow that list to the worker origin afterwards.

The popup saves the current selection. With no selection it saves the page title. `source` is always `chrome`.

## CLI

```sh
PRIVATE_LIFE_URL=https://private-life-ingress.<account>.workers.dev \
PRIVATE_LIFE_TOKEN=<cli token> \
bun run --filter @private-life/cli ingest -- \
  --type note --text "ship the schema" --tag etl
```

`--source` defaults to `cli`. `--url` is optional. `--tag` can be repeated. Each run generates a new id and prints the id from the Worker response.

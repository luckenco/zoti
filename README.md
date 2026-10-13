# Herodotus

Capture notes and sources (videos, tweets, posts, pages, selections) into one ClickHouse table, marked as made by you or by an agent. A Cloudflare Worker is the only process that inserts. A Chrome extension and a command-line client send the same schema. Agents use the CLI.

Nothing in this repository is deployed. No real credential belongs in git.

## Layout

```
packages/schema          versioned record contract and error bodies
apps/worker              ingress Worker
apps/cli                 herodotus ingest
apps/extension           Manifest V3 popup
infra/alchemy.run.ts     Worker, secrets, and rate-limit binding
clickhouse/migrations    records table
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
3. Run `clickhouse/migrations/001_records.sql` in the SQL console.
4. Create a user named `ingest` in the console and set its password there. `clickhouse/grants.sql` has no password.
5. Run `clickhouse/grants.sql`. That user can `INSERT` into `herodotus.records` and cannot `SELECT`.

`ReplacingMergeTree` keeps the newest `ingested_at` for one `id` inside one month, and only after a merge. The same `id` with `ts` in another month stays as two rows. A later read should use `SELECT ... FINAL`. This scaffold has no read API.

## Secrets

Copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars` for local `wrangler dev`. `.dev.vars` is gitignored.

| Name | Value |
| --- | --- |
| `AUTH_TOKENS` | JSON object from identity name to `{"token": "...", "actor": "human" \| "agent"}`, for example `{"chrome":{"token":"...","actor":"human"},"pi":{"token":"...","actor":"agent"}}` |
| `CLICKHOUSE_URL` | HTTPS endpoint from the Cloud console, including the port |
| `CLICKHOUSE_USER` | `ingest` |
| `CLICKHOUSE_PASSWORD` | password from the console |
| `CLICKHOUSE_DATABASE` | `herodotus` |

Alchemy reads those same names from the environment at deploy time and stores them as Worker secrets.

## Worker

Local:

```sh
bun run --filter @herodotus/worker dev
```

Deploy is yours to run:

```sh
bun run --filter @herodotus/infra deploy
```

The stack file is `infra/alchemy.run.ts`. It creates the Worker `herodotus-ingress`, the five secrets, and the rate-limit binding `INGEST_RATE_LIMITER` (namespace `1001`, 60 requests per 60 seconds). One HTTP request counts as one call, including a batch. The rate-limit key is the identity name, never the token. Bun runs that CLI, so `infra` depends on `@effect/platform-bun` 4.0.4 next to Effect 4. The app packages stay on Effect 3.

After the first deploy, send more than 60 requests in a minute and confirm the Worker returns 429. This binding has failed open in production.

`POST /v1/records` with `Authorization: Bearer <token>`. `GET /health` needs no token. Clients should generate `id` before the first POST and reuse that `id` and `ts` on retry. The Worker mints an id only when the body omits one, and a failed insert then cannot be retried as the same row.

Each identity has its own token. The Worker stamps `actor` (`human` or `agent`) and, for agents, `agent` (the identity name) from the token. A body that sets either gets a 400. `via` is the client (`chrome`, `cli`) and the client declares it. Ids exist for retries only. Reusing an id from another token replaces that row, and the insert-only user cannot detect it.

Record fields: `kind` (`note`, `video`, `tweet`, `post`, `page`, `selection`, any string), `via`, and `ts` and `tags` are required. `url`, `title`, `author`, `site`, `publishedAt`, `aboutId` (the `id` of the source a note is about), and `text` are optional. A record needs `text` or `url`. Full contract: `PLAN.md`.

## Extension

```sh
bun run extension:build
```

In Chrome, open `chrome://extensions`, turn on Developer mode, and load `apps/extension/dist`. Open the extension options and set the worker URL plus the token for the `chrome` identity.

`host_permissions` is `https://*/*` plus localhost because the worker hostname does not exist until you deploy. Narrow that list to the worker origin afterwards.

The popup saves the current page, or the selected text when there is a selection. It reads the page title, `og:title`, author, and published time from the page, sets `site` from the hostname, and infers `kind`: `youtube.com` is `video`, `x.com` and `twitter.com` are `tweet`, a selection is `selection`, anything else is `page`. `via` is always `chrome`.

## CLI

Put the Worker URL and one token per identity in `~/.config/herodotus/config.json`, mode `0600`:

```json
{
  "url": "https://herodotus-ingress.<account>.workers.dev",
  "tokens": { "you": "<token>", "pi": "<token>" }
}
```

`--as <identity>` (or `HERODOTUS_AS`) is required and has no default. It picks the token, and the Worker decides from the token whether the record is `human` or `agent`. `HERODOTUS_URL` overrides `url`.

```sh
bun run --filter @herodotus/cli ingest -- \
  --as you --kind note --text "ship the schema" --tag etl

bun run --filter @herodotus/cli ingest -- \
  --as pi --kind video --url https://www.youtube.com/watch?v=abc \
  --title "A talk" --author "A channel" --site youtube.com
```

`--kind` is required. `--text`, `--url`, `--title`, `--author`, `--site`, `--published-at` (ISO 8601), and `--about <id>` are optional. `--tag` can be repeated. `via` is always `cli`. Each run generates a new id and prints the id from the Worker response.

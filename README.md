# Herodotus

Save notes and sources—videos, tweets, posts, pages, selections—with human or agent attribution. A Cloudflare Worker accepts captures from the CLI and Chrome extension and inserts them into ClickHouse. There is no read API yet.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run extension:build
```

- `packages/schema`: request/response contract
- `apps/worker`: authentication, validation, ingestion
- `apps/cli`, `apps/extension`: capture clients
- `infra/alchemy.run.ts`: Cloudflare deployment
- `clickhouse`: schema and grants

## Database and secrets

Create a [ClickHouse Cloud](https://clickhouse.cloud) service and check its pricing. This setup needs **Allow from anywhere** because the Worker has no fixed egress IP; use strong credentials and monitor costs.

Run `clickhouse/migrations/001_records.sql`, create the database user `ingest`, then run `clickhouse/grants.sql`. Give that user only INSERT on `herodotus.records`, with no broader roles. Never give the Worker administrative credentials.

For deployment, put these in gitignored `infra/.env` (mode `0600`):

```dotenv
AUTH_TOKENS='{"you":{"token":"<human-token>","actor":"human"},"chrome":{"token":"<chrome-token>","actor":"human"},"pi":{"token":"<agent-token>","actor":"agent"}}'
CLICKHOUSE_URL=https://YOUR-SERVICE.clickhouse.cloud:8443
CLICKHOUSE_USER=ingest
CLICKHOUSE_PASSWORD='<password>'
CLICKHOUSE_DATABASE=herodotus
```

Tokens must be distinct. Alchemy uploads these values as Worker secrets. For local development, copy `apps/worker/.dev.vars.example` to gitignored `apps/worker/.dev.vars`, fill it in, and run `bun run --filter @herodotus/worker dev`.

Authenticate Alchemy with the intended Cloudflare account, then deploy from `infra`:

```sh
cd infra
bun run alchemy deploy --stage prod --dry-run
bun run alchemy deploy --stage prod
```

The Worker is `herodotus-ingress`. Keep the same stage and working directory for future deployments; preserve `.alchemy` deployment state securely. Verify both `/health` and a real insert. Test a burst of authenticated POSTs to confirm the rate limiter returns 429 (configured for 60 requests per minute per identity, per Cloudflare location).

## Records

`POST /v1/records` takes `{"schemaVersion":1,"records":[...]}` with `Authorization: Bearer <token>`. Required record fields: `kind`, `via`, `tags`, `ts`. Optional: `id`, `url`, `text`, `title`, `author`, `site`, `publishedAt`, `aboutId`. A record needs text or a URL; `aboutId` links a note to another record.

The Worker stamps `actor` and `agent` from the token. Requests setting either are rejected. `kind` and `via` are free strings. See `packages/schema/src/contract.ts` for validation and limits.

Reuse `id` and `ts` on retry. There is no URL deduplication or edit API; reusing an ID can replace a record. ClickHouse replacement is confined to one month and happens during merges; reads needing deduplication use `FINAL`.

## CLI

Create `~/.config/herodotus/config.json` with mode `0600`:

```json
{
  "url": "https://herodotus-ingress.<account>.workers.dev",
  "tokens": { "you": "<human-token>", "pi": "<agent-token>" }
}
```

```sh
bun run --filter @herodotus/cli ingest -- \
  --as you --kind note --text "ship the schema" --tag etl
```

`--as` (or `HERODOTUS_AS`) is mandatory. `HERODOTUS_URL` overrides the configured URL. Optional flags: `--url`, `--text`, `--title`, `--author`, `--site`, `--published-at`, `--about`, and repeated `--tag`. Agents use their own identity/token; `via` is always `cli`.

## Chrome extension

Build with `bun run extension:build`, enable Developer mode at `chrome://extensions`, and load `apps/extension/dist`. Set the Worker URL and Chrome token in its options. Narrow `host_permissions` in `apps/extension/src/manifest.json` to the Worker origin, then rebuild and reload.

The popup captures the URL, selected text, and basic page metadata; it infers video/tweet/page/selection from the hostname and selection. Overlong optional metadata is truncated. While the popup stays open, a failed save can retry the same capture with its original ID and timestamp.

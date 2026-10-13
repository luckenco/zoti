# Herodotus

Save notes and sources—videos, tweets, posts, pages, selections—with human or agent attribution. A Cloudflare Worker accepts captures from the CLI and Chrome extension and upserts them into MotherDuck. There is no read API yet.

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
- `duckdb`: records table

## Database and secrets

Create a [MotherDuck](https://motherduck.com) database named `herodotus` and run `duckdb/migrations/001_records.sql` while connected to it. Create a read/write access token. MotherDuck does not offer an insert-only token. The Worker sends one upsert and nothing else. Use `pg.us-east-1-aws.motherduck.com` for a US organization, or `pg.eu-central-1-aws.motherduck.com` for an EU organization. The Worker connects on port 5432 with `sslmode=require`.

The handler calls `ItemStore.put`. `motherDuckLayer` is the only code that opens MotherDuck. A later move to DuckDB on your own machines replaces that layer and runs the same SQL.

For deployment, put these in gitignored `infra/.env` (mode `0600`):

```dotenv
AUTH_TOKENS='{"you":{"token":"<human-token>","actor":"human"},"chrome":{"token":"<chrome-token>","actor":"human"},"pi":{"token":"<agent-token>","actor":"agent"}}'
MOTHERDUCK_HOST=pg.us-east-1-aws.motherduck.com
MOTHERDUCK_DATABASE=herodotus
MOTHERDUCK_TOKEN='<read-write token>'
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

Reuse `id` and `ts` on retry. There is no URL deduplication or edit API. Sending the same id again updates that one row, and `ingested_at` becomes the time of that write.

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

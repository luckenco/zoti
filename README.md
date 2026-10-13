# Herodotus

Save notes and sources—videos, tweets, posts, pages, selections—with human or agent attribution. A Cloudflare Worker accepts captures from the Chrome extension and upserts them into MotherDuck. The same Worker serves a remote MCP endpoint at `/mcp`.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run extension:build
```

- `packages/schema`: request/response contract
- `apps/worker`: authentication, validation, ingestion, MCP
- `apps/extension`: capture client
- `infra/alchemy.run.ts`: Cloudflare deployment
- `duckdb`: records table

## Database and secrets

Create a [MotherDuck](https://motherduck.com) database named `herodotus` and run `duckdb/migrations/001_records.sql` while connected to it, then `duckdb/migrations/002_consumed_at.sql`. On a database that already has the table, run only `002_consumed_at.sql`. It adds a nullable `consumed_at` and is safe to re-run. Create a read/write access token. Use `pg.us-east-1-aws.motherduck.com` for a US organization, or `pg.eu-central-1-aws.motherduck.com` for an EU organization.

For deployment, put these in gitignored `infra/.env` (mode `0600`):

```dotenv
AUTH_TOKENS='{"you":{"token":"<human-token>","actor":"human"},"chrome":{"token":"<chrome-token>","actor":"human"},"pi":{"token":"<agent-token>","actor":"agent"},"grokbot":{"token":"<grokbot-token>","actor":"agent"}}'
MOTHERDUCK_HOST=pg.us-east-1-aws.motherduck.com
MOTHERDUCK_DATABASE=herodotus
MOTHERDUCK_TOKEN='<read-write token>'
```

Tokens must be distinct. Alchemy uploads these values as Worker secrets. For local development, copy `apps/worker/.dev.vars.example` to gitignored `apps/worker/.dev.vars`, fill it in, and run `bun run --filter @herodotus/worker dev`.

Authenticate Alchemy with the intended Cloudflare account. Deployment state is remote. From `infra`, once, import the existing Worker into that store and confirm the prompt to deploy the state store:

```sh
cd infra
bun run alchemy deploy --stage prod --adopt
```

Later deploys omit `--adopt`:

```sh
bun run alchemy deploy --stage prod
```

The Worker is `herodotus-ingress`. Verify both `/health` and a real insert. Test a burst of authenticated POSTs to confirm the rate limiter returns 429 (60 requests per minute per identity, per Cloudflare location).

Pushes to `main` deploy `--stage prod`. Create the private GitHub repository, add `GITHUB_OWNER` and `GITHUB_REPOSITORY` to `infra/.env`, and create an `admin` profile with an API token or Global API Key that has Account API Tokens Write (not OAuth). That run also needs GitHub auth that can write Actions secrets. Then, from `infra`:

```sh
bun run alchemy profile create admin
bun run alchemy profile edit --profile admin
bun run alchemy deploy --config stacks/github.ts --profile admin --stage prod
```

That writes `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AUTH_TOKENS`, `MOTHERDUCK_HOST`, `MOTHERDUCK_DATABASE`, and `MOTHERDUCK_TOKEN` as Actions secrets.

## Records

`POST /v1/records` takes `{"schemaVersion":1,"records":[...]}` with `Authorization: Bearer <token>`. Required record fields: `kind`, `via`, `tags`, `ts`. Optional: `id`, `url`, `text`, `title`, `author`, `site`, `publishedAt`, `aboutId`. A record needs text or a URL. `aboutId` links a note to another record.

The Worker stamps `actor` and `agent` from the token. Requests that set either are rejected. `kind` and `via` are free strings. See `packages/schema/src/contract.ts` for validation and limits.

## MCP

`https://herodotus-ingress.cloudflare-swimming382.workers.dev/mcp` speaks stateless streamable HTTP. Send `Authorization: Bearer <token>`.

- `add_item` upserts one record with the same fields as `POST /v1/records`. `kind` is the type. `via` is the source.
- `search_items` filters by text contains, `tag`, `source` (`via`), `type` (`kind`), an inclusive `from`/`to` range on `ts`, and `unread` (`consumed_at` is null). `limit` defaults to 20 and cannot exceed 100.
- `recent_items` returns the newest records, with the same limit and `unread` filter.
- `mark_consumed` sets `consumed_at` to now for up to 100 ids. `consumed` defaults to true; pass false to clear it.

Reads include `consumedAt`. Upserting the same id does not change `consumed_at`. Run `002_consumed_at.sql` before deploying this Worker.

`grokbot` in `AUTH_TOKENS` above is that client: its own token, `"actor":"agent"`. Copy the same JSON into `apps/worker/.dev.vars` for local `wrangler dev`. Redeploy from `infra` with `bun run alchemy deploy --stage prod` so the Worker secret updates.

Reuse `id` and `ts` on retry. The same id updates that row.

## Chrome extension

Build with `bun run extension:build`, enable Developer mode at `chrome://extensions`, and load `apps/extension/dist`. Set the Worker URL and Chrome token in its options. Narrow `host_permissions` in `apps/extension/src/manifest.json` to the Worker origin, then rebuild and reload.

The popup captures the URL, selected text, and basic page metadata. It infers video, tweet, page, or selection from the hostname and selection. Overlong optional metadata is truncated. While the popup stays open, a failed save retries the same capture with its original id and timestamp.

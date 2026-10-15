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
- `duckdb`: schema migrations

## Database and secrets

Create a [MotherDuck](https://motherduck.com) database named `herodotus` and a read/write access token. Use `pg.us-east-1-aws.motherduck.com` for a US organization, or `pg.eu-central-1-aws.motherduck.com` for an EU organization. `bun run migrate` applies new files in `duckdb/migrations/` in order and records each filename in `schema_migrations`. Export `MOTHERDUCK_HOST`, `MOTHERDUCK_DATABASE`, and `MOTHERDUCK_TOKEN` first. Pushes to `main` run that command before the Worker deploy.

For deployment, put these in gitignored `infra/.env` (mode `0600`):

```dotenv
AUTH_TOKENS='{"you":{"token":"<human-token>","actor":"human"},"chrome":{"token":"<chrome-token>","actor":"human"},"pi":{"token":"<agent-token>","actor":"agent"},"grokbot":{"token":"<grokbot-token>","actor":"agent"}}'
MOTHERDUCK_HOST=pg.us-east-1-aws.motherduck.com
MOTHERDUCK_DATABASE=herodotus
MOTHERDUCK_TOKEN='<read-write token>'
ZOTERO_API_KEY='<zotero api key>'
ZOTERO_USER_ID='<zotero user id>'
```

Tokens must be distinct. Alchemy uploads these values as Worker secrets. For local development, copy `apps/worker/.dev.vars.example` to gitignored `apps/worker/.dev.vars`, fill it in, and run `bun run --filter @herodotus/worker dev`.

From `apps/worker`, put the Zotero secrets on the Worker:

```sh
bunx wrangler secret put ZOTERO_API_KEY
bunx wrangler secret put ZOTERO_USER_ID
```

GitHub is the source repository. Origin mirrors it. Pushes to `main` deploy production (`bun run alchemy deploy --stage prod` from `infra`) through GitHub Actions. The Worker is `herodotus-ingress`. Deployment state is remote.

To deploy by hand, authenticate Alchemy with the Cloudflare account, then from `infra`:

```sh
bun run alchemy deploy --stage prod
```

Verify both `/health` and a real insert. Test a burst of authenticated POSTs to confirm the rate limiter returns 429 (60 requests per minute per identity, per Cloudflare location).

### New account setup

On a new Cloudflare account, import the Worker once from `infra` with `bun run alchemy deploy --stage prod --adopt` and confirm the prompt to deploy the state store. To write Actions secrets, add `GITHUB_OWNER` and `GITHUB_REPOSITORY` to `infra/.env`, create an `admin` Alchemy profile with an API token or Global API Key that has Account API Tokens Write (not OAuth), and authenticate GitHub so it can write Actions secrets. From `infra`:

```sh
bun run alchemy profile create admin
bun run alchemy profile edit --profile admin
bun run alchemy deploy --config stacks/github.ts --profile admin --stage prod
```

That writes `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AUTH_TOKENS`, `MOTHERDUCK_HOST`, `MOTHERDUCK_DATABASE`, `MOTHERDUCK_TOKEN`, `ZOTERO_API_KEY`, and `ZOTERO_USER_ID` as Actions secrets.

## Records

`POST /v1/records` takes `{"schemaVersion":1,"records":[...]}` with `Authorization: Bearer <token>`. Required record fields: `kind`, `via`, `tags`, `ts`. Optional: `id`, `url`, `text`, `title`, `author`, `site`, `publishedAt`, `aboutId`. A record needs text or a URL. `aboutId` links a note to another record.

The Worker stamps `actor` and `agent` from the token. Requests that set either are rejected. `kind` and `via` are free strings. See `packages/schema/src/contract.ts` for validation and limits.

## MCP

`https://herodotus-ingress.cloudflare-swimming382.workers.dev/mcp` speaks stateless streamable HTTP. Send `Authorization: Bearer <token>`.

- `add_item` upserts one record with the same fields as `POST /v1/records`. `kind` is the type. `via` is the source.
- `search_items` filters by a case-insensitive substring of `text`, `title`, or `url`, plus `tag`, `source` (`via`), `type` (`kind`), an inclusive `from`/`to` range on `ts`, and `unread` (`consumed_at` is null). `limit` defaults to 20 and cannot exceed 100.
- `recent_items` returns the newest records, with the same limit and `unread` filter.
- `mark_consumed` sets `consumed_at` to now for up to 100 ids. `consumed` defaults to true; pass false to clear it.
- `send_to_zotero` files one record into Zotero as a webpage and stores `zoteroKey` and `zoteroUrl` on that row. Pass `id` to file an existing record, or `url` to insert a page and file it. The same id returns the stored link.
- `search_zotero` phrase-searches the Zotero library. `mode` `title` (default) matches title and creator. `everything` matches the whole item. `limit` defaults to 10 and cannot exceed 25.

Reads include `consumedAt`, `zoteroKey`, and `zoteroUrl`. Upserting the same id does not change `consumed_at`, `zotero_key`, or `zotero_url`.

`grokbot` in `AUTH_TOKENS` above is that client: its own token, `"actor":"agent"`. Copy the same JSON into `apps/worker/.dev.vars` for local `wrangler dev`. Redeploy from `infra` with `bun run alchemy deploy --stage prod` so the Worker secret updates.

Reuse `id` and `ts` on retry. The same id updates that row.

## Chrome extension

Build with `bun run extension:build`, enable Developer mode at `chrome://extensions`, and load `apps/extension/dist`. Set the Worker URL and Chrome token in its options. Narrow `host_permissions` in `apps/extension/src/manifest.json` to the Worker origin, then rebuild and reload.

The popup captures the URL, selected text, and basic page metadata. It infers video, tweet, page, or selection from the hostname and selection. Overlong optional metadata is truncated. While the popup stays open, a failed save retries the same capture with its original id and timestamp.

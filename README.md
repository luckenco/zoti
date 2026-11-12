# Zoti

A stateless Zotero MCP server on Cloudflare Workers. Save webpages, search your Zotero library, and assign items to collections directly—no database or browser extension.

## MCP

Endpoint: `https://zoti.cloudflare-swimming382.workers.dev/mcp`

Connect using streamable HTTP with `Authorization: Bearer <token>`.

- **`send_to_zotero`** saves a `url` as a Zotero webpage. Optional fields: `id` (UUID), `title`, `site`, `publishedAt` (UTC timestamp), `text` (title fallback), `tags`, and `collections` (up to 100 collection keys). Returns `id`, `zoteroKey`, and `zoteroUrl`.
- **`search_zotero`** searches top-level items. Omit `text` to browse. `mode` is `title` (title/creator/year, default) or `everything`. `limit` defaults to 10, maximum 25; `start` defaults to 0. Results include plain-text notes, attachment metadata (up to 100 children per item), and `nextStart`.
- **`list_zotero_collections`** lists collections, including nested collections. Returns `collections` with `key`, `name`, and `parentCollection` (`null` for roots), plus `nextStart`. `limit` defaults to 100, maximum 100; `start` defaults to 0. Follow `nextStart` until `null`; names may repeat, so use parent keys to disambiguate.
- **`add_to_zotero_collection`** adds an existing top-level item to a collection using `itemKey` and `collectionKey`. Use the item `key` from search or `zoteroKey` from save—not the UUID `id`. Returns `zoteroKey`, `zoteroUrl`, and the resulting `collections`. Preserves existing memberships and metadata; already-member calls do not write. Child items must be assigned via their parent. Version conflicts return an error; retry the tool to read the latest memberships before updating.

For safe retries, generate an `id` before saving and reuse it with the same payload. Zoti stores a `zoti:<id>` tag on the Zotero item and uses a stable write token. An existing tag returns the saved item without updating it. Pass `id` alone to recover a previously saved item. Omitting `id` generates a new one each time, so retrying without it can create duplicates.

To save into a collection, first call `list_zotero_collections`, then pass the selected keys as `collections` to `send_to_zotero`. Existing-id retries do not change collections; use `add_to_zotero_collection` instead. These tools use existing collections in the configured personal library; they do not create, rename, move, or delete collections.

Existing library items remain searchable. ID-only recovery applies to items tagged by Zoti; it does not look up records from the former capture database. Text is only used as a title fallback, not saved as a note.

Requests are limited to 60 per minute per client identity per Cloudflare location. Invalid tokens share an anonymous limit. `GET /health` is unauthenticated; all other non-MCP routes return 404.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# Fill in the secrets, then:
bun run dev
```

- `apps/worker`: MCP tools, Zotero client, authentication, and rate limiting.
- `infra`: Alchemy deployment and GitHub Actions secret setup.

After changing bindings, regenerate types:

```sh
cd apps/worker/src
bun run wrangler types --config ../wrangler.jsonc --include-runtime=false
```

## Secrets

Create a Zotero API key with read/write access to your personal library at https://www.zotero.org/settings/keys. That page also shows your numeric user ID.

For manual deployment, put these in gitignored `infra/.env` with mode `0600`:

```dotenv
AUTH_TOKENS='{"pi":{"token":"<long-random-token>"},"other-client":{"token":"<different-token>"}}'
ZOTERO_API_KEY='<read-write Zotero API key>'
ZOTERO_USER_ID='<numeric user ID>'
```

Client tokens must be nonempty and distinct. All clients access the same Zotero library. Alchemy uploads these values as Worker secrets. Local development uses `apps/worker/.dev.vars` instead; it still accesses the configured real Zotero library.

## Deployment

The GitHub repository is `luckenco/zoti`. Pushes to `main` run typechecks and tests, then deploy production through GitHub Actions. Manual workflow dispatch is also supported. The Worker and Alchemy stack are named `zoti`; deployment state is remote.

Authenticate Alchemy with your Cloudflare account, then deploy manually:

```sh
bun run deploy
```

For a new account, run from `infra` and approve state-store deployment when prompted:

```sh
bun alchemy deploy --stage prod
```

To provision Actions secrets, add `GITHUB_OWNER=luckenco` and `GITHUB_REPOSITORY=zoti` to `infra/.env`. Authenticate GitHub with permission to write Actions secrets, then create an Alchemy admin profile using an API token or Global API Key with Account API Tokens Write (not OAuth):

```sh
cd infra
bun alchemy profile create admin
bun alchemy profile edit --profile admin
bun alchemy deploy --config stacks/github.ts --profile admin --stage prod
```

This provisions `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AUTH_TOKENS`, `ZOTERO_API_KEY`, and `ZOTERO_USER_ID`.

Verify `/health`, an authenticated MCP `tools/list`, and `search_zotero` after deployment.

Zoti is independent of the Herodotus app in `../herodotus`. They serve different audiences: keep both deployments running. Zoti uses the `zoti` Worker/stack, `zoti-github` secrets-provisioning stack, and rate-limit namespace `1002`. Herodotus keeps its own repository, Worker, deployment state, secrets, and database. Deploying or removing Zoti must not retire Herodotus.

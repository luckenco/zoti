# Private-life ETL plan

Capture pages, selections, notes, and bookmarks into one ClickHouse table. A Cloudflare Worker is the only writer. A Chrome extension and a CLI are the first clients. Nothing in this repository is deployed, and no real credential is committed.

## Done when

All of the following are true on a clean checkout.

1. `pnpm typecheck` exits 0.
2. `pnpm test` exits 0. The suite includes the cases in [Tests](#tests).
3. `clickhouse/migrations/001_items.sql` creates `items` with the columns below, `ReplacingMergeTree`, an `ORDER BY` that ends in `id`, and a `PARTITION BY`.
4. `apps/worker`, `apps/cli`, and `apps/extension` import the item schema from `packages/schema`. They do not declare a second copy.
5. `infra/alchemy.run.ts` declares the Worker, its secrets, and a rate-limit binding. Running it is Cal's job.
6. A search of the tracked tree finds no bearer token, ClickHouse password, or `.dev.vars` file.

## Scope

In this scaffold:

- `packages/schema`, the versioned item contract and the error contract.
- `clickhouse/migrations` and a grants file for an insert-only user.
- `apps/worker`, the proxy.
- `apps/cli`, one command that posts the same contract.
- `apps/extension`, a Manifest V3 popup that posts the same contract.
- `infra/alchemy.run.ts`, Alchemy resources only.
- README with the steps Cal runs himself.

Out of this scaffold:

- A query API, a dashboard, or more sources.
- Deploying the Worker or creating the ClickHouse Cloud service.
- Any live credential.

## Data

One row is one captured item. `id` is the identity. A later insert with the same `id` and a `ts` in the same month replaces the earlier row. The version column is `ingested_at`.

Clients generate `id` with `crypto.randomUUID()` before the first POST. A retry sends that same `id` and the same `ts`. The Worker generates an id only when the client omits one, and then the client cannot retry safely, because it never learned the id if the insert failed.

`raw` is the JSON text of the item the client sent, plus the id the Worker settled on. Later columns can be added without a new client.

### Table

```sql
CREATE DATABASE IF NOT EXISTS private_life;

CREATE TABLE IF NOT EXISTS private_life.items
(
    id UUID,
    url Nullable(String),
    text String,
    type LowCardinality(String),
    source LowCardinality(String),
    tags Array(String),
    ts DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    raw String DEFAULT ''
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (id)
SETTINGS index_granularity = 8192;
```

`ingested_at` is `DateTime64(3, 'UTC')`. The brief wrote `DateTime64(3)` with no time zone. Both columns are UTC so a comparison does not mix server-local and UTC values. `now64(3)` matches the precision. `raw` defaults to empty so a manual insert still parses. The Worker always writes `raw`.

`ReplacingMergeTree` deduplicates inside one partition, and only after a merge. Two consequences:

- The same `id` with a `ts` in a different month stays as two rows. Clients keep `ts` stable across retries.
- A read can see both copies until ClickHouse merges them. Reads use `FINAL`. This scaffold has no read API.

`ORDER BY (id)` is the replacement key. A personal table does not need a wider sort key yet. Time filters can wait for a projection when a query exists.

### Insert-only user

`clickhouse/grants.sql` contains the grant and comments for creating the user in the ClickHouse Cloud console. It contains no password.

```sql
GRANT INSERT ON private_life.items TO ingest;
```

The Worker connects as `ingest`. That user cannot `SELECT` or `ALTER`.

## HTTP contract

`POST /v1/items`

Header `Authorization: Bearer <token>`.

Body, schema version 1:

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "id": "0f8fad5b-d9cb-469f-a165-70867728950e",
      "url": "https://example.com/post",
      "text": "the selected passage",
      "type": "selection",
      "source": "chrome",
      "tags": ["reading"],
      "ts": "2026-10-13T10:52:00.000Z"
    }
  ]
}
```

`id` may be omitted. `url` may be `null` or omitted, and both become SQL `NULL`. `text` is required and non-empty. `type` and `source` are non-empty strings up to 64 characters, not a closed enum, so a new capture kind does not need a migration. The extension sends `source` `chrome` and `type` `page` or `selection`. The CLI sends `source` `cli` unless `--source` is set.

Limits, enforced by the schema or the Worker before the insert:

- At most 100 items per request.
- `text` at most 100_000 characters.
- At most 32 tags, each at most 64 characters.
- `url` at most 2048 characters.
- Request body at most 1 MiB. Larger bodies return 413 and are not parsed.

Success is HTTP 201.

```json
{
  "schemaVersion": 1,
  "inserted": 1,
  "ids": ["0f8fad5b-d9cb-469f-a165-70867728950e"]
}
```

`GET /health` returns 200 `{"ok":true}` with no auth and no ClickHouse call. Any other path returns 404.

### Errors

Errors are `Data.TaggedError` values encoded as JSON. The schema package owns the struct so the CLI can decode it. The `_tag` is the discriminant.

| Status | `_tag` | When |
| --- | --- | --- |
| 400 | `InvalidBody` | JSON is not the version 1 request. `message` is the schema error. |
| 400 | `UnsupportedSchemaVersion` | `schemaVersion` is a number other than 1. |
| 401 | `Unauthorized` | Missing or unknown bearer token. |
| 413 | `PayloadTooLarge` | Body over 1 MiB. |
| 429 | `RateLimited` | Rate-limit binding returns `success: false`. `Retry-After: 60`. |
| 502 | `ClickHouseInsertFailed` | ClickHouse responds non-2xx. Body is the fixed string `ClickHouse insert failed` plus the HTTP status. The ClickHouse response body is logged, not returned. |
| 500 | `Misconfigured` | `AUTH_TOKENS` is not a JSON object of strings, or a ClickHouse setting is empty. |

Auth runs before schema validation of the items, after the body size check. An unauthenticated caller does not get a free schema oracle beyond the size cap. Version probing still happens only after auth, so an unknown token always gets 401.

## Worker path

```
fetch
  index.ts              map env bindings to Effect layers, catch defects as 500
  handler.ts            route, size cap, auth, rate limit, decode, insert, encode
  auth.ts               parse AUTH_TOKENS, SHA-256 then timingSafeEqual
  rate-limit.ts         call the binding with the client name as key
  clickhouse.ts         POST JSONEachRow through @effect/platform HttpClient
```

`handler.ts` is the program tests call. It returns `Effect<Response, never>`. Tagged errors become the JSON body inside that program. Tests assert status and body, and they assert the exact JSONEachRow text the ClickHouse layer received.

Auth secret `AUTH_TOKENS` is a JSON object from client name to token, for example `{"chrome":"...","cli":"..."}`. The Worker hashes the presented bearer token and each stored token with SHA-256, then compares digests with `crypto.subtle.timingSafeEqual`. It checks every configured token. The rate-limit key is the client name, never the token.

The rate-limit binding is `INGEST_RATE_LIMITER`, namespace id `1001`, 60 calls per 60 seconds. One HTTP request counts as one call, including a batch. The binding is per Cloudflare location and has had production reports of counters that fail open. The README tells Cal to send a burst after deploy and confirm a 429. Tests use a fake binding, so they do not claim the live counter works.

ClickHouse insert:

```
POST {CLICKHOUSE_URL}/?database={CLICKHOUSE_DATABASE}&date_time_input_format=best_effort
X-ClickHouse-User: {CLICKHOUSE_USER}
X-ClickHouse-Key: {CLICKHOUSE_PASSWORD}

INSERT INTO items FORMAT JSONEachRow
{"id":"...","url":"...","text":"...","type":"...","source":"...","tags":["..."],"ts":"...","raw":"..."}
```

`ingested_at` is omitted so the column default runs. `date_time_input_format=best_effort` accepts the ISO-8601 timestamp the schema encodes. Headers are `X-ClickHouse-User` and `X-ClickHouse-Key`. The password is not placed in the URL.

Services are Effect `Context.Tag`s. Live layers read the Worker env. Tests provide layers that record the insert and return a chosen rate-limit result. No module-level mutable request state.

`wrangler.jsonc` mirrors the bindings for local `wrangler dev` and `wrangler types`. `infra/alchemy.run.ts` is the deploy definition. Binding names live in one TypeScript module that both files' comments point at. A test does not import wrangler config. Cal updates both files together. That duplication is accepted for this scaffold because Alchemy does not generate the wrangler file in the path we will run in CI.

Compatibility date is `2026-10-13`. The `nodejs_compat` flag is on. Observability logs and traces are enabled in the wrangler file.

## Clients

The CLI is an Effect program using `@effect/platform` and `@effect/cli`.

```
private-life ingest --type note --text "ship the schema" --tag etl
```

It reads `PRIVATE_LIFE_URL` and `PRIVATE_LIFE_TOKEN`, generates an id, posts schema version 1, and prints the returned ids. `--url`, `--source`, and repeated `--tag` are optional. `--source` defaults to `cli`.

The extension is Manifest V3. The popup reads the active tab URL and title, and the current selection via `chrome.scripting.executeScript`. Saving posts `type` `page` or `selection` and `source` `chrome`. The options page stores the Worker URL and bearer token in `chrome.storage.local`. `esbuild` bundles the popup so it can import `packages/schema`. Host permission is `https://*/*` plus localhost, because the Worker hostname is not known until Cal deploys. The README says to narrow that to the Worker origin afterwards. `activeTab` and `scripting` cover reading the current page.

## Alchemy

`infra/alchemy.run.ts` uses the current Alchemy API (`alchemy/Cloudflare`, Effect `Config`).

- `Cloudflare.Worker` with `main` pointing at `apps/worker/src/index.ts`.
- `env.AUTH_TOKENS`, `env.CLICKHOUSE_URL`, `env.CLICKHOUSE_USER`, `env.CLICKHOUSE_PASSWORD`, and `env.CLICKHOUSE_DATABASE` from `Config.Redacted`, so deploy uploads them as secrets.
- `env.INGEST_RATE_LIMITER` from `Cloudflare.RateLimit` with namespace id `1001`, limit 60, period 60.

If the installed beta exports different names, the infra file follows the installed types. The resources stay the same. Deploy is not run.

## Repo layout

```
package.json
pnpm-workspace.yaml
tsconfig.base.json
vitest.config.ts
PLAN.md
README.md
decisions.tsv
packages/schema
apps/worker
apps/cli
apps/extension
infra
clickhouse/migrations/001_items.sql
clickhouse/grants.sql
```

pnpm workspaces. Each package has its own `package.json` and `tsconfig.json`. The schema package depends on `effect`. The Worker, CLI, and extension depend on the schema package via `workspace:*`.

## Tests

`@effect/vitest`. Each test calls the subject and asserts a literal result.

Schema:

- A valid one-item body decodes to the item fields, including the timestamp.
- `schemaVersion: 2` fails version decoding.
- Empty `text`, 101 items, and a non-UUID `id` fail decoding.

Worker, through the fetch handler with a fake ClickHouse and a fake rate limiter:

- A valid batch returns 201 and the recorded body is the two JSONEachRow lines, including `raw` and excluding `ingested_at`.
- The same `id` sent twice is forwarded twice, unchanged.
- A missing `id` is a UUID in the 201 body and in the inserted row.
- A wrong bearer token returns 401 and the fake ClickHouse receives no body.
- The rate limiter returning `success: false` returns 429 and `Retry-After: 60`.
- A non-2xx ClickHouse response returns 502 whose body does not contain the sentinel planted in the ClickHouse error body.
- `GET /health` returns 200 and does not call ClickHouse.

CLI:

- The ingest effect, pointed at a local mock server, posts a body that decodes as schema version 1 and prints the id from the mock's 201.

Extension:

- The pure capture builder returns a body that decodes as schema version 1 with `source` `chrome`.

ClickHouse, only if a local server or `clickhouse-local` can be installed without credentials. Apply `001_items.sql`, insert one JSONEachRow line, and `SELECT` it back with `FINAL`. If that binary is not available, record the skip in `decisions.tsv` and do not pretend the DDL was executed.

## Order of work

1. Commit this plan.
2. Review it and fold in the changes worth making.
3. Workspace toolchain, with `pnpm typecheck` and `pnpm test` as empty successes.
4. Schema package and its tests.
5. ClickHouse SQL, then the local apply check when a server exists.
6. Worker handler and its tests.
7. CLI and its test.
8. Extension and its test.
9. Alchemy file, README, and a final `pnpm test` plus `pnpm typecheck`.

Each step is committed only after its check passes. Later steps do not start on a red suite.

## Review notes

This section starts empty. The review pass appends what changed and what was declined.

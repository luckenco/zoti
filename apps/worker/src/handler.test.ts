import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import { authLayer } from "./auth"
import { handle, IdSource } from "./handler"
import { motherDuckLayer, type SqlSession } from "./motherduck"
import { rateLimitLayer, type RateLimitBinding } from "./rate-limit"
import type { SettledRow, SqlStatement } from "./sql"

const fixedId = "22222222-2222-4222-8222-222222222222"
const knownId = "0f8fad5b-d9cb-469f-a165-70867728950e"
const secondId = "11111111-1111-4111-8111-111111111111"
const tokens = JSON.stringify({
  chrome: { token: "chrome-token", actor: "human" },
  pi: { token: "pi-token", actor: "agent" },
})

const motherDuckConfig = {
  host: "pg.example.test",
  database: "herodotus",
  token: "test-password",
}

const conflict =
  "ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, via = EXCLUDED.via, actor = EXCLUDED.actor, agent = EXCLUDED.agent, url = EXCLUDED.url, title = EXCLUDED.title, author = EXCLUDED.author, site = EXCLUDED.site, published_at = EXCLUDED.published_at, about_id = EXCLUDED.about_id, text = EXCLUDED.text, tags = EXCLUDED.tags, ts = EXCLUDED.ts, raw = EXCLUDED.raw, ingested_at = now()"

const oneRowSql = `INSERT INTO herodotus.records (id, kind, via, actor, agent, url, title, author, site, published_at, about_id, text, tags, ts, raw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ${conflict}`

const twoRowSql = `INSERT INTO herodotus.records (id, kind, via, actor, agent, url, title, author, site, published_at, about_id, text, tags, ts, raw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15), ($16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30) ${conflict}`

const connectionString =
  "postgresql://postgres:test-password@pg.example.test:5432/herodotus?sslmode=require"

interface RecordedStatement {
  readonly connectionString: string
  readonly text: string
  readonly values: ReadonlyArray<unknown>
}

const post = (path: string, body: unknown, token = "chrome-token"): Request =>
  new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

const video = {
  id: knownId,
  kind: "video",
  via: "chrome",
  url: "https://www.youtube.com/watch?v=abc",
  title: "A talk",
  author: "A channel",
  site: "youtube.com",
  publishedAt: "2026-10-01T00:00:00.000Z",
  tags: ["reading"],
  ts: "2026-10-13T10:52:00.000Z",
}

const note = {
  id: secondId,
  kind: "note",
  via: "cli",
  text: "a note",
  aboutId: knownId,
  tags: ["etl"],
  ts: "2026-10-13T11:00:00.000Z",
  futureField: "keep-me",
}

const videoRow = (actor: string, agent: string | null) => ({
  id: knownId,
  kind: "video",
  via: "chrome",
  actor,
  agent,
  url: "https://www.youtube.com/watch?v=abc",
  title: "A talk",
  author: "A channel",
  site: "youtube.com",
  published_at: "2026-10-01T00:00:00.000Z",
  about_id: null,
  text: "",
  tags: ["reading"],
  ts: "2026-10-13T10:52:00.000Z",
  raw: JSON.stringify(video),
})

const noteRow = (actor: string, agent: string | null) => ({
  id: secondId,
  kind: "note",
  via: "cli",
  actor,
  agent,
  url: null,
  title: null,
  author: null,
  site: null,
  published_at: null,
  about_id: knownId,
  text: "a note",
  tags: ["etl"],
  ts: "2026-10-13T11:00:00.000Z",
  raw: JSON.stringify(note),
})

const bound = (row: SettledRow): ReadonlyArray<unknown> => [
  row.id,
  row.kind,
  row.via,
  row.actor,
  row.agent,
  row.url,
  row.title,
  row.author,
  row.site,
  row.published_at,
  row.about_id,
  row.text,
  row.tags,
  row.ts,
  row.raw,
]

const run = (options: {
  readonly request: Request
  readonly token?: string
  readonly database?: string
  readonly allow?: boolean
  readonly failMessage?: string
  readonly authTokens?: string
  readonly limiterThrows?: boolean
}) => {
  const recorded: Array<RecordedStatement> = []
  const closed: Array<string> = []
  const keys: Array<string> = []
  const logs: Array<string> = []
  const binding: RateLimitBinding = {
    limit: ({ key }) => {
      keys.push(key)
      if (options.limiterThrows) return Promise.reject(new Error("binding down"))
      return Promise.resolve({ success: options.allow ?? true })
    },
  }
  const open = (connectionString: string): Promise<SqlSession> =>
    Promise.resolve({
      query: (statement: SqlStatement) => {
        recorded.push({ connectionString, text: statement.text, values: statement.values })
        if (options.failMessage !== undefined) return Promise.reject(new Error(options.failMessage))
        return Promise.resolve()
      },
      close: () => {
        closed.push(connectionString)
        return Promise.resolve()
      },
    })
  const layer = Layer.mergeAll(
    authLayer(options.authTokens ?? tokens),
    rateLimitLayer(binding),
    motherDuckLayer({
      ...motherDuckConfig,
      token: options.token ?? motherDuckConfig.token,
      database: options.database ?? motherDuckConfig.database,
      open,
    }),
    Layer.succeed(IdSource, { next: Effect.succeed(fixedId) }),
  )

  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = console.error
      console.error = (message?: unknown) => {
        logs.push(String(message))
      }
      return original
    }),
    () =>
      handle(options.request).pipe(
        Effect.provide(layer),
        Effect.flatMap((response) =>
          Effect.promise(async () => ({
            status: response.status,
            body: await response.text(),
            retryAfter: response.headers.get("retry-after"),
            recorded,
            closed,
            keys,
            logs,
          })),
        ),
      ),
    (original) =>
      Effect.sync(() => {
        console.error = original
      }),
  )
}

const records = (...items: ReadonlyArray<unknown>) => ({ schemaVersion: 1, records: items })

describe("worker handler", () => {
  it.effect("upserts a batch by id, stamped human", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video, note)) })
      assert.equal(result.status, 201)
      assert.equal(
        result.body,
        JSON.stringify({ schemaVersion: 1, inserted: 2, ids: [knownId, secondId] }),
      )
      assert.equal(result.recorded.length, 1)
      const sent = result.recorded[0]
      assert.ok(sent)
      assert.equal(sent.text, twoRowSql)
      assert.equal(sent.text.includes("ingested_at"), true)
      assert.equal(sent.text.startsWith("INSERT INTO herodotus.records (id, kind, via, actor, agent, url, title, author, site, published_at, about_id, text, tags, ts, raw)"), true)
      assert.deepEqual(sent.values, [...bound(videoRow("human", null)), ...bound(noteRow("human", null))])
      assert.equal(sent.connectionString, connectionString)
      assert.equal(sent.text.includes("test-password"), false)
      assert.deepEqual(result.closed, [connectionString])
      assert.deepEqual(result.keys, ["chrome"])
    }),
  )

  it.effect("stamps an agent token as actor agent with its identity name", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video), "pi-token") })
      assert.equal(result.status, 201)
      assert.equal(result.recorded[0]?.text, oneRowSql)
      assert.deepEqual(result.recorded[0]?.values, bound(videoRow("agent", "pi")))
      assert.deepEqual(result.keys, ["pi"])
    }),
  )

  it.effect("rejects a body that sets actor or agent", () =>
    Effect.gen(function* () {
      for (const forged of [{ actor: "human" }, { agent: "pi" }]) {
        const result = yield* run({ request: post("/v1/records", records({ ...video, ...forged }), "pi-token") })
        assert.equal(result.status, 400)
        assert.equal(
          result.body,
          JSON.stringify({ _tag: "InvalidBody", message: "actor and agent are set by the server" }),
        )
        assert.equal(result.recorded.length, 0)
      }
    }),
  )

  it.effect("rejects a record with neither text nor url", () =>
    Effect.gen(function* () {
      const { url: _url, ...withoutUrl } = video
      const result = yield* run({ request: post("/v1/records", records(withoutUrl)) })
      assert.equal(result.status, 400)
      assert.equal(result.body.includes("a record needs text or url"), true)
      assert.equal(result.recorded.length, 0)
    }),
  )

  it.effect("forwards the same id twice", () =>
    Effect.gen(function* () {
      const first = yield* run({ request: post("/v1/records", records(video)) })
      const second = yield* run({ request: post("/v1/records", records(video)) })
      assert.equal(first.status, 201)
      assert.equal(second.status, 201)
      assert.deepEqual(first.recorded[0]?.values, second.recorded[0]?.values)
      assert.equal(first.recorded[0]?.text, oneRowSql)
      assert.equal(first.body, JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [knownId] }))
    }),
  )

  it.effect("fills a missing id", () =>
    Effect.gen(function* () {
      const { id: _id, ...withoutId } = video
      const result = yield* run({ request: post("/v1/records", records(withoutId)) })
      assert.equal(result.status, 201)
      assert.equal(result.body, JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [fixedId] }))
      assert.equal(result.recorded[0]?.text, oneRowSql)
      assert.deepEqual(
        result.recorded[0]?.values,
        bound({
          ...videoRow("human", null),
          id: fixedId,
          raw: JSON.stringify({ ...withoutId, id: fixedId }),
        }),
      )
    }),
  )

  it.effect("rejects an unknown bearer token", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video), "nope") })
      assert.equal(result.status, 401)
      assert.equal(result.body, JSON.stringify({ _tag: "Unauthorized" }))
      assert.equal(result.recorded.length, 0)
      assert.deepEqual(result.closed, [])
      assert.deepEqual(result.keys, ["anonymous"])
    }),
  )

  it.effect("returns 429 when the limiter refuses", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video)), allow: false })
      assert.equal(result.status, 429)
      assert.equal(result.body, JSON.stringify({ _tag: "RateLimited" }))
      assert.equal(result.retryAfter, "60")
      assert.equal(result.recorded.length, 0)
      assert.deepEqual(result.keys, ["chrome"])
    }),
  )

  it.effect("hides the database error", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/records", records(video)),
        failMessage: "SENTINEL_MD_ERROR test-password",
      })
      assert.equal(result.status, 502)
      assert.equal(result.body, JSON.stringify({ _tag: "StoreWriteFailed" }))
      assert.equal(result.body.includes("SENTINEL_MD_ERROR"), false)
      assert.equal(result.logs.some((line) => line.includes("SENTINEL_MD_ERROR")), true)
      assert.equal(result.logs.some((line) => line.includes("test-password")), false)
      assert.deepEqual(result.closed, [connectionString])
    }),
  )

  it.effect("answers health without the database", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: new Request("https://worker.example/health") })
      assert.equal(result.status, 200)
      assert.equal(result.body, JSON.stringify({ ok: true }))
      assert.equal(result.recorded.length, 0)
      assert.deepEqual(result.closed, [])
      assert.deepEqual(result.keys, [])
    }),
  )

  it.effect("rejects schema version 2", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", { schemaVersion: 2, records: [video] }) })
      assert.equal(result.status, 400)
      assert.equal(result.body, JSON.stringify({ _tag: "UnsupportedSchemaVersion", schemaVersion: 2 }))
      assert.equal(result.recorded.length, 0)
    }),
  )

  it.effect("rejects 101 records before a full decode", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/records", records(...Array.from({ length: 101 }, () => ({ text: "x" })))),
      })
      assert.equal(result.status, 400)
      assert.equal(result.body, JSON.stringify({ _tag: "InvalidBody", message: "at most 100 records" }))
      assert.equal(result.recorded.length, 0)
    }),
  )

  it.effect("rejects an empty token before connect", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video)), token: "" })
      assert.equal(result.status, 500)
      assert.equal(result.body, JSON.stringify({ _tag: "Misconfigured", message: "MOTHERDUCK_TOKEN is empty" }))
      assert.equal(result.recorded.length, 0)
      assert.deepEqual(result.closed, [])
    }),
  )

  it.effect("encodes a token that would break the connection string", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video)), token: "p@ss/word" })
      assert.equal(result.status, 201)
      assert.equal(
        result.recorded[0]?.connectionString,
        "postgresql://postgres:p%40ss%2Fword@pg.example.test:5432/herodotus?sslmode=require",
      )
      assert.equal(result.recorded[0]?.text.includes("p@ss/word"), false)
    }),
  )

  it.effect("rejects duplicate tokens without attributing or inserting records", () =>
    Effect.gen(function* () {
      for (const actors of [["human", "agent"], ["agent", "human"], ["agent", "agent"]]) {
        const result = yield* run({
          request: post("/v1/records", records(video), "shared-secret"),
          authTokens: JSON.stringify({
            first: { token: "shared-secret", actor: actors[0] },
            second: { token: "shared-secret", actor: actors[1] },
          }),
        })
        assert.equal(result.status, 500)
        assert.equal(
          result.body,
          JSON.stringify({ _tag: "Misconfigured", message: "AUTH_TOKENS tokens must be unique" }),
        )
        assert.equal(result.recorded.length, 0)
        assert.deepEqual(result.keys, [])
        assert.deepEqual(result.logs, [])
      }
    }),
  )

  it.effect("returns 500 when an AUTH_TOKENS actor is invalid", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/records", records(video)),
        authTokens: JSON.stringify({ chrome: { token: "chrome-token", actor: "robot" } }),
      })
      assert.equal(result.status, 500)
      assert.equal(
        result.body,
        JSON.stringify({ _tag: "Misconfigured", message: "AUTH_TOKENS actor must be human or agent" }),
      )
      assert.equal(result.recorded.length, 0)
    }),
  )
})

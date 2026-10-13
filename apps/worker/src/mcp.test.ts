import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import { authLayer, type Identity } from "./auth"
import { authorize, IdSource } from "./handler"
import { workerFetch } from "./index"
import { addItem, markConsumedItems, recentItems, searchItems } from "./mcp-tools"
import { motherDuckLayer, type SqlSession } from "./motherduck"
import { rateLimitLayer, type RateLimitBinding } from "./rate-limit"
import { insertRecords, markConsumed, recentRecords, searchRecords, type SqlStatement } from "./sql"

const fixedId = "22222222-2222-4222-8222-222222222222"
const knownId = "0f8fad5b-d9cb-469f-a165-70867728950e"
const secondId = "11111111-1111-4111-8111-111111111111"
const mcpUrl = "https://herodotus-ingress.cloudflare-swimming382.workers.dev/mcp"
const grokbot: Identity = { name: "grokbot", actor: "agent" }
const tokens = JSON.stringify({
  chrome: { token: "chrome-token", actor: "human" },
  grokbot: { token: "grokbot-token", actor: "agent" },
})

const note = {
  kind: "note",
  via: "grok",
  text: "hello",
  tags: ["mcp"],
  ts: "2026-10-13T10:52:00.000Z",
  futureField: "keep-me",
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext

const textOf = (result: { readonly content: ReadonlyArray<unknown>; readonly isError?: boolean }): string => {
  const block = result.content[0]
  assert.ok(block && typeof block === "object" && "text" in block && typeof block.text === "string")
  return block.text
}

const harness = (rows: ReadonlyArray<Record<string, unknown>> = []) => {
  const recorded: Array<SqlStatement> = []
  const closed: Array<string> = []
  const open = (_connectionString: string): Promise<SqlSession> =>
    Promise.resolve({
      query: (statement) => {
        recorded.push(statement)
        return Promise.resolve(rows)
      },
      close: () => {
        closed.push("closed")
        return Promise.resolve()
      },
    })
  const layer = Layer.mergeAll(
    motherDuckLayer({
      host: "pg.example.test",
      database: "herodotus",
      token: "test-password",
      open,
    }),
    Layer.succeed(IdSource, { next: Effect.succeed(fixedId) }),
  )
  return { recorded, closed, layer }
}

describe("mcp tools", () => {
  it.effect("add_item upserts through the same statement as record ingest", () =>
    Effect.gen(function* () {
      const { recorded, closed, layer } = harness()
      const result = yield* addItem(note, grokbot).pipe(Effect.provide(layer))
      assert.equal(result.isError, undefined)
      assert.equal(textOf(result), JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [fixedId] }))
      const sent = recorded[0]
      assert.ok(sent)
      const raw = JSON.parse(String(sent.values[14]))
      assert.deepEqual(raw, { ...note, id: fixedId })
      const expected = insertRecords("herodotus", [
        {
          id: fixedId,
          kind: "note",
          via: "grok",
          actor: "agent",
          agent: "grokbot",
          url: null,
          title: null,
          author: null,
          site: null,
          published_at: null,
          about_id: null,
          text: "hello",
          tags: ["mcp"],
          ts: "2026-10-13T10:52:00.000Z",
          raw: JSON.stringify(raw),
        },
      ])
      assert.equal(sent.text, expected.text)
      assert.equal(sent.text.includes("consumed_at"), false)
      assert.deepEqual(sent.values, expected.values)
      assert.deepEqual(closed, ["closed"])
    }),
  )

  it.effect("reuses a caller id and refuses actor, agent, and empty content", () =>
    Effect.gen(function* () {
      const { recorded, layer } = harness()
      const saved = yield* addItem({ ...note, id: knownId }, { name: "you", actor: "human" }).pipe(Effect.provide(layer))
      assert.equal(textOf(saved), JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [knownId] }))
      assert.equal(recorded[0]?.values[3], "human")
      assert.equal(recorded[0]?.values[4], null)
      assert.equal(
        textOf(yield* addItem({ ...note, actor: "agent" }, grokbot).pipe(Effect.provide(layer))),
        "actor and agent are set by the server",
      )
      assert.equal(
        textOf(yield* addItem({ ...note, agent: "grokbot" }, grokbot).pipe(Effect.provide(layer))),
        "actor and agent are set by the server",
      )
      const { text: _text, ...withoutText } = note
      assert.equal(
        textOf(yield* addItem(withoutText, grokbot).pipe(Effect.provide(layer))),
        "a record needs text or url",
      )
      assert.equal(recorded.length, 1)
    }),
  )

  it.effect("search_items binds filters and keeps the statement fixed", () =>
    Effect.gen(function* () {
      const { recorded, layer } = harness([
        {
          id: knownId,
          kind: "video",
          via: "chrome",
          actor: "human",
          agent: null,
          url: null,
          title: null,
          author: null,
          site: null,
          published_at: null,
          about_id: null,
          text: "the selected passage",
          tags: '["reading"]',
          ts: new Date("2026-10-13T10:52:00.000Z"),
        },
      ])
      const payload = "'; DROP TABLE records; --"
      const result = yield* searchItems({
        text: payload,
        tag: "reading",
        source: "chrome",
        type: "video",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-13T00:00:00.000Z",
        limit: 100,
      }).pipe(Effect.provide(layer))
      const sent = recorded[0]
      assert.ok(sent)
      const expected = searchRecords("herodotus", {
        text: payload,
        tag: "reading",
        via: "chrome",
        kind: "video",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-13T00:00:00.000Z",
        limit: 100,
        unread: false,
      })
      assert.equal(sent.text, expected.text)
      assert.deepEqual(sent.values, expected.values)
      assert.equal(sent.text.includes(payload), false)
      assert.equal(sent.text.includes("SELECT"), true)
      assert.deepEqual(JSON.parse(textOf(result)), {
        records: [
          {
            id: knownId,
            kind: "video",
            via: "chrome",
            actor: "human",
            agent: null,
            url: null,
            title: null,
            author: null,
            site: null,
            publishedAt: null,
            aboutId: null,
            text: "the selected passage",
            tags: ["reading"],
            ts: "2026-10-13T10:52:00.000Z",
            consumedAt: null,
          },
        ],
      })
    }),
  )

  it.effect("omits an empty text filter and defaults the limit", () =>
    Effect.gen(function* () {
      const { recorded, layer } = harness([])
      yield* searchItems({ text: "" }).pipe(Effect.provide(layer))
      assert.deepEqual(
        recorded[0]?.values,
        searchRecords("herodotus", {
          text: null,
          tag: null,
          via: null,
          kind: null,
          from: null,
          to: null,
          limit: 20,
          unread: false,
        }).values,
      )
      yield* recentItems({}).pipe(Effect.provide(layer))
      assert.deepEqual(recorded[1], recentRecords("herodotus", 20))
    }),
  )

  it.effect("rejects a limit above 100 and a sql argument before opening the database", () =>
    Effect.gen(function* () {
      const { recorded, closed, layer } = harness()
      const limited = yield* searchItems({ limit: 101 }).pipe(Effect.provide(layer))
      const recent = yield* recentItems({ limit: 0 }).pipe(Effect.provide(layer))
      const injected = yield* searchItems({ sql: "select 1" }).pipe(Effect.provide(layer))
      assert.equal(limited.isError, true)
      assert.equal(recent.isError, true)
      assert.equal(injected.isError, true)
      assert.equal(recorded.length, 0)
      assert.deepEqual(closed, [])
    }),
  )

  it.effect("hides a malformed read", () =>
    Effect.gen(function* () {
      const { closed, layer } = harness([{ id: knownId }])
      const result = yield* recentItems({ limit: 1 }).pipe(Effect.provide(layer))
      assert.equal(result.isError, true)
      assert.equal(textOf(result), "store failed")
      assert.deepEqual(closed, ["closed"])
    }),
  )

  it.effect("marks ids consumed and can clear them", () =>
    Effect.gen(function* () {
      const { recorded, layer } = harness([{ id: knownId }])
      const marked = yield* markConsumedItems({ ids: [knownId] }).pipe(Effect.provide(layer))
      assert.equal(textOf(marked), JSON.stringify({ consumed: true, ids: [knownId] }))
      assert.deepEqual(recorded[0], markConsumed("herodotus", [knownId], true))
      yield* markConsumedItems({ ids: [knownId, secondId], consumed: false }).pipe(Effect.provide(layer))
      assert.deepEqual(recorded[1], markConsumed("herodotus", [knownId, secondId], false))
      assert.equal(recorded[0]?.text.includes(knownId), false)
    }),
  )

  it.effect("rejects a bad consumed id list before opening the database", () =>
    Effect.gen(function* () {
      const { recorded, closed, layer } = harness()
      const empty = yield* markConsumedItems({ ids: [] }).pipe(Effect.provide(layer))
      const tooMany = yield* markConsumedItems({
        ids: Array.from({ length: 101 }, () => knownId),
      }).pipe(Effect.provide(layer))
      const bad = yield* markConsumedItems({ ids: ["not-a-uuid"] }).pipe(Effect.provide(layer))
      const injected = yield* markConsumedItems({ ids: [knownId], sql: "update records set text = ''" }).pipe(
        Effect.provide(layer),
      )
      assert.equal(empty.isError, true)
      assert.equal(tooMany.isError, true)
      assert.equal(bad.isError, true)
      assert.equal(injected.isError, true)
      assert.equal(recorded.length, 0)
      assert.deepEqual(closed, [])
    }),
  )

  it.effect("filters unread records with consumed_at IS NULL", () =>
    Effect.gen(function* () {
      const { recorded, layer } = harness([])
      yield* searchItems({ unread: true, limit: 5 }).pipe(Effect.provide(layer))
      const expected = searchRecords("herodotus", {
        text: null,
        tag: null,
        via: null,
        kind: null,
        from: null,
        to: null,
        limit: 5,
        unread: true,
      })
      assert.deepEqual(recorded[0], expected)
      assert.equal(expected.text.includes("consumed_at IS NULL"), true)
      yield* recentItems({ unread: true, limit: 5 }).pipe(Effect.provide(layer))
      assert.deepEqual(recorded[1], recentRecords("herodotus", 5, true))
    }),
  )
})

describe("mcp endpoint", () => {
  const binding = (allow: boolean, keys: Array<string>): RateLimitBinding => ({
    limit: ({ key }) => {
      keys.push(key)
      return Promise.resolve({ success: allow })
    },
  })

  const call = (request: Request, allow = true) => {
    const keys: Array<string> = []
    const env = {
      AUTH_TOKENS: tokens,
      MOTHERDUCK_HOST: "not a host",
      MOTHERDUCK_DATABASE: "herodotus",
      MOTHERDUCK_TOKEN: "test-password",
      INGEST_RATE_LIMITER: binding(allow, keys),
    }
    return Effect.gen(function* () {
      const response = yield* workerFetch(request, env, ctx)
      return { status: response.status, body: yield* Effect.promise(() => response.text()), keys, retryAfter: response.headers.get("retry-after") }
    })
  }

  it.effect("requires a bearer token and does not treat /mcp as the records route", () =>
    Effect.gen(function* () {
      const missing = yield* call(new Request(mcpUrl, { method: "POST", body: "{}" }))
      assert.equal(missing.status, 401)
      assert.equal(missing.body, JSON.stringify({ _tag: "Unauthorized" }))
      assert.deepEqual(missing.keys, ["anonymous"])
      const admitted = yield* authorize("Bearer grokbot-token").pipe(
        Effect.provide(Layer.mergeAll(authLayer(tokens), rateLimitLayer(binding(true, [])))),
      )
      assert.deepEqual(admitted, grokbot)
    }),
  )

  it.effect("rate limits /mcp with the ingest limiter", () =>
    Effect.gen(function* () {
      const result = yield* call(
        new Request(mcpUrl, { method: "POST", headers: { authorization: "Bearer grokbot-token" }, body: "{}" }),
        false,
      )
      assert.equal(result.status, 429)
      assert.equal(result.body, JSON.stringify({ _tag: "RateLimited" }))
      assert.equal(result.retryAfter, "60")
      assert.deepEqual(result.keys, ["grokbot"])
    }),
  )

  it.effect("lists add_item, search_items, and recent_items", () =>
    Effect.gen(function* () {
      const result = yield* call(
        new Request(mcpUrl, {
          method: "POST",
          headers: {
            authorization: "Bearer grokbot-token",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            host: "herodotus-ingress.cloudflare-swimming382.workers.dev",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        }),
      )
      assert.equal(result.status, 200)
      const data = result.body.split("\n").find((line) => line.startsWith("data: "))
      assert.ok(data)
      const listed = JSON.parse(data.slice("data: ".length)) as {
        result: { tools: ReadonlyArray<{ name: string }> }
      }
      assert.deepEqual(
        listed.result.tools.map((tool) => tool.name),
        ["add_item", "search_items", "recent_items", "mark_consumed"],
      )
    }),
  )

  it.effect("leaves CORS preflight and health outside the bearer check", () =>
    Effect.gen(function* () {
      const preflight = yield* call(
        new Request(mcpUrl, {
          method: "OPTIONS",
          headers: { host: "herodotus-ingress.cloudflare-swimming382.workers.dev" },
        }),
      )
      assert.equal(preflight.status, 200)
      assert.deepEqual(preflight.keys, [])
      const health = yield* call(new Request("https://herodotus-ingress.cloudflare-swimming382.workers.dev/health"))
      assert.equal(health.status, 200)
      assert.equal(health.body, JSON.stringify({ ok: true }))
    }),
  )
})

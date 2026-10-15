import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { Effect, Layer, TestClock } from "effect"
import { authLayer, type Identity } from "./auth"
import { authorize, IdSource } from "./handler"
import { workerFetch } from "./index"
import { addItem, markConsumedItems, recentItems, searchItems, searchZotero, sendToZotero } from "./mcp-tools"
import { motherDuckLayer, type SqlSession } from "./motherduck"
import { rateLimitLayer, type RateLimitBinding } from "./rate-limit"
import { insertRecords, markConsumed, recentRecords, recordById, searchRecords, stampZotero, type SqlStatement } from "./sql"
import { zoteroLayer, type ZoteroCall, type ZoteroReply } from "./zotero"

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
          zotero_key: "ABCD2345",
          zotero_url: "https://www.zotero.org/users/1234567/items/ABCD2345",
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
            zoteroKey: "ABCD2345",
            zoteroUrl: "https://www.zotero.org/users/1234567/items/ABCD2345",
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
      ZOTERO_API_KEY: "test-zotero-key",
      ZOTERO_USER_ID: "1234567",
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
        ["add_item", "search_items", "recent_items", "mark_consumed", "send_to_zotero", "search_zotero"],
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

const zoteroUser = "1234567"
const zoteroApiKey = "test-zotero-key"
const zoteroKey = "ABCD2345"
const zoteroUrl = `https://www.zotero.org/users/${zoteroUser}/items/${zoteroKey}`
const postUrl = `https://api.zotero.org/users/${zoteroUser}/items`
const capturedAt = "2026-10-13T10:52:00.000Z"

const writeTokenOf = (id: string): string => id.replaceAll("-", "")

const tagUrl = (id: string): string =>
  `https://api.zotero.org/users/${zoteroUser}/items/top?format=json&itemType=webpage&limit=5&sort=dateAdded&direction=asc&tag=${encodeURIComponent(`herodotus:${id}`)}`

const authHeaders = [
  ["Zotero-API-Version", "3"],
  ["Zotero-API-Key", zoteroApiKey],
  ["Accept", "application/json"],
] as const

const postHeaders = (id: string) => [
  ...authHeaders,
  ["Content-Type", "application/json"],
  ["Zotero-Write-Token", writeTokenOf(id)],
]

const webpageBody = (id: string): string =>
  JSON.stringify([
    {
      itemType: "webpage",
      title: "The post",
      url: "https://example.com/post",
      date: "2026-10-01",
      accessDate: "2026-10-13",
      websiteTitle: "example.com",
      tags: [{ tag: "reading" }, { tag: `herodotus:${id}` }],
    },
  ])

const linkText = (id: string): string =>
  JSON.stringify({ id, zoteroKey, zoteroUrl })

const storedRow = (
  id: string,
  link: { readonly zotero_key: string | null; readonly zotero_url: string | null },
) => ({
  id,
  kind: "page",
  via: "chrome",
  actor: "human",
  agent: null,
  url: "https://example.com/post",
  title: "The post",
  author: null,
  site: "example.com",
  published_at: "2026-10-01T00:00:00.000Z",
  about_id: null,
  text: "",
  tags: '["reading"]',
  ts: capturedAt,
  consumed_at: null,
  zotero_key: link.zotero_key,
  zotero_url: link.zotero_url,
})

const stampedRow = [{ zotero_key: zoteroKey, zotero_url: zoteroUrl }]

const savedReply = (): ZoteroReply => ({
  status: 200,
  body: JSON.stringify({
    successful: {
      "0": {
        key: zoteroKey,
        links: { alternate: { href: zoteroUrl } },
      },
    },
  }),
  headers: [],
})

const emptyItems = (): ZoteroReply => ({ status: 200, body: "[]", headers: [] })

const taggedItem = (): ZoteroReply => ({
  status: 200,
  body: JSON.stringify([
    {
      key: zoteroKey,
      links: { alternate: { href: zoteroUrl } },
      data: {
        key: zoteroKey,
        itemType: "webpage",
        dateAdded: "2026-10-13T00:00:00Z",
        title: "The post",
      },
    },
  ]),
  headers: [],
})

const zoteroHarness = (
  queries: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
  replies: ReadonlyArray<ZoteroReply>,
) => {
  const recorded: Array<SqlStatement> = []
  const calls: Array<ZoteroCall> = []
  let queryIndex = 0
  const open = (_connectionString: string): Promise<SqlSession> =>
    Promise.resolve({
      query: (statement) => {
        recorded.push(statement)
        const rows = queries[queryIndex] ?? []
        queryIndex += 1
        return Promise.resolve(rows)
      },
      close: () => Promise.resolve(),
    })
  const exchange = (call: ZoteroCall): Promise<ZoteroReply> => {
    calls.push(call)
    return Promise.resolve(replies[calls.length - 1] ?? { status: 500, body: "unexpected", headers: [] })
  }
  const store = Layer.mergeAll(
    motherDuckLayer({
      host: "pg.example.test",
      database: "herodotus",
      token: "test-password",
      open,
    }),
    Layer.succeed(IdSource, { next: Effect.succeed(fixedId) }),
  )
  const layer = zoteroLayer({ apiKey: zoteroApiKey, userId: zoteroUser, exchange }).pipe(Layer.provideMerge(store))
  return { recorded, calls, layer }
}

const assertTagGet = (call: ZoteroCall | undefined, id: string) => {
  assert.ok(call)
  assert.equal(call.method, "GET")
  assert.equal(call.url, tagUrl(id))
  assert.equal(call.url.includes(zoteroApiKey), false)
  assert.deepEqual(call.headers, [...authHeaders])
  assert.equal(call.body, null)
}

const assertWebpagePost = (call: ZoteroCall | undefined, id: string) => {
  assert.ok(call)
  assert.equal(call.method, "POST")
  assert.equal(call.url, postUrl)
  assert.equal(call.url.includes(zoteroApiKey), false)
  assert.deepEqual(call.headers, postHeaders(id))
  assert.equal(call.body, webpageBody(id))
}

describe("zotero tools", () => {
  it.effect("send_to_zotero posts one webpage for an unlinked row", () =>
    Effect.gen(function* () {
      const { recorded, calls, layer } = zoteroHarness(
        [[storedRow(knownId, { zotero_key: null, zotero_url: null })], stampedRow],
        [emptyItems(), savedReply()],
      )
      const result = yield* sendToZotero({ id: knownId }, grokbot).pipe(Effect.provide(layer))
      assert.equal(result.isError, undefined)
      assert.equal(textOf(result), linkText(knownId))
      assert.equal(calls.length, 2)
      assertTagGet(calls[0], knownId)
      assertWebpagePost(calls[1], knownId)
      assert.deepEqual(recorded[0], recordById("herodotus", knownId))
      assert.deepEqual(
        recorded[1],
        stampZotero("herodotus", knownId, zoteroKey, zoteroUrl),
      )
      assert.equal(recorded.length, 2)
    }),
  )

  it.effect("send_to_zotero returns the stored link without calling Zotero", () =>
    Effect.gen(function* () {
      const { recorded, calls, layer } = zoteroHarness(
        [[storedRow(knownId, { zotero_key: zoteroKey, zotero_url: zoteroUrl })]],
        [],
      )
      const result = yield* sendToZotero({ id: knownId }, grokbot).pipe(Effect.provide(layer))
      assert.equal(textOf(result), linkText(knownId))
      assert.deepEqual(calls, [])
      assert.deepEqual(recorded, [recordById("herodotus", knownId)])
    }),
  )

  it.effect("send_to_zotero adopts the tagged item after a 412", () =>
    Effect.gen(function* () {
      const { recorded, calls, layer } = zoteroHarness(
        [[storedRow(knownId, { zotero_key: null, zotero_url: null })], stampedRow],
        [emptyItems(), { status: 412, body: "", headers: [] }, taggedItem()],
      )
      const result = yield* sendToZotero({ id: knownId }, grokbot).pipe(Effect.provide(layer))
      assert.equal(textOf(result), linkText(knownId))
      assert.deepEqual(
        calls.map((call) => call.method),
        ["GET", "POST", "GET"],
      )
      assertTagGet(calls[0], knownId)
      assertWebpagePost(calls[1], knownId)
      assertTagGet(calls[2], knownId)
      assert.equal(calls.filter((call) => call.method === "POST").length, 1)
      assert.deepEqual(recorded[1], stampZotero("herodotus", knownId, zoteroKey, zoteroUrl))
    }),
  )

  it.effect("send_to_zotero inserts a page via mcp when the url has no id", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(capturedAt)
      const input = {
        url: "https://example.com/post",
        title: "The post",
        site: "example.com",
        publishedAt: "2026-10-01T00:00:00.000Z",
        tags: ["reading"],
      }
      const { recorded, calls, layer } = zoteroHarness(
        [[], [storedRow(fixedId, { zotero_key: null, zotero_url: null })], stampedRow],
        [emptyItems(), savedReply()],
      )
      const result = yield* sendToZotero(input, grokbot).pipe(Effect.provide(layer))
      assert.equal(textOf(result), linkText(fixedId))
      assert.deepEqual(
        recorded[0],
        insertRecords("herodotus", [
          {
            id: fixedId,
            kind: "page",
            via: "mcp",
            actor: "agent",
            agent: "grokbot",
            url: "https://example.com/post",
            title: "The post",
            author: null,
            site: "example.com",
            published_at: "2026-10-01T00:00:00.000Z",
            about_id: null,
            text: "",
            tags: ["reading"],
            ts: capturedAt,
            raw: JSON.stringify({ ...input, id: fixedId }),
          },
        ]),
      )
      assert.deepEqual(recorded[1], recordById("herodotus", fixedId))
      assertWebpagePost(calls[1], fixedId)
      assert.equal(calls[0]?.method, "GET")
      assert.equal(calls.filter((call) => call.method === "POST").length, 1)
    }),
  )

  it.effect("send_to_zotero files the stored row when the url id already exists", () =>
    Effect.gen(function* () {
      const { recorded, calls, layer } = zoteroHarness(
        [[storedRow(knownId, { zotero_key: null, zotero_url: null })], stampedRow],
        [emptyItems(), savedReply()],
      )
      const result = yield* sendToZotero(
        {
          id: knownId,
          url: "https://example.com/ignored",
          title: "Ignored title",
          tags: ["other"],
        },
        grokbot,
      ).pipe(Effect.provide(layer))
      assert.equal(textOf(result), linkText(knownId))
      assert.equal(recorded.some((statement) => statement.text.startsWith("INSERT")), false)
      assert.deepEqual(recorded[0], recordById("herodotus", knownId))
      assertWebpagePost(calls[1], knownId)
    }),
  )

  it.effect("send_to_zotero returns record not found for an unknown id", () =>
    Effect.gen(function* () {
      const { recorded, calls, layer } = zoteroHarness([[]], [])
      const result = yield* sendToZotero({ id: knownId }, grokbot).pipe(Effect.provide(layer))
      assert.equal(result.isError, true)
      assert.equal(textOf(result), "record not found")
      assert.deepEqual(calls, [])
      assert.deepEqual(recorded, [recordById("herodotus", knownId)])
    }),
  )

  it.effect("search_zotero returns notes as plain text and attachment metadata", () =>
    Effect.gen(function* () {
      const top = [
        {
          key: zoteroKey,
          links: { alternate: { href: zoteroUrl } },
          data: {
            key: zoteroKey,
            itemType: "webpage",
            title: "The post",
            url: "https://example.com/post",
            date: "2026-10-01",
            tags: [{ tag: "reading" }, { tag: `herodotus:${knownId}` }],
          },
        },
      ]
      const children = [
        {
          key: "EFGH6789",
          data: { key: "EFGH6789", itemType: "note", note: "<p>a note</p>" },
        },
        {
          key: "IJKLM234",
          data: {
            key: "IJKLM234",
            itemType: "attachment",
            title: "PDF",
            filename: "paper.pdf",
            contentType: "application/pdf",
            url: "https://example.com/paper.pdf",
          },
        },
        {
          key: "MNPQ5678",
          data: { key: "MNPQ5678", itemType: "annotation", note: "drop me" },
        },
      ]
      const { recorded, calls, layer } = zoteroHarness(
        [],
        [
          { status: 200, body: JSON.stringify(top), headers: [["Total-Results", "1"]] },
          { status: 200, body: JSON.stringify(children), headers: [] },
        ],
      )
      const result = yield* searchZotero({ text: "The post" }).pipe(Effect.provide(layer))
      assert.equal(result.isError, undefined)
      assert.equal(
        textOf(result),
        JSON.stringify({
          items: [
            {
              key: zoteroKey,
              type: "webpage",
              title: "The post",
              url: "https://example.com/post",
              date: "2026-10-01",
              tags: ["reading", `herodotus:${knownId}`],
              zoteroUrl,
              notes: [{ key: "EFGH6789", text: "a note" }],
              attachments: [
                {
                  key: "IJKLM234",
                  title: "PDF",
                  filename: "paper.pdf",
                  contentType: "application/pdf",
                  url: "https://example.com/paper.pdf",
                },
              ],
            },
          ],
          nextStart: null,
        }),
      )
      assert.deepEqual(recorded, [])
      assert.equal(calls.length, 2)
      assert.equal(calls[0]?.method, "GET")
      assert.equal(
        calls[0]?.url,
        `https://api.zotero.org/users/${zoteroUser}/items/top?format=json&limit=10&q=The%20post&qmode=titleCreatorYear&start=0`,
      )
      assert.deepEqual(calls[0]?.headers, [...authHeaders])
      assert.equal(calls[0]?.url.includes(zoteroApiKey), false)
      assert.equal(calls[1]?.method, "GET")
      assert.equal(
        calls[1]?.url,
        `https://api.zotero.org/users/${zoteroUser}/items/${zoteroKey}/children?format=json&limit=100`,
      )
    }),
  )
})

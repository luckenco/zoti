import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { Effect, TestClock } from "effect"
import { vi } from "vitest"
import { addToZoteroCollection, listZoteroCollections, searchZotero, sendToZotero } from "./mcp-tools"
import { zoteroLayer, type ZoteroCall, type ZoteroReply } from "./zotero"

const id = "0f8fad5b-d9cb-469f-a165-70867728950e"
const key = "ABCD2345"
const collectionKey = "BCDE3456"
const otherCollection = "CDEF4567"
const apiKey = "test-zotero-key"
const base = "https://api.zotero.org/users/1234567"
const zoteroUrl = `https://www.zotero.org/users/1234567/items/${key}`
const capture = {
  id, url: "https://example.com/post", title: "The post", site: "example.com",
  publishedAt: "2026-10-01T00:00:00.000Z", tags: ["reading"],
  collections: [collectionKey],
}
const tagged = [{ key, data: { itemType: "webpage", dateAdded: "2026-10-13T00:00:00Z" } }]
const reply = (body: unknown, status = 200): ZoteroReply => ({ status, body: JSON.stringify(body), headers: [] })
const saved = reply({ successful: { "0": { key } } })

const harness = (replies: ZoteroReply[]) => {
  const calls: ZoteroCall[] = []
  const layer = zoteroLayer({
    apiKey, userId: "1234567",
    exchange: async (call) => {
      calls.push(call)
      const response = replies[calls.length - 1]
      assert.ok(response, "unexpected Zotero request")
      return response
    },
  })
  return { calls, layer }
}

const textOf = (result: { content: readonly unknown[] }): string => {
  const block = result.content[0]
  assert.ok(block && typeof block === "object" && "text" in block && typeof block.text === "string")
  return block.text
}

describe("send_to_zotero", () => {
  it.effect("saves directly to Zotero with metadata and a stable retry token", () => Effect.gen(function* () {
    yield* TestClock.setTime("2026-10-13T10:52:00.000Z")
    const { calls, layer } = harness([reply([]), saved])
    const result = yield* sendToZotero(capture).pipe(Effect.provide(layer))
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(textOf(result)), { id, zoteroKey: key, zoteroUrl })
    assert.equal(calls[0]?.url, `${base}/items/top?format=json&itemType=webpage&limit=5&sort=dateAdded&direction=asc&tag=zoti%3A${id}`)
    const post = calls[1]
    assert.ok(post)
    assert.equal(post.method, "POST")
    assert.equal(post.url, `${base}/items`)
    assert.deepEqual(post.headers, [
      ["Zotero-API-Version", "3"], ["Zotero-API-Key", apiKey], ["Accept", "application/json"],
      ["Content-Type", "application/json"], ["Zotero-Write-Token", id.replaceAll("-", "")],
    ])
    assert.deepEqual(JSON.parse(post.body ?? ""), [{
      itemType: "webpage", title: "The post", url: capture.url, date: "2026-10-01",
      accessDate: "2026-10-13", websiteTitle: "example.com", tags: [{ tag: "reading" }, { tag: `zoti:${id}` }],
      collections: [collectionKey],
    }])
    assert.equal(calls.length, 2)
  }))

  it.effect("generates an id and uses text as a title fallback", () => Effect.gen(function* () {
    const { calls, layer } = harness([reply([]), saved])
    const result = yield* sendToZotero({ url: capture.url, text: "First line\nSecond line" }).pipe(Effect.provide(layer))
    const link = JSON.parse(textOf(result))
    assert.match(link.id, /^[0-9a-f-]{36}$/)
    assert.equal(JSON.parse(calls[1]?.body ?? "")[0].title, "First line")
    assert.ok(calls[0]?.url.includes(link.id))
    assert.ok(calls[1]?.body?.includes(`zoti:${link.id}`))
  }))

  it.effect("reuses a tagged item for both id-only and full-payload retries", () => Effect.gen(function* () {
    for (const input of [{ id }, capture, { ...capture, collections: [otherCollection] }]) {
      const { calls, layer } = harness([reply(tagged)])
      const result = yield* sendToZotero(input).pipe(Effect.provide(layer))
      assert.deepEqual(JSON.parse(textOf(result)), { id, zoteroKey: key, zoteroUrl })
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.method, "GET")
    }
  }))

  it.effect("recovers a concurrent write after a 412 without posting again", () => Effect.gen(function* () {
    const { calls, layer } = harness([reply([]), reply({}, 412), reply(tagged)])
    const result = yield* sendToZotero(capture).pipe(Effect.provide(layer))
    assert.deepEqual(JSON.parse(textOf(result)), { id, zoteroKey: key, zoteroUrl })
    assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET"])
  }))

  it.effect("does not create an item for an unknown id-only request", () => Effect.gen(function* () {
    const { calls, layer } = harness([reply([])])
    const result = yield* sendToZotero({ id }).pipe(Effect.provide(layer))
    assert.equal(result.isError, true)
    assert.match(textOf(result), /not found/)
    assert.equal(calls.length, 1)
  }))

  it.effect("rejects invalid inputs before contacting Zotero", () => Effect.gen(function* () {
    const { calls, layer } = harness([])
    for (const input of [
      {}, { id: "not-uuid" }, { url: "javascript:alert(1)" }, { url: "x" },
      { ...capture, actor: "agent" }, { ...capture, publishedAt: "not-a-date" },
      { ...capture, tags: [""] }, { ...capture, tags: Array(33).fill("tag") },
      { ...capture, title: "x".repeat(513) },
      { ...capture, collections: ["not-a-key"] }, { ...capture, collections: Array(101).fill(collectionKey) },
      { id, collections: [collectionKey] },
    ]) {
      const result = yield* sendToZotero(input).pipe(Effect.provide(layer))
      assert.equal(result.isError, true)
    }
    assert.equal(calls.length, 0)
  }))

  it.effect("returns the retry id on upstream errors and redacts credentials from logs", () => Effect.gen(function* () {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      for (const response of [reply({ failed: { "0": { code: 400 } } }), reply({ error: apiKey }, 403), reply("bad json")]) {
        const { layer } = harness([reply([]), response])
        const result = yield* sendToZotero(capture).pipe(Effect.provide(layer))
        assert.equal(result.isError, true)
        assert.equal(textOf(result), `zotero failed; id ${id}`)
      }
      assert.equal(JSON.stringify(log.mock.calls).includes(apiKey), false)
      assert.ok(JSON.stringify(log.mock.calls).includes("[redacted]"))
    } finally {
      log.mockRestore()
    }
  }))
})

describe("search_zotero", () => {
  it.effect("returns notes as plain text, attachments, and pagination", () => Effect.gen(function* () {
    const top = reply([{
      key, links: { alternate: { href: zoteroUrl } },
      data: { itemType: "webpage", title: "The post", url: capture.url, date: "2026-10-01", tags: [{ tag: "reading" }] },
    }])
    const { calls, layer } = harness([
      { ...top, headers: [["Total-Results", "2"]] },
      reply([
        { key: "EFGH6789", data: { itemType: "note", note: "<p>a &amp; b<br>next</p>" } },
        { key: "IJKLM234", data: { itemType: "attachment", title: "PDF", filename: "paper.pdf", contentType: "application/pdf", url: "https://example.com/paper.pdf" } },
        { key: "MNPQ5678", data: { itemType: "annotation" } },
      ]),
    ])
    const result = yield* searchZotero({ text: "The post", mode: "everything", limit: 1 }).pipe(Effect.provide(layer))
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(textOf(result)), {
      items: [{
        key, type: "webpage", title: "The post", url: capture.url, date: "2026-10-01", tags: ["reading"], zoteroUrl,
        notes: [{ key: "EFGH6789", text: "a & b\nnext" }],
        attachments: [{ key: "IJKLM234", title: "PDF", filename: "paper.pdf", contentType: "application/pdf", url: "https://example.com/paper.pdf" }],
      }],
      nextStart: 1,
    })
    assert.equal(calls[0]?.url, `${base}/items/top?format=json&limit=1&q=The%20post&qmode=everything&start=0`)
    assert.equal(calls[1]?.url, `${base}/items/${key}/children?format=json&limit=100`)
    assert.equal(calls.some((call) => call.url.includes(apiKey)), false)
  }))

  it.effect("browses with defaults and ends pagination on an empty page", () => Effect.gen(function* () {
    const { calls, layer } = harness([reply([])])
    const result = yield* searchZotero({}).pipe(Effect.provide(layer))
    assert.deepEqual(JSON.parse(textOf(result)), { items: [], nextStart: null })
    assert.equal(calls[0]?.url, `${base}/items/top?format=json&limit=10&qmode=titleCreatorYear&start=0`)
  }))

  it.effect("validates search limits and offsets", () => Effect.gen(function* () {
    const { calls, layer } = harness([])
    for (const input of [{ limit: 26 }, { limit: 0 }, { start: -1 }, { mode: "invalid" }]) {
      const result = yield* searchZotero(input).pipe(Effect.provide(layer))
      assert.equal(result.isError, true)
    }
    assert.equal(calls.length, 0)
  }))

  it.effect("validates credentials before making requests", () => Effect.gen(function* () {
    for (const config of [{ apiKey: "", userId: "1234567" }, { apiKey, userId: "../other" }]) {
      const result = yield* searchZotero({}).pipe(Effect.provide(zoteroLayer({
        ...config, exchange: async () => { throw new Error("must not fetch") },
      })))
      assert.equal(result.isError, true)
      assert.match(textOf(result), /ZOTERO_/)
    }
  }))
})

describe("list_zotero_collections", () => {
  it.effect("returns nested collections with distinct keys and paginates duplicate names", () => Effect.gen(function* () {
    const { calls, layer } = harness([
      { ...reply([
        { data: { key: collectionKey, name: "Reading", parentCollection: false } },
        { data: { key: otherCollection, name: "Reading", parentCollection: collectionKey } },
      ]), headers: [["Total-Results", "5"]] },
      { ...reply([{ data: { key: "DEFG5678", name: "Last", parentCollection: false } }]), headers: [["Total-Results", "5"]] },
    ])
    const first = yield* listZoteroCollections({ start: 2, limit: 2 }).pipe(Effect.provide(layer))
    assert.deepEqual(JSON.parse(textOf(first)), {
      collections: [
        { key: collectionKey, name: "Reading", parentCollection: null },
        { key: otherCollection, name: "Reading", parentCollection: collectionKey },
      ],
      nextStart: 4,
    })
    const last = yield* listZoteroCollections({ start: 4, limit: 2 }).pipe(Effect.provide(layer))
    assert.equal(JSON.parse(textOf(last)).nextStart, null)
    assert.equal(calls[0]?.url, `${base}/collections?format=json&limit=2&start=2`)
    assert.equal(calls[1]?.url, `${base}/collections?format=json&limit=2&start=4`)
  }))

  it.effect("falls back to page size without total results and stops on an empty page", () => Effect.gen(function* () {
    const { layer } = harness([
      reply([{ data: { key: collectionKey, name: "Reading", parentCollection: false } }]),
      reply([]),
    ])
    const first = yield* listZoteroCollections({ limit: 1 }).pipe(Effect.provide(layer))
    assert.equal(JSON.parse(textOf(first)).nextStart, 1)
    const last = yield* listZoteroCollections({ limit: 1, start: 1 }).pipe(Effect.provide(layer))
    assert.deepEqual(JSON.parse(textOf(last)), { collections: [], nextStart: null })
  }))

  it.effect("rejects invalid pagination before making requests", () => Effect.gen(function* () {
    const { calls, layer } = harness([])
    for (const input of [{ limit: 101 }, { limit: 0 }, { start: -1 }, { start: 0.5 }]) {
      const result = yield* listZoteroCollections(input).pipe(Effect.provide(layer))
      assert.equal(result.isError, true)
    }
    assert.deepEqual(calls, [])
  }))
})

describe("add_to_zotero_collection", () => {
  const item = { key, version: 7, data: { itemType: "book", title: "Keep this title", collections: [otherCollection] } }
  const input = { itemKey: key, collectionKey }

  it.effect("adds membership without replacing existing collections or metadata and safely repeats", () => Effect.gen(function* () {
    const { calls, layer } = harness([
      reply(item), reply(null, 204),
      reply({ ...item, version: 8, data: { ...item.data, collections: [otherCollection, collectionKey] } }),
    ])
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* addToZoteroCollection(input).pipe(Effect.provide(layer))
      assert.deepEqual(JSON.parse(textOf(result)), {
        zoteroKey: key, zoteroUrl, collections: [otherCollection, collectionKey],
      })
    }
    assert.deepEqual(calls.map((call) => call.method), ["GET", "PATCH", "GET"])
    assert.equal(calls[0]?.url, `${base}/items/${key}?format=json`)
    assert.equal(calls[1]?.url, `${base}/items/${key}`)
    assert.deepEqual(JSON.parse(calls[1]?.body ?? ""), { collections: [otherCollection, collectionKey] })
    assert.ok(calls[1]?.headers.some(([name, value]) => name === "If-Unmodified-Since-Version" && value === "7"))
  }))

  it.effect("reports version conflicts without overwriting newer memberships", () => Effect.gen(function* () {
    const { calls, layer } = harness([reply(item), reply(null, 412)])
    const result = yield* addToZoteroCollection(input).pipe(Effect.provide(layer))
    assert.equal(result.isError, true)
    assert.match(textOf(result), /changed.*retry/)
    assert.deepEqual(calls.map((call) => call.method), ["GET", "PATCH"])
  }))

  it.effect("rejects missing items and child items without attempting a write", () => Effect.gen(function* () {
    for (const [response, message] of [
      [reply(null, 404), /not found/],
      [reply({ ...item, data: { parentItem: "DEFG5678" } }), /parent itemKey/],
    ] as const) {
      const { calls, layer } = harness([response])
      const result = yield* addToZoteroCollection(input).pipe(Effect.provide(layer))
      assert.equal(result.isError, true)
      assert.match(textOf(result), message)
      assert.deepEqual(calls.map((call) => call.method), ["GET"])
    }
  }))

  it.effect("never replaces memberships from malformed item data or reports rejected writes as success", () => Effect.gen(function* () {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      for (const response of [
        { ...item, version: undefined },
        { ...item, data: { ...item.data, collections: undefined } },
        { ...item, data: { ...item.data, collections: [otherCollection, 123] } },
        { ...item, key: "DEFG5678" },
      ]) {
        const { calls, layer } = harness([reply(response)])
        const result = yield* addToZoteroCollection(input).pipe(Effect.provide(layer))
        assert.equal(result.isError, true)
        assert.deepEqual(calls.map((call) => call.method), ["GET"])
      }
      for (const status of [400, 403, 404, 429, 500]) {
        const { layer } = harness([reply(item), reply(null, status)])
        const result = yield* addToZoteroCollection(input).pipe(Effect.provide(layer))
        assert.equal(result.isError, true)
      }
    } finally {
      log.mockRestore()
    }
  }))

  it.effect("rejects invalid keys before contacting Zotero", () => Effect.gen(function* () {
    const { calls, layer } = harness([])
    for (const invalid of [
      { ...input, itemKey: id }, { ...input, collectionKey: "../other" },
      { ...input, collectionKey: "abcdefgh" }, { itemKey: key },
    ]) {
      const result = yield* addToZoteroCollection(invalid).pipe(Effect.provide(layer))
      assert.equal(result.isError, true)
    }
    assert.deepEqual(calls, [])
  }))
})

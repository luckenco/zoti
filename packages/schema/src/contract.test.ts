import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { DateTime, Effect, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"
import { IngestRequest, RecordId } from "./contract"

const selection = {
  kind: "selection",
  via: "chrome",
  url: "https://example.com/post",
  text: "the selected passage",
  tags: ["reading"],
  ts: "2026-10-13T10:52:00.000Z",
}

const decode = (records: ReadonlyArray<unknown>) =>
  Schema.decodeUnknown(IngestRequest)({ schemaVersion: 1, records })

const failure = (records: ReadonlyArray<unknown>) =>
  decode(records).pipe(
    Effect.flip,
    Effect.map((error) => TreeFormatter.formatErrorSync(error)),
  )

describe("IngestRequest", () => {
  it.effect("decodes one selection", () =>
    Effect.gen(function* () {
      const decoded = yield* decode([selection])
      const first = decoded.records[0]
      assert.ok(first)
      assert.equal(first.kind, "selection")
      assert.equal(first.via, "chrome")
      assert.equal(first.text, "the selected passage")
      assert.equal(first.url, "https://example.com/post")
      assert.deepEqual(first.tags, ["reading"])
      assert.equal(DateTime.formatIso(first.ts), "2026-10-13T10:52:00.000Z")
      assert.equal(first.id, undefined)
    }),
  )

  it.effect("decodes a source with a url and no text", () =>
    Effect.gen(function* () {
      const decoded = yield* decode([
        {
          kind: "video",
          via: "chrome",
          url: "https://www.youtube.com/watch?v=abc",
          title: "A talk",
          author: "A channel",
          site: "youtube.com",
          publishedAt: "2026-10-01T00:00:00.000Z",
          tags: [],
          ts: "2026-10-13T10:52:00.000Z",
        },
      ])
      const first = decoded.records[0]
      assert.ok(first)
      assert.equal(first.text, undefined)
      assert.equal(first.title, "A talk")
      assert.equal(first.author, "A channel")
      assert.equal(first.site, "youtube.com")
      assert.ok(first.publishedAt)
      assert.equal(DateTime.formatIso(first.publishedAt), "2026-10-01T00:00:00.000Z")
    }),
  )

  it.effect("decodes a note that points at a source", () =>
    Effect.gen(function* () {
      const aboutId = "0f8fad5b-d9cb-469f-a165-70867728950e"
      const decoded = yield* decode([
        { kind: "note", via: "cli", text: "worth rereading", aboutId, tags: [], ts: selection.ts },
      ])
      assert.equal(decoded.records[0]?.aboutId, aboutId)
      assert.equal(decoded.records[0]?.url, undefined)
    }),
  )

  it.effect("rejects schema version 2", () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknown(IngestRequest)({
        schemaVersion: 2,
        records: [selection],
      }).pipe(Effect.flip)
      assert.equal(
        TreeFormatter.formatErrorSync(error),
        `(IngestRequest (Encoded side) <-> IngestRequest)
└─ Encoded side transformation failure
   └─ IngestRequest (Encoded side)
      └─ ["schemaVersion"]
         └─ Expected 1, actual 2`,
      )
    }),
  )

  it.effect("rejects a record with neither text nor url", () =>
    Effect.gen(function* () {
      const { text: _text, url: _url, ...bare } = selection
      for (const record of [bare, { ...bare, text: "" }, { ...bare, url: null }]) {
        const message = yield* failure([record])
        assert.equal(message.includes("a record needs text or url"), true)
      }
    }),
  )

  it.effect("rejects an empty kind", () =>
    Effect.gen(function* () {
      const message = yield* failure([{ ...selection, kind: "" }])
      assert.equal(message.includes('["kind"]'), true)
      assert.equal(message.includes("Expected a string at least 1 character(s) long, actual \"\""), true)
    }),
  )

  it.effect("rejects 101 records", () =>
    Effect.gen(function* () {
      const message = yield* failure(Array.from({ length: 101 }, () => selection))
      assert.equal(message.includes("Expected an array of at most 100 item(s)"), true)
    }),
  )

  it.effect("rejects a non-uuid id", () =>
    Effect.gen(function* () {
      const message = yield* failure([{ ...selection, id: "not-a-uuid" }])
      assert.equal(message.includes('["id"]'), true)
      assert.equal(message.includes('Expected a Universally Unique Identifier, actual "not-a-uuid"'), true)
      const id = yield* Schema.decodeUnknown(RecordId)("0f8fad5b-d9cb-469f-a165-70867728950e")
      assert.equal(id, "0f8fad5b-d9cb-469f-a165-70867728950e")
    }),
  )
})

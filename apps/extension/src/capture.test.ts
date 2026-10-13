import { IngestRequest } from "@private-life/schema"
import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import { buildCapture } from "./capture"

const page = {
  pageUrl: "https://example.com/post",
  title: "A field note",
  tags: ["reading"],
  ts: "2026-10-13T10:52:00.000Z",
}

describe("extension capture", () => {
  it.effect("sends a selection as source chrome", () =>
    Effect.gen(function* () {
      const body = yield* buildCapture({ ...page, selection: "the selected passage" })
      const decoded = yield* Schema.decodeUnknown(IngestRequest)(body)
      const item = decoded.items[0]
      assert.ok(item)
      assert.equal(decoded.schemaVersion, 1)
      assert.equal(item.source, "chrome")
      assert.equal(item.type, "selection")
      assert.equal(item.text, "the selected passage")
      assert.equal(item.url, "https://example.com/post")
      assert.deepEqual(item.tags, ["reading"])
    }),
  )

  it.effect("sends the page title when nothing is selected", () =>
    Effect.gen(function* () {
      const body = yield* buildCapture({ ...page, selection: "" })
      const decoded = yield* Schema.decodeUnknown(IngestRequest)(body)
      const item = decoded.items[0]
      assert.ok(item)
      assert.equal(item.source, "chrome")
      assert.equal(item.type, "page")
      assert.equal(item.text, "A field note")
    }),
  )
})

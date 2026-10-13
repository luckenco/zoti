import { IngestRequest } from "@herodotus/schema"
import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { DateTime, Effect, Schema } from "effect"
import { buildCapture } from "./capture"

const page = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  pageUrl: "https://example.com/post",
  title: "A field note",
  ogTitle: "",
  author: "",
  published: "",
  selection: "",
  tags: ["reading"],
  ts: "2026-10-13T10:52:00.000Z",
}

const record = (body: unknown) =>
  Schema.decodeUnknown(IngestRequest)(JSON.parse(JSON.stringify(body))).pipe(
    Effect.map((decoded) => {
      assert.equal(decoded.schemaVersion, 1)
      const first = decoded.records[0]
      assert.ok(first)
      return first
    }),
  )

describe("extension capture", () => {
  it.effect("saves a selection as kind selection via chrome", () =>
    Effect.gen(function* () {
      const first = yield* record(yield* buildCapture({ ...page, selection: "the selected passage" }))
      assert.equal(first.id, page.id)
      assert.equal(DateTime.formatIso(first.ts), page.ts)
      assert.equal(first.via, "chrome")
      assert.equal(first.kind, "selection")
      assert.equal(first.text, "the selected passage")
      assert.equal(first.url, "https://example.com/post")
      assert.equal(first.site, "example.com")
      assert.equal(first.title, "A field note")
      assert.deepEqual(first.tags, ["reading"])
    }),
  )

  it.effect("saves a page as a url with its title and no text", () =>
    Effect.gen(function* () {
      const first = yield* record(yield* buildCapture(page))
      assert.equal(first.kind, "page")
      assert.equal(first.text, undefined)
      assert.equal(first.title, "A field note")
    }),
  )

  it.effect("reads og title, author, and published time from the page", () =>
    Effect.gen(function* () {
      const first = yield* record(
        yield* buildCapture({
          ...page,
          ogTitle: "The real title",
          author: "Ada",
          published: "2026-10-01T09:30:00+02:00",
        }),
      )
      assert.equal(first.title, "The real title")
      assert.equal(first.author, "Ada")
      assert.ok(first.publishedAt)
      assert.equal(DateTime.formatIso(first.publishedAt), "2026-10-01T07:30:00.000Z")
    }),
  )

  it.effect("bounds optional metadata without truncating the selection", () =>
    Effect.gen(function* () {
      const selection = "selected text ".repeat(100)
      const first = yield* record(yield* buildCapture({
        ...page,
        ogTitle: "t".repeat(513),
        author: "a".repeat(513),
        selection,
      }))
      assert.equal(first.title, "t".repeat(512))
      assert.equal(first.author, "a".repeat(512))
      assert.equal(first.text, selection)
      const fallback = yield* record(yield* buildCapture({ ...page, title: "f".repeat(513) }))
      assert.equal(fallback.title, "f".repeat(512))
    }),
  )

  it.effect("drops a published time it cannot parse", () =>
    Effect.gen(function* () {
      const first = yield* record(yield* buildCapture({ ...page, published: "last tuesday" }))
      assert.equal(first.publishedAt, undefined)
    }),
  )

  it.effect("infers kind from the hostname", () =>
    Effect.gen(function* () {
      const cases = [
        ["https://www.youtube.com/watch?v=abc", "", "video"],
        ["https://youtu.be/abc", "", "video"],
        ["https://x.com/ada/status/1", "", "tweet"],
        ["https://mobile.twitter.com/ada/status/1", "a passage", "tweet"],
        ["https://notyoutube.com/", "", "page"],
      ] as const
      for (const [pageUrl, selection, kind] of cases) {
        const first = yield* record(yield* buildCapture({ ...page, pageUrl, selection }))
        assert.equal(first.kind, kind)
      }
    }),
  )

  it.effect("never sends actor or agent", () =>
    Effect.gen(function* () {
      const body = yield* buildCapture({ ...page, selection: "x" })
      const sent = JSON.stringify(body)
      assert.equal(sent.includes("actor"), false)
      assert.equal(sent.includes("agent"), false)
    }),
  )
})

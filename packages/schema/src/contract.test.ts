import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { DateTime, Effect, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"
import { IngestRequest, ItemId } from "./contract"

const item = {
  url: "https://example.com/post",
  text: "the selected passage",
  type: "selection",
  source: "chrome",
  tags: ["reading"],
  ts: "2026-10-13T10:52:00.000Z",
}

describe("IngestRequest", () => {
  it.effect("decodes one capture", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknown(IngestRequest)({
        schemaVersion: 1,
        items: [item],
      })
      const first = decoded.items[0]
      assert.ok(first)
      assert.equal(first.text, "the selected passage")
      assert.equal(first.url, "https://example.com/post")
      assert.equal(first.type, "selection")
      assert.equal(first.source, "chrome")
      assert.deepEqual(first.tags, ["reading"])
      assert.equal(DateTime.formatIso(first.ts), "2026-10-13T10:52:00.000Z")
      assert.equal(first.id, undefined)
    }),
  )

  it.effect("rejects schema version 2", () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknown(IngestRequest)({
        schemaVersion: 2,
        items: [item],
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

  it.effect("rejects empty text", () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknown(IngestRequest)({
        schemaVersion: 1,
        items: [{ ...item, text: "" }],
      }).pipe(Effect.flip)
      assert.equal(
        TreeFormatter.formatErrorSync(error),
        `(IngestRequest (Encoded side) <-> IngestRequest)
└─ Encoded side transformation failure
   └─ IngestRequest (Encoded side)
      └─ ["items"]
         └─ minItems(1) & maxItems(100)
            └─ From side refinement failure
               └─ minItems(1)
                  └─ From side refinement failure
                     └─ ReadonlyArray<(ItemInput (Encoded side) <-> ItemInput)>
                        └─ [0]
                           └─ (ItemInput (Encoded side) <-> ItemInput)
                              └─ Encoded side transformation failure
                                 └─ ItemInput (Encoded side)
                                    └─ ["text"]
                                       └─ minLength(1) & maxLength(100000)
                                          └─ From side refinement failure
                                             └─ minLength(1)
                                                └─ Predicate refinement failure
                                                   └─ Expected a string at least 1 character(s) long, actual ""`,
      )
    }),
  )

  it.effect("rejects 101 items", () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknown(IngestRequest)({
        schemaVersion: 1,
        items: Array.from({ length: 101 }, () => item),
      }).pipe(Effect.flip)
      const message = TreeFormatter.formatErrorSync(error)
      const marker = "Expected an array of at most 100 item(s)"
      const index = message.indexOf(marker)
      assert.equal(message.slice(index, index + marker.length), marker)
    }),
  )

  it.effect("rejects a non-uuid id", () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknown(IngestRequest)({
        schemaVersion: 1,
        items: [{ ...item, id: "not-a-uuid" }],
      }).pipe(Effect.flip)
      assert.equal(
        TreeFormatter.formatErrorSync(error),
        `(IngestRequest (Encoded side) <-> IngestRequest)
└─ Encoded side transformation failure
   └─ IngestRequest (Encoded side)
      └─ ["items"]
         └─ minItems(1) & maxItems(100)
            └─ From side refinement failure
               └─ minItems(1)
                  └─ From side refinement failure
                     └─ ReadonlyArray<(ItemInput (Encoded side) <-> ItemInput)>
                        └─ [0]
                           └─ (ItemInput (Encoded side) <-> ItemInput)
                              └─ Encoded side transformation failure
                                 └─ ItemInput (Encoded side)
                                    └─ ["id"]
                                       └─ a Universally Unique Identifier & Brand<"ItemId"> | undefined
                                          ├─ a Universally Unique Identifier & Brand<"ItemId">
                                          │  └─ Predicate refinement failure
                                          │     └─ Expected a Universally Unique Identifier, actual "not-a-uuid"
                                          └─ Expected undefined, actual "not-a-uuid"`,
      )
      const id = yield* Schema.decodeUnknown(ItemId)("0f8fad5b-d9cb-469f-a165-70867728950e")
      assert.equal(id, "0f8fad5b-d9cb-469f-a165-70867728950e")
    }),
  )
})

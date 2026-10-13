import { FetchHttpClient } from "@effect/platform"
import { IngestRequest } from "@private-life/schema"
import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { Effect, Schema } from "effect"
import { ingest } from "./ingest"

const mockId = "33333333-3333-4333-8333-333333333333"

interface Posted {
  readonly url: string | undefined
  readonly authorization: string | undefined
  readonly raw: string
}

const listen = (posted: Array<Posted>): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      request.on("end", () => {
        posted.push({
          url: request.url,
          authorization: request.headers.authorization,
          raw: Buffer.concat(chunks).toString("utf8"),
        })
        response.writeHead(201, { "content-type": "application/json" })
        response.end(JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [mockId] }))
      })
    })
    server.listen(0, "127.0.0.1", () => {
      resolve(server)
    })
  })

describe("cli ingest", () => {
  it.effect("posts schema version 1 and prints the id from the response", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => {
        const posted: Array<Posted> = []
        return listen(posted).then((server) => ({ server, posted }))
      }),
      ({ server, posted }) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const original = console.log
            const lines: Array<string> = []
            console.log = (message?: unknown) => {
              lines.push(String(message))
            }
            return { original, lines }
          }),
          ({ lines }) =>
            Effect.gen(function* () {
              const address = server.address()
              if (address === null || typeof address === "string") {
                return yield* Effect.die("test server has no port")
              }
              const ids = yield* ingest(
                { url: `http://127.0.0.1:${address.port}`, token: "test-token" },
                { type: "note", text: "ship the schema", tags: ["etl"], source: "cli" },
              ).pipe(Effect.provide(FetchHttpClient.layer))
              assert.deepEqual(ids, [mockId])
              assert.deepEqual(lines, [mockId])
              const sent = posted[0]
              assert.ok(sent)
              assert.equal(sent.url, "/v1/items")
              assert.equal(sent.authorization, "Bearer test-token")
              const decoded = yield* Schema.decodeUnknown(IngestRequest)(JSON.parse(sent.raw))
              const item = decoded.items[0]
              assert.ok(item)
              assert.equal(decoded.schemaVersion, 1)
              assert.equal(item.source, "cli")
              assert.equal(item.type, "note")
              assert.equal(item.text, "ship the schema")
              assert.deepEqual(item.tags, ["etl"])
            }),
          ({ original }) =>
            Effect.sync(() => {
              console.log = original
            }),
        ),
      ({ server }) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.close(() => {
                resolve()
              })
            }),
        ),
    ),
  )
})

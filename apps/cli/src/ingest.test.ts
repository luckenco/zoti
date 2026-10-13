import { FetchHttpClient } from "@effect/platform"
import { IngestRequest } from "@herodotus/schema"
import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { Effect, Schema } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ingest, loadConfig } from "./ingest"

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
                { kind: "note", text: "ship the schema", tags: ["etl"], about: mockId },
              ).pipe(Effect.provide(FetchHttpClient.layer))
              assert.deepEqual(ids, [mockId])
              assert.deepEqual(lines, [mockId])
              const sent = posted[0]
              assert.ok(sent)
              assert.equal(sent.url, "/v1/records")
              assert.equal(sent.authorization, "Bearer test-token")
              const decoded = yield* Schema.decodeUnknown(IngestRequest)(JSON.parse(sent.raw))
              const record = decoded.records[0]
              assert.ok(record)
              assert.equal(decoded.schemaVersion, 1)
              assert.equal(record.via, "cli")
              assert.equal(record.kind, "note")
              assert.equal(record.text, "ship the schema")
              assert.equal(record.aboutId, mockId)
              assert.deepEqual(record.tags, ["etl"])
              const wire: unknown = JSON.parse(sent.raw)
              assert.equal(JSON.stringify(wire).includes("actor"), false)
              assert.equal(JSON.stringify(wire).includes("agent"), false)
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

describe("cli config", () => {
  const write = (contents: unknown, mode: number): string => {
    const path = join(mkdtempSync(join(tmpdir(), "herodotus-")), "config.json")
    writeFileSync(path, JSON.stringify(contents), { mode })
    return path
  }
  const file = { url: "https://worker.example", tokens: { you: "you-token", pi: "pi-token" } }

  it.effect("returns the token for the identity", () =>
    Effect.gen(function* () {
      const config = yield* loadConfig("pi", write(file, 0o600))
      assert.deepEqual(config, { url: "https://worker.example", token: "pi-token" })
    }),
  )

  it.effect("lets an env url override the file url", () =>
    Effect.gen(function* () {
      const config = yield* loadConfig("you", write(file, 0o600), "http://127.0.0.1:8787")
      assert.deepEqual(config, { url: "http://127.0.0.1:8787", token: "you-token" })
    }),
  )

  it.effect("fails for an identity with no token", () =>
    Effect.gen(function* () {
      const path = write(file, 0o600)
      const error = yield* loadConfig("claude", path).pipe(Effect.flip)
      assert.equal(error.message, `no token for identity "claude" in ${path}`)
    }),
  )

  it.effect("rejects inherited property names that have no configured token", () =>
    Effect.gen(function* () {
      const path = write(file, 0o600)
      for (const identity of ["constructor", "__proto__", "toString"]) {
        const error = yield* loadConfig(identity, path).pipe(Effect.flip)
        assert.equal(error.message, `no token for identity "${identity}" in ${path}`)
      }
    }),
  )

  it.effect("accepts a property-name identity when explicitly configured", () =>
    Effect.gen(function* () {
      const path = write({ ...file, tokens: { constructor: "own-token" } }, 0o600)
      const config = yield* loadConfig("constructor", path)
      assert.deepEqual(config, { url: file.url, token: "own-token" })
    }),
  )

  it.effect("rejects a config file others can read", () =>
    Effect.gen(function* () {
      const path = write(file, 0o644)
      const error = yield* loadConfig("you", path).pipe(Effect.flip)
      assert.equal(error.message, `${path} must not be readable by others (chmod 600)`)
    }),
  )
})

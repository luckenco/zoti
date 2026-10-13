import { HttpClient, HttpClientResponse } from "@effect/platform"
import type { HttpBody } from "@effect/platform/HttpBody"
import type { HttpClientRequest } from "@effect/platform/HttpClientRequest"
import * as UrlParams from "@effect/platform/UrlParams"
import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import { authLayer } from "./auth"
import { clickHouseLayer } from "./clickhouse"
import { handle, IdSource } from "./handler"
import { rateLimitLayer, type RateLimitBinding } from "./rate-limit"

const fixedId = "22222222-2222-4222-8222-222222222222"
const knownId = "0f8fad5b-d9cb-469f-a165-70867728950e"
const secondId = "11111111-1111-4111-8111-111111111111"
const tokens = JSON.stringify({ chrome: "chrome-token", cli: "cli-token" })

const clickHouseConfig = {
  url: "https://ch.example:8443/",
  user: "ingest",
  password: "test-password",
  database: "private_life",
}

interface RecordedRequest {
  readonly url: string
  readonly body: string
  readonly user: string | undefined
  readonly key: string | undefined
}

const bodyText = (body: HttpBody): string =>
  body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : ""

const wireUrl = (request: HttpClientRequest): string => {
  const built = UrlParams.makeUrl(request.url, request.urlParams, request.hash)
  if (built._tag === "Left") throw built.left
  return built.right.toString()
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

const itemA = {
  id: knownId,
  url: "https://example.com/post",
  text: "the selected passage",
  type: "selection",
  source: "chrome",
  tags: ["reading"],
  ts: "2026-10-13T10:52:00.000Z",
}

const itemB = {
  id: secondId,
  text: "a note",
  type: "note",
  source: "cli",
  tags: ["etl"],
  ts: "2026-10-13T11:00:00.000Z",
  futureField: "keep-me",
}

const batchBody = `INSERT INTO private_life.items FORMAT JSONEachRow
{"id":"0f8fad5b-d9cb-469f-a165-70867728950e","url":"https://example.com/post","text":"the selected passage","type":"selection","source":"chrome","tags":["reading"],"ts":"2026-10-13T10:52:00.000Z","raw":"{\\"id\\":\\"0f8fad5b-d9cb-469f-a165-70867728950e\\",\\"url\\":\\"https://example.com/post\\",\\"text\\":\\"the selected passage\\",\\"type\\":\\"selection\\",\\"source\\":\\"chrome\\",\\"tags\\":[\\"reading\\"],\\"ts\\":\\"2026-10-13T10:52:00.000Z\\"}"}
{"id":"11111111-1111-4111-8111-111111111111","url":null,"text":"a note","type":"note","source":"cli","tags":["etl"],"ts":"2026-10-13T11:00:00.000Z","raw":"{\\"id\\":\\"11111111-1111-4111-8111-111111111111\\",\\"text\\":\\"a note\\",\\"type\\":\\"note\\",\\"source\\":\\"cli\\",\\"tags\\":[\\"etl\\"],\\"ts\\":\\"2026-10-13T11:00:00.000Z\\",\\"futureField\\":\\"keep-me\\"}"}
`

const run = (options: {
  readonly request: Request
  readonly password?: string
  readonly allow?: boolean
  readonly clickHouseStatus?: number
  readonly clickHouseBody?: string
  readonly authTokens?: string
  readonly limiterThrows?: boolean
}) => {
  const recorded: Array<RecordedRequest> = []
  const keys: Array<string> = []
  const logs: Array<string> = []
  const binding: RateLimitBinding = {
    limit: ({ key }) => {
      keys.push(key)
      if (options.limiterThrows) return Promise.reject(new Error("binding down"))
      return Promise.resolve({ success: options.allow ?? true })
    },
  }
  const http = HttpClient.make((request) => {
    recorded.push({
      url: wireUrl(request),
      body: bodyText(request.body),
      user: request.headers["x-clickhouse-user"],
      key: request.headers["x-clickhouse-key"],
    })
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(options.clickHouseBody ?? "", { status: options.clickHouseStatus ?? 200 }),
      ),
    )
  })
  const layer = Layer.mergeAll(
    authLayer(options.authTokens ?? tokens),
    rateLimitLayer(binding),
    clickHouseLayer({ ...clickHouseConfig, password: options.password ?? clickHouseConfig.password }),
    Layer.succeed(IdSource, { next: Effect.succeed(fixedId) }),
  ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))

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
            keys,
            logs,
          })),
        ),
      ),
    (original) => Effect.sync(() => {
      console.error = original
    }),
  )
}

describe("worker handler", () => {
  it.effect("inserts a batch as JSONEachRow", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/items", { schemaVersion: 1, items: [itemA, itemB] }),
      })
      assert.equal(result.status, 201)
      assert.equal(
        result.body,
        JSON.stringify({ schemaVersion: 1, inserted: 2, ids: [knownId, secondId] }),
      )
      assert.equal(result.recorded.length, 1)
      const sent = result.recorded[0]
      assert.ok(sent)
      assert.equal(sent.body, batchBody)
      assert.equal(sent.body.includes("ingested_at"), false)
      assert.equal(
        sent.url,
        "https://ch.example:8443/?database=private_life&date_time_input_format=best_effort",
      )
      assert.equal(sent.url.includes("test-password"), false)
      assert.equal(sent.user, "ingest")
      assert.equal(sent.key, "test-password")
      assert.deepEqual(result.keys, ["chrome"])
    }),
  )

  it.effect("forwards the same id twice", () =>
    Effect.gen(function* () {
      const first = yield* run({
        request: post("/v1/items", { schemaVersion: 1, items: [itemA] }),
      })
      const second = yield* run({
        request: post("/v1/items", { schemaVersion: 1, items: [itemA] }),
      })
      assert.equal(first.status, 201)
      assert.equal(second.status, 201)
      assert.equal(first.recorded[0]?.body, second.recorded[0]?.body)
      assert.equal(first.body, JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [knownId] }))
    }),
  )

  it.effect("fills a missing id", () =>
    Effect.gen(function* () {
      const { id: _id, ...withoutId } = itemA
      const result = yield* run({
        request: post("/v1/items", { schemaVersion: 1, items: [withoutId] }),
      })
      assert.equal(result.status, 201)
      assert.equal(result.body, JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [fixedId] }))
      assert.equal(
        result.recorded[0]?.body,
        `INSERT INTO private_life.items FORMAT JSONEachRow
{"id":"22222222-2222-4222-8222-222222222222","url":"https://example.com/post","text":"the selected passage","type":"selection","source":"chrome","tags":["reading"],"ts":"2026-10-13T10:52:00.000Z","raw":"{\\"url\\":\\"https://example.com/post\\",\\"text\\":\\"the selected passage\\",\\"type\\":\\"selection\\",\\"source\\":\\"chrome\\",\\"tags\\":[\\"reading\\"],\\"ts\\":\\"2026-10-13T10:52:00.000Z\\",\\"id\\":\\"22222222-2222-4222-8222-222222222222\\"}"}
`,
      )
    }),
  )

  it.effect("rejects an unknown bearer token", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/items", { schemaVersion: 1, items: [itemA] }, "nope"),
      })
      assert.equal(result.status, 401)
      assert.equal(result.body, JSON.stringify({ _tag: "Unauthorized" }))
      assert.equal(result.recorded.length, 0)
      assert.deepEqual(result.keys, ["anonymous"])
    }),
  )

  it.effect("returns 429 when the limiter refuses", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/items", { schemaVersion: 1, items: [itemA] }),
        allow: false,
      })
      assert.equal(result.status, 429)
      assert.equal(result.body, JSON.stringify({ _tag: "RateLimited" }))
      assert.equal(result.retryAfter, "60")
      assert.equal(result.recorded.length, 0)
      assert.deepEqual(result.keys, ["chrome"])
    }),
  )

  it.effect("hides the ClickHouse error body", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/items", { schemaVersion: 1, items: [itemA] }),
        clickHouseStatus: 500,
        clickHouseBody: "SENTINEL_CH_ERROR",
      })
      assert.equal(result.status, 502)
      assert.equal(result.body, JSON.stringify({ _tag: "ClickHouseInsertFailed", status: 500 }))
      assert.equal(result.body.includes("SENTINEL_CH_ERROR"), false)
      assert.equal(result.logs.some((line) => line.includes("SENTINEL_CH_ERROR")), true)
    }),
  )

  it.effect("answers health without ClickHouse", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: new Request("https://worker.example/health"),
      })
      assert.equal(result.status, 200)
      assert.equal(result.body, JSON.stringify({ ok: true }))
      assert.equal(result.recorded.length, 0)
      assert.deepEqual(result.keys, [])
    }),
  )

  it.effect("rejects schema version 2", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/items", { schemaVersion: 2, items: [itemA] }),
      })
      assert.equal(result.status, 400)
      assert.equal(result.body, JSON.stringify({ _tag: "UnsupportedSchemaVersion", schemaVersion: 2 }))
      assert.equal(result.recorded.length, 0)
    }),
  )

  it.effect("rejects 101 items before a full decode", () =>
    Effect.gen(function* () {
      const items = Array.from({ length: 101 }, () => ({ text: "x" }))
      const result = yield* run({
        request: post("/v1/items", { schemaVersion: 1, items }),
      })
      assert.equal(result.status, 400)
      assert.equal(result.body, JSON.stringify({ _tag: "InvalidBody", message: "at most 100 items" }))
      assert.equal(result.recorded.length, 0)
    }),
  )

  it.effect("rejects an empty ClickHouse password before fetch", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/items", { schemaVersion: 1, items: [itemA] }),
        password: "",
      })
      assert.equal(result.status, 500)
      assert.equal(
        result.body,
        JSON.stringify({ _tag: "Misconfigured", message: "CLICKHOUSE_PASSWORD is empty" }),
      )
      assert.equal(result.recorded.length, 0)
    }),
  )
})

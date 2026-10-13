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
const tokens = JSON.stringify({
  chrome: { token: "chrome-token", actor: "human" },
  pi: { token: "pi-token", actor: "agent" },
})

const clickHouseConfig = {
  url: "https://ch.example:8443/",
  user: "ingest",
  password: "test-password",
  database: "herodotus",
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

const video = {
  id: knownId,
  kind: "video",
  via: "chrome",
  url: "https://www.youtube.com/watch?v=abc",
  title: "A talk",
  author: "A channel",
  site: "youtube.com",
  publishedAt: "2026-10-01T00:00:00.000Z",
  tags: ["reading"],
  ts: "2026-10-13T10:52:00.000Z",
}

const note = {
  id: secondId,
  kind: "note",
  via: "cli",
  text: "a note",
  aboutId: knownId,
  tags: ["etl"],
  ts: "2026-10-13T11:00:00.000Z",
  futureField: "keep-me",
}

const insert = (rows: ReadonlyArray<unknown>): string =>
  `INSERT INTO herodotus.records FORMAT JSONEachRow\n${rows.map((row) => JSON.stringify(row)).join("\n")}\n`

const videoRow = (actor: string, agent: string | null) => ({
  id: knownId,
  kind: "video",
  via: "chrome",
  actor,
  agent,
  url: "https://www.youtube.com/watch?v=abc",
  title: "A talk",
  author: "A channel",
  site: "youtube.com",
  published_at: "2026-10-01T00:00:00.000Z",
  about_id: null,
  text: "",
  tags: ["reading"],
  ts: "2026-10-13T10:52:00.000Z",
  raw: JSON.stringify(video),
})

const noteRow = (actor: string, agent: string | null) => ({
  id: secondId,
  kind: "note",
  via: "cli",
  actor,
  agent,
  url: null,
  title: null,
  author: null,
  site: null,
  published_at: null,
  about_id: knownId,
  text: "a note",
  tags: ["etl"],
  ts: "2026-10-13T11:00:00.000Z",
  raw: JSON.stringify(note),
})

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

const records = (...items: ReadonlyArray<unknown>) => ({ schemaVersion: 1, records: items })

describe("worker handler", () => {
  it.effect("inserts a batch as JSONEachRow, stamped human", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video, note)) })
      assert.equal(result.status, 201)
      assert.equal(
        result.body,
        JSON.stringify({ schemaVersion: 1, inserted: 2, ids: [knownId, secondId] }),
      )
      assert.equal(result.recorded.length, 1)
      const sent = result.recorded[0]
      assert.ok(sent)
      assert.equal(sent.body, insert([videoRow("human", null), noteRow("human", null)]))
      assert.equal(sent.body.includes("ingested_at"), false)
      assert.equal(
        sent.url,
        "https://ch.example:8443/?database=herodotus&date_time_input_format=best_effort",
      )
      assert.equal(sent.url.includes("test-password"), false)
      assert.equal(sent.user, "ingest")
      assert.equal(sent.key, "test-password")
      assert.deepEqual(result.keys, ["chrome"])
    }),
  )

  it.effect("stamps an agent token as actor agent with its identity name", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video), "pi-token") })
      assert.equal(result.status, 201)
      assert.equal(result.recorded[0]?.body, insert([videoRow("agent", "pi")]))
      assert.deepEqual(result.keys, ["pi"])
    }),
  )

  it.effect("rejects a body that sets actor or agent", () =>
    Effect.gen(function* () {
      for (const forged of [{ actor: "human" }, { agent: "pi" }]) {
        const result = yield* run({ request: post("/v1/records", records({ ...video, ...forged }), "pi-token") })
        assert.equal(result.status, 400)
        assert.equal(
          result.body,
          JSON.stringify({ _tag: "InvalidBody", message: "actor and agent are set by the server" }),
        )
        assert.equal(result.recorded.length, 0)
      }
    }),
  )

  it.effect("rejects a record with neither text nor url", () =>
    Effect.gen(function* () {
      const { url: _url, ...withoutUrl } = video
      const result = yield* run({ request: post("/v1/records", records(withoutUrl)) })
      assert.equal(result.status, 400)
      assert.equal(result.body.includes("a record needs text or url"), true)
      assert.equal(result.recorded.length, 0)
    }),
  )

  it.effect("forwards the same id twice", () =>
    Effect.gen(function* () {
      const first = yield* run({ request: post("/v1/records", records(video)) })
      const second = yield* run({ request: post("/v1/records", records(video)) })
      assert.equal(first.status, 201)
      assert.equal(second.status, 201)
      assert.equal(first.recorded[0]?.body, second.recorded[0]?.body)
      assert.equal(first.body, JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [knownId] }))
    }),
  )

  it.effect("fills a missing id", () =>
    Effect.gen(function* () {
      const { id: _id, ...withoutId } = video
      const result = yield* run({ request: post("/v1/records", records(withoutId)) })
      assert.equal(result.status, 201)
      assert.equal(result.body, JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [fixedId] }))
      assert.equal(
        result.recorded[0]?.body,
        insert([
          {
            ...videoRow("human", null),
            id: fixedId,
            raw: JSON.stringify({ ...withoutId, id: fixedId }),
          },
        ]),
      )
    }),
  )

  it.effect("rejects an unknown bearer token", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video), "nope") })
      assert.equal(result.status, 401)
      assert.equal(result.body, JSON.stringify({ _tag: "Unauthorized" }))
      assert.equal(result.recorded.length, 0)
      assert.deepEqual(result.keys, ["anonymous"])
    }),
  )

  it.effect("returns 429 when the limiter refuses", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video)), allow: false })
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
        request: post("/v1/records", records(video)),
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
      const result = yield* run({ request: new Request("https://worker.example/health") })
      assert.equal(result.status, 200)
      assert.equal(result.body, JSON.stringify({ ok: true }))
      assert.equal(result.recorded.length, 0)
      assert.deepEqual(result.keys, [])
    }),
  )

  it.effect("rejects schema version 2", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", { schemaVersion: 2, records: [video] }) })
      assert.equal(result.status, 400)
      assert.equal(result.body, JSON.stringify({ _tag: "UnsupportedSchemaVersion", schemaVersion: 2 }))
      assert.equal(result.recorded.length, 0)
    }),
  )

  it.effect("rejects 101 records before a full decode", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/records", records(...Array.from({ length: 101 }, () => ({ text: "x" })))),
      })
      assert.equal(result.status, 400)
      assert.equal(result.body, JSON.stringify({ _tag: "InvalidBody", message: "at most 100 records" }))
      assert.equal(result.recorded.length, 0)
    }),
  )

  it.effect("rejects an empty ClickHouse password before fetch", () =>
    Effect.gen(function* () {
      const result = yield* run({ request: post("/v1/records", records(video)), password: "" })
      assert.equal(result.status, 500)
      assert.equal(
        result.body,
        JSON.stringify({ _tag: "Misconfigured", message: "CLICKHOUSE_PASSWORD is empty" }),
      )
      assert.equal(result.recorded.length, 0)
    }),
  )

  it.effect("rejects duplicate tokens without attributing or inserting records", () =>
    Effect.gen(function* () {
      for (const actors of [["human", "agent"], ["agent", "human"], ["agent", "agent"]]) {
        const result = yield* run({
          request: post("/v1/records", records(video), "shared-secret"),
          authTokens: JSON.stringify({
            first: { token: "shared-secret", actor: actors[0] },
            second: { token: "shared-secret", actor: actors[1] },
          }),
        })
        assert.equal(result.status, 500)
        assert.equal(
          result.body,
          JSON.stringify({ _tag: "Misconfigured", message: "AUTH_TOKENS tokens must be unique" }),
        )
        assert.equal(result.recorded.length, 0)
        assert.deepEqual(result.keys, [])
        assert.deepEqual(result.logs, [])
      }
    }),
  )

  it.effect("returns 500 when an AUTH_TOKENS actor is invalid", () =>
    Effect.gen(function* () {
      const result = yield* run({
        request: post("/v1/records", records(video)),
        authTokens: JSON.stringify({ chrome: { token: "chrome-token", actor: "robot" } }),
      })
      assert.equal(result.status, 500)
      assert.equal(
        result.body,
        JSON.stringify({ _tag: "Misconfigured", message: "AUTH_TOKENS actor must be human or agent" }),
      )
      assert.equal(result.recorded.length, 0)
    }),
  )
})

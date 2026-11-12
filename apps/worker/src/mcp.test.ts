import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { Effect } from "effect"
import type { WorkerBindings } from "./bindings"
import { workerFetch } from "./index"

const origin = "https://zoti.cloudflare-swimming382.workers.dev"
const tokens = JSON.stringify({ pi: { token: "test-token" } })
const ctx: ExecutionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  abort: () => undefined,
  props: {},
  get exports(): never { throw new Error("exports not used") },
  get tracing(): never { throw new Error("tracing not used") },
}

const call = (request: Request, options: { allow?: boolean; tokens?: string; brokenLimiter?: boolean } = {}) => {
  const keys: string[] = []
  const env: WorkerBindings = {
    AUTH_TOKENS: options.tokens ?? tokens,
    ZOTERO_API_KEY: "",
    ZOTERO_USER_ID: "",
    MCP_RATE_LIMITER: {
      limit: async ({ key }) => {
        keys.push(key)
        if (options.brokenLimiter) throw new Error("binding failed")
        return { success: options.allow ?? true }
      },
    },
  }
  return Effect.gen(function* () {
    const response = yield* workerFetch(request, env, ctx)
    return { response, body: yield* Effect.promise(() => response.text()), keys }
  })
}

const rpc = (method: string, params: unknown = {}) => new Request(`${origin}/mcp`, {
  method: "POST",
  headers: {
    authorization: "Bearer test-token",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    host: new URL(origin).host,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
})

const rpcBody = (body: string) => {
  const data = body.split("\n").find((line) => line.startsWith("data: "))
  assert.ok(data)
  return JSON.parse(data.slice(6))
}

describe("MCP endpoint", () => {
  for (const token of [null, "Bearer unknown", "Basic test-token", "Bearer ", "Bearer test token"]) {
    it.effect(`rejects invalid authorization: ${token}`, () => Effect.gen(function* () {
      const headers = new Headers()
      if (token !== null) headers.set("authorization", token)
      const result = yield* call(new Request(`${origin}/mcp`, { method: "POST", headers, body: "{}" }))
      assert.equal(result.response.status, 401)
      assert.equal(result.body, JSON.stringify({ _tag: "Unauthorized" }))
      assert.deepEqual(result.keys, ["anonymous"])
    }))
  }

  it.effect("lists only Zotero tools without needing Zotero credentials", () => Effect.gen(function* () {
    const result = yield* call(rpc("tools/list"))
    assert.equal(result.response.status, 200)
    assert.deepEqual(rpcBody(result.body).result.tools.map((tool: { name: string }) => tool.name), [
      "send_to_zotero", "search_zotero",
    ])
    assert.deepEqual(result.keys, ["pi"])
  }))

  it.effect("initializes as zoti", () => Effect.gen(function* () {
    const result = yield* call(rpc("initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
    }))
    assert.equal(result.response.status, 200)
    assert.equal(rpcBody(result.body).result.serverInfo.name, "zoti")
  }))

  it.effect("runs tools through MCP and returns configuration errors safely", () => Effect.gen(function* () {
    const result = yield* call(rpc("tools/call", { name: "search_zotero", arguments: {} }))
    assert.equal(result.response.status, 200)
    assert.equal(rpcBody(result.body).result.isError, true)
    assert.equal(rpcBody(result.body).result.content[0].text, "ZOTERO_API_KEY is empty")
  }))

  it.effect("rate limits authenticated and anonymous callers", () => Effect.gen(function* () {
    for (const request of [rpc("tools/list"), new Request(`${origin}/mcp`, { method: "POST" })]) {
      const result = yield* call(request, { allow: false })
      assert.equal(result.response.status, 429)
      assert.equal(result.response.headers.get("retry-after"), "60")
      assert.equal(result.body, JSON.stringify({ _tag: "RateLimited" }))
    }
  }))

  for (const raw of ["not json", "[]", "{}", '{"pi":{"token":""}}', '{"pi":{"token":"x"},"other":{"token":"x"}}']) {
    it.effect(`fails closed on invalid token configuration: ${raw}`, () => Effect.gen(function* () {
      const result = yield* call(rpc("tools/list"), { tokens: raw })
      assert.equal(result.response.status, 500)
      assert.deepEqual(result.keys, [])
    }))
  }

  it.effect("fails closed when the rate limiter fails", () => Effect.gen(function* () {
    const result = yield* call(rpc("tools/list"), { brokenLimiter: true })
    assert.equal(result.response.status, 500)
  }))

  it.effect("keeps health and CORS preflight unauthenticated", () => Effect.gen(function* () {
    const preflight = yield* call(new Request(`${origin}/mcp`, {
      method: "OPTIONS", headers: { host: new URL(origin).host },
    }))
    assert.equal(preflight.response.status, 200)
    assert.deepEqual(preflight.keys, [])
    const health = yield* call(new Request(`${origin}/health`), { tokens: "" })
    assert.equal(health.response.status, 200)
    assert.equal(health.body, JSON.stringify({ ok: true }))
  }))

  it.effect("does not serve the removed capture API", () => Effect.gen(function* () {
    for (const method of ["POST", "OPTIONS"]) {
      const result = yield* call(new Request(`${origin}/v1/records`, { method }))
      assert.equal(result.response.status, 404)
      assert.deepEqual(result.keys, [])
    }
  }))
})

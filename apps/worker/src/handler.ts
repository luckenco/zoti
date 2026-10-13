import {
  type ApiFailure,
  IngestRequest,
  ItemId,
  VersionProbe,
  apiFailureBody,
  maxBodyBytes,
  maxItems,
  statusForFailure,
  InvalidBody,
  Misconfigured,
  NotFound,
  PayloadTooLarge,
  Unauthorized,
  UnsupportedSchemaVersion,
} from "@private-life/schema"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"
import { Auth } from "./auth"
import { ClickHouse, jsonEachRow, type SettledRow } from "./clickhouse"
import { RateLimit } from "./rate-limit"

export class IdSource extends Context.Tag("IdSource")<
  IdSource,
  { readonly next: Effect.Effect<string> }
>() {}

export const idLayer: Layer.Layer<IdSource> = Layer.succeed(IdSource, {
  next: Effect.sync(() => crypto.randomUUID()),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store",
}

const jsonResponse = (
  status: number,
  body: unknown,
  extra?: Readonly<Record<string, string>>,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...extra,
    },
  })

const failureResponse = (error: ApiFailure): Response =>
  jsonResponse(
    statusForFailure(error),
    apiFailureBody(error),
    error._tag === "RateLimited" ? { "retry-after": "60" } : undefined,
  )

const declaredTooLarge = (request: Request): boolean => {
  const declared = request.headers.get("content-length")
  return declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBodyBytes
}

const readLimited = (request: Request): Effect.Effect<string, PayloadTooLarge | InvalidBody> =>
  Effect.tryPromise({
    try: async () => {
      const reader = request.body?.getReader()
      if (reader === undefined) return ""
      const chunks: Array<Uint8Array> = []
      let total = 0
      for (;;) {
        const step = await reader.read()
        if (step.done) break
        total += step.value.byteLength
        if (total > maxBodyBytes) {
          await reader.cancel()
          return { tooLarge: true as const }
        }
        chunks.push(step.value)
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new TextDecoder().decode(bytes)
    },
    catch: () => new InvalidBody({ message: "body could not be read" }),
  }).pipe(
    Effect.flatMap((body) =>
      typeof body === "string" ? Effect.succeed(body) : Effect.fail(new PayloadTooLarge()),
    ),
  )

const settleId = Effect.gen(function* () {
  const ids = yield* IdSource
  const raw = yield* ids.next
  return yield* Schema.decodeUnknown(ItemId)(raw).pipe(
    Effect.mapError(() => new Misconfigured({ message: "id generator returned a non-uuid" })),
  )
})

const ingest = (request: Request) =>
  Effect.gen(function* () {
    if (declaredTooLarge(request)) return yield* new PayloadTooLarge()
    const auth = yield* Auth
    const limiter = yield* RateLimit
    const identified = yield* auth.identify(request.headers.get("authorization")).pipe(Effect.either)
    if (identified._tag === "Left") {
      if (identified.left._tag === "Misconfigured") return yield* identified.left
      yield* limiter.consume("anonymous")
      return yield* new Unauthorized()
    }
    yield* limiter.consume(identified.right)

    const text = yield* readLimited(request)
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new InvalidBody({ message: "body is not JSON" }),
    })
    if (isRecord(json) && Array.isArray(json.items) && json.items.length > maxItems) {
      return yield* new InvalidBody({ message: "at most 100 items" })
    }
    if (isRecord(json) && Array.isArray(json.items) && json.items.length === 0) {
      return yield* new InvalidBody({ message: "at least 1 item" })
    }
    const probed = yield* Schema.decodeUnknown(VersionProbe)(json).pipe(Effect.either)
    if (probed._tag === "Right" && probed.right.schemaVersion !== 1) {
      return yield* new UnsupportedSchemaVersion({ schemaVersion: probed.right.schemaVersion })
    }
    const decoded = yield* Schema.decodeUnknown(IngestRequest)(json).pipe(
      Effect.mapError((error) => new InvalidBody({ message: TreeFormatter.formatErrorSync(error) })),
    )
    const originals = isRecord(json) && Array.isArray(json.items) ? json.items : []
    const rows: Array<SettledRow> = []
    for (let index = 0; index < decoded.items.length; index++) {
      const item = decoded.items[index]
      if (item === undefined) return yield* Effect.die("decoded item missing")
      const id = item.id ?? (yield* settleId)
      const original = originals[index]
      const raw = JSON.stringify(isRecord(original) ? { ...original, id } : { id })
      rows.push({
        id,
        url: item.url ?? null,
        text: item.text,
        type: item.type,
        source: item.source,
        tags: item.tags,
        ts: DateTime.formatIso(item.ts),
        raw,
      })
    }
    const clickhouse = yield* ClickHouse
    yield* clickhouse.insert(jsonEachRow(rows))
    return jsonResponse(201, {
      schemaVersion: 1,
      inserted: rows.length,
      ids: rows.map((row) => row.id),
    })
  })

const route = (request: Request) =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname
    if (request.method === "OPTIONS" && (path === "/v1/items" || path === "/health")) {
      return new Response(null, { status: 204, headers: corsHeaders })
    }
    if (request.method === "GET" && path === "/health") {
      return jsonResponse(200, { ok: true })
    }
    if (request.method === "POST" && path === "/v1/items") {
      return yield* ingest(request)
    }
    return yield* new NotFound()
  })

export const handle = (
  request: Request,
): Effect.Effect<Response, never, Auth | RateLimit | ClickHouse | IdSource> =>
  route(request).pipe(Effect.catchAll((error) => Effect.succeed(failureResponse(error))))

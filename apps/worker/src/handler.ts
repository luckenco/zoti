import {
  type ApiFailure,
  IngestRequest,
  RecordId,
  VersionProbe,
  apiFailureBody,
  maxBodyBytes,
  maxRecords,
  statusForFailure,
  InvalidBody,
  Misconfigured,
  NotFound,
  PayloadTooLarge,
  Unauthorized,
  UnsupportedSchemaVersion,
} from "@herodotus/schema"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"
import { Auth } from "./auth"
import { ItemStore } from "./motherduck"
import type { SettledRow } from "./sql"
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
  return yield* Schema.decodeUnknown(RecordId)(raw).pipe(
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
    const identity = identified.right
    yield* limiter.consume(identity.name)

    const text = yield* readLimited(request)
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new InvalidBody({ message: "body is not JSON" }),
    })
    const originals = isRecord(json) && Array.isArray(json.records) ? json.records : []
    if (isRecord(json) && Array.isArray(json.records) && originals.length > maxRecords) {
      return yield* new InvalidBody({ message: `at most ${maxRecords} records` })
    }
    if (isRecord(json) && Array.isArray(json.records) && originals.length === 0) {
      return yield* new InvalidBody({ message: "at least 1 record" })
    }
    const probed = yield* Schema.decodeUnknown(VersionProbe)(json).pipe(Effect.either)
    if (probed._tag === "Right" && probed.right.schemaVersion !== 1) {
      return yield* new UnsupportedSchemaVersion({ schemaVersion: probed.right.schemaVersion })
    }
    if (originals.some((original) => isRecord(original) && ("actor" in original || "agent" in original))) {
      return yield* new InvalidBody({ message: "actor and agent are set by the server" })
    }
    const decoded = yield* Schema.decodeUnknown(IngestRequest)(json).pipe(
      Effect.mapError((error) => new InvalidBody({ message: TreeFormatter.formatErrorSync(error) })),
    )
    const rows: Array<SettledRow> = []
    for (let index = 0; index < decoded.records.length; index++) {
      const record = decoded.records[index]
      if (record === undefined) return yield* Effect.die("decoded record missing")
      const id = record.id ?? (yield* settleId)
      const original = originals[index]
      rows.push({
        id,
        kind: record.kind,
        via: record.via,
        actor: identity.actor,
        agent: identity.actor === "agent" ? identity.name : null,
        url: record.url ?? null,
        title: record.title ?? null,
        author: record.author ?? null,
        site: record.site ?? null,
        published_at: record.publishedAt ? DateTime.formatIso(record.publishedAt) : null,
        about_id: record.aboutId ?? null,
        text: record.text ?? "",
        tags: record.tags,
        ts: DateTime.formatIso(record.ts),
        raw: JSON.stringify(isRecord(original) ? { ...original, id } : { id }),
      })
    }
    const store = yield* ItemStore
    yield* store.put(rows)
    return jsonResponse(201, {
      schemaVersion: 1,
      inserted: rows.length,
      ids: rows.map((row) => row.id),
    })
  })

const route = (request: Request) =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname
    if (request.method === "OPTIONS" && (path === "/v1/records" || path === "/health")) {
      return new Response(null, { status: 204, headers: corsHeaders })
    }
    if (request.method === "GET" && path === "/health") {
      return jsonResponse(200, { ok: true })
    }
    if (request.method === "POST" && path === "/v1/records") {
      return yield* ingest(request)
    }
    return yield* new NotFound()
  })

export const handle = (
  request: Request,
): Effect.Effect<Response, never, Auth | RateLimit | ItemStore | IdSource> =>
  route(request).pipe(Effect.catchAll((error) => Effect.succeed(failureResponse(error))))

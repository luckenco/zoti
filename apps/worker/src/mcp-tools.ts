import {
  InvalidBody,
  Misconfigured,
  RecordId,
  RecordInput,
  StoreWriteFailed,
  maxKindLength,
  maxTagLength,
  maxTextLength,
  schemaVersion,
} from "@herodotus/schema"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { DateTime, Effect, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"
import { z } from "zod"
import type { Identity } from "./auth"
import { settleRecord, type IdSource } from "./handler"
import { ItemStore } from "./motherduck"
import { defaultReadLimit } from "./sql"

const nullableString = z.string().nullable().optional()

export const addItemInput = z
  .object({
    id: z.string().optional(),
    kind: z.string(),
    via: z.string(),
    url: nullableString,
    title: nullableString,
    author: nullableString,
    site: nullableString,
    publishedAt: nullableString,
    aboutId: nullableString,
    text: z.string().optional(),
    tags: z.array(z.string()),
    ts: z.string(),
  })
  .passthrough()

const limit = z.number().int().min(1).max(100)

export const searchItemsInput = z
  .object({
    text: z.string().max(maxTextLength).optional(),
    tag: z.string().max(maxTagLength).optional(),
    source: z.string().max(maxKindLength).optional(),
    type: z.string().max(maxKindLength).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: limit.optional(),
    unread: z.boolean().optional(),
  })
  .strict()

export const recentItemsInput = z
  .object({
    limit: limit.optional(),
    unread: z.boolean().optional(),
  })
  .strict()

export const markConsumedInput = z
  .object({
    ids: z.array(z.string()).min(1).max(100),
    consumed: z.boolean().optional(),
  })
  .strict()

export const addItemDescription =
  "Upsert one record, the same fields as POST /v1/records. kind is the type. via is the source. tags and ts are required. Provide text or url. Omit id to create; send the same id and ts to update. actor and agent are stamped from the bearer token."

export const searchItemsDescription =
  "Find records where text, title, or url contains a substring, case-insensitively. Optional exact filters: tag, source (via), type (kind), and an inclusive UTC timestamp range (from, to) on ts. unread true keeps only records with consumed_at null. limit defaults to 20 and cannot exceed 100. Newest first. Results include consumedAt."

export const recentItemsDescription =
  "Return the newest records. unread true keeps only records with consumed_at null. limit defaults to 20 and cannot exceed 100. Results include consumedAt."

export const markConsumedDescription =
  "Set consumed_at to now, or clear it. ids holds 1 to 100 record ids. consumed defaults to true; pass false to mark them unread. Re-ingesting a record does not change consumed_at."

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toolText = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
})

const toolError = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
})

const toolFailure = (error: InvalidBody | Misconfigured | StoreWriteFailed): CallToolResult =>
  toolError(error._tag === "StoreWriteFailed" ? "store failed" : error.message)

const zodError = (error: z.ZodError): CallToolResult =>
  toolError(error.issues.map((issue) => issue.message).join("; "))

const present = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value

const instant = (value: string | undefined) =>
  Effect.gen(function* () {
    if (value === undefined) return null
    return yield* Schema.decodeUnknown(Schema.DateTimeUtc)(value).pipe(
      Effect.map(DateTime.formatIso),
      Effect.mapError(() => new InvalidBody({ message: "from and to must be UTC timestamps" })),
    )
  })

export const addItem = (
  input: unknown,
  identity: Identity,
): Effect.Effect<CallToolResult, never, ItemStore | IdSource> =>
  Effect.gen(function* () {
    if (isRecord(input) && ("actor" in input || "agent" in input)) {
      return toolError("actor and agent are set by the server")
    }
    const parsed = addItemInput.safeParse(input)
    if (!parsed.success) return zodError(parsed.error)
    const record = yield* Schema.decodeUnknown(RecordInput)(parsed.data).pipe(
      Effect.mapError((error) => new InvalidBody({ message: TreeFormatter.formatErrorSync(error) })),
    )
    if ((record.text ?? "").length === 0 && (record.url ?? "").length === 0) {
      return toolError("a record needs text or url")
    }
    const row = yield* settleRecord(record, parsed.data, identity)
    const store = yield* ItemStore
    yield* store.put([row])
    return toolText({ schemaVersion, inserted: 1, ids: [row.id] })
  }).pipe(Effect.catchAll((error) => Effect.succeed(toolFailure(error))))

export const searchItems = (input: unknown): Effect.Effect<CallToolResult, never, ItemStore> =>
  Effect.gen(function* () {
    const parsed = searchItemsInput.safeParse(input)
    if (!parsed.success) return zodError(parsed.error)
    const from = yield* instant(present(parsed.data.from))
    const to = yield* instant(present(parsed.data.to))
    const store = yield* ItemStore
    const records = yield* store.search({
      text: parsed.data.text ?? null,
      tag: parsed.data.tag ?? null,
      via: parsed.data.source ?? null,
      kind: parsed.data.type ?? null,
      from,
      to,
      limit: parsed.data.limit ?? defaultReadLimit,
      unread: parsed.data.unread ?? false,
    })
    return toolText({ records })
  }).pipe(Effect.catchAll((error) => Effect.succeed(toolFailure(error))))

export const recentItems = (input: unknown): Effect.Effect<CallToolResult, never, ItemStore> =>
  Effect.gen(function* () {
    const parsed = recentItemsInput.safeParse(input ?? {})
    if (!parsed.success) return zodError(parsed.error)
    const store = yield* ItemStore
    const records = yield* store.recent(parsed.data.limit ?? defaultReadLimit, parsed.data.unread ?? false)
    return toolText({ records })
  }).pipe(Effect.catchAll((error) => Effect.succeed(toolFailure(error))))

export const markConsumedItems = (input: unknown): Effect.Effect<CallToolResult, never, ItemStore> =>
  Effect.gen(function* () {
    const parsed = markConsumedInput.safeParse(input)
    if (!parsed.success) return zodError(parsed.error)
    const ids = yield* Schema.decodeUnknown(Schema.Array(RecordId))(parsed.data.ids).pipe(
      Effect.mapError((error) => new InvalidBody({ message: TreeFormatter.formatErrorSync(error) })),
    )
    const consumed = parsed.data.consumed ?? true
    const store = yield* ItemStore
    const updated = yield* store.markConsumed(ids, consumed)
    return toolText({ consumed, ids: updated })
  }).pipe(Effect.catchAll((error) => Effect.succeed(toolFailure(error))))

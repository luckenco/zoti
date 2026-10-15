import {
  InvalidBody,
  Misconfigured,
  NotFound,
  RecordId,
  RecordInput,
  StoreWriteFailed,
  maxFieldLength,
  maxKindLength,
  maxTagLength,
  maxTags,
  maxTextLength,
  maxUrlLength,
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
import { Zotero, ZoteroFailed, type SendRequest } from "./zotero"

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
  "Find records where text, title, or url contains a substring, case-insensitively. Optional exact filters: tag, source (via), type (kind), and an inclusive UTC timestamp range (from, to) on ts. unread true keeps only records with consumed_at null. limit defaults to 20 and cannot exceed 100. Newest first. Results include consumedAt, and zoteroKey and zoteroUrl when the row has been filed."

export const recentItemsDescription =
  "Return the newest records. unread true keeps only records with consumed_at null. limit defaults to 20 and cannot exceed 100. Results include consumedAt, and zoteroKey and zoteroUrl when the row has been filed."

export const sendToZoteroDescription =
  "File one herodotus record into Zotero as a webpage and store zoteroKey and zoteroUrl on that row. Pass id alone to file an existing record. Pass url, with optional title, site, publishedAt, text, and tags, to insert a page via mcp and file it. An id on that url payload files the stored row when the id already exists, and inserts only when it does not. Retry with the returned id. The same id returns the stored link and does not create another Zotero item. A second url call without an id inserts another record. actor and agent are set by the server. A failure after the row exists names its id."

export const searchZoteroDescription =
  "Phrase-search the Zotero library's top-level items. mode title (default) matches title and creator. mode everything matches the whole item. Omit text to browse. limit defaults to 10 and cannot exceed 25. start defaults to 0. nextStart is the next start, or null on the last page. Each item includes notes as plain text and attachment metadata."

const existingSend = z.object({ id: z.string() }).strict()

const captureSend = z
  .object({
    id: z.string().nullable().optional(),
    url: z.string(),
    title: nullableString,
    site: nullableString,
    publishedAt: nullableString,
    text: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict()

export const sendToZoteroInput = z.union([existingSend, captureSend])

const zoteroLimit = z.number().int().min(1).max(25)

export const searchZoteroInput = z
  .object({
    text: z.string().max(maxTextLength).optional(),
    mode: z.enum(["title", "everything"]).optional(),
    limit: zoteroLimit.optional(),
    start: z.number().int().min(0).optional(),
  })
  .strict()

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

const toolFailure = (
  error: InvalidBody | Misconfigured | StoreWriteFailed | NotFound | ZoteroFailed,
): CallToolResult => {
  if (error._tag === "StoreWriteFailed") return toolError("store failed")
  if (error._tag === "NotFound") return toolError("record not found")
  if (error._tag === "ZoteroFailed") {
    return toolError(error.id === null ? "zotero failed" : `zotero failed; id ${error.id}`)
  }
  return toolError(error.message)
}

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

const toSendRequest = (
  input: z.infer<typeof sendToZoteroInput>,
): Effect.Effect<SendRequest, InvalidBody> =>
  Effect.gen(function* () {
    if (!("url" in input)) {
      const id = yield* Schema.decodeUnknown(RecordId)(input.id).pipe(
        Effect.mapError((error) => new InvalidBody({ message: TreeFormatter.formatErrorSync(error) })),
      )
      return { _tag: "Existing", id }
    }
    const id =
      input.id === undefined || input.id === null
        ? null
        : yield* Schema.decodeUnknown(RecordId)(input.id).pipe(
            Effect.mapError((error) => new InvalidBody({ message: TreeFormatter.formatErrorSync(error) })),
          )
    const fields = yield* Schema.decodeUnknown(
      Schema.Struct({
        url: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maxUrlLength)),
        title: Schema.NullOr(Schema.String.pipe(Schema.maxLength(maxFieldLength))),
        site: Schema.NullOr(Schema.String.pipe(Schema.maxLength(maxFieldLength))),
        publishedAt: Schema.NullOr(Schema.DateTimeUtc),
        text: Schema.String.pipe(Schema.maxLength(maxTextLength)),
        tags: Schema.Array(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maxTagLength))).pipe(
          Schema.maxItems(maxTags),
        ),
      }),
    )({
      url: input.url,
      title: input.title ?? null,
      site: input.site ?? null,
      publishedAt: input.publishedAt ?? null,
      text: input.text ?? "",
      tags: input.tags ?? [],
    }).pipe(Effect.mapError((error) => new InvalidBody({ message: TreeFormatter.formatErrorSync(error) })))
    return {
      _tag: "Capture",
      id,
      url: fields.url,
      title: fields.title,
      site: fields.site,
      publishedAt: fields.publishedAt === null ? null : DateTime.formatIso(fields.publishedAt),
      text: fields.text,
      tags: fields.tags,
    }
  })

export const sendToZotero = (
  input: unknown,
  identity: Identity,
): Effect.Effect<CallToolResult, never, Zotero> =>
  Effect.gen(function* () {
    if (isRecord(input) && ("actor" in input || "agent" in input)) {
      return toolError("actor and agent are set by the server")
    }
    const parsed = sendToZoteroInput.safeParse(input)
    if (!parsed.success) return zodError(parsed.error)
    const request = yield* toSendRequest(parsed.data)
    const zotero = yield* Zotero
    const link = yield* zotero.send(request, identity)
    return toolText({ id: link.id, zoteroKey: link.zoteroKey, zoteroUrl: link.zoteroUrl })
  }).pipe(Effect.catchAll((error) => Effect.succeed(toolFailure(error))))

export const searchZotero = (input: unknown): Effect.Effect<CallToolResult, never, Zotero> =>
  Effect.gen(function* () {
    const parsed = searchZoteroInput.safeParse(input ?? {})
    if (!parsed.success) return zodError(parsed.error)
    const text = parsed.data.text
    const zotero = yield* Zotero
    const page = yield* zotero.search({
      text: text === undefined || text.length === 0 ? null : text,
      mode: parsed.data.mode ?? "title",
      limit: parsed.data.limit ?? 10,
      start: parsed.data.start ?? 0,
    })
    return toolText(page)
  }).pipe(Effect.catchAll((error) => Effect.succeed(toolFailure(error))))

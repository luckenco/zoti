import {
  Misconfigured,
  NotFound,
  RecordId,
  RecordInput,
  StoreWriteFailed,
  type RecordId as RecordIdType,
} from "@herodotus/schema"
import { Context, Data, DateTime, Effect, Layer, Schema } from "effect"
import type { Identity } from "./auth"
import { IdSource, settleRecord } from "./handler"
import { ItemStore, type RecordView } from "./motherduck"

declare const zoteroItemKey: unique symbol
export type ZoteroItemKey = string & { readonly [zoteroItemKey]: "ZoteroItemKey" }

declare const zoteroItemUrl: unique symbol
export type ZoteroItemUrl = string & { readonly [zoteroItemUrl]: "ZoteroItemUrl" }

export interface ZoteroLink {
  readonly id: RecordIdType
  readonly zoteroKey: ZoteroItemKey
  readonly zoteroUrl: ZoteroItemUrl
}

export type SendRequest =
  | { readonly _tag: "Existing"; readonly id: RecordIdType }
  | {
      readonly _tag: "Capture"
      readonly id: RecordIdType | null
      readonly url: string
      readonly title: string | null
      readonly site: string | null
      readonly publishedAt: string | null
      readonly text: string
      readonly tags: ReadonlyArray<string>
    }

export interface ZoteroQuery {
  readonly text: string | null
  readonly mode: "title" | "everything"
  readonly limit: number
  readonly start: number
}

export interface ZoteroNote {
  readonly key: ZoteroItemKey
  readonly text: string
}

export interface ZoteroAttachment {
  readonly key: ZoteroItemKey
  readonly title: string | null
  readonly filename: string | null
  readonly contentType: string | null
  readonly url: string | null
}

export interface ZoteroHit {
  readonly key: ZoteroItemKey
  readonly type: string
  readonly title: string | null
  readonly url: string | null
  readonly date: string | null
  readonly tags: ReadonlyArray<string>
  readonly zoteroUrl: ZoteroItemUrl
  readonly notes: ReadonlyArray<ZoteroNote>
  readonly attachments: ReadonlyArray<ZoteroAttachment>
}

export interface ZoteroPage {
  readonly items: ReadonlyArray<ZoteroHit>
  readonly nextStart: number | null
}

export class ZoteroFailed extends Data.TaggedError("ZoteroFailed")<{
  readonly id: RecordIdType | null
}> {}

export type SendError = Misconfigured | StoreWriteFailed | NotFound | ZoteroFailed

export interface ZoteroCall {
  readonly method: "GET" | "POST"
  readonly url: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string | null
}

export interface ZoteroReply {
  readonly status: number
  readonly body: string
  readonly headers: ReadonlyArray<readonly [string, string]>
}

export interface ZoteroConfig {
  readonly apiKey: string
  readonly userId: string
  readonly exchange?: (call: ZoteroCall) => Promise<ZoteroReply>
}

export class Zotero extends Context.Tag("Zotero")<
  Zotero,
  {
    readonly send: (request: SendRequest, identity: Identity) => Effect.Effect<ZoteroLink, SendError>
    readonly search: (query: ZoteroQuery) => Effect.Effect<ZoteroPage, ZoteroFailed | Misconfigured>
  }
>() {}

type Exchange = (call: ZoteroCall) => Promise<ZoteroReply>

declare const zoteroUserId: unique symbol
type ZoteroUserId = string & { readonly [zoteroUserId]: "ZoteroUserId" }

interface ReadyConfig {
  readonly apiKey: string
  readonly userId: ZoteroUserId
}

type RemoteHit = {
  readonly key: ZoteroItemKey
  readonly zoteroUrl: ZoteroItemUrl
  readonly dateAdded: string | null
}

const apiBase = "https://api.zotero.org"
const itemKeyPattern = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/
const userIdPattern = /^[1-9][0-9]{1,15}$/

const itemKey = (value: string): ZoteroItemKey | undefined =>
  itemKeyPattern.test(value) ? (value as ZoteroItemKey) : undefined

const humanUrl = (value: string): ZoteroItemUrl | undefined =>
  value.startsWith("https://www.zotero.org/") ? (value as ZoteroItemUrl) : undefined

const itemUrl = (userId: ZoteroUserId, key: ZoteroItemKey): ZoteroItemUrl =>
  `https://www.zotero.org/users/${userId}/items/${key}` as ZoteroItemUrl

const herodotusTag = (id: string): string => `herodotus:${id}`

const writeToken = (id: string): string => id.replaceAll("-", "")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const jsonValue = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

const queryString = (pairs: ReadonlyArray<readonly [string, string]>): string =>
  pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")

const redact = (message: string, apiKey: string): string => {
  if (apiKey.length === 0) return message
  const encoded = encodeURIComponent(apiKey)
  return message.split(apiKey).join("[redacted]").split(encoded).join("[redacted]")
}

const logRemote = (apiKey: string, status: number, body: string): void => {
  console.error(
    JSON.stringify({
      _tag: "ZoteroFailed",
      status,
      message: redact(body, apiKey).slice(0, 500),
    }),
  )
}

const defaultExchange = async (call: ZoteroCall): Promise<ZoteroReply> => {
  const response = await fetch(call.url, {
    method: call.method,
    headers: call.headers,
    body: call.body ?? undefined,
    signal: AbortSignal.timeout(10_000),
  })
  const headers: Array<readonly [string, string]> = []
  response.headers.forEach((value, name) => {
    headers.push([name, value])
  })
  return { status: response.status, body: await response.text(), headers }
}

const readyConfig = (config: ZoteroConfig): Effect.Effect<ReadyConfig, Misconfigured> =>
  Effect.gen(function* () {
    if (config.apiKey.length === 0) return yield* new Misconfigured({ message: "ZOTERO_API_KEY is empty" })
    if (config.userId.length === 0) return yield* new Misconfigured({ message: "ZOTERO_USER_ID is empty" })
    if (!userIdPattern.test(config.userId)) {
      return yield* new Misconfigured({ message: "ZOTERO_USER_ID is not a user id" })
    }
    return { apiKey: config.apiKey, userId: config.userId as ZoteroUserId }
  })

const authHeaders = (apiKey: string): ReadonlyArray<readonly [string, string]> => [
  ["Zotero-API-Version", "3"],
  ["Zotero-API-Key", apiKey],
  ["Accept", "application/json"],
]

const getCall = (apiKey: string, url: string): ZoteroCall => ({
  method: "GET",
  url,
  headers: authHeaders(apiKey),
  body: null,
})

const postCall = (apiKey: string, url: string, body: string, token: string): ZoteroCall => ({
  method: "POST",
  url,
  headers: [
    ...authHeaders(apiKey),
    ["Content-Type", "application/json"],
    ["Zotero-Write-Token", token],
  ],
  body,
})

const callRemote = (
  exchange: Exchange,
  apiKey: string,
  id: RecordIdType | null,
  call: ZoteroCall,
): Effect.Effect<ZoteroReply, ZoteroFailed> =>
  Effect.tryPromise({
    try: () => exchange(call),
    catch: (error) => {
      const message = error instanceof Error ? error.message : "zotero request failed"
      logRemote(apiKey, 0, message)
      return new ZoteroFailed({ id })
    },
  })

const failed = (apiKey: string, status: number, body: string, id: RecordIdType | null): ZoteroFailed => {
  logRemote(apiKey, status, body)
  return new ZoteroFailed({ id })
}

const recordIdOf = (value: string): Effect.Effect<RecordIdType, ZoteroFailed> =>
  Schema.decodeUnknown(RecordId)(value).pipe(Effect.mapError(() => new ZoteroFailed({ id: null })))

const utcDay = (iso: string): string => {
  const made = DateTime.make(iso)
  if (made._tag === "None") return iso.slice(0, 10)
  return DateTime.formatIsoDateUtc(made.value)
}

const titled = (row: RecordView): string => {
  if (row.title !== null && row.title.length > 0) return row.title
  const line = row.text.split("\n", 1)[0]?.trim() ?? ""
  if (line.length > 0) return line
  if (row.url !== null && row.url.length > 0) return row.url
  return "Untitled"
}

const webpageJson = (row: RecordView): string => {
  const marker = herodotusTag(row.id)
  const tags = row.tags.map((tag) => ({ tag }))
  if (!row.tags.includes(marker)) tags.push({ tag: marker })
  return JSON.stringify([
    {
      itemType: "webpage",
      title: titled(row),
      url: row.url !== null && row.url.length > 0 ? row.url : undefined,
      date: utcDay(row.publishedAt ?? row.ts),
      accessDate: utcDay(row.ts),
      websiteTitle: row.site !== null && row.site.length > 0 ? row.site : undefined,
      tags,
    },
  ])
}

const alternateHref = (value: unknown): string | undefined => {
  if (!isRecord(value) || !isRecord(value.links) || !isRecord(value.links.alternate)) return undefined
  return typeof value.links.alternate.href === "string" ? value.links.alternate.href : undefined
}

const urlFor = (userId: ZoteroUserId, key: ZoteroItemKey, href: string | undefined): ZoteroItemUrl =>
  (href === undefined ? undefined : humanUrl(href)) ?? itemUrl(userId, key)

const linkFor = (id: RecordIdType, key: ZoteroItemKey, href: string | undefined, userId: ZoteroUserId): ZoteroLink => ({
  id,
  zoteroKey: key,
  zoteroUrl: urlFor(userId, key, href),
})

const storedLink = (row: RecordView, id: RecordIdType, userId: ZoteroUserId): ZoteroLink | null => {
  if (row.zoteroKey === null || row.zoteroUrl === null) return null
  const key = itemKey(row.zoteroKey)
  if (key === undefined) return null
  return linkFor(id, key, row.zoteroUrl, userId)
}

const keyOf = (item: Record<string, unknown>, data: Record<string, unknown> | null): ZoteroItemKey | undefined => {
  if (typeof item.key === "string") {
    const parsed = itemKey(item.key)
    if (parsed !== undefined) return parsed
  }
  if (data !== null && typeof data.key === "string") return itemKey(data.key)
  return undefined
}

const remoteHits = (body: string, userId: ZoteroUserId): ReadonlyArray<RemoteHit> | null => {
  const json = jsonValue(body)
  if (!Array.isArray(json)) return null
  const hits: Array<RemoteHit> = []
  for (const item of json) {
    if (!isRecord(item)) return null
    const data = isRecord(item.data) ? item.data : null
    const key = keyOf(item, data)
    if (key === undefined) continue
    const itemType = data !== null && typeof data.itemType === "string" ? data.itemType : ""
    if (itemType.length > 0 && itemType !== "webpage") continue
    const dateAdded = data !== null && typeof data.dateAdded === "string" ? data.dateAdded : null
    hits.push({ key, zoteroUrl: urlFor(userId, key, alternateHref(item)), dateAdded })
  }
  return hits
}

const oldestHit = (remote: ReadonlyArray<RemoteHit>): RemoteHit | null => {
  const ranked = [...remote].sort((left, right) => {
    if (left.dateAdded === right.dateAdded) return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
    if (left.dateAdded === null) return 1
    if (right.dateAdded === null) return -1
    return left.dateAdded < right.dateAdded ? -1 : 1
  })
  return ranked[0] ?? null
}

type ParsedWrite =
  | { readonly _tag: "Saved"; readonly key: ZoteroItemKey; readonly zoteroUrl: ZoteroItemUrl }
  | { readonly _tag: "Failed" }

const savedKey = (value: unknown, userId: ZoteroUserId): ParsedWrite => {
  if (isRecord(value)) {
    const key = typeof value.key === "string" ? itemKey(value.key) : undefined
    if (key === undefined) return { _tag: "Failed" }
    return { _tag: "Saved", key, zoteroUrl: urlFor(userId, key, alternateHref(value)) }
  }
  if (typeof value === "string") {
    const key = itemKey(value)
    if (key === undefined) return { _tag: "Failed" }
    return { _tag: "Saved", key, zoteroUrl: itemUrl(userId, key) }
  }
  return { _tag: "Failed" }
}

const parseWrite = (body: string, userId: ZoteroUserId): ParsedWrite => {
  const json = jsonValue(body)
  if (!isRecord(json)) return { _tag: "Failed" }
  if (isRecord(json.successful) && "0" in json.successful) return savedKey(json.successful["0"], userId)
  if (isRecord(json.success) && "0" in json.success) return savedKey(json.success["0"], userId)
  if (isRecord(json.unchanged) && "0" in json.unchanged) return savedKey(json.unchanged["0"], userId)
  return { _tag: "Failed" }
}

const stringTags = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return []
  const tags: Array<string> = []
  for (const item of value) {
    if (typeof item === "string") tags.push(item)
    else if (isRecord(item) && typeof item.tag === "string") tags.push(item.tag)
  }
  return tags
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null)

interface TopItem {
  readonly key: ZoteroItemKey
  readonly type: string
  readonly title: string | null
  readonly url: string | null
  readonly date: string | null
  readonly tags: ReadonlyArray<string>
  readonly zoteroUrl: ZoteroItemUrl
}

const parseTop = (body: string, userId: ZoteroUserId): ReadonlyArray<TopItem> | null => {
  const json = jsonValue(body)
  if (!Array.isArray(json)) return null
  const items: Array<TopItem> = []
  for (const item of json) {
    if (!isRecord(item) || !isRecord(item.data)) return null
    const key = keyOf(item, item.data)
    const type = item.data.itemType
    if (key === undefined || typeof type !== "string" || type.length === 0) return null
    items.push({
      key,
      type,
      title: textOrNull(item.data.title),
      url: textOrNull(item.data.url),
      date: textOrNull(item.data.date),
      tags: stringTags(item.data.tags),
      zoteroUrl: urlFor(userId, key, alternateHref(item)),
    })
  }
  return items
}

const plainText = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim()

const parseChildren = (
  body: string,
): { readonly notes: ReadonlyArray<ZoteroNote>; readonly attachments: ReadonlyArray<ZoteroAttachment> } | null => {
  const json = jsonValue(body)
  if (!Array.isArray(json)) return null
  const notes: Array<ZoteroNote> = []
  const attachments: Array<ZoteroAttachment> = []
  for (const item of json) {
    if (!isRecord(item) || !isRecord(item.data)) return null
    const kind = item.data.itemType
    if (kind !== "note" && kind !== "attachment") continue
    const key = keyOf(item, item.data)
    if (key === undefined) return null
    if (kind === "note") {
      notes.push({ key, text: plainText(typeof item.data.note === "string" ? item.data.note : "") })
      continue
    }
    attachments.push({
      key,
      title: textOrNull(item.data.title),
      filename: textOrNull(item.data.filename),
      contentType: textOrNull(item.data.contentType),
      url: textOrNull(item.data.url),
    })
  }
  return { notes, attachments }
}

const headerValue = (headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined =>
  headers.find(([key]) => key.toLowerCase() === name)?.[1]

const nextStartOf = (
  start: number,
  limit: number,
  count: number,
  headers: ReadonlyArray<readonly [string, string]>,
): number | null => {
  const raw = headerValue(headers, "total-results")
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const total = Number(raw)
    return start + count < total ? start + count : null
  }
  return count === limit ? start + count : null
}

const tagUrl = (userId: ZoteroUserId, id: string): string =>
  `${apiBase}/users/${userId}/items/top?${queryString([
    ["format", "json"],
    ["itemType", "webpage"],
    ["limit", "5"],
    ["sort", "dateAdded"],
    ["direction", "asc"],
    ["tag", herodotusTag(id)],
  ])}`

const topUrl = (userId: ZoteroUserId, query: ZoteroQuery): string => {
  const pairs: Array<readonly [string, string]> = [
    ["format", "json"],
    ["limit", String(query.limit)],
  ]
  if (query.text !== null && query.text.length > 0) pairs.push(["q", query.text])
  pairs.push(["qmode", query.mode === "title" ? "titleCreatorYear" : "everything"], ["start", String(query.start)])
  return `${apiBase}/users/${userId}/items/top?${queryString(pairs)}`
}

const childrenUrl = (userId: ZoteroUserId, key: ZoteroItemKey): string =>
  `${apiBase}/users/${userId}/items/${encodeURIComponent(key)}/children?format=json&limit=100`

const searchTag = (
  exchange: Exchange,
  ready: ReadyConfig,
  id: RecordIdType,
): Effect.Effect<ReadonlyArray<RemoteHit>, ZoteroFailed> =>
  Effect.gen(function* () {
    const reply = yield* callRemote(exchange, ready.apiKey, id, getCall(ready.apiKey, tagUrl(ready.userId, id)))
    if (reply.status !== 200) return yield* failed(ready.apiKey, reply.status, reply.body, id)
    const hits = remoteHits(reply.body, ready.userId)
    if (hits === null) return yield* failed(ready.apiKey, reply.status, reply.body, id)
    return hits
  })

const keepLink = (
  store: Context.Tag.Service<typeof ItemStore>,
  ready: ReadyConfig,
  id: RecordIdType,
  key: ZoteroItemKey,
  url: ZoteroItemUrl,
): Effect.Effect<ZoteroLink, SendError> =>
  Effect.gen(function* () {
    const stamped = yield* store.stampZotero(id, key, url)
    const keptKey = itemKey(stamped.zoteroKey)
    if (keptKey === undefined) return yield* new ZoteroFailed({ id })
    return linkFor(id, keptKey, stamped.zoteroUrl, ready.userId)
  })

const fileRow = (
  exchange: Exchange,
  store: Context.Tag.Service<typeof ItemStore>,
  ready: ReadyConfig,
  row: RecordView,
): Effect.Effect<ZoteroLink, SendError> =>
  Effect.gen(function* () {
    const id = yield* recordIdOf(row.id)
    const linked = storedLink(row, id, ready.userId)
    if (linked !== null && linked.zoteroUrl === row.zoteroUrl) return linked
    if (linked !== null) return yield* keepLink(store, ready, id, linked.zoteroKey, linked.zoteroUrl)
    const found = oldestHit(yield* searchTag(exchange, ready, id))
    if (found !== null) return yield* keepLink(store, ready, id, found.key, found.zoteroUrl)
    const reply = yield* callRemote(
      exchange,
      ready.apiKey,
      id,
      postCall(
        ready.apiKey,
        `${apiBase}/users/${ready.userId}/items`,
        webpageJson(row),
        writeToken(id),
      ),
    )
    if (reply.status === 412) {
      const again = oldestHit(yield* searchTag(exchange, ready, id))
      if (again === null) return yield* failed(ready.apiKey, reply.status, reply.body, id)
      return yield* keepLink(store, ready, id, again.key, again.zoteroUrl)
    }
    if (reply.status !== 200) return yield* failed(ready.apiKey, reply.status, reply.body, id)
    const written = parseWrite(reply.body, ready.userId)
    if (written._tag === "Failed") return yield* failed(ready.apiKey, reply.status, reply.body, id)
    return yield* keepLink(store, ready, id, written.key, written.zoteroUrl)
  })

const captureOriginal = (request: Extract<SendRequest, { _tag: "Capture" }>): Record<string, unknown> => {
  const original: Record<string, unknown> = { url: request.url }
  if (request.title !== null) original.title = request.title
  if (request.site !== null) original.site = request.site
  if (request.publishedAt !== null) original.publishedAt = request.publishedAt
  if (request.text.length > 0) original.text = request.text
  if (request.tags.length > 0) original.tags = [...request.tags]
  return original
}

const insertCapture = (
  store: Context.Tag.Service<typeof ItemStore>,
  ids: Context.Tag.Service<typeof IdSource>,
  request: Extract<SendRequest, { _tag: "Capture" }>,
  identity: Identity,
): Effect.Effect<RecordView, SendError> =>
  Effect.gen(function* () {
    const ts = DateTime.formatIso(yield* DateTime.now)
    const decoded = yield* Schema.decodeUnknown(RecordInput)({
      ...(request.id === null ? {} : { id: request.id }),
      kind: "page",
      via: "mcp",
      url: request.url,
      title: request.title,
      site: request.site,
      publishedAt: request.publishedAt,
      text: request.text,
      tags: [...request.tags],
      ts,
    }).pipe(Effect.mapError(() => new ZoteroFailed({ id: request.id })))
    const settled = yield* settleRecord(decoded, captureOriginal(request), identity).pipe(
      Effect.provideService(IdSource, ids),
    )
    yield* store.put([settled])
    const loaded = yield* store.get(settled.id)
    if (loaded === null) return yield* new ZoteroFailed({ id: yield* recordIdOf(settled.id) })
    return loaded
  })

const loadRow = (
  store: Context.Tag.Service<typeof ItemStore>,
  ids: Context.Tag.Service<typeof IdSource>,
  request: SendRequest,
  identity: Identity,
): Effect.Effect<RecordView, SendError> =>
  Effect.gen(function* () {
    if (request._tag === "Existing") {
      const found = yield* store.get(request.id)
      if (found === null) return yield* new NotFound()
      return found
    }
    if (request.id !== null) {
      const found = yield* store.get(request.id)
      if (found !== null) return found
    }
    return yield* insertCapture(store, ids, request, identity)
  })

const send = (
  config: ZoteroConfig,
  exchange: Exchange,
  store: Context.Tag.Service<typeof ItemStore>,
  ids: Context.Tag.Service<typeof IdSource>,
  request: SendRequest,
  identity: Identity,
): Effect.Effect<ZoteroLink, SendError> =>
  Effect.gen(function* () {
    const ready = yield* readyConfig(config)
    const row = yield* loadRow(store, ids, request, identity)
    return yield* fileRow(exchange, store, ready, row)
  })

const search = (
  config: ZoteroConfig,
  exchange: Exchange,
  query: ZoteroQuery,
): Effect.Effect<ZoteroPage, ZoteroFailed | Misconfigured> =>
  Effect.gen(function* () {
    const ready = yield* readyConfig(config)
    const reply = yield* callRemote(exchange, ready.apiKey, null, getCall(ready.apiKey, topUrl(ready.userId, query)))
    if (reply.status !== 200) return yield* failed(ready.apiKey, reply.status, reply.body, null)
    const top = parseTop(reply.body, ready.userId)
    if (top === null) return yield* failed(ready.apiKey, reply.status, reply.body, null)
    const items: Array<ZoteroHit> = []
    for (const item of top) {
      const childrenReply = yield* callRemote(
        exchange,
        ready.apiKey,
        null,
        getCall(ready.apiKey, childrenUrl(ready.userId, item.key)),
      )
      if (childrenReply.status !== 200) return yield* failed(ready.apiKey, childrenReply.status, childrenReply.body, null)
      const children = parseChildren(childrenReply.body)
      if (children === null) return yield* failed(ready.apiKey, childrenReply.status, childrenReply.body, null)
      items.push({
        key: item.key,
        type: item.type,
        title: item.title,
        url: item.url,
        date: item.date,
        tags: item.tags,
        zoteroUrl: item.zoteroUrl,
        notes: children.notes,
        attachments: children.attachments,
      })
    }
    return { items, nextStart: nextStartOf(query.start, query.limit, items.length, reply.headers) }
  })

export const zoteroLayer = (config: ZoteroConfig): Layer.Layer<Zotero, never, ItemStore | IdSource> =>
  Layer.effect(
    Zotero,
    Effect.gen(function* () {
      const store = yield* ItemStore
      const ids = yield* IdSource
      const exchange = config.exchange ?? defaultExchange
      return {
        send: (request, identity) => send(config, exchange, store, ids, request, identity),
        search: (query) => search(config, exchange, query),
      }
    }),
  )

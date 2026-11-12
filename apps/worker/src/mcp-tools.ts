import type { CallToolResult } from "@modelcontextprotocol/server"
import { Effect } from "effect"
import { z } from "zod"
import { Misconfigured, NotFound } from "./errors"
import { Zotero, ZoteroFailed, type SendRequest } from "./zotero"

const field = z.string().max(512).nullable().optional()

export const sendToZoteroInput = z.union([
  z.object({ id: z.uuid() }).strict(),
  z.object({
    id: z.uuid().nullable().optional(),
    url: z.url({ protocol: /^https?$/ }).max(2048),
    title: field,
    site: field,
    publishedAt: z.iso.datetime().nullable().optional(),
    text: z.string().max(100_000).optional(),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  }).strict(),
])

export const searchZoteroInput = z.object({
  text: z.string().max(100_000).optional(),
  mode: z.enum(["title", "everything"]).optional(),
  limit: z.number().int().min(1).max(25).optional(),
  start: z.number().int().min(0).optional(),
}).strict()

export const sendToZoteroDescription =
  "Save a URL directly to Zotero as a webpage. Optional title, site, publishedAt (UTC timestamp), text (title fallback), and tags. Supply a UUID id and reuse it on retries to avoid duplicates; otherwise one is generated. Returns id, zoteroKey, and zoteroUrl. Pass id alone to recover a previously saved item. Retrying an existing id returns that item without updating it. Failures include the id when known."

export const searchZoteroDescription =
  "Search the Zotero library's top-level items. mode title (default) matches title, creator, and year; everything searches all fields. Omit text to browse. limit defaults to 10 (maximum 25), start to 0. Results include plain-text notes, attachment metadata, and nextStart (null on the last page)."

const toolText = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
})

const toolError = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
})

const toolFailure = (error: Misconfigured | NotFound | ZoteroFailed): CallToolResult => {
  if (error._tag === "NotFound") return toolError("Zotero item not found; retry with the same id and url")
  if (error._tag === "ZoteroFailed") {
    return toolError(error.id === null ? "zotero failed" : `zotero failed; id ${error.id}`)
  }
  return toolError(error.message)
}

const zodError = (error: z.ZodError): CallToolResult =>
  toolError(error.issues.map((issue) => issue.message).join("; "))

export const sendToZotero = (input: unknown): Effect.Effect<CallToolResult, never, Zotero> =>
  Effect.gen(function* () {
    const parsed = sendToZoteroInput.safeParse(input)
    if (!parsed.success) return zodError(parsed.error)
    const data = parsed.data
    let request: SendRequest
    if ("url" in data) {
      request = {
        _tag: "Capture",
        id: data.id ?? null,
        url: data.url,
        title: data.title ?? null,
        site: data.site ?? null,
        publishedAt: data.publishedAt ?? null,
        text: data.text ?? "",
        tags: data.tags ?? [],
      }
    } else {
      request = { _tag: "Existing", id: data.id }
    }
    const zotero = yield* Zotero
    return toolText(yield* zotero.send(request))
  }).pipe(Effect.catchAll((error) => Effect.succeed(toolFailure(error))))

export const searchZotero = (input: unknown): Effect.Effect<CallToolResult, never, Zotero> =>
  Effect.gen(function* () {
    const parsed = searchZoteroInput.safeParse(input ?? {})
    if (!parsed.success) return zodError(parsed.error)
    const zotero = yield* Zotero
    return toolText(yield* zotero.search({
      text: parsed.data.text || null,
      mode: parsed.data.mode ?? "title",
      limit: parsed.data.limit ?? 10,
      start: parsed.data.start ?? 0,
    }))
  }).pipe(Effect.catchAll((error) => Effect.succeed(toolFailure(error))))

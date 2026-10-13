import { IngestRequest, maxFieldLength } from "@herodotus/schema"
import { Data, Effect, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"

export class CaptureRejected extends Data.TaggedError("CaptureRejected")<{
  readonly message: string
}> {}

// Empty strings are what the page gave us when a tag was missing.
export interface PageCapture {
  readonly id: string
  readonly pageUrl: string
  readonly title: string
  readonly ogTitle: string
  readonly author: string
  readonly published: string
  readonly selection: string
  readonly tags: ReadonlyArray<string>
  readonly ts: string
}

const given = (value: string): string | undefined => {
  if (value.length === 0) return undefined
  return value
}

const onSite = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

const kindFor = (host: string, selection: string): string => {
  if (onSite(host, "youtube.com") || onSite(host, "youtu.be")) return "video"
  if (onSite(host, "x.com") || onSite(host, "twitter.com")) return "tweet"
  if (selection.length > 0) return "selection"
  return "page"
}

const publishedAt = (published: string): string | undefined => {
  const date = new Date(published)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

export const buildCapture = (page: PageCapture) =>
  Effect.gen(function* () {
    const host = yield* Effect.try({
      try: () => new URL(page.pageUrl).hostname,
      catch: () => new CaptureRejected({ message: "page url is not a URL" }),
    })
    const wire = {
      schemaVersion: 1,
      records: [
        {
          id: page.id,
          kind: kindFor(host, page.selection),
          via: "chrome",
          url: page.pageUrl,
          title: given(page.ogTitle.slice(0, maxFieldLength)) ?? given(page.title.slice(0, maxFieldLength)),
          author: given(page.author.slice(0, maxFieldLength)),
          site: given(host.slice(0, maxFieldLength)),
          publishedAt: publishedAt(page.published),
          text: given(page.selection),
          tags: page.tags,
          ts: page.ts,
        },
      ],
    }
    yield* Schema.decodeUnknown(IngestRequest)(wire).pipe(
      Effect.mapError((error) => new CaptureRejected({ message: TreeFormatter.formatErrorSync(error) })),
    )
    return wire
  })

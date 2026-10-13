import { IngestRequest } from "@private-life/schema"
import { Data, DateTime, Effect, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"

export class CaptureRejected extends Data.TaggedError("CaptureRejected")<{
  readonly message: string
}> {}

export interface PageCapture {
  readonly pageUrl: string
  readonly title: string
  readonly selection: string
  readonly tags: ReadonlyArray<string>
  readonly ts: string
}

export const buildCapture = (
  page: PageCapture,
): Effect.Effect<
  {
    readonly schemaVersion: 1
    readonly items: ReadonlyArray<{
      readonly url: string
      readonly text: string
      readonly type: string
      readonly source: "chrome"
      readonly tags: ReadonlyArray<string>
      readonly ts: string
    }>
  },
  CaptureRejected
> =>
  Effect.gen(function* () {
    const text =
      page.selection.length > 0 ? page.selection : page.title.length > 0 ? page.title : page.pageUrl
    const decoded = yield* Schema.decodeUnknown(IngestRequest)({
      schemaVersion: 1,
      items: [
        {
          url: page.pageUrl,
          text,
          type: page.selection.length > 0 ? "selection" : "page",
          source: "chrome",
          tags: [...page.tags],
          ts: page.ts,
        },
      ],
    }).pipe(Effect.mapError((error) => new CaptureRejected({ message: TreeFormatter.formatErrorSync(error) })))
    const item = decoded.items[0]
    if (item === undefined || item.url === undefined || item.url === null) {
      return yield* new CaptureRejected({ message: "capture produced no page" })
    }
    return {
      schemaVersion: 1,
      items: [
        {
          url: item.url,
          text: item.text,
          type: item.type,
          source: "chrome",
          tags: item.tags,
          ts: DateTime.formatIso(item.ts),
        },
      ],
    }
  })

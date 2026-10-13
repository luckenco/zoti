import { HttpBody, HttpClient } from "@effect/platform"
import { IngestRequest, IngestResponse, ItemId } from "@private-life/schema"
import { Config, Data, DateTime, Effect, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"

export class CliConfigError extends Data.TaggedError("CliConfigError")<{
  readonly message: string
}> {}

export class CaptureRejected extends Data.TaggedError("CaptureRejected")<{
  readonly message: string
}> {}

export class IngestFailed extends Data.TaggedError("IngestFailed")<{
  readonly status: number
  readonly message: string
}> {}

export interface ClientConfig {
  readonly url: string
  readonly token: string
}

export interface CaptureInput {
  readonly type: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly source: string
  readonly url?: string
}

export const loadConfig: Effect.Effect<{ readonly url: string; readonly token: string }, CliConfigError> =
  Effect.gen(function* () {
    const url = yield* Config.string("PRIVATE_LIFE_URL")
    const token = yield* Config.string("PRIVATE_LIFE_TOKEN")
    if (url.length === 0 || token.length === 0) {
      return yield* new CliConfigError({ message: "PRIVATE_LIFE_URL and PRIVATE_LIFE_TOKEN are required" })
    }
    return { url, token }
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "CliConfigError"
        ? error
        : new CliConfigError({ message: "PRIVATE_LIFE_URL and PRIVATE_LIFE_TOKEN are required" }),
    ),
  )

const endpoint = (base: string): Effect.Effect<URL, CliConfigError> =>
  Effect.try({
    try: () => new URL("/v1/items", base.endsWith("/") ? base : `${base}/`),
    catch: () => new CliConfigError({ message: "PRIVATE_LIFE_URL is not a URL" }),
  })

export const ingest = (
  config: ClientConfig,
  input: CaptureInput,
): Effect.Effect<ReadonlyArray<string>, CaptureRejected | CliConfigError | IngestFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknown(ItemId)(crypto.randomUUID()).pipe(
      Effect.mapError(() => new CaptureRejected({ message: "uuid generator failed" })),
    )
    const ts = DateTime.formatIso(yield* DateTime.now)
    const url = yield* endpoint(config.url)
    const decoded = yield* Schema.decodeUnknown(IngestRequest)({
      schemaVersion: 1,
      items: [
        {
          id,
          text: input.text,
          type: input.type,
          source: input.source,
          tags: [...input.tags],
          ts,
          ...(input.url === undefined ? {} : { url: input.url }),
        },
      ],
    }).pipe(
      Effect.mapError((error) => new CaptureRejected({ message: TreeFormatter.formatErrorSync(error) })),
    )
    const item = decoded.items[0]
    if (item === undefined) return yield* new CaptureRejected({ message: "capture produced no item" })
    const wire = {
      schemaVersion: 1,
      items: [
        {
          id: item.id,
          text: item.text,
          type: item.type,
          source: item.source,
          tags: item.tags,
          ts: DateTime.formatIso(item.ts),
          ...(item.url === undefined ? {} : { url: item.url }),
        },
      ],
    }
    const http = yield* HttpClient.HttpClient
    const response = yield* http
      .post(url, {
        body: HttpBody.text(JSON.stringify(wire), "application/json"),
        headers: { authorization: `Bearer ${config.token}` },
      })
      .pipe(Effect.mapError(() => new IngestFailed({ status: 0, message: "request failed" })))
    const body = yield* response.text.pipe(
      Effect.mapError(() => new IngestFailed({ status: response.status, message: "response could not be read" })),
    )
    if (response.status !== 201) {
      return yield* new IngestFailed({ status: response.status, message: body })
    }
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(body),
      catch: () => new IngestFailed({ status: response.status, message: "response is not JSON" }),
    })
    const accepted = yield* Schema.decodeUnknown(IngestResponse)(json).pipe(
      Effect.mapError(() => new IngestFailed({ status: response.status, message: "response did not match the contract" })),
    )
    yield* Effect.sync(() => {
      console.log(accepted.ids.join("\n"))
    })
    return accepted.ids
  })

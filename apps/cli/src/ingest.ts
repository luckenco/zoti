import { HttpBody, HttpClient } from "@effect/platform"
import { IngestRequest, IngestResponse, RecordId } from "@herodotus/schema"
import { Data, DateTime, Effect, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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
  readonly kind: string
  readonly tags: ReadonlyArray<string>
  readonly text?: string | undefined
  readonly url?: string | undefined
  readonly title?: string | undefined
  readonly author?: string | undefined
  readonly site?: string | undefined
  readonly publishedAt?: string | undefined
  readonly about?: string | undefined
}

const ConfigFile = Schema.Struct({
  url: Schema.String,
  tokens: Schema.Record({ key: Schema.String, value: Schema.String }),
})

export const configPath = join(homedir(), ".config", "herodotus", "config.json")

// The token is chosen by identity, so the Worker stamps who is calling.
export const loadConfig = (
  identity: string,
  path = configPath,
  urlOverride?: string,
): Effect.Effect<ClientConfig, CliConfigError> =>
  Effect.gen(function* () {
    const fail = (message: string) => new CliConfigError({ message })
    const mode = yield* Effect.try({ try: () => statSync(path).mode, catch: () => fail(`cannot read ${path}`) })
    if ((mode & 0o077) !== 0) return yield* fail(`${path} must not be readable by others (chmod 600)`)
    const text = yield* Effect.try({ try: () => readFileSync(path, "utf8"), catch: () => fail(`cannot read ${path}`) })
    const json = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: () => fail(`${path} is not JSON`) })
    const file = yield* Schema.decodeUnknown(ConfigFile)(json).pipe(
      Effect.mapError(() => fail(`${path} must be {"url": "...", "tokens": {"<identity>": "<token>"}}`)),
    )
    if (!Object.hasOwn(file.tokens, identity)) return yield* fail(`no token for identity "${identity}" in ${path}`)
    const token = file.tokens[identity]
    if (token === undefined || token.length === 0) return yield* fail(`no token for identity "${identity}" in ${path}`)
    const url = urlOverride ?? file.url
    if (url.length === 0) return yield* fail("url is empty")
    return { url, token }
  })

const endpoint = (base: string): Effect.Effect<URL, CliConfigError> =>
  Effect.try({
    try: () => new URL("/v1/records", base.endsWith("/") ? base : `${base}/`),
    catch: () => new CliConfigError({ message: "url is not a URL" }),
  })

export const ingest = (
  config: ClientConfig,
  input: CaptureInput,
): Effect.Effect<ReadonlyArray<string>, CaptureRejected | CliConfigError | IngestFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknown(RecordId)(crypto.randomUUID()).pipe(
      Effect.mapError(() => new CaptureRejected({ message: "uuid generator failed" })),
    )
    const url = yield* endpoint(config.url)
    // JSON.stringify drops the undefined fields, so omitted flags are not sent.
    const wire = {
      schemaVersion: 1,
      records: [
        {
          id,
          kind: input.kind,
          via: "cli",
          url: input.url,
          title: input.title,
          author: input.author,
          site: input.site,
          publishedAt: input.publishedAt,
          aboutId: input.about,
          text: input.text,
          tags: input.tags,
          ts: DateTime.formatIso(yield* DateTime.now),
        },
      ],
    }
    yield* Schema.decodeUnknown(IngestRequest)(wire).pipe(
      Effect.mapError((error) => new CaptureRejected({ message: TreeFormatter.formatErrorSync(error) })),
    )
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

import { Data, Schema } from "effect"

export const schemaVersion = 1
export const maxRecords = 100
export const maxTextLength = 100_000
export const maxTagLength = 64
export const maxTags = 32
export const maxUrlLength = 2048
export const maxKindLength = 64
export const maxFieldLength = 512
export const maxBodyBytes = 1_048_576

export const RecordId = Schema.UUID.pipe(Schema.brand("RecordId"))
export type RecordId = typeof RecordId.Type

// Stamped by the Worker from the bearer token. Never accepted in a request body.
export const Actor = Schema.Literal("human", "agent")
export type Actor = typeof Actor.Type

const kind = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maxKindLength))
const tag = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maxTagLength))
const field = Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(maxFieldLength))))

export class RecordInput extends Schema.Class<RecordInput>("RecordInput")({
  id: Schema.optional(RecordId),
  kind,
  via: kind,
  url: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maxUrlLength)))),
  title: field,
  author: field,
  site: field,
  publishedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  aboutId: Schema.optional(Schema.NullOr(RecordId)),
  text: Schema.optional(Schema.String.pipe(Schema.maxLength(maxTextLength))),
  tags: Schema.Array(tag).pipe(Schema.maxItems(maxTags)),
  ts: Schema.DateTimeUtc,
}) {}

const hasContent = (record: RecordInput) =>
  (record.text ?? "").length > 0 || (record.url ?? "").length > 0 ? true : "a record needs text or url"

export class IngestRequest extends Schema.Class<IngestRequest>("IngestRequest")({
  schemaVersion: Schema.Literal(schemaVersion),
  records: Schema.Array(RecordInput.pipe(Schema.filter(hasContent))).pipe(Schema.minItems(1), Schema.maxItems(maxRecords)),
}) {}

export class VersionProbe extends Schema.Class<VersionProbe>("VersionProbe")({
  schemaVersion: Schema.Number,
}) {}

export class IngestResponse extends Schema.Class<IngestResponse>("IngestResponse")({
  schemaVersion: Schema.Literal(schemaVersion),
  inserted: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  ids: Schema.Array(RecordId).pipe(Schema.minItems(1), Schema.maxItems(maxRecords)),
}) {}

export class InvalidBody extends Data.TaggedError("InvalidBody")<{
  readonly message: string
}> {}

export class UnsupportedSchemaVersion extends Data.TaggedError("UnsupportedSchemaVersion")<{
  readonly schemaVersion: number
}> {}

export class Unauthorized extends Data.TaggedError("Unauthorized") {}

export class PayloadTooLarge extends Data.TaggedError("PayloadTooLarge") {}

export class RateLimited extends Data.TaggedError("RateLimited") {}

export class ClickHouseInsertFailed extends Data.TaggedError("ClickHouseInsertFailed")<{
  readonly status: number
}> {}

export class Misconfigured extends Data.TaggedError("Misconfigured")<{
  readonly message: string
}> {}

export class NotFound extends Data.TaggedError("NotFound") {}

export type ApiFailure =
  | InvalidBody
  | UnsupportedSchemaVersion
  | Unauthorized
  | PayloadTooLarge
  | RateLimited
  | ClickHouseInsertFailed
  | Misconfigured
  | NotFound

export const ApiFailureBody = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("InvalidBody"), message: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("UnsupportedSchemaVersion"),
    schemaVersion: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("Unauthorized") }),
  Schema.Struct({ _tag: Schema.Literal("PayloadTooLarge") }),
  Schema.Struct({ _tag: Schema.Literal("RateLimited") }),
  Schema.Struct({
    _tag: Schema.Literal("ClickHouseInsertFailed"),
    status: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("Misconfigured"), message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
)
export type ApiFailureBody = typeof ApiFailureBody.Type

export const apiFailureBody = (error: ApiFailure): ApiFailureBody => {
  switch (error._tag) {
    case "InvalidBody":
      return { _tag: "InvalidBody", message: error.message }
    case "UnsupportedSchemaVersion":
      return { _tag: "UnsupportedSchemaVersion", schemaVersion: error.schemaVersion }
    case "Unauthorized":
      return { _tag: "Unauthorized" }
    case "PayloadTooLarge":
      return { _tag: "PayloadTooLarge" }
    case "RateLimited":
      return { _tag: "RateLimited" }
    case "ClickHouseInsertFailed":
      return { _tag: "ClickHouseInsertFailed", status: error.status }
    case "Misconfigured":
      return { _tag: "Misconfigured", message: error.message }
    case "NotFound":
      return { _tag: "NotFound" }
    default: {
      const _exhaustive: never = error
      return _exhaustive
    }
  }
}

export const statusForFailure = (error: ApiFailure): number => {
  switch (error._tag) {
    case "InvalidBody":
    case "UnsupportedSchemaVersion":
      return 400
    case "Unauthorized":
      return 401
    case "NotFound":
      return 404
    case "PayloadTooLarge":
      return 413
    case "RateLimited":
      return 429
    case "ClickHouseInsertFailed":
      return 502
    case "Misconfigured":
      return 500
    default: {
      const _exhaustive: never = error
      return _exhaustive
    }
  }
}

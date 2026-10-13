import { ClickHouseInsertFailed, Misconfigured } from "@private-life/schema"
import { HttpBody, HttpClient } from "@effect/platform"
import { Context, Effect, Layer } from "effect"

export const itemsTable = "private_life.items"

export interface ClickHouseConfig {
  readonly url: string
  readonly user: string
  readonly password: string
  readonly database: string
}

export interface SettledRow {
  readonly id: string
  readonly url: string | null
  readonly text: string
  readonly type: string
  readonly source: string
  readonly tags: ReadonlyArray<string>
  readonly ts: string
  readonly raw: string
}

export const jsonEachRow = (rows: ReadonlyArray<SettledRow>): string => {
  const lines = rows.map((row) =>
    JSON.stringify({
      id: row.id,
      url: row.url,
      text: row.text,
      type: row.type,
      source: row.source,
      tags: row.tags,
      ts: row.ts,
      raw: row.raw,
    }),
  )
  return `INSERT INTO ${itemsTable} FORMAT JSONEachRow\n${lines.join("\n")}\n`
}

const setting = (name: string, value: string): Effect.Effect<string, Misconfigured> =>
  value.length === 0
    ? Effect.fail(new Misconfigured({ message: `${name} is empty` }))
    : Effect.succeed(value)

const endpoint = (config: ClickHouseConfig): Effect.Effect<URL, Misconfigured> =>
  Effect.try({
    try: () => new URL(config.url),
    catch: () => new Misconfigured({ message: "CLICKHOUSE_URL is not a URL" }),
  }).pipe(
    Effect.map((url) => {
      url.searchParams.set("database", config.database)
      url.searchParams.set("date_time_input_format", "best_effort")
      return url
    }),
  )

const logFailure = (status: number, body: string) =>
  Effect.sync(() => {
    console.error(
      JSON.stringify({
        _tag: "ClickHouseInsertFailed",
        status,
        body: body.slice(0, 500),
      }),
    )
  })

export class ClickHouse extends Context.Tag("ClickHouse")<
  ClickHouse,
  {
    readonly insert: (statement: string) => Effect.Effect<void, ClickHouseInsertFailed | Misconfigured>
  }
>() {}

export const clickHouseLayer = (config: ClickHouseConfig): Layer.Layer<ClickHouse, never, HttpClient.HttpClient> =>
  Layer.effect(
    ClickHouse,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      return {
        insert: (statement: string) =>
          Effect.gen(function* () {
            const user = yield* setting("CLICKHOUSE_USER", config.user)
            const password = yield* setting("CLICKHOUSE_PASSWORD", config.password)
            const database = yield* setting("CLICKHOUSE_DATABASE", config.database)
            yield* setting("CLICKHOUSE_URL", config.url)
            const url = yield* endpoint({ ...config, database })
            const response = yield* http
              .post(url, {
                body: HttpBody.text(statement),
                headers: {
                  "x-clickhouse-user": user,
                  "x-clickhouse-key": password,
                },
              })
              .pipe(
                Effect.tapError(() => logFailure(0, "request failed")),
                Effect.mapError(() => new ClickHouseInsertFailed({ status: 0 })),
              )
            if (response.status < 200 || response.status >= 300) {
              const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
              yield* logFailure(response.status, body)
              return yield* new ClickHouseInsertFailed({ status: response.status })
            }
          }),
      }
    }),
  )

import { Misconfigured, StoreWriteFailed } from "@herodotus/schema"
import { Effect, Layer } from "effect"
import { Client } from "pg"
import type { SqlStatement } from "./sql"
import { identifier } from "./sql"
import { itemStoreLayer, SqlTransport, type ItemStore } from "./store"

export interface SqlSession {
  readonly query: (statement: SqlStatement) => Promise<void>
  readonly close: () => Promise<void>
}

export interface MotherDuckConfig {
  readonly host: string
  readonly database: string
  readonly token: string
  readonly open?: (connectionString: string) => Promise<SqlSession>
}

const hostnamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

const setting = (name: string, value: string): Effect.Effect<string, Misconfigured> =>
  value.length === 0
    ? Effect.fail(new Misconfigured({ message: `${name} is empty` }))
    : Effect.succeed(value)

const hostname = (value: string): Effect.Effect<string, Misconfigured> =>
  Effect.gen(function* () {
    const host = yield* setting("MOTHERDUCK_HOST", value)
    if (!hostnamePattern.test(host) || host.includes("..")) {
      return yield* new Misconfigured({ message: "MOTHERDUCK_HOST is not a hostname" })
    }
    return host
  })

const databaseSetting = (database: string): Effect.Effect<string, Misconfigured> =>
  Effect.gen(function* () {
    const value = yield* setting("MOTHERDUCK_DATABASE", database)
    const name = identifier(value)
    if (name === undefined) {
      return yield* new Misconfigured({ message: "MOTHERDUCK_DATABASE is not an identifier" })
    }
    return name
  })

export const postgresUrl = (config: {
  readonly host: string
  readonly database: string
  readonly token: string
}): string =>
  `postgresql://postgres:${encodeURIComponent(config.token)}@${config.host}:5432/${config.database}?sslmode=require`

const redact = (message: string, token: string): string => {
  const encoded = encodeURIComponent(token)
  const withoutToken = token.length === 0 ? message : message.split(token).join("[redacted]")
  return encoded.length === 0 ? withoutToken : withoutToken.split(encoded).join("[redacted]")
}

const logFailure = (token: string, error: unknown): StoreWriteFailed => {
  const message = error instanceof Error ? error.message : "query failed"
  console.error(
    JSON.stringify({
      _tag: "StoreWriteFailed",
      message: redact(message, token).slice(0, 500),
    }),
  )
  return new StoreWriteFailed()
}

const pgOpen = (connectionString: string): Promise<SqlSession> => {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 60_000,
  })
  return client.connect().then(() => ({
    query: (statement) => client.query(statement.text, statement.values).then(() => undefined),
    close: () => client.end().then(() => undefined),
  }))
}

export const motherDuckTransportLayer = (config: MotherDuckConfig): Layer.Layer<SqlTransport> =>
  Layer.effect(
    SqlTransport,
    Effect.sync(() => ({
      execute: (statement) =>
        Effect.gen(function* () {
          const host = yield* hostname(config.host)
          const database = yield* databaseSetting(config.database)
          const token = yield* setting("MOTHERDUCK_TOKEN", config.token)
          const connectionString = postgresUrl({ host, database, token })
          const open = config.open ?? pgOpen
          const session = yield* Effect.tryPromise({
            try: () => open(connectionString),
            catch: (error) => logFailure(token, error),
          })
          yield* Effect.tryPromise({
            try: () => session.query(statement),
            catch: (error) => logFailure(token, error),
          }).pipe(
            Effect.ensuring(
              Effect.tryPromise({
                try: () => session.close(),
                catch: () => undefined,
              }).pipe(Effect.ignore),
            ),
          )
        }),
    })),
  )

export const motherDuckLayer = (config: MotherDuckConfig): Layer.Layer<ItemStore> =>
  itemStoreLayer(config.database).pipe(Layer.provide(motherDuckTransportLayer(config)))

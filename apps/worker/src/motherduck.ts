import { Misconfigured, NotFound, StoreWriteFailed } from "@herodotus/schema"
import { Context, Effect, Layer } from "effect"
import { Client } from "pg"
import {
  identifier,
  insertRecords,
  markConsumed,
  recentRecords,
  recordById,
  searchRecords,
  stampZotero,
  type RecordSearch,
  type SettledRow,
  type SqlStatement,
} from "./sql"

export interface RecordView {
  readonly id: string
  readonly kind: string
  readonly via: string
  readonly actor: string
  readonly agent: string | null
  readonly url: string | null
  readonly title: string | null
  readonly author: string | null
  readonly site: string | null
  readonly publishedAt: string | null
  readonly aboutId: string | null
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly ts: string
  readonly consumedAt: string | null
  readonly zoteroKey: string | null
  readonly zoteroUrl: string | null
}

export class ItemStore extends Context.Tag("ItemStore")<
  ItemStore,
  {
    readonly put: (
      rows: ReadonlyArray<SettledRow>,
    ) => Effect.Effect<void, StoreWriteFailed | Misconfigured>
    readonly search: (
      query: RecordSearch,
    ) => Effect.Effect<ReadonlyArray<RecordView>, StoreWriteFailed | Misconfigured>
    readonly recent: (
      limit: number,
      unread: boolean,
    ) => Effect.Effect<ReadonlyArray<RecordView>, StoreWriteFailed | Misconfigured>
    readonly markConsumed: (
      ids: ReadonlyArray<string>,
      consumed: boolean,
    ) => Effect.Effect<ReadonlyArray<string>, StoreWriteFailed | Misconfigured>
    readonly get: (id: string) => Effect.Effect<RecordView | null, StoreWriteFailed | Misconfigured>
    readonly stampZotero: (
      id: string,
      zoteroKey: string,
      zoteroUrl: string,
    ) => Effect.Effect<
      { readonly zoteroKey: string; readonly zoteroUrl: string },
      StoreWriteFailed | Misconfigured | NotFound
    >
  }
>() {}

export interface SqlSession {
  readonly query: (statement: SqlStatement) => Promise<ReadonlyArray<Record<string, unknown>>>
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
    query: (statement) =>
      client.query(statement.text, statement.values).then((result) =>
        Array.isArray(result.rows) ? result.rows : [],
      ),
    close: () => client.end().then(() => undefined),
  }))
}

const timestamp = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string" && value.length > 0) return value
  throw new Error("unexpected record row")
}

const nullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  throw new Error("unexpected record row")
}

const tagsOf = (value: unknown): ReadonlyArray<string> => {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("unexpected record row")
  }
  return parsed
}

const textOf = (value: unknown, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error("unexpected record row")
  return value
}

const linkColumns = (
  row: Record<string, unknown>,
): { readonly zoteroKey: string | null; readonly zoteroUrl: string | null } => {
  const zoteroKey = nullableString(row.zotero_key)
  const zoteroUrl = nullableString(row.zotero_url)
  if (zoteroKey === null && zoteroUrl === null) return { zoteroKey, zoteroUrl }
  if (zoteroKey !== null && zoteroKey.length > 0 && zoteroUrl !== null && zoteroUrl.length > 0) {
    return { zoteroKey, zoteroUrl }
  }
  throw new Error("unexpected record row")
}

const recordView = (row: Record<string, unknown>): RecordView => ({
  id: textOf(row.id),
  kind: textOf(row.kind),
  via: textOf(row.via),
  actor: textOf(row.actor),
  agent: nullableString(row.agent),
  url: nullableString(row.url),
  title: nullableString(row.title),
  author: nullableString(row.author),
  site: nullableString(row.site),
  publishedAt: nullableString(row.published_at),
  aboutId: nullableString(row.about_id),
  text: textOf(row.text, true),
  tags: tagsOf(row.tags),
  ts: timestamp(row.ts),
  consumedAt: nullableString(row.consumed_at),
  ...linkColumns(row),
})

const stampedPair = (
  row: Record<string, unknown>,
): { readonly zoteroKey: string; readonly zoteroUrl: string } => {
  const pair = linkColumns(row)
  if (pair.zoteroKey === null || pair.zoteroUrl === null) throw new Error("unexpected record row")
  return { zoteroKey: pair.zoteroKey, zoteroUrl: pair.zoteroUrl }
}

const recordsOf = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<RecordView> =>
  rows.map(recordView)

const idsOf = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> =>
  rows.map((row) => textOf(row.id))

const withSession = <A>(
  config: MotherDuckConfig,
  body: (session: SqlSession, database: string) => Promise<A>,
): Effect.Effect<A, StoreWriteFailed | Misconfigured> =>
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
    return yield* Effect.tryPromise({
      try: () => body(session, database),
      catch: (error) => logFailure(token, error),
    }).pipe(
      Effect.ensuring(
        Effect.tryPromise({
          try: () => session.close(),
          catch: () => undefined,
        }).pipe(Effect.ignore),
      ),
    )
  })

export const motherDuckLayer = (config: MotherDuckConfig): Layer.Layer<ItemStore> =>
  Layer.effect(
    ItemStore,
    Effect.sync(() => ({
      put: (rows) =>
        rows.length === 0
          ? Effect.void
          : withSession(config, (session, database) =>
              session.query(insertRecords(database, rows)).then(() => undefined),
            ),
      search: (query) =>
        withSession(config, (session, database) => session.query(searchRecords(database, query)).then(recordsOf)),
      recent: (limit, unread) =>
        withSession(config, (session, database) =>
          session.query(recentRecords(database, limit, unread)).then(recordsOf),
        ),
      markConsumed: (ids, consumed) =>
        withSession(config, (session, database) =>
          session.query(markConsumed(database, ids, consumed)).then(idsOf),
        ),
      get: (id) =>
        withSession(config, async (session, database) => {
          const rows = await session.query(recordById(database, id))
          const row = rows[0]
          if (row === undefined) return null
          return recordView(row)
        }),
      stampZotero: (id, zoteroKey, zoteroUrl) =>
        Effect.gen(function* () {
          const outcome = yield* withSession(config, async (session, database) => {
            const updated = await session.query(stampZotero(database, id, zoteroKey, zoteroUrl))
            const written = updated[0]
            if (written !== undefined) return { _tag: "Stamped" as const, pair: stampedPair(written) }
            const loaded = await session.query(recordById(database, id))
            const row = loaded[0]
            if (row === undefined) return { _tag: "Missing" as const }
            return { _tag: "Kept" as const, pair: stampedPair(row) }
          })
          if (outcome._tag === "Missing") return yield* new NotFound()
          return outcome.pair
        }),
    })),
  )

import { Misconfigured, StoreWriteFailed } from "@herodotus/schema"
import { Context, Effect, Layer } from "effect"
import { identifier, insertRecords, type SettledRow, type SqlStatement } from "./sql"

export type { SettledRow } from "./sql"

export class SqlTransport extends Context.Tag("SqlTransport")<
  SqlTransport,
  {
    readonly execute: (
      statement: SqlStatement,
    ) => Effect.Effect<void, StoreWriteFailed | Misconfigured>
  }
>() {}

export class ItemStore extends Context.Tag("ItemStore")<
  ItemStore,
  {
    readonly put: (
      rows: ReadonlyArray<SettledRow>,
    ) => Effect.Effect<void, StoreWriteFailed | Misconfigured>
  }
>() {}

const databaseSetting = (database: string): Effect.Effect<string, Misconfigured> => {
  if (database.length === 0) {
    return Effect.fail(new Misconfigured({ message: "MOTHERDUCK_DATABASE is empty" }))
  }
  const name = identifier(database)
  if (name === undefined) {
    return Effect.fail(new Misconfigured({ message: "MOTHERDUCK_DATABASE is not an identifier" }))
  }
  return Effect.succeed(name)
}

export const itemStoreLayer = (database: string): Layer.Layer<ItemStore, never, SqlTransport> =>
  Layer.effect(
    ItemStore,
    Effect.gen(function* () {
      const transport = yield* SqlTransport
      return {
        put: (rows) =>
          Effect.gen(function* () {
            if (rows.length === 0) return
            const name = yield* databaseSetting(database)
            yield* transport.execute(insertRecords(name, rows))
          }),
      }
    }),
  )

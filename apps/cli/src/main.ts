import { Command, Options } from "@effect/cli"
import { FetchHttpClient } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { ingest, loadConfig } from "./ingest"

const report = (error: { readonly _tag: string; readonly message: string }) =>
  Effect.sync(() => {
    console.error(`${error._tag}: ${error.message}`)
  })

const ingestCommand = Command.make(
  "ingest",
  {
    type: Options.text("type"),
    text: Options.text("text"),
    tag: Options.repeated(Options.text("tag")),
    url: Options.optional(Options.text("url")),
    source: Options.withDefault(Options.text("source"), "cli"),
  },
  (flags) =>
    Effect.gen(function* () {
      const config = yield* loadConfig
      yield* ingest(config, {
        type: flags.type,
        text: flags.text,
        tags: flags.tag,
        source: flags.source,
        ...(Option.isSome(flags.url) ? { url: flags.url.value } : {}),
      })
    }).pipe(Effect.tapError(report)),
)

const root = Command.make("private-life").pipe(Command.withSubcommands([ingestCommand]))

const run = Command.run(root, {
  name: "Private life",
  version: "0.1.0",
})

NodeRuntime.runMain(
  run(process.argv).pipe(
    Effect.provide(Layer.mergeAll(NodeContext.layer, FetchHttpClient.layer)),
  ),
)

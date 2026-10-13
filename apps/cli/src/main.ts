import { Command, Options } from "@effect/cli"
import { FetchHttpClient } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Option } from "effect"
import { ingest, loadConfig } from "./ingest"

const report = (error: { readonly _tag: string; readonly message: string }) =>
  Effect.sync(() => {
    console.error(`${error._tag}: ${error.message}`)
  })

const optional = (name: string) => Options.optional(Options.text(name)).pipe(Options.map(Option.getOrUndefined))

const ingestCommand = Command.make(
  "ingest",
  {
    as: Options.text("as").pipe(Options.withFallbackConfig(Config.string("HERODOTUS_AS"))),
    kind: Options.text("kind"),
    text: optional("text"),
    url: optional("url"),
    title: optional("title"),
    author: optional("author"),
    site: optional("site"),
    publishedAt: optional("published-at"),
    about: optional("about"),
    tag: Options.repeated(Options.text("tag")),
  },
  ({ as, tag, ...flags }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig(as, undefined, process.env.HERODOTUS_URL)
      yield* ingest(config, { ...flags, tags: tag })
    }).pipe(Effect.tapError(report)),
)

const root = Command.make("herodotus").pipe(Command.withSubcommands([ingestCommand]))

const run = Command.run(root, {
  name: "Herodotus",
  version: "0.1.0",
})

NodeRuntime.runMain(
  run(process.argv).pipe(
    Effect.provide(Layer.mergeAll(NodeContext.layer, FetchHttpClient.layer)),
  ),
)

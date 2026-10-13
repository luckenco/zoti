import { FetchHttpClient } from "@effect/platform"
import { Cause, Effect, Layer } from "effect"
import { authLayer } from "./auth"
import type { WorkerBindings } from "./bindings"
import { clickHouseLayer } from "./clickhouse"
import { handle, idLayer } from "./handler"
import { rateLimitLayer } from "./rate-limit"

export const appLayer = (env: WorkerBindings) =>
  Layer.mergeAll(
    authLayer(env.AUTH_TOKENS),
    rateLimitLayer(env.INGEST_RATE_LIMITER),
    clickHouseLayer({
      url: env.CLICKHOUSE_URL,
      user: env.CLICKHOUSE_USER,
      password: env.CLICKHOUSE_PASSWORD,
      database: env.CLICKHOUSE_DATABASE,
    }),
    idLayer,
  )

const defectResponse = (cause: Cause.Cause<never>): Response => {
  console.error(
    JSON.stringify({
      _tag: "Defect",
      message: Cause.pretty(cause).slice(0, 500),
    }),
  )
  return new Response(JSON.stringify({ _tag: "Misconfigured", message: "unexpected failure" }), {
    status: 500,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return Effect.runPromise(
      handle(request).pipe(
        Effect.provide(appLayer(env)),
        Effect.provide(FetchHttpClient.layer),
        Effect.catchAllCause((cause) => Effect.succeed(defectResponse(cause))),
      ),
    )
  },
} satisfies ExportedHandler<Env>

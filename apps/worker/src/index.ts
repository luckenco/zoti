import { Cause, Effect, Layer } from "effect"
import { authLayer } from "./auth"
import type { WorkerBindings } from "./bindings"
import { authorize, failureResponse, handle, idLayer } from "./handler"
import { mcpResponse } from "./mcp"
import { motherDuckLayer } from "./motherduck"
import { rateLimitLayer } from "./rate-limit"

export const appLayer = (env: WorkerBindings) =>
  Layer.mergeAll(
    authLayer(env.AUTH_TOKENS),
    rateLimitLayer(env.INGEST_RATE_LIMITER),
    motherDuckLayer({
      host: env.MOTHERDUCK_HOST,
      database: env.MOTHERDUCK_DATABASE,
      token: env.MOTHERDUCK_TOKEN,
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

export const workerFetch = (
  request: Request,
  env: WorkerBindings,
  ctx: ExecutionContext,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname
    if (path === "/mcp") {
      if (request.method !== "OPTIONS") {
        const admitted = yield* authorize(request.headers.get("authorization")).pipe(Effect.either)
        if (admitted._tag === "Left") return failureResponse(admitted.left)
        return yield* Effect.promise(() => mcpResponse(request, env, ctx, admitted.right))
      }
      return yield* Effect.promise(() => mcpResponse(request, env, ctx, null))
    }
    return yield* handle(request)
  }).pipe(Effect.provide(appLayer(env)))

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return Effect.runPromise(
      workerFetch(request, env, ctx).pipe(
        Effect.catchAllCause((cause) => Effect.succeed(defectResponse(cause))),
      ),
    )
  },
} satisfies ExportedHandler<Env>

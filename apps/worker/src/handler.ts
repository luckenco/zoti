import { Effect } from "effect"
import { Auth, type Identity } from "./auth"
import { Misconfigured, RateLimited, Unauthorized } from "./errors"
import { RateLimit } from "./rate-limit"

export const failureResponse = (error: Unauthorized | RateLimited | Misconfigured): Response => {
  let status = 500
  if (error._tag === "Unauthorized") status = 401
  if (error._tag === "RateLimited") status = 429
  return Response.json(
    error._tag === "Misconfigured" ? { _tag: error._tag, message: error.message } : { _tag: error._tag },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        ...(error._tag === "RateLimited" ? { "retry-after": "60" } : {}),
      },
    },
  )
}

export const authorize = (
  header: string | null,
): Effect.Effect<Identity, Unauthorized | RateLimited | Misconfigured, Auth | RateLimit> =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const limiter = yield* RateLimit
    const identified = yield* auth.identify(header).pipe(Effect.either)
    if (identified._tag === "Left") {
      if (identified.left._tag === "Misconfigured") return yield* identified.left
      yield* limiter.consume("anonymous")
      return yield* new Unauthorized()
    }
    yield* limiter.consume(identified.right.name)
    return identified.right
  })

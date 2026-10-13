import { Misconfigured, RateLimited } from "@herodotus/schema"
import { Context, Effect, Layer } from "effect"

export interface RateLimitBinding {
  readonly limit: (options: { readonly key: string }) => Promise<{ readonly success: boolean }>
}

export class RateLimit extends Context.Tag("RateLimit")<
  RateLimit,
  {
    readonly consume: (key: string) => Effect.Effect<void, RateLimited | Misconfigured>
  }
>() {}

export const rateLimitLayer = (binding: RateLimitBinding): Layer.Layer<RateLimit> =>
  Layer.succeed(RateLimit, {
    consume: (key) =>
      Effect.tryPromise({
        try: () => binding.limit({ key }),
        catch: () => new Misconfigured({ message: "rate limit binding failed" }),
      }).pipe(
        Effect.flatMap((outcome) => (outcome.success ? Effect.void : Effect.fail(new RateLimited()))),
      ),
  })

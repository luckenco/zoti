import { Data } from "effect"

export class Unauthorized extends Data.TaggedError("Unauthorized") {}
export class RateLimited extends Data.TaggedError("RateLimited") {}
export class NotFound extends Data.TaggedError("NotFound") {}
export class Misconfigured extends Data.TaggedError("Misconfigured")<{
  readonly message: string
}> {}

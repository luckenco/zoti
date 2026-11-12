import type { RateLimitBinding } from "./rate-limit"

export type WorkerBindings = Omit<Env, "MCP_RATE_LIMITER"> & {
  readonly MCP_RATE_LIMITER: RateLimitBinding
}

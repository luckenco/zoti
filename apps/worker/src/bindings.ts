import type { RateLimitBinding } from "./rate-limit"

export interface WorkerBindings {
  readonly AUTH_TOKENS: string
  readonly CLICKHOUSE_URL: string
  readonly CLICKHOUSE_USER: string
  readonly CLICKHOUSE_PASSWORD: string
  readonly CLICKHOUSE_DATABASE: string
  readonly INGEST_RATE_LIMITER: RateLimitBinding
}

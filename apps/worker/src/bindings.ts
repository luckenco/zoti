import type { RateLimitBinding } from "./rate-limit"

export interface WorkerBindings {
  readonly AUTH_TOKENS: string
  readonly MOTHERDUCK_HOST: string
  readonly MOTHERDUCK_DATABASE: string
  readonly MOTHERDUCK_TOKEN: string
  readonly ZOTERO_API_KEY: string
  readonly ZOTERO_USER_ID: string
  readonly INGEST_RATE_LIMITER: RateLimitBinding
}

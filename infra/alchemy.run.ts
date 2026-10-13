import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import { fileURLToPath } from "node:url"

const main = fileURLToPath(new URL("../apps/worker/src/index.ts", import.meta.url))

export default Alchemy.Stack(
  "private-life",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    yield* Cloudflare.Worker("Ingress", {
      name: "private-life-ingress",
      main,
      compatibility: {
        date: "2026-10-13",
        flags: ["nodejs_compat"],
      },
      observability: {
        enabled: true,
        logs: {
          enabled: true,
          invocationLogs: true,
          headSamplingRate: 1,
        },
        traces: {
          enabled: true,
          headSamplingRate: 1,
        },
      },
      env: {
        AUTH_TOKENS: Config.Redacted("AUTH_TOKENS"),
        CLICKHOUSE_URL: Config.Redacted("CLICKHOUSE_URL"),
        CLICKHOUSE_USER: Config.Redacted("CLICKHOUSE_USER"),
        CLICKHOUSE_PASSWORD: Config.Redacted("CLICKHOUSE_PASSWORD"),
        CLICKHOUSE_DATABASE: Config.Redacted("CLICKHOUSE_DATABASE"),
        INGEST_RATE_LIMITER: Cloudflare.RateLimit("INGEST_RATE_LIMITER", {
          namespaceId: "1001",
          simple: { limit: 60, period: 60 },
        }),
      },
    })
    return {}
  }),
)

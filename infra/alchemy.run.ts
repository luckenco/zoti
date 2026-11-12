import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import { fileURLToPath } from "node:url"

const main = fileURLToPath(new URL("../apps/worker/src/index.ts", import.meta.url))

export default Alchemy.Stack(
  "zoti",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Cloudflare.Worker("Mcp", {
      name: "zoti",
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
        ZOTERO_API_KEY: Config.Redacted("ZOTERO_API_KEY"),
        ZOTERO_USER_ID: Config.Redacted("ZOTERO_USER_ID"),
        MCP_RATE_LIMITER: Cloudflare.RateLimit("MCP_RATE_LIMITER", {
          namespaceId: "1002",
          simple: { limit: 60, period: 60 },
        }),
      },
    })
    return {}
  }),
)

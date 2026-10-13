import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as GitHub from "alchemy/GitHub"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

export default Alchemy.Stack(
  "github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const owner = yield* Config.String("GITHUB_OWNER")
    const repository = yield* Config.String("GITHUB_REPOSITORY")
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment
    const authTokens = yield* Config.Redacted("AUTH_TOKENS")
    const motherDuckHost = yield* Config.Redacted("MOTHERDUCK_HOST")
    const motherDuckDatabase = yield* Config.Redacted("MOTHERDUCK_DATABASE")
    const motherDuckToken = yield* Config.Redacted("MOTHERDUCK_TOKEN")

    const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("CIToken", {
      name: "herodotus-ci",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers Observability Write",
            "Workers Tail Read",
            "Account Settings Write",
            "Secrets Store Write",
          ],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: "*",
          },
        },
      ],
    })

    yield* GitHub.Secrets({
      owner,
      repository,
      secrets: {
        CLOUDFLARE_API_TOKEN: apiToken.value,
        CLOUDFLARE_ACCOUNT_ID: Redacted.make(accountId),
        AUTH_TOKENS: authTokens,
        MOTHERDUCK_HOST: motherDuckHost,
        MOTHERDUCK_DATABASE: motherDuckDatabase,
        MOTHERDUCK_TOKEN: motherDuckToken,
      },
    })

    return {}
  }),
)

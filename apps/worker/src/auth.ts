import { Misconfigured, Unauthorized } from "@private-life/schema"
import { Context, Effect, Layer } from "effect"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const parseAuthTokens = (
  raw: string,
): Effect.Effect<ReadonlyArray<readonly [string, string]>, Misconfigured> =>
  Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => new Misconfigured({ message: "AUTH_TOKENS is not JSON" }),
  }).pipe(
    Effect.flatMap((value) => {
      if (!isRecord(value)) {
        return Effect.fail(new Misconfigured({ message: "AUTH_TOKENS must be an object" }))
      }
      const entries: Array<readonly [string, string]> = []
      for (const [name, token] of Object.entries(value)) {
        if (name.length === 0 || typeof token !== "string" || token.length === 0) {
          return Effect.fail(
            new Misconfigured({ message: "AUTH_TOKENS values must be non-empty strings" }),
          )
        }
        entries.push([name, token])
      }
      if (entries.length === 0) {
        return Effect.fail(new Misconfigured({ message: "AUTH_TOKENS is empty" }))
      }
      return Effect.succeed(entries)
    }),
  )

const sha256 = (value: string): Effect.Effect<Uint8Array> =>
  Effect.promise(() =>
    crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(value))
      .then((digest) => new Uint8Array(digest)),
  )

const digestsEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index++) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return diff === 0
}

const bearerToken = (header: string | null): string | null => {
  if (header === null || !header.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length)
  if (token.length === 0 || /\s/.test(token)) return null
  return token
}

export class Auth extends Context.Tag("Auth")<
  Auth,
  {
    readonly identify: (header: string | null) => Effect.Effect<string, Unauthorized | Misconfigured>
  }
>() {}

export const authLayer = (raw: string): Layer.Layer<Auth> =>
  Layer.effect(
    Auth,
    Effect.succeed({
      identify: (header: string | null) =>
        Effect.gen(function* () {
          const tokens = yield* parseAuthTokens(raw)
          const presented = bearerToken(header)
          if (presented === null) return yield* new Unauthorized()
          const presentedDigest = yield* sha256(presented)
          let client: string | null = null
          for (const [name, token] of tokens) {
            const digest = yield* sha256(token)
            if (digestsEqual(presentedDigest, digest)) client = name
          }
          if (client === null) return yield* new Unauthorized()
          return client
        }),
    }),
  )

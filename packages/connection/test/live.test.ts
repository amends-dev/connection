import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Connection from "../src/Connection.ts"
import * as Integrations from "../src/Integrations.ts"
import * as ModelCatalog from "../src/ModelCatalog.ts"
import * as ModelIntegrations from "../src/ModelIntegrations.ts"

/**
 * These tests check connections to real model providers over the network, and run only with
 * `AMENDS_TEST_MODELS=1`. A key a provider refuses costs nothing; OpenRouter's own key, in
 * `OPENROUTER_API_KEY` as `bun --env-file=hosts/local/.env` gives it, is checked only when it is
 * there, and a check costs nothing either.
 */
const enabled = process.env.AMENDS_TEST_MODELS === "1"
const openRouterKey = process.env.OPENROUTER_API_KEY

const LiveLayer = Layer.merge(FetchHttpClient.layer, ModelCatalog.layer)

/** Checks a connection to the catalog provider `providerId` that authenticates with `apiKey`. */
const check = (providerId: string, apiKey: string) =>
  Effect.gen(function* () {
    const integrations = yield* Integrations.make(yield* ModelIntegrations.catalogProviders)
    const integration = yield* integrations.find(providerId)
    const connection: Connection.Connection = {
      id: Connection.ConnectionId.make("live"),
      integration: providerId,
      name: "live",
      settings: {},
      auth: "apiKey"
    }
    return yield* integration.check(connection, { apiKey: Redacted.make(apiKey) })
  })

describe.skipIf(!enabled)("checking a connection to a real provider", () => {
  it.live(
    "finds a key that Anthropic, OpenAI, OpenRouter, and DeepSeek refuse",
    () =>
      Effect.gen(function* () {
        const checked = yield* Effect.forEach(
          ["anthropic", "openai", "openrouter", "deepseek"],
          (providerId) => check(providerId, "not-a-key"),
          { concurrency: "unbounded" }
        )

        expect(checked.map((health) => health.status)).toEqual(Array(4).fill("unauthorized"))
      }).pipe(Effect.provide(LiveLayer)),
    60_000
  )

  it.live.skipIf(openRouterKey === undefined)(
    "finds a key that OpenRouter takes",
    () =>
      Effect.gen(function* () {
        expect(yield* check("openrouter", openRouterKey ?? "")).toEqual({ status: "healthy" })
      }).pipe(Effect.provide(LiveLayer)),
    60_000
  )
})

import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as ModelCatalog from "../src/ModelCatalog.ts"
import * as ModelsDev from "../src/ModelsDev.ts"

/** A model as models.dev publishes it, with fields the catalog does not keep. */
const model = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: `Model ${id}`,
  description: "Not kept",
  family: "not-kept",
  attachment: true,
  reasoning: false,
  tool_call: true,
  release_date: "2026-01-02",
  last_updated: "2026-01-03",
  modalities: { input: ["text", "image"], output: ["text"] },
  open_weights: false,
  limit: { context: 200_000, output: 64_000 },
  ...fields
})

/** A provider as models.dev publishes it. */
const provider = (
  id: string,
  npm: string,
  models: ReadonlyArray<{ readonly id: string }>,
  fields: Record<string, unknown> = {}
) => ({
  id,
  name: `Provider ${id}`,
  env: [`${id.toUpperCase()}_API_KEY`],
  npm,
  doc: `https://${id}.example/docs`,
  models: Object.fromEntries(models.map((entry) => [entry.id, entry])),
  ...fields
})

const documentOf = (...providers: ReadonlyArray<ReturnType<typeof provider>>) =>
  Object.fromEntries(providers.map((entry) => [entry.id, entry]))

const modelsOf = (catalog: ModelCatalog.Catalog, providerId: string) =>
  catalog.providers.find((entry) => entry.id === providerId)?.models

describe("ModelsDev.toCatalog", () => {
  it.effect("keeps a model's facts under the catalog's names, and none it does not keep", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelsDev.toCatalog(
        documentOf(
          provider("anthropic", "@ai-sdk/anthropic", [
            model("claude", {
              status: "beta",
              limit: { context: 1_000_000, input: 900_000, output: 128_000 },
              cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5, input_audio: 9 }
            }),
            model("embedder", { tool_call: false, cost: { input: 1, output: 2, reasoning: 3 } })
          ])
        )
      )

      expect(catalog).toStrictEqual({
        providers: [
          {
            id: "anthropic",
            name: "Provider anthropic",
            docs: "https://anthropic.example/docs",
            settings: [],
            models: [
              {
                id: "claude",
                name: "Model claude",
                protocol: "anthropic-messages",
                url: "https://api.anthropic.com/v1",
                released: "2026-01-02",
                status: "beta",
                limits: { context: 1_000_000, input: 900_000, output: 128_000 },
                modalities: { input: ["text", "image"], output: ["text"] },
                tools: true,
                cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
              },
              {
                id: "embedder",
                name: "Model embedder",
                protocol: "anthropic-messages",
                url: "https://api.anthropic.com/v1",
                released: "2026-01-02",
                limits: { context: 200_000, output: 64_000 },
                modalities: { input: ["text", "image"], output: ["text"] },
                tools: false,
                cost: { input: 1, output: 2, reasoning: 3 }
              }
            ]
          }
        ]
      })
    })
  )

  it.effect("reaches each model through the protocol its package and API speak", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelsDev.toCatalog(
        documentOf(
          provider("openai", "@ai-sdk/openai", [
            model("responses"),
            model("chat", { provider: { shape: "completions" } })
          ]),
          provider("router", "@openrouter/ai-sdk-provider", [model("vendor/model")], {
            api: "https://router.example/api/v1"
          }),
          provider(
            "gateway",
            "@ai-sdk/openai-compatible",
            [
              model("chat"),
              model("responses", { provider: { shape: "responses" } }),
              model("claude", { provider: { npm: "@ai-sdk/anthropic" } }),
              model("gpt", {
                provider: { npm: "@ai-sdk/openai", api: "https://gateway.example/openai/v1" }
              })
            ],
            { api: "https://gateway.example/v1" }
          )
        )
      )
      const reached = (providerId: string) =>
        modelsOf(catalog, providerId)?.map(({ id, protocol, url }) => ({ id, protocol, url }))

      expect(reached("openai")).toEqual([
        { id: "chat", protocol: "openai-chat", url: "https://api.openai.com/v1" },
        { id: "responses", protocol: "openai-responses", url: "https://api.openai.com/v1" }
      ])
      expect(reached("router")).toEqual([
        { id: "vendor/model", protocol: "openai-chat", url: "https://router.example/api/v1" }
      ])
      expect(reached("gateway")).toEqual([
        { id: "chat", protocol: "openai-chat", url: "https://gateway.example/v1" },
        { id: "claude", protocol: "anthropic-messages", url: "https://gateway.example/v1" },
        { id: "gpt", protocol: "openai-responses", url: "https://gateway.example/openai/v1" },
        { id: "responses", protocol: "openai-responses", url: "https://gateway.example/v1" }
      ])
    })
  )

  it.effect("leaves out what amends cannot reach, and providers left with no models", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelsDev.toCatalog(
        documentOf(
          // Its package decides how a request authenticates, so none of its models is kept.
          provider("vertex", "@ai-sdk/google-vertex", [
            model("claude", {
              provider: { npm: "@ai-sdk/anthropic", api: "https://vertex.example/v1" }
            })
          ]),
          provider(
            "mixed",
            "@ai-sdk/openai-compatible",
            [model("kept"), model("gemini", { provider: { npm: "@ai-sdk/google" } })],
            { api: "https://mixed.example/v1" }
          ),
          // An OpenAI-compatible API has no URL of its own to fall back on.
          provider("nowhere", "@ai-sdk/openai-compatible", [model("lost")])
        )
      )

      expect(catalog.providers.map((entry) => entry.id)).toEqual(["mixed"])
      expect(modelsOf(catalog, "mixed")?.map((entry) => entry.id)).toEqual(["kept"])
    })
  )

  it.effect("names the settings a provider's URLs take as {NAME}", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelsDev.toCatalog(
        documentOf(
          provider(
            "cloud",
            "@ai-sdk/openai-compatible",
            [model("a"), model("b", { provider: { api: "https://${REGION}.cloud.example/${ACCOUNT_ID}/v1" } })],
            { api: "https://cloud.example/accounts/${ACCOUNT_ID}/v1" }
          )
        )
      )

      expect(catalog.providers[0]?.settings).toEqual(["ACCOUNT_ID", "REGION"])
      expect(modelsOf(catalog, "cloud")?.map((entry) => entry.url)).toEqual([
        "https://cloud.example/accounts/{ACCOUNT_ID}/v1",
        "https://{REGION}.cloud.example/{ACCOUNT_ID}/v1"
      ])
    })
  )

  it.effect("says how a request controls a model's reasoning", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelsDev.toCatalog(
        documentOf(
          provider("anthropic", "@ai-sdk/anthropic", [
            model("plain", { reasoning_options: [{ type: "toggle" }] }),
            model("always", { reasoning: true }),
            model("controlled", {
              reasoning: true,
              reasoning_options: [
                { type: "effort", values: ["max", "low", null, "default"] },
                { type: "toggle" },
                { type: "effort", values: ["minimal", "low"] },
                { type: "budget_tokens", min: 1024, max: 32_000 }
              ]
            })
          ])
        )
      )
      const reasoning = Object.fromEntries(
        (modelsOf(catalog, "anthropic") ?? []).map((entry) => [entry.id, entry.reasoning])
      )

      expect(reasoning).toStrictEqual({
        plain: undefined,
        always: { toggle: false, efforts: [] },
        controlled: {
          toggle: true,
          efforts: ["minimal", "low", "max"],
          budget: { min: 1024, max: 32_000 }
        }
      })
    })
  )

  it.effect("lists providers and their models in order of id", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelsDev.toCatalog(
        documentOf(
          provider("zeta", "@ai-sdk/anthropic", [model("b"), model("a")]),
          provider("alpha", "@ai-sdk/anthropic", [model("y"), model("x")])
        )
      )

      expect(catalog.providers.map((entry) => [entry.id, entry.models.map((item) => item.id)])).toEqual([
        ["alpha", ["x", "y"]],
        ["zeta", ["a", "b"]]
      ])
    })
  )

  it.effect("fails when a part the catalog keeps changes shape", () =>
    Effect.gen(function* () {
      const changed = [
        model("a", { modalities: { input: ["text", "hologram"], output: ["text"] } }),
        model("a", { limit: { context: "200k", output: 64_000 } }),
        model("a", { reasoning_options: [{ type: "dial" }] }),
        model("a", { tool_call: "yes" })
      ]
      for (const entry of changed) {
        const exit = yield* Effect.exit(
          ModelsDev.toCatalog(documentOf(provider("anthropic", "@ai-sdk/anthropic", [entry])))
        )

        expect(exit._tag).toBe("Failure")
      }
    })
  )

  it.effect("makes a catalog that is the same once stored as JSON and read back", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelsDev.toCatalog(
        documentOf(
          provider("anthropic", "@ai-sdk/anthropic", [
            model("full", {
              status: "deprecated",
              reasoning: true,
              reasoning_options: [{ type: "budget_tokens", max: 8000 }],
              cost: { input: 1, output: 2, reasoning: 3 }
            }),
            model("bare")
          ])
        )
      )
      const stored = JSON.parse(JSON.stringify(catalog))

      expect(yield* Schema.decodeUnknownEffect(ModelCatalog.Catalog)(stored)).toStrictEqual(catalog)
    })
  )
})

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ModelCatalog from "../src/ModelCatalog.ts"

const model = (id: string): ModelCatalog.Model => ({
  id,
  name: id,
  protocol: "openai-chat",
  url: "https://api.example/v1",
  released: "2026-01",
  limits: { context: 128_000, output: 16_000 },
  modalities: { input: ["text"], output: ["text"] },
  tools: true
})

const catalog: ModelCatalog.Catalog = {
  providers: [
    { id: "alpha", name: "Alpha", docs: "", settings: [], models: [model("one"), model("two")] },
    { id: "beta", name: "Beta", docs: "", settings: [], models: [model("one")] }
  ]
}

describe("ModelCatalog", () => {
  it.effect("finds a provider and its models by id", () =>
    Effect.gen(function* () {
      const modelCatalog = ModelCatalog.make(catalog)

      expect((yield* modelCatalog.providers).map((provider) => provider.id)).toEqual(["alpha", "beta"])
      expect((yield* modelCatalog.findProvider("beta"))?.name).toBe("Beta")
      expect(yield* modelCatalog.findModel("alpha", "two")).toEqual(model("two"))
      expect(yield* modelCatalog.findModel("beta", "one")).toEqual(model("one"))
    })
  )

  it.effect("finds nothing for a provider or model it does not have", () =>
    Effect.gen(function* () {
      const modelCatalog = ModelCatalog.make(catalog)

      expect(yield* modelCatalog.findProvider("gamma")).toBeUndefined()
      expect(yield* modelCatalog.findModel("beta", "two")).toBeUndefined()
      expect(yield* modelCatalog.findModel("gamma", "one")).toBeUndefined()
    })
  )

  describe("the snapshot", () => {
    it.effect("holds providers and models that can be found, each once, in order of id", () =>
      Effect.gen(function* () {
        const modelCatalog = yield* ModelCatalog.ModelCatalog
        const providers = yield* modelCatalog.providers
        const ids = providers.map((provider) => provider.id)

        expect(providers.length).toBeGreaterThan(100)
        expect(ids).toEqual([...new Set(ids)].toSorted())
        for (const provider of providers) {
          const modelIds = provider.models.map((entry) => entry.id)

          expect(provider.models.length).toBeGreaterThan(0)
          expect(modelIds).toEqual([...new Set(modelIds)].toSorted())
        }
        expect((yield* modelCatalog.findProvider("anthropic"))?.models.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(ModelCatalog.layer))
    )

    it.effect("names each setting a model's URL takes among its provider's settings", () =>
      Effect.gen(function* () {
        const providers = yield* (yield* ModelCatalog.ModelCatalog).providers

        for (const provider of providers) {
          const named = new Set(
            provider.models.flatMap((entry) => Array.from(entry.url.matchAll(/\{(\w+)\}/g), (match) => match[1] ?? ""))
          )

          expect(provider.settings).toEqual([...named].toSorted())
        }
      }).pipe(Effect.provide(ModelCatalog.layer))
    )
  })
})

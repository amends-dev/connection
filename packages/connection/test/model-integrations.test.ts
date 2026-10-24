import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import * as Connection from "../src/Connection.ts"
import type * as Integration from "../src/Integration.ts"
import * as Integrations from "../src/Integrations.ts"
import * as ModelCatalog from "../src/ModelCatalog.ts"
import * as ModelIntegrations from "../src/ModelIntegrations.ts"
import * as ToolIntegrations from "../src/ToolIntegrations.ts"

interface Sent {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

/** A client that answers every request with `status`, or fails to reach anything without one. */
const answering = (status: number | undefined, sent: Array<Sent>) =>
  HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const body = request.body as { readonly body?: Uint8Array }
      sent.push({
        method: request.method,
        url: url.toString(),
        headers: { ...request.headers },
        body: body.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(body.body))
      })
      if (status === undefined) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request })
          })
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status })))
    })
  )

/** The integrations of models, checking connections over a client that answers with `status`. */
const integrationsAnswering = (status: number | undefined) =>
  Effect.gen(function* () {
    const sent: Array<Sent> = []
    const client = answering(status, sent)
    const integrations = yield* Effect.all([
      ModelIntegrations.catalogProviders,
      ModelIntegrations.openAiCompatible
    ]).pipe(Effect.provideService(HttpClient.HttpClient, client))
    const all = yield* Integrations.make([...integrations[0], integrations[1]])
    return { integrations: all, sent }
  })

const key = Redacted.make("secret-key")

const connectionTo = (
  integration: string,
  settings: Connection.Connection["settings"] = {},
  auth: Connection.AuthMethod = "apiKey"
): Connection.Connection => ({
  id: Connection.ConnectionId.make("conn-1"),
  integration,
  name: "Mine",
  settings,
  auth
})

/** The endpoint `integration` gives for `options` over a connection with `settings`. */
const endpointOf = (
  integration: string,
  options: Integration.EndpointOptions,
  settings?: Connection.Connection["settings"]
) =>
  Effect.gen(function* () {
    const { integrations } = yield* integrationsAnswering(200)
    const found = yield* integrations.find(integration)
    return yield* found.modelEndpoint(connectionTo(integration, settings), { apiKey: key }, options)
  })

const refusalOf = (effect: Effect.Effect<unknown, Connection.ConnectionError, ModelCatalog.ModelCatalog>) =>
  Effect.map(Effect.flip(effect), (error) => `${error.reason._tag}: ${error.reason.description}`)

layer(ModelCatalog.layer)("ModelIntegrations", (it) => {
  it.effect("gives each catalog provider, with its models, and the OpenAI-compatible API", () =>
    Effect.gen(function* () {
      const { integrations } = yield* integrationsAnswering(200)
      const anthropic = yield* integrations.find("anthropic")
      const compatible = yield* integrations.find("openai-compatible")

      expect(anthropic).toMatchObject({
        name: "Anthropic",
        auth: ["apiKey"],
        provides: ["models"]
      })
      expect(anthropic.models.listed.map((model) => model.id)).toContain("claude-opus-5-5")
      expect(anthropic.models.unlisted).toBe(false)
      expect(compatible).toMatchObject({
        auth: ["apiKey", "none"],
        provides: ["models"],
        models: { listed: [], unlisted: true }
      })
    })
  )

  it.effect(
    "reaches a catalog model where the catalog says, with the connection's key and the model's context window",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* endpointOf("anthropic", {
          model: "claude-opus-5-5",
          effort: "max",
          maxOutputTokens: 64_000
        })

        expect(endpoint).toEqual({
          provider: "anthropic",
          model: "claude-opus-5-5",
          protocol: "anthropic-messages",
          url: "https://api.anthropic.com/v1",
          apiKey: key,
          effort: "max",
          maxOutputTokens: 64_000,
          contextWindow: 1_000_000
        })
      })
  )

  it.effect("puts the settings a provider's URLs name in them", () =>
    Effect.gen(function* () {
      const settings = { CLOUDFLARE_ACCOUNT_ID: "acct-7" }
      const endpoint = yield* endpointOf(
        "cloudflare-workers-ai",
        { model: "@cf/aisingapore/gemma-sea-lion-v4-27b-it" },
        settings
      )
      const missing = yield* refusalOf(
        endpointOf("cloudflare-workers-ai", { model: "@cf/aisingapore/gemma-sea-lion-v4-27b-it" })
      )

      expect(endpoint.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-7/ai/v1")
      expect(missing).toMatch(/^InvalidConnectionError: The settings of Mine do not match/)
    })
  )

  it.effect("refuses a model, an effort, or an output limit that the catalog does not offer", () =>
    Effect.gen(function* () {
      const asked: ReadonlyArray<Integration.EndpointOptions> = [
        { model: "claude-nine" },
        { model: "claude-opus-5-5", effort: "minimal" },
        { model: "claude-opus-5-5", maxOutputTokens: 200_000 },
        { model: "claude-opus-5-5", maxOutputTokens: 0 },
        { model: "claude-opus-5-5", maxOutputTokens: 1.5 }
      ]
      const { integrations } = yield* integrationsAnswering(200)
      const anthropic = yield* integrations.find("anthropic")

      const refusals = yield* Effect.forEach(asked, (options) => refusalOf(endpointOf("anthropic", options)))
      // Validating the model refuses the same, from a connection that has no key at hand.
      const validated = yield* Effect.forEach(asked, (options) =>
        refusalOf(anthropic.validateModel(connectionTo("anthropic"), options))
      )
      yield* anthropic.validateModel(connectionTo("anthropic"), {
        model: "claude-opus-5-5",
        effort: "max",
        maxOutputTokens: 64_000
      })

      expect(validated).toEqual(refusals)
      expect(refusals).toEqual([
        "UnsupportedError: Anthropic offers no model claude-nine",
        "UnsupportedError: Claude Opus 5.5 takes no effort minimal",
        "UnsupportedError: Claude Opus 5.5 writes at most 128000 tokens in a response, not 200000",
        "UnsupportedError: An output limit is a whole number of tokens above 0, not 0",
        "UnsupportedError: An output limit is a whole number of tokens above 0, not 1.5"
      ])
    })
  )

  it.effect("reaches any model of an OpenAI-compatible API, as a provider of the connection's own", () =>
    Effect.gen(function* () {
      const { integrations } = yield* integrationsAnswering(200)
      const compatible = yield* integrations.find("openai-compatible")
      const connection = connectionTo("openai-compatible", { url: "http://models.internal:8000/v1/" }, "none")

      const endpoint = yield* compatible.modelEndpoint(connection, undefined, {
        model: "qwen-coder",
        effort: "high"
      })

      expect(endpoint).toEqual({
        provider: "conn-1",
        model: "qwen-coder",
        protocol: "openai-chat",
        url: "http://models.internal:8000/v1",
        effort: "high"
      })
    })
  )

  it.effect("checks a provider with a request it must refuse once it has read the key", () =>
    Effect.gen(function* () {
      const { integrations, sent } = yield* integrationsAnswering(400)
      const checked = yield* Effect.forEach(["anthropic", "openai", "openrouter"], (id) =>
        Effect.flatMap(integrations.find(id), (integration) => integration.check(connectionTo(id), { apiKey: key }))
      )

      expect(checked).toEqual(Array.from({ length: 3 }, () => ({ status: "healthy" })))
      const [anthropic, openai, openrouter] = sent
      expect(anthropic).toMatchObject({
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": "secret-key", "anthropic-version": "2023-06-01" },
        body: { max_tokens: 1, messages: [] }
      })
      expect(openai).toMatchObject({
        method: "POST",
        url: "https://api.openai.com/v1/responses",
        headers: { authorization: "Bearer secret-key" },
        body: { input: [], max_output_tokens: 1 }
      })
      expect(openrouter).toMatchObject({
        method: "POST",
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: { authorization: "Bearer secret-key" },
        body: { messages: [] }
      })
      // Each names a model of its provider that is released, not one in a preview.
      for (const request of sent) {
        expect(request.body).toHaveProperty("model")
      }
      const anthropicModel = (request: Sent | undefined) =>
        (request?.body as { readonly model?: string } | undefined)?.model
      const named = (yield* integrations.find("anthropic")).models.listed.find(
        (model) => model.id === anthropicModel(anthropic)
      )
      expect(named?.status).toBeUndefined()
    })
  )

  it.effect("checks with the model released last of those the provider has fully released", () =>
    Effect.gen(function* () {
      const model = (id: string, released: string, status?: "beta" | "deprecated"): ModelCatalog.Model => ({
        id,
        name: id,
        protocol: "openai-chat",
        url: "https://models.example/v1",
        released,
        ...(status === undefined ? {} : { status }),
        limits: { context: 1000, output: 100 },
        modalities: { input: ["text"], output: ["text"] },
        tools: true
      })
      const catalog = ModelCatalog.make({
        providers: [
          {
            id: "example",
            name: "Example",
            docs: "https://models.example/docs",
            settings: [],
            models: [
              model("old", "2025-01-01"),
              model("current", "2025-06-01"),
              model("preview", "2026-01-01", "beta"),
              model("retiring", "2026-02-01", "deprecated")
            ]
          }
        ]
      })
      const sent: Array<Sent> = []
      const [example] = yield* ModelIntegrations.catalogProviders.pipe(
        Effect.provideService(ModelCatalog.ModelCatalog, catalog),
        Effect.provideService(HttpClient.HttpClient, answering(400, sent))
      )

      yield* Effect.flatMap(Effect.fromNullishOr(example), (integration) =>
        integration.check(connectionTo("example"), { apiKey: key })
      )

      expect(sent[0]).toMatchObject({
        url: "https://models.example/v1/chat/completions",
        body: { model: "current" }
      })
    })
  )

  it.effect("checks an OpenAI-compatible API by asking which models it has", () =>
    Effect.gen(function* () {
      const { integrations, sent } = yield* integrationsAnswering(200)
      const compatible = yield* integrations.find("openai-compatible")
      const url = { url: "http://models.internal:8000/v1" }

      const keyed = yield* compatible.check(connectionTo("openai-compatible", url), {
        apiKey: key
      })
      const keyless = yield* compatible.check(connectionTo("openai-compatible", url, "none"), undefined)

      expect([keyed, keyless]).toEqual([{ status: "healthy" }, { status: "healthy" }])
      expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET http://models.internal:8000/v1/models",
        "GET http://models.internal:8000/v1/models"
      ])
      expect(sent[0]?.headers["authorization"]).toBe("Bearer secret-key")
      expect(sent[1]?.headers).not.toHaveProperty("authorization")
    })
  )

  it.effect("says what a provider's answer, or its not answering, says of the connection", () =>
    Effect.gen(function* () {
      const statuses = [200, 400, 422, 401, 403, 404, 405, 408, 429, 500, 503, undefined]
      const found = yield* Effect.forEach(statuses, (status) =>
        Effect.gen(function* () {
          const { integrations } = yield* integrationsAnswering(status)
          const anthropic = yield* integrations.find("anthropic")
          return (yield* anthropic.check(connectionTo("anthropic"), { apiKey: key })).status
        })
      )

      expect(Object.fromEntries(statuses.map((status, index) => [status ?? "none", found[index]]))).toEqual({
        200: "healthy",
        400: "healthy",
        422: "healthy",
        401: "unauthorized",
        403: "unauthorized",
        404: "misconfigured",
        405: "misconfigured",
        408: "unavailable",
        429: "unavailable",
        500: "unavailable",
        503: "unavailable",
        none: "unavailable"
      })
    })
  )
})

describe("the built-in integrations", () => {
  it.effect("have distinct ids, so a host can install them all", () =>
    Effect.gen(function* () {
      const integrations = yield* Effect.all([
        ModelIntegrations.catalogProviders,
        ModelIntegrations.openAiCompatible,
        ToolIntegrations.mcp,
        ToolIntegrations.openApi
      ]).pipe(Effect.provideService(HttpClient.HttpClient, answering(200, [])))
      const [catalog, ...others] = integrations

      const installed = yield* Integrations.make([...catalog, ...others])

      expect(installed.all.length).toBe(catalog.length + 3)
    }).pipe(Effect.provide(Layer.merge(ModelCatalog.layer, Layer.empty)))
  )

  it.effect("ask for their settings by title, and for a provider's by the names its URLs give them", () =>
    Effect.gen(function* () {
      const [catalog, ...others] = yield* Effect.all([
        ModelIntegrations.catalogProviders,
        ModelIntegrations.openAiCompatible,
        ToolIntegrations.mcp,
        ToolIntegrations.openApi
      ]).pipe(Effect.provideService(HttpClient.HttpClient, answering(200, [])))
      const formOf = (id: string) => catalog.find((integration) => integration.id === id)?.settings

      for (const integration of others) {
        for (const field of Object.values(integration.settings.properties)) {
          expect(field.title, integration.id).toBeTruthy()
        }
      }
      expect(others.map(({ settings }) => settings.required)).toEqual([["url"], ["url"], ["documentUrl"]])
      expect(formOf("cloudflare-workers-ai")).toEqual({
        type: "object",
        properties: { CLOUDFLARE_ACCOUNT_ID: { type: "string", minLength: 1 } },
        required: ["CLOUDFLARE_ACCOUNT_ID"]
      })
      expect(formOf("anthropic")).toEqual({ type: "object", properties: {} })
    }).pipe(Effect.provide(ModelCatalog.layer))
  )
})

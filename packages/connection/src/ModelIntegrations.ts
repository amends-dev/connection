/**
 * The integrations of model providers: one for each provider the model catalog lists, which gives
 * the provider's models in the catalog, and `openAiCompatible`, which gives any model of an API
 * that serves the Chat Completions protocol at a URL the connection gives, such as a model server
 * on a company's network.
 *
 * A connection to a catalog provider authenticates with an API key, and gives the settings that the
 * provider's URLs name, such as the id of a Cloudflare account. The endpoint of one of its models is
 * where the catalog says the model is served, with the effort and output limit an agent asks for,
 * which the model must offer.
 *
 * Checking a connection to a catalog provider asks for a response to a request the provider must
 * refuse, as it has no messages: a provider that reads the key first refuses the key, or else says
 * the request is incomplete, which costs nothing. A few providers look at the request before the
 * key, so a wrong key there shows only when a turn runs. Checking a connection to an
 * OpenAI-compatible API asks it which models it has.
 *
 * @since 0.1.0
 */

import type { ModelEndpoint } from "@amends-dev/harness"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Connection from "./Connection.ts"
import * as Integration from "./Integration.ts"
import * as ModelCatalog from "./ModelCatalog.ts"

/**
 * The integrations of the catalog's providers, which check connections over the host's client,
 * read from the `ModelCatalog` the host provides.
 *
 * @category constructors
 * @since 0.1.0
 */
export const catalogProviders = Effect.gen(function* () {
  const catalog = yield* ModelCatalog.ModelCatalog
  const client = yield* HttpClient.HttpClient
  return (yield* catalog.providers).map((provider) => providerIntegration(provider, client))
})

/**
 * The integration of an OpenAI-compatible API, `openai-compatible`, which checks connections over
 * the host's client.
 *
 * @category constructors
 * @since 0.1.0
 */
export const openAiCompatible = Effect.map(HttpClient.HttpClient, (client) =>
  Integration.make({
    id: "openai-compatible",
    name: "OpenAI-compatible API",
    settings: Schema.Struct({
      url: Schema.NonEmptyString.annotate({
        title: "Base URL",
        description: "The base URL of the API, which /chat/completions follows."
      })
    }),
    auth: ["apiKey", "none"],
    models: {
      listed: [],
      unlisted: true,
      endpoint: ({ connection, settings, apiKey }, options) =>
        Result.succeed({
          // The connection's own id, which no other provider has, so that an agent that knows
          // providers by name, as opencode does, takes the API for a provider of its own.
          provider: connection.id,
          model: options.model,
          protocol: "openai-chat",
          url: settings.url.replace(/\/+$/, ""),
          ...withOptions(apiKey, options)
        })
    },
    check: ({ settings, apiKey }) => {
      const url = `${settings.url.replace(/\/+$/, "")}/models`
      return checkWith(client, url, HttpClientRequest.get(url).pipe(withBearer(apiKey)))
    }
  })
)

const providerIntegration = (provider: ModelCatalog.Provider, client: HttpClient.HttpClient) =>
  Integration.make({
    id: provider.id,
    name: provider.name,
    docs: provider.docs,
    settings:
      provider.settings.length === 0
        ? undefined
        : Schema.Struct(Object.fromEntries(provider.settings.map((name) => [name, Schema.NonEmptyString]))),
    auth: ["apiKey"],
    models: {
      listed: provider.models,
      unlisted: false,
      endpoint: ({ settings, apiKey }, options) => {
        // A connection offers only the models it lists, so an endpoint is asked only for one of them.
        const model = provider.models.find((listed) => listed.id === options.model)
        if (model === undefined) {
          const description = `The catalog has no model ${options.model} of ${provider.name}`
          return Result.fail(new Connection.UnsupportedError({ description }))
        }
        return Result.succeed({
          provider: provider.id,
          model: model.id,
          protocol: model.protocol,
          url: urlWith(model.url, settings),
          ...(model.limits.context > 0 ? { contextWindow: model.limits.context } : {}),
          ...withOptions(apiKey, options)
        })
      }
    },
    check: ({ settings, apiKey }) => {
      const model = modelToCheckWith(provider)
      if (model === undefined) return Effect.succeed({ status: "healthy" })
      const request = requestToRefuse(model.protocol, urlWith(model.url, settings), model.id, apiKey)
      return checkWith(client, request.url, request)
    }
  })

/**
 * The model a check names, which the provider's key reaches as it does any other: the one released
 * last of those the provider has fully released, as a provider may answer for a model it does not
 * serve to everyone, or no longer serves, as for an address it has not. The catalog keeps no
 * provider without models.
 */
const modelToCheckWith = (provider: ModelCatalog.Provider) =>
  provider.models
    .filter((model) => model.status === undefined)
    .reduce<ModelCatalog.Model | undefined>(
      (latest, model) => (latest === undefined || model.released > latest.released ? model : latest),
      undefined
    ) ?? provider.models[0]

/** The parts of an endpoint that come from the connection's key and the agent's options. */
const withOptions = (apiKey: Redacted.Redacted<string> | undefined, options: Integration.EndpointOptions) => ({
  ...(apiKey === undefined ? {} : { apiKey }),
  ...(options.effort === undefined ? {} : { effort: options.effort }),
  ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens })
})

/** `url` with the settings it names, between braces, as the catalog writes them. */
const urlWith = (url: string, settings: { readonly [name: string]: string }) =>
  url.replaceAll(/\{(\w+)\}/g, (_, name: string) => settings[name] ?? "").replace(/\/+$/, "")

/**
 * A request for a response that has no messages, which the provider of `protocol` at `url` must
 * refuse, for the model `model`, with the key as the protocol presents it.
 */
const requestToRefuse = (
  protocol: ModelEndpoint.Protocol,
  url: string,
  model: string,
  apiKey: Redacted.Redacted<string> | undefined
) => {
  switch (protocol) {
    case "anthropic-messages":
      return HttpClientRequest.post(`${url}/messages`).pipe(
        HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
        apiKey === undefined ? (request) => request : HttpClientRequest.setHeader("x-api-key", Redacted.value(apiKey)),
        HttpClientRequest.bodyJsonUnsafe({ model, max_tokens: 1, messages: [] })
      )
    case "openai-responses":
      // The API takes an output limit of 16 tokens at least, so it refuses this one.
      return HttpClientRequest.post(`${url}/responses`).pipe(
        withBearer(apiKey),
        HttpClientRequest.bodyJsonUnsafe({ model, input: [], max_output_tokens: 1 })
      )
    case "openai-chat":
      return HttpClientRequest.post(`${url}/chat/completions`).pipe(
        withBearer(apiKey),
        HttpClientRequest.bodyJsonUnsafe({ model, messages: [] })
      )
  }
}

const withBearer = (apiKey: Redacted.Redacted<string> | undefined) => (request: HttpClientRequest.HttpClientRequest) =>
  apiKey === undefined ? request : HttpClientRequest.bearerToken(request, Redacted.value(apiKey))

/** Sends `request`, and says what its answer, or its failing to be answered, says of the connection. */
const checkWith = (
  client: HttpClient.HttpClient,
  url: string,
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<Connection.Health> =>
  client.execute(request).pipe(
    Effect.map((response: HttpClientResponse.HttpClientResponse) => Connection.healthOfStatus(response.status, url)),
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() => Connection.unanswered(url))
  )

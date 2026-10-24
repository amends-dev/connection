/**
 * models.dev is an open database of AI model providers and the models they serve, published as one
 * JSON document at `https://models.dev/api.json`. This module reads the parts of it a model catalog
 * keeps, failing when one of them changes shape, and turns them into a `ModelCatalog.Catalog`.
 *
 * models.dev names the AI SDK package that reaches each provider, and a model may name its own
 * package, base URL, and API. The catalog keeps the models whose package speaks a protocol amends
 * speaks, and the providers that have any.
 *
 * @since 0.1.0
 */

import type { ModelEndpoint } from "@amends-dev/harness"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as ModelCatalog from "./ModelCatalog.ts"

/** A level of reasoning effort, where `null` and `default` leave the level to the provider. */
const Effort = Schema.NullOr(Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]))

/** A way a request controls a model's reasoning. */
const ReasoningOption = Schema.Union([
  Schema.Struct({ type: Schema.Literal("toggle") }),
  Schema.Struct({ type: Schema.Literal("effort"), values: Schema.Array(Effort) }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optionalKey(Schema.Int),
    max: Schema.optionalKey(Schema.Int)
  })
])

const Modality = Schema.Literals(["text", "image", "audio", "video", "pdf"])

/** A model as a provider serves it, with only the fields a catalog keeps. */
const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  release_date: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["alpha", "beta", "deprecated"])),
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.optionalKey(Schema.Int),
    output: Schema.Int
  }),
  modalities: Schema.Struct({ input: Schema.Array(Modality), output: Schema.Array(Modality) }),
  tool_call: Schema.Boolean,
  reasoning: Schema.Boolean,
  reasoning_options: Schema.optionalKey(Schema.Array(ReasoningOption)),
  cost: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optionalKey(Schema.Finite),
      cache_write: Schema.optionalKey(Schema.Finite),
      reasoning: Schema.optionalKey(Schema.Finite)
    })
  ),

  /** Where the model is reached, when not as its provider is. */
  provider: Schema.optionalKey(
    Schema.Struct({
      npm: Schema.optionalKey(Schema.String),
      api: Schema.optionalKey(Schema.String),
      shape: Schema.optionalKey(Schema.Literals(["responses", "completions"]))
    })
  )
})

type Model = typeof Model.Type

const Provider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  doc: Schema.String,

  /** The AI SDK package that reaches the provider's models. */
  npm: Schema.String,

  /** The base URL of the provider's API, where its package has none of its own. */
  api: Schema.optionalKey(Schema.String),

  models: Schema.Record(Schema.String, Model)
})

type Provider = typeof Provider.Type

/**
 * What `api.json` holds: the providers, keyed by id, with only the fields a catalog keeps.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Document = Schema.Record(Schema.String, Provider)

/**
 * @category schemas
 * @since 0.1.0
 */
export type Document = typeof Document.Type

/**
 * The catalog of what `document` holds, from models.dev's `api.json`. It fails when a field the
 * catalog keeps has changed shape.
 *
 * @category decoding
 * @since 0.1.0
 */
export const toCatalog = Effect.fn("ModelsDev.toCatalog")(function* (document: unknown) {
  const providers = yield* Schema.decodeUnknownEffect(Document)(document)
  return {
    providers: Object.values(providers)
      .map(providerOf)
      .filter((provider) => provider.models.length > 0)
      .toSorted(byId)
  } satisfies ModelCatalog.Catalog
})

/**
 * The packages whose API amends speaks, with the base URL each uses when given none. OpenRouter's
 * serves the Chat Completions API.
 */
const packages: Record<string, { readonly url?: string }> = {
  "@ai-sdk/anthropic": { url: "https://api.anthropic.com/v1" },
  "@ai-sdk/openai": { url: "https://api.openai.com/v1" },
  "@ai-sdk/openai-compatible": {},
  "@openrouter/ai-sdk-provider": {}
}

/** The provider as the catalog keeps it, with the models it serves through a protocol amends speaks. */
const providerOf = (provider: Provider): ModelCatalog.Provider => {
  const models = Object.values(provider.models)
    .flatMap((model) => {
      const reached = reachOf(provider, model)
      return reached === undefined ? [] : [modelOf(model, reached)]
    })
    .toSorted(byId)
  return {
    id: provider.id,
    name: provider.name,
    docs: provider.doc,
    settings: [...new Set(models.flatMap((model) => settingsIn(model.url)))].toSorted(),
    models
  }
}

/**
 * How `model` is reached: its protocol and the base URL of its API, with each `${NAME}` written as
 * `{NAME}`. Nothing when its package is not one amends speaks, or names no URL.
 */
const reachOf = (
  provider: Provider,
  model: Model
): { readonly protocol: ModelEndpoint.Protocol; readonly url: string } | undefined => {
  // A provider's package decides how a request authenticates, so a provider whose package amends
  // does not speak is left out, even where its models name one that it does.
  if (!Object.hasOwn(packages, provider.npm)) return undefined
  const npm = model.provider?.npm ?? provider.npm
  const url = model.provider?.api ?? provider.api ?? packages[npm]?.url
  if (!Object.hasOwn(packages, npm) || url === undefined) return undefined
  const shape = model.provider?.shape
  const protocol =
    npm === "@ai-sdk/anthropic"
      ? "anthropic-messages"
      : (npm === "@ai-sdk/openai" && shape !== "completions") ||
          (npm === "@ai-sdk/openai-compatible" && shape === "responses")
        ? "openai-responses"
        : "openai-chat"
  return { protocol, url: url.replaceAll(/\$\{(\w+)\}/g, "{$1}") }
}

const modelOf = (
  model: Model,
  reached: { readonly protocol: ModelEndpoint.Protocol; readonly url: string }
): ModelCatalog.Model => {
  const reasoning = model.reasoning ? reasoningOf(model.reasoning_options ?? []) : undefined
  return {
    id: model.id,
    name: model.name,
    protocol: reached.protocol,
    url: reached.url,
    released: model.release_date,
    ...(model.status === undefined ? {} : { status: model.status }),
    limits: model.limit,
    modalities: model.modalities,
    tools: model.tool_call,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(model.cost === undefined ? {} : { cost: costOf(model.cost) })
  }
}

const efforts: ReadonlyArray<ModelEndpoint.Effort> = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/** How a request controls the reasoning of a model that reasons, from models.dev's options. */
const reasoningOf = (options: ReadonlyArray<typeof ReasoningOption.Type>): ModelCatalog.Reasoning => {
  const offered = new Set(options.flatMap((option) => (option.type === "effort" ? option.values : [])))
  const budget = options.find((option) => option.type === "budget_tokens")
  return {
    toggle: options.some((option) => option.type === "toggle"),
    efforts: efforts.filter((effort) => offered.has(effort)),
    ...(budget === undefined
      ? {}
      : {
          budget: {
            ...(budget.min === undefined ? {} : { min: budget.min }),
            ...(budget.max === undefined ? {} : { max: budget.max })
          }
        })
  }
}

const costOf = (cost: NonNullable<Model["cost"]>): ModelCatalog.Cost => ({
  input: cost.input,
  output: cost.output,
  ...(cost.cache_read === undefined ? {} : { cacheRead: cost.cache_read }),
  ...(cost.cache_write === undefined ? {} : { cacheWrite: cost.cache_write }),
  ...(cost.reasoning === undefined ? {} : { reasoning: cost.reasoning })
})

/** The settings a model's URL names, as `{NAME}`. */
const settingsIn = (url: string): ReadonlyArray<string> =>
  Array.from(url.matchAll(/\{(\w+)\}/g), (match) => match[1] ?? "")

const byId = (a: { readonly id: string }, b: { readonly id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

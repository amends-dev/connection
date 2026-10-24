/**
 * An integration is a kind of system amends connects to, such as opencode, Anthropic's API, Daytona,
 * or an MCP server, declared in code: the settings a connection to it gives, the ways a connection
 * can authenticate, what a connection gives amends, and how a connection is checked. A connection
 * gives any of five things: harnesses, which run agents, models an agent runs on, sandboxes it works
 * in, tools it calls, and channels, through which people outside the workspace are heard and
 * answered.
 *
 * `make` declares an integration from what it does with a connection, given the connection's
 * settings decoded and its key, as `Access`. Each operation of the integration it makes takes a
 * connection and its credential as they are stored, and fails with `ConnectionError` for a
 * connection the integration does not take, or for what it does not give.
 *
 * An integration describes its settings as a form a person fills in, `SettingsForm`, which is how
 * MCP asks a person for input, so that settings can be asked for without code for each integration.
 *
 * @since 0.1.0
 */

import type { ChannelTransport } from "@amends-dev/channel"
import type { Agent, Harness, ModelEndpoint } from "@amends-dev/harness"
import type { SandboxProvider } from "@amends-dev/sandbox"
import type { ToolSource } from "@amends-dev/toolkit"
import * as McpSchema from "effect/ai/McpSchema"
import type * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Redacted from "effect/Redacted"
import type * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import {
  type AuthMethod,
  type Connection,
  ConnectionError,
  type ConnectionErrorReason,
  type Credential,
  type Health,
  InvalidConnectionError,
  UnsupportedError
} from "./Connection.ts"
import type * as ModelCatalog from "./ModelCatalog.ts"

/**
 * What a connection gives amends, as `Integration.provides` lists it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Capability = Schema.Literals(["harnesses", "models", "sandboxes", "tools", "channels"])

/**
 * @category schemas
 * @since 0.1.0
 */
export type Capability = typeof Capability.Type

/**
 * The settings a connection gives, as a form a person fills in: an object of text, number,
 * yes-or-no, and choice fields, each with a title and a description, which is how MCP asks a person
 * for input.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SettingsForm = McpSchema.ElicitRequestFormParams.fields.requestedSchema

/**
 * @category schemas
 * @since 0.1.0
 */
export type SettingsForm = typeof SettingsForm.Type

/** The settings of an integration that takes none: an object with no keys. */
const noSettings = Schema.Record(Schema.String, Schema.Never)

/**
 * The settings of an integration that takes none, an object with no keys, as `make` decodes a
 * connection's settings when `Options.settings` is left out.
 *
 * @category models
 * @since 0.1.0
 */
export type NoSettings = typeof noSettings.Type

/**
 * A connection as an integration's code is given it: with its settings decoded, and its key, which
 * the code of an integration that a connection authenticates with only by a key is always given.
 *
 * @category models
 * @since 0.1.0
 */
export interface Access<Settings, Auth extends AuthMethod = AuthMethod> {
  readonly connection: Connection

  /** The connection's settings, decoded by the integration's `settings` schema. */
  readonly settings: Settings

  /** The connection's API key, when it authenticates with one. */
  readonly apiKey: "none" extends Auth ? Redacted.Redacted<string> | undefined : Redacted.Redacted<string>
}

/**
 * The model an agent is to run on through a connection, and how it is to run.
 *
 * @category options
 * @since 0.1.0
 */
export interface EndpointOptions {
  /** The model's id, as its provider names it. */
  readonly model: string

  /** How hard the model works, which a listed model must take. */
  readonly effort?: ModelEndpoint.Effort

  /** The most tokens the model may write in a response, which a listed model must allow. */
  readonly maxOutputTokens?: number
}

/**
 * What `make` declares an integration from: its id and name, the settings and ways to
 * authenticate a connection gives, what a connection gives of each capability, and how a connection
 * is checked. A capability left out is one the integration does not give.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options<Settings, Auth extends AuthMethod = AuthMethod> {
  /** Names the integration, as connections name it, such as `anthropic` or `mcp`. */
  readonly id: string

  /** What people call the system, such as `Anthropic`. */
  readonly name: string

  /** Where the system's documentation is. */
  readonly docs?: string | undefined

  /**
   * The settings a connection gives, besides its credential, such as a URL: no more and no fewer.
   * They make a form, of fields whose `title` and `description` annotations the form shows. Left
   * out, a connection gives none. An empty struct is not none, as it takes any value.
   */
  readonly settings?: Schema.Decoder<Settings> | undefined

  /** The ways a connection can authenticate, in the order to offer them. */
  readonly auth: Array.NonEmptyReadonlyArray<Auth>

  /** The harnesses a connection gives, which run its agent. */
  readonly harnesses?: {
    /**
     * Whether the agent works only in a sandbox, as the `requiresSandbox` of each harness says, so
     * that an agent can be set up to run on it before any harness is made.
     */
    readonly requiresSandbox: boolean

    /**
     * The harness of a connection, running its agent on the models it is given, or why it cannot
     * run on them.
     */
    readonly harness: (
      access: Access<Settings, Auth>,
      options: Agent.Options
    ) => Effect.Effect<Harness.Harness["Service"], ConnectionErrorReason>
  }

  /** The models a connection gives an agent. */
  readonly models?: {
    /** The catalog's models a connection offers, for an agent to be given one. */
    readonly listed: ReadonlyArray<ModelCatalog.Model>

    /**
     * Whether a connection also offers models that are not listed, by any id, as an API of the
     * connection's own does. Nothing more is known of them, so they take any effort and limit.
     */
    readonly unlisted: boolean

    /**
     * How an agent reaches a model the connection offers, with an effort and limit the model takes,
     * or why the connection cannot give it after all.
     */
    readonly endpoint: (
      access: Access<Settings, Auth>,
      options: EndpointOptions
    ) => Result.Result<ModelEndpoint.ModelEndpoint, UnsupportedError>
  }

  /** The sandbox provider of a connection, which works until the scope closes. */
  readonly sandboxes?: (
    access: Access<Settings, Auth>
  ) => Effect.Effect<SandboxProvider.SandboxProvider["Service"], ConnectionErrorReason, Scope.Scope>

  /** The tool source of a connection. */
  readonly tools?: (access: Access<Settings, Auth>) => Effect.Effect<ToolSource.ToolSource, ConnectionErrorReason>

  /** The channel transport of a connection, which receives the system's events and posts there. */
  readonly channels?: (
    access: Access<Settings, Auth>
  ) => Effect.Effect<ChannelTransport.ChannelTransport, ConnectionErrorReason>

  /** Checks a connection, as by asking the system for something only a working connection gets. */
  readonly check: (access: Access<Settings, Auth>) => Effect.Effect<Health>
}

/**
 * An integration as `make` declares it: what it is, what a connection to it gives, and the
 * operations that take a connection and its credential as they are stored. Each fails with
 * `ConnectionError`: `InvalidConnectionError` for a connection the integration does not take, and
 * `UnsupportedError` for what it does not give.
 *
 * @category models
 * @since 0.1.0
 */
export interface Integration {
  /** Names the integration, as connections name it, such as `anthropic` or `mcp`. */
  readonly id: string

  /** What people call the system, such as `Anthropic`. */
  readonly name: string

  /** Where the system's documentation is, when the integration says. */
  readonly docs: string | undefined

  /** The ways a connection can authenticate, in the order to offer them. */
  readonly auth: Array.NonEmptyReadonlyArray<AuthMethod>

  /** The settings a connection gives, as the form a person fills in to give them. */
  readonly settings: SettingsForm

  /** What a connection to the integration gives. */
  readonly provides: ReadonlyArray<Capability>

  /**
   * Whether the agent of the harnesses a connection gives works only in a sandbox. False for an
   * integration that gives no harnesses.
   */
  readonly requiresSandbox: boolean

  /**
   * The models a connection offers: the catalog's models it lists, and whether it also offers
   * models it does not list, by any id. None for an integration that gives no models.
   */
  readonly models: {
    readonly listed: ReadonlyArray<ModelCatalog.Model>
    readonly unlisted: boolean
  }

  /**
   * Fails for `connection` when the integration does not take it, by its settings or by how it
   * authenticates, and runs nothing. Its credential is apart from it, so whether it has the key it
   * needs is not checked.
   */
  readonly validate: (connection: Connection) => Effect.Effect<void, ConnectionError>

  /**
   * Fails, as `validate` does, for `connection`, and when it does not offer the model as `options`
   * ask for it: a model it does not offer, or an effort or output limit the model does not take.
   * Like `validate`, it runs nothing and needs no credential.
   */
  readonly validateModel: (connection: Connection, options: EndpointOptions) => Effect.Effect<void, ConnectionError>

  /**
   * The harness of `connection`, running its agent on the models `options` gives. It dies when the
   * harness says otherwise than the integration of whether its agent needs a sandbox.
   */
  readonly harness: (
    connection: Connection,
    credential: Credential | undefined,
    options: Agent.Options
  ) => Effect.Effect<Harness.Harness["Service"], ConnectionError>

  /** How an agent reaches a model through `connection`. */
  readonly modelEndpoint: (
    connection: Connection,
    credential: Credential | undefined,
    options: EndpointOptions
  ) => Effect.Effect<ModelEndpoint.ModelEndpoint, ConnectionError>

  /** The sandbox provider of `connection`, which works until the scope closes. */
  readonly sandboxProvider: (
    connection: Connection,
    credential: Credential | undefined
  ) => Effect.Effect<SandboxProvider.SandboxProvider["Service"], ConnectionError, Scope.Scope>

  /** The tool source of `connection`. */
  readonly toolSource: (
    connection: Connection,
    credential: Credential | undefined
  ) => Effect.Effect<ToolSource.ToolSource, ConnectionError>

  /** The channel transport of `connection`. */
  readonly channelTransport: (
    connection: Connection,
    credential: Credential | undefined
  ) => Effect.Effect<ChannelTransport.ChannelTransport, ConnectionError>

  /**
   * Checks `connection` by the integration's own `check`, failing only for a connection the
   * integration does not take: what the check finds, as a refused key, is the `Health`.
   */
  readonly check: (connection: Connection, credential: Credential | undefined) => Effect.Effect<Health, ConnectionError>
}

/**
 * The integration that `options` declares. It throws for settings that do not make a form, which
 * the integration's code must change.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <Settings = NoSettings, Auth extends AuthMethod = AuthMethod>(
  options: Options<Settings, Auth>
): Integration => {
  const auth: Array.NonEmptyReadonlyArray<AuthMethod> = options.auth
  // An integration that leaves its settings out has the settings `NoSettings` describes.
  const settings = (options.settings ?? noSettings) as Schema.Decoder<Settings>
  const fail = (reason: ConnectionErrorReason, cause?: unknown) =>
    new ConnectionError({ integration: options.id, reason, cause })

  /** The connection's settings decoded, failing for a connection the integration does not take. */
  const settingsOf = (connection: Connection) =>
    Effect.gen(function* () {
      if (!auth.includes(connection.auth)) {
        const description = `${options.name} takes no authentication by ${connection.auth}`
        return yield* fail(new InvalidConnectionError({ description }))
      }
      return yield* Schema.decodeEffect(settings)(connection.settings, {
        onExcessProperty: "error"
      }).pipe(
        Effect.mapError((cause) =>
          fail(
            new InvalidConnectionError({
              description: `The settings of ${connection.name} do not match what ${options.name} takes: ${cause.message}`
            }),
            cause
          )
        )
      )
    })

  /** `connection` as the integration's code takes it, failing for one the integration does not. */
  const accessOf = (connection: Connection, credential: Credential | undefined) =>
    Effect.gen(function* () {
      const decoded = yield* settingsOf(connection)
      if (connection.auth === "apiKey" && credential === undefined) {
        const description = `The connection ${connection.name} has no API key`
        return yield* fail(new InvalidConnectionError({ description }))
      }
      // A connection that authenticates with a key has one, as checked above.
      const access = {
        connection,
        settings: decoded,
        apiKey: connection.auth === "apiKey" ? credential?.apiKey : undefined
      } as Access<Settings, Auth>
      return access
    })

  const notProvided = (what: string) =>
    Effect.fail(fail(new UnsupportedError({ description: `${options.name} gives no ${what}` })))

  const models = {
    listed: options.models?.listed ?? [],
    unlisted: options.models?.unlisted ?? false
  }

  /** Fails when a connection does not offer the model as `endpointOptions` ask for it. */
  const ensureOffered = (endpointOptions: EndpointOptions) => {
    const description = offerRefusal(options.name, models, endpointOptions)
    return description === undefined ? Effect.void : Effect.fail(fail(new UnsupportedError({ description })))
  }

  return {
    id: options.id,
    name: options.name,
    docs: options.docs,
    auth,
    settings: settingsFormOf(options.name, settings),
    provides: [
      ...(options.harnesses === undefined ? [] : ["harnesses" as const]),
      ...(options.models === undefined ? [] : ["models" as const]),
      ...(options.sandboxes === undefined ? [] : ["sandboxes" as const]),
      ...(options.tools === undefined ? [] : ["tools" as const]),
      ...(options.channels === undefined ? [] : ["channels" as const])
    ],
    requiresSandbox: options.harnesses?.requiresSandbox ?? false,
    models,

    validate: (connection) => Effect.asVoid(settingsOf(connection)),

    validateModel: (connection, endpointOptions) => {
      if (options.models === undefined) return notProvided("models")
      return Effect.andThen(settingsOf(connection), ensureOffered(endpointOptions))
    },

    harness: (connection, credential, agentOptions) => {
      const { harnesses } = options
      if (harnesses === undefined) return notProvided("harnesses")
      return accessOf(connection, credential).pipe(
        Effect.flatMap((access) => Effect.mapError(harnesses.harness(access, agentOptions), (reason) => fail(reason))),
        // Agents are set up by what the integration says of its agent, before any harness is made.
        Effect.tap((harness) =>
          harness.agent.requiresSandbox === harnesses.requiresSandbox
            ? Effect.void
            : Effect.die(
                new Error(
                  `${options.name} says that its agent ${harnesses.requiresSandbox ? "works only in a sandbox" : "works without a sandbox"}, and the harness it made says otherwise`
                )
              )
        )
      )
    },

    modelEndpoint: (connection, credential, endpointOptions) => {
      const declared = options.models
      if (declared === undefined) return notProvided("models")
      return accessOf(connection, credential).pipe(
        Effect.tap(ensureOffered(endpointOptions)),
        Effect.flatMap((access) =>
          Effect.fromResult(declared.endpoint(access, endpointOptions)).pipe(Effect.mapError((reason) => fail(reason)))
        )
      )
    },

    sandboxProvider: (connection, credential) => {
      const { sandboxes } = options
      if (sandboxes === undefined) return notProvided("sandboxes")
      return accessOf(connection, credential).pipe(
        Effect.flatMap((access) => Effect.mapError(sandboxes(access), (reason) => fail(reason)))
      )
    },

    toolSource: (connection, credential) => {
      const { tools } = options
      if (tools === undefined) return notProvided("tools")
      return accessOf(connection, credential).pipe(
        Effect.flatMap((access) => Effect.mapError(tools(access), (reason) => fail(reason)))
      )
    },

    channelTransport: (connection, credential) => {
      const { channels } = options
      if (channels === undefined) return notProvided("channels")
      return accessOf(connection, credential).pipe(
        Effect.flatMap((access) => Effect.mapError(channels(access), (reason) => fail(reason)))
      )
    },

    check: (connection, credential) => Effect.flatMap(accessOf(connection, credential), options.check)
  }
}

/**
 * Why a connection to the integration named `name` does not offer the model as `options` ask for
 * it, or nothing when it does: a model it neither lists nor offers unlisted, an output limit that is
 * not a whole number of tokens, or an effort or a limit that the listed model does not take. A model
 * offered unlisted takes any effort and limit, as nothing more is known of it.
 */
const offerRefusal = (name: string, models: Integration["models"], options: EndpointOptions): string | undefined => {
  const { effort, maxOutputTokens } = options
  const model = models.listed.find((listed) => listed.id === options.model)
  if (model === undefined && !models.unlisted) return `${name} offers no model ${options.model}`
  if (maxOutputTokens !== undefined && !(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0)) {
    return `An output limit is a whole number of tokens above 0, not ${maxOutputTokens}`
  }
  if (model === undefined) return undefined
  if (effort !== undefined && !(model.reasoning?.efforts ?? []).includes(effort)) {
    return `${model.name} takes no effort ${effort}`
  }
  if (maxOutputTokens !== undefined && maxOutputTokens > model.limits.output) {
    return `${model.name} writes at most ${model.limits.output} tokens in a response, not ${maxOutputTokens}`
  }
  return undefined
}

/**
 * The form of the settings an integration named `name` takes, from their JSON Schema. It throws for
 * settings that do not make a form, such as a nested object.
 */
const settingsFormOf = (name: string, settings: Schema.Decoder<unknown>): SettingsForm => {
  const { schema } = Schema.toJsonSchemaDocument(settings)
  // The JSON Schema of an object with no keys lists no properties, which a form must.
  const form = Schema.decodeUnknownExit(SettingsForm)({ properties: {}, ...schema })
  if (Exit.isSuccess(form)) return form.value
  throw new Error(`The settings of ${name} do not make a form: ${String(form.cause)}`)
}

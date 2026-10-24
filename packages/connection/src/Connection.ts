/**
 * A connection is a workspace's link to one integration, such as its Anthropic account or the MCP
 * server of its issue tracker: the settings the integration takes, such as a URL, and how the
 * connection authenticates. The secret it authenticates with is its credential, which is kept apart
 * from it, so that a connection can be shown and stored without it.
 *
 * `ConnectionError` is what a connection that cannot be used as asked fails with, and `Health` what
 * checking a connection finds.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * The identity of a connection, as core records it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ConnectionId = Schema.NonEmptyString.pipe(Schema.brand("ConnectionId"))

/**
 * @category schemas
 * @since 0.1.0
 */
export type ConnectionId = typeof ConnectionId.Type

// TODO: Add OAuth, once an integration a connection is made to takes it.
/**
 * How a connection authenticates: with an API key, or not at all.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AuthMethod = Schema.Literals(["apiKey", "none"])

/**
 * @category schemas
 * @since 0.1.0
 */
export type AuthMethod = typeof AuthMethod.Type

/**
 * A workspace's link to one integration, as core stores it and an integration's operations take
 * it: which integration, what the workspace calls it, its settings, and how it authenticates. Its
 * credential is kept apart, as `Credential`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Connection = Schema.Struct({
  id: ConnectionId,

  /** The integration the connection links to, as its id names it. */
  integration: Schema.NonEmptyString,

  /** What the workspace calls the connection, such as `Work Anthropic`. */
  name: Schema.NonEmptyString,

  /** The settings the connection's integration takes, as JSON. */
  settings: Schema.Record(Schema.String, Schema.Json),

  /** How the connection authenticates, as one of the methods its integration offers. */
  auth: AuthMethod
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Connection extends Schema.Schema.Type<typeof Connection> {}

/**
 * The secret a connection authenticates with: its API key.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Credential = Schema.Struct({ apiKey: Schema.Redacted(Schema.String) })

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Credential extends Schema.Schema.Type<typeof Credential> {}

/**
 * What checking a connection finds: that nothing the check could see is wrong, that the system
 * refused the credential, that the settings lead nowhere the integration works, or that the system
 * could not answer, which may pass.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Health = Schema.Struct({
  status: Schema.Literals(["healthy", "unauthorized", "misconfigured", "unavailable"]),

  /** What the check found, for a status other than `healthy`. */
  description: Schema.optionalKey(Schema.String)
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Health extends Schema.Schema.Type<typeof Health> {}

/**
 * What an answer of `status` from `url` says of the connection: refusing the key, not knowing the
 * request, or being unable to answer it now. Any other answer, as one that says the request is
 * incomplete, comes once the key is taken. For integrations whose check asks over HTTP, as those
 * of `ModelIntegrations` do.
 *
 * @category constructors
 * @since 0.1.0
 */
export const healthOfStatus = (status: number, url: string): Health => {
  if (status === 401 || status === 403) {
    return { status: "unauthorized", description: `${url} refused the key (${status})` }
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { status: "unavailable", description: `${url} could not answer now (${status})` }
  }
  if (status === 404 || status === 405) {
    return { status: "misconfigured", description: `${url} serves no such request (${status})` }
  }
  return { status: "healthy" }
}

/**
 * What a check that nothing at `url` answered says of the connection: it is unavailable.
 *
 * @category constructors
 * @since 0.1.0
 */
export const unanswered = (url: string): Health => ({
  status: "unavailable",
  description: `Nothing answered at ${url}`
})

/**
 * What a check that failed for `reason` says of the connection: unavailable when trying again may
 * succeed, and misconfigured otherwise.
 *
 * @category constructors
 * @since 0.1.0
 */
export const healthOfReason = (reason: ConnectionErrorReason): Health => ({
  status: reason.isRetryable ? "unavailable" : "misconfigured",
  description: reason.message
})

/**
 * The host has no integration of the id a connection names.
 *
 * @category errors
 * @since 0.1.0
 */
export class NotFoundError extends Schema.TaggedError<NotFoundError>("@amends-dev/connection/Connection/NotFoundError")(
  "NotFoundError",
  { description: Schema.optional(Schema.String) }
) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The host has no integration of this id"
  }
}

/**
 * The connection is not one its integration takes: its settings do not match, it authenticates in
 * a way the integration does not offer, or it has no credential to authenticate with.
 *
 * @category errors
 * @since 0.1.0
 */
export class InvalidConnectionError extends Schema.TaggedError<InvalidConnectionError>(
  "@amends-dev/connection/Connection/InvalidConnectionError"
)("InvalidConnectionError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The integration does not take this connection"
  }
}

/**
 * The integration does not give what was asked of the connection, such as models from an
 * integration of tools, or a model or an effort it does not offer.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnsupportedError extends Schema.TaggedError<UnsupportedError>(
  "@amends-dev/connection/Connection/UnsupportedError"
)("UnsupportedError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The integration does not give what was asked"
  }
}

/**
 * The integration's system could not be reached for what was asked, which may pass.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnavailableError extends Schema.TaggedError<UnavailableError>(
  "@amends-dev/connection/Connection/UnavailableError"
)("UnavailableError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return true
  }

  override get message(): string {
    return this.description ?? "The integration's system could not be reached"
  }
}

/**
 * Why an integration's operation failed: one of the errors above, which `ConnectionError.reason`
 * holds.
 *
 * @category errors
 * @since 0.1.0
 */
export const ConnectionErrorReason = Schema.Union([
  NotFoundError,
  InvalidConnectionError,
  UnsupportedError,
  UnavailableError
]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * @category errors
 * @since 0.1.0
 */
export type ConnectionErrorReason = typeof ConnectionErrorReason.Type

/**
 * What every operation of an integration fails with: the integration of the connection, by its
 * id, and the reason. Only an `UnavailableError` is worth trying again, as `isRetryable` says.
 *
 * @category errors
 * @since 0.1.0
 */
export class ConnectionError extends Schema.TaggedError<ConnectionError>(
  "@amends-dev/connection/Connection/ConnectionError"
)("ConnectionError", {
  /** The integration of the connection, as its id names it. */
  integration: Schema.String,

  /** Why the operation failed. */
  reason: ConnectionErrorReason,

  /** The failure underneath, such as the error of decoding a connection's settings. */
  cause: Schema.optional(Schema.Defect())
}) {
  get isRetryable(): boolean {
    return this.reason.isRetryable
  }

  override get message(): string {
    return `${this.integration}: ${this.reason.message}`
  }
}

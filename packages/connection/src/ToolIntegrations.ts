/**
 * The integrations of tool sources: `mcp`, an MCP server reached over Streamable HTTP at the URL a
 * connection gives, and `openApi`, an HTTP API whose OpenAPI document, as JSON, is at the URL a
 * connection gives. A connection authenticates with an API key or not at all. The key goes in the
 * `Authorization` header as a bearer token, or as it is in the header the connection names, on
 * every request to the server or the API, and on nothing else: an API's document is read without
 * it.
 *
 * Checking a connection to an MCP server asks it which tools it has. Checking one to an API reads its
 * document, which the key plays no part in, so a wrong key shows when a tool first runs.
 *
 * @since 0.1.0
 */

import { Http, Mcp, OpenApi, ToolSourceError } from "@amends-dev/toolkit"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import {
  type ConnectionErrorReason,
  type Health,
  healthOfReason,
  InvalidConnectionError,
  UnavailableError
} from "./Connection.ts"
import * as Integration from "./Integration.ts"

const keyHeader = Schema.optionalKey(Schema.NonEmptyString).annotate({
  title: "Key header",
  description: "The header the API key goes in, as it is. Without one, it goes in Authorization as a bearer token."
})

/**
 * The integration of MCP servers, `mcp`, which reaches them over the host's client.
 *
 * @category constructors
 * @since 0.1.0
 */
export const mcp = Effect.map(HttpClient.HttpClient, (client) => {
  const sourceOf = ({
    connection,
    settings,
    apiKey
  }: Integration.Access<{ readonly url: string; readonly keyHeader?: string }>) =>
    Mcp.http({
      name: connection.name,
      url: settings.url,
      client: withKey(client, apiKey, settings.keyHeader)
    })
  return Integration.make({
    id: "mcp",
    name: "MCP server",
    docs: "https://modelcontextprotocol.io",
    settings: Schema.Struct({
      url: Schema.NonEmptyString.annotate({
        title: "Server URL",
        description: "Where the MCP server answers over Streamable HTTP."
      }),
      keyHeader
    }),
    auth: ["apiKey", "none"],
    tools: sourceOf,
    check: (access) =>
      sourceOf(access).pipe(
        Effect.flatMap((source) => source.discover),
        Effect.as<Health>({ status: "healthy" }),
        Effect.catch((error) => Effect.succeed(healthOfFailure(error)))
      )
  })
})

/**
 * The integration of HTTP APIs with an OpenAPI document, `openapi`, which reaches them over the
 * host's client.
 *
 * @category constructors
 * @since 0.1.0
 */
export const openApi = Effect.map(HttpClient.HttpClient, (client) => {
  /** The API's operations, from its document, and the base URL its requests go to. */
  const apiOf = (settings: {
    readonly documentUrl: string
    readonly baseUrl?: string
  }): Effect.Effect<
    { readonly operations: ReadonlyArray<Http.Operation>; readonly baseUrl: string },
    ConnectionErrorReason
  > =>
    Effect.gen(function* () {
      const { documentUrl } = settings
      const response = yield* client
        .get(documentUrl)
        .pipe(Effect.mapError(() => new UnavailableError({ description: `Nothing answered at ${documentUrl}` })))
      if (response.status === 429 || response.status >= 500) {
        const description = `${documentUrl} could not answer now (${response.status})`
        return yield* new UnavailableError({ description })
      }
      const document = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
        Effect.mapError(
          () =>
            new InvalidConnectionError({
              description: `${documentUrl} answered with no JSON document (${response.status})`
            })
        )
      )
      const imported = yield* OpenApi.readOperations(document).pipe(
        Effect.mapError(
          (error) =>
            new InvalidConnectionError({
              description: `The document at ${documentUrl} is not one of an API: ${error.message}`
            })
        )
      )
      const [server] = imported.servers
      const baseUrl = settings.baseUrl ?? (server === undefined ? undefined : resolveUrl(server, documentUrl))
      if (baseUrl === undefined) {
        const description = `The document at ${documentUrl} names no server, so the connection must give a base URL`
        return yield* new InvalidConnectionError({ description })
      }
      return { operations: imported.operations, baseUrl }
    })

  // TODO: Keep an API's operations in the catalog of tools, rather than reading its document each
  // time a source is made, once the catalog stores them.
  // TODO: Read a document written in YAML, and one that only a request with the key can read.
  return Integration.make({
    id: "openapi",
    name: "HTTP API",
    docs: "https://spec.openapis.org/oas/latest.html",
    settings: Schema.Struct({
      documentUrl: Schema.NonEmptyString.annotate({
        title: "Document URL",
        description: "Where the API's OpenAPI document is, as JSON."
      }),
      baseUrl: Schema.optionalKey(Schema.NonEmptyString).annotate({
        title: "Base URL",
        description: "Where the API's requests go, when not to the first server its document names."
      }),
      keyHeader
    }),
    auth: ["apiKey", "none"],
    tools: ({ connection, settings, apiKey }) =>
      apiOf(settings).pipe(
        Effect.flatMap(({ operations, baseUrl }) =>
          Http.make({
            name: connection.name,
            baseUrl,
            client: withKey(client, apiKey, settings.keyHeader),
            operations
          })
        )
      ),
    check: ({ settings }) =>
      apiOf(settings).pipe(
        Effect.as<Health>({ status: "healthy" }),
        Effect.catch((reason) => Effect.succeed(healthOfReason(reason)))
      )
  })
})

/**
 * The address `url` names, which may be a path that follows the address of the document at `base`,
 * as a document may name its server.
 *
 * @category utilities
 * @since 0.1.0
 */
export const resolveUrl = (url: string, base: string) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(base)?.[0] ?? ""
  if (url.startsWith("/")) return `${origin}${url}`
  const directory = base.replace(/[?#].*$/, "").replace(/[^/]*$/, "")
  return `${directory}${url}`
}

/** `client` with `apiKey` on every request, in `header` as it is, or else as a bearer token. */
const withKey = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string> | undefined,
  header: string | undefined
) =>
  apiKey === undefined
    ? client
    : HttpClient.mapRequest(
        client,
        header === undefined
          ? HttpClientRequest.bearerToken(Redacted.value(apiKey))
          : HttpClientRequest.setHeader(header, Redacted.value(apiKey))
      )

/** What a source's failing to say which tools it has says of the connection. */
const healthOfFailure = ({ reason }: ToolSourceError.ToolSourceError): Health =>
  ToolSourceError.ToolSourceErrorReason.matchOrElse(
    reason,
    {
      AuthenticationError: (): Health => ({ status: "unauthorized", description: reason.message }),
      UnavailableError: (): Health => ({ status: "unavailable", description: reason.message })
    },
    (): Health => ({ status: "misconfigured", description: reason.message })
  )

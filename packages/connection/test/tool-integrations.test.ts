import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Logger, Redacted, Schema } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse, HttpRouter } from "effect/http"
import * as Connection from "../src/Connection.ts"
import * as ToolIntegrations from "../src/ToolIntegrations.ts"

const key = Redacted.make("secret-key")

const connectionTo = (
  integration: string,
  settings: Connection.Connection["settings"],
  auth: Connection.AuthMethod = "apiKey"
): Connection.Connection => ({
  id: Connection.ConnectionId.make("conn-1"),
  integration,
  name: "issues",
  settings,
  auth
})

const Echo = Tool.make("echo", {
  description: "Echoes the text",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})

const EchoToolkit = Toolkit.make(Echo)

const mcpServer = Layer.mergeAll(
  McpServer.toolkit(EchoToolkit).pipe(Layer.provide(EchoToolkit.toLayer({ echo: ({ text }) => Effect.succeed(text) })))
).pipe(
  Layer.provide(
    McpServer.layerHttp({
      name: "issues",
      version: "1.0.0",
      path: "/mcp",
      protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25]
    })
  ),
  Layer.provide(Logger.layer([]))
)

/**
 * The MCP integration, reaching an MCP server at `http://issues.test/mcp` in this process, which
 * answers only requests with `header` set to `value`, or no request at all when `reachable` is
 * false. The headers of each request it received are kept.
 */
const mcpServing = ({ header, value, reachable = true }: { header: string; value: string; reachable?: boolean }) =>
  Effect.gen(function* () {
    const received: Array<Record<string, string>> = []
    const server = HttpRouter.toWebHandler(mcpServer, { disableLogger: true })
    yield* Effect.addFinalizer(() => Effect.promise(() => server.dispose()))
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      if (!reachable) throw new TypeError("Unable to connect")
      received.push(Object.fromEntries(request.headers))
      if (request.headers.get(header) !== value) return new Response(null, { status: 401 })
      return server.handler(request)
    }
    const fetch: typeof globalThis.fetch = Object.assign(fetchImpl, { preconnect() {} })
    const integration = yield* ToolIntegrations.mcp.pipe(
      Effect.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))))
    )
    return { integration, received }
  })

const mcpConnection = (settings: Connection.Connection["settings"] = {}) =>
  connectionTo("mcp", { url: "http://issues.test/mcp", ...settings })

describe("ToolIntegrations.mcp", () => {
  it.effect("gives the tools of an MCP server, reached with the key as a bearer token", () =>
    Effect.gen(function* () {
      const { integration, received } = yield* mcpServing({
        header: "authorization",
        value: "Bearer secret-key"
      })

      const source = yield* integration.toolSource(mcpConnection(), { apiKey: key })
      const tools = yield* source.discover
      const echoed = yield* source.call("echo", { text: "hi" })

      expect(integration.provides).toEqual(["tools"])
      expect(source.name).toBe("issues")
      expect(tools.map((tool) => tool.name)).toEqual(["echo"])
      expect(echoed).toBe("hi")
      expect(received.every((headers) => headers["authorization"] === "Bearer secret-key")).toBe(true)
    }).pipe(Effect.scoped)
  )

  it.effect("puts the key in the header the connection names, as it is", () =>
    Effect.gen(function* () {
      const { integration, received } = yield* mcpServing({
        header: "x-api-key",
        value: "secret-key"
      })

      const source = yield* integration.toolSource(mcpConnection({ keyHeader: "X-Api-Key" }), {
        apiKey: key
      })
      yield* source.discover

      expect(received.length).toBeGreaterThan(0)
      for (const headers of received) {
        expect(headers["x-api-key"]).toBe("secret-key")
        expect(headers).not.toHaveProperty("authorization")
      }
    }).pipe(Effect.scoped)
  )

  it.effect("checks a server by asking which tools it has", () =>
    Effect.gen(function* () {
      const served = yield* mcpServing({ header: "authorization", value: "Bearer secret-key" })
      const unreachable = yield* mcpServing({ header: "x", value: "y", reachable: false })

      const checked = [
        yield* served.integration.check(mcpConnection(), { apiKey: key }),
        yield* served.integration.check(mcpConnection(), { apiKey: Redacted.make("wrong") }),
        yield* served.integration.check(connectionTo("mcp", { url: "http://issues.test/mcp" }, "none"), undefined),
        yield* unreachable.integration.check(mcpConnection(), { apiKey: key })
      ]
      const keyless = yield* Effect.flip(served.integration.check(mcpConnection(), undefined))

      expect(checked.map((health) => health.status)).toEqual(["healthy", "unauthorized", "unauthorized", "unavailable"])
      // A connection that authenticates with nothing sends no credential.
      expect(served.received.at(-1)).not.toHaveProperty("authorization")
      expect(keyless.reason._tag).toBe("InvalidConnectionError")
    }).pipe(Effect.scoped)
  )
})

/** An API that greets whom its one operation is given, as its OpenAPI document says. */
const document = {
  openapi: "3.1.0",
  info: { title: "Greeter", version: "1" },
  servers: [{ url: "/v1" }],
  paths: {
    "/greeting": {
      get: {
        operationId: "greet",
        parameters: [{ name: "name", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "The greeting",
            content: { "application/json": { schema: { type: "object" } } }
          }
        }
      }
    }
  }
}

interface Sent {
  readonly url: string
  readonly headers: Record<string, string>
}

/**
 * The OpenAPI integration, reaching an API at `http://greeter.test`, whose document is at
 * `/openapi.json` and answers as `answer` says, or, without one, reaches nothing. The API greets
 * only requests with the key as a bearer token.
 */
const apiServing = (answer?: { readonly status: number; readonly body: unknown }) =>
  Effect.gen(function* () {
    const sent: Array<Sent> = []
    const client = HttpClient.make((request, url) =>
      Effect.suspend(() => {
        sent.push({ url: url.toString(), headers: { ...request.headers } })
        if (answer === undefined) {
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request })
            })
          )
        }
        const respond = (status: number, body: unknown) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })))
        if (url.pathname === "/openapi.json") return respond(answer.status, answer.body)
        if (request.headers["authorization"] !== "Bearer secret-key") return respond(401, {})
        return respond(200, { hello: url.searchParams.get("name") })
      })
    )
    const integration = yield* Effect.provideService(ToolIntegrations.openApi, HttpClient.HttpClient, client)
    return { integration, sent }
  })

const apiConnection = (settings: Connection.Connection["settings"] = {}) =>
  connectionTo("openapi", { documentUrl: "http://greeter.test/openapi.json", ...settings })

describe("ToolIntegrations.openApi", () => {
  it.effect("gives the operations of an API's document, sending the key only to the API", () =>
    Effect.gen(function* () {
      const { integration, sent } = yield* apiServing({ status: 200, body: document })

      const source = yield* integration.toolSource(apiConnection(), { apiKey: key })
      const tools = yield* source.discover
      const greeted = yield* source.call("greet", { name: "Ada" })

      expect(tools.map((tool) => tool.name)).toEqual(["greet"])
      expect(greeted).toEqual({ hello: "Ada" })
      expect(sent.map(({ url }) => url)).toEqual([
        "http://greeter.test/openapi.json",
        "http://greeter.test/v1/greeting?name=Ada"
      ])
      expect(sent[0]?.headers).not.toHaveProperty("authorization")
      expect(sent[1]?.headers["authorization"]).toBe("Bearer secret-key")
    })
  )

  it.effect("sends the requests to the base URL the connection gives, over the document's", () =>
    Effect.gen(function* () {
      const { integration, sent } = yield* apiServing({ status: 200, body: document })

      const source = yield* integration.toolSource(apiConnection({ baseUrl: "http://greeter.test/v2" }), {
        apiKey: key
      })
      yield* source.call("greet", { name: "Ada" })

      expect(sent.at(-1)?.url).toBe("http://greeter.test/v2/greeting?name=Ada")
    })
  )

  it.effect("refuses an API whose document names no server, when the connection gives none", () =>
    Effect.gen(function* () {
      const { servers: _, ...serverless } = document
      const { integration } = yield* apiServing({ status: 200, body: serverless })

      const error = yield* Effect.flip(integration.toolSource(apiConnection(), { apiKey: key }))

      expect(error.reason).toMatchObject({
        _tag: "InvalidConnectionError",
        description:
          "The document at http://greeter.test/openapi.json names no server, so the connection must give a base URL"
      })
    })
  )

  it.effect("checks an API by reading its document", () =>
    Effect.gen(function* () {
      const answers = [
        { status: 200, body: document },
        { status: 404, body: {} },
        { status: 200, body: { swagger: "2.0" } },
        { status: 503, body: {} },
        undefined
      ]

      const checked = yield* Effect.forEach(answers, (answer) =>
        Effect.flatMap(apiServing(answer), ({ integration }) => integration.check(apiConnection(), { apiKey: key }))
      )

      expect(checked.map((health) => health.status)).toEqual([
        "healthy",
        "misconfigured",
        "misconfigured",
        "unavailable",
        "unavailable"
      ])
      expect(checked[2]?.description).toContain("Swagger 2.0")
    })
  )
})

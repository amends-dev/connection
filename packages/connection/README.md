# @amends-dev/connection

What amends connects to, and what it knows of the models it can run. An **integration** is a kind of
system a host installs, such as a model provider, an MCP server, a sandbox platform, or an agent; a
**connection** is a workspace's link to one, with its settings and key. This package declares
integrations and what each gives a workspace's connections: harnesses that run agents, models they
run on, sandboxes they work in, tools they call, and channels whose conversations become threads. It
also holds the model catalog.

In [amends](https://github.com/amends-dev/amends),
[core](https://github.com/amends-dev/amends/tree/main/packages/core#connections) records connections
and their keys, the host decides which integrations it installs (the
[local host](https://github.com/amends-dev/amends/tree/main/hosts/local#readme) declares its own),
and [cluster](https://github.com/amends-dev/amends/tree/main/packages/cluster#readme) builds a
turn's harness, model, and sandbox from them. The package depends on Effect and on the contracts
whose values a connection gives: the [harness](https://github.com/amends-dev/harness)'s `Harness`
and `ModelEndpoint`, the [sandbox](https://github.com/amends-dev/sandbox)'s `SandboxProvider`, the
[toolkit](https://github.com/amends-dev/toolkit)'s `ToolSource`, and the
[channel](https://github.com/amends-dev/channel)'s `ChannelTransport`.

## Install

```sh
bun add @amends-dev/connection effect
```

## Integrations, connections, and credentials

An **integration** is a kind of system amends connects to, declared in code with `Integration.make`:
its `settings`, a schema of what a connection to it gives besides a secret, such as a URL, left out
when it takes none; the `auth` methods a connection can authenticate by, `apiKey` or `none`; what a
connection gives, of `harnesses` that run agents, `models` an agent runs on, `sandboxes` it works
in, `tools` it calls, and `channels` whose conversations become threads; and a `check`. The code of
an integration is given a connection with its settings decoded and its key, which it always has when
a connection to it authenticates only with a key. An integration that gives harnesses says whether
their agent `requiresSandbox`, so that an agent can be set up to run on it before any harness is
made. One that gives models lists the catalog's models a connection offers, and says whether it also
offers `unlisted` models, by any id, which take any effort and output limit as nothing more is known
of them.

An integration describes its settings as a form a person fills in, `SettingsForm`: the JSON Schema
of an object of text, number, yes-or-no, and choice fields, which is how MCP asks a person for
input. The form comes from the settings schema, with each field's `title` and `description`
annotations, so settings are asked for without code for each integration; `make` throws for settings
that make no form, such as a nested object or an empty struct, which takes any value.

An integration of a chat system's rooms, whose connections give channels and authenticate with a
key, for example:

```ts
import type { ChannelTransport } from "@amends-dev/channel"
import { Connection, Integration } from "@amends-dev/connection"
import { Effect, type Redacted, Schema } from "effect"

// The transport for one room server, written as `@amends-dev/channel` shows.
declare const roomTransport: (url: string, apiKey: Redacted.Redacted<string>) => ChannelTransport.ChannelTransport
// The HTTP status the server at `url` answers a request with the key with.
declare const statusOf: (url: string, apiKey: Redacted.Redacted<string>) => Effect.Effect<number, Error>

export const rooms = Integration.make({
  id: "rooms",
  name: "Rooms",
  settings: Schema.Struct({
    url: Schema.NonEmptyString.annotate({ title: "Server URL", description: "Where the room server answers." })
  }),
  auth: ["apiKey"],
  channels: ({ settings, apiKey }) => Effect.succeed(roomTransport(settings.url, apiKey)),
  check: ({ settings, apiKey }) =>
    statusOf(settings.url, apiKey).pipe(
      Effect.map((status) => Connection.healthOfStatus(status, settings.url)),
      Effect.orElseSucceed(() => Connection.unanswered(settings.url))
    )
})
```

A **connection** is a workspace's link to one integration: its id, the integration's id, a name, its
settings as JSON, and the auth method it uses. Its **credential**, the API key, is kept apart, so
that a connection can be shown and stored without it. An integration's operations take the two as
they are stored: `validate` refuses a connection by its settings, which are those of the form and no
others, or by its auth method, running nothing and without its credential; `validateModel` refuses
it as `validate` does, and refuses a model it does not offer, or an effort or output limit the model
does not take, likewise; `harness` gives a harness that runs its agent on the models it is given, as
`Agent.Options`, and dies when the harness says otherwise of the sandbox its agent needs;
`modelEndpoint` how an agent reaches a model, which it refuses as `validateModel` does;
`sandboxProvider` a sandbox provider that works until its scope closes, `toolSource` a tool source,
and `check` its `Health`. They fail with `ConnectionError`, which names the integration and holds a
reason: `NotFoundError`, `InvalidConnectionError` for settings, an auth method, or a missing key the
integration does not take, `UnsupportedError` for what it does not give, and `UnavailableError`,
which may pass.

`Integrations` holds those a host installs, for a connection to find its own by id: the built-in
ones it chooses, and those of the harnesses and sandbox providers it runs, which the host declares
itself, as the local host's `HarnessIntegrations` and `SandboxIntegrations` do. What only the host
decides, such as where a local sandbox keeps its files or what opencode's bridge tokens derive from,
it gives an integration when it installs it; a connection's settings are what a workspace gives.
What a check finds is a `Connection.Health`: `Connection.healthOfStatus` reads one from the HTTP
status an integration's check got, `Connection.unanswered` is what a check that got no answer finds,
and `Connection.healthOfReason` is what a check that failed with a `ConnectionError` reason finds.

## Models

The model catalog is what amends knows of the models it can run: for each provider, the models
reached through Anthropic Messages, OpenAI Responses, or Chat Completions, with where each is
served, its limits, modalities, tool support, reasoning controls, and cost. It is
`src/internal/snapshot.ts`, which `bun run update-models` writes from
[models.dev](https://models.dev), failing when a field the catalog keeps changes shape;
`ModelCatalog.layer` reads it.

`ModelIntegrations.catalogProviders` is an integration for each provider in the catalog. A
connection authenticates with an API key, gives the settings the provider's URLs name, such as a
Cloudflare account's id, and offers the provider's models in the catalog and no others. Its endpoint
for a model is where the catalog says the model is served, with the effort and output limit an agent
asks for, which the model must offer, and the model's context window.
`ModelIntegrations.openAiCompatible` offers any model of an API that serves Chat Completions at the
URL a connection gives, unlisted, with a key or none, as a provider of the connection's own.

Checking a connection to a provider asks it for a response to a request it must refuse, as it has no
messages, naming the model it released last of those it released fully. A provider that reads the
key first refuses a wrong key, and otherwise says the request is incomplete, which costs nothing. A
few, such as NVIDIA's and Fireworks', look at the request first, so a wrong key there shows only
when a turn runs. Checking an OpenAI-compatible API asks it which models it has.

## Tools

`ToolIntegrations.mcp` reaches an MCP server over Streamable HTTP at the URL a connection gives, and
`ToolIntegrations.openApi` an HTTP API whose OpenAPI document, as JSON, is at the URL a connection
gives, sending requests to the base URL it gives or to the first server the document names. A
connection authenticates with an API key, in the `Authorization` header as a bearer token or as it
is in a header the connection names, or with none. The key goes on the requests to the server or the
API alone; an API's document is read without it. Checking an MCP server asks it which tools it has.
Checking an API reads its document, which the key plays no part in, so a wrong key there shows when
a tool first runs.

## Channels

An integration gives channels with `channels: (access) => Effect<ChannelTransport>`, and
`Integration.channelTransport(connection, credential?)` makes the transport for a connection: how
its external system's conversations are received and replied to, as the
[channel contract](https://github.com/amends-dev/channel/tree/main/packages/channel#readme) describes. No integration amends's local host installs
gives channels yet; the conformance suites run channels on a test transport.

## Development

```sh
bun run test packages/connection
bun run --cwd packages/connection update-models
```

`update-models` rewrites `src/internal/snapshot.ts` from models.dev. `test/models-dev.test.ts` and
`test/model-catalog.test.ts` check how models.dev's data becomes the catalog, and the snapshot;
`test/integration.test.ts` what `Integration.make` does with a connection, and `Integrations`;
`test/model-integrations.test.ts` the catalog's models through a client that answers as a provider
would; and `test/tool-integrations.test.ts` an MCP server in the test's process and an HTTP API with
its document. `test/live.test.ts` checks connections to real providers with `AMENDS_TEST_MODELS=1`.

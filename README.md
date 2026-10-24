# connection

What a host connects to, for [Effect](https://effect.website). An integration is a kind of system a
host installs, such as a model provider, an MCP server, a sandbox platform, or an agent; a
connection is a workspace's link to one, with its settings and key. This package declares
integrations and what each gives a connection: harnesses that run agents, models they run on,
sandboxes they work in, tools they call, and channels whose conversations become threads. It also
holds the model catalog, from [models.dev](https://models.dev).

| Package                                         | What it is                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| [`@amends-dev/connection`](packages/connection) | Integrations, what each gives a connection, and the model catalog |

```sh
bun add @amends-dev/connection effect
```

The [package's guide](packages/connection/README.md) describes integrations, connections and their
credentials, and the models, tools, and channels they give. What a connection gives comes from the
[harness](https://github.com/amends-dev/harness), [sandbox](https://github.com/amends-dev/sandbox),
[toolkit](https://github.com/amends-dev/toolkit), and [channel](https://github.com/amends-dev/channel)
contracts. [amends](https://github.com/amends-dev/amends) records connections and declares the
integrations its host installs.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setting up, the checks every change passes, and
releases. Report a vulnerability as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)

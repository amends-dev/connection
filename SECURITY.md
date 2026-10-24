# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability**. Do not open a public issue or pull request for it.

Say what is affected, such as a package and its version, how to reproduce it, and what an attacker
could do with it. We will confirm we received it, keep you told as we investigate and fix it, and
publish a security advisory once a fix is released, crediting you if you would like.

## Supported versions

These packages are in early development. Fixes go into `main` and the next release of each
package; earlier releases do not receive them.

## Scope

Reports are welcome for every package in this repository: above all, a way for a connection's key
to reach anything but the system it is for, such as an OpenAPI document's server or a model, or for
a connection's settings to send its requests somewhere the integration does not mean them to go.

Some behavior is by design, and is not a vulnerability:

- **Keys are kept by the host.** A connection is stored and shown without its credential, and the
  host keeps the credential and gives it to the integration's operations; how it is stored is the
  host's.
- **Checking a connection sends a request.** `check` asks a model provider or an MCP server a
  question with the connection's key, so the system sees the key, as it would on any request.

A vulnerability in Effect, models.dev's data, a provider, an MCP server, an API, or another
dependency belongs with that project. Tell us too when it affects these packages in a way of its
own.

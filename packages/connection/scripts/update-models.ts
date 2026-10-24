/**
 * Writes `src/internal/snapshot.ts`, the model catalog this package ships, from models.dev's current data.
 * Reading the data fails, and writes nothing, when a part the catalog keeps has changed shape, so
 * that the change is made here rather than found by a host.
 *
 * The snapshot is the catalog's JSON in a raw template string, which a type checker reads as a
 * string rather than a type for every model, with a line for each provider and each of its models,
 * so that an update shows as the lines of the models it changed.
 *
 * Run it with `bun run update-models` in this package.
 */

import { Effect } from "effect"
import type * as ModelCatalog from "../src/ModelCatalog.ts"
import * as ModelsDev from "../src/ModelsDev.ts"

const source = "https://models.dev/api.json"

// models.dev takes a request whose user agent names Bun, as Bun's own does, for its own app's use.
const response = await fetch(source, { headers: { "user-agent": "amends-update-models" } })
if (!response.ok) throw new Error(`${source} answered ${response.status}`)
const catalog = await Effect.runPromise(ModelsDev.toCatalog(await response.json()))

/** The catalog as JSON, a line for each provider and each of its models. */
const jsonOf = (catalog: ModelCatalog.Catalog) => {
  const providers = catalog.providers.map(({ models, ...provider }) => {
    const head = JSON.stringify(provider).slice(0, -1)
    const lines = models.map((model) => `    ${JSON.stringify(model)}`)
    return `  ${head},"models":[\n${lines.join(",\n")}\n  ]}`
  })
  return `{"providers":[\n${providers.join(",\n")}\n]}`
}

const json = jsonOf(catalog)
// A raw template string keeps the JSON as it is, except for these, which would end or interrupt it.
if (json.includes("`") || json.includes("${")) {
  throw new Error("The catalog has a backtick or ${, which the snapshot's template cannot hold")
}

await Bun.write(
  new URL("../src/internal/snapshot.ts", import.meta.url),
  [
    "// Written by `bun run update-models` from models.dev. Do not edit.",
    "",
    "/** The model catalog as JSON, a line for each provider and each of its models. */",
    `export const snapshot = String.raw\`${json}\`;`,
    ""
  ].join("\n")
)

const models = catalog.providers.reduce((sum, provider) => sum + provider.models.length, 0)
console.log(`Wrote ${catalog.providers.length} providers and ${models} models to src/internal/snapshot.ts`)

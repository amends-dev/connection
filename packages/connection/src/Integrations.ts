/**
 * The integrations a host installs, among which a connection finds its own by the id it names: the
 * built-in ones it chooses, such as those of `ModelIntegrations` and `ToolIntegrations`, and those
 * it declares itself, such as of the sandbox providers it runs.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Connection from "./Connection.ts"
import type * as Integration from "./Integration.ts"

/**
 * The service through which a connection finds its integration among those the host installs.
 * The host provides it from `make`.
 *
 * @category services
 * @since 0.1.0
 */
export class Integrations extends Context.Service<
  Integrations,
  {
    /** Every installed integration, in the order the host gave them. */
    readonly all: ReadonlyArray<Integration.Integration>

    /** The integration of the id `id`, failing with `NotFoundError` for one the host has not. */
    readonly find: (id: string) => Effect.Effect<Integration.Integration, Connection.ConnectionError>
  }
>()("@amends-dev/connection/Integrations") {}

/**
 * The installed integrations `integrations`, whose ids must be distinct. It dies when two share an
 * id.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (integrations: ReadonlyArray<Integration.Integration>) => {
  const byId = new Map(integrations.map((integration) => [integration.id, integration]))
  if (byId.size !== integrations.length) {
    return Effect.die(new Error("More than one integration has the same id"))
  }
  return Effect.succeed(
    Integrations.of({
      all: integrations,
      find: (id) => {
        const integration = byId.get(id)
        if (integration !== undefined) return Effect.succeed(integration)
        const description = `No integration is installed as ${id}`
        return Effect.fail(
          new Connection.ConnectionError({
            integration: id,
            reason: new Connection.NotFoundError({ description })
          })
        )
      }
    })
  )
}

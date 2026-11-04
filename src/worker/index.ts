import { WorkflowEntrypoint, type WorkflowEvent } from 'cloudflare:workers'
import { sweepExpired } from './admin.js'
import { createGatewayHandler } from './gateway.js'
import { runDeployment, type Step } from './run.js'
import type { GatewayConfig, GatewayEnv } from './types.js'

export * from '../utils/session.js'
export { ENTRY_POINT } from './paymaster.js'
export type { GatewayConfig, GatewayEnv, PublicFunding } from './types.js'

/**
 * Create the funding gateway. Export `fetch` from your Worker, and `Workflow`
 * under the class name your `wrangler` config binds as `DEPLOY_WORKFLOW`.
 */
export const createGateway = <E extends GatewayEnv>(
  config: GatewayConfig<E>,
): {
  fetch: ReturnType<typeof createGatewayHandler<E>>
  scheduled: (controller: unknown, env: E) => Promise<void>
  Workflow: new (...args: never[]) => WorkflowEntrypoint<E, { id: string }>
} => ({
  fetch: createGatewayHandler(config),
  scheduled: async (_, env) => {
    await sweepExpired(env, config)
  },
  Workflow: class extends WorkflowEntrypoint<E, { id: string }> {
    run(event: WorkflowEvent<{ id: string }>, step: unknown) {
      return runDeployment({
        id: event.payload.id,
        env: this.env,
        step: step as Step,
        config,
      })
    }
  },
})

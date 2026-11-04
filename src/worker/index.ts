import { WorkflowEntrypoint, type WorkflowEvent } from 'cloudflare:workers'
import { runMaintenance } from './deployments.js'
import { createGatewayHandler } from './gateway.js'
import { runDeployment, type Step } from './run.js'
import type { GatewayConfig, GatewayEnv } from './types.js'

export {
  type Deployment,
  type DeploymentState,
  getDeployment,
  listAudit,
  listDeployments,
  removeDeployment,
  renewDeployment,
  type UnpinResult,
} from './deployments.js'
export type {
  DeployRequest,
  GatewayConfig,
  GatewayEnv,
  User,
} from './types.js'

/**
 * Add Omnipin to your Worker. Call `fetch` from your own handler, export
 * `Workflow` under the class name your `wrangler` config binds as
 * `DEPLOY_WORKFLOW`, and call `scheduled` from a Cron Trigger.
 */
export const createGateway = <E extends GatewayEnv>(
  config: GatewayConfig<E>,
): {
  fetch: ReturnType<typeof createGatewayHandler<E>>
  scheduled: (env: E) => Promise<void>
  Workflow: new (...args: never[]) => WorkflowEntrypoint<E, { id: string }>
} => ({
  fetch: createGatewayHandler(config),
  scheduled: async (env) => {
    await runMaintenance(env, config)
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

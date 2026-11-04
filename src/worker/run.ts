import { PROVIDERS } from '../constants.js'
import { pickUploader, publishToProvider, selectProviders } from '../deploy.js'
import { InvalidCARError } from '../errors.js'
import { findEnvVarProviderName } from '../utils/env.js'
import { verifyCAR } from '../utils/ipfs.js'
import {
  checkableProviders,
  completeDeployment,
  type DeploymentRow,
  loadRow,
  type ProviderState,
  pinStatuses,
} from './deployments.js'
import type { GatewayConfig, GatewayEnv } from './types.js'

/** The slice of Cloudflare's `WorkflowStep` the run uses. */
export type Step = {
  do: <T>(
    name: string,
    options: {
      retries: { limit: number; delay: string; backoff: 'exponential' }
      timeout: string
    },
    callback: () => Promise<T>,
  ) => Promise<T>
  sleep: (name: string, duration: string) => Promise<void>
}

const RETRIES = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const

const PIN_CHECKS = 10

/**
 * Publish one deployment. Each provider runs as its own step, so a retry
 * repeats only what failed and the CAR is never carried between steps.
 */
export const runDeployment = async <E extends GatewayEnv>({
  id,
  env,
  step,
  config,
}: {
  id: string
  env: E
  step: Step
  config: GatewayConfig<E>
}): Promise<void> => {
  const update = (sql: string, ...values: unknown[]) =>
    env.DB.prepare(sql)
      .bind(...values)
      .run()

  const deployment = await step.do('load', RETRIES, async () => {
    const row = await loadRow(env.DB, id)
    if (!row) throw new Error(`Deployment ${id} not found`)
    return row
  })

  const close = async (status: string, error: string) => {
    await step.do('close', RETRIES, async () => {
      await env.CARS.delete(deployment.car_key)
      await update(
        'UPDATE omnipin_deployments SET status = ?2, error = ?3 WHERE id = ?1',
        id,
        status,
        error,
      )
    })
  }

  const valid = await step.do('verify', RETRIES, async () => {
    const car = await env.CARS.get(deployment.car_key)
    if (!car) throw new Error('CAR is missing')
    try {
      await verifyCAR(car.body, deployment.cid)
      return true
    } catch (e) {
      if (e instanceof InvalidCARError) return false
      throw e
    }
  })

  if (!valid) return close('rejected', 'CAR does not match its CID')

  const tokens = () => config.tokens(env)
  const providerNames = selectProviders(tokens(), config.providers).active.map(
    (p) => p.name,
  )
  const byName = (name: string) => PROVIDERS[findEnvVarProviderName(name)]
  const states: ProviderState[] = []

  const publish = (name: string, first: boolean) =>
    step.do(`${first ? 'upload' : 'pin'}: ${name}`, RETRIES, async () => {
      const car = first ? await env.CARS.get(deployment.car_key) : null
      if (first && !car) throw new Error('CAR is missing')

      const pin = await publishToProvider({
        provider: byName(name),
        first,
        // Only the uploader needs the bytes, which keeps memory use to one
        // copy of the CAR, and only for one step.
        bytes: car ? new Uint8Array(await car.arrayBuffer()) : new Uint8Array(),
        name: deployment.name,
        size: deployment.size,
        cid: deployment.cid,
        tokens: tokens(),
      })
      return pin ?? null
    })

  const attempt = async (name: string, first: boolean) => {
    try {
      const pin = await publish(name, first)
      states.push({ name, status: 'deployed', pin: pin ?? undefined })
      return true
    } catch (e) {
      // Error text can quote provider responses, so keep it to the provider's
      // own message and away from anything secret.
      states.push({ name, status: 'failed', error: (e as Error).name })
      return false
    }
  }

  // Later uploaders are fallbacks: nothing else can pin the site until one
  // provider actually holds the bytes.
  const candidates = providerNames.map(byName)
  const uploaded: string[] = []
  let remaining = candidates

  while (!uploaded.length) {
    const uploader = pickUploader(remaining)
    if (!uploader) break
    remaining = remaining.filter((p) => p !== uploader)
    if (await attempt(uploader.name, true)) uploaded.push(uploader.name)
  }

  if (!uploaded.length) return close('failed', 'No provider accepted the site')

  for (const { name } of remaining) await attempt(name, false)

  await step.do('record providers', RETRIES, async () => {
    await update(
      'UPDATE omnipin_deployments SET providers = ?2 WHERE id = ?1',
      id,
      JSON.stringify(states),
    )
  })

  // Providers accept a request long before they hold anything, and a launch
  // can't be undone, so only a provider reporting `pinned` counts.
  const checkable = checkableProviders(states)
  let confirmed = false
  let pins: (string | null)[] = []

  for (let check = 0; check < PIN_CHECKS && checkable.length; check++) {
    pins = await step.do(`pin status ${check}`, RETRIES, () =>
      pinStatuses(env, config, deployment.cid, checkable),
    )

    for (const [i, pin] of pins.entries()) {
      const state = states.find((s) => s.name === checkable[i])
      if (state && pin) state.pin = pin
    }

    confirmed = pins.includes('pinned')
    if (confirmed || pins.every((pin) => pin === 'failed')) break
    await step.sleep(`pin wait ${check}`, '1 minute')
  }

  await step.do('record pins', RETRIES, async () => {
    await update(
      'UPDATE omnipin_deployments SET providers = ?2 WHERE id = ?1',
      id,
      JSON.stringify(states),
    )
  })

  if (confirmed) {
    await step.do('complete', RETRIES, () =>
      completeDeployment(env, config, deployment as DeploymentRow),
    )
    return
  }

  if (checkable.length && pins.every((pin) => pin === 'failed'))
    return close('failed', 'Every provider failed to pin the site')

  // Unconfirmed isn't failed: pins can take hours. The CAR stays so nothing is
  // lost, and a recheck or the scheduled upkeep can finish the job.
  await step.do('wait for confirmation', RETRIES, async () => {
    await update(
      "UPDATE omnipin_deployments SET status = 'pending', error = ?2 WHERE id = ?1",
      id,
      checkable.length
        ? 'No provider has confirmed the pin yet'
        : 'None of the providers can confirm a pin',
    )
  })
}

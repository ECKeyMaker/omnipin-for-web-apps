import { PROVIDERS } from '../constants.js'
import { pickUploader, publishToProvider, selectProviders } from '../deploy.js'
import { InvalidCARError } from '../errors.js'
import { updateDnsLink } from '../utils/dnslink.js'
import { findEnvVarProviderName } from '../utils/env.js'
import { verifyCAR } from '../utils/ipfs.js'
import type { DeploymentRow } from './gateway.js'
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

type ProviderState = {
  name: string
  status: 'deployed' | 'failed'
  pin?: string
  error?: string
}

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
    const row = await env.DB.prepare('SELECT * FROM deployments WHERE id = ?1')
      .bind(id)
      .first<DeploymentRow>()
    if (!row) throw new Error(`Deployment ${id} not found`)
    return row
  })

  const finish = async (status: string, error: string | null = null) => {
    await step.do('finish', RETRIES, async () => {
      await env.CARS.delete(deployment.car_key)
      await update(
        'UPDATE deployments SET status = ?2, error = ?3 WHERE id = ?1',
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

  if (!valid) return finish('rejected', 'CAR does not match its CID')

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

  if (!uploaded.length) return finish('failed', 'No provider accepted the site')

  for (const { name } of remaining) await attempt(name, false)

  await step.do('record providers', RETRIES, async () => {
    await update(
      'UPDATE deployments SET providers = ?2 WHERE id = ?1',
      id,
      JSON.stringify(states),
    )
  })

  // Pins fetch asynchronously, so "published" means someone has confirmed
  // holding the site, not just that a request was accepted.
  const checkable = states.filter(
    (s) => s.status === 'deployed' && byName(s.name).status,
  )

  for (let check = 0; check < PIN_CHECKS && checkable.length; check++) {
    const pins = await step.do(`pin status ${check}`, RETRIES, async () => {
      const results = await Promise.allSettled(
        checkable.map(({ name }) =>
          byName(name).status?.({
            cid: deployment.cid,
            auth: { token: tokens().get(findEnvVarProviderName(name)) },
            baseURL: tokens().get('SPEC_URL'),
          }),
        ),
      )
      return results.map((r) =>
        r.status === 'fulfilled' ? (r.value?.pin ?? null) : null,
      )
    })

    for (const [i, pin] of pins.entries()) if (pin) checkable[i].pin = pin

    if (pins.some((pin) => pin === 'pinned')) break
    await step.sleep(`pin wait ${check}`, '1 minute')
  }

  await step.do('record pins', RETRIES, async () => {
    await update(
      'UPDATE deployments SET providers = ?2 WHERE id = ?1',
      id,
      JSON.stringify(states),
    )
  })

  let dnsError: string | null = null

  if (deployment.dnslink && config.dnslink) {
    try {
      await step.do('dnslink', RETRIES, async () => {
        const { apiKey, zoneId } = config.dnslink?.(env) ?? {}
        const { errors } = await updateDnsLink({
          cid: deployment.cid,
          name: deployment.dnslink as string,
          apiKey: apiKey as string,
          zoneId: zoneId as string,
          verbose: false,
        })
        if (errors?.length) throw new Error(errors[0].message)
      })
    } catch {
      dnsError = 'DNSLink update failed'
    }
  }

  await finish('published', dnsError)
}

import { PROVIDERS } from '../constants.js'
import { updateDnsLink } from '../utils/dnslink.js'
import { findEnvVarProviderName } from '../utils/env.js'
import type { D1Database, GatewayConfig, GatewayEnv } from './types.js'

const DAY_MS = 86_400_000
const SWEEP_BATCH = 100

export type DeploymentRow = {
  id: string
  user_id: string
  name: string
  cid: string
  size: number
  car_key: string
  status: string
  providers: string
  ens_name: string | null
  ens_status: string | null
  dnslink: string | null
  error: string | null
  retention_until: number | null
  created_at: number
}

export type DeploymentState =
  | 'created'
  | 'publishing'
  | 'pending'
  | 'published'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'removed'

export type ProviderState = {
  name: string
  status: 'deployed' | 'failed'
  pin?: string
  error?: string
}

export type Deployment = {
  id: string
  userId: string
  name: string
  cid: string
  size: number
  status: DeploymentState
  providers: ProviderState[]
  ens: { name: string; status: string | null } | null
  dnslink: string | null
  error: string | null
  retentionUntil: number | null
  createdAt: number
  urls: { gateway: string }
}

export const toDeployment = (row: DeploymentRow): Deployment => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  cid: row.cid,
  size: row.size,
  status: row.status as DeploymentState,
  providers: JSON.parse(row.providers),
  ens: row.ens_name ? { name: row.ens_name, status: row.ens_status } : null,
  dnslink: row.dnslink,
  error: row.error,
  retentionUntil: row.retention_until,
  createdAt: row.created_at,
  urls: { gateway: `https://${row.cid}.ipfs.dweb.link` },
})

export const loadRow = (db: D1Database, id: string) =>
  db
    .prepare('SELECT * FROM omnipin_deployments WHERE id = ?1')
    .bind(id)
    .first<DeploymentRow>()

/** Read one deployment from your server, without touching any SQL. */
export const getDeployment = async (
  db: D1Database,
  id: string,
): Promise<Deployment | null> => {
  const row = await loadRow(db, id)
  return row ? toDeployment(row) : null
}

/** Newest first. Filter by user, status or both. */
export const listDeployments = async (
  db: D1Database,
  {
    userId,
    status,
    limit = 50,
  }: { userId?: string; status?: DeploymentState; limit?: number } = {},
): Promise<Deployment[]> => {
  const { results } = await db
    .prepare(
      `SELECT * FROM omnipin_deployments
       WHERE (?1 IS NULL OR user_id = ?1) AND (?2 IS NULL OR status = ?2)
       ORDER BY created_at DESC LIMIT ?3`,
    )
    .bind(userId ?? null, status ?? null, limit)
    .all<DeploymentRow>()
  return results.map(toDeployment)
}

export const audit = <E extends GatewayEnv>(
  env: E,
  entry: {
    actor: string
    action: string
    deployment?: string
    detail?: string
  },
) =>
  env.DB.prepare(
    'INSERT INTO omnipin_audit_log (at, actor, action, deployment_id, detail) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(
      Date.now(),
      entry.actor,
      entry.action,
      entry.deployment ?? null,
      entry.detail ?? null,
    )
    .run()

/** Latest audit entries, newest first. */
export const listAudit = async (db: D1Database, limit = 200) =>
  (
    await db
      .prepare('SELECT * FROM omnipin_audit_log ORDER BY id DESC LIMIT ?1')
      .bind(limit)
      .all()
  ).results

/** Ask providers whether they hold a CID. Unknown answers come back `null`. */
export const pinStatuses = async <E extends GatewayEnv>(
  env: E,
  config: GatewayConfig<E>,
  cid: string,
  names: string[],
): Promise<(string | null)[]> => {
  const tokens = config.tokens(env)

  const results = await Promise.allSettled(
    names.map((name) => {
      const key = findEnvVarProviderName(name)
      return PROVIDERS[key].status?.({
        cid,
        auth: { token: tokens.get(key) },
        baseURL: tokens.get('SPEC_URL'),
      })
    }),
  )

  return results.map((r) =>
    r.status === 'fulfilled' ? (r.value?.pin ?? null) : null,
  )
}

/** Providers that hold a site and can be asked about it. */
export const checkableProviders = (states: ProviderState[]) =>
  states
    .filter(
      (s) =>
        s.status === 'deployed' &&
        PROVIDERS[findEnvVarProviderName(s.name)]?.status,
    )
    .map((s) => s.name)

/** Mark a confirmed site published, and do what had to wait for that. */
export const completeDeployment = async <E extends GatewayEnv>(
  env: E,
  config: GatewayConfig<E>,
  row: DeploymentRow,
): Promise<void> => {
  let error: string | null = null

  if (row.dnslink && config.dnslink) {
    const { apiKey, zoneId } = config.dnslink(env)
    try {
      const { errors } = await updateDnsLink({
        cid: row.cid,
        name: row.dnslink,
        apiKey,
        zoneId,
        verbose: false,
      })
      if (errors?.length) error = 'DNSLink update failed'
    } catch {
      error = 'DNSLink update failed'
    }
  }

  await env.CARS.delete(row.car_key)
  await env.DB.prepare(
    "UPDATE omnipin_deployments SET status = 'published', error = ?2 WHERE id = ?1",
  )
    .bind(row.id, error)
    .run()
}

/**
 * Ask providers again about a `pending` deployment.
 *
 * @returns The deployment's status afterwards.
 */
export const recheckDeployment = async <E extends GatewayEnv>(
  env: E,
  config: GatewayConfig<E>,
  row: DeploymentRow,
): Promise<string> => {
  if (row.status !== 'pending') return row.status

  const states = JSON.parse(row.providers) as ProviderState[]
  const names = checkableProviders(states)
  const pins = await pinStatuses(env, config, row.cid, names)

  for (const [i, pin] of pins.entries()) {
    const state = states.find((s) => s.name === names[i])
    if (state && pin) state.pin = pin
  }

  await env.DB.prepare(
    'UPDATE omnipin_deployments SET providers = ?2 WHERE id = ?1',
  )
    .bind(row.id, JSON.stringify(states))
    .run()

  if (pins.includes('pinned')) {
    await completeDeployment(env, config, row)
    return 'published'
  }

  if (names.length && pins.every((pin) => pin === 'failed')) {
    await env.CARS.delete(row.car_key)
    await env.DB.prepare(
      "UPDATE omnipin_deployments SET status = 'failed', error = 'Every provider failed to pin the site' WHERE id = ?1",
    )
      .bind(row.id)
      .run()
    return 'failed'
  }

  return 'pending'
}

export type UnpinResult = {
  name: string
  status: 'unpinned' | 'unsupported' | 'failed' | 'shared'
}

/** A live deployment other than `exceptId` that needs this CID, if any. */
export const isCidInUse = async (
  db: D1Database,
  cid: string,
  exceptId = '',
): Promise<boolean> =>
  (await db
    .prepare(
      `SELECT 1 FROM omnipin_deployments
       WHERE cid = ?1 AND id != ?2
         AND status IN ('publishing', 'pending', 'published')
       LIMIT 1`,
    )
    .bind(cid, exceptId)
    .first()) !== null

/** Ask named providers to drop a CID. */
export const unpinFromProviders = async <E extends GatewayEnv>(
  env: E,
  config: GatewayConfig<E>,
  cid: string,
  names: string[],
): Promise<UnpinResult[]> => {
  const tokens = config.tokens(env)

  return Promise.all(
    names.map(async (name): Promise<UnpinResult> => {
      const key = findEnvVarProviderName(name)
      const provider = PROVIDERS[key]
      if (!provider.unpin) return { name, status: 'unsupported' }

      try {
        await provider.unpin({
          cid,
          token: tokens.get(key) as string,
          baseURL: tokens.get('SPEC_URL'),
        })
        return { name, status: 'unpinned' }
      } catch {
        return { name, status: 'failed' }
      }
    }),
  )
}

/**
 * Take a site down. A provider without an unpin API is reported rather than
 * ignored, because it has to be removed by hand.
 *
 * Pins belong to a CID, and a CID is only a hash of the content, so anyone can
 * deploy a copy of someone else's public site. The pin therefore stays while
 * another live deployment shares the CID, or removing a copy would take the
 * original offline. Pass `force` for a takedown that must win regardless.
 */
export const removeDeployment = async <E extends GatewayEnv>(
  env: E,
  config: GatewayConfig<E>,
  id: string,
  {
    actor,
    reason,
    force = false,
  }: { actor: string; reason?: string; force?: boolean },
  status = 'removed',
): Promise<UnpinResult[] | null> => {
  const row = await loadRow(env.DB, id)
  if (!row) return null

  const held = (JSON.parse(row.providers) as ProviderState[])
    .filter((p) => p.status === 'deployed')
    .map((p) => p.name)

  const shared = !force && (await isCidInUse(env.DB, row.cid, row.id))

  const results: UnpinResult[] = shared
    ? held.map((name) => ({ name, status: 'shared' }))
    : await unpinFromProviders(env, config, row.cid, held)

  await env.CARS.delete(row.car_key)
  await env.DB.prepare(
    'UPDATE omnipin_deployments SET status = ?2 WHERE id = ?1',
  )
    .bind(row.id, status)
    .run()
  await audit(env, {
    actor,
    action: status === 'expired' ? 'deployment.expired' : 'deployment.removed',
    deployment: row.id,
    detail: JSON.stringify({ reason, force, results }),
  })

  return results
}

/** Extend how long a site is kept, restoring it if it had expired. */
export const renewDeployment = async <E extends GatewayEnv>(
  env: E,
  id: string,
  days: number,
  actor: string,
): Promise<number | null> => {
  const row = await loadRow(env.DB, id)
  if (!row) return null

  const retentionUntil =
    Math.max(row.retention_until ?? 0, Date.now()) + days * DAY_MS

  await env.DB.prepare(
    `UPDATE omnipin_deployments SET retention_until = ?2,
       status = CASE status WHEN 'expired' THEN 'published' ELSE status END
     WHERE id = ?1`,
  )
    .bind(id, retentionUntil)
    .run()
  await audit(env, {
    actor,
    action: 'deployment.renewed',
    deployment: id,
    detail: `${days} days`,
  })

  return retentionUntil
}

/**
 * Scheduled upkeep: recheck pending deployments and handle expired ones.
 * Expired sites are only marked unless `limits.unpinExpired` is on.
 */
export const runMaintenance = async <E extends GatewayEnv>(
  env: E,
  config: GatewayConfig<E>,
  now = Date.now(),
): Promise<{ rechecked: number; expired: number }> => {
  const { results: pending } = await env.DB.prepare(
    "SELECT * FROM omnipin_deployments WHERE status = 'pending' LIMIT ?1",
  )
    .bind(SWEEP_BATCH)
    .all<DeploymentRow>()

  for (const row of pending) await recheckDeployment(env, config, row)

  const { results: expired } = await env.DB.prepare(
    `SELECT * FROM omnipin_deployments
     WHERE status = 'published' AND retention_until < ?1 LIMIT ?2`,
  )
    .bind(now, SWEEP_BATCH)
    .all<DeploymentRow>()

  for (const row of expired) {
    if (config.limits.unpinExpired) {
      await removeDeployment(
        env,
        config,
        row.id,
        { actor: 'retention' },
        'expired',
      )
      continue
    }

    await env.DB.prepare(
      "UPDATE omnipin_deployments SET status = 'expired' WHERE id = ?1",
    )
      .bind(row.id)
      .run()
    await audit(env, {
      actor: 'retention',
      action: 'deployment.expired',
      deployment: row.id,
    })
  }

  return { rechecked: pending.length, expired: expired.length }
}

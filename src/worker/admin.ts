import { PROVIDERS } from '../constants.js'
import { findEnvVarProviderName } from '../utils/env.js'
import { deriveAppSecret } from '../utils/session.js'
import type { App, DeploymentRow } from './gateway.js'
import type { GatewayConfig, GatewayEnv } from './types.js'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const DAY_MS = 86_400_000
const SWEEP_BATCH = 100
const APP_ID = /^[a-z0-9-]{1,64}$/
const textEncoder = new TextEncoder()

export const audit = <E extends GatewayEnv>(
  env: E,
  entry: {
    actor: string
    app?: string | null
    action: string
    deployment?: string
    detail?: string
  },
) =>
  env.DB.prepare(
    'INSERT INTO audit_log (at, actor, app_id, action, deployment_id, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  )
    .bind(
      Date.now(),
      entry.actor,
      entry.app ?? null,
      entry.action,
      entry.deployment ?? null,
      entry.detail ?? null,
    )
    .run()

type UnpinResult = {
  name: string
  status: 'unpinned' | 'unsupported' | 'failed' | 'shared'
}

/**
 * Ask every provider holding a site to drop it. A provider without an unpin
 * API is reported rather than ignored: the operator has to remove it by hand.
 *
 * Pins belong to a CID, and a CID is only a hash of the content, so anyone can
 * deploy a copy of someone else's public site. The pin therefore stays while
 * another live deployment shares the CID, or removing a copy would take the
 * original offline. Only an operator takedown may `force` it.
 */
export const unpinDeployment = async <E extends GatewayEnv>(
  env: E,
  config: GatewayConfig<E>,
  deployment: DeploymentRow,
  {
    actor,
    action,
    force = false,
  }: { actor: string; action: string; force?: boolean },
  status = 'removed',
): Promise<UnpinResult[]> => {
  const tokens = config.tokens(env)
  const held = (
    JSON.parse(deployment.providers) as { name: string; status: string }[]
  ).filter((p) => p.status === 'deployed')

  const shared =
    !force &&
    (await env.DB.prepare(
      `SELECT 1 FROM deployments
       WHERE cid = ?1 AND id != ?2 AND status IN ('publishing', 'published')
       LIMIT 1`,
    )
      .bind(deployment.cid, deployment.id)
      .first()) !== null

  const results = await Promise.all(
    held.map(async ({ name }): Promise<UnpinResult> => {
      if (shared) return { name, status: 'shared' }

      const key = findEnvVarProviderName(name)
      const provider = PROVIDERS[key]
      if (!provider.unpin) return { name, status: 'unsupported' }

      try {
        await provider.unpin({
          cid: deployment.cid,
          token: tokens.get(key) as string,
          baseURL: tokens.get('SPEC_URL'),
        })
        return { name, status: 'unpinned' }
      } catch {
        return { name, status: 'failed' }
      }
    }),
  )

  await env.DB.prepare('UPDATE deployments SET status = ?2 WHERE id = ?1')
    .bind(deployment.id, status)
    .run()
  await audit(env, {
    actor,
    app: deployment.app_id,
    action,
    deployment: deployment.id,
    detail: JSON.stringify(results),
  })

  return results
}

/**
 * Handle sites past their retention. They're marked `expired`, and only
 * unpinned if `limits.unpinExpired` is on. Runs from a Cron Trigger.
 *
 * @returns How many sites were handled.
 */
export const sweepExpired = async <E extends GatewayEnv>(
  env: E,
  config: GatewayConfig<E>,
  now = Date.now(),
): Promise<number> => {
  const { results } = await env.DB.prepare(
    `SELECT * FROM deployments
     WHERE status = 'published' AND retention_until < ?1 LIMIT ?2`,
  )
    .bind(now, SWEEP_BATCH)
    .all<DeploymentRow>()

  for (const deployment of results) {
    if (config.limits.unpinExpired) {
      await unpinDeployment(
        env,
        config,
        deployment,
        { actor: 'retention', action: 'deployment.expired' },
        'expired',
      )
      continue
    }

    await env.DB.prepare(
      "UPDATE deployments SET status = 'expired' WHERE id = ?1",
    )
      .bind(deployment.id)
      .run()
    await audit(env, {
      actor: 'retention',
      app: deployment.app_id,
      action: 'deployment.expired',
      deployment: deployment.id,
    })
  }

  return results.length
}

/**
 * Compare under HMAC with `crypto.subtle.verify`, which runs in constant time,
 * so response timing can't reveal the secret.
 */
const isAdmin = async (request: Request, secret: string) => {
  const presented =
    request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const expected = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(secret),
  )
  return crypto.subtle.verify(
    'HMAC',
    key,
    expected,
    textEncoder.encode(presented),
  )
}

const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'Expected a JSON object')
  return body as Record<string, unknown>
}

const positiveInt = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new HttpError(400, `${name} must be a positive integer`)
  return value as number
}

/**
 * Operator API, switched off unless `adminSecret` is set. It answers 404 until
 * then, so its existence isn't advertised.
 */
export const adminRoutes = async <E extends GatewayEnv>(
  request: Request,
  env: E,
  path: string,
  config: GatewayConfig<E>,
): Promise<Response> => {
  const secret = config.adminSecret?.(env)
  if (!secret) throw new HttpError(404, 'Not found')
  if (!(await isAdmin(request, secret)))
    throw new HttpError(401, 'Invalid admin credentials')

  const [, resource, id, action] = path.split('/').filter(Boolean)
  const { method } = request

  const load = async () => {
    const deployment = await env.DB.prepare(
      'SELECT * FROM deployments WHERE id = ?1',
    )
      .bind(id)
      .first<DeploymentRow>()
    if (!deployment) throw new HttpError(404, 'Deployment not found')
    return deployment
  }

  const secretFor = (appId: string, version: number) =>
    deriveAppSecret(config.masterSecret(env), appId, version)

  if (resource === 'apps' && method === 'POST' && !id) {
    const body = await readBody(request)
    const { id: appId, name, origins } = body

    if (typeof appId !== 'string' || !APP_ID.test(appId))
      throw new HttpError(400, 'Invalid app id')
    if (typeof name !== 'string' || !name)
      throw new HttpError(400, 'Invalid name')
    if (
      !Array.isArray(origins) ||
      !origins.length ||
      !origins.every((o) => {
        try {
          return new URL(o).origin === o
        } catch {
          return false
        }
      })
    )
      throw new HttpError(400, 'origins must be a list of origins')

    const { meta } = await env.DB.prepare(
      `INSERT OR IGNORE INTO connected_apps
         (id, name, origins, daily_bytes, user_daily_deploys, daily_sponsorships)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        appId,
        name,
        JSON.stringify(origins),
        positiveInt(body.dailyBytes, 'dailyBytes'),
        positiveInt(body.userDailyDeploys, 'userDailyDeploys'),
        positiveInt(body.dailySponsorships, 'dailySponsorships'),
      )
      .run()
    if (!meta.changes) throw new HttpError(409, 'App already exists')

    await audit(env, { actor: 'admin', app: appId, action: 'app.created' })
    return json({ id: appId, secret: await secretFor(appId, 1) }, 201)
  }

  if (resource === 'apps' && id && method === 'POST') {
    const app = await env.DB.prepare(
      'SELECT * FROM connected_apps WHERE id = ?1',
    )
      .bind(id)
      .first<App>()
    if (!app) throw new HttpError(404, 'App not found')

    if (action === 'rotate') {
      const version = app.secret_version + 1
      await env.DB.prepare(
        'UPDATE connected_apps SET secret_version = ?2 WHERE id = ?1',
      )
        .bind(id, version)
        .run()
      await audit(env, { actor: 'admin', app: id, action: 'app.rotated' })
      return json({ id, secret: await secretFor(id, version) })
    }

    if (action === 'suspend' || action === 'resume') {
      await env.DB.prepare(
        'UPDATE connected_apps SET active = ?2 WHERE id = ?1',
      )
        .bind(id, action === 'resume' ? 1 : 0)
        .run()
      await audit(env, { actor: 'admin', app: id, action: `app.${action}` })
      return json({ id, active: action === 'resume' })
    }
  }

  if (resource === 'deployments' && id && method === 'POST') {
    if (action === 'remove') {
      const deployment = await load()
      const { reason } = await readBody(request)
      if (typeof reason !== 'string' || !reason)
        throw new HttpError(400, 'A reason is required')

      const results = await unpinDeployment(env, config, deployment, {
        actor: 'admin',
        action: `deployment.taken_down: ${reason}`,
        force: true,
      })
      return json({ id, status: 'removed', providers: results })
    }

    if (action === 'renew') {
      const deployment = await load()
      const days = positiveInt((await readBody(request)).days, 'days')
      const base = Math.max(deployment.retention_until, Date.now())
      const retentionUntil = base + days * DAY_MS

      await env.DB.prepare(
        `UPDATE deployments SET retention_until = ?2,
           status = CASE status WHEN 'expired' THEN 'published' ELSE status END
         WHERE id = ?1`,
      )
        .bind(id, retentionUntil)
        .run()
      await audit(env, {
        actor: 'admin',
        app: deployment.app_id,
        action: 'deployment.renewed',
        deployment: id,
        detail: `${days} days`,
      })
      return json({ id, retentionUntil })
    }
  }

  if (resource === 'audit' && method === 'GET' && !id) {
    const { results } = await env.DB.prepare(
      'SELECT * FROM audit_log ORDER BY id DESC LIMIT 200',
    ).all()
    return json({ entries: results })
  }

  throw new HttpError(404, 'Not found')
}

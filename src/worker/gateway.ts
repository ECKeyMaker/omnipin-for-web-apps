import { CID } from 'multiformats/cid'
import * as Provider from 'ox/Provider'
import { fromHttp } from 'ox/RpcTransport'
import { prepareEnsUpdate, readContenthash, simulateEnsUpdate } from '../ens.js'
import { getEnsResolver } from '../utils/ens/get-resolver.js'
import { presignPut } from '../utils/s3.js'
import {
  createSessionToken,
  deriveAppSecret,
  type Session,
  verifySessionToken,
} from '../utils/session.js'
import {
  adminRoutes,
  audit,
  HttpError,
  json,
  unpinDeployment,
} from './admin.js'
import {
  approveOperation,
  ENTRY_POINT,
  maxCost,
  paymasterStub,
  type UserOperation,
} from './paymaster.js'
import type { GatewayConfig, GatewayEnv } from './types.js'

const CAR_TYPE = 'application/vnd.ipld.car'
const DAY_MS = 86_400_000
const UPLOAD_URL_LIFETIME = 900
const SPONSOR_TOKEN_LIFETIME = 600

export type App = {
  id: string
  origins: string
  daily_bytes: number
  user_daily_deploys: number
  daily_sponsorships: number
  active: number
  secret_version: number
}

export type DeploymentRow = {
  id: string
  app_id: string
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
  retention_until: number
  sponsor_attempts: number
  created_at: number
}

const NAME = /^[\w.-]{1,64}$/
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i
const ENS_NAME = /^(?=.{3,253}$)([^\s.]{1,63}\.)+eth$/i

const isCIDv1 = (cid: unknown): cid is string => {
  try {
    return typeof cid === 'string' && CID.parse(cid).version === 1
  } catch {
    return false
  }
}

const publicView = (d: DeploymentRow) => ({
  id: d.id,
  name: d.name,
  cid: d.cid,
  size: d.size,
  status: d.status,
  providers: JSON.parse(d.providers),
  ens: d.ens_name ? { name: d.ens_name, status: d.ens_status } : null,
  dnslink: d.dnslink,
  error: d.error,
  retentionUntil: d.retention_until,
  urls: { gateway: `https://${d.cid}.ipfs.dweb.link` },
})

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'Expected a JSON object')
  return body as Record<string, unknown>
}

export const createGatewayHandler = <E extends GatewayEnv>(
  config: GatewayConfig<E>,
) => {
  // A session for an unknown app must still fail normally, so this derives a
  // secret regardless rather than throwing.
  const secretFor = (env: E) => async (appId: string) =>
    deriveAppSecret(
      config.masterSecret(env),
      appId,
      (await loadApp(env, appId))?.secret_version ?? 1,
    )

  const authenticate = async (request: Request, env: E): Promise<Session> => {
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '')
    const session = token
      ? await verifySessionToken(token, secretFor(env))
      : undefined

    // A scoped token exists to be handed to a wallet, so it must not work as
    // a full session.
    if (!session || session.scope) throw new HttpError(401, 'Invalid session')
    await rateLimit(env, `${session.app}:${session.sub}`)
    return session
  }

  const rateLimit = async (env: E, key: string) => {
    if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key })).success)
      throw new HttpError(429, 'Too many requests')
  }

  const loadApp = (env: E, id: string) =>
    env.DB.prepare('SELECT * FROM connected_apps WHERE id = ?1')
      .bind(id)
      .first<App>()

  const loadOwn = async (env: E, id: string, session: Session) => {
    const row = await env.DB.prepare(
      'SELECT * FROM deployments WHERE id = ?1 AND app_id = ?2 AND user_id = ?3',
    )
      .bind(id, session.app, session.sub)
      .first<DeploymentRow>()
    // Same answer for "missing" and "someone else's", so ids can't be probed.
    if (!row) throw new HttpError(404, 'Deployment not found')
    return row
  }

  const provider = (env: E) => Provider.from(fromHttp(config.rpcUrl(env)))

  const create = async (request: Request, env: E, session: Session) => {
    const app = await loadApp(env, session.app)
    if (!app?.active) throw new HttpError(403, 'App is not active')

    const { name, cid, size, ens, dnslink } = await readJson(request)

    if (typeof name !== 'string' || !NAME.test(name))
      throw new HttpError(400, 'Invalid name')
    if (!isCIDv1(cid)) throw new HttpError(400, 'cid must be a CIDv1')
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > config.limits.maxCarBytes
    )
      throw new HttpError(413, 'Size is outside the allowed range')
    if (ens !== undefined && (typeof ens !== 'string' || !ENS_NAME.test(ens)))
      throw new HttpError(400, 'Invalid ENS name')
    if (dnslink !== undefined) {
      if (typeof dnslink !== 'string' || !HOSTNAME.test(dnslink))
        throw new HttpError(400, 'Invalid DNSLink hostname')
      if (!(await config.authorizeDnsLink?.(session, dnslink, env)))
        throw new HttpError(403, 'Not allowed to update this hostname')
    }

    const id = crypto.randomUUID()
    const now = Date.now()
    const dayStart = now - DAY_MS
    const carKey = `${session.app}/${id}.car`
    const retentionUntil = now + config.limits.retentionDays * DAY_MS

    // One statement, so concurrent requests can't both pass the quota check.
    // Rejected deployments are free: they never reach a provider.
    const { meta } = await env.DB.prepare(
      `INSERT INTO deployments
         (id, app_id, user_id, name, cid, size, car_key, status, ens_name, dnslink, retention_until, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'created', ?8, ?9, ?10, ?11
       WHERE (SELECT COALESCE(SUM(size), 0) FROM deployments
              WHERE app_id = ?2 AND created_at >= ?12 AND status != 'rejected') + ?6 <= ?13
         AND (SELECT COUNT(*) FROM deployments
              WHERE app_id = ?2 AND user_id = ?3 AND created_at >= ?12 AND status != 'rejected') < ?14
         AND (SELECT COALESCE(SUM(size), 0) FROM deployments
              WHERE created_at >= ?12 AND status != 'rejected') + ?6 <= ?15`,
    )
      .bind(
        id,
        session.app,
        session.sub,
        name,
        cid,
        size,
        carKey,
        ens ?? null,
        dnslink ?? null,
        retentionUntil,
        now,
        dayStart,
        app.daily_bytes,
        app.user_daily_deploys,
        config.limits.globalDailyBytes,
      )
      .run()

    if (!meta.changes) throw new HttpError(429, 'Daily quota reached')

    await audit(env, {
      actor: session.sub,
      app: session.app,
      action: 'deployment.created',
      deployment: id,
      detail: `${size} bytes`,
    })

    const r2 = config.r2(env)
    const uploadUrl = await presignPut({
      apiUrl: `${r2.accountId}.r2.cloudflarestorage.com`,
      bucketName: r2.bucketName,
      filename: carKey,
      token: btoa(`${r2.accessKeyId}:${r2.secretAccessKey}`),
      region: 'auto',
      expiresIn: UPLOAD_URL_LIFETIME,
      contentType: CAR_TYPE,
    })

    return json({ id, uploadUrl, contentType: CAR_TYPE }, 201)
  }

  const start = async (env: E, id: string, session: Session) => {
    const deployment = await loadOwn(env, id, session)
    if (deployment.status !== 'created')
      throw new HttpError(409, `Deployment is ${deployment.status}`)

    // A presigned URL can't limit size, so the object is checked here.
    const object = await env.CARS.head(deployment.car_key)
    if (!object) throw new HttpError(409, 'CAR has not been uploaded')

    if (object.size !== deployment.size) {
      await env.CARS.delete(deployment.car_key)
      await env.DB.prepare(
        "UPDATE deployments SET status = 'rejected', error = ?2 WHERE id = ?1",
      )
        .bind(id, 'Uploaded size does not match the declared size')
        .run()
      throw new HttpError(422, 'Uploaded size does not match the declared size')
    }

    // Conditional, so a double submit can't start two workflows.
    const { meta } = await env.DB.prepare(
      "UPDATE deployments SET status = 'publishing' WHERE id = ?1 AND status = 'created'",
    )
      .bind(id)
      .run()
    if (!meta.changes) throw new HttpError(409, 'Deployment already started')

    await audit(env, {
      actor: session.sub,
      app: session.app,
      action: 'deployment.started',
      deployment: id,
    })

    await env.DEPLOY_WORKFLOW.create({ id, params: { id } })
    return json({ id, status: 'publishing' }, 202)
  }

  const prepareUpdate = (env: E, deployment: DeploymentRow) => {
    if (deployment.status !== 'published')
      throw new HttpError(409, 'Deployment is not published yet')
    if (!deployment.ens_name)
      throw new HttpError(409, 'Deployment has no ENS name')

    return prepareEnsUpdate({
      provider: provider(env),
      domain: deployment.ens_name,
      cid: deployment.cid,
    })
  }

  const sponsorship = async (
    request: Request,
    env: E,
    id: string,
    session: Session,
  ) => {
    const deployment = await loadOwn(env, id, session)
    const { to, data } = await prepareUpdate(env, deployment)
    const call = { to, data }

    const { chainId } = config

    if (!config.funding) return json({ call, chainId, sponsored: false })

    const token = await createSessionToken({
      appId: session.app,
      userId: session.sub,
      secret: await secretFor(env)(session.app),
      expiresIn: SPONSOR_TOKEN_LIFETIME,
      scope: `sponsor:${id}`,
    })
    const url = new URL(request.url)
    url.pathname = `${config.basePath}/${id}/paymaster`
    url.search = new URLSearchParams({ token }).toString()

    return json({
      call,
      sponsored: true,
      chainId,
      paymasterUrl: url.toString(),
    })
  }

  /**
   * ERC-7677 endpoint. Wallets call this from their own backend, so it can't
   * use a normal session: the URL carries a token limited to one deployment.
   */
  const paymaster = async (request: Request, env: E, id: string) => {
    const rpc = await readJson(request)
    const reply = (result: unknown) =>
      json({ jsonrpc: '2.0', id: rpc.id ?? null, result })
    const fail = (message: string, code = -32602) =>
      json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code, message } })

    const token = new URL(request.url).searchParams.get('token') ?? ''
    const session = await verifySessionToken(token, secretFor(env))
    if (session?.scope !== `sponsor:${id}`)
      throw new HttpError(401, 'Invalid sponsorship token')

    await rateLimit(env, `sponsor:${id}`)

    const funding = config.funding?.(env)
    if (!funding) return fail('Sponsorship is disabled')

    const [op, entryPoint, chainId] = (rpc.params ?? []) as [
      UserOperation,
      string,
      string,
    ]

    if (entryPoint?.toLowerCase() !== ENTRY_POINT.toLowerCase())
      return fail('Unsupported EntryPoint')
    if (Number(chainId) !== config.chainId) return fail('Unsupported chain')
    if (rpc.method === 'pm_getPaymasterStubData')
      return reply(paymasterStub(funding.paymaster))
    if (rpc.method !== 'pm_getPaymasterData')
      return fail('Method not found', -32601)

    if (maxCost(op) > funding.maxCostPerOp)
      return fail('Operation exceeds the sponsorship cost cap')

    const deployment = await env.DB.prepare(
      'SELECT * FROM deployments WHERE id = ?1 AND app_id = ?2 AND user_id = ?3',
    )
      .bind(id, session.app, session.sub)
      .first<DeploymentRow>()
    if (!deployment) throw new HttpError(404, 'Deployment not found')

    const update = await prepareUpdate(env, deployment)

    // Wallets encode batches differently, so this can't decode `callData`.
    // It requires the deployment's exact update; anything else is bounded by
    // the cost cap, and by the attempt limit below.
    if (!op.callData.toLowerCase().includes(update.data.slice(2).toLowerCase()))
      return fail('Operation is not this deployment’s ENS update')

    // Don't pay for an operation that can only revert, such as one from an
    // account without permission on the name.
    await simulateEnsUpdate(provider(env), update, op.sender).catch(() => {
      throw new HttpError(403, 'This account cannot update that ENS name')
    })

    const { meta } = await env.DB.prepare(
      'UPDATE deployments SET sponsor_attempts = sponsor_attempts + 1 WHERE id = ?1 AND sponsor_attempts < ?2',
    )
      .bind(id, config.limits.sponsorAttempts ?? 3)
      .run()
    if (!meta.changes) return fail('Sponsorship attempts used up')

    const app = await loadApp(env, session.app)
    if (!app?.active) return fail('App is not active')

    const dayStart = Date.now() - DAY_MS

    // One statement, so a burst can't overrun the daily gas budget.
    const { meta: budget } = await env.DB.prepare(
      `INSERT INTO sponsorships (deployment_id, app_id, created_at)
       SELECT ?1, ?2, ?3
       WHERE (SELECT COUNT(*) FROM sponsorships
              WHERE app_id = ?2 AND created_at >= ?4) < ?5
         AND (SELECT COUNT(*) FROM sponsorships WHERE created_at >= ?4) < ?6`,
    )
      .bind(
        id,
        session.app,
        Date.now(),
        dayStart,
        app.daily_sponsorships,
        config.limits.dailySponsorships ?? 1000,
      )
      .run()
    if (!budget.changes) return fail('Daily sponsorship budget reached')

    await audit(env, {
      actor: session.sub,
      app: session.app,
      action: 'sponsorship.approved',
      deployment: id,
      detail: op.sender,
    })

    return reply(
      approveOperation({
        op,
        paymaster: funding.paymaster,
        chainId: config.chainId,
        signerKey: funding.signerKey,
        lifetime: funding.approvalLifetime ?? 300,
        now: Date.now(),
      }),
    )
  }

  /** Trust the chain, not the client: read the name back after any update. */
  const verifyEns = async (env: E, id: string, session: Session) => {
    const deployment = await loadOwn(env, id, session)
    const update = await prepareUpdate(env, deployment)
    const client = provider(env)

    const stored = await readContenthash({
      provider: client,
      resolver: await getEnsResolver({
        provider: client,
        name: deployment.ens_name as string,
      }),
      node: update.node,
    })

    const confirmed = stored.toLowerCase() === update.contentHash.toLowerCase()

    if (confirmed)
      await env.DB.prepare(
        "UPDATE deployments SET ens_status = 'confirmed' WHERE id = ?1",
      )
        .bind(id)
        .run()

    return json({ confirmed })
  }

  /** Take a user's own site down. It can't recall copies held elsewhere. */
  const removeOwn = async (env: E, id: string, session: Session) => {
    const deployment = await loadOwn(env, id, session)
    if (deployment.status !== 'published' && deployment.status !== 'expired')
      throw new HttpError(409, `Deployment is ${deployment.status}`)

    const results = await unpinDeployment(env, config, deployment, {
      actor: session.sub,
      action: 'deployment.removed',
    })
    return json({ id, status: 'removed', providers: results })
  }

  const corsHeaders = async (
    request: Request,
    env: E,
    path: string,
  ): Promise<Record<string, string>> => {
    const shared = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    }

    // The admin API is for scripts, so browsers get no CORS access to it.
    if (path.startsWith('/admin')) return {}

    // Wallet backends call this from origins no connected app can list. The
    // token in its URL is the credential, not cookies or the origin.
    if (path.endsWith('/paymaster'))
      return { ...shared, 'Access-Control-Allow-Origin': '*' }

    const origin = request.headers.get('Origin')
    if (!origin) return shared

    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '')
    const appId =
      request.headers.get('X-Omnipin-App') ??
      (token
        ? (await verifySessionToken(token, secretFor(env)))?.app
        : undefined)
    // Nothing identifies an app, so there's no list to check. Authentication
    // still rejects the request, and a 401 tells the client to refresh.
    if (!appId && request.method !== 'OPTIONS') return shared

    const app = appId ? await loadApp(env, appId) : null
    const allowed = app?.active
      ? (JSON.parse(app.origins) as string[]).includes(origin)
      : false

    if (!allowed) {
      // No token on a preflight, so answer it and let the real request fail.
      if (request.method === 'OPTIONS')
        return {
          ...shared,
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers':
            'Authorization, Content-Type, X-Omnipin-App',
        }
      throw new HttpError(403, 'Origin is not allowed for this app')
    }

    return {
      ...shared,
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, X-Omnipin-App',
    }
  }

  const route = async (
    request: Request,
    env: E,
    path: string,
  ): Promise<Response> => {
    const [id, action, sub] = path.split('/').filter(Boolean)
    const { method } = request

    if (id === 'admin') return adminRoutes(request, env, path, config)

    if (!id && method === 'POST')
      return create(request, env, await authenticate(request, env))

    if (id && !action && method === 'GET')
      return json(
        publicView(await loadOwn(env, id, await authenticate(request, env))),
      )

    if (id && method === 'POST') {
      if (action === 'paymaster' && !sub) return paymaster(request, env, id)

      const session = await authenticate(request, env)
      if (action === 'start' && !sub) return start(env, id, session)
      if (action === 'sponsorship' && !sub)
        return sponsorship(request, env, id, session)
      if (action === 'ens' && sub === 'verify')
        return verifyEns(env, id, session)
      if (action === 'remove' && !sub) return removeOwn(env, id, session)
    }

    throw new HttpError(404, 'Not found')
  }

  return async (request: Request, env: E): Promise<Response> => {
    const url = new URL(request.url)
    if (!`${url.pathname}/`.startsWith(`${config.basePath}/`))
      return new Response('Not found', { status: 404 })

    const path = url.pathname.slice(config.basePath.length)
    let headers: Record<string, string> = {}

    try {
      headers = await corsHeaders(request, env, path)
      if (request.method === 'OPTIONS')
        return new Response(null, { status: 204, headers })

      const response = await route(request, env, path)
      for (const [key, value] of Object.entries(headers))
        response.headers.set(key, value)
      return response
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.message }, error.status, headers)

      // Provider and RPC errors can carry URLs and signed requests.
      console.error('Gateway error', error)
      return json({ error: 'Internal error' }, 500, headers)
    }
  }
}

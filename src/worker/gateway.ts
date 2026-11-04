import { CID } from 'multiformats/cid'
import * as Provider from 'ox/Provider'
import { fromHttp } from 'ox/RpcTransport'
import { publishToProvider, selectProviders } from '../deploy.js'
import { prepareEnsUpdate, readContenthash } from '../ens.js'
import { updateDnsLink } from '../utils/dnslink.js'
import { getEnsResolver } from '../utils/ens/get-resolver.js'
import { presignPut } from '../utils/s3.js'
import {
  audit,
  type DeploymentRow,
  isCidInUse,
  loadRow,
  pinStatuses,
  recheckDeployment,
  removeDeployment,
  toDeployment,
  unpinFromProviders,
} from './deployments.js'
import type { GatewayConfig, GatewayEnv, User } from './types.js'

const CAR_TYPE = 'application/vnd.ipld.car'
const DAY_MS = 86_400_000
const UPLOAD_URL_LIFETIME = 900

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
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

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const clientView = (row: DeploymentRow) => {
  const { userId: _, ...view } = toDeployment(row)
  return view
}

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'Expected a JSON object')
  return body as Record<string, unknown>
}

/**
 * Handle Omnipin's routes under `config.basePath`. Mount it in your Worker,
 * ahead of your own routes.
 */
export const createGatewayHandler = <E extends GatewayEnv>(
  config: GatewayConfig<E>,
) => {
  const authenticate = async (request: Request, env: E): Promise<User> => {
    const user = await config.authenticate(request, env)
    if (!user) throw new HttpError(401, 'Sign in first')

    if (
      env.RATE_LIMITER &&
      !(await env.RATE_LIMITER.limit({ key: user.id })).success
    )
      throw new HttpError(429, 'Too many requests')

    return user
  }

  const loadOwn = async (env: E, id: string, user: User) => {
    const row = await loadRow(env.DB, id)
    // Same answer for "missing" and "someone else's", so ids can't be probed.
    if (row?.user_id !== user.id)
      throw new HttpError(404, 'Deployment not found')
    return row
  }

  const provider = (env: E) => Provider.from(fromHttp(config.rpcUrl(env)))

  const checkDnsLink = async (env: E, user: User, hostname: unknown) => {
    if (typeof hostname !== 'string' || !HOSTNAME.test(hostname))
      throw new HttpError(400, 'Invalid DNSLink hostname')
    if (!(await config.authorizeDnsLink?.(user, hostname, env)))
      throw new HttpError(403, 'Not allowed to update this hostname')
    return hostname
  }

  const create = async (request: Request, env: E, user: User) => {
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
    if (dnslink !== undefined) await checkDnsLink(env, user, dnslink)

    const deploy = {
      name,
      cid,
      size,
      ...(ens ? { ens: ens as string } : {}),
      ...(dnslink ? { dnslink: dnslink as string } : {}),
    }
    if (
      config.authorizeDeploy &&
      !(await config.authorizeDeploy(user, deploy, env))
    )
      throw new HttpError(403, 'Not allowed to deploy')

    const id = crypto.randomUUID()
    const now = Date.now()
    const dayStart = now - DAY_MS
    const carKey = `omnipin/${id}.car`
    const { dailyBytes, userDailyDeploys, retentionDays } = config.limits

    // One statement, so concurrent requests can't both pass the quota check.
    // Rejected deployments are free: they never reach a provider.
    const { meta } = await env.DB.prepare(
      `INSERT INTO omnipin_deployments
         (id, user_id, name, cid, size, car_key, status, ens_name, dnslink, retention_until, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'created', ?7, ?8, ?9, ?10
       WHERE (?11 IS NULL OR (SELECT COALESCE(SUM(size), 0) FROM omnipin_deployments
              WHERE created_at >= ?12 AND status != 'rejected') + ?5 <= ?11)
         AND (?13 IS NULL OR (SELECT COUNT(*) FROM omnipin_deployments
              WHERE user_id = ?2 AND created_at >= ?12 AND status != 'rejected') < ?13)`,
    )
      .bind(
        id,
        user.id,
        name,
        cid,
        size,
        carKey,
        ens ?? null,
        dnslink ?? null,
        retentionDays ? now + retentionDays * DAY_MS : null,
        now,
        dailyBytes ?? null,
        dayStart,
        userDailyDeploys ?? null,
      )
      .run()

    if (!meta.changes) throw new HttpError(429, 'Daily quota reached')

    await audit(env, {
      actor: user.id,
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

  const start = async (env: E, id: string, user: User) => {
    const deployment = await loadOwn(env, id, user)
    if (deployment.status !== 'created')
      throw new HttpError(409, `Deployment is ${deployment.status}`)

    // A presigned URL can't limit size, so the object is checked here.
    const object = await env.CARS.head(deployment.car_key)
    if (!object) throw new HttpError(409, 'CAR has not been uploaded')

    if (object.size !== deployment.size) {
      await env.CARS.delete(deployment.car_key)
      await env.DB.prepare(
        "UPDATE omnipin_deployments SET status = 'rejected', error = ?2 WHERE id = ?1",
      )
        .bind(id, 'Uploaded size does not match the declared size')
        .run()
      throw new HttpError(422, 'Uploaded size does not match the declared size')
    }

    // Conditional, so a double submit can't start two workflows.
    const { meta } = await env.DB.prepare(
      "UPDATE omnipin_deployments SET status = 'publishing' WHERE id = ?1 AND status = 'created'",
    )
      .bind(id)
      .run()
    if (!meta.changes) throw new HttpError(409, 'Deployment already started')

    await audit(env, {
      actor: user.id,
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

  /** The call a user's wallet makes. The gateway never signs for anyone. */
  const prepareEns = async (env: E, id: string, user: User) => {
    const { to, data } = await prepareUpdate(env, await loadOwn(env, id, user))
    return json({ call: { to, data }, chainId: config.chainId })
  }

  /** Trust the chain, not the client: read the name back after any update. */
  const verifyEns = async (env: E, id: string, user: User) => {
    const deployment = await loadOwn(env, id, user)
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
        "UPDATE omnipin_deployments SET ens_status = 'confirmed' WHERE id = ?1",
      )
        .bind(id)
        .run()

    return json({ confirmed })
  }

  const recheck = async (env: E, id: string, user: User) => {
    const row = await loadOwn(env, id, user)
    await recheckDeployment(env, config, row)
    return json(clientView((await loadRow(env.DB, id)) as DeploymentRow))
  }

  const removeOwn = async (env: E, id: string, user: User) => {
    if (!config.allowUserRemoval)
      throw new HttpError(403, 'Removing sites is turned off')

    const deployment = await loadOwn(env, id, user)
    if (!['published', 'pending', 'expired'].includes(deployment.status))
      throw new HttpError(409, `Deployment is ${deployment.status}`)

    const results = await removeDeployment(env, config, id, { actor: user.id })
    return json({ id, status: 'removed', providers: results })
  }

  const configuredProviders = (env: E) =>
    selectProviders(config.tokens(env), config.providers).active.filter(
      (p) => p.protocol === 'ipfs',
    )

  const cidParam = (cid: string | undefined) => {
    if (!isCIDv1(cid)) throw new HttpError(400, 'cid must be a CIDv1')
    return cid
  }

  /** `omnipin status`: where a CID stands on your providers. */
  const pinStatus = async (env: E, cid: string) => {
    const names = configuredProviders(env)
      .filter((p) => p.status)
      .map((p) => p.name)
    const pins = await pinStatuses(env, config, cid, names)

    return json({
      cid,
      providers: names.map((name, i) => ({ name, pin: pins[i] ?? 'unknown' })),
    })
  }

  /** `omnipin pin`: pin a CID that's already on IPFS. */
  const pin = async (request: Request, env: E, user: User) => {
    if (!config.tools?.pin) throw new HttpError(403, 'Pinning is turned off')

    const { cid, name } = await readJson(request)
    if (!isCIDv1(cid)) throw new HttpError(400, 'cid must be a CIDv1')
    if (name !== undefined && (typeof name !== 'string' || !NAME.test(name)))
      throw new HttpError(400, 'Invalid name')

    const pinners = configuredProviders(env).filter(
      (p) => p.supported !== 'upload',
    )
    const providers = await Promise.all(
      pinners.map(async (provider) => {
        try {
          const pin = await publishToProvider({
            provider,
            first: false,
            bytes: new Uint8Array(),
            name: (name as string | undefined) ?? cid,
            size: 0,
            cid,
            tokens: config.tokens(env),
          })
          return { name: provider.name, status: 'deployed', pin }
        } catch {
          return { name: provider.name, status: 'failed' }
        }
      }),
    )

    await audit(env, {
      actor: user.id,
      action: 'cid.pinned',
      detail: cid,
    })

    return json({ cid, providers })
  }

  /** `omnipin unpin`: drop a CID, unless a deployment still needs it. */
  const unpin = async (env: E, cid: string, user: User) => {
    if (!config.tools?.unpin)
      throw new HttpError(403, 'Unpinning is turned off')
    if (await isCidInUse(env.DB, cid))
      throw new HttpError(409, 'A deployment still uses this CID')

    const names = configuredProviders(env).map((p) => p.name)
    const results = await unpinFromProviders(env, config, cid, names)

    await audit(env, { actor: user.id, action: 'cid.unpinned', detail: cid })
    return json({ cid, providers: results })
  }

  /** `omnipin dnslink`: point a hostname at a CID. */
  const dnsLink = async (request: Request, env: E, user: User) => {
    const { cid, name } = await readJson(request)
    if (!isCIDv1(cid)) throw new HttpError(400, 'cid must be a CIDv1')
    const hostname = await checkDnsLink(env, user, name)

    const credentials = config.dnslink?.(env)
    if (!credentials) throw new HttpError(403, 'DNSLink is not configured')

    const { errors } = await updateDnsLink({
      cid,
      name: hostname,
      ...credentials,
      verbose: false,
    })
    if (errors?.length) throw new HttpError(502, 'DNSLink update failed')

    await audit(env, {
      actor: user.id,
      action: 'dnslink.updated',
      detail: `${hostname} ${cid}`,
    })
    return json({ cid, name: hostname })
  }

  const corsHeaders = (request: Request): Record<string, string> => {
    const origin = request.headers.get('Origin')
    if (!origin || origin === new URL(request.url).origin) return {}

    // Browsers send cookies on cross-site requests too, so this is also what
    // stops another site acting as a signed-in user.
    if (!config.allowedOrigins?.includes(origin))
      throw new HttpError(403, 'Origin is not allowed')

    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    }
  }

  const route = async (
    request: Request,
    env: E,
    path: string,
  ): Promise<Response> => {
    const [first, second, third] = path.split('/').filter(Boolean)
    const { method } = request
    const user = await authenticate(request, env)

    if (!first && method === 'POST') return create(request, env, user)

    if (first === 'pins') {
      if (!second && method === 'POST') return pin(request, env, user)
      if (second && !third && method === 'GET')
        return pinStatus(env, cidParam(second))
      if (second && third === 'unpin' && method === 'POST')
        return unpin(env, cidParam(second), user)
    }

    if (first === 'dnslink' && !second && method === 'POST')
      return dnsLink(request, env, user)

    if (first && !second && method === 'GET')
      return json(clientView(await loadOwn(env, first, user)))

    if (first && method === 'POST') {
      if (second === 'start' && !third) return start(env, first, user)
      if (second === 'recheck' && !third) return recheck(env, first, user)
      if (second === 'remove' && !third) return removeOwn(env, first, user)
      if (second === 'ens' && third === 'prepare')
        return prepareEns(env, first, user)
      if (second === 'ens' && third === 'verify')
        return verifyEns(env, first, user)
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
      headers = corsHeaders(request)
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
      console.error('Omnipin gateway error', error)
      return json({ error: 'Internal error' }, 500, headers)
    }
  }
}

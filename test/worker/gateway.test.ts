import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { PROVIDERS } from '../../src/constants.js'
import { packFiles } from '../../src/utils/ipfs.js'
import type { GatewayConfig } from '../../src/worker/types.js'
import { createEnv } from '../helpers/gateway.js'

const update = {
  to: '0x00000000000000000000000000000000000000cc',
  data: '0x304e6adeabcdef',
  node: '0x01',
  contentHash: '0xe301',
} as const

let stored: string

mock.module(new URL('../../src/ens.ts', import.meta.url).href, {
  namedExports: {
    prepareEnsUpdate: async () => update,
    readContenthash: async () => stored,
  },
})
mock.module(
  new URL('../../src/utils/ens/get-resolver.ts', import.meta.url).href,
  { namedExports: { getEnsResolver: async () => update.to } },
)

const { createGatewayHandler } = await import('../../src/worker/gateway.js')

const BASE = '/api/deployments'
const HOST = 'https://app.example'
const OTHER = 'https://partner.example'
const MB = 1_000_000

const { rootCID } = await packFiles([
  { path: 'index.html', content: new TextEncoder().encode('hi') },
])
const CID = rootCID.toString()

type Env = ReturnType<typeof createEnv>['env']

const config: GatewayConfig<Env> = {
  basePath: BASE,
  authenticate: (request) => {
    const user = request.headers.get('X-Test-User')
    return user ? { id: user } : null
  },
  tokens: () => new Map([['UP_TOKEN', 'token']]),
  providers: ['Up'],
  rpcUrl: () => 'https://rpc.example',
  chainId: 1,
  r2: () => ({
    accountId: 'acct',
    bucketName: 'cars',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
  }),
  limits: { maxCarBytes: 10 * MB, dailyBytes: 20 * MB, userDailyDeploys: 3 },
}

let env: Env
let started: string[]
let handle: ReturnType<typeof createGatewayHandler<Env>>
let pinCalls: boolean[]
let unpinCalls: string[]

const call = async (
  path: string,
  {
    method = 'POST',
    body,
    user = 'alice',
    origin,
  }: {
    method?: string
    body?: unknown
    user?: string | null
    origin?: string
  } = {},
) => {
  const res = await handle(
    new Request(`${HOST}${BASE}${path}`, {
      method,
      headers: {
        ...(user ? { 'X-Test-User': user } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  )
  return { res, json: (await res.json().catch(() => null)) as any }
}

const site = { name: 'site', cid: CID, size: MB }

const created = async (user?: string, body: object = site) => {
  const { res, json } = await call('/', { body, user })
  assert.strictEqual(res.status, 201, JSON.stringify(json))
  return json as { id: string; uploadUrl: string }
}

const publish = async (extra: object = { ens: 'site.eth' }, user?: string) => {
  const { id } = await created(user, { ...site, ...extra })
  env.DB.sqlite
    .prepare("UPDATE omnipin_deployments SET status = 'published' WHERE id = ?")
    .run(id)
  return id
}

beforeEach(() => {
  ;({ env, started } = (() => {
    const made = createEnv()
    return { env: made.env, started: made.started }
  })())
  handle = createGatewayHandler(config)
  stored = update.contentHash
  pinCalls = []
  unpinCalls = []
  PROVIDERS.UP_TOKEN = {
    name: 'Up',
    supported: 'both',
    protocol: 'ipfs',
    upload: async ({ first, cid }) => {
      pinCalls.push(first)
      return { cid, status: 'queued' }
    },
    status: async () => ({ pin: 'pinned' }),
    unpin: async ({ cid }: { cid: string }) => {
      unpinCalls.push(cid)
      return { success: true, cid }
    },
  }
})

afterEach(() => {
  delete PROVIDERS.UP_TOKEN
})

describe('authentication', () => {
  it('uses the app’s own login', async () => {
    assert.strictEqual(
      (await call('/', { user: null, body: site })).res.status,
      401,
    )
    await created()
  })

  for (const [method, path] of [
    ['POST', '/'],
    ['GET', '/some-id'],
    ['POST', '/some-id/start'],
    ['POST', '/some-id/recheck'],
    ['POST', '/some-id/remove'],
    ['POST', '/some-id/ens/prepare'],
    ['POST', '/pins'],
    ['GET', `/pins/${CID}`],
    ['POST', '/dnslink'],
  ] as const)
    it(`protects ${method} ${path}`, async () => {
      const { res } = await call(path, { method, user: null })
      assert.strictEqual(res.status, 401)
    })

  it('lets the app veto a deploy, such as for payment', async () => {
    handle = createGatewayHandler({
      ...config,
      authorizeDeploy: (user, deploy) =>
        user.id === 'paid' && deploy.cid === CID,
    })
    assert.strictEqual((await call('/', { body: site })).res.status, 403)
    await created('paid')
  })
})

describe('origins', () => {
  it('needs no setup for the same origin', async () => {
    const { res } = await call('/', { body: site, origin: HOST })
    assert.strictEqual(res.status, 201)
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null)
  })

  it('refuses other sites, so they can’t use a signed-in user’s cookies', async () => {
    const { res } = await call('/', {
      body: site,
      origin: 'https://evil.example',
    })
    assert.strictEqual(res.status, 403)
    assert.strictEqual(
      env.DB.sqlite
        .prepare('SELECT COUNT(*) AS n FROM omnipin_deployments')
        .get()?.n,
      0,
    )
  })

  it('allows origins the app lists', async () => {
    handle = createGatewayHandler({ ...config, allowedOrigins: [OTHER] })
    const { res } = await call('/', { body: site, origin: OTHER })
    assert.strictEqual(res.status, 201)
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), OTHER)
  })

  it('answers a preflight for a listed origin only', async () => {
    handle = createGatewayHandler({ ...config, allowedOrigins: [OTHER] })
    const allowed = await call('/', { method: 'OPTIONS', origin: OTHER })
    const refused = await call('/', {
      method: 'OPTIONS',
      origin: 'https://evil.example',
    })
    assert.strictEqual(allowed.res.status, 204)
    assert.strictEqual(refused.res.status, 403)
  })
})

describe('creating a deployment', () => {
  it('stores it and returns a signed upload URL', async () => {
    const { uploadUrl } = await created()
    const url = new URL(uploadUrl)
    assert.strictEqual(url.hostname, 'acct.r2.cloudflarestorage.com')
    assert.ok(url.pathname.startsWith('/cars/omnipin/'))
    assert.strictEqual(
      url.searchParams.get('X-Amz-SignedHeaders'),
      'content-type;host',
    )
    assert.ok(!uploadUrl.includes('secret'))
  })

  for (const [label, body, status] of [
    ['a bad name', { ...site, name: '../x' }, 400],
    [
      'a CIDv0',
      { ...site, cid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' },
      400,
    ],
    ['a garbage CID', { ...site, cid: 'nope' }, 400],
    ['a zero size', { ...site, size: 0 }, 413],
    ['a fractional size', { ...site, size: 1.5 }, 413],
    ['an oversized site', { ...site, size: 11 * MB }, 413],
    ['a non-.eth ENS name', { ...site, ens: 'site.com' }, 400],
  ] as const)
    it(`rejects ${label}`, async () => {
      assert.strictEqual((await call('/', { body })).res.status, status)
    })

  it('ignores client-supplied provider URLs and tokens', async () => {
    const { id } = await created(undefined, {
      ...site,
      baseURL: 'https://evil.example',
      beeURL: 'https://evil.example',
      rpcUrl: 'https://evil.example',
      providers: ['Evil'],
    })
    const row = env.DB.sqlite
      .prepare('SELECT * FROM omnipin_deployments WHERE id = ?')
      .get(id)
    assert.ok(!JSON.stringify(row).includes('evil'))
  })

  it('denies DNSLink unless authorized', async () => {
    const { res } = await call('/', {
      body: { ...site, dnslink: 'site.example.com' },
    })
    assert.strictEqual(res.status, 403)
  })

  it('allows DNSLink for an authorized hostname only', async () => {
    handle = createGatewayHandler({
      ...config,
      authorizeDnsLink: (_, hostname) => hostname === 'site.example.com',
    })
    await created(undefined, { ...site, dnslink: 'site.example.com' })
    const { res } = await call('/', {
      body: { ...site, dnslink: 'other.example.com' },
    })
    assert.strictEqual(res.status, 403)
  })
})

describe('quotas', () => {
  it('limits deploys per user', async () => {
    for (let i = 0; i < 3; i++) await created()
    assert.strictEqual((await call('/', { body: site })).res.status, 429)
  })

  it('counts each user separately', async () => {
    for (let i = 0; i < 3; i++) await created()
    await created('bob')
  })

  it('limits total bytes per day', async () => {
    handle = createGatewayHandler({
      ...config,
      limits: { ...config.limits, dailyBytes: 2 * MB },
    })
    await created()
    await created('bob')
    assert.strictEqual(
      (await call('/', { user: 'carol', body: site })).res.status,
      429,
    )
  })

  it('has no limits unless the app sets them', async () => {
    handle = createGatewayHandler({
      ...config,
      limits: { maxCarBytes: 10 * MB },
    })
    for (let i = 0; i < 5; i++) await created()
  })

  it('holds under concurrent requests', async () => {
    handle = createGatewayHandler({
      ...config,
      limits: { ...config.limits, userDailyDeploys: 2 },
    })
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('/', { body: site })),
    )
    assert.strictEqual(
      results.filter(({ res }) => res.status === 201).length,
      2,
    )
  })

  it('does not charge for rejected deployments', async () => {
    handle = createGatewayHandler({
      ...config,
      limits: { ...config.limits, userDailyDeploys: 1 },
    })
    const { id } = await created()
    env.DB.sqlite
      .prepare(
        "UPDATE omnipin_deployments SET status = 'rejected' WHERE id = ?",
      )
      .run(id)
    await created()
  })

  it('applies a retention period when set', async () => {
    handle = createGatewayHandler({
      ...config,
      limits: { ...config.limits, retentionDays: 1 },
    })
    const { id } = await created()
    const { json } = await call(`/${id}`, { method: 'GET' })
    assert.ok(json.retentionUntil > Date.now())
  })
})

describe('isolation', () => {
  it('hides a deployment from other users', async () => {
    const { id } = await created()
    for (const [method, path] of [
      ['GET', `/${id}`],
      ['POST', `/${id}/start`],
      ['POST', `/${id}/recheck`],
      ['POST', `/${id}/ens/prepare`],
      ['POST', `/${id}/ens/verify`],
    ])
      assert.strictEqual(
        (await call(path, { method, user: 'bob' })).res.status,
        404,
        path,
      )
  })

  it('does not expose internal fields', async () => {
    const { id } = await created()
    const { json } = await call(`/${id}`, { method: 'GET' })
    for (const field of ['car_key', 'user_id', 'userId'])
      assert.ok(!(field in json), field)
  })
})

describe('starting', () => {
  const upload = (id: string, size: number) => {
    const row = env.DB.sqlite
      .prepare('SELECT car_key FROM omnipin_deployments WHERE id = ?')
      .get(id) as { car_key: string }
    env.CARS.objects.set(row.car_key, new Uint8Array(size))
    return row.car_key
  }

  it('starts the workflow once', async () => {
    const { id } = await created()
    upload(id, MB)
    assert.strictEqual((await call(`/${id}/start`)).res.status, 202)
    assert.strictEqual((await call(`/${id}/start`)).res.status, 409)
    assert.deepStrictEqual(started, [id])
  })

  it('starts at most once under a double submit', async () => {
    const { id } = await created()
    upload(id, MB)
    await Promise.all([call(`/${id}/start`), call(`/${id}/start`)])
    assert.deepStrictEqual(started, [id])
  })

  it('refuses to start before the upload', async () => {
    const { id } = await created()
    assert.strictEqual((await call(`/${id}/start`)).res.status, 409)
  })

  it('rejects and deletes an object bigger than declared', async () => {
    const { id } = await created()
    const key = upload(id, 2 * MB)
    assert.strictEqual((await call(`/${id}/start`)).res.status, 422)
    assert.strictEqual(env.CARS.objects.has(key), false)
    assert.deepStrictEqual(started, [])
    const { json } = await call(`/${id}`, { method: 'GET' })
    assert.strictEqual(json.status, 'rejected')
  })
})

describe('recheck', () => {
  it('publishes a pending deployment a provider now confirms', async () => {
    const { id } = await created()
    env.DB.sqlite
      .prepare(
        `UPDATE omnipin_deployments SET status = 'pending', providers = ? WHERE id = ?`,
      )
      .run(JSON.stringify([{ name: 'Up', status: 'deployed' }]), id)

    const { json } = await call(`/${id}/recheck`)
    assert.strictEqual(json.status, 'published')
  })
})

describe('removal', () => {
  it('is off unless the app turns it on', async () => {
    const id = await publish()
    assert.strictEqual((await call(`/${id}/remove`)).res.status, 403)
  })

  describe('when turned on', () => {
    beforeEach(() => {
      handle = createGatewayHandler({ ...config, allowUserRemoval: true })
    })

    it('lets an owner remove their own site', async () => {
      const id = await publish()
      assert.strictEqual((await call(`/${id}/remove`)).json.status, 'removed')
    })

    it('does not let anyone else remove it', async () => {
      const id = await publish()
      const { res } = await call(`/${id}/remove`, { user: 'bob' })
      assert.strictEqual(res.status, 404)
    })

    it('refuses a site that was never published', async () => {
      const { id } = await created()
      assert.strictEqual((await call(`/${id}/remove`)).res.status, 409)
    })
  })
})

describe('ENS', () => {
  it('hands the wallet its call, without signing anything', async () => {
    const id = await publish()
    const { json } = await call(`/${id}/ens/prepare`)
    assert.deepStrictEqual(json, {
      call: { to: update.to, data: update.data },
      chainId: 1,
    })
  })

  it('refuses before the site is confirmed', async () => {
    const { id } = await created(undefined, { ...site, ens: 'site.eth' })
    env.DB.sqlite
      .prepare("UPDATE omnipin_deployments SET status = 'pending' WHERE id = ?")
      .run(id)
    assert.strictEqual((await call(`/${id}/ens/prepare`)).res.status, 409)
  })

  it('refuses without an ENS name', async () => {
    const id = await publish({})
    assert.strictEqual((await call(`/${id}/ens/prepare`)).res.status, 409)
  })

  it('confirms when the chain matches', async () => {
    const id = await publish()
    assert.strictEqual((await call(`/${id}/ens/verify`)).json.confirmed, true)
    const { json } = await call(`/${id}`, { method: 'GET' })
    assert.strictEqual(json.ens.status, 'confirmed')
  })

  it('does not confirm when the chain differs', async () => {
    const id = await publish()
    stored = '0xe399'
    assert.strictEqual((await call(`/${id}/ens/verify`)).json.confirmed, false)
    const { json } = await call(`/${id}`, { method: 'GET' })
    assert.strictEqual(json.ens.status, null)
  })
})

describe('CLI tools', () => {
  describe('status', () => {
    it('reports a CID on each provider', async () => {
      const { json } = await call(`/pins/${CID}`, { method: 'GET' })
      assert.deepStrictEqual(json, {
        cid: CID,
        providers: [{ name: 'Up', pin: 'pinned' }],
      })
    })

    it('rejects a bad CID', async () => {
      const { res } = await call('/pins/nope', { method: 'GET' })
      assert.strictEqual(res.status, 400)
    })
  })

  describe('pin', () => {
    it('is off unless the app turns it on', async () => {
      assert.strictEqual(
        (await call('/pins', { body: { cid: CID } })).res.status,
        403,
      )
      assert.deepStrictEqual(pinCalls, [])
    })

    it('pins by CID, sending no bytes', async () => {
      handle = createGatewayHandler({ ...config, tools: { pin: true } })
      const { json } = await call('/pins', { body: { cid: CID } })
      assert.strictEqual(json.providers[0].status, 'deployed')
      assert.deepStrictEqual(pinCalls, [false])
    })
  })

  describe('unpin', () => {
    it('is off unless the app turns it on', async () => {
      const { res } = await call(`/pins/${CID}/unpin`)
      assert.strictEqual(res.status, 403)
      assert.deepStrictEqual(unpinCalls, [])
    })

    it('unpins a CID nothing uses', async () => {
      handle = createGatewayHandler({ ...config, tools: { unpin: true } })
      const { json } = await call(`/pins/${CID}/unpin`)
      assert.strictEqual(json.providers[0].status, 'unpinned')
    })

    it('refuses a CID a deployment still uses', async () => {
      handle = createGatewayHandler({ ...config, tools: { unpin: true } })
      await publish({}, 'bob')
      const { res } = await call(`/pins/${CID}/unpin`)
      assert.strictEqual(res.status, 409)
      assert.deepStrictEqual(unpinCalls, [])
    })
  })

  describe('dnslink', () => {
    it('denies by default', async () => {
      const { res } = await call('/dnslink', {
        body: { cid: CID, name: 'site.example.com' },
      })
      assert.strictEqual(res.status, 403)
    })
  })
})

describe('rate limiting', () => {
  it('limits authenticated routes by user', async () => {
    const keys: string[] = []
    ;(env as Env & { RATE_LIMITER: unknown }).RATE_LIMITER = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key)
        return { success: false }
      },
    }
    assert.strictEqual((await call('/', { body: site })).res.status, 429)
    assert.deepStrictEqual(keys, ['alice'])
  })
})

describe('errors', () => {
  it('hides unexpected errors from clients', async () => {
    const broken = createGatewayHandler({
      ...config,
      authenticate: () => {
        throw new Error('secret detail sk_live_123')
      },
    })
    const res = await broken(new Request(`${HOST}${BASE}/x`), env)
    assert.strictEqual(res.status, 500)
    assert.ok(!(await res.text()).includes('sk_live'))
  })

  it('leaves other paths alone', async () => {
    const res = await handle(new Request(`${HOST}/other`), env)
    assert.strictEqual(res.status, 404)
  })

  it('does not match a longer path sharing the prefix', async () => {
    const res = await handle(new Request(`${HOST}${BASE}-evil`), env)
    assert.strictEqual(res.status, 404)
  })
})

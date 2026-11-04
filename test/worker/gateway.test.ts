import * as assert from 'node:assert'
import { beforeEach, describe, it, mock } from 'node:test'
import { packFiles } from '../../src/utils/ipfs.js'
import { createSessionToken, deriveAppSecret } from '../../src/utils/session.js'
import { ENTRY_POINT, type UserOperation } from '../../src/worker/paymaster.js'
import type { GatewayConfig } from '../../src/worker/types.js'
import { createEnv } from '../helpers/gateway.js'

const update = {
  to: '0x00000000000000000000000000000000000000cc',
  data: '0x304e6adeabcdef',
  node: '0x01',
  contentHash: '0xe301',
} as const

let simulation: () => Promise<unknown>
let stored: string

const ensModule = new URL('../../src/ens.ts', import.meta.url).href
mock.module(ensModule, {
  namedExports: {
    prepareEnsUpdate: async () => update,
    simulateEnsUpdate: () => simulation(),
    readContenthash: async () => stored,
  },
})
mock.module(
  new URL('../../src/utils/ens/get-resolver.ts', import.meta.url).href,
  {
    namedExports: { getEnsResolver: async () => update.to },
  },
)

const { createGatewayHandler } = await import('../../src/worker/gateway.js')

const MASTER = 'master-secret'
const BASE = '/api/deployments'
const ORIGIN = 'https://app.example'
const MB = 1_000_000

const { rootCID } = await packFiles([
  { path: 'index.html', content: new TextEncoder().encode('hi') },
])
const CID = rootCID.toString()

const config: GatewayConfig<ReturnType<typeof createEnv>['env']> = {
  basePath: BASE,
  masterSecret: () => MASTER,
  tokens: () => new Map([['PINATA_TOKEN', 'token']]),
  rpcUrl: () => 'https://rpc.example',
  chainId: 1,
  r2: () => ({
    accountId: 'acct',
    bucketName: 'cars',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
  }),
  funding: () => ({
    paymaster: '0x00000000000000000000000000000000000000AA',
    signerKey: `0x${'11'.repeat(32)}`,
    maxCostPerOp: 10n ** 16n,
  }),
  limits: {
    maxCarBytes: 10 * MB,
    globalDailyBytes: 100 * MB,
    retentionDays: 30,
    sponsorAttempts: 2,
  },
}

let env: ReturnType<typeof createEnv>['env']
let started: string[]
let handle: ReturnType<typeof createGatewayHandler<typeof env>>

const addApp = (
  id: string,
  {
    dailyBytes = 20 * MB,
    userDeploys = 3,
    active = 1,
    dailySponsorships = 50,
  } = {},
) =>
  env.DB.sqlite
    .prepare(
      `INSERT INTO connected_apps
         (id, name, origins, daily_bytes, user_daily_deploys, daily_sponsorships, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      id,
      JSON.stringify([ORIGIN]),
      dailyBytes,
      userDeploys,
      dailySponsorships,
      active,
    )

const token = async (appId = 'app', userId = 'alice') =>
  createSessionToken({
    appId,
    userId,
    secret: await deriveAppSecret(MASTER, appId),
  })

const call = async (
  path: string,
  {
    method = 'POST',
    body,
    auth,
    origin = ORIGIN,
  }: {
    method?: string
    body?: unknown
    auth?: string | null
    origin?: string | null
  } = {},
) => {
  const authorization = auth === undefined ? await token() : auth
  const res = await handle(
    new Request(`https://gateway.example${BASE}${path}`, {
      method,
      headers: {
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  )
  return { res, json: (await res.json().catch(() => null)) as any }
}

const site = { name: 'site', cid: CID, size: MB }

const created = async (auth?: string, body: object = site) => {
  const { res, json } = await call('/', { body, auth })
  assert.strictEqual(res.status, 201, JSON.stringify(json))
  return json as { id: string; uploadUrl: string }
}

const publish = async (extra: object = { ens: 'site.eth' }) => {
  const { id } = await created(undefined, { ...site, ...extra })
  env.DB.sqlite
    .prepare("UPDATE deployments SET status = 'published' WHERE id = ?")
    .run(id)
  return id
}

const op = (overrides: Partial<UserOperation> = {}): UserOperation => ({
  sender: '0x00000000000000000000000000000000000000BB',
  nonce: '0x1',
  callData: `0xb61d27f6${'00'.repeat(32)}${update.data.slice(2)}`,
  callGasLimit: '0x10000',
  verificationGasLimit: '0x10000',
  preVerificationGas: '0x5000',
  maxFeePerGas: '0x3b9aca00',
  maxPriorityFeePerGas: '0x1',
  ...overrides,
})

const paymasterCall = async (
  id: string,
  {
    method = 'pm_getPaymasterData',
    operation = op(),
    entryPoint = ENTRY_POINT,
    chainId = '0x1',
    url,
  }: {
    method?: string
    operation?: UserOperation
    entryPoint?: string
    chainId?: string
    url?: string
  } = {},
) => {
  const target = url ?? (await call(`/${id}/sponsorship`)).json.paymasterUrl
  const res = await handle(
    new Request(target, {
      method: 'POST',
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method,
        params: [operation, entryPoint, chainId, {}],
      }),
    }),
    env,
  )
  return { res, json: (await res.json().catch(() => null)) as any }
}

beforeEach(() => {
  ;({ env, started } = createEnv())
  handle = createGatewayHandler(config)
  addApp('app')
  simulation = async () => '0x'
  stored = update.contentHash
})

describe('authentication', () => {
  it('rejects a missing or forged session', async () => {
    assert.strictEqual(
      (await call('/', { auth: null, body: site })).res.status,
      401,
    )
    assert.strictEqual(
      (await call('/', { auth: 'junk.token', body: site })).res.status,
      401,
    )
  })

  it('rejects a session signed with another app’s secret', async () => {
    const forged = await createSessionToken({
      appId: 'app',
      userId: 'alice',
      secret: await deriveAppSecret(MASTER, 'evil'),
    })
    assert.strictEqual(
      (await call('/', { auth: forged, body: site })).res.status,
      401,
    )
  })

  it('rejects an inactive app', async () => {
    addApp('off', { active: 0 })
    const { res } = await call('/', { auth: await token('off'), body: site })
    assert.strictEqual(res.status, 403)
  })

  it('does not accept a sponsorship token as a session', async () => {
    const id = await publish()
    const url = new URL((await call(`/${id}/sponsorship`)).json.paymasterUrl)
    const scoped = url.searchParams.get('token') as string
    assert.strictEqual(
      (await call('/', { auth: scoped, body: site })).res.status,
      401,
    )
    assert.strictEqual(
      (await call(`/${id}`, { method: 'GET', auth: scoped })).res.status,
      401,
    )
  })
})

describe('origins', () => {
  it('allows a registered origin', async () => {
    const { res } = await call('/', { body: site })
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN)
  })

  it('blocks an unregistered origin', async () => {
    const { res } = await call('/', {
      body: site,
      origin: 'https://evil.example',
    })
    assert.strictEqual(res.status, 403)
  })
})

describe('creating a deployment', () => {
  it('stores it and returns a signed upload URL', async () => {
    const { uploadUrl } = await created()
    const url = new URL(uploadUrl)
    assert.strictEqual(url.hostname, 'acct.r2.cloudflarestorage.com')
    assert.ok(url.pathname.startsWith('/cars/app/'))
    assert.strictEqual(
      url.searchParams.get('X-Amz-SignedHeaders'),
      'content-type;host',
    )
    assert.ok(!uploadUrl.includes('secret'))
  })

  for (const [label, body] of [
    ['a bad name', { ...site, name: '../x' }],
    [
      'a CIDv0',
      { ...site, cid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' },
    ],
    ['a garbage CID', { ...site, cid: 'nope' }],
    ['a zero size', { ...site, size: 0 }],
    ['a fractional size', { ...site, size: 1.5 }],
    ['a non-.eth ENS name', { ...site, ens: 'site.com' }],
  ] as const)
    it(`rejects ${label}`, async () => {
      assert.strictEqual(
        (await call('/', { body })).res.status,
        400 + (label.includes('size') ? 13 : 0),
      )
    })

  it('rejects a site above the size limit', async () => {
    const { res } = await call('/', { body: { ...site, size: 11 * MB } })
    assert.strictEqual(res.status, 413)
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
      .prepare('SELECT * FROM deployments WHERE id = ?')
      .get(id)
    assert.ok(!JSON.stringify(row).includes('evil'))
  })

  it('denies DNSLink unless authorized', async () => {
    const { res } = await call('/', {
      body: { ...site, dnslink: 'site.example.com' },
    })
    assert.strictEqual(res.status, 403)
  })

  it('allows DNSLink for an authorized hostname', async () => {
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
    await created(await token('app', 'bob'))
  })

  it('limits bytes per app', async () => {
    addApp('small', { dailyBytes: 2 * MB, userDeploys: 100 })
    const auth = await token('small')
    await created(auth)
    await created(auth)
    assert.strictEqual((await call('/', { auth, body: site })).res.status, 429)
  })

  it('caps the whole pool across connected apps', async () => {
    addApp('other', { dailyBytes: 500 * MB, userDeploys: 100 })
    handle = createGatewayHandler({
      ...config,
      limits: { ...config.limits, globalDailyBytes: 2 * MB },
    })
    await created()
    await created(await token('other'))
    const { res } = await call('/', { auth: await token('other'), body: site })
    assert.strictEqual(res.status, 429)
  })

  it('holds under concurrent requests', async () => {
    addApp('race', { dailyBytes: 500 * MB, userDeploys: 2 })
    const auth = await token('race')
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('/', { auth, body: site })),
    )
    assert.strictEqual(
      results.filter(({ res }) => res.status === 201).length,
      2,
    )
  })

  it('does not charge for rejected deployments', async () => {
    addApp('one', { userDeploys: 1 })
    const auth = await token('one')
    const { id } = await created(auth)
    env.DB.sqlite
      .prepare("UPDATE deployments SET status = 'rejected' WHERE id = ?")
      .run(id)
    await created(auth)
  })

  it('stops counting after a day', async () => {
    addApp('one', { userDeploys: 1 })
    const auth = await token('one')
    const { id } = await created(auth)
    env.DB.sqlite
      .prepare('UPDATE deployments SET created_at = ? WHERE id = ?')
      .run(Date.now() - 90_000_000, id)
    await created(auth)
  })
})

describe('isolation', () => {
  it('hides a deployment from other users', async () => {
    const { id } = await created()
    const bob = await token('app', 'bob')
    assert.strictEqual(
      (await call(`/${id}`, { method: 'GET', auth: bob })).res.status,
      404,
    )
    assert.strictEqual(
      (await call(`/${id}/start`, { auth: bob })).res.status,
      404,
    )
    assert.strictEqual(
      (await call(`/${id}/sponsorship`, { auth: bob })).res.status,
      404,
    )
  })

  it('hides a deployment from other apps, even with the same user id', async () => {
    addApp('other')
    const { id } = await created()
    const { res } = await call(`/${id}`, {
      method: 'GET',
      auth: await token('other'),
    })
    assert.strictEqual(res.status, 404)
  })

  it('does not expose internal fields', async () => {
    const { id } = await created()
    const { json } = await call(`/${id}`, { method: 'GET' })
    for (const field of ['car_key', 'user_id', 'app_id', 'sponsor_attempts'])
      assert.ok(!(field in json))
  })
})

describe('starting', () => {
  const upload = (id: string, size: number) => {
    const row = env.DB.sqlite
      .prepare('SELECT car_key FROM deployments WHERE id = ?')
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

describe('sponsorship', () => {
  it('refuses before the site is published', async () => {
    const { id } = await created(undefined, { ...site, ens: 'site.eth' })
    assert.strictEqual((await call(`/${id}/sponsorship`)).res.status, 409)
  })

  it('refuses without an ENS name', async () => {
    const id = await publish({})
    assert.strictEqual((await call(`/${id}/sponsorship`)).res.status, 409)
  })

  it('reports unsponsored when funding is off', async () => {
    handle = createGatewayHandler({ ...config, funding: undefined })
    const id = await publish()
    const { json } = await call(`/${id}/sponsorship`)
    assert.strictEqual(json.sponsored, false)
    assert.deepStrictEqual(json.call, { to: update.to, data: update.data })
  })

  it('approves the deployment’s own update', async () => {
    const id = await publish()
    const { json } = await paymasterCall(id)
    assert.strictEqual(json.error, undefined)
    assert.strictEqual(json.result.paymaster.length, 42)
    assert.strictEqual(json.result.paymasterData.length, 2 + 77 * 2)
  })

  it('gives a stub without using an attempt or a real signature', async () => {
    const id = await publish()
    const { json } = await paymasterCall(id, {
      method: 'pm_getPaymasterStubData',
    })
    assert.ok(json.result.paymasterData.endsWith('00'.repeat(65)))
    const row = env.DB.sqlite
      .prepare('SELECT sponsor_attempts FROM deployments WHERE id = ?')
      .get(id) as { sponsor_attempts: number }
    assert.strictEqual(row.sponsor_attempts, 0)
  })

  it('refuses any other call', async () => {
    const id = await publish()
    const { json } = await paymasterCall(id, {
      operation: op({ callData: '0xb61d27f6deadbeef' }),
    })
    assert.match(json.error.message, /not this deployment/)
  })

  it('refuses an operation above the cost cap', async () => {
    const id = await publish()
    const { json } = await paymasterCall(id, {
      operation: op({ maxFeePerGas: '0x174876e800000' }),
    })
    assert.match(json.error.message, /cost cap/)
  })

  it('refuses another EntryPoint or chain', async () => {
    const id = await publish()
    const entry = await paymasterCall(id, {
      entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    })
    assert.match(entry.json.error.message, /EntryPoint/)
    assert.match(
      (await paymasterCall(id, { chainId: '0xa' })).json.error.message,
      /chain/,
    )
  })

  it('refuses an account without permission on the name', async () => {
    const id = await publish()
    simulation = async () => {
      throw new Error('reverted')
    }
    assert.strictEqual((await paymasterCall(id)).res.status, 403)
    const row = env.DB.sqlite
      .prepare('SELECT sponsor_attempts FROM deployments WHERE id = ?')
      .get(id) as { sponsor_attempts: number }
    assert.strictEqual(row.sponsor_attempts, 0)
  })

  it('caps approvals per deployment', async () => {
    const id = await publish()
    const url = (await call(`/${id}/sponsorship`)).json.paymasterUrl
    await paymasterCall(id, { url })
    await paymasterCall(id, { url })
    const { json } = await paymasterCall(id, { url })
    assert.match(json.error.message, /used up/)
  })

  it('holds the cap under concurrent requests', async () => {
    const id = await publish()
    const url = (await call(`/${id}/sponsorship`)).json.paymasterUrl
    const results = await Promise.all(
      Array.from({ length: 6 }, () => paymasterCall(id, { url })),
    )
    assert.strictEqual(results.filter((r) => r.json.result).length, 2)
  })

  it('refuses a token for another deployment', async () => {
    const one = await publish()
    const two = await publish()
    const url = new URL((await call(`/${one}/sponsorship`)).json.paymasterUrl)
    url.pathname = url.pathname.replace(one, two)
    assert.strictEqual(
      (await paymasterCall(two, { url: url.toString() })).res.status,
      401,
    )
  })

  it('refuses a missing token', async () => {
    const id = await publish()
    const { res } = await paymasterCall(id, {
      url: `https://gateway.example${BASE}/${id}/paymaster`,
    })
    assert.strictEqual(res.status, 401)
  })

  it('answers wallet backends from any origin', async () => {
    const id = await publish()
    const { res } = await paymasterCall(id)
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*')
  })
})

describe('ENS verification', () => {
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

describe('errors', () => {
  it('hides unexpected errors from clients', async () => {
    const id = await publish()
    simulation = async () => '0x'
    const broken = createGatewayHandler({
      ...config,
      funding: () => {
        throw new Error('secret detail sk_live_123')
      },
    })
    const res = await broken(
      new Request(`https://gateway.example${BASE}/${id}/paymaster?token=x`, {
        method: 'POST',
        body: '{}',
      }),
      env,
    )
    assert.ok(!(await res.text()).includes('sk_live'))
  })

  it('leaves other paths alone', async () => {
    const res = await handle(new Request('https://gateway.example/other'), env)
    assert.strictEqual(res.status, 404)
  })

  it('does not match a longer path sharing the prefix', async () => {
    const res = await handle(
      new Request(`https://gateway.example${BASE}-evil`),
      env,
    )
    assert.strictEqual(res.status, 404)
  })
})

describe('sponsorship budget', () => {
  const approved = (results: { json: { result?: unknown } }[]) =>
    results.filter((r) => r.json.result).length

  it('caps approvals per app per day', async () => {
    addApp('tiny', { dailySponsorships: 1, userDeploys: 10 })
    const auth = await token('tiny')
    const ids = []
    for (let i = 0; i < 2; i++) {
      const { id } = await created(auth, { ...site, ens: 'site.eth' })
      env.DB.sqlite
        .prepare("UPDATE deployments SET status = 'published' WHERE id = ?")
        .run(id)
      ids.push(id)
    }

    const results = []
    for (const id of ids) {
      const url = (await call(`/${id}/sponsorship`, { auth })).json.paymasterUrl
      results.push(await paymasterCall(id, { url }))
    }

    assert.strictEqual(approved(results), 1)
    assert.match(results[1].json.error.message, /budget/)
  })

  it('caps approvals across all apps, even in a burst', async () => {
    handle = createGatewayHandler({
      ...config,
      limits: { ...config.limits, dailySponsorships: 2, sponsorAttempts: 50 },
    })
    const id = await publish()
    const url = (await call(`/${id}/sponsorship`)).json.paymasterUrl
    const results = await Promise.all(
      Array.from({ length: 8 }, () => paymasterCall(id, { url })),
    )
    assert.strictEqual(approved(results), 2)
  })

  it('refuses a suspended app even with a valid token', async () => {
    const id = await publish()
    const url = (await call(`/${id}/sponsorship`)).json.paymasterUrl
    env.DB.sqlite.exec("UPDATE connected_apps SET active = 0 WHERE id = 'app'")
    const { json } = await paymasterCall(id, { url })
    assert.match(json.error.message, /not active/)
  })

  it('records approvals in the audit log', async () => {
    const id = await publish()
    await paymasterCall(id)
    const entry = env.DB.sqlite
      .prepare("SELECT * FROM audit_log WHERE action = 'sponsorship.approved'")
      .get() as { deployment_id: string; detail: string }
    assert.strictEqual(entry.deployment_id, id)
    assert.strictEqual(entry.detail, op().sender)
  })
})

describe('rate limiting', () => {
  it('limits authenticated routes', async () => {
    const keys: string[] = []
    ;(env as typeof env & { RATE_LIMITER: unknown }).RATE_LIMITER = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key)
        return { success: false }
      },
    }
    assert.strictEqual((await call('/', { body: site })).res.status, 429)
    assert.deepStrictEqual(keys, ['app:alice'])
  })

  it('limits the paymaster by deployment', async () => {
    const id = await publish()
    const url = (await call(`/${id}/sponsorship`)).json.paymasterUrl
    ;(env as typeof env & { RATE_LIMITER: unknown }).RATE_LIMITER = {
      limit: async () => ({ success: false }),
    }
    assert.strictEqual((await paymasterCall(id, { url })).res.status, 429)
  })
})

describe('removing a site', () => {
  it('lets an owner remove their own site', async () => {
    const id = await publish()
    const { json } = await call(`/${id}/remove`)
    assert.strictEqual(json.status, 'removed')
    const entry = env.DB.sqlite
      .prepare(
        "SELECT actor FROM audit_log WHERE action = 'deployment.removed'",
      )
      .get() as { actor: string }
    assert.strictEqual(entry.actor, 'alice')
  })

  it('does not let anyone else remove it', async () => {
    const id = await publish()
    const { res } = await call(`/${id}/remove`, {
      auth: await token('app', 'bob'),
    })
    assert.strictEqual(res.status, 404)
  })

  it('refuses a site that was never published', async () => {
    const { id } = await created()
    assert.strictEqual((await call(`/${id}/remove`)).res.status, 409)
  })
})

describe('admin API', () => {
  const ADMIN = 'admin-secret'
  const admin = (
    path: string,
    init: { method?: string; body?: unknown; auth?: string } = {},
  ) =>
    call(`/admin${path}`, {
      method: init.method ?? 'POST',
      body: init.body,
      auth: init.auth ?? ADMIN,
      origin: null,
    })

  beforeEach(() => {
    handle = createGatewayHandler({ ...config, adminSecret: () => ADMIN })
  })

  const newApp = {
    id: 'new-app',
    name: 'New',
    origins: [ORIGIN],
    dailyBytes: MB,
    userDailyDeploys: 2,
    dailySponsorships: 2,
  }

  it('is switched off by default', async () => {
    handle = createGatewayHandler(config)
    const { res } = await admin('/audit', { method: 'GET' })
    assert.strictEqual(res.status, 404)
  })

  it('rejects a wrong secret, and session tokens', async () => {
    assert.strictEqual(
      (await admin('/audit', { method: 'GET', auth: 'wrong' })).res.status,
      401,
    )
    assert.strictEqual(
      (await admin('/audit', { method: 'GET', auth: await token() })).res
        .status,
      401,
    )
  })

  it('gives browsers no CORS access', async () => {
    const res = await handle(
      new Request(`https://gateway.example${BASE}/admin/audit`, {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN },
      }),
      env,
    )
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null)
  })

  it('registers an app whose secret works', async () => {
    const { res, json } = await admin('/apps', { body: newApp })
    assert.strictEqual(res.status, 201)

    const auth = await createSessionToken({
      appId: 'new-app',
      userId: 'alice',
      secret: json.secret,
    })
    await created(auth)
  })

  it('refuses duplicates and malformed apps', async () => {
    await admin('/apps', { body: newApp })
    assert.strictEqual((await admin('/apps', { body: newApp })).res.status, 409)
    for (const bad of [
      { ...newApp, id: 'NOT VALID' },
      { ...newApp, id: 'x', origins: ['not-a-url'] },
      { ...newApp, id: 'x', origins: ['https://a.test/path'] },
      { ...newApp, id: 'x', dailyBytes: 0 },
    ])
      assert.strictEqual((await admin('/apps', { body: bad })).res.status, 400)
  })

  it('rotates one app without affecting others', async () => {
    addApp('other')
    const oldSession = await token()
    const otherSession = await token('other')

    const { json } = await admin('/apps/app/rotate')

    assert.strictEqual(
      (await call('/', { body: site, auth: oldSession })).res.status,
      401,
    )
    await created(otherSession)
    await created(
      await createSessionToken({
        appId: 'app',
        userId: 'alice',
        secret: json.secret,
      }),
    )
  })

  it('suspends and resumes an app', async () => {
    await admin('/apps/app/suspend')
    assert.strictEqual((await call('/', { body: site })).res.status, 403)
    await admin('/apps/app/resume')
    await created()
  })

  it('takes down any site, recording why', async () => {
    const id = await publish()
    assert.strictEqual(
      (await admin(`/deployments/${id}/remove`, { body: {} })).res.status,
      400,
    )
    const { json } = await admin(`/deployments/${id}/remove`, {
      body: { reason: 'phishing report #12' },
    })
    assert.strictEqual(json.status, 'removed')

    const { json: log } = await admin('/audit', { method: 'GET' })
    assert.ok(
      log.entries.some((e: { action: string }) =>
        e.action.includes('phishing report #12'),
      ),
    )
  })

  it('renews a site, restoring an expired one', async () => {
    const id = await publish()
    env.DB.sqlite
      .prepare(
        "UPDATE deployments SET status = 'expired', retention_until = 1 WHERE id = ?",
      )
      .run(id)

    const before = Date.now()
    const { json } = await admin(`/deployments/${id}/renew`, {
      body: { days: 30 },
    })

    assert.ok(json.retentionUntil >= before + 30 * 86_400_000)
    const { json: status } = await call(`/${id}`, { method: 'GET' })
    assert.strictEqual(status.status, 'published')
  })

  it('leaves unknown admin paths at 404', async () => {
    assert.strictEqual((await admin('/nope')).res.status, 404)
  })
})

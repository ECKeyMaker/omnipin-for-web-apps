import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { PROVIDERS } from '../../src/constants.js'
import type { DeploymentRow } from '../../src/worker/deployments.js'
import {
  getDeployment,
  listAudit,
  listDeployments,
  recheckDeployment,
  removeDeployment,
  renewDeployment,
  runMaintenance,
} from '../../src/worker/deployments.js'
import type { GatewayConfig } from '../../src/worker/types.js'
import { createEnv } from '../helpers/gateway.js'

type Env = ReturnType<typeof createEnv>['env']

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const upload = async () => ({ cid: CID })

let env: Env
let unpinned: string[]
let pin: 'pinned' | 'queued' | 'failed'

const config = (limits = {}) =>
  ({
    tokens: () => new Map([['GONE_TOKEN', 'token']]),
    limits: { maxCarBytes: 1, ...limits },
  }) as unknown as GatewayConfig<Env>

const insert = (
  id: string,
  { status = 'published', retention = null as number | null, user = 'u' } = {},
) =>
  env.DB.sqlite
    .prepare(
      `INSERT INTO omnipin_deployments
         (id, user_id, name, cid, size, car_key, status, providers, retention_until, created_at)
       VALUES (?, ?, 's', ?, 1, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      user,
      CID,
      `car/${id}`,
      status,
      JSON.stringify([
        { name: 'Gone', status: 'deployed' },
        { name: 'Keeps', status: 'deployed' },
        { name: 'Never', status: 'failed' },
      ]),
      retention,
    )

const row = (id: string) =>
  env.DB.sqlite
    .prepare('SELECT * FROM omnipin_deployments WHERE id = ?')
    .get(id) as unknown as DeploymentRow

beforeEach(() => {
  ;({ env } = createEnv())
  unpinned = []
  pin = 'queued'
  PROVIDERS.GONE_TOKEN = {
    name: 'Gone',
    upload,
    supported: 'both',
    protocol: 'ipfs',
    status: async () => ({ pin }),
    unpin: async ({ cid }: { cid: string }) => {
      unpinned.push(cid)
      return { success: true, cid }
    },
  }
  PROVIDERS.KEEPS_TOKEN = {
    name: 'Keeps',
    upload,
    supported: 'both',
    protocol: 'ipfs',
  }
  PROVIDERS.NEVER_TOKEN = {
    name: 'Never',
    upload,
    supported: 'both',
    protocol: 'ipfs',
    unpin: async () => {
      throw new Error('should not be called')
    },
  }
})

afterEach(() => {
  delete PROVIDERS.GONE_TOKEN
  delete PROVIDERS.KEEPS_TOKEN
  delete PROVIDERS.NEVER_TOKEN
})

describe('lookups', () => {
  it('reads a deployment without SQL', async () => {
    insert('site', { user: 'alice' })
    const deployment = await getDeployment(env.DB, 'site')
    assert.strictEqual(deployment?.userId, 'alice')
    assert.strictEqual(deployment?.status, 'published')
    assert.strictEqual(deployment?.providers.length, 3)
  })

  it('returns null for an unknown id', async () => {
    assert.strictEqual(await getDeployment(env.DB, 'nope'), null)
  })

  it('filters by user and status', async () => {
    insert('a', { user: 'alice' })
    insert('b', { user: 'alice', status: 'failed' })
    insert('c', { user: 'bob' })

    const ids = async (filter: object) =>
      (await listDeployments(env.DB, filter)).map((d) => d.id).sort()

    assert.deepStrictEqual(await ids({}), ['a', 'b', 'c'])
    assert.deepStrictEqual(await ids({ userId: 'alice' }), ['a', 'b'])
    assert.deepStrictEqual(await ids({ status: 'failed' }), ['b'])
    assert.deepStrictEqual(await ids({ userId: 'bob', status: 'failed' }), [])
  })
})

describe('recheckDeployment', () => {
  it('publishes once a provider confirms, then drops the CAR', async () => {
    insert('site', { status: 'pending' })
    env.CARS.objects.set('car/site', new Uint8Array(1))
    pin = 'pinned'

    assert.strictEqual(
      await recheckDeployment(env, config(), row('site')),
      'published',
    )
    assert.strictEqual(row('site').status, 'published')
    assert.strictEqual(env.CARS.objects.has('car/site'), false)
  })

  it('keeps waiting, and keeps the CAR, while unconfirmed', async () => {
    insert('site', { status: 'pending' })
    env.CARS.objects.set('car/site', new Uint8Array(1))

    assert.strictEqual(
      await recheckDeployment(env, config(), row('site')),
      'pending',
    )
    assert.strictEqual(env.CARS.objects.has('car/site'), true)
  })

  it('fails when every provider reports failure', async () => {
    insert('site', { status: 'pending' })
    pin = 'failed'
    assert.strictEqual(
      await recheckDeployment(env, config(), row('site')),
      'failed',
    )
  })

  it('leaves other states alone', async () => {
    insert('site', { status: 'removed' })
    pin = 'pinned'
    assert.strictEqual(
      await recheckDeployment(env, config(), row('site')),
      'removed',
    )
    assert.strictEqual(row('site').status, 'removed')
  })
})

describe('runMaintenance', () => {
  it('finishes pending deployments', async () => {
    insert('site', { status: 'pending' })
    pin = 'pinned'
    await runMaintenance(env, config(), 200)
    assert.strictEqual(row('site').status, 'published')
  })

  it('only marks expired sites by default, leaving them pinned', async () => {
    insert('old', { retention: 100 })
    const { expired } = await runMaintenance(env, config(), 200)
    assert.strictEqual(expired, 1)
    assert.strictEqual(row('old').status, 'expired')
    assert.deepStrictEqual(unpinned, [])
  })

  it('unpins when configured to', async () => {
    insert('old', { retention: 100 })
    await runMaintenance(env, config({ unpinExpired: true }), 200)
    assert.strictEqual(row('old').status, 'expired')
    assert.deepStrictEqual(unpinned, [CID])
  })

  it('keeps sites with no retention, and sites still within it', async () => {
    insert('forever')
    insert('fresh', { retention: 300 })
    const { expired } = await runMaintenance(env, config(), 200)
    assert.strictEqual(expired, 0)
  })

  it('records every expiry', async () => {
    insert('old', { retention: 100 })
    await runMaintenance(env, config(), 200)
    const [entry] = (await listAudit(env.DB)) as { actor: string }[]
    assert.strictEqual(entry.actor, 'retention')
  })
})

describe('removeDeployment', () => {
  const remove = (id: string, options = {}) =>
    removeDeployment(env, config(), id, { actor: 'admin', ...options })

  it('reports providers that can’t unpin instead of hiding them', async () => {
    insert('site')
    assert.deepStrictEqual(await remove('site'), [
      { name: 'Gone', status: 'unpinned' },
      { name: 'Keeps', status: 'unsupported' },
    ])
    assert.strictEqual(row('site').status, 'removed')
  })

  it('reports a provider failure', async () => {
    PROVIDERS.GONE_TOKEN.unpin = async () => {
      throw new Error('down')
    }
    insert('site')
    assert.strictEqual((await remove('site'))?.[0].status, 'failed')
  })

  it('returns null for an unknown id', async () => {
    assert.strictEqual(await remove('nope'), null)
  })

  it('keeps the pin while another deployment shares the CID', async () => {
    insert('attacker-copy')
    insert('original')

    const results = await remove('attacker-copy')

    assert.deepStrictEqual(unpinned, [])
    assert.ok(results?.every((r) => r.status === 'shared'))
    assert.strictEqual(row('original').status, 'published')
  })

  it('counts a pending deployment as using the CID', async () => {
    insert('copy')
    insert('waiting', { status: 'pending' })
    await remove('copy')
    assert.deepStrictEqual(unpinned, [])
  })

  it('unpins once the last deployment of a CID goes', async () => {
    insert('one')
    insert('two')
    await remove('one')
    await remove('two')
    assert.deepStrictEqual(unpinned, [CID])
  })

  it('lets a forced takedown win, recording why', async () => {
    insert('phishing')
    insert('copy')
    await remove('phishing', { force: true, reason: 'report #12' })
    assert.deepStrictEqual(unpinned, [CID])

    const [entry] = (await listAudit(env.DB)) as { detail: string }[]
    assert.match(entry.detail, /report #12/)
  })
})

describe('renewDeployment', () => {
  it('extends retention and restores an expired site', async () => {
    insert('site', { status: 'expired', retention: 1 })
    const before = Date.now()
    const until = await renewDeployment(env, 'site', 30, 'admin')

    assert.ok((until as number) >= before + 30 * 86_400_000)
    assert.strictEqual(row('site').status, 'published')
  })

  it('returns null for an unknown id', async () => {
    assert.strictEqual(await renewDeployment(env, 'nope', 1, 'admin'), null)
  })
})

import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { PROVIDERS } from '../../src/constants.js'
import { sweepExpired, unpinDeployment } from '../../src/worker/admin.js'
import type { DeploymentRow } from '../../src/worker/gateway.js'
import type { GatewayConfig } from '../../src/worker/types.js'
import { createEnv } from '../helpers/gateway.js'

type Env = ReturnType<typeof createEnv>['env']

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const upload = async () => ({ cid: CID })

let env: Env
let unpinned: string[]

const config = (limits = {}) =>
  ({
    tokens: () => new Map([['GONE_TOKEN', 'token']]),
    limits: {
      maxCarBytes: 1,
      globalDailyBytes: 1,
      retentionDays: 1,
      ...limits,
    },
  }) as unknown as GatewayConfig<Env>

const insert = (id: string, retention: number, status = 'published') =>
  env.DB.sqlite
    .prepare(
      `INSERT INTO deployments
         (id, app_id, user_id, name, cid, size, car_key, status, providers, retention_until, created_at)
       VALUES (?, 'app', 'u', 's', ?, 1, 'k', ?, ?, ?, 0)`,
    )
    .run(
      id,
      CID,
      status,
      JSON.stringify([
        { name: 'Gone', status: 'deployed' },
        { name: 'Keeps', status: 'deployed' },
        { name: 'Never', status: 'failed' },
      ]),
      retention,
    )

const statusOf = (id: string) =>
  (
    env.DB.sqlite
      .prepare('SELECT status FROM deployments WHERE id = ?')
      .get(id) as { status: string }
  ).status

beforeEach(() => {
  ;({ env } = createEnv())
  unpinned = []
  env.DB.sqlite.exec(`
    INSERT INTO connected_apps (id, name, origins, daily_bytes, user_daily_deploys)
    VALUES ('app', 'app', '[]', 1, 1)
  `)
  PROVIDERS.GONE_TOKEN = {
    name: 'Gone',
    upload,
    supported: 'both',
    protocol: 'ipfs',
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

describe('sweepExpired', () => {
  it('only marks expired sites by default, leaving them pinned', async () => {
    insert('old', 100)
    assert.strictEqual(await sweepExpired(env, config(), 200), 1)
    assert.strictEqual(statusOf('old'), 'expired')
    assert.deepStrictEqual(unpinned, [])
  })

  it('unpins when configured to', async () => {
    insert('old', 100)
    await sweepExpired(env, config({ unpinExpired: true }), 200)
    assert.strictEqual(statusOf('old'), 'expired')
    assert.deepStrictEqual(unpinned, [CID])
  })

  it('leaves sites still within retention', async () => {
    insert('fresh', 300)
    assert.strictEqual(await sweepExpired(env, config(), 200), 0)
    assert.strictEqual(statusOf('fresh'), 'published')
  })

  it('ignores sites that never published', async () => {
    insert('failed', 100, 'failed')
    assert.strictEqual(await sweepExpired(env, config(), 200), 0)
  })

  it('records every expiry', async () => {
    insert('old', 100)
    await sweepExpired(env, config(), 200)
    const entry = env.DB.sqlite.prepare('SELECT * FROM audit_log').get() as {
      actor: string
      action: string
    }
    assert.strictEqual(entry.actor, 'retention')
    assert.strictEqual(entry.action, 'deployment.expired')
  })
})

describe('unpinDeployment', () => {
  const load = (id: string) =>
    env.DB.sqlite
      .prepare('SELECT * FROM deployments WHERE id = ?')
      .get(id) as unknown as DeploymentRow

  it('reports providers that can’t unpin instead of hiding them', async () => {
    insert('site', 0)
    const results = await unpinDeployment(env, config(), load('site'), {
      actor: 'admin',
      action: 'test',
    })
    assert.deepStrictEqual(results, [
      { name: 'Gone', status: 'unpinned' },
      { name: 'Keeps', status: 'unsupported' },
    ])
  })

  it('keeps the pin while another deployment shares the CID', async () => {
    insert('attacker-copy', 0)
    insert('original', 0)

    const results = await unpinDeployment(
      env,
      config(),
      load('attacker-copy'),
      { actor: 'attacker', action: 'test' },
    )

    assert.deepStrictEqual(unpinned, [])
    assert.ok(results.every((r) => r.status === 'shared'))
    assert.strictEqual(statusOf('attacker-copy'), 'removed')
    assert.strictEqual(statusOf('original'), 'published')
  })

  it('unpins once the last deployment of a CID goes', async () => {
    insert('one', 0)
    insert('two', 0)
    await unpinDeployment(env, config(), load('one'), {
      actor: 'a',
      action: 'test',
    })
    await unpinDeployment(env, config(), load('two'), {
      actor: 'a',
      action: 'test',
    })
    assert.deepStrictEqual(unpinned, [CID])
  })

  it('lets an operator takedown force the unpin', async () => {
    insert('phishing', 0)
    insert('copy', 0)
    await unpinDeployment(env, config(), load('phishing'), {
      actor: 'admin',
      action: 'test',
      force: true,
    })
    assert.deepStrictEqual(unpinned, [CID])
  })

  it('reports a provider failure', async () => {
    PROVIDERS.GONE_TOKEN.unpin = async () => {
      throw new Error('down')
    }
    insert('site', 0)
    const results = await unpinDeployment(env, config(), load('site'), {
      actor: 'admin',
      action: 'test',
    })
    assert.strictEqual(results[0].status, 'failed')
  })
})

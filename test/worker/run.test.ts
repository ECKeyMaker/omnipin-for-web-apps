import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { PROVIDERS } from '../../src/constants.js'
import type { SupportedMethods, UploadFunction } from '../../src/types.js'
import { packFiles } from '../../src/utils/ipfs.js'
import { runDeployment, type Step } from '../../src/worker/run.js'
import type { GatewayConfig } from '../../src/worker/types.js'
import { createEnv } from '../helpers/gateway.js'

const { rootCID, bytes } = await packFiles([
  { path: 'index.html', content: new TextEncoder().encode('hi') },
])
const CID = rootCID.toString()

type Env = ReturnType<typeof createEnv>['env']

const registered: string[] = []
const register = (
  name: string,
  upload: UploadFunction,
  supported: SupportedMethods = 'both',
  status?: () => Promise<{ pin: 'pinned' | 'queued' | 'failed' }>,
) => {
  const key = `${name.toUpperCase()}_TOKEN`
  PROVIDERS[key] = { name, upload, supported, protocol: 'ipfs', status }
  registered.push(key)
}

const echo: UploadFunction = async ({ cid }) => ({ cid, status: 'queued' })
const pinned = async () => ({ pin: 'pinned' as const })
const queued = async () => ({ pin: 'queued' as const })

// Runs steps immediately, without Cloudflare's retry delays.
const steps = () => {
  const names: string[] = []
  const step: Step = {
    do: async (name, _, callback) => {
      names.push(name)
      return JSON.parse(JSON.stringify((await callback()) ?? null))
    },
    sleep: async (name) => {
      names.push(name)
    },
  }
  return { names, step }
}

let env: Env
const car = 'app/1.car'

const config = (
  providers: string[],
  extra: Partial<GatewayConfig<Env>> = {},
): GatewayConfig<Env> => ({
  basePath: '/d',
  authenticate: () => null,
  tokens: () =>
    new Map(providers.map((p) => [`${p.toUpperCase()}_TOKEN`, 'token'])),
  providers,
  r2: () => ({
    accountId: 'a',
    bucketName: 'b',
    accessKeyId: 'c',
    secretAccessKey: 'd',
  }),
  rpcUrl: () => 'https://rpc.example',
  chainId: 1,
  limits: { maxCarBytes: 1 },
  ...extra,
})

const row = () =>
  env.DB.sqlite
    .prepare("SELECT * FROM omnipin_deployments WHERE id = '1'")
    .get() as {
    status: string
    error: string | null
    providers: string
  }

const run = (providers: string[], extra?: Partial<GatewayConfig<Env>>) => {
  const { names, step } = steps()
  return runDeployment({
    id: '1',
    env,
    step,
    config: config(providers, extra),
  }).then(() => names)
}

beforeEach(() => {
  ;({ env } = createEnv())
  env.DB.sqlite.exec(`
    INSERT INTO omnipin_deployments
      (id, user_id, name, cid, size, car_key, status, created_at)
    VALUES ('1', 'u', 'site', '${CID}', ${bytes.length}, '${car}', 'publishing', 0);
  `)
  env.CARS.objects.set(car, bytes)
})

afterEach(() => {
  for (const key of registered.splice(0)) delete PROVIDERS[key]
})

describe('runDeployment', () => {
  it('publishes a confirmed site and removes the temporary CAR', async () => {
    register('Up', echo, 'both', pinned)
    await run(['Up'])
    assert.strictEqual(row().status, 'published')
    assert.strictEqual(env.CARS.objects.has(car), false)
  })

  it('rejects a CAR that fails verification, touching no provider', async () => {
    let called = false
    register('Up', async ({ cid }) => {
      called = true
      return { cid }
    })
    env.CARS.objects.set(car, bytes.slice(0, bytes.length - 3))

    await run(['Up'])

    assert.strictEqual(row().status, 'rejected')
    assert.strictEqual(called, false)
    assert.strictEqual(env.CARS.objects.has(car), false)
  })

  it('sends bytes to one provider only', async () => {
    const sizes: Record<string, number> = {}
    const tracking =
      (name: string): UploadFunction =>
      async ({ bytes: received, cid }) => {
        sizes[name] = received.byteLength
        return { cid }
      }
    register('Up', tracking('Up'))
    register('Pin', tracking('Pin'), 'pin')

    await run(['Pin', 'Up'])

    assert.deepStrictEqual(sizes, { Up: bytes.length, Pin: 0 })
  })

  it('falls back to the next uploader', async () => {
    register('Down', async () => {
      throw new Error('down')
    })
    register('Up', echo, 'both', pinned)

    await run(['Down', 'Up'])

    assert.strictEqual(row().status, 'published')
    assert.deepStrictEqual(
      JSON.parse(row().providers).map((p: { status: string }) => p.status),
      ['failed', 'deployed'],
    )
  })

  it('fails when no provider accepts the site', async () => {
    register('Down', async () => {
      throw new Error('down')
    })
    await run(['Down'])
    assert.strictEqual(row().status, 'failed')
    assert.strictEqual(env.CARS.objects.has(car), false)
  })

  it('stays published when only a pin fails', async () => {
    register('Up', echo, 'both', pinned)
    register(
      'Pin',
      async () => {
        throw new Error('down')
      },
      'pin',
    )
    await run(['Up', 'Pin'])
    assert.strictEqual(row().status, 'published')
  })

  it('does not record raw provider errors', async () => {
    register('Down', async () => {
      throw new Error('401 for token sk_live_123')
    })
    await run(['Down'])
    assert.ok(!JSON.stringify(row()).includes('sk_live_123'))
  })

  it('polls until a provider confirms the pin', async () => {
    let checks = 0
    register('Up', echo, 'both', async () => ({
      pin: ++checks >= 2 ? 'pinned' : 'queued',
    }))

    const names = await run(['Up'])

    assert.deepStrictEqual(
      names.filter((n) => n.startsWith('pin')),
      ['pin status 0', 'pin wait 0', 'pin status 1'],
    )
    assert.strictEqual(JSON.parse(row().providers)[0].pin, 'pinned')
  })

  it('repeats only the step that failed when retried', async () => {
    let attempts = 0
    let pins = 0
    register(
      'Up',
      async ({ cid }) => {
        if (++attempts === 1) throw new Error('flaky')
        return { cid }
      },
      'both',
      pinned,
    )
    register(
      'Pin',
      async ({ cid }) => {
        pins++
        return { cid }
      },
      'pin',
    )

    const retrying: Step = {
      do: async (_, __, callback) => {
        try {
          return await callback()
        } catch {
          return callback()
        }
      },
      sleep: async () => {},
    }

    await runDeployment({
      id: '1',
      env,
      step: retrying,
      config: config(['Up', 'Pin']),
    })

    assert.strictEqual(attempts, 2)
    assert.strictEqual(pins, 1)
    assert.strictEqual(row().status, 'published')
  })

  it('finishes from a replay once earlier steps are cached', async () => {
    const cache = new Map<string, unknown>()
    let uploads = 0
    register(
      'Up',
      async ({ cid }) => {
        uploads++
        return { cid }
      },
      'both',
      pinned,
    )

    // Cloudflare replays `run` after an eviction, returning finished steps
    // from storage. The first pass dies partway through.
    const replayable = (dieAt?: string): Step => ({
      do: async (name, _, callback) => {
        if (cache.has(name)) return cache.get(name) as never
        if (name === dieAt) throw new Error('evicted')
        const result = await callback()
        cache.set(name, result)
        return result
      },
      sleep: async () => {},
    })

    await assert.rejects(
      runDeployment({
        id: '1',
        env,
        step: replayable('complete'),
        config: config(['Up']),
      }),
      /evicted/,
    )
    await runDeployment({
      id: '1',
      env,
      step: replayable(),
      config: config(['Up']),
    })

    assert.strictEqual(uploads, 1)
    assert.strictEqual(row().status, 'published')
  })

  it('does not publish what no provider has confirmed', async () => {
    register('Up', echo, 'both', queued)

    await run(['Up'])

    assert.strictEqual(row().status, 'pending')
    assert.strictEqual(env.CARS.objects.has(car), true)
  })

  it('stays pending when no provider can report a pin', async () => {
    register('Up', echo)
    await run(['Up'])
    assert.strictEqual(row().status, 'pending')
    assert.match(row().error ?? '', /can confirm/)
  })

  it('fails when every provider reports a failed pin', async () => {
    register('Up', echo, 'both', async () => ({ pin: 'failed' as const }))
    await run(['Up'])
    assert.strictEqual(row().status, 'failed')
    assert.strictEqual(env.CARS.objects.has(car), false)
  })

  it('holds DNSLink back until the site is confirmed', async () => {
    env.DB.sqlite.exec(
      "UPDATE omnipin_deployments SET dnslink = 'site.example.com' WHERE id = '1'",
    )
    const realFetch = globalThis.fetch
    let dnsCalls = 0
    globalThis.fetch = (async () => {
      dnsCalls++
      return Response.json({ result: [] })
    }) as typeof fetch

    register('Up', echo, 'both', queued)
    await run(['Up'], {
      dnslink: () => ({ apiKey: 'k', zoneId: 'z' }),
    })
    globalThis.fetch = realFetch

    assert.strictEqual(dnsCalls, 0)
  })

  it('gives each provider its own retryable step', async () => {
    register('Up', echo)
    register('Pin', echo, 'pin')
    const names = await run(['Up', 'Pin'])
    assert.ok(names.includes('upload: Up'))
    assert.ok(names.includes('pin: Pin'))
  })
})

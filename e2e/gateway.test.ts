import * as assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { createDeployClient, packSite, prepareSite } from '../dist/client.js'
import { packFiles } from '../dist/index.js'

// Runs the example app's Worker on Cloudflare's real runtime, with real
// Workflows and local D1 and R2. Only the outside world is stubbed: storage
// providers, and the S3 endpoint R2 has no local version of.

const API = 'http://app.test/api/deployments'

let mf: Miniflare
let client: ReturnType<typeof createDeployClient>
let uploadedBytes: number | undefined
let expectedCid: string
let pinStatus = 'pinned'
let workerSource: string
const realFetch = globalThis.fetch

const provider = async (request: Request) => {
  const { host } = new URL(request.url)

  if (host === 'uploads.pinata.cloud') {
    const form = await request.formData()
    uploadedBytes = (form.get('file') as File).size
    return Response.json({ data: { cid: expectedCid, id: 'x' } })
  }

  if (host === 'api.pinata.cloud')
    return Response.json({ count: 1, results: [{ status: pinStatus }] })

  return new Response('unexpected request', { status: 500 })
}

const site = (body: string) =>
  prepareSite([
    { path: 'dist/index.html', content: new Blob([body]) },
    {
      path: 'dist/a/big.bin',
      content: new Blob([new Uint8Array(2_000_000).map((_, i) => i % 251)]),
    },
  ]).files

before(async () => {
  const { outputFiles } = await build({
    entryPoints: ['examples/cloudflare-app/worker/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers'],
    alias: { 'omnipin-web-apps/worker': `${process.cwd()}/dist/worker.js` },
    logLevel: 'error',
  })

  workerSource = outputFiles[0].text

  mf = new Miniflare({
    modules: true,
    script: workerSource,
    compatibilityDate: '2026-06-01',
    d1Databases: { DB: 'db' },
    r2Buckets: { CARS: 'cars' },
    workflows: {
      DEPLOY_WORKFLOW: { name: 'omnipin-deploy', className: 'DeployWorkflow' },
    },
    bindings: {
      DEV_USER: 'alice',
      PINATA_TOKEN: 'token',
      R2_ACCOUNT_ID: 'account',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
      RPC_URL: 'https://rpc.test',
    },
    outboundService: provider as never,
  })

  const db = await mf.getD1Database('DB')
  const statements = readFileSync('src/worker/schema.sql', 'utf8')
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const statement of statements) await db.prepare(statement).run()
  const bucket = await mf.getR2Bucket('CARS')

  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const target = String(url)

    if (target.includes('.r2.cloudflarestorage.com')) {
      const key = decodeURIComponent(new URL(target).pathname).replace(
        '/my-app-cars/',
        '',
      )
      await bucket.put(
        key,
        new Uint8Array(await (init.body as Blob).arrayBuffer()),
      )
      return new Response(null, { status: 200 })
    }

    if (target.startsWith('http://app.test'))
      return mf.dispatchFetch(target, init as never)

    return realFetch(url, init)
  }) as typeof fetch

  client = createDeployClient({ apiBase: API, pollInterval: 100 })
})

after(async () => {
  globalThis.fetch = realFetch
  await mf?.dispose()
})

const settled = async (id: string) => {
  for (let i = 0; i < 400; i++) {
    const current = await client.status(id)
    if (current.status !== 'publishing') return current
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Deployment never settled')
}

describe('deploying through the gateway', () => {
  it('publishes a site and cleans up after itself', {
    timeout: 60_000,
  }, async () => {
    const files = site('<h1>hello</h1>')
    const packed = await packSite(files)
    expectedCid = packed.cid

    const stages: string[] = []
    const result = await client.deploy(files, {
      name: 'hello',
      onStage: (stage) => stages.push(stage),
    })

    assert.deepStrictEqual(stages, [
      'packing',
      'uploading',
      'publishing',
      'published',
    ])
    assert.strictEqual(result.status, 'published')
    assert.strictEqual(result.cid, packed.cid)
    assert.strictEqual(result.providers[0].pin, 'pinned')
    assert.strictEqual(uploadedBytes, packed.size)

    const bucket = await mf.getR2Bucket('CARS')
    assert.strictEqual((await bucket.list()).objects.length, 0)
  })

  it('computes the same CID in the browser client and the core', async () => {
    const body = new TextEncoder().encode('<h1>same</h1>')
    const browser = await packSite([
      { path: 'index.html', content: new Blob([body]) },
    ])
    const core = await packFiles([{ path: 'index.html', content: body }])
    assert.strictEqual(browser.cid, core.rootCID.toString())
  })

  it('rejects a CAR that was swapped under a false CID', {
    timeout: 60_000,
  }, async () => {
    const claimed = await packSite(site('<h1>real</h1>'))
    const swapped = await packSite(site('<h1>swapped</h1>'))

    const made = await mf.dispatchFetch(API, {
      method: 'POST',
      body: JSON.stringify({
        name: 'evil',
        cid: claimed.cid,
        size: swapped.size,
      }),
    })
    const { id } = (await made.json()) as { id: string }

    const db = await mf.getD1Database('DB')
    const row = await db
      .prepare('SELECT car_key FROM omnipin_deployments WHERE id = ?1')
      .bind(id)
      .first<{ car_key: string }>()
    const bucket = await mf.getR2Bucket('CARS')
    await bucket.put(
      row?.car_key as string,
      new Uint8Array(await swapped.car.arrayBuffer()),
    )

    uploadedBytes = undefined
    await mf.dispatchFetch(`${API}/${id}/start`, { method: 'POST' })

    const result = await settled(id)
    assert.strictEqual(result.status, 'rejected')
    assert.strictEqual(uploadedBytes, undefined)
  })

  it('leaves a site pending until a provider confirms it', {
    timeout: 60_000,
  }, async () => {
    const files = site('<h1>slow pin</h1>')
    expectedCid = (await packSite(files)).cid
    pinStatus = 'queued'

    // The workflow waits between checks, so follow it only as far as the
    // upload to show it hasn't claimed success.
    const { id } = (await (
      await mf.dispatchFetch(API, {
        method: 'POST',
        body: JSON.stringify({
          name: 'slow',
          cid: expectedCid,
          size: (await packSite(files)).size,
        }),
      })
    ).json()) as { id: string }

    const db = await mf.getD1Database('DB')
    const row = await db
      .prepare('SELECT car_key FROM omnipin_deployments WHERE id = ?1')
      .bind(id)
      .first<{ car_key: string }>()
    const bucket = await mf.getR2Bucket('CARS')
    await bucket.put(
      row?.car_key as string,
      new Uint8Array(await (await packSite(files)).car.arrayBuffer()),
    )
    await mf.dispatchFetch(`${API}/${id}/start`, { method: 'POST' })

    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.strictEqual((await client.status(id)).status, 'publishing')
    pinStatus = 'pinned'
  })

  it('refuses anyone the app hasn’t signed in', async () => {
    const locked = new Miniflare({
      modules: true,
      script: workerSource,
      compatibilityDate: '2026-06-01',
      d1Databases: { DB: 'locked' },
      r2Buckets: { CARS: 'locked' },
      workflows: {
        DEPLOY_WORKFLOW: {
          name: 'omnipin-deploy',
          className: 'DeployWorkflow',
        },
      },
      bindings: {
        PINATA_TOKEN: 'token',
        R2_ACCOUNT_ID: 'account',
        R2_ACCESS_KEY_ID: 'id',
        R2_SECRET_ACCESS_KEY: 'secret',
        RPC_URL: 'https://rpc.test',
      },
    })

    const res = await locked.dispatchFetch(API, { method: 'POST', body: '{}' })
    await locked.dispose()
    assert.strictEqual(res.status, 401)
  })
})

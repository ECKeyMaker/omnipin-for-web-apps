import * as assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { createDeployClient, packSite, prepareSite } from '../dist/client.js'
import {
  createSessionToken,
  deriveAppSecret,
  packFiles,
} from '../dist/index.js'

// Runs the built packages on Cloudflare's real runtime, with real Workflows
// and local D1 and R2. Only the outside world is stubbed: storage providers,
// and the S3 endpoint R2 has no local version of.

const ORIGIN = 'https://app.test'
const API = 'http://gateway.test/api/deployments'

let mf: Miniflare
let token: string
let client: ReturnType<typeof createDeployClient>
let uploadedBytes: number | undefined
let expectedCid: string
const failUploads = false
const realFetch = globalThis.fetch

const provider = async (request: Request) => {
  const { host } = new URL(request.url)

  if (host === 'uploads.pinata.cloud') {
    if (failUploads) return new Response('down', { status: 500 })
    const form = await request.formData()
    uploadedBytes = (form.get('file') as File).size
    return Response.json({ data: { cid: expectedCid, id: 'x' } })
  }

  if (host === 'api.pinata.cloud')
    return Response.json({ count: 1, results: [{ status: 'pinned' }] })

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

const authed = {
  headers: () => ({ Authorization: `Bearer ${token}`, Origin: ORIGIN }),
}

before(async () => {
  const { outputFiles } = await build({
    entryPoints: ['examples/cloudflare-gateway/src/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers'],
    alias: { 'omnipin-web-apps/worker': `${process.cwd()}/dist/worker.js` },
    logLevel: 'error',
  })

  mf = new Miniflare({
    modules: true,
    script: outputFiles[0].text,
    compatibilityDate: '2026-06-01',
    d1Databases: { DB: 'db' },
    r2Buckets: { CARS: 'cars' },
    workflows: {
      DEPLOY_WORKFLOW: { name: 'omnipin-deploy', className: 'DeployWorkflow' },
    },
    bindings: {
      MASTER_SECRET: 'master',
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
  await db
    .prepare(
      `INSERT INTO connected_apps (id, name, origins, daily_bytes, user_daily_deploys)
       VALUES ('app', 'App', '["${ORIGIN}"]', 1000000000, 50)`,
    )
    .run()

  token = await createSessionToken({
    appId: 'app',
    userId: 'alice',
    secret: await deriveAppSecret('master', 'app'),
  })

  const bucket = await mf.getR2Bucket('CARS')

  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const target = String(url)

    if (target.includes('.r2.cloudflarestorage.com')) {
      const key = decodeURIComponent(new URL(target).pathname).replace(
        '/omnipin-cars/',
        '',
      )
      await bucket.put(
        key,
        new Uint8Array(await (init.body as Blob).arrayBuffer()),
      )
      return new Response(null, { status: 200 })
    }

    if (target.startsWith('http://gateway.test'))
      return mf.dispatchFetch(target, {
        ...init,
        headers: { ...init.headers, Origin: ORIGIN },
      } as never)

    return realFetch(url, init)
  }) as typeof fetch

  client = createDeployClient({
    apiBase: API,
    getToken: () => token,
    pollInterval: 100,
  })
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
      headers: authed.headers(),
      body: JSON.stringify({
        name: 'evil',
        cid: claimed.cid,
        size: swapped.size,
      }),
    })
    const { id } = (await made.json()) as { id: string }

    const db = await mf.getD1Database('DB')
    const row = await db
      .prepare('SELECT car_key FROM deployments WHERE id = ?1')
      .bind(id)
      .first<{ car_key: string }>()
    const bucket = await mf.getR2Bucket('CARS')
    await bucket.put(
      row?.car_key as string,
      new Uint8Array(await swapped.car.arrayBuffer()),
    )

    uploadedBytes = undefined
    await mf.dispatchFetch(`${API}/${id}/start`, {
      method: 'POST',
      headers: authed.headers(),
    })

    const result = await settled(id)
    assert.strictEqual(result.status, 'rejected')
    assert.strictEqual(uploadedBytes, undefined)
  })

  it('refuses a request without a session', async () => {
    const res = await mf.dispatchFetch(API, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: '{}',
    })
    assert.strictEqual(res.status, 401)
  })
})

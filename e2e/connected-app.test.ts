import * as assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { verifySessionToken } from '../dist/index.js'

const SECRET = 'app-secret'
const dist = `${process.cwd()}/dist`
const alias = {
  'omnipin-web-apps/react': `${dist}/react.js`,
  'omnipin-web-apps': `${dist}/index.js`,
}

const start = async (bindings: Record<string, string>) => {
  const { outputFiles } = await build({
    entryPoints: ['examples/connected-app/worker/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    alias,
    logLevel: 'error',
  })
  return new Miniflare({
    modules: true,
    script: outputFiles[0].text,
    compatibilityDate: '2026-06-01',
    bindings: {
      OMNIPIN_APP_ID: 'your-app',
      OMNIPIN_APP_SECRET: SECRET,
      ...bindings,
    },
  })
}

describe('connected app example', () => {
  let locked: Miniflare
  let signedIn: Miniflare

  before(async () => {
    locked = await start({})
    signedIn = await start({ DEV_USER: 'alice' })
  })

  after(async () => {
    await locked?.dispose()
    await signedIn?.dispose()
  })

  const issue = (app: Miniflare, method = 'POST') =>
    app.dispatchFetch('http://app.test/api/omnipin-token', { method })

  it('refuses everyone until real auth is added', async () => {
    assert.strictEqual((await issue(locked)).status, 401)
  })

  it('refuses a token request by GET, so links can’t trigger it', async () => {
    assert.strictEqual((await issue(signedIn, 'GET')).status, 405)
  })

  it('issues a token the gateway accepts', async () => {
    const res = await issue(signedIn)
    assert.strictEqual(res.status, 200)
    const session = await verifySessionToken(await res.text(), () => SECRET)
    assert.strictEqual(session?.app, 'your-app')
    assert.strictEqual(session?.sub, 'alice')
  })

  it('has a frontend that bundles without the app secret', async () => {
    const { outputFiles } = await build({
      entryPoints: ['examples/connected-app/src/main.tsx'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      alias,
      logLevel: 'error',
    })
    assert.ok(outputFiles[0].text.includes('omnipin-token'))
    assert.ok(!outputFiles[0].text.includes('OMNIPIN_APP_SECRET'))
  })
})

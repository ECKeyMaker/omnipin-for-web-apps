import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  createSessionToken,
  deriveAppSecret,
  verifySessionToken,
} from '../../src/utils/session.js'

const secret = 'app-secret'
const secretFor = () => secret
const base = { appId: 'app', userId: 'user', secret }

describe('session tokens', () => {
  it('round-trips a session', async () => {
    const session = await verifySessionToken(
      await createSessionToken(base),
      secretFor,
    )
    assert.strictEqual(session?.app, 'app')
    assert.strictEqual(session?.sub, 'user')
  })

  it('rejects an expired token', async () => {
    const token = await createSessionToken({ ...base, expiresIn: 10, now: 0 })
    assert.strictEqual(
      await verifySessionToken(token, secretFor, 11_000),
      undefined,
    )
  })

  it('rejects another secret', async () => {
    const token = await createSessionToken({ ...base, secret: 'other' })
    assert.strictEqual(await verifySessionToken(token, secretFor), undefined)
  })

  it('rejects a changed payload', async () => {
    const [, signature] = (await createSessionToken(base)).split('.')
    const forged = btoa(
      JSON.stringify({ app: 'app', sub: 'admin', exp: 9_999_999_999 }),
    ).replaceAll('=', '')
    assert.strictEqual(
      await verifySessionToken(`${forged}.${signature}`, secretFor),
      undefined,
    )
  })

  it('rejects junk without throwing', async () => {
    for (const token of ['', 'a', 'a.b', 'a.b.c', '...', '%%.%%'])
      assert.strictEqual(await verifySessionToken(token, secretFor), undefined)
  })

  it('derives a different secret per app', async () => {
    assert.notStrictEqual(
      await deriveAppSecret('master', 'one'),
      await deriveAppSecret('master', 'two'),
    )
  })
})

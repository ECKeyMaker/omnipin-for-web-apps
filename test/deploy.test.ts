import * as assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { CID } from 'multiformats/cid'
import { PROVIDERS } from '../src/constants.js'
import { type DeployEvent, deploy, selectProviders } from '../src/deploy.js'
import {
  AllProvidersFailedError,
  DeployError,
  NoProvidersError,
  NoUploaderError,
} from '../src/errors.js'
import type { SupportedMethods, UploadFunction } from '../src/types.js'

const ROOT_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const OTHER_CID = 'bafybeibwzifw52ttrkqlikfzext5akxu7lz4xiwjgwzmqcpdzmp3n5vnoi'

const registered: string[] = []

const register = (
  name: string,
  upload: UploadFunction,
  supported: SupportedMethods = 'both',
) => {
  const key = `${name.toUpperCase()}_TOKEN`
  PROVIDERS[key] = { name, upload, supported, protocol: 'ipfs' }
  registered.push(key)
  return name
}

const echo: UploadFunction = async ({ cid }) => ({ cid, status: 'queued' })

const run = (names: string[], extra = {}) => {
  const tokens = new Map(
    names.map((name) => [`${name.toUpperCase()}_TOKEN`, 'token']),
  )
  return deploy({
    bytes: new Uint8Array(),
    name: 'site',
    size: 0,
    cid: ROOT_CID,
    tokens,
    selection: selectProviders(tokens, names),
    ...extra,
  })
}

afterEach(() => {
  for (const key of registered.splice(0)) delete PROVIDERS[key]
})

describe('deploy', () => {
  it('returns a result per provider and gateway links', async () => {
    const result = await run([register('Alpha', echo)])

    assert.strictEqual(result.protocol, 'ipfs')
    assert.strictEqual(result.cid, ROOT_CID)
    assert.deepStrictEqual(result.providers, [
      { name: 'Alpha', status: 'deployed', cid: ROOT_CID, pin: 'queued' },
    ])
    assert.strictEqual(
      result.urls.gateway,
      `https://${ROOT_CID}.ipfs.dweb.link`,
    )
  })

  it('reads credentials from tokens, not the environment', async () => {
    let received: string | undefined
    const name = register('Alpha', async ({ token, cid }) => {
      received = token
      return { cid }
    })
    await run([name])
    assert.strictEqual(received, 'token')
  })

  it('reports a partial failure without throwing', async () => {
    const result = await run([
      register('Alpha', echo),
      register('Beta', async () => {
        throw new Error('down')
      }),
    ])

    assert.deepStrictEqual(
      result.providers.map((p) => p.status),
      ['deployed', 'failed'],
    )
    assert.strictEqual(result.providers[1].error?.message, 'down')
  })

  it('treats a provider returning a different CID as failed', async () => {
    const result = await run([
      register('Alpha', echo),
      register('Liar', async () => ({ cid: OTHER_CID })),
    ])

    const liar = result.providers[1]
    assert.strictEqual(liar.status, 'failed')
    assert.ok(liar.error instanceof DeployError)
  })

  it('fails the deploy when the only provider returns a different CID', async () => {
    await assert.rejects(
      run([register('Liar', async () => ({ cid: OTHER_CID }))]),
      AllProvidersFailedError,
    )
  })

  it('accepts the same content under another CID encoding', async () => {
    const v0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
    const v1 = CID.parse(v0).toV1().toString()
    const name = register('Alpha', async () => ({ cid: v0 }))
    const result = await run([name], { cid: v1 })
    assert.strictEqual(result.providers[0].status, 'deployed')
  })

  it('throws when no provider can receive the bytes', async () => {
    await assert.rejects(
      run([register('Pinner', echo, 'pin')]),
      NoUploaderError,
    )
  })

  it('gives the bytes to exactly one provider, the uploader first', async () => {
    const firsts: Record<string, boolean> = {}
    const tracking =
      (name: string): UploadFunction =>
      async ({ first, cid }) => {
        firsts[name] = first
        return { cid }
      }

    await run([
      register('Pinner', tracking('Pinner'), 'pin'),
      register('Uploader', tracking('Uploader'), 'both'),
      register('Second', tracking('Second'), 'both'),
    ])

    assert.deepStrictEqual(firsts, {
      Pinner: false,
      Uploader: true,
      Second: false,
    })
  })

  it('reports progress through onEvent', async () => {
    const events: DeployEvent['type'][] = []
    await run([register('Alpha', echo)], {
      onEvent: (event: DeployEvent) => events.push(event.type),
    })
    assert.deepStrictEqual(events, ['start', 'success'])
  })

  it('stops when aborted', async () => {
    let called = false
    const name = register('Alpha', async ({ cid }) => {
      called = true
      return { cid }
    })
    await assert.rejects(
      run([name], { signal: AbortSignal.abort() }),
      /aborted/i,
    )
    assert.strictEqual(called, false)
  })

  it('refuses an IPFS deploy without a CID', async () => {
    await assert.rejects(
      run([register('Alpha', echo)], { cid: undefined }),
      /needs the CID/,
    )
  })
})

describe('selectProviders', () => {
  it('throws when nothing is configured', () => {
    assert.throws(() => selectProviders(new Map()), NoProvidersError)
  })

  it('derives providers from tokens', () => {
    const name = register('Alpha', echo)
    const { active } = selectProviders(new Map([['ALPHA_TOKEN', 'token']]))
    assert.deepStrictEqual(
      active.map((p) => p.name),
      [name],
    )
  })
})

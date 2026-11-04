import * as assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import {
  connectWallet,
  createDeployClient,
  type GatewayError,
} from '../../src/client/index.js'

const account = '0x00000000000000000000000000000000000000aa'
const call = { to: '0x00000000000000000000000000000000000000cc', data: '0x12' }
const realFetch = globalThis.fetch

const respond = (handler: (url: string, init: RequestInit) => Response) => {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) =>
    handler(String(url), init)) as typeof fetch
}

const client = () =>
  createDeployClient({
    apiBase: 'https://gateway.test/',
    getToken: () => 'token',
    pollInterval: 1,
  })

const site = [{ path: 'index.html', content: new Blob(['hi']) }]

const published = {
  id: '1',
  status: 'published',
  providers: [],
  urls: { gateway: 'https://x' },
}

const gateway =
  (statuses: object[]) =>
  (url: string, init: RequestInit): Response => {
    if (url.includes('storage')) return new Response(null, { status: 200 })
    if (url.endsWith('/') && init.method === 'POST')
      return Response.json({
        id: '1',
        uploadUrl: 'https://storage.test/put',
        contentType: 'application/vnd.ipld.car',
      })
    if (url.endsWith('/start')) return Response.json({})
    return Response.json(statuses.shift() ?? published)
  }

const wallet = (handlers: Record<string, unknown>) => {
  const calls: { method: string; params?: unknown[] }[] = []
  return {
    calls,
    request: async (args: { method: string; params?: unknown[] }) => {
      calls.push(args)
      const handler = handlers[args.method]
      if (handler instanceof Error) throw handler
      return handler
    },
  }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('deploy', () => {
  it('polls until publishing settles', async () => {
    respond(gateway([{ ...published, status: 'publishing' }, published]))
    const seen: string[] = []
    const result = await client().deploy(site, {
      name: 'site',
      onStatus: ({ status }) => seen.push(status),
    })
    assert.strictEqual(result.status, 'published')
    assert.deepStrictEqual(seen, ['publishing', 'published'])
  })

  it('returns a failed deployment without claiming it published', async () => {
    respond(gateway([{ ...published, status: 'failed', error: 'no' }]))
    const stages: string[] = []
    const result = await client().deploy(site, {
      name: 'site',
      onStage: (stage) => stages.push(stage),
    })
    assert.strictEqual(result.status, 'failed')
    assert.ok(!stages.includes('published'))
  })

  it('surfaces a gateway error with its status', async () => {
    respond(() =>
      Response.json({ error: 'Daily quota reached' }, { status: 429 }),
    )
    await assert.rejects(
      client().deploy(site, { name: 'site' }),
      (e: GatewayError) => e.status === 429 && /quota/.test(e.message),
    )
  })

  it('fails when the upload fails', async () => {
    const respondTo = gateway([])
    respond((url, init) =>
      url.includes('storage')
        ? new Response(null, { status: 403 })
        : respondTo(url, init),
    )
    await assert.rejects(
      client().deploy(site, { name: 'site' }),
      /Upload failed/,
    )
  })

  it('stops when aborted while publishing', async () => {
    const abort = new AbortController()
    respond(gateway([{ ...published, status: 'publishing' }]))
    await assert.rejects(
      client().deploy(site, {
        name: 'site',
        signal: abort.signal,
        onStatus: () => abort.abort(new Error('cancelled')),
      }),
      /cancelled/,
    )
  })

  it('stops before uploading when already aborted', async () => {
    let requests = 0
    respond(() => {
      requests++
      return Response.json({})
    })
    await assert.rejects(
      client().deploy(site, { name: 'site', signal: AbortSignal.abort() }),
    )
    assert.strictEqual(requests, 0)
  })
})

describe('updateEns through a Safe', () => {
  const safe = '0x00000000000000000000000000000000000000dd'

  const safeWallet = () => {
    const methods: string[] = []
    return {
      methods,
      request: async ({ method }: { method: string }) => {
        methods.push(method)
        if (method === 'eth_signTypedData_v4') return `0x${'ab'.repeat(65)}`
        return `0x${'00'.repeat(31)}07`
      },
    }
  }

  it('proposes with the owner’s wallet and sends no transaction', async () => {
    const proposals: { sender: string; nonce: string }[] = []
    respond((url, init) => {
      if (url.includes('api.safe.global')) {
        proposals.push(JSON.parse(init.body as string))
        return new Response('', { status: 201 })
      }
      return Response.json({ call, chainId: 11155111, sponsored: false })
    })
    const w = safeWallet()

    const result = await client().updateEns('1', {
      wallet: w,
      account,
      safe,
    })

    assert.ok(result.queueUrl?.includes(safe))
    assert.strictEqual(result.sponsored, false)
    assert.ok(w.methods.includes('eth_signTypedData_v4'))
    assert.ok(!w.methods.includes('eth_sendTransaction'))
    assert.ok(!w.methods.includes('wallet_sendCalls'))
    assert.strictEqual(proposals.length, 1)
    assert.strictEqual(proposals[0].sender.toLowerCase(), account)
    assert.strictEqual(proposals[0].nonce, '7')
  })

  it('does not sign if the update would revert', async () => {
    respond(() => Response.json({ call, chainId: 1, sponsored: false }))
    const methods: string[] = []
    await assert.rejects(
      client().updateEns('1', {
        account,
        safe,
        wallet: {
          request: async ({ method }: { method: string }) => {
            methods.push(method)
            throw new Error('execution reverted')
          },
        },
      }),
      /reverted/,
    )
    assert.ok(!methods.includes('eth_signTypedData_v4'))
  })

  it('refuses a chain Safe support doesn’t cover', async () => {
    respond(() => Response.json({ call, chainId: 10, sponsored: false }))
    await assert.rejects(
      client().updateEns('1', { wallet: safeWallet(), account, safe }),
      /isn't supported/,
    )
  })
})

describe('confirmEns', () => {
  it('resolves true once the chain matches', async () => {
    let checks = 0
    respond(() => Response.json({ confirmed: ++checks === 2 }))
    assert.strictEqual(await client().confirmEns('1', { interval: 1 }), true)
    assert.strictEqual(checks, 2)
  })

  it('gives up without calling it failed', async () => {
    respond(() => Response.json({ confirmed: false }))
    assert.strictEqual(
      await client().confirmEns('1', { attempts: 2, interval: 1 }),
      false,
    )
  })
})

describe('packing in a worker', () => {
  class FakeWorker {
    terminated = false
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: { message: string }) => void) | null = null
    postMessage() {}
    terminate() {
      this.terminated = true
    }
  }

  it('terminates the worker when cancelled', async () => {
    const worker = new FakeWorker()
    const abort = new AbortController()
    const running = createDeployClient({
      apiBase: 'https://gateway.test',
      getToken: () => 'token',
      createWorker: () => worker as unknown as Worker,
    }).deploy(site, { name: 'site', signal: abort.signal })

    abort.abort(new Error('cancelled'))

    await assert.rejects(running, /cancelled/)
    assert.strictEqual(worker.terminated, true)
  })

  it('forwards progress, then finishes', async () => {
    const worker = new FakeWorker()
    respond(gateway([]))
    const seen: number[] = []
    const running = createDeployClient({
      apiBase: 'https://gateway.test',
      getToken: () => 'token',
      pollInterval: 1,
      createWorker: () => {
        queueMicrotask(() => {
          worker.onmessage?.({ data: { progress: { done: 1, total: 2 } } })
          worker.onmessage?.({
            data: { site: { cid: 'x', car: new Blob(['x']), size: 1 } },
          })
        })
        return worker as unknown as Worker
      },
    }).deploy(site, {
      name: 'site',
      onProgress: ({ done }) => seen.push(done),
    })

    assert.strictEqual((await running).status, 'published')
    assert.deepStrictEqual(seen, [1])
    assert.strictEqual(worker.terminated, true)
  })
})

describe('updateEns', () => {
  const sponsoredPlan = {
    call,
    sponsored: true,
    chainId: 1,
    paymasterUrl: 'https://gateway.test/paymaster?token=t',
  }

  it('uses the paymaster when the wallet supports it', async () => {
    respond(() => Response.json(sponsoredPlan))
    const w = wallet({
      wallet_getCapabilities: {
        '0x1': { paymasterService: { supported: true } },
      },
      wallet_sendCalls: { id: 'bundle' },
    })

    const result = await client().updateEns('1', { wallet: w, account })

    assert.deepStrictEqual(result, { sponsored: true, reference: 'bundle' })
    const sent = w.calls.at(-1)?.params?.[0] as {
      capabilities: { paymasterService: { url: string } }
    }
    assert.strictEqual(
      sent.capabilities.paymasterService.url,
      sponsoredPlan.paymasterUrl,
    )
  })

  it('falls back to a normal transaction on older wallets', async () => {
    respond(() => Response.json(sponsoredPlan))
    const w = wallet({
      wallet_getCapabilities: new Error('Method not supported'),
      eth_sendTransaction: '0xhash',
    })
    assert.deepStrictEqual(
      await client().updateEns('1', { wallet: w, account }),
      { sponsored: false, reference: '0xhash' },
    )
  })

  it('falls back when sponsorship is off for the chain', async () => {
    respond(() => Response.json(sponsoredPlan))
    const w = wallet({
      wallet_getCapabilities: {
        '0xa': { paymasterService: { supported: true } },
      },
      eth_sendTransaction: '0xhash',
    })
    const { sponsored } = await client().updateEns('1', { wallet: w, account })
    assert.strictEqual(sponsored, false)
  })

  it('does not send anything if the user rejects the prompt', async () => {
    respond(() => Response.json({ call, sponsored: false }))
    const w = wallet({ eth_sendTransaction: new Error('User rejected') })
    await assert.rejects(
      client().updateEns('1', { wallet: w, account }),
      /User rejected/,
    )
  })

  it('never falls back to paying when a sponsored send is rejected', async () => {
    respond(() => Response.json(sponsoredPlan))
    const w = wallet({
      wallet_getCapabilities: {
        '0x1': { paymasterService: { supported: true } },
      },
      wallet_sendCalls: new Error('User rejected'),
    })
    await assert.rejects(client().updateEns('1', { wallet: w, account }))
    assert.ok(!w.calls.some((c) => c.method === 'eth_sendTransaction'))
  })
})

describe('connectWallet', () => {
  it('returns the first account', async () => {
    const w = wallet({ eth_requestAccounts: [account] })
    assert.strictEqual(await connectWallet(w), account)
  })

  it('fails clearly when no account is shared', async () => {
    const w = wallet({ eth_requestAccounts: [] })
    await assert.rejects(connectWallet(w), /did not share/)
  })
})

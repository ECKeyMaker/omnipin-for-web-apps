import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import type { Provider } from 'ox/Provider'
import { recoverAddress } from 'ox/Secp256k1'
import { fromHex } from 'ox/Signature'
import { getSignPayload } from 'ox/TypedData'
import {
  privateKeySigner,
  serializeTypedData,
  walletSigner,
} from '../../src/utils/signer.js'

const typedData = {
  types: { Ping: [{ name: 'n', type: 'uint256' }] },
  primaryType: 'Ping',
  domain: { chainId: 1n },
  message: { n: 7n },
} as const

const address = '0x00000000000000000000000000000000000000aa'

describe('signers', () => {
  it('privateKeySigner signs typed data for its own address', async () => {
    const signer = privateKeySigner({
      privateKey: `0x${'11'.repeat(32)}`,
      provider: {} as Provider,
      chainId: 1,
    })
    const signature = await signer.signTypedData(typedData)
    assert.strictEqual(
      recoverAddress({
        payload: getSignPayload(typedData),
        signature: fromHex(signature),
      }),
      signer.address,
    )
  })

  it('serializes bigints and declares the domain for wallets', () => {
    const parsed = JSON.parse(serializeTypedData(typedData))
    assert.strictEqual(parsed.message.n, '7')
    assert.deepStrictEqual(parsed.types.EIP712Domain, [
      { name: 'chainId', type: 'uint256' },
    ])
  })

  it('walletSigner sends through the wallet, holding no key', async () => {
    const calls: { method: string; params?: unknown[] }[] = []
    const signer = walletSigner({
      address,
      wallet: {
        request: async (args) => {
          calls.push(args)
          return '0xabc'
        },
      },
    })

    assert.strictEqual(
      await signer.sendTransaction({ to: address, data: '0x12', value: 255n }),
      '0xabc',
    )
    assert.strictEqual(calls[0].method, 'eth_sendTransaction')
    assert.deepStrictEqual(calls[0].params, [
      { from: address, to: address, data: '0x12', value: '0xff' },
    ])
  })

  it('walletSigner surfaces a rejected prompt', async () => {
    const signer = walletSigner({
      address,
      wallet: {
        request: async () => {
          throw new Error('User rejected')
        },
      },
    })
    await assert.rejects(signer.signTypedData(typedData), /User rejected/)
  })
})

import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import { size, slice } from 'ox/Hex'
import {
  approveOperation,
  maxCost,
  paymasterHash,
  paymasterStub,
  type UserOperation,
} from '../../src/worker/paymaster.js'

// The same values are pinned in contracts/test/SponsorPaymaster.t.sol
// (test_hashAndSignatureMatchTheGateway). If either side changes, both tests
// fail, because a mismatch would make the paymaster reject every approval.
const paymaster = '0x00000000000000000000000000000000000000AA'
const op: UserOperation = {
  sender: '0x00000000000000000000000000000000000000BB',
  nonce: '0x5',
  callData: '0xdeadbeef',
  callGasLimit: '0x30d40',
  verificationGasLimit: '0x30d40',
  preVerificationGas: '0xc350',
  maxFeePerGas: '0x2540be400',
  maxPriorityFeePerGas: '0x3b9aca00',
}
const signerKey =
  '0x00000000000000000000000000000000000000000000000000000000000516e4'
const chainId = 11155111
const validUntil = 1_900_000_000

const EXPECTED_HASH =
  '0xea42cd66d7e02361929039eb82a1987af1f5676585ab03924f7638d024a1c434'
const EXPECTED_DATA =
  '0x0000713fb300000000000000b92190824049754d438013fdcc34266013b448ddd231e44606a86ef7b4d1ea5c22bc71d72a1b9e32e0ebe758019f361294c3199476bc8c969446552c2471129a1c'

describe('paymaster', () => {
  it('matches the vector the contract test pins', () => {
    assert.strictEqual(
      paymasterHash({ op, paymaster, chainId, validUntil, validAfter: 0 }),
      EXPECTED_HASH,
    )
    assert.strictEqual(
      approveOperation({
        op,
        paymaster,
        chainId,
        signerKey,
        lifetime: 100,
        now: (validUntil - 100) * 1000,
      }).paymasterData,
      EXPECTED_DATA,
    )
  })

  it('computes the worst-case cost from every gas limit', () => {
    const gas = 200_000n + 200_000n + 50_000n + 100_000n
    assert.strictEqual(maxCost(op), gas * 10_000_000_000n)
  })

  it('binds validity into paymaster data', () => {
    const { paymasterData } = approveOperation({
      op,
      paymaster,
      chainId,
      signerKey,
      lifetime: 300,
      now: 1_000_000,
    })
    assert.strictEqual(Number(slice(paymasterData, 0, 6)), 1300)
    assert.strictEqual(Number(slice(paymasterData, 6, 12)), 0)
  })

  it('changes the hash when any bound field changes', () => {
    const base = { op, paymaster, chainId, validUntil, validAfter: 0 } as const
    const original = paymasterHash(base)
    assert.notStrictEqual(
      paymasterHash({ ...base, op: { ...op, callData: '0xdeadbeee' } }),
      original,
    )
    assert.notStrictEqual(paymasterHash({ ...base, chainId: 1 }), original)
    assert.notStrictEqual(paymasterHash({ ...base, validUntil: 1 }), original)
  })

  it('stubs with a 65-byte placeholder signature', () => {
    assert.strictEqual(size(paymasterStub(paymaster).paymasterData), 77)
  })
})

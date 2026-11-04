import * as AbiParameters from 'ox/AbiParameters'
import type { Address } from 'ox/Address'
import { keccak256 } from 'ox/Hash'
import { concat, fromNumber, type Hex, padLeft, size, toBigInt } from 'ox/Hex'
import { getSignPayload } from 'ox/PersonalMessage'
import { sign } from 'ox/Secp256k1'
import { toHex } from 'ox/Signature'

/** ERC-4337 EntryPoint v0.7, at the same address on every chain. */
export const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

const VERIFICATION_GAS = 100_000n
const POST_OP_GAS = 0n

/** A v0.7 user operation, as ERC-7677 delivers it. */
export type UserOperation = {
  sender: Address
  nonce: Hex
  factory?: Address | null
  factoryData?: Hex | null
  callData: Hex
  callGasLimit: Hex
  verificationGasLimit: Hex
  preVerificationGas: Hex
  maxFeePerGas: Hex
  maxPriorityFeePerGas: Hex
}

const pack128 = (high: Hex | bigint, low: Hex | bigint): Hex =>
  concat(
    padLeft(fromNumber(BigInt(high)), 16),
    padLeft(fromNumber(BigInt(low)), 16),
  )

const paymasterPrefix = (paymaster: Address): Hex =>
  concat(paymaster, pack128(VERIFICATION_GAS, POST_OP_GAS))

/** Mirrors `SponsorPaymaster.getHash`. */
export const paymasterHash = ({
  op,
  paymaster,
  chainId,
  validUntil,
  validAfter,
}: {
  op: UserOperation
  paymaster: Address
  chainId: number
  validUntil: number
  validAfter: number
}): Hex =>
  keccak256(
    AbiParameters.encode(
      AbiParameters.from(
        'address, uint256, bytes32, bytes32, bytes32, bytes32, uint256, bytes32, uint256, address, uint48, uint48',
      ),
      [
        op.sender,
        toBigInt(op.nonce),
        keccak256(
          op.factory ? concat(op.factory, op.factoryData ?? '0x') : '0x',
        ),
        keccak256(op.callData),
        pack128(op.verificationGasLimit, op.callGasLimit),
        keccak256(paymasterPrefix(paymaster)),
        toBigInt(op.preVerificationGas),
        pack128(op.maxPriorityFeePerGas, op.maxFeePerGas),
        BigInt(chainId),
        paymaster,
        validUntil,
        validAfter,
      ],
    ),
  )

/** Most the EntryPoint could charge the paymaster for an operation. */
export const maxCost = (op: UserOperation): bigint =>
  (toBigInt(op.callGasLimit) +
    toBigInt(op.verificationGasLimit) +
    toBigInt(op.preVerificationGas) +
    VERIFICATION_GAS +
    POST_OP_GAS) *
  toBigInt(op.maxFeePerGas)

const timestamps = (validUntil: number, validAfter: number): Hex =>
  concat(padLeft(fromNumber(validUntil), 6), padLeft(fromNumber(validAfter), 6))

const gasFields = (paymaster: Address) => ({
  paymaster,
  paymasterVerificationGasLimit: fromNumber(VERIFICATION_GAS),
  paymasterPostOpGasLimit: fromNumber(POST_OP_GAS),
})

/** ERC-7677 stub, used by wallets for gas estimation only. */
export const paymasterStub = (paymaster: Address) => ({
  ...gasFields(paymaster),
  paymasterData: concat(timestamps(0, 0), padLeft('0x', 65)),
  isFinal: false,
})

/** ERC-7677 final data: the gateway's approval of this exact operation. */
export const approveOperation = ({
  op,
  paymaster,
  chainId,
  signerKey,
  lifetime,
  now,
}: {
  op: UserOperation
  paymaster: Address
  chainId: number
  signerKey: Hex
  lifetime: number
  now: number
}) => {
  const validUntil = Math.floor(now / 1000) + lifetime
  const hash = paymasterHash({
    op,
    paymaster,
    chainId,
    validUntil,
    validAfter: 0,
  })
  const signature = toHex(
    sign({ payload: getSignPayload(hash), privateKey: signerKey }),
  )

  if (size(signature) !== 65) throw new Error('Unexpected signature length')

  return {
    ...gasFields(paymaster),
    paymasterData: concat(timestamps(validUntil, 0), signature),
  }
}

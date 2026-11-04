import { type Address, fromPublicKey } from 'ox/Address'
import type { Hex } from 'ox/Hex'
import type { Provider } from 'ox/Provider'
import { getPublicKey, sign } from 'ox/Secp256k1'
import { toHex } from 'ox/Signature'
import { getSignPayload } from 'ox/TypedData'
import { sendTransaction } from './tx.js'

export type TypedData = Parameters<typeof getSignPayload>[0]

export type Call = { to: Address; data: Hex; value?: bigint }

/**
 * Something that can act for an account. Code that changes on-chain state
 * takes a `Signer`, so it never needs to know whether a raw key (CLI) or a
 * browser wallet is behind it.
 */
export type Signer = {
  address: Address
  sendTransaction: (call: Call) => Promise<Hex>
  signTypedData: (data: TypedData) => Promise<Hex>
}

export const privateKeySigner = ({
  privateKey,
  provider,
  chainId,
}: {
  privateKey: Hex
  provider: Provider
  chainId: number
}): Signer => {
  const address = fromPublicKey(getPublicKey({ privateKey }))

  return {
    address,
    sendTransaction: (call) =>
      sendTransaction({
        ...call,
        privateKey,
        provider,
        chainId,
        from: address,
      }),
    signTypedData: async (data) =>
      toHex(sign({ payload: getSignPayload(data), privateKey })),
  }
}

/** Minimal EIP-1193 surface, which `window.ethereum` and wallet SDKs provide. */
export type WalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

const domainFields = {
  name: { name: 'name', type: 'string' },
  version: { name: 'version', type: 'string' },
  chainId: { name: 'chainId', type: 'uint256' },
  verifyingContract: { name: 'verifyingContract', type: 'address' },
  salt: { name: 'salt', type: 'bytes32' },
} as const

/** JSON for `eth_signTypedData_v4`, which can't carry `bigint` and needs `EIP712Domain`. */
export const serializeTypedData = (data: TypedData): string => {
  const domain = (data.domain ?? {}) as Record<string, unknown>

  return JSON.stringify(
    {
      ...data,
      domain,
      types: {
        EIP712Domain: Object.entries(domainFields)
          .filter(([key]) => domain[key] !== undefined)
          .map(([, field]) => field),
        ...data.types,
      },
    },
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
  )
}

/** Act through a connected browser wallet. Every action prompts its user. */
export const walletSigner = ({
  wallet,
  address,
}: {
  wallet: WalletProvider
  address: Address
}): Signer => ({
  address,
  sendTransaction: async ({ to, data, value = 0n }) =>
    (await wallet.request({
      method: 'eth_sendTransaction',
      params: [{ from: address, to, data, value: `0x${value.toString(16)}` }],
    })) as Hex,
  signTypedData: async (data) =>
    (await wallet.request({
      method: 'eth_signTypedData_v4',
      params: [address, serializeTypedData(data)],
    })) as Hex,
})

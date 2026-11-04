import { decodeResult, encodeData } from 'ox/AbiFunction'
import type { Address } from 'ox/Address'
import type { Hex } from 'ox/Hex'
import { toBigInt } from 'ox/Hex'
import type { Provider } from 'ox/Provider'
import { chains } from './constants.js'
import type { ChainName } from './types.js'
import { getEnsResolver } from './utils/ens/get-resolver.js'
import {
  dnsEncodeName,
  setContentHashV2,
  supportsV2Contenthash,
} from './utils/ens/permissioned-resolver.js'
import { prepareUpdateEnsArgs, setContentHash } from './utils/ens.js'
import { assertCID } from './utils/ipfs.js'
import { getNonce } from './utils/safe/constants.js'
import { proposeTransaction } from './utils/safe/propose.js'
import { OperationType, type SafeTransactionData } from './utils/safe/types.js'
import {
  prepareSafeTransactionData,
  safeTransactionTypedData,
} from './utils/safe.js'
import type { Signer, TypedData } from './utils/signer.js'
import { SIMULATION_GAS_LIMIT, simulateTransaction } from './utils/tx.js'

const contenthash = {
  name: 'contenthash',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }],
  outputs: [{ name: '', type: 'bytes' }],
} as const

export type EnsUpdate = {
  to: Address
  data: Hex
  node: Hex
  /** Encoded contenthash, as the resolver stores it. */
  contentHash: Hex
}

/**
 * Build the call that points an ENS name at a CID. ENSv2 resolvers take a
 * DNS-encoded name; the ENSv1 public resolver takes the namehash.
 */
export const prepareEnsUpdate = async ({
  provider,
  domain,
  cid,
}: {
  provider: Provider
  domain: string
  cid: string
}): Promise<EnsUpdate> => {
  assertCID(cid)
  if (!domain.endsWith('.eth')) throw new Error('Domain must end with .eth')

  const { contentHash, node } = prepareUpdateEnsArgs({
    cid,
    domain,
    codec: cid.length === 64 ? 'swarm' : 'ipfs',
  })

  const to = await getEnsResolver({ provider, name: domain })
  const encoded: Hex = `0x${contentHash}`

  const data = (await supportsV2Contenthash({ provider, address: to }))
    ? encodeData(setContentHashV2, [dnsEncodeName(domain), encoded])
    : encodeData(setContentHash, [node, encoded])

  return { to, data, node, contentHash: encoded }
}

/**
 * Surface a revert (wrong resolver, no permission on the name) before anyone
 * signs.
 */
export const simulateEnsUpdate = (
  provider: Provider,
  { to, data }: EnsUpdate,
  from: Address,
): Promise<unknown> => simulateTransaction({ provider, to, data, from })

/** Read back what the resolver currently stores for a name. */
export const readContenthash = async ({
  provider,
  resolver,
  node,
}: {
  provider: Provider
  resolver: Address
  node: Hex
}): Promise<Hex> =>
  decodeResult(
    contenthash,
    await provider.request({
      method: 'eth_call',
      params: [
        {
          to: resolver,
          data: encodeData(contenthash, [node]),
          gas: SIMULATION_GAS_LIMIT,
        },
        'latest',
      ],
    }),
  )

/**
 * Propose an ENS update to a Safe. This only queues it: nothing changes on
 * chain until enough owners approve and someone executes the transaction.
 *
 * The signer must be an owner of the Safe. `dryRun` stops short of proposing.
 */
export const proposeEnsUpdate = async ({
  signer,
  provider,
  update,
  safe,
  chainName,
  dryRun = false,
}: {
  signer: Signer
  provider: Provider
  update: EnsUpdate
  safe: Address
  chainName: ChainName
  dryRun?: boolean
}): Promise<{ safeTxHash: Hex; queueUrl: string }> => {
  const chainId = chains[chainName].id

  // Surface revert reasons before anyone signs. `from` is the Safe, so this
  // sees the call exactly as the multisig will eventually make it.
  await simulateEnsUpdate(provider, update, safe)

  const nonce = toBigInt(
    await provider.request({
      method: 'eth_call',
      params: [
        { to: safe, data: encodeData(getNonce), gas: SIMULATION_GAS_LIMIT },
        'latest',
      ],
    }),
  )

  const txData: SafeTransactionData = {
    nonce,
    operation: OperationType.Call,
    to: update.to,
    data: update.data,
    value: 0n,
  }

  const { safeTxHash } = await prepareSafeTransactionData({
    txData,
    safeAddress: safe,
    chainId,
    provider,
  })

  const senderSignature = await signer.signTypedData(
    safeTransactionTypedData({
      txData,
      safeAddress: safe,
      chainId,
    }) as unknown as TypedData,
  )

  if (!dryRun)
    await proposeTransaction({
      txData,
      safeAddress: safe,
      safeTxHash,
      senderSignature,
      chainId,
      chainName,
      address: signer.address,
    })

  return {
    safeTxHash,
    queueUrl: `https://app.safe.global/transactions/queue?safe=${safe}`,
  }
}

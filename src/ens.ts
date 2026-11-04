import { decodeResult, encodeData } from 'ox/AbiFunction'
import type { Address } from 'ox/Address'
import type { Hex } from 'ox/Hex'
import type { Provider } from 'ox/Provider'
import { getEnsResolver } from './utils/ens/get-resolver.js'
import {
  dnsEncodeName,
  setContentHashV2,
  supportsV2Contenthash,
} from './utils/ens/permissioned-resolver.js'
import { prepareUpdateEnsArgs, setContentHash } from './utils/ens.js'
import { assertCID } from './utils/ipfs.js'
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
 * signs or anything is sponsored.
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

import { type Address, checksum, fromPublicKey } from 'ox/Address'
import type { Hex } from 'ox/Hex'
import * as Provider from 'ox/Provider'
import { fromHttp } from 'ox/RpcTransport'
import { getPublicKey } from 'ox/Secp256k1'
import { chains, isTTY } from '../constants.js'
import { styleText } from '../deps.js'
import {
  prepareEnsUpdate,
  proposeEnsUpdate,
  simulateEnsUpdate,
} from '../ens.js'
import { MissingCLIArgsError, MissingKeyError } from '../errors.js'
import type { ChainName } from '../types.js'
import { getExactAddress } from '../utils/address/getExactAddress.js'
import { resolveEnsName } from '../utils/ens/resolve-name.js'
import { chainToRpcUrl, type EnsName } from '../utils/ens.js'
import { assertCID } from '../utils/ipfs.js'
import { logger } from '../utils/logger.js'
import {
  type EIP3770Address,
  getEip3770Address,
} from '../utils/safe/eip3770.js'
import { privateKeySigner } from '../utils/signer.js'
import { waitForTransaction } from '../utils/tx.js'

export type EnsActionArgs = Partial<{
  chain: ChainName
  safe: Address | EIP3770Address | EnsName
  'rpc-url': string
  verbose: boolean
  'dry-run': boolean
}>

export const ensAction = async ({
  cid,
  domain,
  options = {},
}: {
  cid: string
  domain: string
  options: EnsActionArgs
}) => {
  const {
    chain: chainName = 'mainnet',
    safe: safeAddress,
    'rpc-url': rpcUrl,
    'dry-run': dryRun,
  } = options

  assertCID(cid)
  if (!domain) throw new MissingCLIArgsError(['domain'])
  const chain = chains[chainName]

  const transport = fromHttp(rpcUrl ?? chainToRpcUrl(chainName))

  const provider = Provider.from(transport)

  const pk = process.env.OMNIPIN_PK as Hex

  if (!pk) throw new MissingKeyError('PK')

  const address = fromPublicKey(getPublicKey({ privateKey: pk }))

  if (options.verbose)
    logger.info(`Validating transaction for wallet ${address}`)

  const from = safeAddress
    ? await getExactAddress({ chain, addressOrEns: safeAddress, provider })
    : address

  const update = await prepareEnsUpdate({ provider, domain, cid })
  const { to: resolverAddress, data } = update

  if (options.verbose) console.log('Transaction encoded data:', data)

  const signer = privateKeySigner({
    privateKey: pk,
    provider,
    chainId: chain.id,
  })

  if (safeAddress) {
    logger.info(
      `Preparing a transaction for Safe ${safeAddress} on ${chainName}`,
    )

    const { address: safe } = getEip3770Address({
      fullAddress: from,
      chainId: chain.id,
    })

    try {
      const { safeTxHash } = await proposeEnsUpdate({
        signer,
        provider,
        update,
        safe: checksum(safe),
        chainName,
        dryRun,
      })

      logger.info(`Signed a Safe transaction with a hash ${safeTxHash}`)
    } catch (e) {
      // Re-throw so the CLI exits with a non-zero status. Swallowing this
      // here made `omnipin ens` report success even when the Safe proposal
      // never went through (e.g. in CI), masking real failures.
      throw new Error('Failed to propose a transaction', { cause: e })
    }

    if (!dryRun) {
      const resolved = safeAddress.endsWith('.eth')
        ? await resolveEnsName({ name: safeAddress, provider })
        : safeAddress
      const safeLink = `https://app.safe.global/transactions/queue?safe=${resolved}`
      logger.success(
        `Transaction proposed to a Safe wallet.\nOpen in a browser: ${
          isTTY ? styleText('underline', safeLink) : safeLink
        }`,
      )
    }
  } else {
    await simulateEnsUpdate(provider, update, from)

    if (!dryRun) {
      const hash = await signer.sendTransaction({
        to: resolverAddress,
        data,
      })

      logger.info(
        `Transaction pending: ${chain.blockExplorers.default.url}/tx/${hash}`,
      )

      await waitForTransaction(provider, hash)

      logger.success('Transaction succeeded')
      const browserLink = `https://${domain}.limo`
      logger.info(
        `Open in a browser: ${isTTY ? styleText('underline', browserLink) : browserLink}`,
      )
    }
  }
}

import '../providers/node.js'

import { isTTY } from '../constants.js'
import { type DeployEvent, deploy, selectProviders } from '../deploy.js'
import { styleText } from '../deps.js'
import { AllProvidersFailedError } from '../errors.js'
import { AsciiBar } from '../utils/ascii-bar.js'
import { parseTokensFromEnv } from '../utils/env.js'
import { deployMessage, logger } from '../utils/logger.js'
import { dnsLinkAction } from './dnslink.js'
import { type EnsActionArgs, ensAction } from './ens.js'
import { type PackActionArgs, packAction } from './pack.js'

export type DeployActionArgs = Partial<{
  strict: boolean
  ens: string
  providers: string
  dnslink: string
  'progress-bar': boolean
  'skip-pinned': boolean
  'filecoin-chain': 'mainnet' | 'calibration'
  'filecoin-force-new-dataset': boolean
}> &
  PackActionArgs &
  EnsActionArgs

export const deployAction = async ({
  dir,
  options = {},
}: {
  dir?: string
  options?: DeployActionArgs
}) => {
  const {
    strict,
    ens,
    chain = 'mainnet',
    name: customName,
    dist,
    verbose = false,
    providers: providersList,
    dnslink,
    'progress-bar': progressBar,
    'skip-pinned': skipPinned,
    'filecoin-chain': filecoinChain,
    'filecoin-force-new-dataset': filecoinForceNewDataset,
    ...opts
  } = options

  const tokens = parseTokensFromEnv()
  const selection = selectProviders(tokens, providersList?.split(','))
  const isSwarm = selection.protocol === 'swarm'

  logger.info(
    `Deploying with providers: ${selection.active.map((p) => p.name).join(', ')}`,
  )

  const packed = await packAction({
    dir,
    options: { name: customName, dist, verbose, tar: isSwarm },
  })

  if (isSwarm && skipPinned)
    logger.warn('skip-pinned has no effect on Swarm deploys and is ignored')

  const bar =
    isTTY && progressBar
      ? new AsciiBar({
          total: selection.active.length,
          hideCursor: false,
          enableSpinner: true,
          width: process.stdout.columns - 30,
        })
      : undefined

  let total = 0

  const onEvent = (event: DeployEvent) => {
    switch (event.type) {
      case 'already-pinned':
        return logger.info(`Skipping ${event.provider} (already pinned)`)
      case 'status-unknown':
        if (verbose)
          logger.warn(
            `Could not check pin status on ${event.provider}, deploying anyway:`,
            event.error,
          )
        return
      case 'skip':
        return bar?.update(total++, `⏭ ${event.provider} (already pinned)`)
      case 'start':
        return bar?.update(
          total++,
          deployMessage(event.provider.name, event.provider.supported),
        )
    }
  }

  let result: Awaited<ReturnType<typeof deploy>>

  try {
    result = await deploy({
      bytes: packed.bytes as Uint8Array<ArrayBuffer>,
      name: packed.name,
      size: packed.size,
      cid: packed.cid,
      path: packed.path,
      tokens,
      selection,
      strict,
      skipPinned,
      verbose,
      filecoinChain,
      filecoinForceNewDataset,
      onEvent,
    })
  } catch (e) {
    if (e instanceof AllProvidersFailedError) {
      logger.error('Deploy failed')
      e.errors.forEach((error) => {
        logger.error(error)
      })
    }
    throw e
  }

  bar?.update(total)

  const { cid, providers, urls, swarmCid } = result
  const failed = providers.filter((p) => p.status === 'failed')

  if (failed.length) {
    logger.warn('There were some problems with deploying')
    failed.forEach((p) => {
      logger.error(p.error)
    })
  } else if (providers.every((p) => p.status === 'skipped'))
    logger.success('All providers already pin this CID')
  else logger.success('Deployed across all providers')

  if (swarmCid) {
    logger.success('Deployed on Swarm')
    logger.info(`Swarm Reference ID: ${cid}`)
    console.log(`\nOpen in a browser: ${urls.gateway} `)
  } else {
    const dwebLink = urls.gateway
    const providersLink = urls.providers as string

    console.log(
      `\nOpen in a browser:\n${isTTY ? styleText('bold', 'IPFS') : 'IPFS'}:      ${
        isTTY ? styleText('underline', dwebLink) : dwebLink
      }\n${isTTY ? styleText('bold', 'Providers') : 'Providers'}: ${
        isTTY ? styleText('underline', providersLink) : providersLink
      }`,
    )
  }

  if (typeof ens === 'string') {
    console.log('\n')
    await ensAction({
      cid,
      domain: ens,
      options: { ...opts, chain, verbose },
    })
  }

  if (dnslink) {
    if (isSwarm) throw new Error('DNSLink is not supported with Swarm')
    await dnsLinkAction({ cid, name: dnslink, options: { verbose } })
  }
}

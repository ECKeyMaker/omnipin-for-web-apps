import { PROVIDERS } from './constants.js'
import {
  AllProvidersFailedError,
  DeployError,
  NoProvidersError,
  NoUploaderError,
} from './errors.js'
import type { PinStatus } from './types.js'
import {
  findEnvVarProviderName,
  parseBoolean,
  parseNumber,
  tokensToProviderNames,
} from './utils/env.js'
import { isSameCID } from './utils/ipfs.js'

type Provider = (typeof PROVIDERS)[string]

export type ProviderSelection = {
  /** Providers that will be deployed to. */
  active: Provider[]
  protocol: 'ipfs' | 'swarm'
}

/**
 * Work out which providers a deploy uses. A site can't go to both protocols
 * at once, so Swarm wins when present and IPFS providers are ignored (see
 * docs/docs/swarm.md). Everything that counts providers must use this set, not
 * whichever tokens happen to be configured.
 */
export const selectProviders = (
  tokens: Map<string, string>,
  providers?: string[],
): ProviderSelection => {
  const selected = (providers ?? tokensToProviderNames(tokens.keys())).map(
    (name) => PROVIDERS[findEnvVarProviderName(name)],
  )

  if (!selected.length) throw new NoProvidersError()

  const swarm = selected.filter((p) => p.protocol === 'swarm')
  if (swarm.length) return { active: swarm, protocol: 'swarm' }

  return {
    protocol: 'ipfs',
    // Providers that can take bytes go first, so one of them receives the CAR.
    active: selected
      .filter((p) => p.protocol === 'ipfs')
      .toSorted(
        (a, b) => Number(a.supported === 'pin') - Number(b.supported === 'pin'),
      ),
  }
}

export type DeployEvent =
  | { type: 'status-unknown'; provider: string; error: unknown }
  | { type: 'already-pinned'; provider: string }
  | { type: 'skip'; provider: string }
  | { type: 'start'; provider: Provider }
  | { type: 'success'; provider: string; cid?: string }
  | { type: 'failure'; provider: string; error: Error }

export type ProviderResult = {
  name: string
  status: 'deployed' | 'skipped' | 'failed'
  cid?: string
  pin?: PinStatus
  error?: Error
}

export type DeployInput = {
  /** Packed site: a CAR for IPFS, a TAR for Swarm. */
  bytes: Uint8Array<ArrayBuffer>
  name: string
  size: number
  /** Root CID of the CAR. Required for IPFS, unused for Swarm. */
  cid?: string
  /** Provider credentials and settings, keyed without the `OMNIPIN_` prefix. */
  tokens: Map<string, string>
  selection: ProviderSelection
  /** Path of the archive on disk, for providers that read it (Hoverfly). */
  path?: string
  strict?: boolean
  skipPinned?: boolean
  verbose?: boolean
  filecoinChain?: 'mainnet' | 'calibration'
  filecoinForceNewDataset?: boolean
  signal?: AbortSignal
  onEvent?: (event: DeployEvent) => void
}

export type DeployResult = {
  protocol: 'ipfs' | 'swarm'
  /** Root CID for IPFS, reference ID for Swarm. */
  cid: string
  /** Swarm only: the reference encoded as a CID. */
  swarmCid?: string
  providers: ProviderResult[]
  urls: { gateway: string; providers?: string }
}

/**
 * Publish an already-packed site. Runs anywhere `fetch` does: it does no I/O
 * of its own besides provider calls, and reports through `onEvent` and its
 * return value rather than the terminal.
 *
 * @throws {AllProvidersFailedError} If every attempted provider failed.
 * @throws {NoUploaderError} If no selected provider can receive the CAR.
 */
export const deploy = async (input: DeployInput): Promise<DeployResult> => {
  const { selection } = input
  return selection.protocol === 'swarm'
    ? deployToSwarm(input)
    : deployToIpfs(input)
}

const finish = (
  operation: DeployResult,
  errors: Error[],
  attempted: number,
): DeployResult => {
  // Compare against providers actually attempted: skipped providers can
  // neither fail nor rescue a deploy where everything attempted failed.
  if (errors.length !== 0 && errors.length === attempted)
    throw new AllProvidersFailedError('deploy', errors)
  return operation
}

const deployToSwarm = async ({
  bytes,
  tokens,
  selection,
  path,
  strict,
  verbose,
  signal,
  onEvent,
}: DeployInput): Promise<DeployResult> => {
  const results: ProviderResult[] = []
  const errors: Error[] = []
  let cid = ''
  let swarmCid = ''

  for (const provider of selection.active) {
    signal?.throwIfAborted()
    onEvent?.({ type: 'start', provider })
    const envVar = findEnvVarProviderName(provider.name)

    try {
      const result = await provider.upload({
        bytes,
        token: tokens.get(envVar)!,
        verbose,
        name: '',
        first: true,
        beeURL: tokens.get('BEE_URL'),
        // Hoverfly talks to a local `hoverfly daemon` over its UNIX socket.
        // Its options (including the signer key) are only handed to the
        // Hoverfly provider itself.
        ...(envVar === 'HOVERFLY_TOKEN'
          ? {
              key: tokens.get('HOVERFLY_KEY'),
              nonce: tokens.get('HOVERFLY_NONCE'),
              path,
              socket: tokens.get('HOVERFLY_SOCKET'),
              rpcUrl: tokens.get('HOVERFLY_RPC_URL'),
              depth: parseNumber(tokens.get('HOVERFLY_DEPTH')),
              immutable: parseBoolean(tokens.get('HOVERFLY_IMMUTABLE')),
              redundancy: tokens.get('HOVERFLY_REDUNDANCY'),
              concurrency: parseNumber(tokens.get('HOVERFLY_CONCURRENCY')),
              retries: parseNumber(tokens.get('HOVERFLY_RETRIES')),
              skipOwnerCheck: parseBoolean(
                tokens.get('HOVERFLY_NO_OWNER_CHECK'),
              ),
            }
          : {}),
      })
      swarmCid = result.cid
      cid = result.rID!
      results.push({ name: provider.name, status: 'deployed', cid: result.cid })
      onEvent?.({ type: 'success', provider: provider.name, cid: result.cid })
    } catch (e) {
      if (strict) throw e
      const error = e as Error
      errors.push(error)
      results.push({ name: provider.name, status: 'failed', error })
      onEvent?.({ type: 'failure', provider: provider.name, error })
    }
  }

  return finish(
    {
      protocol: 'swarm',
      cid,
      swarmCid,
      providers: results,
      urls: { gateway: `https://${swarmCid}.bzz.limo/` },
    },
    errors,
    selection.active.length,
  )
}

const canUpload = (p: Provider) =>
  p.supported === 'both' || p.supported === 'upload'

/** The provider that should receive the CAR, if any can. */
export const pickUploader = (
  providers: Provider[],
  skipped?: Set<Provider>,
): Provider | undefined =>
  providers.find((p) => !skipped?.has(p) && canUpload(p))

/**
 * Publish to one IPFS provider. `deploy` is the usual entry point; this exists
 * for callers that run each provider as its own durable, retryable step.
 * `bytes` is only read when `first` is set, or by providers that always upload.
 *
 * @throws {DeployError} If the provider stored a different CID.
 */
export const publishToProvider = async ({
  provider,
  first,
  bytes,
  name,
  size,
  cid,
  tokens,
  verbose,
  filecoinChain,
  filecoinForceNewDataset,
}: Pick<
  DeployInput,
  | 'bytes'
  | 'name'
  | 'size'
  | 'tokens'
  | 'verbose'
  | 'filecoinChain'
  | 'filecoinForceNewDataset'
> & {
  provider: Provider
  first: boolean
  cid: string
}): Promise<PinStatus | undefined> => {
  const envVar = findEnvVarProviderName(provider.name)

  let bucketName: string | undefined

  if (envVar.includes('FILEBASE'))
    bucketName = tokens.get('FILEBASE_BUCKET_NAME')
  else if (envVar.includes('4EVERLAND'))
    bucketName = tokens.get('4EVERLAND_BUCKET_NAME')

  const result = await provider.upload({
    name,
    bytes,
    token: tokens.get(envVar)!,
    bucketName,
    cid,
    first,
    verbose,
    baseURL: tokens.get('SPEC_URL'),
    size,

    // Filecoin
    providerURL: tokens.get('FILECOIN_SP_URL'),
    providerAddress: tokens.get('FILECOIN_SP_ADDRESS'),
    pieceCid: tokens.get('FILECOIN_PIECE_CID'),
    filecoinChain,
    filecoinForceNewDataset,
  })

  // The CID goes on to ENS and DNSLink, so a provider that stored something
  // else must not count as a success. The provider holding the bytes has to
  // say what it stored: without that, nothing proves the upload worked.
  if (first && !result.cid)
    throw new DeployError(provider.name, 'upload returned no CID')

  if (result.cid && !isSameCID(result.cid, cid))
    throw new DeployError(
      provider.name,
      `returned CID ${result.cid}, expected ${cid}`,
    )

  return result.status
}

const deployToIpfs = async ({
  bytes,
  name,
  size,
  cid: expectedCid,
  tokens,
  selection,
  strict,
  skipPinned,
  verbose,
  filecoinChain,
  filecoinForceNewDataset,
  signal,
  onEvent,
}: DeployInput): Promise<DeployResult> => {
  if (!expectedCid) throw new Error('An IPFS deploy needs the CID of the CAR')
  const cid = expectedCid
  const providers = selection.active

  // Providers that already pin this CID and can be skipped. Only a definite
  // 'pinned' counts — 'queued' can still fail — and a failed status check
  // means "unknown", so that provider is deployed to normally instead of
  // skipped. Status failures are deliberately kept out of `errors` and away
  // from `strict`: a flaky status endpoint must never fail an otherwise fine
  // deploy.
  const skipped = new Set<Provider>()

  if (skipPinned) {
    const checkable = providers.filter((p) => p.status)
    const checks = await Promise.allSettled(
      checkable.map((provider) =>
        provider.status!({
          cid,
          auth: { token: tokens.get(findEnvVarProviderName(provider.name)) },
          verbose,
          baseURL: tokens.get('SPEC_URL'),

          // Filecoin: PDP lookups are keyed by the piece CID, which is
          // derived from the packed CAR bytes.
          bytes,
          pieceCid: tokens.get('FILECOIN_PIECE_CID'),
          providerURL: tokens.get('FILECOIN_SP_URL'),
          providerAddress: tokens.get('FILECOIN_SP_ADDRESS'),
          filecoinChain,
        }),
      ),
    )
    for (const [i, check] of checks.entries()) {
      const provider = checkable[i]
      if (check.status === 'fulfilled' && check.value.pin === 'pinned') {
        skipped.add(provider)
        onEvent?.({ type: 'already-pinned', provider: provider.name })
      } else if (check.status === 'rejected')
        onEvent?.({
          type: 'status-unknown',
          provider: provider.name,
          error: check.reason,
        })
    }
  }

  // Only one provider receives the bytes; the rest pin by CID and fetch the
  // content over IPFS. Once something already pins the CID nobody *has* to
  // receive them, so an uploader is optional in that case.
  const uploader = pickUploader(providers, skipped)

  if (!uploader && !skipped.size) throw new NoUploaderError()

  const results: ProviderResult[] = []
  const errors: Error[] = []

  for (const provider of providers) {
    signal?.throwIfAborted()

    if (skipped.has(provider)) {
      onEvent?.({ type: 'skip', provider: provider.name })
      results.push({
        name: provider.name,
        status: 'skipped',
        cid,
        pin: 'pinned',
      })
      continue
    }

    onEvent?.({ type: 'start', provider })

    try {
      const pin = await publishToProvider({
        provider,
        first: provider === uploader,
        bytes,
        name,
        size,
        cid,
        tokens,
        verbose,
        filecoinChain,
        filecoinForceNewDataset,
      })

      results.push({ name: provider.name, status: 'deployed', cid, pin })
      onEvent?.({ type: 'success', provider: provider.name, cid })
    } catch (e) {
      if (strict) throw e
      const error = e as Error
      errors.push(error)
      results.push({ name: provider.name, status: 'failed', error })
      onEvent?.({ type: 'failure', provider: provider.name, error })
    }
  }

  return finish(
    {
      protocol: 'ipfs',
      cid,
      providers: results,
      urls: {
        gateway: `https://${cid}.ipfs.dweb.link`,
        providers: `https://delegated-ipfs.dev/routing/v1/providers/${cid}`,
      },
    },
    errors,
    providers.length - skipped.size,
  )
}

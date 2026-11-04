import type { Address } from 'ox/Address'
import type { Hex } from 'ox/Hex'
import type { Provider } from 'ox/Provider'
import { proposeEnsUpdate } from '../ens.js'
import type { ChainName } from '../types.js'
import {
  type Signer,
  type WalletProvider,
  walletSigner,
} from '../utils/signer.js'
import type { SiteFile } from './files.js'
import { type PackedSite, type PackProgress, packSite } from './pack.js'

export * from './files.js'
export { type PackedSite, type PackProgress, packSite } from './pack.js'

export class GatewayError extends Error {
  name = 'GatewayError'
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type DeploymentStatus = {
  id: string
  name: string
  cid: string
  size: number
  status:
    | 'created'
    | 'publishing'
    | 'pending'
    | 'published'
    | 'failed'
    | 'rejected'
    | 'expired'
    | 'removed'
  providers: { name: string; status: string; pin?: string }[]
  ens: { name: string; status: string | null } | null
  dnslink: string | null
  error: string | null
  retentionUntil: number | null
  createdAt: number
  urls: { gateway: string }
}

export class DeployTimeoutError extends Error {
  name = 'DeployTimeoutError'
  /** Still running. Keep following it with `client.watch(id)`. */
  deploymentId: string
  constructor(deploymentId: string) {
    super(`Timed out waiting for deployment ${deploymentId}`)
    this.deploymentId = deploymentId
  }
}

export type DeployStage =
  | 'packing'
  | 'uploading'
  | 'publishing'
  | 'pending'
  | 'published'

export type DeployClientOptions = {
  /** Where you mounted the gateway, such as `/api/deployments`. */
  apiBase: string
  /** A bearer token, if your app doesn't use cookies. */
  getToken?: () => string | Promise<string>
  /** Sent with each gateway request. `same-origin` by default. */
  credentials?: RequestCredentials
  /** Run packing off the main thread, using `pack.worker`. */
  createWorker?: () => Worker
  /** How often, in milliseconds, to poll while publishing. */
  pollInterval?: number
  /** How long, in milliseconds, to wait for publishing to settle. */
  timeout?: number
}

type EnsPlan = { call: { to: Address; data: Hex }; chainId: number }

const CHAIN_NAMES: Record<number, ChainName> = {
  1: 'mainnet',
  11155111: 'sepolia',
}

export type PublishOptions = {
  name: string
  ens?: string
  dnslink?: string
  signal?: AbortSignal
  onStage?: (stage: DeployStage) => void
  onStatus?: (status: DeploymentStatus) => void
}

export type DeployOptions = PublishOptions & {
  onProgress?: (progress: PackProgress) => void
}

export type PinResult = {
  cid: string
  providers: { name: string; status: string; pin?: string }[]
}

const packInWorker = (
  createWorker: () => Worker,
  files: SiteFile[],
  onProgress?: (progress: PackProgress) => void,
  signal?: AbortSignal,
) =>
  new Promise<PackedSite>((resolve, reject) => {
    signal?.throwIfAborted()

    const worker = createWorker()
    const stop = (settle: () => void) => {
      signal?.removeEventListener('abort', cancel)
      worker.terminate()
      settle()
    }
    // Terminating is what actually cancels: work in a worker can't be
    // interrupted from outside any other way.
    const cancel = () => stop(() => reject(signal?.reason))

    signal?.addEventListener('abort', cancel, { once: true })

    worker.onmessage = ({ data }) => {
      if (data.progress) onProgress?.(data.progress)
      else if (data.error) stop(() => reject(new Error(data.error)))
      else stop(() => resolve(data.site))
    }
    worker.onerror = (event) => stop(() => reject(new Error(event.message)))
    worker.postMessage(files)
  })

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

// `pending` counts: pins can take hours, so nobody should be left polling. Use
// `recheck`, or let the scheduled upkeep finish it.
const SETTLED = new Set([
  'pending',
  'published',
  'failed',
  'rejected',
  'expired',
  'removed',
])

const DEFAULT_TIMEOUT = 20 * 60_000

/** Ask a wallet for its account, prompting the user if needed. */
export const connectWallet = async (
  wallet: WalletProvider,
): Promise<Address> => {
  const [account] = (await wallet.request({
    method: 'eth_requestAccounts',
  })) as Address[]

  if (!account) throw new Error('The wallet did not share an account')
  return account
}

export const createDeployClient = ({
  apiBase,
  getToken,
  credentials = 'same-origin',
  createWorker,
  pollInterval = 3000,
  timeout = DEFAULT_TIMEOUT,
}: DeployClientOptions) => {
  const base = apiBase.replace(/\/$/, '')

  const request = async <T>(
    path: string,
    init: RequestInit & { body?: string } = {},
  ): Promise<T> => {
    const token = await getToken?.()
    const res = await fetch(`${base}${path}`, {
      ...init,
      credentials,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    const body = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok)
      throw new GatewayError(res.status, body.error ?? res.statusText)
    return body
  }

  const post = <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, {
      method: 'POST',
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  const status = (id: string, signal?: AbortSignal) =>
    request<DeploymentStatus>(`/${id}`, { signal })

  /**
   * Follow a deployment until it settles. Resolves with whatever it settled
   * as, so check `status`: only `published` means a provider confirmed it.
   *
   * @throws {DeployTimeoutError} If it hasn't settled within `timeout`.
   */
  const watch = async (
    id: string,
    {
      signal,
      onStage,
      onStatus,
    }: Pick<PublishOptions, 'signal' | 'onStage' | 'onStatus'> = {},
  ): Promise<DeploymentStatus> => {
    const deadline = Date.now() + timeout

    for (;;) {
      const current = await status(id, signal)
      onStatus?.(current)

      if (SETTLED.has(current.status)) {
        if (current.status === 'published' || current.status === 'pending')
          onStage?.(current.status)
        return current
      }

      signal?.throwIfAborted()
      if (Date.now() >= deadline) throw new DeployTimeoutError(id)
      await sleep(pollInterval, signal)
    }
  }

  /** Pack a site without deploying it, to learn its CID up front. */
  const pack = (
    files: SiteFile[],
    {
      onProgress,
      signal,
    }: {
      onProgress?: (progress: PackProgress) => void
      signal?: AbortSignal
    } = {},
  ): Promise<PackedSite> =>
    createWorker
      ? packInWorker(createWorker, files, onProgress, signal)
      : packSite(files, onProgress)

  /** Upload and publish a site that's already packed. */
  const publish = async (
    site: PackedSite,
    { name, ens, dnslink, signal, onStage, onStatus }: PublishOptions,
  ): Promise<DeploymentStatus> => {
    onStage?.('uploading')
    const { id, uploadUrl, contentType } = await post<{
      id: string
      uploadUrl: string
      contentType: string
    }>('/', { name, cid: site.cid, size: site.size, ens, dnslink }, signal)

    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      body: site.car,
      headers: { 'Content-Type': contentType },
      signal,
    })
    if (!upload.ok) throw new GatewayError(upload.status, 'Upload failed')

    onStage?.('publishing')
    await post(`/${id}/start`, undefined, signal)

    return watch(id, { signal, onStage, onStatus })
  }

  /** Pack, upload and publish a site, resolving once publishing settles. */
  const deploy = async (
    files: SiteFile[],
    { onProgress, ...options }: DeployOptions,
  ): Promise<DeploymentStatus> => {
    options.onStage?.('packing')
    const site = await pack(files, { onProgress, signal: options.signal })
    options.signal?.throwIfAborted()
    return publish(site, options)
  }

  /** Ask providers again about a `pending` deployment. */
  const recheck = (id: string) => post<DeploymentStatus>(`/${id}/recheck`)

  /** Take down your own site, if your app has turned that on. */
  const remove = (id: string) =>
    post<{ id: string; status: string; providers: PinResult['providers'] }>(
      `/${id}/remove`,
    )

  /** `omnipin status`: where a CID stands on your providers. */
  const pinStatus = (cid: string) => request<PinResult>(`/pins/${cid}`)

  /** `omnipin pin`: pin a CID that's already on IPFS. */
  const pin = (cid: string, name?: string) =>
    post<PinResult>('/pins', { cid, name })

  /** `omnipin unpin`: drop a CID no deployment uses. */
  const unpin = (cid: string) => post<PinResult>(`/pins/${cid}/unpin`)

  /** `omnipin dnslink`: point a hostname at a CID. */
  const updateDnsLink = (cid: string, name: string) =>
    post<{ cid: string; name: string }>('/dnslink', { cid, name })

  /**
   * `omnipin ens`: point the deployment's ENS name at it, signing in the
   * user's wallet, which pays the gas.
   *
   * With `safe`, this only proposes the update. Nothing changes until enough
   * owners approve.
   */
  const updateEns = async (
    id: string,
    {
      wallet,
      account,
      safe,
    }: {
      wallet: WalletProvider
      account: Address
      /** Propose through this Safe, which `account` must be an owner of. */
      safe?: Address
    },
  ): Promise<{
    reference: string
    /** Set for a Safe: the update waits there for the other owners. */
    queueUrl?: string
  }> => {
    const plan = await post<EnsPlan>(`/${id}/ens/prepare`)

    if (safe) {
      const chainName = CHAIN_NAMES[plan.chainId]
      if (!chainName) throw new Error(`Safe isn't supported on ${plan.chainId}`)

      const signer: Signer = walletSigner({ wallet, address: account })
      const { queueUrl, safeTxHash } = await proposeEnsUpdate({
        signer,
        provider: wallet as unknown as Provider,
        update: { ...plan.call, node: '0x', contentHash: '0x' },
        safe,
        chainName,
      })

      return { reference: safeTxHash, queueUrl }
    }

    const hash = (await wallet.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, ...plan.call, value: '0x0' }],
    })) as Hex

    return { reference: hash }
  }

  /** Ask the gateway to read the name back from chain. */
  const verifyEns = (id: string) =>
    post<{ confirmed: boolean }>(`/${id}/ens/verify`)

  /**
   * Wait for an ENS update to land. Polling the chain through the gateway
   * covers wallets that send through a bundler as well as normal transactions.
   *
   * @returns Whether the name was confirmed in time. `false` doesn't mean it
   *   failed: the transaction may still be pending.
   */
  const confirmEns = async (
    id: string,
    {
      attempts = 40,
      interval = 5000,
      signal,
    }: { attempts?: number; interval?: number; signal?: AbortSignal } = {},
  ): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted()
      if ((await verifyEns(id)).confirmed) return true
      await sleep(interval, signal)
    }
    return false
  }

  return {
    deploy,
    pack,
    publish,
    watch,
    status,
    recheck,
    remove,
    pin,
    pinStatus,
    unpin,
    updateDnsLink,
    updateEns,
    verifyEns,
    confirmEns,
  }
}

export type DeployClient = ReturnType<typeof createDeployClient>

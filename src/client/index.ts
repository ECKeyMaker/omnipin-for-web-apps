import type { Address } from 'ox/Address'
import type { Hex } from 'ox/Hex'
import type { WalletProvider } from '../utils/signer.js'
import type { SiteFile } from './files.js'
import { type PackedSite, packSite } from './pack.js'

export * from './files.js'
export { type PackedSite, packSite } from './pack.js'

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
  status: 'created' | 'publishing' | 'published' | 'failed' | 'rejected'
  providers: { name: string; status: string; pin?: string }[]
  ens: { name: string; status: string | null } | null
  dnslink: string | null
  error: string | null
  retentionUntil: number
  urls: { gateway: string }
}

export type DeployStage = 'packing' | 'uploading' | 'publishing' | 'published'

export type DeployClientOptions = {
  /** Gateway URL, such as `https://gateway.example/api/deployments`. */
  apiBase: string
  /** Fresh session token from your server. Never put an app secret here. */
  getToken: () => string | Promise<string>
  /** Connected app id, sent so the gateway can answer CORS for your origin. */
  appId?: string
  /** Run packing off the main thread, using `pack.worker`. */
  createWorker?: () => Worker
  /** How often, in milliseconds, to poll while publishing. */
  pollInterval?: number
}

type EnsPlan =
  | { call: { to: Address; data: Hex }; sponsored: false }
  | {
      call: { to: Address; data: Hex }
      sponsored: true
      chainId: number
      paymasterUrl: string
    }

export type DeployOptions = {
  name: string
  ens?: string
  dnslink?: string
  signal?: AbortSignal
  onStage?: (stage: DeployStage) => void
  onStatus?: (status: DeploymentStatus) => void
}

const packInWorker = (createWorker: () => Worker, files: SiteFile[]) =>
  new Promise<PackedSite>((resolve, reject) => {
    const worker = createWorker()
    worker.onmessage = ({ data }) => {
      worker.terminate()
      if (data.error) reject(new Error(data.error))
      else resolve(data.site)
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message))
    }
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

const walletSupportsSponsorship = async (
  wallet: WalletProvider,
  account: Address,
  chainId: number,
): Promise<boolean> => {
  try {
    const capabilities = (await wallet.request({
      method: 'wallet_getCapabilities',
      params: [account],
    })) as Record<string, { paymasterService?: { supported?: boolean } }>

    return Boolean(
      capabilities?.[`0x${chainId.toString(16)}`]?.paymasterService?.supported,
    )
  } catch {
    // Most wallets predate EIP-5792 and reject the method outright.
    return false
  }
}

const SETTLED = new Set(['published', 'failed', 'rejected'])

export const createDeployClient = ({
  apiBase,
  getToken,
  appId,
  createWorker,
  pollInterval = 3000,
}: DeployClientOptions) => {
  const base = apiBase.replace(/\/$/, '')

  const request = async <T>(
    path: string,
    init: RequestInit & { body?: string } = {},
  ): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(appId ? { 'X-Omnipin-App': appId } : {}),
      },
    })
    const body = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok)
      throw new GatewayError(res.status, body.error ?? res.statusText)
    return body
  }

  const status = (id: string, signal?: AbortSignal) =>
    request<DeploymentStatus>(`/${id}`, { signal })

  /** Pack, upload and publish a site, resolving once publishing settles. */
  const deploy = async (
    files: SiteFile[],
    { name, ens, dnslink, signal, onStage, onStatus }: DeployOptions,
  ): Promise<DeploymentStatus> => {
    onStage?.('packing')
    const site = createWorker
      ? await packInWorker(createWorker, files)
      : await packSite(files)
    signal?.throwIfAborted()

    onStage?.('uploading')
    const { id, uploadUrl, contentType } = await request<{
      id: string
      uploadUrl: string
      contentType: string
    }>('/', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        name,
        cid: site.cid,
        size: site.size,
        ens,
        dnslink,
      }),
    })

    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      body: site.car,
      headers: { 'Content-Type': contentType },
      signal,
    })
    if (!upload.ok) throw new GatewayError(upload.status, 'Upload failed')

    onStage?.('publishing')
    await request(`/${id}/start`, { method: 'POST', signal })

    for (;;) {
      const current = await status(id, signal)
      onStatus?.(current)

      if (SETTLED.has(current.status)) {
        if (current.status === 'published') onStage?.('published')
        return current
      }
      await sleep(pollInterval, signal)
    }
  }

  /**
   * Point the deployment's ENS name at it. The public pool pays the gas when
   * the wallet supports sponsorship; otherwise the wallet pays as usual.
   *
   * @returns Whether the gas was sponsored.
   */
  const updateEns = async (
    id: string,
    { wallet, account }: { wallet: WalletProvider; account: Address },
  ): Promise<{ sponsored: boolean; reference: string }> => {
    const plan = await request<EnsPlan>(`/${id}/sponsorship`, {
      method: 'POST',
    })

    if (
      plan.sponsored &&
      (await walletSupportsSponsorship(wallet, account, plan.chainId))
    ) {
      const result = (await wallet.request({
        method: 'wallet_sendCalls',
        params: [
          {
            version: '2.0.0',
            from: account,
            chainId: `0x${plan.chainId.toString(16)}`,
            atomicRequired: false,
            calls: [{ ...plan.call, value: '0x0' }],
            capabilities: {
              paymasterService: { url: plan.paymasterUrl },
            },
          },
        ],
      })) as { id: string } | string

      return {
        sponsored: true,
        reference: typeof result === 'string' ? result : result.id,
      }
    }

    const hash = (await wallet.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, ...plan.call, value: '0x0' }],
    })) as Hex

    return { sponsored: false, reference: hash }
  }

  /** Ask the gateway to read the name back from chain. */
  const verifyEns = (id: string) =>
    request<{ confirmed: boolean }>(`/${id}/ens/verify`, { method: 'POST' })

  return { deploy, status, updateEns, verifyEns }
}

export type DeployClient = ReturnType<typeof createDeployClient>

/** @jsxRuntime automatic */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  connectWallet,
  createDeployClient,
  type DeployClientOptions,
  type DeploymentStatus,
  type DeployStage,
  fromDataTransfer,
  fromFileList,
  fromZip,
  type PackProgress,
  prepareSite,
  type SiteFile,
  type SiteLimits,
} from '../client/index.js'
import type { Address } from 'ox/Address'
import { fileSize } from '../utils/format.js'
import type { WalletProvider } from '../utils/signer.js'

export type UseDeployOptions = DeployClientOptions & { limits?: SiteLimits }

type EnsState =
  | { step: 'idle' }
  | { step: 'signing' }
  | { step: 'confirming' }
  | { step: 'confirmed' }
  | { step: 'pending' }
  | { step: 'proposed'; queueUrl: string }

type State = {
  stage: DeployStage | 'idle'
  progress?: PackProgress
  deployment?: DeploymentStatus
  ens: EnsState
  error?: string
}

const idle: State = { stage: 'idle', ens: { step: 'idle' } }

/** `pending` isn't an error: the site is uploaded and awaiting confirmation. */
const settled = (deployment: DeploymentStatus): Partial<State> => {
  const { status, error } = deployment
  const ok = status === 'published' || status === 'pending'

  return {
    deployment,
    stage: ok ? status : 'idle',
    error: ok ? undefined : (error ?? `Deployment ${status}`),
  }
}

/** Headless deploy state, for apps that bring their own interface. */
export const useDeploy = ({ limits, ...options }: UseDeployOptions) => {
  const { apiBase } = options
  const latest = useRef(options)
  latest.current = options

  const client = useMemo(
    () =>
      createDeployClient({
        ...latest.current,
        apiBase,
        getToken: () => latest.current.getToken?.() ?? '',
      }),
    [apiBase],
  )

  const [state, setState] = useState<State>(idle)
  const controller = useRef<AbortController | null>(null)

  const deploy = useCallback(
    async (
      input: SiteFile[],
      settings: { name: string; ens?: string; dnslink?: string },
    ) => {
      controller.current?.abort()
      const abort = new AbortController()
      controller.current = abort
      setState({ ...idle, stage: 'packing' })

      try {
        const { files } = prepareSite(input, limits)
        const deployment = await client.deploy(files, {
          ...settings,
          signal: abort.signal,
          onStage: (stage) => setState((s) => ({ ...s, stage })),
          onStatus: (status) => setState((s) => ({ ...s, deployment: status })),
          onProgress: (progress) => setState((s) => ({ ...s, progress })),
        })

        setState((s) => ({ ...s, ...settled(deployment) }))
        return deployment
      } catch (error) {
        if (!abort.signal.aborted)
          setState((s) => ({
            ...s,
            stage: 'idle',
            error: (error as Error).message,
          }))
        return undefined
      }
    },
    [client, limits],
  )

  const cancel = useCallback(() => {
    controller.current?.abort()
    setState(idle)
  }, [])

  /** Ask providers again about a `pending` deployment. */
  const recheck = useCallback(async () => {
    const id = state.deployment?.id
    if (!id) return
    try {
      const deployment = await client.recheck(id)
      setState((s) => ({ ...s, ...settled(deployment) }))
    } catch (error) {
      setState((s) => ({ ...s, error: (error as Error).message }))
    }
  }, [client, state.deployment?.id])

  /**
   * Point the deployment's ENS name at it. The user's wallet signs and pays.
   */
  const updateEns = useCallback(
    async (wallet: WalletProvider, { safe }: { safe?: Address } = {}) => {
      const id = state.deployment?.id
      if (!id) return

      setState((s) => ({ ...s, ens: { step: 'signing' }, error: undefined }))

      try {
        const account = await connectWallet(wallet)
        const { queueUrl } = await client.updateEns(id, {
          wallet,
          account,
          safe,
        })

        // A proposal has to wait for other people, so there's nothing to poll.
        if (queueUrl) {
          setState((s) => ({ ...s, ens: { step: 'proposed', queueUrl } }))
          return
        }

        setState((s) => ({ ...s, ens: { step: 'confirming' } }))

        const confirmed = await client.confirmEns(id)
        setState((s) => ({
          ...s,
          ens: { step: confirmed ? 'confirmed' : 'pending' },
        }))
      } catch (error) {
        setState((s) => ({
          ...s,
          ens: { step: 'idle' },
          error: (error as Error).message,
        }))
      }
    },
    [client, state.deployment?.id],
  )

  return { ...state, client, deploy, cancel, recheck, updateEns }
}

const STAGE_LABELS: Record<DeployStage, string> = {
  packing: 'Packing your site…',
  uploading: 'Uploading…',
  publishing: 'Publishing to storage providers…',
  pending: 'Uploaded. Waiting for a provider to confirm it holds your site.',
  published: 'Published',
}

const ENS_LABELS: Record<Exclude<EnsState['step'], 'idle'>, string> = {
  signing: 'Approve the update in your wallet…',
  confirming: 'Waiting for the transaction…',
  confirmed: 'ENS name updated',
  pending: 'Still waiting for the transaction. It may take a while to land.',
  proposed: 'Proposed to your Safe. Other owners still need to approve it.',
}

const percent = ({ done, total }: PackProgress) =>
  total ? Math.floor((done / total) * 100) : 0

export type DeployPanelProps = UseDeployOptions & {
  /** Offer an ENS field. */
  ens?: boolean
  /** EIP-1193 provider. Defaults to the browser's injected wallet. */
  wallet?: WalletProvider
  /** Update ENS through this Safe instead of directly. */
  safe?: Address
  onDeployed?: (deployment: DeploymentStatus) => void
}

const injectedWallet = () =>
  (globalThis as { ethereum?: WalletProvider }).ethereum

/**
 * Drop-in deploy form. Style it with the `--omnipin-*` CSS variables, or use
 * `useDeploy` to build your own.
 */
export const DeployPanel = ({
  ens: offerEns,
  wallet,
  safe,
  onDeployed,
  ...options
}: DeployPanelProps) => {
  const {
    stage,
    progress,
    deployment,
    ens,
    error,
    deploy,
    cancel,
    recheck,
    updateEns,
  } = useDeploy(options)
  const [files, setFiles] = useState<SiteFile[]>([])
  const [size, setSize] = useState(0)
  const [name, setName] = useState('')
  const [ensName, setEnsName] = useState('')
  const [readError, setReadError] = useState<string>()
  const [dragging, setDragging] = useState(false)

  // Checking on selection means a bad folder fails before anything uploads.
  const review = async (read: () => SiteFile[] | Promise<SiteFile[]>) => {
    setReadError(undefined)
    try {
      const prepared = prepareSite(await read(), options.limits)
      setFiles(prepared.files)
      setSize(prepared.size)
    } catch (e) {
      setFiles([])
      setSize(0)
      setReadError((e as Error).message)
    }
  }

  const pickFiles = (list: FileList | null) => {
    if (!list?.length) return

    const [first] = list
    const isZip = list.length === 1 && first.name.endsWith('.zip')
    const picked = Array.from(list)

    return review(() =>
      isZip ? fromZip(first, options.limits) : fromFileList(picked),
    )
  }

  const busy =
    stage === 'packing' || stage === 'uploading' || stage === 'publishing'

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const result = await deploy(files, {
      name,
      ...(ensName ? { ens: ensName } : {}),
    })
    if (result?.status === 'published') onDeployed?.(result)
  }

  const availableWallet = wallet ?? injectedWallet()
  const message = error ?? readError
  const showEns =
    stage === 'published' && deployment?.ens && ens.step === 'idle'

  return (
    <form
      onSubmit={submit}
      style={{
        display: 'grid',
        gap: '0.75rem',
        color: 'var(--omnipin-text, inherit)',
        background: 'var(--omnipin-surface, transparent)',
      }}
    >
      <label>
        Site name
        <input
          required
          pattern="[\w.\-]{1,64}"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <fieldset
        data-dragging={dragging}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          // Read before awaiting: the drop's data is gone after this event.
          const reading = fromDataTransfer(e.dataTransfer)
          review(() => reading)
        }}
        style={{
          borderColor: dragging ? 'var(--omnipin-accent, currentColor)' : undefined,
        }}
      >
        <legend>Built site</legend>
        <p>Drop your build folder or a .zip here, or choose one:</p>
        <label>
          Folder
          <input
            type="file"
            data-kind="folder"
            {...{ webkitdirectory: '', directory: '' }}
            onChange={(e) => pickFiles(e.target.files)}
          />
        </label>
        <label>
          Files or .zip
          <input
            type="file"
            data-kind="files"
            multiple
            onChange={(e) => pickFiles(e.target.files)}
          />
        </label>
        {files.length > 0 && (
          <p data-testid="review">
            {files.length} {files.length === 1 ? 'file' : 'files'},{' '}
            {fileSize(size)}. Everything you publish is public and can't be
            fully removed.
          </p>
        )}
      </fieldset>

      {offerEns && (
        <label>
          ENS name (optional)
          <input
            placeholder="mysite.eth"
            value={ensName}
            onChange={(e) => setEnsName(e.target.value)}
          />
        </label>
      )}

      {busy ? (
        <button type="button" onClick={cancel}>
          Cancel
        </button>
      ) : (
        <button type="submit" disabled={!files.length || !name}>
          {message && stage === 'idle' && files.length ? 'Try again' : 'Deploy'}
        </button>
      )}

      <div role="status" aria-live="polite">
        {stage !== 'idle' && !message && <p>{STAGE_LABELS[stage]}</p>}
        {stage === 'packing' && progress && (
          <progress max={100} value={percent(progress)} />
        )}
        {deployment?.providers.map((p) => (
          <p key={p.name}>
            {p.name}: {p.pin ?? p.status}
          </p>
        ))}
        {stage === 'published' && deployment && (
          <a href={deployment.urls.gateway} rel="noreferrer" target="_blank">
            {deployment.urls.gateway}
          </a>
        )}
        {ens.step !== 'idle' && <p>{ENS_LABELS[ens.step]}</p>}
        {ens.step === 'proposed' && (
          <a href={ens.queueUrl} rel="noreferrer" target="_blank">
            Open the Safe queue
          </a>
        )}
      </div>

      {stage === 'pending' && (
        <button type="button" onClick={recheck}>
          Check again
        </button>
      )}

      {showEns &&
        (availableWallet ? (
          <button type="button" onClick={() => updateEns(availableWallet, { safe })}>
            Point {deployment.ens?.name} at this site
          </button>
        ) : (
          <p>Connect a wallet to point {deployment.ens?.name} at this site.</p>
        ))}

      {message && (
        <p role="alert" style={{ color: 'var(--omnipin-error, #b42318)' }}>
          {message}
        </p>
      )}
    </form>
  )
}

/** @jsxRuntime automatic */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  createDeployClient,
  type DeployClientOptions,
  type DeploymentStatus,
  type DeployStage,
  fromFileList,
  fromZip,
  prepareSite,
  type SiteFile,
  type SiteLimits,
} from '../client/index.js'

export type UseDeployOptions = DeployClientOptions & { limits?: SiteLimits }

type State = {
  stage: DeployStage | 'idle'
  deployment?: DeploymentStatus
  error?: string
}

/** Headless deploy state, for apps that bring their own interface. */
export const useDeploy = ({ limits, ...options }: UseDeployOptions) => {
  const { apiBase, appId } = options
  const latest = useRef(options)
  latest.current = options

  const client = useMemo(
    () =>
      createDeployClient({
        ...latest.current,
        apiBase,
        appId,
        getToken: () => latest.current.getToken(),
      }),
    [apiBase, appId],
  )

  const [state, setState] = useState<State>({ stage: 'idle' })
  const controller = useRef<AbortController | null>(null)

  const deploy = useCallback(
    async (
      input: SiteFile[],
      settings: { name: string; ens?: string; dnslink?: string },
    ) => {
      controller.current?.abort()
      const abort = new AbortController()
      controller.current = abort
      setState({ stage: 'packing' })

      try {
        const { files } = prepareSite(input, limits)
        const deployment = await client.deploy(files, {
          ...settings,
          signal: abort.signal,
          onStage: (stage) => setState((s) => ({ ...s, stage })),
          onStatus: (status) =>
            setState((s) => ({ ...s, deployment: status })),
        })

        setState((s) => ({
          ...s,
          deployment,
          stage: deployment.status === 'published' ? 'published' : 'idle',
          error:
            deployment.status === 'published'
              ? undefined
              : (deployment.error ?? `Deployment ${deployment.status}`),
        }))
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
    setState({ stage: 'idle' })
  }, [])

  return { ...state, client, deploy, cancel }
}

const STAGE_LABELS: Record<DeployStage, string> = {
  packing: 'Packing your site…',
  uploading: 'Uploading…',
  publishing: 'Publishing to storage providers…',
  published: 'Published',
}

export type DeployPanelProps = UseDeployOptions & {
  /** Offer an ENS field. */
  ens?: boolean
  onDeployed?: (deployment: DeploymentStatus) => void
}

/**
 * Drop-in deploy form. Style it with the `--omnipin-*` CSS variables, or use
 * `useDeploy` to build your own.
 */
export const DeployPanel = ({
  ens: offerEns,
  onDeployed,
  ...options
}: DeployPanelProps) => {
  const { stage, deployment, error, deploy, cancel } = useDeploy(options)
  const [files, setFiles] = useState<SiteFile[]>([])
  const [name, setName] = useState('')
  const [ens, setEns] = useState('')
  const [readError, setReadError] = useState<string>()

  const pickFiles = async (list: FileList | null) => {
    setReadError(undefined)
    if (!list?.length) return

    try {
      const [first] = list
      setFiles(
        list.length === 1 && first.name.endsWith('.zip')
          ? await fromZip(first, options.limits)
          : fromFileList(list),
      )
    } catch (e) {
      setFiles([])
      setReadError((e as Error).message)
    }
  }

  const busy =
    stage === 'packing' || stage === 'uploading' || stage === 'publishing'

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const result = await deploy(files, {
      name,
      ...(ens ? { ens } : {}),
    })
    if (result?.status === 'published') onDeployed?.(result)
  }

  const message = error ?? readError

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
      <label>
        Built site (folder contents or .zip)
        <input
          type="file"
          multiple
          onChange={(e) => pickFiles(e.target.files)}
        />
      </label>
      {offerEns && (
        <label>
          ENS name (optional)
          <input
            placeholder="mysite.eth"
            value={ens}
            onChange={(e) => setEns(e.target.value)}
          />
        </label>
      )}
      {busy ? (
        <button type="button" onClick={cancel}>
          Cancel
        </button>
      ) : (
        <button type="submit" disabled={!files.length || !name}>
          Deploy
        </button>
      )}
      <div role="status" aria-live="polite">
        {stage !== 'idle' && !message && <p>{STAGE_LABELS[stage]}</p>}
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
      </div>
      {message && (
        <p role="alert" style={{ color: 'var(--omnipin-error, #b42318)' }}>
          {message}
        </p>
      )}
    </form>
  )
}

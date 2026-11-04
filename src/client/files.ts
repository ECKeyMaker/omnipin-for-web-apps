import { unzip } from 'fflate'

export type SiteFile = { path: string; content: Blob }

export class InvalidSiteError extends Error {
  name = 'InvalidSiteError'
}

export type SiteLimits = {
  /** Largest total size accepted, in bytes. */
  maxBytes?: number
  maxFiles?: number
}

const DEFAULT_MAX_BYTES = 100_000_000
const DEFAULT_MAX_FILES = 20_000

const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.DS_Store',
  'Thumbs.db',
])

// Publishing is public and effectively permanent, so a secret that slips into
// a build folder can't be taken back. These stop the deploy rather than being
// dropped silently, so the user finds out their output contained them.
const SENSITIVE = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
]

const normalizePath = (raw: string): string => {
  const path = raw.replaceAll('\\', '/').replace(/^\.\//, '')
  const segments = path.split('/')

  if (
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    segments.includes('..') ||
    path.includes('\0')
  )
    throw new InvalidSiteError(`Unsafe file path: ${raw}`)

  return segments.filter((s) => s && s !== '.').join('/')
}

/** Zips and folder pickers often wrap everything in one top-level folder. */
const stripWrapper = (files: SiteFile[]): SiteFile[] => {
  const atRoot = files.some((f) => f.path === 'index.html')
  const [first] = files[0]?.path.split('/') ?? []

  if (atRoot || !first || !files.every((f) => f.path.startsWith(`${first}/`)))
    return files

  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }))
}

/**
 * Normalize a site's files and refuse anything that shouldn't be published.
 *
 * @throws {InvalidSiteError} With a message fit to show the user.
 */
export const prepareSite = (
  input: SiteFile[],
  {
    maxBytes = DEFAULT_MAX_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
  }: SiteLimits = {},
): { files: SiteFile[]; size: number } => {
  const kept = input
    .map((file) => ({ ...file, path: normalizePath(file.path) }))
    .filter(
      ({ path }) =>
        path && !path.split('/').some((s) => IGNORED_SEGMENTS.has(s)),
    )

  const files = stripWrapper(kept)

  if (!files.length) throw new InvalidSiteError('No files to deploy')
  if (files.length > maxFiles)
    throw new InvalidSiteError(`Too many files (limit ${maxFiles})`)

  const sensitive = files.filter(({ path }) => {
    const name = path.split('/').at(-1) as string
    return SENSITIVE.some((pattern) => pattern.test(name))
  })
  if (sensitive.length)
    throw new InvalidSiteError(
      `Refusing to publish files that may contain secrets: ${sensitive
        .map((f) => f.path)
        .join(', ')}`,
    )

  if (!files.some((f) => f.path === 'index.html'))
    throw new InvalidSiteError('The site needs an index.html at its root')

  const size = files.reduce((total, f) => total + f.content.size, 0)
  if (size === 0) throw new InvalidSiteError('The site is empty')
  if (size > maxBytes)
    throw new InvalidSiteError(`The site is over the ${maxBytes} byte limit`)

  return { files, size }
}

/** Files from `<input type="file" webkitdirectory>` or a drop. */
export const fromFileList = (list: Iterable<File>): SiteFile[] =>
  Array.from(list, (file) => ({
    path: file.webkitRelativePath || file.name,
    content: file,
  }))

/** Read a zip without letting a zip bomb expand past `maxBytes`. */
export const fromZip = async (
  zip: Blob,
  { maxBytes = DEFAULT_MAX_BYTES }: Pick<SiteLimits, 'maxBytes'> = {},
): Promise<SiteFile[]> => {
  const bytes = new Uint8Array(await zip.arrayBuffer())

  const entries = await new Promise<Record<string, Uint8Array>>(
    (resolve, reject) => {
      let declared = 0

      try {
        unzip(
          bytes,
          {
            filter: ({ name, originalSize }) => {
              if (name.endsWith('/')) return false
              declared += originalSize
              if (declared > maxBytes)
                throw new InvalidSiteError(
                  `The zip expands past the ${maxBytes} byte limit`,
                )
              return true
            },
          },
          (error, result) => (error ? reject(error) : resolve(result)),
        )
      } catch (error) {
        reject(error)
      }
    },
  ).catch((error) => {
    if (error instanceof InvalidSiteError) throw error
    throw new InvalidSiteError('Could not read the zip file')
  })

  return Object.entries(entries).map(([path, content]) => ({
    path,
    content: new Blob([content as Uint8Array<ArrayBuffer>]),
  }))
}

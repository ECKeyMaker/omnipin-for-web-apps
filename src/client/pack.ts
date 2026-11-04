import type { ByteStream, FileCandidate } from '../utils/ipfs/unixfs.js'
import { packFiles } from '../utils/ipfs.js'
import type { SiteFile } from './files.js'

const CHUNK = 1 << 20

/**
 * Read a Blob in pieces. Slicing also works on Safari, which can't iterate a
 * `ReadableStream` directly.
 */
async function* readBlob(
  blob: Blob,
  onBytes?: (bytes: number) => void,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    const chunk = new Uint8Array(
      await blob.slice(offset, offset + CHUNK).arrayBuffer(),
    )
    yield chunk
    onBytes?.(chunk.byteLength)
  }
}

export type PackedSite = { cid: string; car: Blob; size: number }

/** Progress through a site's bytes. */
export type PackProgress = { done: number; total: number }

export const packSite = async (
  files: SiteFile[],
  onProgress?: (progress: PackProgress) => void,
): Promise<PackedSite> => {
  const total = files.reduce((sum, file) => sum + file.content.size, 0)
  let done = 0

  const candidates: FileCandidate<ByteStream>[] = files.map(
    ({ path, content }) => ({
      path,
      content: readBlob(content, (bytes) => {
        done += bytes
        onProgress?.({ done, total })
      }),
    }),
  )
  const { bytes, rootCID } = await packFiles(candidates)
  return {
    cid: rootCID.toString(),
    car: new Blob([bytes], { type: 'application/vnd.ipld.car' }),
    size: bytes.byteLength,
  }
}

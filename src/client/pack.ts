import type { ByteStream, FileCandidate } from '../utils/ipfs/unixfs.js'
import { packFiles } from '../utils/ipfs.js'
import type { SiteFile } from './files.js'

const CHUNK = 1 << 20

/**
 * Read a Blob in pieces. Slicing also works on Safari, which can't iterate a
 * `ReadableStream` directly.
 */
async function* readBlob(blob: Blob): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += CHUNK)
    yield new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer())
}

export type PackedSite = { cid: string; car: Blob; size: number }

export const packSite = async (files: SiteFile[]): Promise<PackedSite> => {
  const candidates: FileCandidate<ByteStream>[] = files.map(
    ({ path, content }) => ({ path, content: readBlob(content) }),
  )
  const { bytes, rootCID } = await packFiles(candidates)
  return {
    cid: rootCID.toString(),
    car: new Blob([bytes], { type: 'application/vnd.ipld.car' }),
    size: bytes.byteLength,
  }
}

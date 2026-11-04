import { CarWriter } from '@ipld/car/writer'
import * as dagPb from '@ipld/dag-pb'
import { base32 } from 'multiformats/bases/base32'
import { CID } from 'multiformats/cid'
import { InvalidCIDError } from '../errors.js'
import { MemoryBlockstore } from './ipfs/blockstore.js'
import { type FileCandidate, importer } from './ipfs/unixfs.js'

const concatBytes = (chunks: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  let total = 0
  for (const c of chunks) total += c.byteLength

  const out = new Uint8Array(total)
  let offset = 0

  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }

  return out
}

/**
 * Yield every block reachable from `root` once, depth-first with each node
 * before its children and links in order. The importer writes blocks in
 * whatever order its concurrent file imports finish, so this is what makes
 * the CAR bytes (and the Filecoin piece CID over them) deterministic.
 */
async function* walkDAG(
  root: CID,
  blockstore: MemoryBlockstore,
): AsyncGenerator<{ cid: CID; bytes: Uint8Array<ArrayBuffer> }> {
  const seen = new Set<string>()
  const stack = [root]

  while (stack.length > 0) {
    const cid = stack.pop() as CID
    const key = cid.toString()

    if (seen.has(key)) continue
    seen.add(key)

    const bytes = concatBytes(await Array.fromAsync(blockstore.get(cid)))

    yield { cid, bytes }

    if (cid.code === dagPb.code) {
      const { Links } = dagPb.decode(bytes)

      // Reversed so the first link is popped, and so written, first.
      for (let i = Links.length - 1; i >= 0; i--) {
        stack.push(Links[i].Hash)
      }
    }
  }
}

const byPath = (a: FileCandidate, b: FileCandidate) => {
  const [left, right] = [a.path ?? '', b.path ?? '']
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Pack files into a CAR in memory. Input order never affects the result, so
 * the same site produces the same CAR whichever source listed its files.
 */
export const packFiles = async (
  files: FileCandidate[],
): Promise<{ bytes: Uint8Array<ArrayBuffer>; rootCID: CID }> => {
  const blockstore = new MemoryBlockstore()
  let rootCID: CID | null = null

  for await (const entry of importer(files.toSorted(byPath), blockstore)) {
    rootCID = entry.cid
  }

  if (!rootCID) {
    throw new Error('No files were imported')
  }

  const { writer, out } = CarWriter.create([rootCID])

  // Must be drained while blocks are fed in: `writer.put` will not resolve
  // until the previous chunk has been taken off `out`.
  const collecting = Array.fromAsync(out)

  for await (const block of walkDAG(rootCID, blockstore)) {
    await writer.put(block)
  }

  await writer.close()
  const carChunks = await collecting

  // Released before joining the chunks so peak memory stays at roughly one
  // copy of the blocks plus one of the CAR.
  blockstore.clear()

  const bytes = concatBytes(carChunks)
  carChunks.length = 0

  return { bytes, rootCID }
}

export const assertCID = (cid: string) => {
  if (cid.length !== 64) {
    try {
      base32.decode(cid)
    } catch {
      throw new InvalidCIDError(cid)
    }
  }
}

/**
 * Whether two CID strings name the same content, whatever their version or
 * base. A provider's reply that isn't a CID can't be compared, so it doesn't
 * count as a mismatch.
 */
export const isSameCID = (a: string, b: string): boolean => {
  try {
    return CID.parse(a).toV1().equals(CID.parse(b).toV1())
  } catch {
    return true
  }
}

import { CarBlockIterator } from '@ipld/car/iterator'
import { CarWriter } from '@ipld/car/writer'
import * as dagPb from '@ipld/dag-pb'
import { base32 } from 'multiformats/bases/base32'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { InvalidCARError, InvalidCIDError } from '../errors.js'
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
 * base. Anything that isn't a CID proves nothing, so it never matches.
 */
export const isSameCID = (a: string, b: string): boolean => {
  try {
    return CID.parse(a).toV1().equals(CID.parse(b).toV1())
  } catch {
    return false
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i])

/**
 * Prove a CAR really is the site `expected` names, reading it as a stream so
 * the check doesn't hold the file in memory. A client picks the CID that goes
 * on to ENS, so a server must run this before publishing an uploaded CAR.
 *
 * @throws {InvalidCARError} If the root is wrong, a block's bytes don't match
 *   its CID, a linked block is missing, or a block isn't part of the site.
 */
export const verifyCAR = async (
  source: AsyncIterable<Uint8Array>,
  expected: string,
): Promise<void> => {
  const root = CID.parse(expected).toV1()
  const reader = await CarBlockIterator.fromIterable(source).catch((cause) => {
    throw new InvalidCARError('not a readable CAR', { cause })
  })

  const roots = await reader.getRoots()
  if (roots.length !== 1 || !roots[0].toV1().equals(root))
    throw new InvalidCARError(`root does not match ${expected}`)

  const present = new Set<string>()
  const linked = new Set<string>([root.toString()])

  try {
    for await (const { cid, bytes } of reader) {
      if (cid.multihash.code !== sha256.code)
        throw new InvalidCARError(`unsupported hash in block ${cid}`)

      const digest = await sha256.digest(bytes)
      if (!sameBytes(digest.bytes, cid.multihash.bytes))
        throw new InvalidCARError(`block ${cid} does not match its hash`)

      present.add(cid.toV1().toString())

      if (cid.code === dagPb.code)
        for (const { Hash } of dagPb.decode(bytes).Links)
          linked.add(Hash.toV1().toString())
    }
  } catch (cause) {
    if (cause instanceof InvalidCARError) throw cause
    throw new InvalidCARError('corrupt block data', { cause })
  }

  for (const cid of linked)
    if (!present.has(cid)) throw new InvalidCARError(`missing block ${cid}`)

  // Unreachable blocks would be stored and paid for, without being in the site
  // the CID describes.
  for (const cid of present)
    if (!linked.has(cid)) throw new InvalidCARError(`unreachable block ${cid}`)
}

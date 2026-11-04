import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { CID } from 'multiformats/cid'
import type { FileEntry } from '../types.js'
import type { FileCandidate } from './ipfs/unixfs.js'
import { packFiles } from './ipfs.js'
import { packTarFiles } from './tar.js'

const tmp = tmpdir()

/** Path of the archive `packTAR` writes for `name`. */
export const tarOutputPath = (name: string, dir: string = tmp): string =>
  `${dir}/${name}.tar`

/** `packFiles`, plus a copy of the CAR on disk for the CLI's users. */
export const packCAR = async (
  files: FileCandidate[],
  name: string,
  dir = tmp,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; rootCID: CID }> => {
  const packed = await packFiles(files)
  await writeFile(`${dir}/${name}.car`, packed.bytes)
  return packed
}

/** `packTarFiles`, plus a copy of the archive on disk when `name` is set. */
export const packTAR = async (
  files: Omit<FileEntry, 'size'>[],
  name?: string,
  dir: string = tmp,
): Promise<{ bytes: Uint8Array; output: string | null }> => {
  const bytes = await packTarFiles(files)

  if (!name) return { bytes, output: null }

  const output = tarOutputPath(name, dir)
  await writeFile(output, bytes)
  return { bytes, output }
}

import { createTar, type TarFileItem } from 'nanotar'
import type { FileEntry } from '../types.js'

/** Pack files into a TAR in memory. */
export const packTarFiles = async (
  files: Omit<FileEntry, 'size'>[],
): Promise<Uint8Array> => {
  const entries: TarFileItem[] = []

  for (const { path, content } of files) {
    const chunks =
      content instanceof Uint8Array ? [content] : await Array.fromAsync(content)

    let totalLength = 0
    for (const c of chunks) totalLength += c.length

    const fileData = new Uint8Array(totalLength)
    let offset = 0
    for (const c of chunks) {
      fileData.set(c, offset)
      offset += c.length
    }

    entries.push({
      name: path,
      data: fileData,
    })
  }

  return createTar(entries) as Uint8Array
}

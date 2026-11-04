const units = ['KB', 'MB', 'GB', 'TB', 'PB']
const thresh = 1000
export function fileSize(bytes: number, digits = 1): string {
  if (Math.abs(bytes) < thresh) return `${bytes}B`

  let u = -1
  const r = 10 ** digits

  do {
    bytes /= thresh
    ++u
  } while (
    Math.round(Math.abs(bytes) * r) / r >= thresh &&
    u < units.length - 1
  )

  return bytes.toFixed(digits) + units[u]
}

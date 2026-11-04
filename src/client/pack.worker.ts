import type { SiteFile } from './files.js'
import { packSite } from './pack.js'

// Optional: pack off the main thread. See `createWorker` on the client.
const scope = globalThis as unknown as {
  onmessage: (event: { data: SiteFile[] }) => void
  postMessage: (message: unknown) => void
}

scope.onmessage = async ({ data }) => {
  try {
    scope.postMessage({ site: await packSite(data) })
  } catch (error) {
    scope.postMessage({ error: (error as Error).message })
  }
}

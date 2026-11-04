import type { Address } from 'ox/Address'
import type { Hex } from 'ox/Hex'
import type { Session } from '../utils/session.js'

// The slices of Cloudflare's bindings the gateway uses. Declaring only these
// keeps `@cloudflare/workers-types` out of the public types.
export type D1Result = { meta: { changes?: number } }
export type D1Statement = {
  bind: (...values: unknown[]) => D1Statement
  first: <T = Record<string, unknown>>() => Promise<T | null>
  run: () => Promise<D1Result>
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>
}
export type D1Database = { prepare: (sql: string) => D1Statement }

export type R2Object = {
  size: number
  body: ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>
  arrayBuffer: () => Promise<ArrayBuffer>
}
export type R2Bucket = {
  head: (key: string) => Promise<{ size: number } | null>
  get: (key: string) => Promise<R2Object | null>
  delete: (key: string) => Promise<void>
}

export type WorkflowBinding = {
  create: (options: { id: string; params: { id: string } }) => Promise<unknown>
}

export type GatewayEnv = {
  DB: D1Database
  CARS: R2Bucket
  DEPLOY_WORKFLOW: WorkflowBinding
}

export type PublicFunding = {
  /** Paymaster that sponsors ENS updates. */
  paymaster: Address
  /** Gateway key that approves operations. Can't move funds. */
  signerKey: Hex
  /** Must match the paymaster's `maxCostPerOp`. */
  maxCostPerOp: bigint
  /** How long, in seconds, an approval stays usable. */
  approvalLifetime?: number
}

export type GatewayConfig<E extends GatewayEnv = GatewayEnv> = {
  /** Path the gateway is mounted on, such as `/api/deployments`. */
  basePath: string
  /** Master secret that per-app secrets are derived from. */
  masterSecret: (env: E) => string
  /** Provider tokens and settings, keyed without the `OMNIPIN_` prefix. */
  tokens: (env: E) => Map<string, string>
  /** Providers to publish to, in order. Defaults to every configured token. */
  providers?: string[]
  r2: (env: E) => {
    accountId: string
    bucketName: string
    accessKeyId: string
    secretAccessKey: string
  }
  /** Ethereum RPC URL. Never taken from a client. */
  rpcUrl: (env: E) => string
  chainId: number
  /** Gas sponsorship. Omit to have users pay their own gas. */
  funding?: (env: E) => PublicFunding
  dnslink?: (env: E) => { apiKey: string; zoneId: string }
  /**
   * Whether a user may point a DNSLink hostname at their site. Denied unless
   * set, because otherwise any user could repoint any name in the zone.
   */
  authorizeDnsLink?: (
    session: Session,
    hostname: string,
    env: E,
  ) => boolean | Promise<boolean>
  limits: {
    /** Largest CAR accepted, in bytes. */
    maxCarBytes: number
    /** Total bytes per day across all connected apps. */
    globalDailyBytes: number
    /** How long the pool commits to storing a site, in days. */
    retentionDays: number
    /** Sponsorship approvals allowed per deployment. */
    sponsorAttempts?: number
  }
}

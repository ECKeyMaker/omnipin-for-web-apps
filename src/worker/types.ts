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

/** Cloudflare's Rate Limiting binding. */
export type RateLimitBinding = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

export type GatewayEnv = {
  DB: D1Database
  CARS: R2Bucket
  DEPLOY_WORKFLOW: WorkflowBinding
  /** Optional. Limits each user's requests. */
  RATE_LIMITER?: RateLimitBinding
}

/** Whoever your app says is making a request. */
export type User = { id: string }

export type DeployRequest = {
  name: string
  cid: string
  size: number
  ens?: string
  dnslink?: string
}

export type GatewayConfig<E extends GatewayEnv = GatewayEnv> = {
  /** Path the gateway is mounted on, such as `/api/deployments`. */
  basePath: string
  /**
   * Identify the user with your app's own login. Return `null` to refuse them.
   * Everyone you accept can spend from your provider accounts.
   */
  authenticate: (request: Request, env: E) => User | null | Promise<User | null>
  /**
   * Decide whether a user may make a deploy, such as checking they have paid.
   * Return `false` to refuse it. Every authenticated user may if unset.
   */
  authorizeDeploy?: (
    user: User,
    deploy: DeployRequest,
    env: E,
  ) => boolean | Promise<boolean>
  /** Provider tokens and settings, keyed without the `OMNIPIN_` prefix. */
  tokens: (env: E) => Map<string, string>
  /**
   * Providers to publish to, in order. Defaults to every configured token.
   * Include one with a pin status API, or nothing can confirm a deploy.
   */
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
  /**
   * Other origins allowed to call this gateway. Requests from the gateway's
   * own origin always work; anything else is refused unless listed.
   */
  allowedOrigins?: string[]
  dnslink?: (env: E) => { apiKey: string; zoneId: string }
  /**
   * Whether a user may point a DNSLink hostname at a site. Denied unless set,
   * because otherwise any user could repoint any name in the zone.
   */
  authorizeDnsLink?: (
    user: User,
    hostname: string,
    env: E,
  ) => boolean | Promise<boolean>
  /**
   * Let users take down their own sites. Off by default, because a site can
   * have people relying on it besides its creator. `removeDeployment` is
   * always available to your server.
   */
  allowUserRemoval?: boolean
  /** Let users pin or unpin any CID on your accounts. Both off by default. */
  tools?: { pin?: boolean; unpin?: boolean }
  limits: {
    /** Largest CAR accepted, in bytes. */
    maxCarBytes: number
    /** Total bytes per day across all users. No limit if unset. */
    dailyBytes?: number
    /** Deploys per user per day. No limit if unset. */
    userDailyDeploys?: number
    /** Days to keep a site. Kept indefinitely if unset. */
    retentionDays?: number
    /**
     * Unpin sites once retention ends. Off by default: expired sites are only
     * marked, because unpinning takes public content offline.
     */
    unpinExpired?: boolean
  }
}

import { createGateway, type GatewayEnv } from 'omnipin-web-apps/worker'

type Env = GatewayEnv & {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  PINATA_TOKEN: string
  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  RPC_URL: string
  /** Local development only. Never set this in production. */
  DEV_USER?: string
}

/**
 * REPLACE THIS with your app's real login check.
 *
 * It refuses everyone until you do, because everyone it accepts can spend from
 * your provider accounts.
 */
const getUser = async (_request: Request, env: Env) =>
  env.DEV_USER ? { id: env.DEV_USER } : null

const omnipin = createGateway<Env>({
  basePath: '/api/deployments',
  authenticate: getUser,
  tokens: (env) => new Map([['PINATA_TOKEN', env.PINATA_TOKEN]]),
  r2: (env) => ({
    accountId: env.R2_ACCOUNT_ID,
    bucketName: 'my-app-cars',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  }),
  rpcUrl: (env) => env.RPC_URL,
  chainId: 11155111,
  limits: { maxCarBytes: 100_000_000, userDailyDeploys: 20 },
})

export const DeployWorkflow = omnipin.Workflow

export default {
  fetch(request: Request, env: Env) {
    const { pathname } = new URL(request.url)

    return pathname.startsWith('/api/deployments')
      ? omnipin.fetch(request, env)
      : env.ASSETS.fetch(request)
  },
  scheduled(_controller: unknown, env: Env) {
    return omnipin.scheduled(env)
  },
}

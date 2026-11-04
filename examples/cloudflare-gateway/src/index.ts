import { createGateway, type GatewayEnv } from 'omnipin-web-apps/worker'

type Env = GatewayEnv & {
  MASTER_SECRET: string
  PINATA_TOKEN: string
  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  RPC_URL: string
  PAYMASTER_ADDRESS?: `0x${string}`
  PAYMASTER_SIGNER_KEY?: `0x${string}`
  MAX_COST_PER_OP?: string
  ADMIN_SECRET?: string
}

const gateway = createGateway<Env>({
  basePath: '/api/deployments',
  masterSecret: (env) => env.MASTER_SECRET,
  tokens: (env) => new Map([['PINATA_TOKEN', env.PINATA_TOKEN]]),
  r2: (env) => ({
    accountId: env.R2_ACCOUNT_ID,
    bucketName: 'omnipin-cars',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  }),
  rpcUrl: (env) => env.RPC_URL,
  chainId: 11155111,
  adminSecret: (env) => env.ADMIN_SECRET ?? '',
  funding: (env) => {
    if (!env.PAYMASTER_ADDRESS || !env.PAYMASTER_SIGNER_KEY)
      throw new Error('Public funding is not configured')
    return {
      paymaster: env.PAYMASTER_ADDRESS,
      signerKey: env.PAYMASTER_SIGNER_KEY,
      maxCostPerOp: BigInt(env.MAX_COST_PER_OP ?? '0'),
    }
  },
  limits: {
    maxCarBytes: 100_000_000,
    globalDailyBytes: 5_000_000_000,
    retentionDays: 90,
    dailySponsorships: 500,
  },
})

export const DeployWorkflow = gateway.Workflow

export default { fetch: gateway.fetch, scheduled: gateway.scheduled }

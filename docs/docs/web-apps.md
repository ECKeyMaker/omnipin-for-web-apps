# Embedding in web apps

Use the Omnipin toolset from your own web app instead of the command line. Your users upload a built site from the browser, and your Worker publishes it to IPFS with your provider accounts.

## How it works

1. The browser checks the site and packs it into a CAR.
2. Your Worker checks the user with your own login, and gives the browser a temporary upload URL.
3. A Cloudflare Workflow verifies the CAR, then publishes it to your storage providers.
4. The deployment becomes `published` once a provider confirms it holds the site.
5. If the site has an ENS name, the user signs the update in their own wallet and pays the gas.

Provider tokens stay in your Worker. Your Worker never holds a user's wallet keys.

## Install

The package doesn't have to come from npm. Pin a commit, so an update can't change your app without you noticing.

::: code-group

```sh [npm]
npm i github:ECKeyMaker/omnipin-for-web-apps#COMMIT_SHA
```

```sh [pnpm]
pnpm add github:ECKeyMaker/omnipin-for-web-apps#COMMIT_SHA
```

:::

The package builds itself during install. npm prints an `install-scripts` warning about that. pnpm refuses until you approve the exact commit in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  'omnipin-web-apps@https://codeload.github.com/ECKeyMaker/omnipin-for-web-apps/tar.gz/COMMIT_SHA': true
```

`COMMIT_SHA` must be the full 40-character commit, and each update needs a new entry.

You can also build a tarball with `pnpm pack`, then `npm i ./omnipin-web-apps-1.0.0-rc.0.tgz`.

## Add it to your app

You need a Worker on Workers Paid, because Workers Free allows only 10 ms of CPU per request. `examples/cloudflare-app` is a complete app to copy.

### 1. Set up Cloudflare

Omnipin's tables are prefixed with `omnipin_`, so they can share your app's D1 database.

```sh
wrangler d1 execute my-app --file=node_modules/omnipin-web-apps/dist/schema.sql
wrangler r2 bucket create my-app-cars
```

Configure the bucket:

- **CORS:** allow `PUT` from your app's origin, with the `Content-Type` header.
- **Lifecycle:** delete objects after a few days, which cleans up uploads that never started.

Add the bindings to `wrangler.jsonc`:

```jsonc
{
  "d1_databases": [
    { "binding": "DB", "database_name": "my-app", "database_id": "..." }
  ],
  "r2_buckets": [{ "binding": "CARS", "bucket_name": "my-app-cars" }],
  "workflows": [
    {
      "name": "omnipin-deploy",
      "binding": "DEPLOY_WORKFLOW",
      "class_name": "DeployWorkflow"
    }
  ],
  // Rechecks pending deployments.
  "triggers": { "crons": ["*/15 * * * *"] }
}
```

### 2. Mount it in your Worker

```ts
import { createGateway } from 'omnipin-web-apps/worker'

const omnipin = createGateway({
  basePath: '/api/deployments',
  // Your app's login. Everyone you accept can spend from your accounts.
  authenticate: (request, env) => getUser(request, env),
  tokens: (env) => new Map([['PINATA_TOKEN', env.PINATA_TOKEN]]),
  r2: (env) => ({
    accountId: env.R2_ACCOUNT_ID,
    bucketName: 'my-app-cars',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  }),
  rpcUrl: (env) => env.RPC_URL,
  chainId: 1,
  limits: { maxCarBytes: 100_000_000, userDailyDeploys: 20 },
})

export const DeployWorkflow = omnipin.Workflow

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/api/deployments'))
      return omnipin.fetch(request, env)
    return handleYourApp(request, env)
  },
  scheduled(_, env) {
    return omnipin.scheduled(env)
  },
}
```

::: warning Choose your providers
Include at least one provider with a pin status API, such as Pinata or Filebase. Lighthouse, QuickNode and AIOZ can't report a pin, so on their own a deployment stays `pending`.
:::

### 3. Add the deploy form

```tsx
import { DeployPanel } from 'omnipin-web-apps/react'

<DeployPanel apiBase="/api/deployments" ens />
```

Your login cookie goes along automatically. It accepts a build folder, a `.zip` or dropped files, reviews them before anything uploads, and walks the user through the ENS update.

Style it with the `--omnipin-text`, `--omnipin-surface`, `--omnipin-accent` and `--omnipin-error` CSS variables, or use `useDeploy()` to build your own interface.

### Options

| Option | Use it to |
|---|---|
| `authorizeDeploy` | Refuse a deploy, such as checking a user has paid |
| `limits.userDailyDeploys`, `limits.dailyBytes` | Cap usage. No limits apply if unset |
| `limits.retentionDays` | Stop keeping sites after a while. Kept indefinitely if unset |
| `allowUserRemoval` | Let users take down their own sites. Off by default |
| `tools.pin`, `tools.unpin` | Let users pin or unpin any CID. Off by default |
| `dnslink`, `authorizeDnsLink` | Update DNSLink. Denied unless you authorize each hostname |
| `allowedOrigins` | Call the gateway from another site |

## Using the client

Without React, use the client directly. It works with any framework:

```ts
import { createDeployClient, fromFileList, prepareSite } from 'omnipin-web-apps/client'

const client = createDeployClient({ apiBase: '/api/deployments' })

const { files } = prepareSite(fromFileList(input.files))
const deployment = await client.deploy(files, { name: 'my-site' })
```

If your app doesn't use cookies, pass `getToken` and read the `Authorization` header in `authenticate`.

### Know the CID before publishing

Pack and publish separately, so you can use the CID first without packing twice:

```ts
const site = await client.pack(files)
showTheUser(site.cid)
const deployment = await client.publish(site, { name: 'my-site' })
```

### Deployment states

`deploy` and `publish` resolve once a deployment settles, so check `status`:

| Status | Meaning |
|---|---|
| `published` | A provider confirmed it holds the site |
| `pending` | Uploaded, but nothing has confirmed it yet. Don't treat it as live |
| `failed` | No provider took the site |
| `rejected` | The CAR didn't match its CID, or the size was wrong |
| `expired` | Past its retention period |
| `removed` | Taken down |

A `pending` deployment is rechecked by your cron, and `client.recheck(id)` checks on demand. DNSLink updates wait for confirmation, and ENS updates are refused until then.

If a deployment hasn't settled after 20 minutes, `deploy` throws a `DeployTimeoutError`. The deployment keeps running, so follow it with `client.watch(error.deploymentId)`.

## The CLI commands

| CLI | From a web app |
|---|---|
| `omnipin deploy` | `client.deploy()`, or `<DeployPanel />` |
| `omnipin pack` | `client.pack()` |
| `omnipin status` | `client.pinStatus(cid)` |
| `omnipin pin` | `client.pin(cid)`, once `tools.pin` is on |
| `omnipin unpin` | `client.unpin(cid)`, once `tools.unpin` is on. Refused while a deployment uses the CID |
| `omnipin ens` | `client.updateEns()`, signed in the user's wallet |
| `omnipin dnslink` | `client.updateDnsLink(cid, name)` |
| `omnipin resolver-setup` | CLI only |
| `omnipin deposit`, `omnipin bridge` | CLI only |

The Filecoin and Hoverfly providers are also CLI only.

## Update an ENS name

```ts
await client.updateEns(deployment.id, { wallet, account })
const confirmed = await client.confirmEns(deployment.id)
```

`wallet` is any EIP-1193 provider, and it signs and pays for the transaction. The name must be owned by, or delegated to, `account`. `confirmEns` reads the name back from chain, so it doesn't rely on the client's word.

To go through a Safe, pass `safe`. The wallet must belong to an owner. This only proposes the update, and nothing changes until enough owners approve it:

```ts
const { queueUrl } = await client.updateEns(deployment.id, {
  wallet,
  account,
  safe: '0x...',
})
```

## From your server

These run in your Worker, without any SQL of your own:

```ts
import {
  getDeployment,
  listDeployments,
  listAudit,
  removeDeployment,
  renewDeployment,
} from 'omnipin-web-apps/worker'

const deployment = await getDeployment(env.DB, id)
if (deployment?.status === 'failed') await refundUser(deployment.userId)

await listDeployments(env.DB, { userId, status: 'published' })
```

To take a site down:

```ts
await removeDeployment(env, config, id, {
  actor: 'support',
  reason: 'phishing report #12',
  force: true,
})
```

Check the result, which lists what happened at each provider:

| Status | Meaning |
|---|---|
| `unpinned` | The provider dropped it |
| `shared` | Kept, because another live deployment has identical content. `force` overrides this |
| `unsupported` | The provider has no unpin API, so remove it there by hand |
| `failed` | The provider refused or was unreachable |

Removal stops you storing a site. It can't recall copies other people or nodes already hold.

## What can be deployed

Only static output works: HTML, CSS, JavaScript and assets, with `index.html` at the root. Server rendering and API routes can't run on IPFS. Client-side routes may need hash routing or a fallback page.

Deploys are refused if they contain likely secrets such as `.env` files or private keys. Anything published is public and effectively permanent.

## Secrets

Set these with `wrangler secret put`. None belong in your frontend or in `wrangler.jsonc`.

| Secret | Purpose |
|---|---|
| Provider tokens, such as `PINATA_TOKEN` | Publishing to storage |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Signing upload URLs. Scope the key to the one bucket |
| A Cloudflare API token, for DNSLink | Scope it to the one zone |

See the [security model](./security) for what this does and doesn't protect against.

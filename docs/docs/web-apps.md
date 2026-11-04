# Embedding in web apps

Add site deployment to any web app. Your users upload a built site, and it's published to IPFS through a shared funding gateway. Storage and ENS gas are paid from a public pool, within quotas.

Your frontend holds no provider tokens and no wallet keys.

## How it works

1. The browser checks the site and packs it into a CAR.
2. The gateway checks your quota and gives the browser a temporary upload URL.
3. A Cloudflare Workflow verifies the CAR, then publishes it to storage providers.
4. If the site has an ENS name, the user's wallet approves the update. The public pool pays the gas when the wallet supports it.

## Install

The package doesn't have to come from npm. Pick whichever suits your app, and pin a commit or version so an update can't change your app without you noticing.

### From a tarball

Build one with `pnpm pack`, then install the file:

```sh
npm i ./omnipin-web-apps-1.0.0-rc.0.tgz
```

### From Git with npm

```sh
npm i github:ECKeyMaker/omnipin-for-web-apps#COMMIT_SHA
```

The package builds itself during install, and npm prints an `install-scripts` warning about that.

### From Git with pnpm

pnpm won't run a Git dependency's build until you approve that exact commit. Add it to `pnpm-workspace.yaml`, then install:

```yaml
allowBuilds:
  'omnipin-web-apps@git+https://github.com/ECKeyMaker/omnipin-for-web-apps.git#COMMIT_SHA': true
```

```sh
pnpm add github:ECKeyMaker/omnipin-for-web-apps#COMMIT_SHA
```

If pnpm prints a different key, copy that one. You'll need a new entry for each commit you update to.

## Connect your app

You need an app id and secret from the gateway operator. They'll also need your site's origin and the quotas you're requesting.

### 1. Issue sessions from your server

Authenticate your user as you normally would, then mint a short-lived token:

```ts
import { createSessionToken } from 'omnipin-web-apps'

const token = await createSessionToken({
  appId: process.env.OMNIPIN_APP_ID,
  userId: user.id,
  secret: process.env.OMNIPIN_APP_SECRET,
})
```

::: danger
The app secret must stay on your server. Anyone holding it can spend your app's quota as any user.
:::

Per-user quotas are only as good as your `userId`. Require a real login before issuing a token.

### 2. Add the deploy form

```tsx
import { DeployPanel } from 'omnipin-web-apps/react'

<DeployPanel
  apiBase="https://gateway.example/api/deployments"
  appId="your-app"
  getToken={() => fetch('/api/omnipin-token').then((r) => r.text())}
  ens
/>
```

It accepts a build folder, a `.zip` or dropped files, reviews them before anything uploads, and walks the user through the ENS update. Style it with the `--omnipin-text`, `--omnipin-surface`, `--omnipin-accent` and `--omnipin-error` CSS variables, or use `useDeploy()` to build your own interface.

### Without React

```ts
import {
  createDeployClient,
  fromFileList,
  prepareSite,
} from 'omnipin-web-apps/client'

const client = createDeployClient({
  apiBase: 'https://gateway.example/api/deployments',
  appId: 'your-app',
  getToken,
})

const { files } = prepareSite(fromFileList(input.files))
const deployment = await client.deploy(files, { name: 'my-site' })
```

## Update an ENS name

```ts
const { sponsored } = await client.updateEns(deployment.id, { wallet, account })
```

`wallet` is any EIP-1193 provider. The name must be owned by, or delegated to, `account`.

- **Sponsored:** smart wallets that support the `paymasterService` capability have their gas paid by the pool.
- **Not sponsored:** other wallets send a normal transaction and pay their own gas.

Once the transaction lands, confirm it with `client.verifyEns(deployment.id)`. The gateway reads the name back from chain, so it doesn't rely on the client's word.

### Through a Safe

Pass `safe` to propose the update instead of sending it. The connected wallet must belong to an owner:

```ts
const { queueUrl } = await client.updateEns(deployment.id, {
  wallet,
  account,
  safe: '0x...',
})
```

This only queues the update. Nothing changes until enough owners approve it, and that gas isn't sponsored. `DeployPanel` takes the same `safe` prop.

## Remove a site

```ts
await fetch(`${apiBase}/${deployment.id}/remove`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
})
```

Users can remove their own sites. The response lists what happened at each provider:

| Status | Meaning |
|---|---|
| `unpinned` | The provider dropped it |
| `shared` | Kept, because another live deployment has identical content |
| `unsupported` | The provider has no unpin API, so the operator must remove it |
| `failed` | The provider refused or was unreachable |

Removal stops the pool storing a site. It can't recall copies other people or nodes already hold.

## What can be deployed

Only static output works: HTML, CSS, JavaScript and assets, with `index.html` at the root. Server rendering and API routes can't run on IPFS. Client-side routes may need hash routing or a fallback page.

Deploys are refused if they contain likely secrets such as `.env` files or private keys. Anything published is public and effectively permanent, and unpinning doesn't remove copies held elsewhere.

## Limits

Requests fail with a `GatewayError` carrying a status code. A `429` means a quota or rate limit was reached, and a `401` means your session expired, so fetch a new token.

A deployment is retained only for the gateway's retention period. Check `retentionUntil` on the deployment.

## Example

`examples/connected-app` is a complete app: a React frontend and a Worker that issues sessions. Its token endpoint refuses everyone until you add your own login check.

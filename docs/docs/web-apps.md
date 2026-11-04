# Embedding in web apps

Add site deployment to any web app. Your users upload a built site, and it's published to IPFS through a shared funding gateway. Storage and ENS gas are paid from a public pool, within quotas.

Your frontend holds no provider tokens and no wallet keys.

## How it works

1. The browser checks the site and packs it into a CAR.
2. The gateway checks your quota and gives the browser a temporary upload URL.
3. A Cloudflare Workflow verifies the CAR, then publishes it to storage providers.
4. If the site has an ENS name, the user's wallet approves the update. The public pool pays the gas when the wallet supports it.

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

Style it with the `--omnipin-text`, `--omnipin-surface` and `--omnipin-error` CSS variables, or use `useDeploy()` to build your own interface.

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

## What can be deployed

Only static output works: HTML, CSS, JavaScript and assets, with `index.html` at the root. Server rendering and API routes can't run on IPFS. Client-side routes may need hash routing or a fallback page.

Deploys are refused if they contain likely secrets such as `.env` files or private keys. Anything published is public and effectively permanent, and unpinning doesn't remove copies held elsewhere.

## Limits

A deployment is retained only for the gateway's retention period. Check `retentionUntil` on the deployment.

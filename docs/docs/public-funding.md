# Operating public funding

This guide is for whoever runs the shared gateway and treasury. For adding deployment to an app, see [Embedding in web apps](./web-apps).

## Overview

| Part | What it is | Controls |
|---|---|---|
| Treasury | OpenZeppelin `TimelockController` | Multisig proposes and executes, after a delay |
| Gas pool | EntryPoint deposit for `SponsorPaymaster` | Only the treasury can withdraw |
| Storage | Provider accounts paid by the operator | Off-chain |
| Gateway | Cloudflare Worker | App keys, quotas, provider tokens, paymaster signer |

Anyone can donate by sending ETH to the treasury, or by calling `EntryPoint.depositTo(paymaster)`.

## What isn't automated

- **Paying for storage.** Most providers bill an account, so the operator must convert treasury funds into provider credit. The contracts can't do this.
- **Renewals.** Storage bills recur. The gateway records `retention_until` on each deployment, but it doesn't renew, unpin or delete anything. Set a retention period the treasury can actually cover.
- **Content moderation.** Quotas limit how much is stored, not what. Only register apps you trust, and have a process for abuse reports.

## Before mainnet

::: danger
`SponsorPaymaster` has not been audited. Get an external audit before it holds public funds.
:::

1. Audit `contracts/src/SponsorPaymaster.sol` and confirm the EntryPoint address on the target chain.
2. Create a multisig, and pick a timelock delay long enough for donors to react.
3. Run the whole flow on Sepolia, including a bundler and a real smart wallet.
4. Deploy, then stake the paymaster, since bundlers may require it:

```sh
cd contracts
MULTISIG=0x... GATEWAY_SIGNER=0x... TIMELOCK_DELAY=172800 MAX_COST_PER_OP=5000000000000000 \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

## Limiting losses

The paymaster signer sits in a Worker secret, so plan for it leaking. It can't withdraw funds or change the rules, but until it's replaced it can approve operations.

- **Keep the deposit small.** A leaked signer can spend at most `maxCostPerOp` per operation, and at most the deposit. Top up in small amounts from the treasury.
- **Rotate by redeploying.** The signer is immutable, so deploy a new paymaster, then have the treasury withdraw from the old one. Withdrawals wait for the timelock, so the old deposit stays exposed during the delay.
- **Set `maxCostPerOp` from real gas costs.** It must match the gateway's config, and it should sit just above the cost of a contenthash update.

## Run the gateway

Start from `examples/cloudflare-gateway`. It needs Workers Paid, because Workers Free allows only 10 ms of CPU per request.

```sh
wrangler d1 create omnipin-gateway
wrangler d1 execute omnipin-gateway --file=node_modules/omnipin-web-apps/dist/schema.sql
wrangler r2 bucket create omnipin-cars
wrangler secret put MASTER_SECRET
wrangler deploy
```

Configure the bucket:

- **CORS:** allow `PUT` from every connected app's origin, with the `Content-Type` header.
- **Lifecycle:** delete objects after a day, which cleans up uploads that never started.

## Register an app

```sql
INSERT INTO connected_apps (id, name, origins, daily_bytes, user_daily_deploys)
VALUES ('your-app', 'Your App', '["https://app.example"]', 1000000000, 5);
```

Derive the app's secret with `deriveAppSecret(MASTER_SECRET, 'your-app')`, and send it over a secure channel. To cut an app off, set `active = 0`.

Changing `MASTER_SECRET` invalidates every app's secret at once, so there's currently no way to rotate a single app's secret. Instead, register the app under a new id.

## Quotas

| Limit | Set in | Protects against |
|---|---|---|
| `limits.globalDailyBytes` | Gateway config | The pool being spent by all apps together |
| `daily_bytes` | `connected_apps` | One app using the pool |
| `user_daily_deploys` | `connected_apps` | One user using an app's quota |
| `limits.sponsorAttempts` | Gateway config | Repeated gas approvals per deployment |
| `maxCostPerOp` | Paymaster | One expensive operation |

Per-user limits depend on the connected app's logins, so `daily_bytes` is the limit that actually holds if an app is abused or its secret leaks. There is no daily cap on gas across all deployments yet, so the size of the paymaster deposit is the overall gas limit.

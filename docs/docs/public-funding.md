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
- **Renewals.** Storage bills recur. A daily sweep marks sites past `retention_until` as `expired`, but only the operator can renew them, and each renewal is a commitment the treasury has to cover. Set a retention period it can actually afford.
- **Content moderation.** Quotas limit how much is stored, not what. Only register apps you trust, and have a process for abuse reports. See [Take a site down](#take-a-site-down).

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
wrangler deploy
```

Configure the bucket:

- **CORS:** allow `PUT` from every connected app's origin, with the `Content-Type` header.
- **Lifecycle:** delete objects after a day, which cleans up uploads that never started.

### Secrets

Set each with `wrangler secret put`. None of them belong in a connected app or in `wrangler.jsonc`.

| Secret | Purpose | If it leaks |
|---|---|---|
| `MASTER_SECRET` | Derives every app's secret | Anyone can act as any app. Replace it, which invalidates every app at once |
| `ADMIN_SECRET` | Operator API. The API is off if this is unset | Anyone can register apps, read the audit log and take sites down |
| `PAYMASTER_SIGNER_KEY` | Approves gas sponsorship | See [Limiting losses](#limiting-losses) |
| `PINATA_TOKEN` and other provider tokens | Publishing to storage | Revoke it at the provider |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Signing upload URLs | Revoke it in Cloudflare |

Scope the R2 key to the one bucket. Scope any Cloudflare DNSLink token to the one zone.

## Operator API

These routes sit under the gateway's base path, and need `Authorization: Bearer $ADMIN_SECRET`. They're closed to browsers.

### Register an app

```sh
curl -X POST "$GATEWAY/admin/apps" -H "Authorization: Bearer $ADMIN_SECRET" -d '{
  "id": "your-app",
  "name": "Your App",
  "origins": ["https://app.example"],
  "dailyBytes": 1000000000,
  "userDailyDeploys": 5,
  "dailySponsorships": 20
}'
```

The response holds the app's secret. It's shown here and on rotation only, so send it over a secure channel.

| Route (`POST`) | Effect |
|---|---|
| `/admin/apps/:id/rotate` | Replaces one app's secret. Its existing sessions stop working |
| `/admin/apps/:id/suspend` | Stops the app deploying or using gas |
| `/admin/apps/:id/resume` | Reverses a suspension |
| `/admin/deployments/:id/renew` | Extends retention by `{ "days": 30 }`, and restores an expired site |
| `/admin/deployments/:id/remove` | Takes a site down, with a required `{ "reason": "..." }` |

`GET /admin/audit` returns the latest 200 audit entries. Everything that spends from the pool or removes content is recorded.

### Take a site down

`remove` unpins from every provider that holds the site, even if other deployments share its content. Check the response: a provider listed as `unsupported` has no unpin API, so remove it there by hand.

This stops the pool storing the site. It can't remove copies elsewhere, and an ENS name pointing at it keeps pointing there.

## Retention

The cron in the example runs the sweep daily. Sites past retention are marked `expired` and stay pinned, so nothing goes offline by accident. Set `limits.unpinExpired` to unpin them as well.

## Quotas

| Limit | Set in | Protects against |
|---|---|---|
| `limits.globalDailyBytes` | Gateway config | The pool being spent by all apps together |
| `limits.dailySponsorships` | Gateway config | Gas spent across all apps in a day |
| `dailyBytes` | Per app | One app using the pool |
| `dailySponsorships` | Per app | One app using the gas pool |
| `userDailyDeploys` | Per app | One user using an app's quota |
| `limits.sponsorAttempts` | Gateway config | Repeated gas approvals per deployment |
| `maxCostPerOp` | Paymaster | One expensive operation |
| `RATE_LIMITER` binding | `wrangler.jsonc` | Request floods, per user and per deployment |

Per-user limits depend on the connected app's logins, so `dailyBytes` and `dailySponsorships` are the limits that hold if an app is abused or its secret leaks.

The gateway enforces these. A leaked `PAYMASTER_SIGNER_KEY` bypasses the gas quotas, leaving only the cost cap and the size of the deposit.

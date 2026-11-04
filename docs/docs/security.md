# Security model

This describes what the gateway and contracts defend against, and what they don't.

::: danger Status
The contracts are unaudited. Nothing here has been tested against live providers, real wallets or a bundler. Don't put real funds behind it yet.
:::

## Who holds what

| Secret | Held by | Never reaches |
|---|---|---|
| Provider tokens | Gateway | Connected apps, browsers |
| Paymaster signer | Gateway | Connected apps, browsers |
| App secret | Connected app's server | Browsers |
| Session token | Browser, for 15 minutes | Other apps |
| Wallet keys | The user's wallet | Anything here |

The gateway holds no key that can move treasury funds, change an ENS name or sign for a user.

## Threats and defenses

| Threat | Defense |
|---|---|
| Publishing a different site from the CID shown | The workflow checks every block against the CID, and that no linked block is missing, before any provider is called |
| A provider storing the wrong content | A provider that returns a different CID counts as failed |
| Draining storage | Daily byte quotas per app and across the pool, enforced in one atomic statement |
| Draining gas | Daily approval caps, a per-deployment limit, and a cost cap per operation |
| Sponsoring something else | Approvals require this deployment's exact ENS update, and are bound to the sender, gas, nonce, chain and paymaster |
| Sponsoring a doomed transaction | The update is simulated from the sender first |
| Replaying an approval | Approvals are bound to the nonce and expire within minutes |
| Reaching another user's site | Every lookup is scoped to the app and user, and misses look the same as someone else's |
| Repointing someone's DNSLink | Denied unless `authorizeDnsLink` allows that user and hostname |
| Making the Worker call arbitrary URLs | Provider and RPC URLs come only from server config, and client fields are ignored |
| Unpinning someone else's site with a copy | A pin stays while another live deployment shares its CID |
| Publishing secrets by accident | `.env` files and private keys block the deploy |
| Zip bombs and path traversal | Declared sizes are checked before expanding, and unsafe paths are refused |
| Leaking details in errors | Unexpected errors return a generic message, and provider errors aren't stored |

## Known limits

- **Signer leaks.** A leaked paymaster signer can spend up to the cost cap per operation, until the deposit is gone. Keep the deposit small. See [Limiting losses](./public-funding#limiting-losses).
- **The master secret is a single point of failure.** It derives every app's secret.
- **Quotas trust connected apps.** A compromised app can spend its full daily quota under invented users. Only its own limits contain it.
- **Calldata is matched, not decoded.** Wallets encode batches differently, so an approved operation must contain the update but may carry other calls. The cost cap bounds this.
- **On-chain limits are coarse.** The paymaster only enforces the signature, expiry and cost cap. Daily limits live in the gateway.
- **Moderation is manual.** Nothing checks what's being published.
- **Removal isn't erasure.** Anyone can keep a copy of public IPFS content.
- **Storage isn't paid on-chain.** Treasury funds reach providers through the operator, who is trusted to do so.

## Reporting

Report vulnerabilities privately through GitHub security advisories on this repository, not in a public issue.

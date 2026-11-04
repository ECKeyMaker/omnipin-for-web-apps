# Security model

This describes what the embedded toolset defends against, and what's left to your app.

::: danger Status
Nothing here has been tested against live providers, or with real wallets. Test on Sepolia first.
:::

## Who holds what

| Secret | Held by | Never reaches |
|---|---|---|
| Provider tokens | Your Worker | Browsers |
| R2 keys | Your Worker | Browsers |
| Wallet keys | The user's wallet | Your Worker, or anything here |

Your Worker can't change an ENS name or sign for a user.

## Threats and defenses

| Threat | Defense |
|---|---|
| Publishing a different site from the CID shown | The workflow checks every block against the CID before any provider is called |
| Storing extra data on your accounts | A CAR with a block outside the site is rejected |
| A provider storing the wrong content | A provider that returns a different CID counts as failed, and an upload must return one |
| Calling a site live before it is | `published` needs a provider to report `pinned`. ENS and DNSLink wait for that |
| Overspending | Optional daily quotas, enforced in one atomic statement, plus your `authorizeDeploy` |
| Reaching another user's site | Every lookup is scoped to the user, and misses look the same as someone else's |
| Another site using a signed-in user's cookies | Requests from origins you haven't listed are refused |
| Repointing someone's DNSLink | Denied unless `authorizeDnsLink` allows that user and hostname |
| Making the Worker call arbitrary URLs | Provider and RPC URLs come only from server config, and client fields are ignored |
| Unpinning someone else's site with a copy | A pin stays while another live deployment shares its CID |
| A creator pulling a site others rely on | User removal is off unless you turn it on |
| Publishing secrets by accident | `.env` files and private keys block the deploy |
| Zip bombs and path traversal | Declared sizes are checked before expanding, and unsafe paths are refused |
| Leaking details in errors | Unexpected errors return a generic message, and provider errors aren't stored |

## What's left to your app

- **`authenticate` is your front door.** Everyone it accepts can spend from your provider accounts. Set quotas too, as they're off by default.
- **Moderation.** Nothing checks what's being published, and you're hosting it on your accounts.
- **Removal isn't erasure.** Anyone can keep a copy of public IPFS content.

Quotas only limit what passes through the gateway. Anyone holding a provider token can use that account directly.

## Reporting

Report vulnerabilities privately through GitHub security advisories on this repository, not in a public issue.

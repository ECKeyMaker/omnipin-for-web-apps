# Omnipin Developer Guide

Guidelines for agentic coding agents operating in this repository.

---

## 1. Build, Lint, and Test Commands

```bash
pnpm install         # Install dependencies
pnpm build           # Build with rslib to dist/
pnpm types           # TypeScript type checking
pnpm check           # Biome linter/formatter
pnpm check:core      # After build: fail if Node built-ins reached dist/index.js
pnpm test:report     # Run tests with coverage
pnpm test            # Run all tests
pnpm test:contracts  # Run Solidity tests (needs Foundry)
node --experimental-test-module-mocks --import ./test/register.ts --test path  # Run specific test file
node --env-file=.env.local --experimental-test-module-mocks --import ./test/register.ts --test path  # With env vars
```

---

## 2. Code Style Guidelines

### Formatting
- **Indent**: 2 spaces
- **Quotes**: Single quotes (`'`)
- **Semicolons**: As needed (Biome handles this)

### Imports
- Use explicit `.js` extensions for local imports: `import { foo } from './bar.js'`
- Group order: Node built-ins → External packages → Internal modules
- Use `import type` for type-only imports

### Types
- Use TypeScript for all new code
- Avoid `any` - use proper generic types
- Use `T = object` as default generic for provider configs
- CID values must be CIDv1 (`bafybe...`), never CIDv0 (`Qm...`)

### Naming Conventions
| Type | Convention | Example |
|------|------------|---------|
| Variables | camelCase | `providerName` |
| Constants | UPPER_SNAKE_CASE | `PROVIDERS` |
| Functions | camelCase | `pinOnAioz` |
| Classes | PascalCase | `DeployError` |
| Files | kebab-case | `aioz.ts` |

### Provider Function Naming
- `uploadOn{Provider}` - handles both upload and pin
- `pinOn{Provider}` - pin-only provider
- `statusOn{Provider}` - status check function

### Error Handling
Use custom error classes from `src/errors.ts`:
```typescript
throw new DeployError(providerName, errorMessage)
throw new UploadNotSupportedError(providerName)
throw new MissingKeyError('PROVIDER_KEY')
```

---

## 3. Writing Providers

Create provider file at `src/providers/ipfs/{provider}.ts`:

```typescript
import { DeployError, UploadNotSupportedError } from '../../errors.js'
import type { UploadFunction } from '../../types.js'

const providerName = 'ProviderName'

export const uploadOnProvider: UploadFunction = async ({
  first, token, verbose, name = '', cid
}) => {
  if (first) throw new UploadNotSupportedError(providerName)

  const res = await fetch('https://api.provider.example/pin', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cid, name }),
  })

  if (verbose) logger.request('POST', res.url, res.status)

  const json = await res.json()
  if (!res.ok) {
    throw new DeployError(providerName, json.message || 'Pinning failed')
  }

  return { cid: json.data.cid }
}
```

Register in `src/constants.ts` with `{PROVIDER}_TOKEN` key:
```typescript
export const PROVIDERS = {
  PROVIDER_TOKEN: {
    name: 'ProviderName',
    upload: uploadOnProvider,
    supported: 'pin' | 'upload' | 'both',
    protocol: 'ipfs' | 'swarm',
  },
}
```

---

## 4. Tests

- Test files: `test/providers/<provider>.test.ts`
- Use the `node:test` runner with `node:assert`
- Use CIDv1 for test CIDs (`bafybe...`)
- Skip live API tests if no token: pass `{ skip: !hasToken }` to `it()`
- `pnpm test` must not need the network. Tests that call a live service without a token skip unless `OMNIPIN_LIVE_TESTS=1`, which CI sets

```typescript
import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import { UploadNotSupportedError } from '../../src/errors.js'
import { pinOnProvider } from '../../src/providers/ipfs/provider.js'

const hasToken = Boolean(process.env.OMNIPIN_PROVIDER_TOKEN)

describe('ProviderName', () => {
  it('should throw if first provider', async () => {
    await assert.rejects(
      pinOnProvider({ first: true, token: 'key', cid: '...', name: 'test', car: new Blob(), size: 0 }),
      UploadNotSupportedError,
    )
  })

  it('should pin successfully', { skip: !hasToken, timeout: 30_000 }, async () => {
    // Live test
  })
})
```

---

## 5. Environment Variables

Tokens use prefix `OMNIPIN_`:
```
OMNIPIN_PINATA_TOKEN=xxx
OMNIPIN_AIOZ_TOKEN=api_key:api_secret
```

---

## 6. Project Structure

```
/src
  /actions        # CLI actions (deploy, pin, status)
  /providers/ipfs # IPFS providers (pinata, lighthouse, aioz)
  /providers/swarm# Swarm providers (bee, swarmy)
  /utils          # Utility functions
  constants.ts    # Provider registry
  deploy.ts       # Runtime-neutral deploy
  index.ts        # Library entry point
  errors.ts       # Custom error classes
  types.ts        # Core type definitions
  cli.ts          # CLI entry point

/test
  /providers      # Provider tests
  /utils          # Utility tests
/contracts          # SponsorPaymaster, tests and deploy script (Foundry)
/examples           # Connected gateway template
dist/             # Build output
```

---

## 7. Key Patterns

### Supported Methods
- `pin` - Only pinning supported
- `upload` - Only upload supported
- `both` - Both upload and pin supported

### Token Parsing
Tokens are parsed in `src/utils/env.ts`. The `OMNIPIN_` prefix is stripped.

### Runtime Boundaries
`src/index.ts` is the runtime-neutral core for browsers and Cloudflare Workers. Nothing it reaches may import a `node:` module or use `process` unguarded.
- Node-only code lives in `src/actions`, `src/cli.ts`, `src/utils/fs.ts` and `src/utils/pack-node.ts`
- Providers that need Node are registered in `src/providers/node.ts`, not `src/constants.ts`
- `src/client`, `src/react` and `src/worker` are the embeddable layers. `src/client` must never receive secrets
- `src/worker` is the funding gateway. Never accept provider URLs, RPC URLs or tokens from a client
- `SponsorPaymaster.getHash` and `paymasterHash` in `src/worker/paymaster.ts` must match; both pin the same vector in their tests
- `src/deploy.ts` reports through its return value and `onEvent`, never the terminal

### Documentation
Use `context7` tools to search docs when needed.

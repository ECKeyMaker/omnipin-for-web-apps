// Fails if a Node built-in reached the browser/Worker bundle. Run after a
// build; `omnipin` core must stay importable with no `node:` modules.
import { readFile } from 'node:fs/promises'

const bundle = await readFile('dist/index.js', 'utf8')
const builtins = [...bundle.matchAll(/(?:from|import\()\s*['"](node:[^'"]+)/g)]

if (builtins.length) {
  console.error(
    `dist/index.js imports Node built-ins: ${[...new Set(builtins.map((m) => m[1]))].join(', ')}`,
  )
  process.exit(1)
}

console.log('dist/index.js has no Node built-ins')

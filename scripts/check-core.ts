// Fails if a Node built-in reached a browser or Worker bundle, shared chunks
// included. Run after a build: only the CLI may use `node:` modules.
import { readdir, readFile } from 'node:fs/promises'

const bundles = (await readdir('dist')).filter(
  (file) => file.endsWith('.js') && file !== 'cli.js',
)
let failed = false

for (const name of bundles) {
  const bundle = await readFile(`dist/${name}`, 'utf8')
  const builtins = bundle.matchAll(/(?:from|import\()\s*['"](node:[^'"]+)/g)
  const found = [...new Set(Array.from(builtins, (m) => m[1]))]

  if (found.length) {
    console.error(`dist/${name} imports: ${found.join(', ')}`)
    failed = true
  }
}

// The bundle has no `React` import, so classic JSX would crash on first render.
if ((await readFile('dist/react.js', 'utf8')).includes('React.createElement')) {
  console.error('dist/react.js uses classic JSX and would crash when rendered')
  failed = true
}

if (failed) process.exit(1)
console.log(`No Node built-ins in: ${bundles.join(', ')}`)

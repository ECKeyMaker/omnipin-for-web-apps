import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import {
  fromDataTransfer,
  fromFileList,
  fromZip,
  InvalidSiteError,
  prepareSite,
  type SiteFile,
} from '../../src/client/files.js'
import { packSite } from '../../src/client/pack.js'
import { packFiles } from '../../src/utils/ipfs.js'

const file = (path: string, text = 'x'): SiteFile => ({
  path,
  content: new Blob([text]),
})
const paths = (files: SiteFile[]) => files.map((f) => f.path).sort()

describe('prepareSite', () => {
  it('keeps a valid site', () => {
    const { files, size } = prepareSite([
      file('index.html', 'hi'),
      file('a/b.css', 'yo'),
    ])
    assert.deepStrictEqual(paths(files), ['a/b.css', 'index.html'])
    assert.strictEqual(size, 4)
  })

  it('strips a single wrapping folder', () => {
    const { files } = prepareSite([
      file('dist/index.html'),
      file('dist/a/b.js'),
    ])
    assert.deepStrictEqual(paths(files), ['a/b.js', 'index.html'])
  })

  it('does not strip when index.html is already at the root', () => {
    const { files } = prepareSite([file('index.html')])
    assert.deepStrictEqual(paths(files), ['index.html'])
  })

  it('normalizes Windows separators and leading ./', () => {
    const { files } = prepareSite([file('.\\index.html'), file('./a\\b.js')])
    assert.deepStrictEqual(paths(files), ['a/b.js', 'index.html'])
  })

  for (const path of [
    '../evil.html',
    'a/../../evil.html',
    '/etc/passwd',
    'C:\\Windows\\evil.html',
    'a\0b.html',
  ])
    it(`rejects unsafe path ${JSON.stringify(path)}`, () => {
      assert.throws(
        () => prepareSite([file('index.html'), file(path)]),
        /Unsafe file path/,
      )
    })

  it('drops tooling folders', () => {
    const { files } = prepareSite([
      file('index.html'),
      file('node_modules/x/index.js'),
      file('.git/config'),
      file('.DS_Store'),
    ])
    assert.deepStrictEqual(paths(files), ['index.html'])
  })

  for (const path of [
    '.env',
    '.env.production',
    'deep/.env.local',
    '.npmrc',
    'server.pem',
    'tls/private.key',
    'id_rsa',
    '.git-credentials',
  ])
    it(`refuses to publish ${path}`, () => {
      assert.throws(
        () => prepareSite([file('index.html'), file(path)]),
        /may contain secrets/,
      )
    })

  it('allows files that only resemble secrets', () => {
    const { files } = prepareSite([
      file('index.html'),
      file('environment.js'),
      file('key.png'),
      file('.envelope.svg'),
    ])
    assert.strictEqual(files.length, 4)
  })

  it('requires index.html at the root', () => {
    assert.throws(() => prepareSite([file('page.html')]), InvalidSiteError)
  })

  it('rejects an empty site', () => {
    assert.throws(() => prepareSite([]), /No files/)
    assert.throws(() => prepareSite([file('index.html', '')]), /empty/)
  })

  it('enforces limits', () => {
    assert.throws(
      () => prepareSite([file('index.html', 'abcd')], { maxBytes: 3 }),
      /byte limit/,
    )
    assert.throws(
      () => prepareSite([file('index.html'), file('a')], { maxFiles: 1 }),
      /Too many files/,
    )
  })
})

describe('fromZip', () => {
  const zip = (entries: Record<string, Uint8Array>) =>
    new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>])

  it('reads a zip into a publishable site', async () => {
    const files = await fromZip(
      zip({
        'site/index.html': strToU8('hi'),
        'site/a.js': strToU8('js'),
      }),
    )
    assert.deepStrictEqual(paths(prepareSite(files).files), [
      'a.js',
      'index.html',
    ])
  })

  it('refuses a zip that expands past the limit', async () => {
    await assert.rejects(
      fromZip(zip({ 'bomb.bin': new Uint8Array(5_000_000) }), {
        maxBytes: 1_000_000,
      }),
      /expands past/,
    )
  })

  it('reports an unreadable file', async () => {
    await assert.rejects(
      fromZip(new Blob(['not a zip'])),
      /Could not read the zip file/,
    )
  })

  it('leaves traversal in a zip for prepareSite to reject', async () => {
    const files = await fromZip(zip({ '../evil.html': strToU8('x') }))
    assert.throws(() => prepareSite(files), /Unsafe file path/)
  })
})

describe('fromFileList', () => {
  it('keeps folder structure from a directory picker', () => {
    const file = new File(['hi'], 'index.html')
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'dist/index.html',
    })
    assert.deepStrictEqual(paths(fromFileList([file])), ['dist/index.html'])
  })
})

describe('fromDataTransfer', () => {
  const fileEntry = (path: string) => ({
    isFile: true,
    isDirectory: false,
    fullPath: path,
    file: (done: (f: File) => void) => done(new File(['x'], 'f')),
  })

  it('walks dropped folders across every readEntries batch', async () => {
    const batches = [
      [fileEntry('/site/index.html')],
      [fileEntry('/site/a.js')],
      [],
    ]
    const folder = {
      isFile: false,
      isDirectory: true,
      fullPath: '/site',
      createReader: () => ({
        readEntries: (done: (e: unknown[]) => void) =>
          done(batches.shift() ?? []),
      }),
    }

    const files = await fromDataTransfer({
      items: [{ webkitGetAsEntry: () => folder }],
      files: [],
    } as unknown as DataTransfer)

    assert.deepStrictEqual(paths(files), ['site/a.js', 'site/index.html'])
  })

  it('falls back to plain files', async () => {
    const files = await fromDataTransfer({
      items: [],
      files: [new File(['x'], 'index.html')],
    } as unknown as DataTransfer)
    assert.deepStrictEqual(paths(files), ['index.html'])
  })
})

describe('packSite', () => {
  it('reports progress through to the full size', async () => {
    const seen: number[] = []
    await packSite(
      [{ path: 'big.bin', content: new Blob([new Uint8Array(2_500_000)]) }],
      ({ done, total }) => {
        assert.strictEqual(total, 2_500_000)
        seen.push(done)
      },
    )
    assert.strictEqual(seen.at(-1), 2_500_000)
    assert.ok(seen.length > 1)
  })

  it('matches packFiles, so browser and CLI agree on the CID', async () => {
    const big = new Uint8Array(3_000_000).map((_, i) => i % 251)
    const site = await packSite([
      { path: 'index.html', content: new Blob(['hi']) },
      { path: 'big.bin', content: new Blob([big]) },
    ])
    const { rootCID, bytes } = await packFiles([
      { path: 'index.html', content: new TextEncoder().encode('hi') },
      { path: 'big.bin', content: big },
    ])

    assert.strictEqual(site.cid, rootCID.toString())
    assert.strictEqual(site.size, bytes.byteLength)
  })
})

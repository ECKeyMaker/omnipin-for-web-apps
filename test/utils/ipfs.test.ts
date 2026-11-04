import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import { CarReader } from '@ipld/car/reader'
import { CarWriter } from '@ipld/car/writer'
import * as dagPb from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'
import { InvalidCARError } from '../../src/errors.js'
import {
  assertCID,
  isSameCID,
  packFiles,
  verifyCAR,
} from '../../src/utils/ipfs.js'
import { packCAR } from '../../src/utils/pack-node.js'
import { cases } from '../fixtures/unixfs-cases.js'

const te = new TextEncoder()

// Depth-first from the root, each node before its children, links in order,
// each block once -- the order trustless gateways serve a DAG in.
const dfsOrder = async (reader: CarReader, root: CID) => {
  const order: string[] = []
  const seen = new Set<string>()

  const visit = async (cid: CID) => {
    if (seen.has(cid.toString())) return
    seen.add(cid.toString())
    order.push(cid.toString())

    if (cid.code !== dagPb.code) return

    const block = await reader.get(cid)
    assert.ok(block, `CAR is missing linked block ${cid}`)

    for (const link of dagPb.decode(block.bytes).Links) await visit(link.Hash)
  }

  await visit(root)

  return order
}

describe('ipfs utils', () => {
  describe('packFiles', () => {
    it('produces the same CAR whatever order files arrive in', async () => {
      const files = ['b.txt', 'a.txt', 'nested/c.txt'].map((path) => ({
        path,
        content: te.encode(path),
      }))

      const forward = await packFiles(files)
      const reversed = await packFiles(files.toReversed())

      assert.strictEqual(
        forward.rootCID.toString(),
        reversed.rootCID.toString(),
      )
      assert.deepStrictEqual(forward.bytes, reversed.bytes)
    })

    it('matches packCAR', async () => {
      const files = [{ path: 'a.txt', content: te.encode('A') }]
      const pure = await packFiles(structuredClone(files))
      const node = await packCAR(structuredClone(files), 'parity')
      assert.strictEqual(pure.rootCID.toString(), node.rootCID.toString())
      assert.deepStrictEqual(pure.bytes, node.bytes)
    })

    it('does not reorder the array it was given', async () => {
      const files = ['b', 'a'].map((path) => ({
        path,
        content: te.encode(path),
      }))
      await packFiles(files)
      assert.deepStrictEqual(
        files.map((f) => f.path),
        ['b', 'a'],
      )
    })
  })

  describe('verifyCAR', () => {
    const site = () =>
      packFiles([
        { path: 'index.html', content: te.encode('<h1>site</h1>') },
        { path: 'big.bin', content: new Uint8Array(600_000).fill(7) },
      ])
    const stream = (bytes: Uint8Array) =>
      (async function* () {
        yield bytes
      })()

    it('accepts an intact CAR', async () => {
      const { bytes, rootCID } = await site()
      await verifyCAR(stream(bytes), rootCID.toString())
    })

    it('rejects a CAR claiming another root', async () => {
      const { bytes } = await site()
      const other = await packFiles([
        { path: 'index.html', content: te.encode('other') },
      ])
      await assert.rejects(
        verifyCAR(stream(bytes), other.rootCID.toString()),
        InvalidCARError,
      )
    })

    it('rejects changed block bytes', async () => {
      const { bytes, rootCID } = await site()
      const tampered = bytes.slice()
      tampered[tampered.length - 5] ^= 0xff
      await assert.rejects(
        verifyCAR(stream(tampered), rootCID.toString()),
        InvalidCARError,
      )
    })

    it('rejects a CAR with a linked block missing', async () => {
      const { bytes, rootCID } = await site()
      const reader = await CarReader.fromBytes(bytes)
      const { writer, out } = CarWriter.create([rootCID])
      const collected = Array.fromAsync(out)
      let kept = 0
      for await (const block of reader.blocks())
        if (kept++ < 2) await writer.put(block)
      await writer.close()
      const partial = new Uint8Array(
        await new Blob((await collected) as BlobPart[]).arrayBuffer(),
      )
      await assert.rejects(
        verifyCAR(stream(partial), rootCID.toString()),
        /missing block/,
      )
    })

    it('rejects something that is not a CAR', async () => {
      const { rootCID } = await site()
      await assert.rejects(
        verifyCAR(stream(te.encode('not a car')), rootCID.toString()),
        InvalidCARError,
      )
    })
  })

  describe('isSameCID', () => {
    const v0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
    const v1 = CID.parse(v0).toV1().toString()
    const other = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

    it('matches across CID versions', () => {
      assert.strictEqual(isSameCID(v0, v1), true)
    })

    it('rejects different content', () => {
      assert.strictEqual(isSameCID(v1, other), false)
    })

    it('does not treat a non-CID reply as a mismatch', () => {
      assert.strictEqual(isSameCID('request-id-123', v1), true)
    })
  })

  describe('packCAR', () => {
    it('should pack files into a CAR and return bytes and rootCID', async () => {
      const files = [
        {
          path: 'a.txt',
          content: te.encode('File A'),
        },
        {
          path: 'b.txt',
          content: te.encode('File B'),
        },
        {
          path: 'nested/c.txt',
          content: te.encode('File C'),
        },
      ]

      const { bytes, rootCID } = await packCAR(files, 'test-car')

      assert.ok(bytes instanceof Uint8Array)
      assert.ok(rootCID)
      assert.ok(rootCID.toString().startsWith('bafy'))
    })

    it('writes blocks under their importer-assigned codec', async () => {
      // Regression test for the MemoryBlockstore.getAll() bug where every
      // block was rebuilt as `CID.createV1(raw.code, multihash)`, regardless
      // of whether the UnixFS importer originally assigned dag-pb (for
      // directories and chunked-file roots) or raw (for leaf chunks).
      //
      // Before the fix, the CAR's declared root was a dag-pb CID
      // (`bafybei…`) but the block in the CAR with the matching multihash
      // was written as a raw CID (`bafkrei…`), so `reader.has(rootCID)`
      // returned false — the CAR could not resolve its own root.
      //
      // We use a file >256KB so the importer chunks it: that path
      // produces both raw leaf blocks and a dag-pb intermediate root for
      // the chunked file, exercising the mixed-codec case end-to-end.
      const files = [
        { path: 'index.html', content: te.encode('<html>hi</html>') },
        { path: 'sub/big.bin', content: new Uint8Array(400 * 1024) },
      ]

      const { bytes, rootCID } = await packCAR(files, 'codec-regression')
      const reader = await CarReader.fromBytes(bytes)

      // The root CID declared in the CAR header must be a dag-pb CID
      // (wrapping directory) and must be present as a block inside the
      // CAR itself.
      assert.strictEqual(rootCID.code, dagPb.code, 'root CID should be dag-pb')
      assert.ok(
        await reader.has(rootCID),
        'CAR must contain a block for its own declared root CID',
      )

      // And that block's bytes must actually parse as dag-pb (i.e. the
      // codec field in the CID matches the encoded payload).
      const rootBlock = await reader.get(rootCID)
      assert.ok(rootBlock)
      const decoded = dagPb.decode(rootBlock.bytes)
      assert.strictEqual(
        decoded.Links?.length,
        2,
        'wrapping directory should link to index.html and sub/',
      )

      // The CAR should contain a mix of dag-pb and raw blocks. Pre-fix
      // it contained raw blocks only.
      const codecs = new Set<number>()
      for await (const block of reader.blocks()) {
        codecs.add(block.cid.code)
      }
      assert.ok(
        codecs.has(dagPb.code),
        'CAR should contain at least one dag-pb block (directory / chunked-file root)',
      )
      assert.ok(
        codecs.has(0x55),
        'CAR should contain at least one raw block (file leaf chunk)',
      )
    })

    // The importer writes blocks as its concurrent file imports finish, so
    // emitting them in that order made the CAR bytes -- and the Filecoin
    // piece CID over them -- change between runs.
    for (const { name, files } of cases) {
      it(`writes ${name} in DAG order, byte for byte the same every time`, async () => {
        // structuredClone: the importer normalises `path` in place
        const first = await packCAR(structuredClone(files), `order-${name}`)
        const second = await packCAR(structuredClone(files), `order-${name}`)

        assert.deepStrictEqual(first.bytes, second.bytes)

        const reader = await CarReader.fromBytes(first.bytes)
        const written: string[] = []
        for await (const { cid } of reader.blocks())
          written.push(cid.toString())

        assert.deepStrictEqual(written, await dfsOrder(reader, first.rootCID))
      })
    }
  })

  describe('assertCID', () => {
    it('should not throw for valid base32 CID', () => {
      assert.doesNotThrow(() => {
        assertCID('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
      })
    })

    it('should throw for invalid CID', () => {
      assert.throws(
        () => {
          assertCID('invalid-cid')
        },
        {
          name: 'InvalidCIDError',
        },
      )
    })
  })
})

import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { createPresignedUrl } from '@stauro/filebase-upload'
import { DeployError } from '../../src/errors.js'
import { uploadOnS3 } from '../../src/providers/ipfs/s3.js'
import { presignPut } from '../../src/utils/s3.js'

const token = btoa('ACCESSKEY:secret/key+value')
const args = {
  name: 'test.car',
  bytes: new Uint8Array(),
  token,
  bucketName: 'bucketName',
  apiUrl: 'example.com',
  providerName: 'S3',
  verbose: false,
  size: 0,
}

const realFetch = globalThis.fetch
let requests: { url: string; init?: RequestInit }[]
let uploadResponse: () => Response

beforeEach(() => {
  requests = []
  globalThis.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    return String(url).includes('X-Amz-Signature')
      ? uploadResponse()
      : new Response(null, { status: 200 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  mock.timers.reset()
})

describe('s3', () => {
  it('should upload a car to s3', async () => {
    uploadResponse = () => new Response(null, { status: 200 })
    const res = await uploadOnS3(args)
    assert.strictEqual(res.status, 200)

    const put = requests.at(-1)
    assert.strictEqual(put?.init?.method, 'PUT')
    assert.deepStrictEqual(put?.init?.headers, { 'x-amz-meta-import': 'car' })
  })

  it('should throw if upload fails', async () => {
    uploadResponse = () => new Response('mock', { status: 400 })
    await assert.rejects(uploadOnS3(args), DeployError)
  })

  it('should still upload when creating the bucket fails', async () => {
    uploadResponse = () => new Response(null, { status: 200 })
    const fetchMock = globalThis.fetch
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!String(url).includes('X-Amz-Signature'))
        throw new Error('network down')
      return fetchMock(url, init)
    }) as typeof fetch

    assert.strictEqual((await uploadOnS3(args)).status, 200)
  })

  it('should sign exactly like @stauro/filebase-upload', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 2, 4, 5, 6, 7) })

    const file = new File([], 'site.car')
    const target = { bucketName: 'my-bucket', apiUrl: 's3.filebase.com', token }

    const expected = new URL(
      decodeURIComponent(await createPresignedUrl({ ...target, file })),
    )
    const actual = new URL(await presignPut({ ...target, filename: file.name }))

    assert.strictEqual(actual.origin, expected.origin)
    assert.strictEqual(actual.pathname, expected.pathname)
    assert.deepStrictEqual(
      Object.fromEntries(actual.searchParams),
      Object.fromEntries(expected.searchParams),
    )
  })

  it('should percent-encode file names in the signed path', async () => {
    const url = await presignPut({
      bucketName: 'bucket',
      apiUrl: 'example.com',
      token,
      filename: 'my site.car',
    })
    assert.ok(url.startsWith('https://example.com/bucket/my%20site.car?'))
  })

  it('should reject a malformed token', async () => {
    await assert.rejects(
      presignPut({
        bucketName: 'bucket',
        apiUrl: 'example.com',
        token: btoa('no-separator'),
        filename: 'a.car',
      }),
      /Missing access key ID/,
    )
  })
})

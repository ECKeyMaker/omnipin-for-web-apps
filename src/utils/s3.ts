const textEncoder = new TextEncoder()

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')

const sha256Hex = async (message: string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', textEncoder.encode(message)))

const hmac = async (
  key: Uint8Array<ArrayBuffer>,
  message: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(message)),
  )
}

const signingKey = async (
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const kDate = await hmac(
    textEncoder.encode(`AWS4${secretAccessKey}`),
    dateStamp,
  )
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

const signature = async (
  key: Uint8Array<ArrayBuffer>,
  stringToSign: string,
): Promise<string> => toHex((await hmac(key, stringToSign)).buffer)

const timestamps = (now: Date) => {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

const parseCredentials = (token: string) => {
  const [accessKeyId, secretAccessKey] = atob(token)
    .split(':')
    .map((part) => part.trim())

  if (!accessKeyId || !secretAccessKey)
    throw new Error('Missing access key ID and secret access key')

  return { accessKeyId, secretAccessKey }
}

const encodePath = (path: string): string =>
  path.split('/').map(encodeURIComponent).join('/')

type S3Target = {
  apiUrl: string
  bucketName: string
  token: string
  region?: string
}

/**
 * Presign an S3 `PUT` with SigV4 query authentication, using Web Crypto so it
 * runs in Workers and browsers as well as Node.
 */
export const presignPut = async ({
  apiUrl,
  bucketName,
  token,
  filename,
  region = 'us-east-1',
  expiresIn = 3600,
  now = new Date(),
}: S3Target & {
  filename: string
  expiresIn?: number
  now?: Date
}): Promise<string> => {
  const { accessKeyId, secretAccessKey } = parseCredentials(token)
  const { amzDate, dateStamp } = timestamps(now)
  const path = `/${encodePath(bucketName)}/${encodePath(filename)}`
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  }

  const canonicalQuery = Object.entries(query)
    .sort()
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const canonicalRequest = [
    'PUT',
    path,
    canonicalQuery,
    `host:${apiUrl}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const sig = await signature(
    await signingKey(secretAccessKey, dateStamp, region),
    stringToSign,
  )

  return `https://${apiUrl}${path}?${canonicalQuery}&X-Amz-Signature=${sig}`
}

/** Build the signed request that creates a bucket on an S3-compatible API. */
export const signCreateBucket = async ({
  apiUrl,
  bucketName,
  token,
  region = 'us-east-1',
  now = new Date(),
}: S3Target & { now?: Date }): Promise<{
  url: string
  init: RequestInit
}> => {
  const { accessKeyId, secretAccessKey } = parseCredentials(token)
  const { amzDate, dateStamp } = timestamps(now)
  const host = `${bucketName}.${apiUrl}`
  const payloadHash = await sha256Hex('')
  const signedHeaders = 'content-length;host;x-amz-content-sha256;x-amz-date'
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`

  const canonicalRequest = [
    'PUT',
    '/',
    '',
    `content-length:0\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const sig = await signature(
    await signingKey(secretAccessKey, dateStamp, region),
    stringToSign,
  )

  return {
    url: `https://${host}/`,
    init: {
      method: 'PUT',
      headers: {
        'Content-Length': '0',
        'X-Amz-Content-Sha256': payloadHash,
        'X-Amz-Date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
      },
    },
  }
}

/**
 * Upload a CAR to an S3-compatible API that imports `x-amz-meta-import: car`.
 * Creating the bucket is best-effort: it already exists on all but the first
 * deploy, and a real problem surfaces on the `PUT` that follows.
 */
export const uploadCar = async ({
  file,
  ...target
}: S3Target & { file: File }): Promise<Response> => {
  const { url, init } = await signCreateBucket(target)
  await fetch(url, init)
    .then((res) => res.body?.cancel())
    .catch(() => {})

  return fetch(await presignPut({ ...target, filename: file.name }), {
    method: 'PUT',
    body: file,
    headers: { 'x-amz-meta-import': 'car' },
  })
}

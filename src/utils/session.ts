const textEncoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  )

const hmacKey = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )

/**
 * The secret a connected app signs sessions with. It's derived from the
 * gateway's master secret, so the gateway stores no per-app secrets.
 */
export const deriveAppSecret = async (
  masterSecret: string,
  appId: string,
  version = 1,
): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        await hmacKey(masterSecret, 'sign'),
        textEncoder.encode(`omnipin-app:${version}:${appId}`),
      ),
    ),
  )

export type Session = {
  /** Connected app the session belongs to. */
  app: string
  /** That app's user. Quotas are counted per user. */
  sub: string
  /** Expiry, in seconds since the epoch. */
  exp: number
  /** Limits a token to one purpose, such as sponsoring one deployment. */
  scope?: string
}

/**
 * Mint a short-lived session. A connected app calls this on its own server,
 * after authenticating its user, and hands the token to its frontend. The app
 * secret must never reach a browser.
 */
export const createSessionToken = async ({
  appId,
  userId,
  secret,
  expiresIn = 900,
  scope,
  now = Date.now(),
}: {
  appId: string
  userId: string
  secret: string
  /** Lifetime in seconds. */
  expiresIn?: number
  scope?: string
  now?: number
}): Promise<string> => {
  const session: Session = {
    app: appId,
    sub: userId,
    exp: Math.floor(now / 1000) + expiresIn,
    ...(scope ? { scope } : {}),
  }
  const body = toBase64Url(textEncoder.encode(JSON.stringify(session)))
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, 'sign'),
    textEncoder.encode(body),
  )
  return `${body}.${toBase64Url(new Uint8Array(signature))}`
}

/** @returns The session, or `undefined` if the token isn't valid or has expired. */
export const verifySessionToken = async (
  token: string,
  secretFor: (appId: string) => string | Promise<string>,
  now = Date.now(),
): Promise<Session | undefined> => {
  try {
    const [body, signature, extra] = token.split('.')
    if (!body || !signature || extra !== undefined) return undefined

    const session = JSON.parse(
      new TextDecoder().decode(fromBase64Url(body)),
    ) as Session

    if (typeof session.app !== 'string' || typeof session.sub !== 'string')
      return undefined

    // `verify` compares in constant time, unlike comparing two strings.
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(await secretFor(session.app), 'verify'),
      fromBase64Url(signature),
      textEncoder.encode(body),
    )

    return valid && session.exp * 1000 > now ? session : undefined
  } catch {
    return undefined
  }
}

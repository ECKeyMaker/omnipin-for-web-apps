import { createSessionToken } from 'omnipin-web-apps'

type Env = {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  OMNIPIN_APP_ID: string
  OMNIPIN_APP_SECRET: string
  /** Local development only. Never set this in production. */
  DEV_USER?: string
}

/**
 * REPLACE THIS with your app's real login check, returning a stable user id.
 *
 * It refuses everyone until you do, because per-user quotas are only as strong
 * as this function: anyone who gets a token spends from the public pool.
 */
const getUserId = async (
  _request: Request,
  env: Env,
): Promise<string | null> => env.DEV_USER ?? null

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (pathname !== '/api/omnipin-token') return env.ASSETS.fetch(request)
    if (request.method !== 'POST')
      return new Response('Method not allowed', { status: 405 })

    const userId = await getUserId(request, env)
    if (!userId) return new Response('Sign in first', { status: 401 })

    return new Response(
      await createSessionToken({
        appId: env.OMNIPIN_APP_ID,
        userId,
        secret: env.OMNIPIN_APP_SECRET,
      }),
    )
  },
}

// Runtime-neutral stand-ins for the Node built-ins the core used to import.
// Everything reachable from `src/index.ts` must run unchanged in browsers and
// Cloudflare Workers, so nothing here may import a `node:` module or touch
// `process` without guarding for it.

const runtimeProcess = globalThis.process as typeof process | undefined

export const isTTY = Boolean(runtimeProcess?.stdout?.isTTY)

export const setTimeout = (ms: number): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, ms))

/**
 * Uniform random integer in `[0, max)`. Rejection sampling avoids the modulo
 * bias of `getRandomValues(...)[0] % max`.
 */
export const randomInt = (max: number): number => {
  if (!Number.isSafeInteger(max) || max <= 0 || max > 2 ** 32)
    throw new RangeError(`randomInt: invalid max ${max}`)

  const limit = 2 ** 32 - (2 ** 32 % max)
  const buffer = new Uint32Array(1)
  let value: number

  do {
    crypto.getRandomValues(buffer)
    value = buffer[0]
  } while (value >= limit)

  return value % max
}

const styles = {
  bold: [1, 22],
  underline: [4, 24],
  white: [37, 39],
  green: [32, 39],
  cyan: [36, 39],
  gray: [90, 39],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
} as const

export const styleText = (style: keyof typeof styles, text: string): string => {
  if (!isTTY || runtimeProcess?.env?.NO_COLOR) return text
  const [open, close] = styles[style]
  return `\u001b[${open}m${text}\u001b[${close}m`
}

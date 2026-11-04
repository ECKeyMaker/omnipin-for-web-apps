import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type {
  D1Database,
  GatewayEnv,
  R2Object,
} from '../../src/worker/types.js'

/** D1's API over a real SQLite database, so the gateway's SQL actually runs. */
export const createDb = (): D1Database & { sqlite: DatabaseSync } => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync('src/worker/schema.sql', 'utf8'))

  const positional = (sql: string, values: unknown[]) => {
    // Rewrites `?1` to a named form node:sqlite binds regardless of reuse.
    const named = sql.replace(/\?(\d+)/g, '$p$1')
    const params: Record<string, unknown> = {}
    values.forEach((value, i) => {
      if (named.includes(`$p${i + 1}`)) params[`p${i + 1}`] = value
    })
    return { named, params }
  }

  return {
    sqlite,
    prepare(sql) {
      const statement = (values: unknown[]) => {
        const { named, params } = positional(sql, values)
        const run = sqlite.prepare(named)
        run.setAllowUnknownNamedParameters(true)
        return { run, params }
      }
      const bound = (values: unknown[]) => ({
        bind: (...next: unknown[]) => bound(next),
        first: async <T>() => {
          const { run, params } = statement(values)
          return (run.get(params as never) ?? null) as T | null
        },
        run: async () => {
          const { run, params } = statement(values)
          return { meta: { changes: Number(run.run(params as never).changes) } }
        },
        all: async <T>() => {
          const { run, params } = statement(values)
          return { results: run.all(params as never) as T[] }
        },
      })
      return bound([])
    },
  }
}

export const createBucket = () => {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>()

  return {
    objects,
    head: async (key: string) => {
      const bytes = objects.get(key)
      return bytes ? { size: bytes.byteLength } : null
    },
    get: async (key: string) => {
      const bytes = objects.get(key)
      if (!bytes) return null
      return {
        size: bytes.byteLength,
        body: new Blob([bytes]).stream(),
        arrayBuffer: async () => bytes.slice().buffer,
      } as unknown as R2Object
    },
    delete: async (key: string) => {
      objects.delete(key)
    },
  }
}

export const createEnv = () => {
  const started: string[] = []
  const env = {
    DB: createDb(),
    CARS: createBucket(),
    DEPLOY_WORKFLOW: {
      create: async ({ id }: { id: string }) => {
        started.push(id)
      },
    },
  } satisfies GatewayEnv
  return { env, started }
}

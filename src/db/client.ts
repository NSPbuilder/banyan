import 'server-only'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { BASE_MODULES } from '@/lib/module-contract'
import { selectedAddons } from '@/assembly/selection'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set — see .env.local')

// Next.js hot-reloads modules in dev; without this the pool is re-created on
// every edit until Postgres runs out of connections.
const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> }

const sql =
  globalForDb.sql ??
  postgres(url, {
    max: 10,
    connection: { options: `-c figtree.modules=${[...BASE_MODULES, ...selectedAddons].join(',')}` },
    // Money is bigint cents. Let postgres.js hand back a JS BigInt so that
    // accidental floating-point arithmetic throws instead of silently rounding.
    types: {
      bigint: postgres.BigInt,
    },
  })

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql

export const db = drizzle(sql, { schema })
export { sql }

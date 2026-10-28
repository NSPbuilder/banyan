import 'server-only'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * Which migrations exist on disk but have not been applied here.
 *
 * `npm run db:migrate` once imported the module that swaps DATABASE_URL for the
 * TEST database, so it migrated the wrong one and printed "Database is up to
 * date" — the books sat five migrations behind, with the constraints those
 * migrations add simply absent. Nothing in the running application would have
 * said so, which is why this is read from the application itself rather than
 * left to a command someone has to remember.
 */
export async function pendingMigrations(): Promise<string[]> {
  const onDisk = readdirSync(join(process.cwd(), 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql')).sort()

  const applied = new Set(
    (await db.execute<{ filename: string }>(sql`SELECT filename FROM _migration`))
      .map((r) => r.filename))

  return onDisk.filter((f) => !applied.has(f))
}

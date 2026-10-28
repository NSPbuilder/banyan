import { guardRoute } from '@/lib/gate'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { localStamp } from '@/lib/today'
import { pgTool } from '@/lib/backup-paths'

/**
 * Take a database-only copy right now and hand it to the browser.
 *
 * This exists so that WHERE a backup goes is decided at the moment it is taken.
 * The browser's own save dialog can reach an external disk, a synced folder,
 * anywhere — which is the answer to the one thing the daily schedule cannot do:
 * it runs unattended, so it can only ever write to a fixed place on this
 * machine, and that is the same disk the database is on. It deliberately is
 * not called a complete backup: attachment originals live outside Postgres
 * and travel only in the manifested set made by scripts/backup.sh.
 *
 * The file is the same `pg_dump -Fc` archive the schedule writes, so
 * docs/RESTORE.md applies to it unchanged. Two formats would mean two restore
 * procedures, and a restore is the worst moment to meet a surprise.
 */
/**
 * POST, NOT GET — and behind an owner (RISKS §15b).
 *
 * This route runs pg_dump and streams the entire database: every company,
 * every entry, every SIN in the payroll module, every birth date in the
 * transparency register. As an unauthenticated GET it was a one-request export
 * of the whole business, and because GET is supposed to be a read, an
 * `<img src="…/backup/download">` on any page the owner visited would have
 * triggered a dump.
 *
 * It is a POST because it HAS A SIDE EFFECT — it spawns a process — which was
 * true before authentication existed and would still be true without it.
 */
export async function POST() {
  const who = await guardRoute({ owner: true })
  if (who instanceof Response) return who

  const url = process.env.DATABASE_URL
  if (!url) return plain('DATABASE_URL is not set, so there is nothing to back up.', 500)

  const database = url.split('/').pop() ?? 'erp'
  const stamp = localStamp()

  const pgDump = spawn(pgTool('pg_dump'), ['-Fc', '-d', url])

  // Collect stderr: if pg_dump fails after the response has begun there is no
  // way to change the status code, so the reason has to reach the log at least.
  let problem = ''
  pgDump.stderr.on('data', (chunk) => { problem += String(chunk) })

  // Wait for the first byte before answering. pg_dump reports a bad connection
  // or a missing database immediately, and it is worth turning that into a
  // readable message rather than a truncated download the person would keep.
  const firstByte = await new Promise<Buffer | null>((resolve) => {
    pgDump.stdout.once('readable', () => resolve(pgDump.stdout.read() ?? null))
    pgDump.once('error', () => resolve(null))
    pgDump.once('close', (code) => { if (code !== 0) resolve(null) })
  })

  if (firstByte === null) {
    return plain(`The backup could not be taken.\n\n${problem || 'pg_dump produced nothing.'}`, 500)
  }

  const body = Readable.toWeb(
    Readable.from((async function* () {
      yield firstByte
      for await (const chunk of pgDump.stdout) yield chunk
      if (problem) console.error('[backup download] pg_dump said:', problem)
    })()),
  ) as ReadableStream

  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${database}-${stamp}.dump"`,
      'Cache-Control': 'no-store',
    },
  })
}

const plain = (message: string, status: number) =>
  new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

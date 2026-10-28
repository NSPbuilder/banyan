
import { PageHeading } from '@/components/DialogHeading'
import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { restoreBackupAction } from '@/app/actions'
import { BackupScreen } from './BackupScreen'

export const dynamic = 'force-dynamic'

/**
 * Backup — this company, in one file, and back again.
 *
 * `pg_dump` backs up the DATABASE and `docs/RESTORE.md` is about putting one
 * back on a machine. This is the other thing: one company, portable, and
 * restorable BESIDE the original rather than over it (owner, 2026-09-07).
 */
export default async function Backup({ params }: { params: Promise<{ ledgerId: string }> }) {
  const user = await requireUser()
  const { ledgerId } = await params

  const [head] = await db.execute<{ code: string; name: string }>(sql`
    SELECT e.code, e.name FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  if (!head) notFound()

  // What the receipts weigh, read from the rows rather than from the store:
  // the screen only has to say what it is about to carry.
  const [paper] = await db.execute<{ n: string; bytes: string }>(sql`
    WITH company AS (SELECT entity_id FROM ledger WHERE id=${ledgerId}::uuid),
    hashes AS (SELECT a.sha256 FROM attachment a JOIN journal_entry je ON je.id=a.entry_id JOIN ledger l ON l.id=je.ledger_id WHERE l.entity_id=(SELECT entity_id FROM company)
      UNION SELECT a.sha256 FROM minute_book_attachment a JOIN minute_book_entry m ON m.id=a.minute_book_entry_id WHERE m.entity_id=(SELECT entity_id FROM company)
      UNION SELECT sha256 FROM crm_attachment WHERE entity_id=(SELECT entity_id FROM company)),
    paper AS (SELECT byte_size FROM attachment_blob WHERE sha256 IN (SELECT sha256 FROM hashes)
      UNION ALL SELECT byte_size FROM project_attachment_blob WHERE entity_id=(SELECT entity_id FROM company))
    SELECT count(*)::text AS n,COALESCE(sum(byte_size),0)::text AS bytes FROM paper`)

  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10 font-sans">
      <PageHeading className="mt-2" title={<>Backup</>} />
      <p className="mt-1 text-sm text-neutral-500">{head.name}</p>
      <BackupScreen ledgerId={ledgerId} code={head.code} name={head.name}
                    paperCount={Number(paper.n)} paperBytes={Number(paper.bytes)}
                    restoreAction={restoreBackupAction}
                    restoreAvailable={user.kind === 'superadmin'} />
    </main>
  )
}

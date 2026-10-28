import { requireUser } from '@/lib/gate'
import { accessFor, homeSeatForEntity, mayOpenEntity } from '@/lib/access'
import { LEDGER_NAV } from '@/lib/nav'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { archiveCompanyAction, deleteCompanyAction, renameCompanyAction, unarchiveCompanyAction } from '@/app/actions'
import { companiesWithState } from '@/lib/companies'
import { CompanyState } from './CompanyState'
import { BUTTON, BUTTON_WIDE } from '@/lib/ui'
import { ApplicationFrame } from '@/components/ApplicationFrame'
import { GlobalNavigation } from '@/components/GlobalNavigation'
import { PageHeader } from '@/components/PageHeader'

// Ledger data must be read on every request. Without this Next prerenders the
// page at build time and the figures freeze at whatever the database held then.
export const dynamic = 'force-dynamic'

type Row = {
  ledger_id: string; entity_id: string; code: string; name: string; province: string | null
  standard: string; ledger: string; entries: string
  archived_at: string | null; archived_reason: string | null
}

export default async function Companies() {
  const me = await requireUser()

  const companies = await db.execute<Row>(sql`
    SELECT l.id::text AS ledger_id, e.id::text AS entity_id, e.code, e.name, e.province,
           e.archived_at::text, e.archived_reason,
           l.accounting_standard AS standard, l.name AS ledger,
           (SELECT count(*) FROM journal_entry je
             WHERE je.ledger_id = l.id AND je.status IN ('posted','reversed'))::text AS entries
      FROM entity e JOIN ledger l ON l.entity_id = e.id AND l.is_primary
     -- Only the companies this person may open. An owner sees them all; for
     -- anybody else the list IS the permission made visible, and showing a
     -- company they would be refused at is an invitation to a locked door.
     -- The gate refuses the ledger regardless — this is the courtesy half.
     -- The same predicate the desk uses: it was written here first and the desk
     -- did not have it (critic, 2026-09-03).
     WHERE ${mayOpenEntity(me, sql`e.id`)}
     -- Archived companies last rather than gone: their books are still
     -- readable, which is the whole point of archiving rather than removing
     -- (0065). They are dimmed, and they carry the door back.
     ORDER BY e.archived_at IS NOT NULL, e.code`)
  // Whether a company can be removed is the library's answer, read from the
  // counts `deleteCompany` refuses on rather than from a second count here.
  const counts = new Map((await companiesWithState()).map((c) => [c.id, c]))
  const access = await accessFor(me)
  const modulePaths = LEDGER_NAV.map((item) => item.path)

  return (
    <ApplicationFrame navigation={<GlobalNavigation owner={me.is_owner} />} context={{ name: 'Workspace' }}>
    <main className="w-full max-w-none px-8 py-6 font-sans">
      <PageHeader title="Companies">
        {companies.length > 0 && me.is_owner && <Link href="/companies/new" className={BUTTON}>Add company</Link>}
      </PageHeader>

      {companies.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-500">{me.is_owner?'No companies yet.':'No companies have been assigned to you. Ask an owner for access.'}</p>
          {me.is_owner&&<Link href="/companies/new"
                className={`mt-4 ${BUTTON_WIDE}`}>
            Add your first company
          </Link>}
        </div>
      ) : (
        <ul className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {companies.map((c) => (
            <li key={c.ledger_id} className={`standalone-company rounded-panel border border-line-subtle bg-surface p-4 ${c.archived_at !== null ? 'opacity-60' : ''}`}
                data-company={c.entity_id}>
              <Link href={`/ledger/${c.ledger_id}${homeSeatForEntity(access, c.entity_id, modulePaths) ?? ''}`}
                    className="group block rounded-lg">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{c.code}</span>
                <span className="mt-1 block text-section-title font-semibold group-hover:underline">{c.name}</span>
                <span className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
                  <span>{c.province ?? '—'} · {c.standard}</span>
                  <span className="tabular-nums">{c.entries} {c.entries === '1' ? 'entry' : 'entries'}</span>
                </span>
              </Link>
              {/* Whether a company exists at all is the same question as who
                  may see it, one step further: owners only (0054, 0065). */}
              {me.is_owner && (
                <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-700">
                  <Link href={`/companies/new?copy=${c.entity_id}`}
                        className="mb-2 inline-block text-xs text-neutral-500 underline">Copy setup</Link>
                  <CompanyState entityId={c.entity_id} code={c.code} name={c.name}
                                books={counts.get(c.entity_id)?.entries ?? '1'}
                                aiRecords={counts.get(c.entity_id)?.ai_records ?? '1'}
                                archivedAt={c.archived_at} archivedReason={c.archived_reason}
                                archiveAction={archiveCompanyAction}
                                unarchiveAction={unarchiveCompanyAction}
                                deleteAction={deleteCompanyAction}
                                province={c.province} renameAction={renameCompanyAction} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-xs text-neutral-500">
        Archived companies keep history and cannot post. Delete requires empty books and no AI history.
      </p>
    </main>
    </ApplicationFrame>
  )
}

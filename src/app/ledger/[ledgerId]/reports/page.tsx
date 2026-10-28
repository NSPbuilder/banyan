
import { PageHeading } from '@/components/DialogHeading'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { availableStatements } from '@/lib/statements'

export const dynamic = 'force-dynamic'

/**
 * The one seat in the sidebar for everything that is READ rather than done:
 * statements, aging. Each report is a full page of its own — they are paper,
 * and paper is not an overlay. This page only says what exists and links it;
 * a report queried here and again on its own page would be the two-lists
 * defect with figures in it.
 */
export default async function Reports({
  params,
}: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()

  const { ledgerId } = await params

  const [head] = await db.execute<{ entity: string; standard: string }>(sql`
    SELECT e.name AS entity, l.accounting_standard AS standard
      FROM ledger l JOIN entity e ON e.id = l.entity_id WHERE l.id = ${ledgerId}::uuid`)
  if (!head) notFound()

  const templates = await availableStatements(head.standard)

  const reports: Array<{ href: string; title: string; what: string }> = [
    ...templates.map((t) => ({
      href: `/ledger/${ledgerId}/statements?template=${t.code}`,
      title: t.name,
      what: 'Financial statement, for any date range or as at its end.',
    })),
    {
      href: `/ledger/${ledgerId}/reports/trial-balance`,
      title: 'Trial balance',
      what: 'Every account with its movement and closing balance for a span.',
    },
    {
      href: `/ledger/${ledgerId}/reports/general-ledger`,
      title: 'General ledger',
      what: "Every account's entries for a span, with opening and running balances.",
    },
    {
      href: `/ledger/${ledgerId}/aging`,
      title: 'Aging — receivables & payables',
      what: 'Who owes what and for how long, by open item, as at any date.',
    },
    {href:`/ledger/${ledgerId}/reports/budgets`,title:'Budgets',what:'Fiscal-period budgets and current P&L actuals.'},
  ]

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeading className="mt-2" title={<>Reports</>} />
      <p className="mt-1 text-sm text-neutral-500">{head.entity}</p>

      <ul className="mt-8 divide-y divide-neutral-200 dark:divide-neutral-800">
        {reports.map((r) => (
          <li key={r.href}>
            <Link href={r.href} className="block py-4 hover:bg-neutral-50 dark:hover:bg-neutral-900">
              <span className="font-medium">{r.title}</span>

            </Link>
          </li>
        ))}
      </ul>

    </main>
  )
}

import { PageHeader } from '@/components/PageHeader'
import { formatNumber } from '@/lib/numbers'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { formatMoney } from '@/lib/money'
import { localToday } from '@/lib/today'
import { currentYearEnd, monthName } from '@/lib/setup'
import { unclosedYears } from '@/lib/posting'
import { pendingMigrations } from '@/lib/schema-version'
import { missingRoles } from '@/lib/needed-roles'
import { missingReceipts } from '@/lib/attachments'
import { backupStatus } from '@/lib/backups'
import { CloseYear } from './CloseYear'
import { BackupBanner } from '@/app/BackupBanner'
import { ActionForm } from '@/components/ActionForm'
import { rebuildBalances, rebuildAttachmentsAction, waiveReceiptAction } from '@/app/actions'
import { FiscalYearForm } from './FiscalYearForm'
import { Floating } from '@/components/Floating'
import { BUTTON, QUIET, REFUSAL } from '@/lib/ui'

export const dynamic = 'force-dynamic'

type Head = {
  entity: string; ledger: string; standard: string; currency: string
  fy_end_month: number; fy_end_day: number
  first_year_start: string | null; last_year_end: string | null
  account_count: string; period_count: string
}
type Drift = { check_name: string; account_code: string; period_name: string; expected: string; found: string }
type Draft = { id: string; entry_date: string; description: string }
type BankTask = {
  id: string; account_id: string; account_code: string; account_name: string
  txn_date: string; description: string; unmatched_amount: string; state: string
}

export default async function LedgerPage({ params }: { params: Promise<{ ledgerId: string }> }) {
  const me=await requireUser()
  const { ledgerId } = await params

  const [head] = await db.execute<Head>(sql`
    SELECT e.name AS entity, l.name AS ledger, l.accounting_standard AS standard, l.currency,
           e.fiscal_year_end_month AS fy_end_month, e.fiscal_year_end_day AS fy_end_day,
           (SELECT max(fy.end_date)::text FROM fiscal_year fy WHERE fy.ledger_id = l.id) AS last_year_end,
           (SELECT min(fy.start_date)::text FROM fiscal_year fy WHERE fy.ledger_id = l.id) AS first_year_start,
           (SELECT count(*) FROM account a WHERE a.entity_id = e.id)::text AS account_count,
           (SELECT count(*) FROM fiscal_period fp WHERE fp.ledger_id = l.id)::text AS period_count
      FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  if (!head) notFound()

  const [drift, unclosed, pending, unreceipted, missing, drafts, bankTasks] = await Promise.all([
    db.execute<Drift>(sql`
      SELECT check_name, account_code, period_name, expected::text, found::text
        FROM check_balance_integrity(${ledgerId}::uuid)`),
    unclosedYears(ledgerId),
    pendingMigrations(),
    missingReceipts(ledgerId),
    missingRoles(ledgerId),
    db.execute<Draft>(sql`
      SELECT id::text, entry_date::text, description
        FROM journal_entry
       WHERE ledger_id = ${ledgerId}::uuid AND status = 'draft'
       ORDER BY entry_date DESC, created_at DESC`),
    db.execute<BankTask>(sql`
      SELECT s.id::text, s.account_id::text, a.code AS account_code, a.name AS account_name,
             s.txn_date::text, s.description, s.unmatched_amount::text, s.state
        FROM bank_row_state s
        JOIN account a ON a.id = s.account_id
        JOIN ledger l ON l.entity_id = a.entity_id
       WHERE l.id = ${ledgerId}::uuid AND s.state IN ('unmatched', 'part')
       ORDER BY s.txn_date DESC, s.id DESC`),
  ])

  const today = localToday()
  const hasPeriods = head.period_count !== '0'
  const needsYear = !hasPeriods || (head.last_year_end !== null && head.last_year_end < today)
  const needsChart = head.account_count === '0'
  const coreMissing = needsChart ? [] : missing.filter((m) => m.stops.some((c) => c.weight === 'core'))
  const dueYears = unclosed.filter((y) => y.end_date < today)
  const backup = backupStatus()
  const setupCount = Number(needsChart) + Number(needsYear) + coreMissing.length
  const systemCount = pending.length + drift.length + Number(backup.state !== 'ok') + Number(Boolean(backup.checkNote))
  const total = unreceipted.length + bankTasks.length + drafts.length + dueYears.length + setupCount + systemCount

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title="Overview" context={`${head.ledger} · ${head.standard}`}>
        {me.is_owner&&<Link href={`/ledger/${ledgerId}/getting-started`} className={QUIET}>Company setup</Link>}
        {hasPeriods && !needsYear && <FiscalYearButton head={head} ledgerId={ledgerId} />}
      </PageHeader>

      <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-section-title font-semibold">To do</h2>
        <span className="text-sm text-neutral-500" role="status">
          {total === 0 ? 'All caught up' : `${formatNumber(total)} item${total === 1 ? '' : 's'} need attention`}
        </span>
      </div>

      <div className="task-register mt-3">
        {[
        <TaskGroup key="system" priority={pending.length + drift.length > 0 ? 0 : systemCount > 0 ? 4 : 100} open={pending.length + drift.length > 0} title="System checks" count={systemCount}>
          {pending.length > 0 && (
            <div className={`mb-4 ${REFUSAL}`}>
              <p className="font-medium">{formatNumber(pending.length)} database migration{pending.length === 1 ? '' : 's'} pending</p>
              <p className="mt-1 text-xs">Run <code className="font-mono">npm run db:migrate</code> before continuing.</p>
              <p className="mt-1 font-mono text-xs">{pending.join(' ')}</p>
            </div>
          )}
          {drift.length > 0 && (
            <div className={`mb-4 ${REFUSAL}`}>
              <p className="font-medium">{formatNumber(drift.length)} balance disagreement{drift.length === 1 ? '' : 's'}</p>
              <div className="mt-3"><RebuildButton ledgerId={ledgerId} label="Rebuild balances" /></div>
              <ul className="mt-3 space-y-1 text-xs">
                {drift.map((d, i) => (
                  <li key={i}>{d.check_name} · {d.account_code} {d.period_name} · expected {d.expected}, found {d.found}</li>
                ))}
              </ul>
            </div>
          )}
          {(backup.state !== 'ok' || backup.checkNote) && <BackupBanner />}
          {systemCount === 0 && <Empty />}
          <div className="mt-4 flex flex-wrap gap-4 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <RebuildButton ledgerId={ledgerId} label="Rebuild balances" subtle />
            <RebuildAttachmentsButton ledgerId={ledgerId} />
          </div>
        </TaskGroup>,

        <TaskGroup key="setup" priority={setupCount > 0 ? 0 : 100} open={setupCount > 0} title="Bookkeeping setup" count={setupCount}>
          {setupCount === 0 ? <Empty /> : (
            <div className="space-y-4 py-2 text-sm">
              {needsChart && <p><Link href={`/ledger/${ledgerId}/accounts`} className="underline">Add a chart of accounts</Link> before posting entries.</p>}
              {coreMissing.map((m) => (
                <p key={m.role}>
                  <Link href={`/ledger/${ledgerId}/accounts`} className="underline">Assign {m.label}</Link>
                  <span className="ml-2 text-neutral-500">{m.stops.filter((c) => c.weight === 'core').map((c) => c.what).join('; ')}</span>
                </p>
              ))}
              {needsYear && (
                <div className="flex flex-wrap items-center gap-3">
                  <span>{hasPeriods ? 'The current fiscal year has ended.' : 'Create the first fiscal year before posting entries.'}</span>
                  <FiscalYearButton head={head} ledgerId={ledgerId} />
                </div>
              )}
            </div>
          )}
        </TaskGroup>,

        <TaskGroup key="bank" priority={bankTasks.length > 0 ? 1 : 100} open={bankTasks.length > 0} title="Bank transactions to review" count={bankTasks.length}>
          {bankTasks.length === 0 ? <Empty /> : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {bankTasks.map((row) => (
                <li key={row.id} className="py-3 text-sm">
                  <Link href={`/ledger/${ledgerId}/bank/${row.account_id}?tab=pending`}
                        className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 hover:underline">
                    <span><span className="mr-3 font-mono text-xs text-neutral-500">{row.txn_date}</span>
                      {row.description}</span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      {row.account_code} {row.account_name} · {row.state === 'part' ? 'partly matched · ' : ''}
                      {formatMoney(BigInt(row.unmatched_amount))} remaining
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </TaskGroup>,

        <TaskGroup key="drafts" priority={drafts.length > 0 ? 2 : 100} open={drafts.length > 0} title="Draft journal entries" count={drafts.length}>
          {drafts.length === 0 ? <Empty /> : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {drafts.map((d) => (
                <li key={d.id} className="py-3 text-sm">
                  <Link href={`/ledger/${ledgerId}/entries/${d.id}`} className="hover:underline">
                    <span className="mr-3 font-mono text-xs text-neutral-500">{d.entry_date}</span>{d.description}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </TaskGroup>,

        <TaskGroup key="years" priority={dueYears.length > 0 ? 2 : 100} open={dueYears.length > 0} title="Fiscal years to close" count={dueYears.length}>
          {dueYears.length === 0 ? <Empty /> : <CloseYear ledgerId={ledgerId} unclosed={dueYears} />}
        </TaskGroup>,

        <TaskGroup key="paper" priority={unreceipted.length > 0 ? 3 : 100} open={false} title="Supporting documents to upload" count={unreceipted.length}>
          {unreceipted.length === 0 ? <Empty /> : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {unreceipted.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <Link href={`/ledger/${ledgerId}/entries/${m.id}`} className="min-w-0 hover:underline">
                    <span className="mr-3 font-mono text-xs text-neutral-500">{m.entry_date} · {m.entry_no}</span>
                    {m.description}
                  </Link>
                  <ActionForm action={waiveReceiptAction} submit="No document needed" working="…"
                              buttonClassName="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800 dark:hover:text-neutral-200">
                    <input type="hidden" name="ledgerId" value={ledgerId} />
                    <input type="hidden" name="entryId" value={m.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </TaskGroup>
        ].sort((a, b) => a.props.priority - b.props.priority)}
      </div>
    </main>
  )
}

function TaskGroup({ title, count, children, open }: { title: string; count: number; priority: number; open: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="task-group group" data-has-tasks={count > 0 || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-clay-600 [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <span className="task-count ml-auto min-w-8 text-center font-semibold tabular-nums">{formatNumber(count)}</span>
        <span aria-hidden="true" className="text-lg leading-none text-neutral-500 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="task-body px-4 pb-3 pt-1">{children}</div>
    </details>
  )
}

function Empty() {
  return <p className="py-2 text-sm text-neutral-500">Nothing waiting.</p>
}

function FiscalYearButton({ head, ledgerId }: { head: Head; ledgerId: string }) {
  const hasPeriods = head.period_count !== '0'
  return (
    <Floating label={hasPeriods ? 'Add fiscal year' : 'Create fiscal year'}
              title={hasPeriods ? 'Add the next fiscal year' : 'The first fiscal year'}
              buttonClassName={hasPeriods ? QUIET : BUTTON}>
      <p className="mt-1 text-sm text-neutral-500">
        {hasPeriods
          ? `Covers ${head.first_year_start} to ${head.last_year_end}. The next year must follow without a gap.`
          : 'Nothing can be posted until this company has periods to post into.'}
      </p>
      <FiscalYearForm ledgerId={ledgerId}
        defaultEnd={nextYearEnd(head.last_year_end, head.fy_end_month, head.fy_end_day)} />
      <p className="mt-3 text-xs text-neutral-500">Year end: {monthName(head.fy_end_month)} {head.fy_end_day}.</p>
    </Floating>
  )
}

function RebuildAttachmentsButton({ ledgerId }: { ledgerId: string }) {
  return (
    <ActionForm action={rebuildAttachmentsAction} submit="Rebuild attachment folders" working="Rebuilding…"
                buttonClassName="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800 dark:hover:text-neutral-200">
      <input type="hidden" name="ledgerId" value={ledgerId} />
    </ActionForm>
  )
}

function RebuildButton({ ledgerId, label, subtle }: { ledgerId: string; label: string; subtle?: boolean }) {
  const rebuild = async () => {
    'use server'
    await rebuildBalances(ledgerId)
  }
  return (
    <form action={rebuild}>
      <button type="submit" className={subtle
        ? 'text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800 dark:hover:text-neutral-200'
        : 'rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800'}>
        {label}
      </button>
    </form>
  )
}

function nextYearEnd(lastEnd: string | null, month: number, day: number): string {
  if (lastEnd) {
    const d = new Date(lastEnd + 'T00:00:00Z')
    return new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()))
      .toISOString().slice(0, 10)
  }
  return currentYearEnd(month, day)
}

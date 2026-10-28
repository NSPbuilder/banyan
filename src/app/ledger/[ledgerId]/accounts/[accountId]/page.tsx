
import { PageHeader } from '@/components/PageHeader'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { accountLedger, accountSummary } from '@/lib/reports'
import { formatMoney } from '@/lib/money'
import { localToday } from '@/lib/today'
import { PrintButton } from '@/app/PrintButton'
import { RangePicker } from '@/components/RangePicker'
import { availableRoles, chartOfAccounts } from '@/lib/accounts'
import { EditAccount } from './EditAccount'
import { deleteAccountAction, setAccountActiveAction } from '@/app/actions'
import { ours } from '@/lib/ours'
import { DataTable, TableViewport } from '@/components/Table'

export const dynamic = 'force-dynamic'

export default async function AccountHistory({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string; accountId: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  await requireUser()

  const { ledgerId, accountId } = await params
  const { from = '', to = '' } = await searchParams

  // Another company's account id under this ledger's URL is not a page here.
  if (!(await ours('account', accountId, ledgerId))) notFound()
  const account = await accountSummary(accountId)
  if (!account) notFound()
  // The same list the chart's own form offers, from the same place.
  const roleOptions = (await availableRoles()).map((r) => ({
    code: r.code, label: r.label, family: r.family, category: r.category, isCore: r.isCore,
  }))
  // And the same chart, so the "sits under" list on this page offers exactly
  // what the chart screen's own form offers (0078).
  const chart = await chartOfAccounts(account.entity_id)

  // Journal lines carry exact dates, so the range filters directly — no
  // snapping to fiscal months here, unlike the screens that read the
  // period-kept balance cache.
  const lines = await accountLedger(accountId, ledgerId, {
    from: from || undefined, to: to || undefined,
  })

  const ranged = Boolean(from || to)
  const debitNormal = account.normal_balance === 'debit'
  const balance = BigInt(account.balance)

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/accounts`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Chart of accounts</ToolAction></Link>

      <PageHeader title={<><span className="font-mono text-ink-muted">{account.code}</span>{' '}{account.name}</>}>
        <Link href={`/ledger/${ledgerId}/accounts/new?copy=${accountId}`}
              className={TOOL_BUTTON}>Copy</Link>
      </PageHeader>
      <p className="mt-1 text-sm text-neutral-500">
        {account.account_type} · normally {account.normal_balance}
        {account.parent_code && (
          <> · under{' '}
            <Link href={`/ledger/${ledgerId}/accounts/${account.parent_id}`}
                  className="hover:underline">
              <span className="font-mono">{account.parent_code}</span> {account.parent_name}
            </Link>
          </>
        )}
        {!account.is_active && ' · inactive'}
        {account.roles.length > 0 && <> · {account.roles.join(' · ')}</>}
        {account.roles.length === 0 && (
          <span className="text-amber-700 dark:text-amber-400"> · no role, so it appears on no statement</span>
        )}
      </p>

      <div className="mt-4">
        <EditAccount
        version={chart.find(a=>a.id===accountId)?.version??''}
          ledgerId={ledgerId} entityId={account.entity_id} roles={roleOptions} accounts={chart}
          account={{
            id: accountId, code: account.code, name: account.name,
            accountType: account.account_type, normalBalance: account.normal_balance,
            isPostable: account.is_postable, roles: account.roles,
            parentCode: account.parent_code,
            // What the form freezes the TYPE on: an account with posted lines
            // may be renamed and retagged, never re-meant.
            lineCount: Number(account.line_count),
            isActive: account.is_active, inUse: account.in_use,
          }}
          setActive={setAccountActiveAction} remove={deleteAccountAction} />
      </div>

      <div className="mt-6 flex gap-8 border-y border-neutral-200 py-3 text-sm dark:border-neutral-800">
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-500">Total debits</div>
          <div className="tabular-nums">{formatMoney(BigInt(account.total_debit))}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-500">Total credits</div>
          <div className="tabular-nums">{formatMoney(BigInt(account.total_credit))}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-500">Balance</div>
          <div className="tabular-nums font-medium">
            {formatMoney(debitNormal ? balance : -balance, { sign: 'accounting' })}
            <span className="ml-1 text-xs font-normal text-neutral-500">
              {balance === 0n ? '' : (balance > 0n ? 'Dr' : 'Cr')}
            </span>
          </div>
        </div>

      </div>

      <div className="mt-6">
        <RangePicker from={from} to={to} today={localToday()} clearable />
      </div>

      <div className="mt-6 flex justify-end gap-4 text-sm print:hidden">
        <a href={`/ledger/${ledgerId}/export?what=account&account=${accountId}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}&format=xlsx`}
           className={TOOL_BUTTON} title="Download Excel"><ToolAction kind="xlsx">Download Excel</ToolAction></a>
        <PrintButton />
      </div>

      {lines.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          Nothing posted to this account{ranged ? ' in this range' : ''} yet.
        </p>
      ) : (
        <TableViewport label="Account history" className="mt-6">
        <DataTable className="ui-table-spaced min-w-5xl">
          <thead className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <tr>
              <th scope="col" className="py-2 font-medium">Date</th>
              <th scope="col" className="font-medium">Entry</th>
              <th scope="col" className="font-medium">Description</th>
              <th scope="col" className="font-medium">Party</th>
              <th scope="col" className="font-medium">Against</th>
              <th scope="col" className="text-right font-medium">Debit</th>
              <th scope="col" className="text-right font-medium">Credit</th>
              <th scope="col" className="text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={`${l.entry_id}-${i}`} className="border-b border-neutral-100 dark:border-neutral-900">
                <td data-date className="py-2 text-label">{l.entry_date}</td>
                <td className="whitespace-nowrap py-2">
                  <Link href={`/ledger/${ledgerId}/entries/${l.entry_id}`}
                        className="font-mono text-xs hover:underline">
                    {l.entry_no}
                  </Link>
                  {l.status === 'reversed' && (
                    <span className="ml-1 text-xs text-neutral-500">rev</span>
                  )}
                </td>
                <td className="py-2">
                  {l.line_description || l.description}
                  {l.line_description && l.line_description !== l.description && (
                    <span className="ml-2 text-xs text-neutral-500">{l.description}</span>
                  )}
                </td>
                <td className="min-w-40 max-w-56 py-2 pr-4 break-words">
                  {l.party_id && l.party_name ? <Link href={`/ledger/${ledgerId}/parties/${l.party_id}`} className="hover:underline">{l.party_name}</Link>
                    : <span className="text-ink-muted">—</span>}
                </td>
                <td className="whitespace-nowrap py-2 font-mono text-xs text-neutral-500">
                  {l.contra_codes.length === 0 ? '—'
                    : l.contra_codes.length <= 2 ? l.contra_codes.join(' ')
                    : `${l.contra_codes[0]} +${l.contra_codes.length - 1}`}
                </td>
                <td data-numeric className="py-2 text-right tabular-nums">
                  {l.debit === '0' ? '' : formatMoney(BigInt(l.debit))}
                </td>
                <td data-numeric className="py-2 text-right tabular-nums">
                  {l.credit === '0' ? '' : formatMoney(BigInt(l.credit))}
                </td>
                <td data-numeric className="py-2 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                  {formatMoney(debitNormal ? BigInt(l.running) : -BigInt(l.running), { sign: 'accounting' })}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
        </TableViewport>
      )}

      <p className="mt-4 text-xs text-neutral-500">Posted entries · Running balance includes earlier history</p>
    </main>
  )
}

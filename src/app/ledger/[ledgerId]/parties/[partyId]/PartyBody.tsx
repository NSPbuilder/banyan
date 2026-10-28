import { TOOL_BUTTON } from '@/lib/ui'

import { PageHeader } from '@/components/PageHeader'

import { DataTable } from '@/components/Table'
import { requireUser } from '@/lib/gate'
import { refuseForLedger } from '@/lib/access'
import { invoiceHref } from '@/lib/invoice-routes'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  correctRoleAction, deactivatePartyAction, deleteAddressAction, deletePartyAction, deleteRoleAction, endRoleAction, grantRoleAction,
  reactivatePartyAction, setAddressAction, updatePartyAction,setPartyEmailAction,
} from '@/app/actions'
import { partyDetail, roleDefinitions } from '@/lib/parties'
import { openItemsFor, owedAmount, owedSummary } from '@/lib/payments'
import { formatMoney } from '@/lib/money'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { localToday } from '@/lib/today'
import { PartyManage } from './PartyManage'
import { ours } from '@/lib/ours'
import {PartyReminder} from '@/components/PartyReminder'
import {reminderColumns,type ReminderRule} from '@/lib/mail'
import {incomeEmailPath} from '@/lib/workflow-links'

/**
 * One party, body only — the full page and the overlay both render exactly
 * this (the one-renderer rule applied to screens).
 */
export async function PartyBody({
  ledgerId, partyId,
}: { ledgerId: string; partyId: string }) {
  const [ledgerHead] = await db.execute<{ entity_id: string }>(sql`
    SELECT entity_id::text FROM ledger WHERE id = ${ledgerId}::uuid`)
  if (!ledgerHead) notFound()
  const [detail, roleDefs, allOpen] = await Promise.all([
    partyDetail(partyId, ledgerHead.entity_id), roleDefinitions(), openItemsFor(ledgerId),
  ])
  // A party is one record shared by every company it deals with; it is a page
  // HERE only when this company has given it a role.
  if (!detail || !(await ours('party', partyId, ledgerId))) notFound()
  const { party, roles } = detail

  // What THIS party still owes us on DOCUMENTS, and what we still owe them —
  // openItemsFor, the invoice-level derivation the payments panel reads. The
  // aging report reads the ledger's control-account movements instead, which
  // also carry party-tagged entries with no document behind them; those show
  // in aging and on the statement, not in this table, and the caption says so.
  const today = localToday()
  const open = allOpen.filter((i) => i.party_id === partyId)
  const owedToUs = open.filter((i) => i.direction === 'sales')
    .reduce((t, i) => t + owedAmount(i), 0n)
  const owedByUs = open.filter((i) => i.direction === 'purchase')
    .reduce((t, i) => t + owedAmount(i), 0n)

  // A statement is OUR document to a customer; the link only makes sense
  // where a customer role exists (ended or not — the debt may outlive it).
  const isCustomer = roles.some((r) => r.role === 'customer')

  const me=await requireUser(),mailAllowed=isCustomer&&!(await refuseForLedger(me,ledgerId,'/automation'))&&!(await refuseForLedger(me,ledgerId,'/invoices'))
  const [reminder]=mailAllowed?await db.execute<ReminderRule>(sql`SELECT ${reminderColumns} FROM reminder_rule WHERE ledger_id=${ledgerId}::uuid AND party_id=${partyId}::uuid`):[]
  const primaryEmail=detail.contacts.find(c=>c.is_primary)?.email??null
  return (
    <>
      <PageHeader title={party.name} context={!party.is_active ? 'No longer on the list' : undefined}>
        <Link href={`/ledger/${ledgerId}/parties/new?copy=${partyId}`}
              className={TOOL_BUTTON}>Copy</Link>
      </PageHeader>
      <p className="mt-1 text-sm text-neutral-500">
        {party.kind === 'person' ? 'A person' : 'An organisation'}
        {party.trading_name && <> · trading as {party.trading_name}</>}
        {party.tax_number && <> · <span className="font-mono text-xs">{party.tax_number}</span></>}
        {isCustomer && (
          <>
            {' · '}
            <Link href={`/ledger/${ledgerId}/parties/${partyId}/statement`}
                  className="underline hover:text-neutral-800 dark:hover:text-neutral-200">
              statement
            </Link>
          </>
        )}
      </p>

      <section className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Open items — what is still unpaid
        </h2>
        {open.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Nothing outstanding either way. Every posted document involving them is settled.
          </p>
        ) : (
          <>
            <DataTable density="reading" className="mt-2 w-full text-sm">
              <tbody>
                {open.map((i) => (
                  <tr key={i.invoice_id} className="border-b border-neutral-200 last:border-0 dark:border-neutral-800">
                    <td className="py-2 font-mono text-xs">
                      <Link href={invoiceHref(ledgerId, i.direction === 'purchase' ? 'purchase' : 'sales', i.invoice_id)} className="hover:underline">
                        {i.number ?? 'unnumbered'}
                      </Link>
                    </td>
                    <td className="py-2 text-xs text-neutral-500">
                      {i.direction === 'sales'
                        ? (i.document_kind === 'credit_note' ? 'credit note to them' : 'they owe us')
                        : (i.document_kind === 'credit_note' ? 'credit note from them' : 'we owe them')}
                    </td>
                    <td className="py-2 font-mono text-xs text-neutral-500">
                      due {i.due_on}
                      {i.due_on < today && i.document_kind === 'invoice' && (
                        <span className="ml-1 text-red-700 dark:text-red-400">overdue</span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">{formatMoney(owedAmount(i))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-sm font-medium">
                {([['sales', owedToUs], ['purchase', owedByUs]] as const).filter(([, t]) => t !== 0n).map(([side, t]) => {
                  const said = owedSummary(side, t)
                  return (
                    <tr key={side}><td colSpan={3} className="py-2">{said.label}</td>
                        <td className="py-2 text-right font-mono tabular-nums">{formatMoney(said.amount)}</td></tr>
                  )
                })}
              </tfoot>
            </DataTable>

          </>
        )}
      </section>

      <PartyManage
        primaryEmail={primaryEmail}
        version={party.version}
        ledgerId={ledgerId}
        entityId={ledgerHead.entity_id}
        party={party}
        roles={roles}
        roleOptions={roleDefs.map((r) => ({ code: r.code, label: r.label }))}
        addresses={detail.addresses}
        today={today}
        actions={{
          saveEmail:setPartyEmailAction,
          update: updatePartyAction,
          setAddress: setAddressAction,
          endRole: endRoleAction,
          correctRole: correctRoleAction, deleteRole: deleteRoleAction, deleteAddress: deleteAddressAction,
          grantRole: grantRoleAction,
          deactivate: deactivatePartyAction,
          reactivate: reactivatePartyAction,
          delete: deletePartyAction,
        }}
      />
      {mailAllowed&&<><PartyReminder ledgerId={ledgerId} partyId={partyId} email={primaryEmail} rule={reminder}/><p className="mt-4 text-sm"><Link className="underline" href={incomeEmailPath(ledgerId,'new')+'?party='+partyId}>Preview customer statement email</Link></p></>}
    </>
  )
}

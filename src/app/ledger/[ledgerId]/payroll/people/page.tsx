
import { PageHeading } from '@/components/DialogHeading'

import { DataTable } from '@/components/Table'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { listEmployees } from '@/lib/payroll/employees'
import { FREQUENCY_LABEL } from '@/lib/payroll/labels'
import { formatMoney } from '@/lib/money'
import { ledgerHead } from '@/lib/ledger-head'
import { BUTTON } from '@/lib/ui'

export const dynamic = 'force-dynamic'

/**
 * Who is on the payroll — a list. Adding somebody and editing somebody float
 * the one employee form over it (`people/new`, `people/[id]/edit`; owner,
 * 2026-09-16), where it used to sit open at the bottom of the page.
 */
export default async function PayrollPeople({
  params,
}: {
  params: Promise<{ ledgerId: string }>
}) {
  await requireUser()

  const { ledgerId } = await params

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const staff = await listEmployees(ledgerId)

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/payroll`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Pay runs</ToolAction></Link>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
        <PageHeading title={<>Employees</>} />
        <Link href={`/ledger/${ledgerId}/payroll/people/new`} className={BUTTON}>Add employee</Link>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-neutral-500">
        {head.entity}
      </p>

      {staff.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">Nobody on the payroll yet.</p>
      ) : (
        <DataTable density="reading" className="mt-8 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Paid</th>
              <th className="py-2 pr-4 text-right font-medium">Federal claim</th>
              <th className="py-2 pr-4 text-right font-medium">BC claim</th>
              <th className="py-2 pr-4 text-right font-medium">Extra tax</th>
              <th className="py-2 pr-4 font-medium">SIN</th>
              <th className="py-2 pr-4 font-medium">Since</th>
              <th className="py-2 pr-4 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((e) => (
              <tr key={e.id}
                  className={`border-b border-neutral-200 dark:border-neutral-800 ${e.is_active ? '' : 'text-neutral-400'}`}>
                <td className="py-2 pr-4">
                  <Link href={`/ledger/${ledgerId}/payroll/people/${e.id}`}
                        className="underline decoration-neutral-300 underline-offset-2">
                    {e.party_name}
                  </Link>
                  {!e.is_active && <span className="ml-2 text-xs uppercase">off payroll</span>}
                </td>
                <td className="py-2 pr-4">{FREQUENCY_LABEL[e.frequency]}</td>
                {/* Blank is claim code 1 — the basic amount, which the engine
                    works out for the edition rather than storing a copy of.
                    "basic" and "$0.00" are different answers and read as such. */}
                <td className="py-2 pr-4 text-right tabular-nums">
                  {e.federal_claim ? formatMoney(BigInt(e.federal_claim))
                                   : <span className="text-neutral-400">basic</span>}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {e.bc_claim ? formatMoney(BigInt(e.bc_claim))
                              : <span className="text-neutral-400">basic</span>}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {formatMoney(BigInt(e.additional_tax))}
                </td>
                {/* Shown in full: this is the one screen whose job is to let
                    somebody check the number against the card before it goes
                    on a T4. */}
                <td className="py-2 pr-4 tabular-nums">{e.sin ?? '—'}</td>
                <td className="py-2 pr-4">{e.hired_on ?? '—'}</td>
                <td className="py-2 pr-4 text-right">
                  <Link href={`/ledger/${ledgerId}/payroll/people/${e.id}/edit`}
                        className="text-xs underline">edit</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </main>
  )
}

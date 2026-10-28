'use client'

import { DataTable } from '@/components/Table'

import { useState } from 'react'
import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { DateInput } from '@/components/DateInput'
import { SRED_FIELDS as F } from '@/lib/sred-fields'
import { BUTTON, CARD, FIELD, LABEL, QUIET } from '@/lib/ui'

export type RateRow = {
  id: string; jurisdiction: string; name: string; value: string
  effective_from: string; effective_to: string | null
  authority: string; confidence: string; note: string | null
}

/**
 * A rate's boxes — the add form's and a row's when its Edit is pressed. One
 * definition, so a rate cannot be added with a field it cannot be corrected by.
 */
export function RateFields({ ledgerId, r, initial }: { ledgerId: string; r?: RateRow; initial?: RateRow }) {
  const source = r ?? initial
  return (
    <>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      {r && <input type="hidden" name={F.rateId} value={r.id} />}
      <label className="text-xs text-neutral-500">
        <span className={LABEL}>Where</span>
        <select name={F.jurisdiction} defaultValue={source?.jurisdiction ?? 'federal'}
                className={`mt-1 ${FIELD} py-1 text-xs`}>
          <option value="federal">federal</option>
          <option value="BC">BC</option>
        </select>
      </label>
      <label className="text-xs text-neutral-500">
        <span className={LABEL}>Name</span>
        <input name={F.rateName} required defaultValue={source?.name ?? ''}
               className={`mt-1 w-56 ${FIELD} py-1 font-mono text-xs`} />
      </label>
      <label className="text-xs text-neutral-500">
        <span className={LABEL}>Value</span>
        <input name={F.value} required defaultValue={source?.value ?? ''} inputMode="decimal"
               className={`mt-1 w-28 ${FIELD} py-1 text-xs`} />
      </label>
      <label className="text-xs text-neutral-500">
        <span className={LABEL}>From</span>
        <DateInput name={F.effectiveFrom} required defaultValue={r?.effective_from ?? ''}
                   className={`mt-1 ${FIELD} py-1 text-xs`} />
      </label>
      <label className="text-xs text-neutral-500">
        <span className={LABEL}>Until</span>
        <DateInput name={F.effectiveTo} defaultValue={r?.effective_to ?? ''}
                   className={`mt-1 ${FIELD} py-1 text-xs`} />
      </label>
      <label className="text-xs text-neutral-500">
        <span className={LABEL}>Authority</span>
        <input name={F.authority} required defaultValue={source?.authority ?? ''} className={`mt-1 w-56 ${FIELD} py-1 text-xs`} />
      </label>
      <label className="text-xs text-neutral-500">
        <span className={LABEL}>Sure?</span>
        <select name={F.confidence} defaultValue={source?.confidence ?? 'unconfirmed'}
                className={`mt-1 ${FIELD} py-1 text-xs`}>
          <option value="confirmed">confirmed</option>
          <option value="unconfirmed">unconfirmed</option>
        </select>
      </label>
      <label className="text-xs text-neutral-500">
        <span className={LABEL}>Note</span>
        <input name={F.note} defaultValue={source?.note ?? ''}
               className={`mt-1 w-72 ${FIELD} py-1 text-xs`} />
      </label>
    </>
  )
}

/**
 * The rate table, with a door.
 *
 * 0068 seeded these by migration and left no way to touch them, so adding next
 * year's percentage meant writing SQL (owner, 2026-09-12). EXPORTED so a
 * harness can read the forms back: which row's id each carries is what "correct
 * this rate" means, and it lives in markup.
 *
 * The distinction the screen has to teach, because it is the whole reason the
 * table is dated: a rate that CHANGED is a new row, and editing a row in place
 * rewrites what every past working paper computed.
 *
 * A table of text since 2026-09-16 — eleven rates of eight boxes each was the
 * page the owner called 凌乱. A row's Edit opens its boxes; Add a rate floats
 * (`sred/new-rate`). `initialEditing` opens a row for the harness.
 */
export function Rates({ ledgerId, rates, actions, initialEditing = null }: {
  ledgerId: string
  rates: RateRow[]
  actions: { saveRate: FormAction; deleteRate: FormAction }
  initialEditing?: string | null
}) {
  const [editing, setEditing] = useState<string | null>(initialEditing)
  const TD = 'py-1.5 pr-3 text-xs'
  return (
    <section className={`mt-10 ${CARD}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg font-semibold">Rates</h2>
        <Link href={`/ledger/${ledgerId}/sred/new-rate`} className={BUTTON}>Add a rate</Link>
      </div>

      <DataTable density="reading" className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-3 font-medium">Where</th>
            <th className="py-2 pr-3 font-medium">Name</th>
            <th className="py-2 pr-3 text-right font-medium">Value</th>
            <th className="py-2 pr-3 font-medium">From</th>
            <th className="py-2 pr-3 font-medium">Until</th>
            <th className="py-2 pr-3 font-medium">Authority</th>
            <th className="py-2 pr-3 font-medium">Sure?</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {rates.map((r) => editing === r.id ? (
            <tr key={r.id} data-rate={r.id} className="border-b border-neutral-100 bg-neutral-50 dark:border-neutral-900 dark:bg-neutral-950">
              <td colSpan={8} className="py-3">
                <p className="mb-2 text-xs text-neutral-500">
                  Edits change past papers; deleting can make them unavailable. Filed-year rates are locked.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <ActionForm action={actions.saveRate} submit="Save" working="…"
                              onSucceeded={() => setEditing(null)}
                              className="flex flex-wrap items-end gap-2" buttonClassName={QUIET}>
                    <RateFields ledgerId={ledgerId} r={r} />
                  </ActionForm>
                  <ActionForm action={actions.deleteRate} submit="Delete" working="…"
                              className="inline" buttonClassName={QUIET}>
                    <input type="hidden" name={F.ledgerId} value={ledgerId} />
                    <input type="hidden" name={F.rateId} value={r.id} />
                  </ActionForm>
                  <button type="button" onClick={() => setEditing(null)}
                          className="text-xs text-neutral-500 hover:underline">Cancel</button>
                </div>
              </td>
            </tr>
          ) : (
            <tr key={r.id} data-rate={r.id} className="border-b border-neutral-100 dark:border-neutral-900">
              <td className={TD}>{r.jurisdiction}</td>
              <td className={`${TD} font-mono`}>{r.name}</td>
              <td className={`${TD} text-right font-mono tabular-nums`}>{r.value}</td>
              <td className={`${TD} font-mono`}>{r.effective_from}</td>
              <td className={`${TD} font-mono`}>{r.effective_to ?? '—'}</td>
              <td className={TD} title={r.note ?? undefined}>{r.authority}</td>
              <td className={`${TD} ${r.confidence === 'unconfirmed' ? 'text-amber-700 dark:text-amber-400' : ''}`}>{r.confidence}</td>
              <td className="py-1.5 text-right">
                <Link href={`/ledger/${ledgerId}/sred/new-rate?copy=${r.id}`}
                      className="mr-3 text-xs text-neutral-500 hover:underline">Copy</Link>
                <button type="button" onClick={() => setEditing(r.id)} aria-label={`Edit ${r.name}`}
                        className="text-xs text-neutral-500 hover:underline">Edit</button>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </section>
  )
}

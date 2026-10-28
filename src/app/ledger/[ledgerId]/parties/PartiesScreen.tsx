'use client'

import { DataTable } from '@/components/Table'

import { formatNumber } from '@/lib/numbers'
import { useState } from 'react'
import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { PARTY_FIELDS as F } from '@/lib/forms'
import { Floating } from '@/components/Floating'
import { BUTTON, FIELD } from '@/lib/ui'

export type PartyRow = {
  id: string
  kind: string
  name: string
  trading_name: string | null
  tax_number: string | null
  is_active: boolean
  roles: string
}

export type RoleDef = { code: string; label: string; transacts: boolean }

/**
 * The list for one company, and the two ways something gets onto it.
 *
 * The second way is the one that carries the design: an organisation that
 * already deals with another company is offered for a role HERE, rather than
 * being typed in again. Typing it in again is what produces two addresses and
 * two answers to what is owed, and it is what `03` was written to prevent — so
 * the screen has to make the cheap path the right one.
 */
export function PartiesScreen({
  ledgerId, entityId, entityName, parties, roles, elsewhere, actions,
}: {
  ledgerId: string
  entityId: string
  entityName: string
  parties: PartyRow[]
  roles: RoleDef[]
  elsewhere: Array<{ id: string; name: string; kind: string; held: string; version: string }>
  actions: { grant: FormAction }
  /**
   * The local calendar day, decided on the server by `localToday()`.
   *
   * Not computed here. This component cannot import `today.ts` — it is
   * `server-only` — and the obvious substitute reads the UTC day, which west of
   * Greenwich is tomorrow for the last seven hours of every day. `R47` scans
   * for it and caught this screen doing exactly that.
   *
   * The pattern is deliberately not written out above: R47 reads source as
   * text and cannot tell a comment from code, so spelling the defect here to
   * explain it would trip the check that finds it.
   */
  today: string
}) {

  // Search and filters, on data the server already derived (owner,
  // 2026-09-03): narrowing never re-queries.
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const q = query.trim().toLowerCase()
  const shown = parties.filter((p) =>
    (showInactive || p.is_active)
    && (!q || p.name.toLowerCase().includes(q) || (p.trading_name ?? '').toLowerCase().includes(q))
    && (!roleFilter || p.roles.toLowerCase().includes(roleFilter.toLowerCase())))

  return (
    <>
      <section className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          On {entityName}&apos;s list
        </h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-neutral-500">
            <span className="block">Find</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} className={`mt-1 w-64 ${FIELD}`} />
          </label>
          <label className="text-xs text-neutral-500">
            <span className="block">Role</span>
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
                    className={`mt-1 ${FIELD}`}>
              <option value="">Any role</option>
              {roles.map((r) => <option key={r.code} value={r.label}>{r.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-neutral-500">
            <input type="checkbox" checked={showInactive}
                   onChange={(e) => setShowInactive(e.target.checked)} />
            show inactive
          </label>
          <span className="ml-auto pb-2 text-xs text-neutral-500">
            {formatNumber(shown.length)} of {formatNumber(parties.length)}
          </span>
        </div>
        {parties.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Nobody yet. Add a customer or a supplier below.
          </p>
        ) : shown.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">Nothing matches.</p>
        ) : (
          <DataTable density="reading" className="mt-2 w-full text-sm">
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className="border-b border-neutral-200 last:border-0 dark:border-neutral-800">
                  <td className="py-2">
                    <Link href={`/ledger/${ledgerId}/parties/${p.id}`}
                          className={`hover:underline ${p.is_active ? '' : 'text-neutral-400 line-through'}`}>
                      {p.name}
                    </Link>
                    {p.trading_name && (
                      <span className="ml-2 text-xs text-neutral-500">trading as {p.trading_name}</span>
                    )}
                    {!p.is_active && (
                      <span className="ml-2 text-xs text-neutral-500">no longer on the list</span>
                    )}
                    {p.tax_number && (
                      <span className="block font-mono text-xs text-neutral-500">{p.tax_number}</span>
                    )}
                  </td>
                  <td className="py-2 text-right text-xs text-neutral-500">{p.roles}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </section>

      {elsewhere.length > 0 && (
        <section className="mt-8 rounded border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Already known to another company
          </h2>

          <ul className="mt-3 space-y-2">
            {elsewhere.map((p) => (
              <li key={p.id} className="flex flex-wrap items-end gap-2 text-sm">
                <span className="min-w-40">{p.name}</span>
                <span className="text-xs text-neutral-500">at {p.held}</span>
                {/* A button per row, and the role and date in a floating form
                    — not two boxes on every row (owner, 2026-09-16). */}
                <span className="ml-auto">
                  <Floating label="Add here" title={`Add ${p.name} here`} buttonClassName={BUTTON}
                            ariaLabel={`Add ${p.name} to this company`}>
                    <p className="mt-1 text-sm text-neutral-500">Known to {p.held}. One record, a role here too.</p>
                    <ActionForm action={actions.grant} submit="Add here" working="…"
                                className="mt-4 flex items-end gap-2" buttonClassName={BUTTON}>
                      <input type="hidden" name={F.ledgerId} value={ledgerId} />
                      <input type="hidden" name={F.entityId} value={entityId} />
                      <input type="hidden" name={F.partyId} value={p.id} />
                      <input type="hidden" name="expectedVersion" value={p.version} />
                      <label className="text-xs text-neutral-500">
                        <span className="block">As</span>
                        <select name={F.role} defaultValue="customer" className={`mt-1 ${FIELD}`}>
                          {roles.map((r) => (
                            <option key={r.code} value={r.code}>{r.label}</option>
                          ))}
                        </select>
                      </label>
                    </ActionForm>
                  </Floating>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

    </>
  )
}

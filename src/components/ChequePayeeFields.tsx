'use client'

import { useState } from 'react'
import type { FormAction } from '@/components/ActionForm'
import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import { FIELD } from '@/lib/ui'

export type ChequePartyChoice = { id: string; name: string; address: string; roles: string }

export function ChequePayeeFields({ parties, ledgerId, initialDate, newParty, initialPartyId = '', initialPayee = '', initialAddress = '' }: {
  parties: ChequePartyChoice[]
  ledgerId: string
  initialDate: string
  newParty: FormAction
  initialPartyId?: string
  initialPayee?: string
  initialAddress?: string
}) {
  const [partyId, setPartyId] = useState(initialPartyId)
  const [date, setDate] = useState(initialDate)
  const [payee, setPayee] = useState(initialPayee)
  const [address, setAddress] = useState(initialAddress)
  const label = 'flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-neutral-500'
  return <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
    <label className={label}>Party
      <Picker name="partyId" value={partyId} ariaLabel="Party"
        options={parties.map((p) => ({ id: p.id, label: p.name, hint: p.roles }))}
        create={{
          presentation: 'party',
          title: 'New payee', action: newParty, hidden: { ledgerId },
          fields: [
            { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
            { name: 'kind', label: 'Kind', width: '9rem', options: [
              { value: 'organisation', label: 'Organisation' }, { value: 'person', label: 'Person' },
            ] },
            { name: 'role', label: 'As a', width: '9rem', options: [
              { value: 'supplier', label: 'Supplier' }, { value: 'employee', label: 'Employee' },
              { value: 'customer', label: 'Customer' }, { value: 'director', label: 'Director' },
            ] },
          ],

        }}
        onChange={(id) => {
          setPartyId(id)
          const party = parties.find((p) => p.id === id)
          if (party) { setPayee(party.name); setAddress(party.address) }
        }} onCreated={(made) => { setPayee(made.label); setAddress('') }} />
    </label>
    <label className={label}>Payee name on cheque
      <input name="payee" required maxLength={200} value={payee} onChange={(e) => setPayee(e.target.value)} className={FIELD} />
    </label>
    <label className={label}>Cheque date
      <DateInput name="chequeDate" required value={date} onChange={(e) => setDate(e.target.value)} className={FIELD} />
    </label>

    <label className={`${label} sm:col-span-2`}>Payee address (on cheque)
      <textarea name="payeeAddress" maxLength={300} rows={3} value={address}
        onChange={(e) => setAddress(e.target.value)} className={FIELD} />
    </label>
  </div>
}

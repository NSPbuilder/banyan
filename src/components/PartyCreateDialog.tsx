'use client'

import type { RefObject } from 'react'
import type { PickerCreate } from './Picker'
import { FloatingPanel } from './Floating'
import { PartyCreateForm } from './PartyCreateForm'

export default function PartyCreateDialog({ create, typed, dialogRef, onDone }: {
  create: PickerCreate
  typed: string
  dialogRef: RefObject<HTMLDialogElement | null>
  onDone: (made: { id: string; label: string } | null) => void
}) {
  const roles = create.hidden.role
    ? [{ code: create.hidden.role, label: create.hidden.role[0].toUpperCase() + create.hidden.role.slice(1) }]
    : (create.fields.find(field => field.name === 'role')?.options ?? [
      { value: 'customer', label: 'Customer' }, { value: 'supplier', label: 'Supplier' },
    ]).map(role => ({ code: role.value, label: role.label }))
  return <FloatingPanel title={create.title} dialogRef={dialogRef} onClose={() => onDone(null)}>
    {requestClose => <PartyCreateForm ledgerId={create.hidden.ledgerId} entityId={create.hidden.entityId}
      action={create.action} roles={roles}
      initial={{ name: typed.trim(), kind: create.hidden.kind ?? create.fields.find(field => field.name === 'kind')?.options?.[0]?.value,
        role: create.hidden.role, taxNumber: '' }}
      fixedKind={create.hidden.kind === 'person' ? 'person' : undefined}
      onCreated={onDone} onCancel={requestClose}/>}
  </FloatingPanel>
}

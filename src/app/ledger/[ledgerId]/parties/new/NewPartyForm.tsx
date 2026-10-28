'use client'

import { type FormAction } from '@/components/ActionForm'
import { PartyCreateForm, type PartyCreateInitial } from '@/components/PartyCreateForm'

type RoleDef = { code: string; label: string; transacts: boolean }

export function NewPartyForm({
  ledgerId, entityId, roles, action, initial,
}: {
  ledgerId: string
  entityId: string
  roles: RoleDef[]
  today?: string
  action: FormAction
  initial?: PartyCreateInitial
}) {
  return <PartyCreateForm ledgerId={ledgerId} entityId={entityId} roles={roles} action={action}
    initial={initial ? { ...initial, name: `${initial.name} (copy)` } : undefined}/>
}

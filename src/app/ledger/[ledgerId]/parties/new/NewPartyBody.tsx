
import { PageHeading } from '@/components/DialogHeading'
import { notFound } from 'next/navigation'
import { createPartyAction } from '@/app/actions'
import { roleDefinitions } from '@/lib/parties'
import { NewPartyForm } from './NewPartyForm'
import { ledgerHead } from '@/lib/ledger-head'
import { ours } from '@/lib/ours'
import { partyDetail } from '@/lib/parties'

/**
 * Someone new, body only — the full page and the overlay both render exactly
 * this (the one-renderer rule applied to screens).
 */
export async function NewPartyBody({ ledgerId, copyId }: { ledgerId: string; copyId?: string }) {
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const roles = await roleDefinitions()
  if (copyId && !(await ours('party', copyId, ledgerId))) notFound()
  const copied = copyId ? await partyDetail(copyId, head.entity_id) : null
  const copiedRole = copied?.roles.find((role) => !role.held_to) ?? copied?.roles[0]
  const copiedContact = copied?.contacts.find(contact => contact.is_primary)
  const copiedAddress = copied?.addresses.find(address => address.purpose === 'mailing')

  return (
    <>
      <PageHeading className="mt-2" title={<>{copied ? 'Copy party' : 'Someone new'}</>} />

      <NewPartyForm key={copyId ?? 'new'}
        ledgerId={ledgerId}
        entityId={head.entity_id}
        roles={roles}
        action={createPartyAction}
        initial={copied ? {
          name: copied.party.name,
          kind: copied.party.kind,
          role: copiedRole?.role ?? 'customer',
          taxNumber: '',
          tradingName: copied.party.trading_name ?? undefined,
          notes: copied.party.notes ?? undefined,
          contactName: copiedContact?.name ?? undefined,
          email: copiedContact?.email ?? undefined,
          phone: copiedContact?.phone ?? undefined,
          line1: copiedAddress?.line1,
          line2: copiedAddress?.line2 ?? undefined,
          city: copiedAddress?.city ?? undefined,
          region: copiedAddress?.region ?? undefined,
          postalCode: copiedAddress?.postal_code ?? undefined,
          country: copiedAddress?.country,
        } : undefined}
      />
    </>
  )
}

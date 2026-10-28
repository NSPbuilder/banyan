import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs } from './acting'
import { auditRow } from './audit-row'
import { attemptWith, g, PARTY_FIELDS as F, type FormResult } from './forms'
import { NOT_OURS } from './ours'
import { PartyError, setAddress, type AddressRecord } from './parties'

export type ShareholderAddress = Pick<AddressRecord,
  'id' | 'party_id' | 'purpose' | 'line1' | 'line2' | 'city' | 'region' | 'postal_code' | 'country'>

/** The same preferred address that partyAddressLine prints on the CSR. */
export async function shareholderAddresses(entityId: string) {
  return db.execute<ShareholderAddress>(sql`
    SELECT DISTINCT ON (a.party_id) a.id::text, a.party_id::text, a.purpose,
           a.line1, a.line2, a.city, a.region, a.postal_code, a.country
      FROM party_address a JOIN party_address_purpose p ON p.code = a.purpose
     WHERE EXISTS (SELECT 1 FROM share_transaction t
                    JOIN share_class c ON c.id = t.share_class_id
                   WHERE t.party_id = a.party_id AND c.entity_id = ${entityId}::uuid)
     ORDER BY a.party_id, p.sort_order, a.purpose`)
}

/** Records may maintain a registered holder's address, without a Parties seat. */
export async function setShareholderAddressFromForm(f: FormData, actor: string): Promise<FormResult> {
  const ledgerId = g(f, F.ledgerId), partyId = g(f, F.partyId)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuid.test(ledgerId) || !uuid.test(partyId)) return { error: NOT_OURS }

  return attemptWith(() => actingAs(actor, async tx => {
    // Share history, rather than an active role: former holders remain on the CSR.
    const [holder] = await tx.execute<{ name: string }>(sql`
      SELECT p.name FROM party p JOIN share_transaction t ON t.party_id = p.id
      JOIN share_class c ON c.id = t.share_class_id JOIN ledger l ON l.entity_id = c.entity_id
      WHERE l.id = ${ledgerId}::uuid AND p.id = ${partyId}::uuid LIMIT 1`)
    if (!holder) throw new PartyError('NOT_OURS', NOT_OURS)

    const [current] = await tx.execute<{ purpose: string }>(sql`
      SELECT a.purpose FROM party_address a JOIN party_address_purpose p ON p.code = a.purpose
      WHERE a.party_id = ${partyId}::uuid ORDER BY p.sort_order, a.purpose LIMIT 1`)
    const purpose = current?.purpose ?? 'mailing'
    if (g(f, F.purpose) !== purpose) {
      throw new PartyError('ADDRESS_CHANGED', 'The address on file has changed. Refresh and open Edit address again.')
    }
    const address = await setAddress({
      partyId, purpose, line1: g(f, F.line1), line2: g(f, F.line2), city: g(f, F.city),
      region: g(f, F.region), postalCode: g(f, F.postalCode), country: g(f, F.country),
    }, tx)
    await auditRow(tx, {
      actor, action: 'set_shareholder_address', table: 'party_address', recordId: address.id,
      scope: 'shared', reason: 'Last known address maintained from the central securities register.',
      targetLabel: holder.name, after: { partyId, purpose }, context: { sourceLedgerId: ledgerId },
    })
  }), 'Address saved.', PartyError)
}

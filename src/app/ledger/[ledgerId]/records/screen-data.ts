import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { localToday } from '@/lib/today'
import {
  allDirectorships, allOffices, allSignificantIndividuals, minuteBookOf, movementRows,
  profileOf, securitiesRegister, shareClassRows, shareTotalsAsAt,
} from '@/lib/records'
import { minuteBookPaperOf } from '@/modules/records/attachments'
import { minuteKinds } from '@/lib/record-forms'
import { shareholderAddresses } from '@/lib/shareholder-address'

/**
 * What a corporate-record row's boxes suggest — every name on any company's
 * list, this company's names, its share classes as the screens print them, and
 * the minute book's kinds. One assembly, eaten by the add form of rows and by
 * the Edit on each register row (0083), so the two cannot offer different
 * lists.
 */
export async function recordChoices(entityId: string) {
  const [parties, localParties, classes, kinds] = await Promise.all([
    db.execute<{ name: string }>(sql`SELECT name FROM party WHERE is_active ORDER BY name`),
    db.execute<{ name: string }>(sql`
      SELECT DISTINCT p.name FROM party p JOIN party_role r ON r.party_id = p.id
       WHERE p.is_active AND r.entity_id = ${entityId}::uuid ORDER BY p.name`),
    db.execute<{ label: string }>(sql`
      SELECT CASE WHEN series IS NULL THEN name ELSE name || ' — ' || series END AS label
        FROM share_class WHERE entity_id = ${entityId}::uuid ORDER BY name, series NULLS FIRST`),
    minuteKinds(),
  ])
  return {
    names: parties.map((p) => p.name),
    localNames: localParties.map((p) => p.name),
    classes: classes.map((c) => c.label),
    minuteKinds: kinds,
  }
}

/**
 * Everything the RecordsScreen needs, assembled ONCE — the Basic Info page
 * and each register page render the same component with a different `show`,
 * so they must eat the same data. A second assembly would be the two-lists
 * defect wearing corporate clothes.
 */
export async function recordsScreenData(ledgerId: string) {
  const [head] = await db.execute<{
    entity: string; entity_id: string; is_ccpc: boolean | null
  }>(sql`
    SELECT e.name AS entity, e.id::text AS entity_id, e.is_ccpc
      FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  if (!head) return null

  const today = localToday()
  const E = head.entity_id

  const [profile, offices, directorships, holdings, totals, sis, minuteBook,
         companyTypes, paper, movements, classes, choices, addresses] = await Promise.all([
    profileOf(E),
    allOffices(E),
    allDirectorships(E),
    securitiesRegister(E, today),
    shareTotalsAsAt(E, today),
    allSignificantIndividuals(E),
    minuteBookOf(E),
    db.execute<{ code: string; name: string }>(sql`
      SELECT code, name FROM company_type ORDER BY code`),
    minuteBookPaperOf(E),
    movementRows(E),
    shareClassRows(E),
    recordChoices(E),
    shareholderAddresses(E),
  ])
  const addressesByParty = new Map(addresses.map(a => [a.party_id, a]))

  return {
    entity: head.entity,
    entityId: E,
    today,
    profile,
    isCcpc: head.is_ccpc,
    companyTypes: companyTypes.map((t) => ({ id: t.code, label: t.name })),
    offices,
    directorships,
    holdings: holdings.map((h) => ({
      // The ids travel with the row because the row now offers a document:
      // a certificate is for THIS holder of THIS class, and a screen that
      // only knows their names cannot ask for one.
      share_class_id: h.share_class_id, party_id: h.party_id,
      class_name: h.class_name, series: h.series, holder: h.holder,
      holding: String(h.holding),
      address: h.address,
      addressDetails: addressesByParty.get(h.party_id),
    })),
    totals: totals.map((t) => ({
      class_name: t.class_name, series: t.series, issued: String(t.issued),
    })),
    // Every entry ever, ceased ones too, so each can be put right — and only
    // these fields: the birth date and address never leave the
    // server for this screen (an edit's blank box keeps them as they are).
    sis: sis.map((s) => ({
      id: s.id, name: s.name, how_control: s.how_control, became_on: s.became_on, ceased_on: s.ceased_on,
      citizen_or_pr: s.citizen_or_pr, citizenships: s.citizenships, tax_resident_ca: s.tax_resident_ca,
    })),
    movements: [...movements],
    classes: [...classes],
    choices,
    minuteBook,
    /** Each minute-book record's documents, by record id (0081). */
    minutePaper: paper.reduce<Record<string, Array<{ id: string; filename: string }>>>((by, p) => {
      (by[p.minute_book_entry_id] ??= []).push({ id: p.id, filename: p.uploaded })
      return by
    }, {}),
  }
}

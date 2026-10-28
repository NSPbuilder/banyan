import 'server-only'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {accessFor,mayOpenEntity,refuseForLedger,seatsForEntity} from './access'
import {LEDGER_NAV} from './nav'
import type {UserRecord} from './users'

/** Personal settings keep the company whose Settings link was used. */
export async function settingsContext(user:UserRecord,requested:unknown){
  const ledgerId=typeof requested==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested)?requested:null
  const [ledger]=await db.execute<{id:string;entity_id:string;entity:string;entity_code:string;currency:string;archived_at:string|null}>(sql`
    SELECT l.id::text,e.id::text AS entity_id,e.name AS entity,e.code AS entity_code,l.currency,e.archived_at::text
    FROM ledger l JOIN entity e ON e.id=l.entity_id WHERE ${mayOpenEntity(user,sql`e.id`)}
    ORDER BY (l.id=${ledgerId}::uuid) DESC,l.is_primary DESC,e.code LIMIT 1`)
  const access=await accessFor(user)
  const seats=ledger?seatsForEntity(access,ledger.entity_id,LEDGER_NAV.map(i=>i.path)):[]
  const canConfigureAi=!!ledger&&!(await refuseForLedger(user,ledger.id,['/assistant','/expenses','/invoices']))
  return {user,ledger:ledger??null,access,seats,canConfigureAi}
}
export type SettingsContext=Awaited<ReturnType<typeof settingsContext>>
export const personalSettingsPath=(ledgerId:string|null,section='appearance')=>`/settings?section=${section}${ledgerId?'&ledger='+ledgerId:''}`

import 'server-only'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {requireUser} from './gate'
import {refuseForLedger} from './access'
export async function invoiceMailContacts(ledgerId:string){
  const me=await requireUser()
  if(await refuseForLedger(me,ledgerId,'/automation')||await refuseForLedger(me,ledgerId,'/invoices'))return null
  const rows=await db.execute<{id:string;email:string|null}>(sql`SELECT DISTINCT p.id::text,c.email FROM party p JOIN party_role r ON r.party_id=p.id JOIN ledger l ON l.entity_id=r.entity_id LEFT JOIN party_contact c ON c.party_id=p.id AND c.is_primary WHERE l.id=${ledgerId}::uuid AND r.role='customer'`)
  return Object.fromEntries(rows.map(r=>[r.id,r.email])) as Record<string,string|null>
}

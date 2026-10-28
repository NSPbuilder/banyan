import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireAutomationLedger } from '@/lib/automation-gate'
import { BusinessWorkspace as AutomationShell } from '@/components/BusinessWorkspace'
import { inboxColumns,type InboxItem } from '@/lib/inbox'
import { proposalOf } from '@/lib/bill-reading'
import { companyClock } from '@/lib/automation-access'
import { InboxReview } from '../../InboxReview'
export const dynamic='force-dynamic'
export default async function InboxDetail({params}:{params:Promise<{ledgerId:string;itemId:string}>}) {
  const {ledgerId,itemId}=await params;await requireAutomationLedger(ledgerId,['/invoices','/entries'])
  const [item]=await db.execute<InboxItem>(sql`SELECT ${inboxColumns} FROM inbox_item WHERE id=${itemId}::uuid AND ledger_id=${ledgerId}::uuid`);if(!item)notFound()
  const [head]=await db.execute<{currency:string;timezone:string}>(sql`SELECT l.currency,coalesce(s.timezone,'America/Vancouver') AS timezone FROM ledger l LEFT JOIN automation_setting s ON s.entity_id=l.entity_id WHERE l.id=${ledgerId}::uuid`)
  const accounts=await db.execute<{id:string;label:string;code:string;type:string}>(sql`SELECT a.id::text,a.code||' — '||a.name AS label,a.code,a.account_type AS type FROM account a JOIN ledger l ON l.entity_id=a.entity_id WHERE l.id=${ledgerId}::uuid AND a.is_active AND a.is_postable ORDER BY a.code`)
  const parties=await db.execute<{id:string;label:string}>(sql`SELECT DISTINCT p.id::text,p.name AS label FROM party p JOIN party_role r ON r.party_id=p.id JOIN ledger l ON l.entity_id=r.entity_id WHERE l.id=${ledgerId}::uuid AND p.is_active AND r.role IN ('supplier','customer') ORDER BY label`)
  const targets=await db.execute<{id:string;label:string;type:'invoice'|'entry'}>(sql`SELECT id::text,coalesce(number,their_ref,'Unnumbered')||' · '||issued_on::text AS label,'invoice' AS type FROM invoice WHERE ledger_id=${ledgerId}::uuid AND status<>'void' UNION ALL SELECT id::text,coalesce(entry_no,'Draft')||' · '||description AS label,'entry' AS type FROM journal_entry WHERE ledger_id=${ledgerId}::uuid ORDER BY label LIMIT 1000`)
  const [reading]=item.reading_id?await db.execute<{proposal:unknown}>(sql`SELECT proposal FROM ai_bill_reading WHERE id=${item.reading_id}::uuid AND ledger_id=${ledgerId}::uuid`):[]
  return <AutomationShell context="AI" ledgerId={ledgerId} title="Review receipt"><InboxReview ledgerId={ledgerId} item={item} proposal={reading?proposalOf(reading.proposal):null} accounts={accounts} parties={parties} targets={targets} currency={head.currency} today={companyClock(head.timezone).date}/></AutomationShell>
}

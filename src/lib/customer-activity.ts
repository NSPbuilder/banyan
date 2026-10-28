import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { openControlEntries } from './aging'
import { renderCustomerStatement } from './customer-docs'
import { addDays,validBusinessDate } from './automation-drafts'
import { AutomationError } from './automation-access'
import { reportPdf } from './pdf'
import { formatMoney } from './money'

export async function customerActivity(ledgerId:string,partyId:string,from:string,to:string) {
  validBusinessDate(from);validBusinessDate(to)
  if(from>to)throw new AutomationError('DATES','The statement end must be on or after its start.')
  const [openingItems,closing,rows]=await Promise.all([
    openControlEntries(ledgerId,'trade_receivables',addDays(from,-1),partyId),
    renderCustomerStatement(ledgerId,partyId,to),
    db.execute<{id:string;date:string;number:string|null;description:string;amount:string}>(sql`
      SELECT je.id::text,je.entry_date::text AS date,coalesce(i.number,je.entry_no) AS number,je.description,sum(jl.amount)::text AS amount
      FROM journal_entry je JOIN journal_line jl ON jl.entry_id=je.id
      JOIN account_role ar ON ar.account_id=jl.account_id AND ar.role='trade_receivables'
      LEFT JOIN invoice i ON i.entry_id=je.id
      WHERE je.ledger_id=${ledgerId}::uuid AND jl.party_id=${partyId}::uuid AND je.status IN ('posted','reversed')
        AND je.entry_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY je.id,i.number ORDER BY je.entry_date,je.entry_no,je.id`),
  ])
  const opening=openingItems.reduce((sum,r)=>sum+BigInt(r.open_amount),0n)
  // Applications redistribute open items; their net is zero. The statement
  // balance continues to come from the existing as-at AR derivation.
  if(opening+rows.reduce((sum,r)=>sum+BigInt(r.amount),0n)!==closing.totalOwed)
    throw new AutomationError('STATEMENT_CHANGED','AR changed while this statement was generated, or its figures do not reconcile. Regenerate before sending.')
  return {from,to,opening,closing:closing.totalOwed,company:closing.company,party:closing.party,rows}
}
export async function customerActivityPdf(ledgerId:string,partyId:string,from:string,to:string) {
  const st=await customerActivity(ledgerId,partyId,from,to)
  return {filename:'customer-activity-'+from+'-'+to+'.pdf',buffer:await reportPdf({company:st.company.name,title:'Statement of account — period activity',subtitle:[from+' through '+to]},[
    {kind:'note',text:[st.party.name,...st.party.addressLines].join('\n')},
    {kind:'table',columns:[{label:'Date',weight:1.4},{label:'Reference',weight:1.3},{label:'Activity',weight:3},{label:'AR movement',align:'right',weight:1.6}],rows:[
      {cells:[from,'','Opening balance',formatMoney(st.opening)],bold:true},
      ...st.rows.map(r=>({cells:[r.date,r.number??'—',r.description,formatMoney(BigInt(r.amount))]})),
      {cells:[to,'','Closing balance',formatMoney(st.closing)],bold:true,rule:true},
    ]},
    {kind:'note',text:'Signed receivable movements include invoices, credit notes, receipts and unapplied amounts. Positive amounts increase what is owed; negative amounts reduce it.'},
  ])}
}

import 'server-only'
import { sql } from 'drizzle-orm'
import type { Tx } from './acting'
import { createInvoice } from './invoices'
import { postEntryCore } from './posting'
import { ImportError } from './import-csv'
import type { ImportItem } from './import-types'

/** Only the migration owner calls this command inside its checkpoint transaction.
 * Original document dates survive; accounting starts at the conversion date.
 * The carried outstanding balance is paired with conversion clearing, never income or tax.
 */
export async function createOpeningDocument(tx:Tx,input:{runId:string;ledgerId:string;asOf:string;clearingAccountId:string;controlAccountId:string;partyId:string;item:ImportItem;actor:string}) {
  const [owner]=await tx.execute(sql`SELECT 1 FROM migration_run WHERE id=${input.runId}::uuid AND ledger_id=${input.ledgerId}::uuid AND status='running' AND current_setting('erp.migration_run',true)=id::text`)
  if(!owner)throw new ImportError('IMPORT_OWNER','Opening documents require the active controlled migration transaction.')
  const item=input.item,n=BigInt(item.amount),normal=item.direction==='sales'?1n:-1n
  const movement=normal*n*(item.kind==='invoice'?1n:-1n)
  const description=`Opening outstanding balance — ${item.number||item.sourceId}`
  if(item.kind==='unapplied') {
    const posted=await postEntryCore(tx,{ledgerId:input.ledgerId,entryDate:input.asOf,description,documentRef:item.number||item.sourceId,sourceType:'payment',actor:input.actor,lines:[
      {accountId:input.controlAccountId,amount:movement,partyId:input.partyId,description},
      {accountId:input.clearingAccountId,amount:-movement,description:'Conversion clearing'},
    ]})
    return {entryId:posted.entry.id,invoiceId:null,movement}
  }
  const invoice=await createInvoice({ledgerId:input.ledgerId,direction:item.direction,kind:item.kind,partyId:input.partyId,controlAccountId:input.controlAccountId,
    issuedOn:item.issuedOn,dueOn:item.dueOn,number:item.number,theirRef:item.sourceId,template:'system',
    note:'Carried outstanding balance at conversion; this is not a new sale or purchase or a reconstruction of the original invoice total.',
    lines:[{accountId:input.clearingAccountId,amount:-movement,description}],actor:input.actor},tx)
  const posted=await postEntryCore(tx,{ledgerId:input.ledgerId,entryDate:input.asOf,description,sourceType:item.direction==='sales'?'ar_invoice':'ap_bill',sourceId:invoice.id,actor:input.actor,lines:[
    {accountId:input.controlAccountId,amount:movement,partyId:input.partyId,description},
    {accountId:input.clearingAccountId,amount:-movement,description:'Conversion clearing'},
  ]})
  await tx.execute(sql`UPDATE invoice SET status='posted',entry_id=${posted.entry.id}::uuid,posted_at=now(),posted_by=${input.actor} WHERE id=${invoice.id}::uuid`)
  return {entryId:posted.entry.id,invoiceId:invoice.id,movement}
}

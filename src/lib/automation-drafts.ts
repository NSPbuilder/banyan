import 'server-only'
import { sql } from 'drizzle-orm'
import type { Tx } from './acting'
import { createInvoice,invoiceDetail,type InvoiceLineInput } from './invoices'
import { invoiceEditorState } from './invoice-editor'
import { saveDraft } from './posting'
import { linesFrom,resolveTaggedLines,type ParsedLine } from './invoice-forms'
import { moneyInput,parseMoney } from './money'
import type { TaxCode } from './tax-rates'
import { AutomationError,type AutomationScope } from './automation-access'

type InvoiceSnapshot={type:'sales'|'purchase';currency:string;partyId:string;controlAccountId:string;note:string;
  inclusive:boolean;lines:Array<{accountId:string;description:string;typed:string;taxCode:TaxCode;gst?:string;pst?:string}>}
type EntrySnapshot={type:'entry';currency:string;description:string;memo:string;
  lines:Array<{accountId:string;amount:string;description?:string;partyId?:string;dimensions?:Record<string,string>}>}
export type DraftSnapshot=InvoiceSnapshot|EntrySnapshot
import { validBusinessDate,addDays } from './recurrence-calendar'
export { validBusinessDate,addDays } from './recurrence-calendar'
const cents=(v:string)=>{
  if(!/^-?\d{1,19}$/.test(v))throw new AutomationError('AMOUNT','Stored amounts must be integer cents.')
  const n=BigInt(v);if(n>9223372036854775807n||n< -9223372036854775807n)throw new AutomationError('AMOUNT','That amount exceeds the ledger range.');return n
}
export async function validateDraftSnapshot(tx:Tx,s:AutomationScope,snapshot:DraftSnapshot,date:string) {
  validBusinessDate(date)
  const currencies=Intl.supportedValuesOf('currency')
  if(snapshot.currency!==s.currency || !currencies.includes(s.currency)
    ||new Intl.NumberFormat('en',{style:'currency',currency:s.currency}).resolvedOptions().maximumFractionDigits!==2)
    throw new AutomationError('CURRENCY','This draft needs the ledger currency with supported two-decimal amounts; no automatic foreign-currency conversion is performed.')
  if(!['sales','purchase','entry'].includes(snapshot.type)||!Array.isArray(snapshot.lines)||!snapshot.lines.length||snapshot.lines.length>200)
    throw new AutomationError('LINES','Choose a document with between 1 and 200 complete lines.')
  const ids=new Set(snapshot.lines.map(l=>l.accountId));if(snapshot.type!=='entry')ids.add(snapshot.controlAccountId)
  for(const id of ids) {
    const found=await tx.execute(sql`SELECT 1 FROM account WHERE id=${id}::uuid AND entity_id=${s.entity_id}::uuid AND is_postable AND is_active FOR SHARE`)
    if(!found.length)throw new AutomationError('ACCOUNT','A referenced account is missing, inactive or belongs to another company. Repair the template; no fallback account is used.')
  }
  if(snapshot.type==='entry') {
    if(snapshot.lines.some(l=>cents(l.amount)===0n)||snapshot.lines.reduce((sum,l)=>sum+cents(l.amount),0n)!==0n)
      throw new AutomationError('UNBALANCED','The recurring journal must have nonzero lines with equal debits and credits.')
    for(const line of snapshot.lines)if(line.partyId) {
      const p=await tx.execute(sql`SELECT 1 FROM party p JOIN party_role r ON r.party_id=p.id
        WHERE p.id=${line.partyId}::uuid AND p.is_active AND r.entity_id=${s.entity_id}::uuid LIMIT 1`)
      if(!p.length)throw new AutomationError('PARTY','A journal party is inactive or unavailable in this company.')
    }
  } else {
    const p=await tx.execute(sql`SELECT 1 FROM party p JOIN party_role r ON r.party_id=p.id
      WHERE p.id=${snapshot.partyId}::uuid AND p.is_active AND r.entity_id=${s.entity_id}::uuid
        AND r.role=${snapshot.type==='sales'?'customer':'supplier'}
        AND (r.held_to IS NULL OR r.held_to>=${date}::date) LIMIT 1`)
    if(!p.length)throw new AutomationError('PARTY','Select an active customer or supplier valid on the scheduled date.')
  }
}
export async function captureDraftSnapshot(tx:Tx,s:AutomationScope,type:DraftSnapshot['type'],id:string):Promise<DraftSnapshot> {
  if(type==='entry') {
    const [head]=await tx.execute<{entry_date:string;description:string;memo:string|null}>(sql`SELECT entry_date::text,description,memo FROM journal_entry
      WHERE id=${id}::uuid AND ledger_id=${s.ledgerId}::uuid AND source_type='manual' AND status IN ('draft','posted') FOR SHARE`)
    if(!head)throw new AutomationError('SOURCE','Choose an available manual journal in this company.')
    if((await tx.execute(sql`SELECT 1 FROM journal_line WHERE entry_id=${id}::uuid AND original_currency IS NOT NULL LIMIT 1`)).length)throw new AutomationError('CURRENCY','Foreign sources require a newly reviewed FX draft; recurring copy does not guess a rate.')
    const lines=await tx.execute<{accountId:string;amount:string;description:string|null;partyId:string|null;dimensions:Record<string,string>}>(sql`
      SELECT account_id::text AS "accountId",amount::text,description,party_id::text AS "partyId",dimensions
      FROM journal_line WHERE entry_id=${id}::uuid ORDER BY line_no`)
    return {type,currency:s.currency,description:head.description,memo:head.memo??'',lines:lines.map(l=>({...l,description:l.description??undefined,partyId:l.partyId??undefined}))}
  }
  const head=await tx.execute(sql`SELECT id FROM invoice WHERE id=${id}::uuid AND ledger_id=${s.ledgerId}::uuid AND direction=${type}
    AND document_kind='invoice' AND status IN ('draft','posted') AND NOT EXISTS(SELECT 1 FROM project_accounting_link WHERE invoice_id=${id}::uuid) FOR SHARE`)
  if(!head.length)throw new AutomationError('SOURCE','Choose an ordinary invoice or bill in this company; Project retains its own document owner.')
  const detail=await invoiceDetail(id);if(!detail)throw new AutomationError('SOURCE','The source document no longer exists.')
  if(detail.invoice.fx_currency)throw new AutomationError('CURRENCY','Foreign invoices require a newly reviewed FX draft; recurring copy does not guess a rate.')
  const state=invoiceEditorState(detail)
  return {type,currency:s.currency,partyId:detail.invoice.party_id,controlAccountId:detail.invoice.control_account_id,note:detail.invoice.note??'',inclusive:!!state.inclusive,
    lines:state.rows.map(l=>({accountId:l.account,description:l.description,typed:parseMoney(l.amount).toString(),taxCode:l.taxCode as TaxCode,
      gst:l.gst?parseMoney(l.gst).toString():undefined,pst:l.pst?parseMoney(l.pst).toString():undefined}))}
}
async function invoiceLines(s:AutomationScope,snapshot:InvoiceSnapshot,date:string):Promise<InvoiceLineInput[]> {
  const parsed:ParsedLine[]=snapshot.lines.map((l,i)=>({index:i,position:i+1,typed:cents(l.typed),taxCode:l.taxCode,
    overrides:{gst:l.gst===undefined?undefined:cents(l.gst),pst:l.pst===undefined?undefined:cents(l.pst)},
    line:{accountId:l.accountId,description:l.description,amount:0n,taxCode:l.taxCode}}))
  const resolved=await resolveTaggedLines(s.ledgerId,snapshot.type,'invoice',parsed,snapshot.inclusive,date)
  if(resolved.error)throw new AutomationError('TAX',resolved.error)
  return resolved.lines
}
export async function createSnapshotDraft(tx:Tx,s:AutomationScope,snapshot:DraftSnapshot,date:string,dueDays=30) {
  await validateDraftSnapshot(tx,s,snapshot,date)
  if(snapshot.type==='entry') {
    const entry=await saveDraft({ledgerId:s.ledgerId,entryDate:date,description:snapshot.description,memo:snapshot.memo,actor:s.email,
      lines:snapshot.lines.map(l=>({...l,amount:cents(l.amount)}))},undefined,tx)
    return {entryId:entry.id,invoiceId:null}
  }
  const invoice=await createInvoice({ledgerId:s.ledgerId,direction:snapshot.type,partyId:snapshot.partyId,controlAccountId:snapshot.controlAccountId,
    issuedOn:date,dueOn:addDays(date,dueDays),note:snapshot.note,lines:await invoiceLines(s,snapshot,date),actor:s.email},tx)
  return {entryId:null,invoiceId:invoice.id}
}
export async function reviewedSnapshot(tx:Tx,s:AutomationScope,f:FormData):Promise<{snapshot:DraftSnapshot;date:string;dueDays:number;total:string;reference:string}> {
  const get=(key:string)=>String(f.get(key)??'').trim(),date=validBusinessDate(get('issuedOn'))
  const direction=get('targetType')==='sales'?'sales':'purchase'
  const parsed=linesFrom(f,direction,'invoice',()=> 'selected account')
  if(parsed.error)throw new AutomationError('LINES',parsed.error)
  const currency=get('currency'),partyId=get('partyId'),inclusive=get('amounts')==='inclusive'
  const total=parseMoney(get('total'));if(total<=0n)throw new AutomationError('TOTAL','Enter and verify the positive total shown on the original document.')
  const base:InvoiceSnapshot={type:direction,currency,partyId,controlAccountId:get('controlAccountId'),note:get('note'),inclusive,
    lines:parsed.lines.map(l=>({accountId:l.line.accountId,description:l.line.description??'',typed:l.typed.toString(),taxCode:l.taxCode,
      gst:l.overrides?.gst?.toString(),pst:l.overrides?.pst?.toString()}))}
  const resolved=await invoiceLines(s,base,date),movement=resolved.reduce((sum,l)=>sum+l.amount,0n)
  if((movement<0n?-movement:movement)!==total)throw new AutomationError('TOTAL_MISMATCH','Reviewed lines and taxes do not equal the original total. Correct them before creating a draft.')
  if(get('paid')==='yes'&&get('targetType')!=='expense')throw new AutomationError('PAID_REVIEW','An already-paid receipt needs a reviewed expense draft or a link to existing accounting; it must not create another unpaid bill.')
  if(!['yes','no'].includes(get('paid')))throw new AutomationError('PAID_REVIEW','Confirm whether the original receipt has already been paid.')
  if(get('targetType')==='expense'&&get('paid')!=='yes')throw new AutomationError('PAID_REVIEW','An expense draft requires confirmation of the paid receipt and its actual payment account.')
  const reference=get('theirRef')
  if(get('targetType')==='expense') {
    const supplier=await tx.execute(sql`SELECT 1 FROM party p JOIN party_role r ON r.party_id=p.id WHERE p.id=${partyId}::uuid AND p.is_active AND r.entity_id=${s.entity_id}::uuid AND r.role='supplier' AND (r.held_to IS NULL OR r.held_to>=${date}::date)`);if(!supplier.length)throw new AutomationError('PARTY','Choose an active supplier for the reviewed receipt.')
    if(!get('paymentAccountId'))throw new AutomationError('PAYMENT_ACCOUNT','Choose the actual payment account; no account is selected automatically.')
    const payment=await tx.execute(sql`SELECT 1 FROM account WHERE id=${get('paymentAccountId')}::uuid AND entity_id=${s.entity_id}::uuid AND is_active AND is_postable
      AND account_type IN ('asset','liability')`)
    if(!payment.length)throw new AutomationError('PAYMENT_ACCOUNT','The selected payment account is unavailable in this company.')
    const snapshot:EntrySnapshot={type:'entry',currency,description:get('note')||'Reviewed receipt',memo:reference,
      lines:[...resolved.map(l=>({accountId:l.accountId,amount:l.amount.toString(),description:l.description,partyId})),
        {accountId:get('paymentAccountId'),amount:(-total).toString(),description:'Reviewed payment account'}]}
    return {snapshot,date,dueDays:0,total:total.toString(),reference}
  }
  const due=validBusinessDate(get('dueOn')),dueDays=Math.round((new Date(due+'T12:00:00Z').getTime()-new Date(date+'T12:00:00Z').getTime())/86400000)
  if(dueDays<0||dueDays>366)throw new AutomationError('DUE_DATE','Enter a due date from the issue date through the following 366 days.')
  return {snapshot:base,date,dueDays,total:total.toString(),reference}
}
export const displayCents=(v:string)=>moneyInput(cents(v))

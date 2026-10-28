import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs, type Runner, type Tx } from './acting'
import { refuseForLedger } from './access'
import type { UserRecord } from './users'
import { auditRow } from './audit-row'
import { openProject, projectDate, saveProjectRecord, createProjectPayment, allocateProjectPayment, voidProjectItem, ProjectError, type ProjectPaymentEdit, type ProjectPaymentRow } from './project'
import { createInvoice, editInvoice, deleteInvoice, postInvoice, InvoiceError, type InvoiceLineInput } from './invoices'
import { postEntryCore, editEntryCore, deleteEntryCore, type PostEntryLine } from './posting'
import { applyEntryToInvoice, deletePayment } from './payments'
import { lockPaymentProjects } from './project-finance-locks'
import { ensureProjectAccountsCore, projectCategoryAccounts,projectTaxAccounts,resolveProjectTaxAccounts } from './project-accounts'
import type { ProjectCategory } from './project-accounting'
import type { ProjectTaxBindings } from './project-tax'

type Account = { id:string; code:string; name:string; account_type:string; normal_balance:string; required_dimensions:string[]; roles:string[] }
type Choice = { id:string; label:string }
export type ProjectFinanceLink = {
  id:string; record_id:string; ledger_id:string; invoice_id:string|null; expense_entry_id:string|null;
  control_account_id:string|null; gst_account_id:string|null; pst_account_id:string|null; bank_account_id:string|null;
  number:string|null; status:string; account_ids:string[]; payment_stages?:string|null
}
export type ProjectFinanceOptions = {
  invoices:boolean; expenses:boolean; payments:boolean;
  revenue:Choice[]; cost:Choice[]; receivable:Choice[]; payable:Choice[];
  gstPayable:Choice[]; pstPayable:Choice[]; gstRecoverable:Choice[]; pstRecoverable:Choice[]; bank:Choice[]
  itemAccounts:Partial<Record<ProjectCategory,Choice>>
  taxAccounts:ProjectTaxBindings
}
async function accounts(entityId:string,on:Runner=db) {
  return on.execute<Account>(sql`SELECT a.id::text,a.code,a.name,a.account_type::text,a.normal_balance::text,a.required_dimensions,
    ARRAY(SELECT role FROM account_role WHERE account_id=a.id) AS roles
    FROM account a WHERE a.entity_id=${entityId}::uuid AND a.is_active AND a.is_postable ORDER BY a.code`)
}
export async function projectFinanceOptions(me:UserRecord,ledgerId:string,entityId:string):Promise<ProjectFinanceOptions> {
  const [invoices,expenses,entries,all,itemAccounts,taxAccounts]=await Promise.all([
    refuseForLedger(me,ledgerId,'/invoices'),refuseForLedger(me,ledgerId,'/expenses'),refuseForLedger(me,ledgerId,'/entries'),accounts(entityId),projectCategoryAccounts(entityId),projectTaxAccounts(entityId),
  ])
  const choices=(test:(a:Account)=>boolean)=>all.filter(test).map(a=>({id:a.id,label:`${a.code} — ${a.name}`}))
  const role=(r:string)=>choices(a=>a.roles.includes(r))
  const taxRole=(r:string)=>choices(a=>a.roles.includes(r)&&a.required_dimensions.length===0
    &&a.account_type===(r.endsWith('payable')?'liability':'asset')&&a.normal_balance===(r.endsWith('payable')?'credit':'debit'))
  return {invoices:!invoices,expenses:!expenses&&!entries,payments:!invoices,revenue:choices(a=>a.account_type==='revenue'),
    cost:choices(a=>!['trade_receivables','trade_payables','cash_and_cash_equivalents'].some(r=>a.roles.includes(r))),
    receivable:role('trade_receivables'),payable:role('trade_payables'),gstPayable:taxRole('gst_hst_payable'),pstPayable:taxRole('qst_pst_payable'),
    gstRecoverable:taxRole('gst_hst_recoverable'),pstRecoverable:taxRole('qst_pst_recoverable'),bank:role('cash_and_cash_equivalents'),itemAccounts,taxAccounts}
}
export async function projectFinanceLinks(entityId:string,projectId:string,on:Runner=db) {
  return on.execute<ProjectFinanceLink>(sql`SELECT h.id::text,h.record_id::text,h.ledger_id::text,h.invoice_id::text,h.expense_entry_id::text,
    h.control_account_id::text,h.gst_account_id::text,h.pst_account_id::text,h.bank_account_id::text,
    coalesce(i.number,j.entry_no) AS number,coalesce(i.status::text,j.status::text,h.state) AS status,
    i.print_template_snapshot->>'paymentStages' AS payment_stages,
    ARRAY(SELECT account_id::text FROM project_accounting_line WHERE link_id=h.id ORDER BY position) AS account_ids
    FROM project_accounting_link h LEFT JOIN invoice i ON i.id=h.invoice_id LEFT JOIN journal_entry j ON j.id=h.expense_entry_id
    WHERE h.entity_id=${entityId}::uuid AND h.project_id=${projectId}::uuid AND h.state='active'`)
}
export async function managedProjectOrigin(invoiceId:string) {
  const [r]=await db.execute<{project_id:string;ledger_id:string;code:string}>(sql`SELECT h.project_id::text,h.ledger_id::text,p.code
    FROM project_accounting_link h JOIN project p ON p.id=h.project_id WHERE h.invoice_id=${invoiceId}::uuid AND h.state='active'`)
  return r||null
}
export async function managedEntryOrigins(entryId:string) {
  return db.execute<{project_id:string;code:string}>(sql`SELECT DISTINCT p.id::text AS project_id,p.code FROM project p WHERE p.id IN (
    SELECT project_id FROM project_accounting_link WHERE expense_entry_id=${entryId}::uuid AND state='active'
    UNION SELECT project_id FROM project_accounting_payment WHERE entry_id=${entryId}::uuid
    UNION SELECT h.project_id FROM project_accounting_link h JOIN invoice i ON i.id=h.invoice_id WHERE i.entry_id=${entryId}::uuid AND h.state='active') ORDER BY p.code`)
}
async function seats(me:UserRecord,ledgerId:string,modules:string[]) {
  for(const seat of new Set(['/projects',...modules])) if(await refuseForLedger(me,ledgerId,seat))
    throw new ProjectError('NO_ACCESS',`Project and ${modules.map(m=>m.slice(1)).join(' / ')} access are required for this action.`)
}
export const projectWrite=(tx:Tx)=>tx.execute(sql`SELECT set_config('erp.project_write','on',true)`)
type RecordInput = Parameters<typeof saveProjectRecord>[0] & {
  ledgerId:string; accountIds?:string[]; originalPositions?:Array<number|null>; controlAccountId?:string; gstAccountId?:string; pstAccountId?:string; bankAccountId?:string
  paymentStages?:string
}
type MappedRecordInput=RecordInput & {accountIds:string[]}
function mappingHash(input:MappedRecordInput) {
  const values:unknown[]=[input.accountIds,input.controlAccountId||null,input.gstAccountId||null,input.pstAccountId||null,input.bankAccountId||null]
  if(input.paymentStages)values.push({paymentStages:input.paymentStages})
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}
async function numberFor(tx:Tx,entityId:string,code:string,direction:'sales'|'purchase',excludeId?:string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project-invoice:${entityId}`},0))`)
  const used=new Set((await tx.execute<{number:string}>(sql`SELECT number FROM invoice WHERE entity_id=${entityId}::uuid AND direction=${direction}
    AND document_kind='invoice' AND (${excludeId||null}::uuid IS NULL OR id<>${excludeId||null}::uuid)
    AND (number=${code} OR starts_with(number,${code+'-'}))`)).map(r=>r.number))
  if(!used.has(code))return code
  for(let n=2;n<=100000;n++){const value=`${code}-${String(n).padStart(2,'0')}`;if(!used.has(value))return value}
  throw new ProjectError('NUMBER','Project document numbers are exhausted.')
}
function financialLines(input:MappedRecordInput,all:Account[],expense:boolean):InvoiceLineInput[] {
  if(input.accountIds.length!==input.lines.length)throw new ProjectError('ACCOUNT','Choose an account for every line.')
  const sign=input.kind==='revenue'?-1n:1n,result:InvoiceLineInput[]=[]
  let gst=0n,pst=0n
  for(const [i,l] of input.lines.entries()) {
    const a=all.find(a=>a.id===input.accountIds[i])
    if(!a || (input.kind==='revenue'?a.account_type!=='revenue':['trade_receivables','trade_payables','cash_and_cash_equivalents'].some(r=>a.roles.includes(r))))
      throw new ProjectError('ACCOUNT','Choose an active item account from this company.')
    if(input.kind==='cost'&&((l.gst>0n&&l.gstRecoverable===null)||(l.pst>0n&&l.pstRecoverable===null)))
      throw new ProjectError('TAX_REVIEW','Enter recoverable tax for every cost line. Use 0 for nonrecoverable tax.')
    const recoverGst=input.kind==='revenue'?l.gst:l.gstRecoverable||0n,recoverPst=input.kind==='revenue'?l.pst:l.pstRecoverable||0n
    gst+=recoverGst;pst+=recoverPst
    const amount=l.base+(input.kind==='cost'?l.gst+l.pst-recoverGst-recoverPst:0n)
    if(amount)result.push({accountId:a.id,amount:sign*amount,description:l.description||input.description,taxCode:l.taxCode})
  }
  for(const [value,id,role,label] of [[gst,input.gstAccountId,input.kind==='revenue'?'gst_hst_payable':'gst_hst_recoverable','GST/HST'],
    [pst,input.pstAccountId,input.kind==='revenue'?'qst_pst_payable':'qst_pst_recoverable','PST/QST']] as const) {
    if(!value)continue
    const a=all.find(a=>a.id===id&&a.roles.includes(role))
    if(!a)throw new ProjectError('TAX_ACCOUNT',`Choose the company's ${label} ${input.kind==='revenue'?'payable':'recoverable'} account.`)
    result.push({accountId:a.id,amount:sign*value,description:label})
  }
  if(expense&&!all.some(a=>a.id===input.bankAccountId&&a.roles.includes('cash_and_cash_equivalents')))
    throw new ProjectError('BANK','Choose an active cash / bank account from this company.')
  return result
}
/** Client account IDs never choose a new line's account. Stable source
 * positions preserve historical mappings through edits and row removal. */
async function recordAccounts(tx:Tx,input:RecordInput,old?:ProjectFinanceLink) {
  const defaults=await projectCategoryAccounts(input.entityId,tx)
  const prior=old?await tx.execute<{position:number;kind:string;account_id:string}>(sql`
    SELECT l.position,l.kind,m.account_id::text FROM project_record_line l
    JOIN project_accounting_line m ON m.link_id=${old.id}::uuid AND m.position=l.position
    WHERE l.record_id=${old.record_id}::uuid ORDER BY l.position`):[]
  const positions=input.originalPositions??input.lines.map((_,i)=>old?i+1:null)
  const used=positions.filter((p):p is number=>p!==null)
  if(positions.length!==input.lines.length||new Set(used).size!==used.length
    ||used.some(p=>!Number.isSafeInteger(p)||!prior.some(l=>l.position===p)))
    throw new ProjectError('STALE_LINES','The original lines changed. Reload this record before editing.')
  return input.lines.map((line,i)=>{
    const original=prior.find(l=>l.position===positions[i])
    if(original?.kind===line.kind)return original.account_id
    const account=defaults[line.kind]
    if(!account)throw new ProjectError('ACCOUNT_SETUP','This Project category has no active account. Review the company’s Project accounts before saving.')
    return account.id
  })
}
async function ledgerScope(tx:Tx,input:{ledgerId:string;entityId:string;projectId:string}) {
  const [l]=await tx.execute<{currency:string}>(sql`SELECT currency FROM ledger WHERE id=${input.ledgerId}::uuid AND entity_id=${input.entityId}::uuid`)
  const p=await openProject(tx,input.entityId,input.projectId)
  if(!l||p.currency!==l.currency)throw new ProjectError('SCOPE','Project and accounting books must belong to the same company and currency.')
  return p
}
/** Identical business input takes the paper-only door, preserving settlements. */
async function unchangedRevenue(tx:Tx,input:MappedRecordInput,old:ProjectFinanceLink) {
  const [record]=await tx.execute<{version:number;party_id:string|null;record_date:string;due_date:string|null;reference:string|null;description:string;kind:string;state:string}>(sql`
    SELECT version,party_id::text,record_date::text,due_date::text,reference,description,kind,state FROM project_record
    WHERE id=${old.record_id}::uuid AND entity_id=${input.entityId}::uuid AND project_id=${input.projectId}::uuid FOR UPDATE`)
  if(!record||record.state!=='active')throw new ProjectError('NO_RECORD','That active record is not in this project.')
  if(record.version!==input.version)throw new ProjectError('CONFLICT','This record changed. Refresh before editing it.')
  const lines=await tx.execute<{kind:string;description:string;base_cents:bigint;gst_cents:bigint;pst_cents:bigint;tax_code:string|null}>(sql`
    SELECT kind,description,base_cents,gst_cents,pst_cents,tax_code FROM project_record_line WHERE record_id=${old.record_id}::uuid ORDER BY position`)
  return record.kind==='revenue'&&!input.paid&&record.party_id===input.partyId&&record.record_date===input.date
    &&record.due_date===(input.dueDate||null)&&record.reference===(input.reference?.trim()||null)&&record.description===input.description.trim()
    &&input.controlAccountId===old.control_account_id&&(input.gstAccountId||null)===old.gst_account_id&&(input.pstAccountId||null)===old.pst_account_id
    &&(input.bankAccountId||null)===old.bank_account_id&&input.accountIds.every((id,i)=>id===old.account_ids[i])
    &&lines.length===input.lines.length&&lines.every((line,i)=>{const next=input.lines[i];return line.kind===next.kind&&line.description===next.description.trim()
      &&line.base_cents===next.base&&line.gst_cents===next.gst&&line.pst_cents===next.pst&&(line.tax_code??null)===(next.taxCode??null)})
}
async function savePaymentStages(tx:Tx,input:RecordInput,invoiceId:string) {
  if(input.paymentStages===undefined)return
  const [inv]=await tx.execute<{print_template_snapshot:Record<string,unknown>|null;status:string;direction:string;document_kind:string}>(sql`
    SELECT print_template_snapshot,status,direction,document_kind FROM invoice WHERE id=${invoiceId}::uuid AND ledger_id=${input.ledgerId}::uuid FOR UPDATE`)
  if(!inv||inv.status!=='posted'||inv.direction!=='sales'||inv.document_kind!=='invoice'||!inv.print_template_snapshot)
    throw new ProjectError('PAYMENT_STAGES','This linked sales invoice cannot change its payment stages.')
  const snapshot={...inv.print_template_snapshot}
  if(input.paymentStages)snapshot.paymentStages=input.paymentStages;else delete snapshot.paymentStages
  if(JSON.stringify(snapshot)===JSON.stringify(inv.print_template_snapshot))return
  await tx.execute(sql`SELECT set_config('erp.payment_stages_edit','on',true)`)
  await tx.execute(sql`UPDATE invoice SET print_template_snapshot=${JSON.stringify(snapshot)}::jsonb WHERE id=${invoiceId}::uuid`)
  await tx.execute(sql`SELECT set_config('erp.payment_stages_edit','off',true)`)
  await auditRow(tx,{actor:input.actor,action:'edit_payment_stages',table:'invoice',recordId:invoiceId,entityId:input.entityId,ledgerId:input.ledgerId,scope:'company',
    before:{paymentStages:inv.print_template_snapshot.paymentStages??null},after:{paymentStages:input.paymentStages||null}})
}
/** Project source, accounting document, and initial settlement share one commit. */
export async function saveProjectFinanceRecord(me:UserRecord,requestInput:RecordInput) {
  if(requestInput.paymentStages!==undefined&&requestInput.kind!=='revenue')
    throw new ProjectError('PAYMENT_STAGES','Payment stages apply to sales invoices only.')
  if(requestInput.paymentStages!==undefined&&(typeof requestInput.paymentStages!=='string'||requestInput.paymentStages.length>4000))
    throw new ProjectError('PAYMENT_STAGES','Payment stages allow up to 4,000 characters.')
  requestInput={...requestInput,paymentStages:requestInput.paymentStages?.trim()}
  const input=requestInput
  await seats(me,input.ledgerId,[])
  const gross=input.lines.reduce((n,l)=>n+l.base+l.gst+l.pst,0n)
  const direct=!!input.paid&&(input.paid.amount??gross)===gross&&input.paid.date===input.date
  const existing=input.recordId?(await projectFinanceLinks(input.entityId,input.projectId)).find(l=>l.record_id===input.recordId):undefined
  const expense=existing?!!existing.expense_entry_id:input.kind==='cost'&&direct
  await seats(me,input.ledgerId,expense?['/expenses','/entries']:['/invoices',...(input.paid?['/invoices']:[])])
  return actingAs(input.actor,async tx=>{
    const p=await ledgerScope(tx,requestInput)
    await projectWrite(tx)
    const old=requestInput.recordId?(await projectFinanceLinks(requestInput.entityId,p.id,tx)).find(l=>l.record_id===requestInput.recordId):undefined
    if(old&&old.ledger_id!==requestInput.ledgerId)throw new ProjectError('BOOK','Open this linked record in its original accounting book.')
    if(requestInput.recordId&&!old) {
      const [legacy]=await tx.execute(sql`SELECT id FROM project_invoice_handoff WHERE record_id=${requestInput.recordId}::uuid`)
      const [settled]=await tx.execute<{sum:string}>(sql`SELECT coalesce(sum(amount_cents),0)::text AS sum FROM project_payment_allocation WHERE record_id=${requestInput.recordId}::uuid AND state='active'`)
      if(legacy||BigInt(settled.sum)>0n)throw new ProjectError('LEGACY','This record has earlier documents or operational payments. Keep its existing workflow; create new records to use automatic accounting.')
    }
    await ensureProjectAccountsCore(tx,requestInput.entityId,requestInput.actor)
    const taxBindings=await projectTaxAccounts(requestInput.entityId,tx,old?{kind:requestInput.kind,gstAccountId:old.gst_account_id,pstAccountId:old.pst_account_id}:undefined)
    const input:MappedRecordInput={...requestInput,paymentStages:requestInput.paymentStages??old?.payment_stages??undefined,accountIds:await recordAccounts(tx,requestInput,old),...resolveProjectTaxAccounts(taxBindings,requestInput.kind,requestInput.lines)}
    const all=await accounts(input.entityId,tx),lines=financialLines(input,all,expense)
    const role=input.kind==='revenue'?'trade_receivables':'trade_payables'
    if(!expense&&!all.some(a=>a.id===input.controlAccountId&&a.roles.includes(role)))
      throw new ProjectError('CONTROL','Choose the company’s trade receivables / payables account.')
    if(old?.invoice_id&&input.kind==='revenue'&&await unchangedRevenue(tx,input,old)) {
      await savePaymentStages(tx,requestInput,old.invoice_id)
      await tx.execute(sql`UPDATE project_record SET version=version+1,updated_at=now() WHERE id=${old.record_id}::uuid`)
      return old.record_id
    }
    // Editing a bill releases its applications under the existing open-books
    // policy. The mirror keeps Project settlements in step with that release.
    if(old?.invoice_id)await tx.execute(sql`DELETE FROM invoice_application WHERE invoice_id=${old.invoice_id}::uuid`)
    if(old?.expense_entry_id) {
      await tx.execute(sql`UPDATE project_payment_allocation SET state='void',version=version+1 WHERE record_id=${input.recordId}::uuid AND state='active'`)
    }
    const recordId=await saveProjectRecord({...input,paid:expense?input.paid:undefined},tx)
    const [prior]=await tx.execute<{id:string;mapping_hash:string}>(sql`SELECT id::text,mapping_hash FROM project_accounting_link WHERE record_id=${recordId}::uuid`)
    if(prior&&!input.recordId) {
      if(prior.mapping_hash!==mappingHash(input))throw new ProjectError('REPLAY','That record was already saved with different accounting or printed details. Refresh before editing it.')
      return recordId
    }
    const direction=input.kind==='revenue'?'sales' as const:'purchase' as const
    let invoiceId=old?.invoice_id||null,entryId=old?.expense_entry_id||null
    const dueOn=input.dueDate||input.date
    if(expense) {
      const entryLines:PostEntryLine[]=[{accountId:input.bankAccountId!,amount:-gross,description:input.description},
        ...lines.map(l=>({accountId:l.accountId,amount:l.amount,description:l.description,
          partyId:input.accountIds.includes(l.accountId)?input.partyId||undefined:undefined}))]
      const payload={ledgerId:input.ledgerId,entryDate:input.date,description:input.description||`Project ${p.code} cost`,documentRef:input.reference,sourceType:'quick_expense' as const,actor:input.actor,lines:entryLines}
      if(entryId) {
        await editEntryCore(tx,entryId,payload,input.actor,'quick_expense')
        const [pay]=await tx.execute<{payment_id:string}>(sql`SELECT payment_id::text FROM project_accounting_payment WHERE entry_id=${entryId}::uuid AND project_id=${p.id}::uuid`)
        await tx.execute(sql`UPDATE project_payment SET party_id=${input.partyId}::uuid,payment_date=${input.date}::date,amount_cents=${gross},version=version+1 WHERE id=${pay.payment_id}::uuid`)
        await allocateProjectPayment({entityId:input.entityId,projectId:p.id,paymentId:pay.payment_id,recordId,amount:gross,actor:input.actor},tx)
      } else entryId=(await postEntryCore(tx,payload)).entry.id
    } else {
      if(!input.partyId)throw new ProjectError('PARTY','Purchase bills require a supplier. Choose one before saving an unpaid cost.')
      const payload={ledgerId:input.ledgerId,direction,partyId:input.partyId,controlAccountId:input.controlAccountId!,issuedOn:input.date,dueOn,theirRef:input.reference,note:input.description,lines,actor:input.actor}
      if(invoiceId) {
        const [inv]=await tx.execute<{number:string}>(sql`SELECT number FROM invoice WHERE id=${invoiceId}::uuid`)
        const number=input.kind==='cost'?(input.reference?.trim()||await numberFor(tx,input.entityId,p.code+'-B',direction,invoiceId)):inv.number
        await editInvoice(invoiceId,{...payload,number},tx)
      } else for(let attempt=0;attempt<10;attempt++) {
        try {invoiceId=(await createInvoice({...payload,number:input.kind==='cost'&&input.reference?.trim()?input.reference.trim():await numberFor(tx,input.entityId,input.kind==='revenue'?p.code:p.code+'-B',direction)},tx)).id;break}
        catch(error){if(error instanceof InvoiceError&&error.code==='DUPLICATE_NUMBER'&&!(input.kind==='cost'&&input.reference?.trim())&&attempt<9)continue;throw error}
      }
    }
    const [link]=await tx.execute<{id:string}>(sql`INSERT INTO project_accounting_link(entity_id,project_id,record_id,ledger_id,invoice_id,expense_entry_id,control_account_id,gst_account_id,pst_account_id,bank_account_id,created_by,mapping_hash)
      VALUES(${input.entityId}::uuid,${p.id}::uuid,${recordId}::uuid,${input.ledgerId}::uuid,${invoiceId}::uuid,${entryId}::uuid,${input.controlAccountId||null}::uuid,
        ${input.gstAccountId||null}::uuid,${input.pstAccountId||null}::uuid,${input.bankAccountId||null}::uuid,${input.actor},${mappingHash(input)})
      ON CONFLICT(record_id) DO UPDATE SET control_account_id=excluded.control_account_id,gst_account_id=excluded.gst_account_id,
        pst_account_id=excluded.pst_account_id,bank_account_id=excluded.bank_account_id RETURNING id::text`)
    await tx.execute(sql`DELETE FROM project_accounting_line WHERE link_id=${link.id}::uuid`)
    for(const [i,id] of input.accountIds.entries())await tx.execute(sql`INSERT INTO project_accounting_line(entity_id,link_id,position,account_id) VALUES(${input.entityId}::uuid,${link.id}::uuid,${i+1},${id}::uuid)`)
    if(invoiceId) {
      const [inv]=await tx.execute<{status:string}>(sql`SELECT status FROM invoice WHERE id=${invoiceId}::uuid`)
      if(inv.status==='draft')await postInvoice(invoiceId,input.actor,tx,{paymentStages:input.paymentStages})
      else if(old&&input.kind==='revenue')await savePaymentStages(tx,requestInput,invoiceId)
    }
    if(expense&&!old) {
      const [pay]=await tx.execute<{payment_id:string}>(sql`SELECT payment_id::text FROM project_payment_allocation WHERE record_id=${recordId}::uuid AND state='active'`)
      await tx.execute(sql`INSERT INTO project_accounting_payment(entity_id,project_id,payment_id,entry_id,origin) VALUES(${input.entityId}::uuid,${p.id}::uuid,${pay.payment_id}::uuid,${entryId}::uuid,'project')`)
    }
    if(input.paid&&!expense) {
      await seats(me,input.ledgerId,['/invoices'])
      await paymentCore(tx,{...input,bankAccountId:input.bankAccountId!,partyId:input.partyId,direction:'paid',date:input.paid.date,amount:input.paid.amount??gross,
        recordId,allocation:input.paid.amount??gross,key:`project-paid:${recordId}`,method:input.paid.method,reference:input.paid.reference})
    }
    await auditRow(tx,{actor:input.actor,action:old?'sync_project_edit':'create_project_accounting',table:'project_accounting_link',recordId:link.id,
      entityId:input.entityId,ledgerId:input.ledgerId,scope:'company',after:{recordId,invoiceId,entryId}})
    return recordId
  })
}

type PaymentInput=Parameters<typeof createProjectPayment>[0]&{ledgerId:string;bankAccountId:string;controlAccountId?:string}
async function paymentCore(tx:Tx,input:PaymentInput) {
  const p=await ledgerScope(tx,input)
  await projectWrite(tx)
  const all=await accounts(input.entityId,tx)
  if(!all.some(a=>a.id===input.bankAccountId&&a.roles.includes('cash_and_cash_equivalents')))throw new ProjectError('BANK','Choose an active cash / bank account from this company.')
  const hash=createHash('sha256').update(JSON.stringify([input.bankAccountId,input.controlAccountId||null,input.recordId||null,(input.allocation??input.amount).toString()])).digest('hex')
  const [existing]=await tx.execute<{id:string;entry_id:string|null;mapping_hash:string|null}>(sql`SELECT p.id::text,h.entry_id::text,h.mapping_hash FROM project_payment p LEFT JOIN project_accounting_payment h ON h.payment_id=p.id
    WHERE p.entity_id=${input.entityId}::uuid AND p.idempotency_key=${input.key}`)
  const recordLink=input.recordId?(await projectFinanceLinks(input.entityId,p.id,tx)).find(l=>l.record_id===input.recordId):undefined
  if(input.recordId&&!recordLink?.invoice_id)throw new ProjectError('DOCUMENT','Choose a record linked to an invoice or purchase bill. Use the existing workflow for older operational records.')
  if(recordLink&&recordLink.ledger_id!==input.ledgerId)throw new ProjectError('BOOK','Record this payment in the linked document’s accounting book.')
  if(recordLink&&!existing?.entry_id) {
    const applied=input.allocation??input.amount
    const [r]=await tx.execute<{remaining:string}>(sql`SELECT
      ((SELECT sum(base_cents+gst_cents+pst_cents) FROM project_record_line WHERE record_id=${input.recordId!}::uuid)
        -coalesce((SELECT sum(amount_cents) FROM project_payment_allocation WHERE record_id=${input.recordId!}::uuid AND state='active'),0))::text AS remaining`)
    if(applied<=0n||applied>input.amount||applied>BigInt(r.remaining))throw new ProjectError('OVERPAYMENT','Allocation must be positive and cannot exceed this payment or the record’s outstanding balance.')
  }
  let control=input.controlAccountId
  if(recordLink)control=recordLink.control_account_id||undefined
  const role=input.direction==='received'?'trade_receivables':'trade_payables'
  if(!all.some(a=>a.id===control&&a.roles.includes(role)))throw new ProjectError('CONTROL','Choose the company’s trade receivables / payables account.')
  // Compare the original operational payload on retries before returning its
  // existing accounting link. Never create a second journal entry.
  const paymentId=await createProjectPayment({...input,recordId:undefined,allocation:undefined},tx)
  if(existing?.entry_id) {
    if(existing.mapping_hash!==hash)throw new ProjectError('REPLAY','That payment was already saved with different accounting or allocation details.')
    const [bank]=await tx.execute<{yes:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM journal_line WHERE entry_id=${existing.entry_id}::uuid AND account_id=${input.bankAccountId}::uuid) AS yes`)
    if(!bank.yes)throw new ProjectError('REPLAY','That payment was saved to a different bank account. Refresh before trying again.')
    return paymentId
  }
  const sign=input.direction==='received'?1n:-1n
  const posted=await postEntryCore(tx,{ledgerId:input.ledgerId,entryDate:input.date,description:input.note||`Project ${p.code} ${input.direction==='received'?'receipt':'payment'}`,
    documentRef:input.reference,sourceType:'payment',actor:input.actor,
    lines:[{accountId:input.bankAccountId,amount:sign*input.amount},{accountId:control!,amount:-sign*input.amount,partyId:input.partyId||undefined}]})
  await tx.execute(sql`INSERT INTO project_accounting_payment(entity_id,project_id,payment_id,entry_id,origin,mapping_hash) VALUES(${input.entityId}::uuid,${p.id}::uuid,${paymentId}::uuid,${posted.entry.id}::uuid,'project',${hash})`)
  if(recordLink?.invoice_id) {
    const [inv]=await tx.execute<{status:string}>(sql`SELECT status FROM invoice WHERE id=${recordLink.invoice_id}::uuid`)
    if(inv.status==='draft')await postInvoice(recordLink.invoice_id,input.actor,tx)
    await applyEntryToInvoice({invoiceId:recordLink.invoice_id,entryId:posted.entry.id,amount:input.allocation??input.amount,actor:input.actor},tx)
  }
  return paymentId
}
export async function saveProjectFinancePayment(me:UserRecord,input:PaymentInput) {
  await seats(me,input.ledgerId,['/invoices',...(input.recordId?['/invoices']:[])])
  return actingAs(input.actor,tx=>paymentCore(tx,input))
}

async function paymentEditState(entityId:string,projectId:string,paymentId:string,on:Runner=db) {
  const [pay]=await on.execute<{id:string;version:number;party_id:string|null;direction:'paid'|'received';date:string;amount:string;reference:string|null;note:string|null;entry_id:string|null;origin:string|null;ledger_id:string|null;source_type:string|null;description:string|null;memo:string|null;entry_date:string|null}>(sql`
    SELECT p.id::text,p.version,p.party_id::text,p.direction,p.payment_date::text AS date,p.amount_cents::text AS amount,p.reference,p.note,
      h.entry_id::text,h.origin,j.ledger_id::text,j.source_type,j.description,j.memo,j.entry_date::text
    FROM project_payment p LEFT JOIN project_accounting_payment h ON h.payment_id=p.id LEFT JOIN journal_entry j ON j.id=h.entry_id
    WHERE p.id=${paymentId}::uuid AND p.entity_id=${entityId}::uuid AND p.project_id=${projectId}::uuid AND p.state='active'`)
  if(!pay)throw new ProjectError('STALE','This payment changed. Reload the project before editing.')
  const lines=pay.entry_id?await on.execute<{account_id:string;amount:string;party_id:string|null;description:string|null;tax_code:string|null;cash:boolean}>(sql`
    SELECT l.account_id::text,l.amount::text,l.party_id::text,l.description,NULL::text AS tax_code,
      EXISTS(SELECT 1 FROM account_role WHERE account_id=l.account_id AND role='cash_and_cash_equivalents') AS cash
    FROM journal_line l WHERE l.entry_id=${pay.entry_id}::uuid ORDER BY l.line_no`):[]
  const allocations=pay.source_type==='payment'?await on.execute<{target:string;label:string;amount:string}>(sql`
    SELECT 'invoice:'||i.id::text AS target,i.number AS label,sum(a.amount)::text AS amount
    FROM invoice_application a JOIN invoice i ON i.id=a.invoice_id WHERE a.entry_id=${pay.entry_id}::uuid
    GROUP BY i.id ORDER BY i.id`):await on.execute<{target:string;label:string;amount:string}>(sql`
    SELECT 'record:'||r.id::text AS target,coalesce(nullif(r.description,''),r.kind||' on '||r.record_date::text) AS label,sum(a.amount_cents)::text AS amount
    FROM project_payment_allocation a JOIN project_record r ON r.id=a.record_id WHERE a.payment_id=${paymentId}::uuid AND a.state='active'
    GROUP BY r.id ORDER BY r.id`)
  const bank=lines.find(l=>l.cash),control=pay.source_type==='payment'?lines.find(l=>!l.cash):undefined
  if(pay.entry_id&&(!bank||lines.filter(l=>l.cash).length!==1||pay.source_type==='payment'&&(lines.length!==2||!control)))
    throw new ProjectError('PAYMENT_SHAPE','Open the original accounting payment to review its lines before editing.')
  const edit:ProjectPaymentEdit={amount:bank?(BigInt(bank.amount)<0n?-BigInt(bank.amount):BigInt(bank.amount)).toString():pay.amount,
    note:pay.note||pay.memo,bankAccountId:bank?.account_id||null,controlAccountId:control?.account_id||null,source:pay.source_type,
    allocations:Array.from(allocations),signature:createHash('sha256').update(JSON.stringify([pay.date,pay.amount,pay.reference,pay.entry_date,lines,allocations])).digest('hex')}
  return {pay,lines,edit}
}
export async function withProjectPaymentEditing(entityId:string,projectId:string,payments:ProjectPaymentRow[]):Promise<ProjectPaymentRow[]> {
  return Promise.all(payments.map(async p=>{
    try{return {...p,edit:(await paymentEditState(entityId,projectId,p.id)).edit}}
    catch(error){if(error instanceof ProjectError&&error.code==='PAYMENT_SHAPE')return p;throw error}
  }))
}
export type EditProjectPaymentInput={entityId:string;ledgerId:string;projectId:string;paymentId:string;version:number;signature:string;
  date:string;amount:bigint;reference?:string;note?:string;bankAccountId?:string;controlAccountId?:string;actor:string;allocations:Array<{target:string;amount:bigint}>}
/** Keep the cash entry, invoice applications and all Project mirrors in one transaction. */
export async function editProjectFinancePayment(me:UserRecord,input:EditProjectPaymentInput) {
  await seats(me,input.ledgerId,[])
  projectDate(input.date)
  if(input.amount<=0n)throw new ProjectError('AMOUNT','Enter a positive payment amount.')
  if((input.reference?.length||0)>1000||(input.note?.length||0)>10000)throw new ProjectError('TEXT','Reference or notes are too long.')
  return actingAs(input.actor,async tx=>{
    const [mapped]=await tx.execute<{entry_id:string|null}>(sql`SELECT entry_id::text FROM project_accounting_payment WHERE payment_id=${input.paymentId}::uuid AND entity_id=${input.entityId}::uuid`)
    if(mapped?.entry_id)await lockPaymentProjects(tx,mapped.entry_id)
    const project=await ledgerScope(tx,input);await projectWrite(tx)
    if(mapped?.entry_id) {
      const [closed]=await tx.execute(sql`SELECT p.id FROM project p JOIN project_accounting_payment h ON h.project_id=p.id
        WHERE h.entry_id=${mapped.entry_id}::uuid AND (p.status='archived' OR p.deleted_at IS NOT NULL) LIMIT 1`)
      if(closed)throw new ProjectError('ARCHIVED','A linked project is read-only. Restore it before editing this shared payment.')
    }
    await tx.execute(sql`SELECT id FROM project_payment WHERE id=${input.paymentId}::uuid FOR UPDATE`)
    const {pay,lines,edit}=await paymentEditState(input.entityId,input.projectId,input.paymentId,tx)
    if(pay.version!==input.version||edit.signature!==input.signature)throw new ProjectError('STALE','This payment or its allocations changed. Reload the project before editing.')
    if(pay.entry_id&&pay.ledger_id!==input.ledgerId)throw new ProjectError('BOOK','Edit this payment in its original accounting book.')
    const targets=new Set(edit.allocations.map(a=>a.target))
    if(input.allocations.length!==targets.size||new Set(input.allocations.map(a=>a.target)).size!==targets.size||input.allocations.some(a=>!targets.has(a.target)||a.amount<0n))
      throw new ProjectError('ALLOCATION','Existing allocation targets changed. Reload before editing.')
    const allocated=input.allocations.reduce((n,a)=>n+a.amount,0n)
    if(allocated>input.amount)throw new ProjectError('OVERPAYMENT','Allocated amount cannot exceed this payment. Adjust the allocations below.')
    const update=()=>tx.execute(sql`UPDATE project_payment SET payment_date=${input.date}::date,amount_cents=${input.amount},reference=${input.reference?.trim()||null},note=${input.note?.trim()||null},version=version+1 WHERE id=${pay.id}::uuid`)
    if(!pay.entry_id) {
      if(mapped)throw new ProjectError('STALE','The accounting entry was removed. Reload before editing.')
      await tx.execute(sql`UPDATE project_payment_allocation SET state='void',version=version+1 WHERE payment_id=${pay.id}::uuid AND state='active'`)
      await update()
      for(const a of input.allocations)if(a.amount)await allocateProjectPayment({...input,recordId:a.target.slice(7),amount:a.amount},tx)
    } else {
      const all=await accounts(input.entityId,tx)
      if(!all.some(a=>a.id===input.bankAccountId&&a.roles.includes('cash_and_cash_equivalents')))throw new ProjectError('BANK','Choose an active cash / bank account from this company.')
      let entryId=pay.entry_id,control=edit.controlAccountId
      if(pay.source_type==='quick_expense') {
        await seats(me,input.ledgerId,['/expenses','/entries'])
        const link=(await projectFinanceLinks(input.entityId,input.projectId,tx)).find(l=>l.expense_entry_id===pay.entry_id)
        if(!link)throw new ProjectError('STALE','The paid cost changed. Reload before editing.')
        if(input.date===pay.entry_date&&input.amount===BigInt(edit.amount)&&allocated===input.amount) {
          await editEntryCore(tx,entryId,{entryDate:input.date,description:pay.description!,memo:input.note,
            lines:lines.map(l=>({accountId:l.cash?input.bankAccountId!:l.account_id,amount:BigInt(l.amount),partyId:l.party_id||undefined,description:l.description||undefined})),
            documentRef:(await tx.execute<{reference:string|null}>(sql`SELECT reference FROM project_record WHERE id=${link.record_id}::uuid`))[0].reference||undefined},input.actor,'quick_expense')
          await update()
          await tx.execute(sql`UPDATE project_accounting_link SET bank_account_id=${input.bankAccountId}::uuid WHERE id=${link.id}::uuid`)
        } else {
          // Separate the unchanged cost recognition from a corrected settlement.
          await seats(me,input.ledgerId,['/invoices'])
          if(!pay.party_id)throw new ProjectError('PARTY','Add a supplier to the cost before changing this payment date or amount.')
          if(!all.some(a=>a.id===input.controlAccountId&&a.roles.includes('trade_payables')))throw new ProjectError('CONTROL','Choose the company’s payables account.')
          const [record]=await tx.execute<{date:string;due:string|null;reference:string|null;description:string}>(sql`SELECT record_date::text AS date,due_date::text AS due,reference,description FROM project_record WHERE id=${link.record_id}::uuid`)
          await tx.execute(sql`UPDATE project_payment_allocation SET state='void',version=version+1 WHERE payment_id=${pay.id}::uuid AND state='active'`)
          await tx.execute(sql`UPDATE project_accounting_link SET state='void',expense_entry_id=NULL WHERE id=${link.id}::uuid`)
          const invoice=await createInvoice({ledgerId:input.ledgerId,direction:'purchase',partyId:pay.party_id,controlAccountId:input.controlAccountId!,issuedOn:record.date,dueOn:record.due||record.date,
            number:record.reference?.trim()||await numberFor(tx,input.entityId,project.code+'-B','purchase'),theirRef:record.reference||undefined,note:record.description,
            lines:lines.filter(l=>!l.cash).map(l=>({accountId:l.account_id,amount:BigInt(l.amount),description:l.description||undefined,taxCode:l.tax_code as InvoiceLineInput['taxCode']})),actor:input.actor},tx)
          await tx.execute(sql`UPDATE project_accounting_link SET state='active',invoice_id=${invoice.id}::uuid,control_account_id=${input.controlAccountId}::uuid,bank_account_id=NULL WHERE id=${link.id}::uuid`)
          await postInvoice(invoice.id,input.actor,tx)
          // Retain the original supporting paper before deleting the cash expense.
          await tx.execute(sql`UPDATE attachment SET entry_id=(SELECT entry_id FROM invoice WHERE id=${invoice.id}::uuid) WHERE entry_id=${entryId}::uuid`)
          await deleteEntryCore(tx,entryId,input.actor,'quick_expense')
          control=input.controlAccountId!
          entryId=(await postEntryCore(tx,{ledgerId:input.ledgerId,entryDate:input.date,description:input.note||`Project ${project.code} payment`,documentRef:input.reference,sourceType:'payment',actor:input.actor,
            lines:[{accountId:input.bankAccountId!,amount:-input.amount},{accountId:control,amount:input.amount,partyId:pay.party_id}]})).entry.id
          await tx.execute(sql`UPDATE project_accounting_payment SET entry_id=${entryId}::uuid WHERE payment_id=${pay.id}::uuid`)
          await update()
          for(const a of input.allocations)if(a.amount)await applyEntryToInvoice({entryId,invoiceId:invoice.id,amount:a.amount,actor:input.actor},tx)
        }
      } else if(pay.source_type==='payment') {
        await seats(me,input.ledgerId,['/invoices'])
        const sign=pay.direction==='received'?1n:-1n
        const oldControl=lines.find(l=>!l.cash)!
        if(!control||oldControl.party_id!==pay.party_id||BigInt(lines.find(l=>l.cash)!.amount)*sign<=0n)
          throw new ProjectError('PAYMENT_SHAPE','This payment has different accounting details. Review its original entry.')
        await editEntryCore(tx,entryId,{entryDate:input.date,description:input.note||`Project ${project.code} ${pay.direction==='received'?'receipt':'payment'}`,memo:input.note,documentRef:input.reference,
          lines:[{accountId:input.bankAccountId!,amount:sign*input.amount},{accountId:control,amount:-sign*input.amount,partyId:pay.party_id||undefined}]},input.actor,'payment')
        if(pay.origin==='project')await update()
        for(const a of input.allocations)if(a.amount)await applyEntryToInvoice({entryId,invoiceId:a.target.slice(8),amount:a.amount,actor:input.actor},tx)
        // Accounting-origin mirrors represent only their own allocated share.
        await tx.execute(sql`UPDATE project_payment SET payment_date=${input.date}::date,reference=${input.reference?.trim()||null},note=${input.note?.trim()||null},version=version+1
          WHERE id IN (SELECT payment_id FROM project_accounting_payment WHERE entry_id=${entryId}::uuid)`)
      } else throw new ProjectError('PAYMENT_SHAPE','This entry cannot be edited as a payment.')
    }
    await auditRow(tx,{actor:input.actor,action:'edit_project_payment',table:'project_payment',recordId:pay.id,entityId:input.entityId,ledgerId:input.ledgerId,scope:'company',
      before:{date:pay.date,amount:edit.amount,allocations:edit.allocations},after:{date:input.date,amount:input.amount.toString(),allocations:input.allocations.map(a=>({...a,amount:a.amount.toString()}))}})
  })
}
export async function allocateProjectFinancePayment(me:UserRecord,input:Parameters<typeof allocateProjectPayment>[0]&{ledgerId:string}) {
  await seats(me,input.ledgerId,['/invoices','/invoices'])
  return actingAs(input.actor,async tx=>{
    await ledgerScope(tx,input);await projectWrite(tx)
    const [pay]=await tx.execute<{entry_id:string}>(sql`SELECT entry_id::text FROM project_accounting_payment WHERE payment_id=${input.paymentId}::uuid AND project_id=${input.projectId}::uuid AND entity_id=${input.entityId}::uuid`)
    const link=(await projectFinanceLinks(input.entityId,input.projectId,tx)).find(l=>l.record_id===input.recordId)
    if(!pay?.entry_id||!link?.invoice_id)throw new ProjectError('DOCUMENT','Allocate accounting payments to linked invoices or bills.')
    if(link.ledger_id!==input.ledgerId)throw new ProjectError('BOOK','Allocate in the linked document’s accounting book.')
    const [inv]=await tx.execute<{status:string}>(sql`SELECT status FROM invoice WHERE id=${link.invoice_id}::uuid`)
    if(inv.status==='draft')await postInvoice(link.invoice_id,input.actor,tx)
    // Allocation submission key belongs to Project; the mirror writes the row.
    const [prior]=input.key?await tx.execute<{amount:string;payment_id:string;record_id:string}>(sql`SELECT amount_cents::text AS amount,payment_id::text,record_id::text FROM project_payment_allocation WHERE entity_id=${input.entityId}::uuid AND idempotency_key=${input.key}`):[]
    if(prior){if(BigInt(prior.amount)!==input.amount||prior.payment_id!==input.paymentId||prior.record_id!==input.recordId)throw new ProjectError('REPLAY','Allocation changed on retry.');return}
    await applyEntryToInvoice({invoiceId:link.invoice_id,entryId:pay.entry_id,amount:input.amount,actor:input.actor},tx)
    if(input.key)await tx.execute(sql`UPDATE project_payment_allocation SET idempotency_key=${input.key} WHERE id=(SELECT a.id FROM project_payment_allocation a JOIN project_accounting_application b ON b.allocation_id=a.id WHERE a.payment_id=${input.paymentId}::uuid AND a.record_id=${input.recordId}::uuid AND a.state='active' ORDER BY a.created_at DESC LIMIT 1)`)
  })
}
export async function cancelProjectFinanceItem(me:UserRecord,input:Parameters<typeof voidProjectItem>[0]&{ledgerId:string}) {
  await seats(me,input.ledgerId,[])
  return actingAs(input.actor,async tx=>{
    await ledgerScope(tx,input);await projectWrite(tx)
    if(input.kind==='record') {
      const link=(await projectFinanceLinks(input.entityId,input.projectId,tx)).find(l=>l.record_id===input.id)
      if(link) {
        await seats(me,input.ledgerId,link.invoice_id?['/invoices']:['/expenses','/entries'])
        if(link.invoice_id) {
          await tx.execute(sql`UPDATE project_accounting_link SET state='void' WHERE id=${link.id}::uuid`)
          await deleteInvoice(link.invoice_id,input.actor,tx)
        }
        else {
          await tx.execute(sql`UPDATE project_accounting_link SET state='void',expense_entry_id=NULL WHERE id=${link.id}::uuid`)
          await tx.execute(sql`UPDATE project_payment SET state='void',version=version+1 WHERE id IN (SELECT payment_id FROM project_accounting_payment WHERE entry_id=${link.expense_entry_id}::uuid)`)
          await deleteEntryCore(tx,link.expense_entry_id!,input.actor,'quick_expense',input.reason)
        }
        await tx.execute(sql`UPDATE project_accounting_link SET state='void',invoice_id=NULL WHERE id=${link.id}::uuid`)
      }
    } else if(input.kind==='payment') {
      const [pay]=await tx.execute<{entry_id:string;source_type:string}>(sql`SELECT h.entry_id::text,j.source_type FROM project_accounting_payment h JOIN journal_entry j ON j.id=h.entry_id WHERE h.payment_id=${input.id}::uuid AND h.entity_id=${input.entityId}::uuid AND h.project_id=${input.projectId}::uuid`)
      if(pay) {
        if(pay.source_type==='quick_expense')throw new ProjectError('EXPENSE','Cancel the paid cost record to cancel its expense and payment together.')
        await seats(me,input.ledgerId,['/invoices'])
        // deletePayment releases all linked allocations. Check version first,
        // then it can also cancel mirrors in other projects sharing the entry.
        await voidProjectItem(input,tx)
        await deletePayment(pay.entry_id,input.actor,tx)
        return
      }
    } else {
      const [app]=await tx.execute<{application_id:string}>(sql`SELECT application_id::text FROM project_accounting_application WHERE allocation_id=${input.id}::uuid AND entity_id=${input.entityId}::uuid`)
      if(app?.application_id) {
        await seats(me,input.ledgerId,['/invoices','/invoices'])
        await voidProjectItem(input,tx)
        await tx.execute(sql`DELETE FROM invoice_application WHERE id=${app.application_id}::uuid`)
        return
      }
    }
    await voidProjectItem(input,tx)
  })
}

import 'server-only'
import { createHash } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs, type Runner, type Tx } from './acting'
import { auditRow } from './audit-row'
import { projectLineAmounts, PROJECT_AMOUNT_KEYS, PROJECT_CATEGORIES, type ProjectCategory } from './project-accounting'
import { TAX_CODES, type TaxCode } from './tax-rates'

export class ProjectError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProjectError' }
}
export const projectId = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new ProjectError('BAD_ID', 'That record identifier is not valid.')
  return id
}
export function projectDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T12:00:00Z'))
      || new Date(value+'T12:00:00Z').toISOString().slice(0,10) !== value)
    throw new ProjectError('BAD_DATE', 'Use a valid date in YYYY-MM-DD format.')
  return value
}
const text = (value: string, label: string) => {
  const s = value.trim()
  if (!s || s.length > 1000) throw new ProjectError('REQUIRED', `${label} is required (up to 1,000 characters).`)
  return s
}
export type ProjectCompany = { id: string; name: string; currency: string; archived_at: string | null }
export async function projectCompany(ledgerId: string): Promise<ProjectCompany> {
  projectId(ledgerId)
  const [row] = await db.execute<ProjectCompany>(sql`
    SELECT e.id::text, e.name, e.archived_at::text, l.currency FROM ledger l JOIN entity e ON e.id=l.entity_id
    WHERE l.id=${ledgerId}::uuid`)
  if (!row) throw new ProjectError('NO_COMPANY', 'That company is not on file.')
  return row
}
export type ProjectHead = {
  id: string; entity_id: string; code: string; name: string; customer_party_id: string; customer: string;
  currency: string; site: string | null; start_date: string | null; end_date: string | null;
  note: string | null; status: string; version: number; deleted_at:string|null; deleted_by:string|null
}
async function openCompany(tx: Tx, entityId: string) {
  projectId(entityId)
  const [e] = await tx.execute<{ archived_at: string | null }>(sql`SELECT archived_at::text FROM entity WHERE id=${entityId}::uuid FOR SHARE`)
  if (!e) throw new ProjectError('NO_COMPANY', 'That company is not on file.')
  if (e.archived_at) throw new ProjectError('ARCHIVED', 'This company is archived. Its projects are read-only.')
}
export async function projectHead(entityId: string, id: string, on: Runner = db, lock = false, includeDeleted = false): Promise<ProjectHead> {
  projectId(id); projectId(entityId)
  const [p] = await on.execute<ProjectHead>(sql`SELECT p.*, p.id::text, p.entity_id::text,
    p.customer_party_id::text, c.name AS customer, p.start_date::text, p.end_date::text
    FROM project p JOIN party c ON c.id=p.customer_party_id
    WHERE p.id=${id}::uuid AND p.entity_id=${entityId}::uuid ${includeDeleted?sql``:sql`AND p.deleted_at IS NULL`} ${lock ? sql`FOR UPDATE OF p` : sql``}`)
  if (!p) throw new ProjectError('NO_PROJECT', 'That project is not in this company.')
  return p
}
export async function openProject(tx: Tx, entityId: string, id: string) {
  await openCompany(tx, entityId)
  const p = await projectHead(entityId,id,tx,true)
  if (p.status==='archived') throw new ProjectError('ARCHIVED', 'Restore this project before changing it.')
  return p
}
async function usableParty(tx: Tx, entityId: string, partyId: string) {
  projectId(partyId)
  const [p] = await tx.execute<{ id: string }>(sql`SELECT p.id FROM party p WHERE p.id=${partyId}::uuid AND p.is_active
    AND (EXISTS (SELECT 1 FROM party_role r WHERE r.party_id=p.id AND r.entity_id=${entityId}::uuid)
      OR EXISTS (SELECT 1 FROM crm_account c WHERE c.party_id=p.id AND c.entity_id=${entityId}::uuid)
      OR EXISTS (SELECT 1 FROM project x WHERE x.entity_id=${entityId}::uuid AND x.customer_party_id=p.id)
      OR EXISTS (SELECT 1 FROM project_record r WHERE r.entity_id=${entityId}::uuid AND r.party_id=p.id))`)
  if (!p) throw new ProjectError('BAD_PARTY', 'Choose an active Party already associated with this company.')
}
const audit = (tx: Tx, entityId: string, actor: string, table: string, id: string, action: string, after: unknown, before?: unknown, reason?: string) =>
  auditRow(tx,{actor, table, recordId:id, action, after:jsonSafe(after), before:jsonSafe(before), entityId, scope:'company', reason})
const jsonSafe = (value:unknown):unknown => value===undefined ? undefined : JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v))
const submissionHash = (value:unknown) => createHash('sha256').update(JSON.stringify(jsonSafe(value))).digest('hex')
export async function createProject(input: {
  entityId: string; currency: string; code: string; name: string; customerPartyId: string;
  site?: string; startDate?: string; endDate?: string; note?: string; actor: string;
}) {
  return actingAs(input.actor, async tx => {
    await openCompany(tx,input.entityId); await usableParty(tx,input.entityId,input.customerPartyId)
    const [p] = await tx.execute<{ id: string }>(sql`INSERT INTO project(entity_id,code,name,customer_party_id,currency,site,start_date,end_date,note,created_by)
      VALUES(${input.entityId}::uuid,${text(input.code,'Project code')},${text(input.name,'Project name')},${input.customerPartyId}::uuid,
        ${input.currency},${input.site?.trim()||null},${input.startDate ? projectDate(input.startDate) : null}::date,
        ${input.endDate ? projectDate(input.endDate) : null}::date,${input.note?.trim()||null},${input.actor}) RETURNING id::text`)
    await audit(tx,input.entityId,input.actor,'project',p.id,'create_project',{code:input.code,name:input.name})
    return p.id
  })
}
export async function updateProject(input: { entityId: string; projectId: string; version: number; actor: string; name: string; site?: string; note?: string; status: string }) {
  if (!['planned','active','completed','archived'].includes(input.status)) throw new ProjectError('STATUS','Choose a valid project status.')
  return actingAs(input.actor,async tx=>{
    await openCompany(tx,input.entityId)
    const before = await projectHead(input.entityId,input.projectId,tx,true)
    if (before.version!==input.version) throw new ProjectError('CONFLICT','This project changed. Refresh before editing it.')
    if (before.status==='archived' && input.status==='archived') throw new ProjectError('ARCHIVED','Restore the project before editing.')
    await tx.execute(sql`UPDATE project SET name=${text(input.name,'Project name')},site=${input.site?.trim()||null},note=${input.note?.trim()||null},
      status=${input.status},version=version+1,updated_at=now() WHERE id=${before.id}::uuid`)
    await audit(tx,input.entityId,input.actor,'project',before.id,'update_project',{name:input.name,status:input.status},before)
  })
}
export async function setProjectDeleted(input:{entityId:string;projectId:string;version:number;actor:string;deleted:boolean}) {
  return actingAs(input.actor,async tx=>{
    await openCompany(tx,input.entityId)
    const before=await projectHead(input.entityId,input.projectId,tx,true,true)
    if(before.version!==input.version)throw new ProjectError('CONFLICT','This project changed. Refresh before continuing.')
    if(!!before.deleted_at===input.deleted)throw new ProjectError('STATE',input.deleted?'This project is already deleted.':'This project is not deleted.')
    await tx.execute(sql`UPDATE project SET deleted_at=${input.deleted?sql`now()`:sql`NULL`},deleted_by=${input.deleted?input.actor:null},version=version+1,updated_at=now() WHERE id=${before.id}::uuid`)
    await audit(tx,input.entityId,input.actor,'project',before.id,input.deleted?'delete_project':'restore_project',{deleted:input.deleted},before)
  })
}
export type ProjectLine = { kind: ProjectCategory; description: string; base: bigint; gst: bigint; pst: bigint; gstRecoverable: bigint|null; pstRecoverable: bigint|null; taxCode?:TaxCode }
export type ProjectPaidInput={date:string;amount?:bigint;method?:string;reference?:string}
export async function saveProjectRecord(input: {
  entityId: string; projectId: string; recordId?: string; version?: number; kind: 'revenue'|'cost'; partyId: string|null;
  date: string; dueDate?: string; reference?: string; description: string; lines: ProjectLine[]; actor: string; key?: string; paid?:ProjectPaidInput
}, on: Runner = db) {
  projectDate(input.date); if(input.dueDate) projectDate(input.dueDate)
  if(!['revenue','cost'].includes(input.kind)) throw new ProjectError('KIND','Choose revenue or cost.')
  if(!input.lines.length || input.lines.length>200) throw new ProjectError('LINES','Add between 1 and 200 lines.')
  const description=input.description.trim()
  if(description.length>1000)throw new ProjectError('DESCRIPTION','Description can be up to 1,000 characters.')
  let gross=0n
  for(const l of input.lines) {
    if(l.taxCode!==undefined&&!TAX_CODES.some(t=>t.code===l.taxCode))throw new ProjectError('TAX','Choose a valid tax code.')
    if((l.kind==='revenue')!==(input.kind==='revenue') || !PROJECT_CATEGORIES.includes(l.kind)) throw new ProjectError('KIND','Choose a valid cost category.')
    if([l.base,l.gst,l.pst].some(v=>typeof v!=='bigint'||v<0n)) throw new ProjectError('AMOUNT','Amounts must be non-negative integer cents.')
    for(const [tax,recoverable] of [[l.gst,l.gstRecoverable],[l.pst,l.pstRecoverable]])
      if(recoverable!==null && (recoverable!<0n || recoverable!>tax!)) throw new ProjectError('TAX','Recoverable tax cannot exceed the tax on that line.')
    if(input.kind==='revenue') { l.gstRecoverable=null; l.pstRecoverable=null }
    else { if(l.gst===0n) l.gstRecoverable=0n; if(l.pst===0n) l.pstRecoverable=0n }
    gross+=l.base+l.gst+l.pst
  }
  if(gross<=0n) throw new ProjectError('AMOUNT','The record needs a positive total.')
  if(!input.partyId && input.lines.some(l=>l.kind!=='other'))throw new ProjectError('BAD_PARTY','Choose a Party. Only Other costs can omit one.')
  if(input.paid) {
    if(input.kind!=='cost'||input.recordId)throw new ProjectError('PAYMENT','Use Record payment for an existing record.')
    projectDate(input.paid.date)
    if((input.paid.amount??gross)<=0n||(input.paid.amount??gross)>gross)throw new ProjectError('OVERPAYMENT','Paid amount must be positive and cannot exceed the total cost.')
  }
  const payload:unknown[]=[input.projectId,input.kind,input.partyId,input.date,input.dueDate||null,input.reference?.trim()||null,description,input.lines.map(l=>[l.kind,l.description.trim(),l.base,l.gst,l.pst,l.gstRecoverable,l.pstRecoverable,...(l.taxCode!==undefined?[l.taxCode]:[])])]
  if(input.paid)payload.push([input.paid.date,input.paid.amount??gross,input.paid.method?.trim()||null,input.paid.reference?.trim()||null])
  const fingerprint=submissionHash(payload)
  return actingAs(input.actor,async tx=>{
    const p=await openProject(tx,input.entityId,input.projectId)
    if(input.kind==='revenue' && p.customer_party_id!==input.partyId) throw new ProjectError('CUSTOMER','Revenue must name this project’s customer.')
    let id=input.recordId
    let before: unknown
    if(id) {
      projectId(id)
      const [old]=await tx.execute<{version:number;state:string;party_id:string|null;kind:string}>(sql`SELECT * FROM project_record WHERE id=${id}::uuid AND entity_id=${input.entityId}::uuid AND project_id=${p.id}::uuid`)
      if(!old || old.state!=='active') throw new ProjectError('NO_RECORD','That active record is not in this project.')
      if(old.version!==input.version) throw new ProjectError('CONFLICT','This record changed. Refresh before editing it.')
      if(old.kind!==input.kind) throw new ProjectError('KIND','The record’s direction cannot change.')
      // Preserve historical identity when reviewing an existing cost. A new
      // record or a changed Party still requires an active company association.
      if(old.party_id!==input.partyId && input.partyId)await usableParty(tx,input.entityId,input.partyId)
      const [a]=await tx.execute<{amount:string;early:boolean}>(sql`SELECT COALESCE(sum(amount_cents),0)::text AS amount,
        COALESCE(bool_or(effective_date < ${input.date}::date),false) AS early FROM project_payment_allocation WHERE record_id=${id}::uuid AND state='active'`)
      if(BigInt(a.amount)>gross || a.early || (BigInt(a.amount)>0n && old.party_id!==input.partyId))
        throw new ProjectError('ALLOCATED','Remove affected payment allocations before changing this amount, date or Party.')
      before={...old,lines:Array.from(await tx.execute(sql`SELECT * FROM project_record_line WHERE record_id=${id}::uuid ORDER BY position`))}
      await tx.execute(sql`UPDATE project_record SET party_id=${input.partyId}::uuid,record_date=${input.date}::date,due_date=${input.dueDate||null}::date,
        reference=${input.reference?.trim()||null},description=${description},version=version+1,updated_at=now() WHERE id=${id}::uuid`)
      await tx.execute(sql`DELETE FROM project_record_line WHERE record_id=${id}::uuid`)
    } else {
      if(input.partyId)await usableParty(tx,input.entityId,input.partyId)
      if(input.key) {
        const [old]=await tx.execute<{id:string;submission_hash:string}>(sql`SELECT id::text,submission_hash FROM project_record WHERE entity_id=${input.entityId}::uuid AND idempotency_key=${text(input.key,'Submission key')}`)
        if(old) { if(old.submission_hash!==fingerprint) throw new ProjectError('REPLAY','That submission key was already used with different record details. Close and reopen the form.'); return old.id }
      }
      const [row]=await tx.execute<{id:string}>(sql`INSERT INTO project_record(entity_id,project_id,party_id,kind,record_date,due_date,reference,description,created_by,idempotency_key,submission_hash)
        VALUES(${input.entityId}::uuid,${p.id}::uuid,${input.partyId}::uuid,${input.kind},${input.date}::date,${input.dueDate||null}::date,
        ${input.reference?.trim()||null},${description},${input.actor},${input.key||null},${fingerprint}) RETURNING id::text`)
      id=row.id
    }
    for(const [i,l] of input.lines.entries()) await tx.execute(sql`INSERT INTO project_record_line(entity_id,project_id,record_id,position,kind,description,base_cents,gst_cents,pst_cents,gst_recoverable_cents,pst_recoverable_cents,tax_code)
      VALUES(${input.entityId}::uuid,${p.id}::uuid,${id}::uuid,${i+1},${l.kind},${l.description.trim()},${l.base},${l.gst},${l.pst},${l.gstRecoverable},${l.pstRecoverable},${l.taxCode||null})`)
    await audit(tx,input.entityId,input.actor,'project_record',id!,before?'edit_project_record':'create_project_record',
      {kind:input.kind,date:input.date,gross:gross.toString(),lines:input.lines.map(l=>Object.fromEntries(Object.entries(l).map(([k,v])=>[k,typeof v==='bigint'?v.toString():v])))},before)
    if(input.paid)await savePayment(tx,{entityId:input.entityId,projectId:p.id,partyId:input.partyId,direction:'paid',date:input.paid.date,amount:input.paid.amount??gross,
      method:input.paid.method,reference:input.paid.reference,actor:input.actor,key:`cost-paid:${id}`,recordId:id!},p)
    return id!
  }, on)
}
async function allocate(tx:Tx,input:{entityId:string;projectId:string;paymentId:string;recordId:string;amount:bigint;actor:string;key?:string}) {
  projectId(input.paymentId); projectId(input.recordId)
  if(input.amount<=0n) throw new ProjectError('AMOUNT','Allocate a positive amount.')
  const fingerprint=submissionHash([input.projectId,input.paymentId,input.recordId,input.amount])
  if(input.key) {
    const [old]=await tx.execute<{id:string;submission_hash:string}>(sql`SELECT id::text,submission_hash FROM project_payment_allocation WHERE entity_id=${input.entityId}::uuid AND idempotency_key=${text(input.key,'Submission key')}`)
    if(old) {if(old.submission_hash!==fingerprint)throw new ProjectError('REPLAY','That submission key was used for a different allocation.');return old.id}
  }
  const [pay]=await tx.execute<{party_id:string|null;direction:string;payment_date:string;remaining:string}>(sql`SELECT p.party_id::text,p.direction,p.payment_date::text,
    (p.amount_cents-COALESCE((SELECT sum(a.amount_cents) FROM project_payment_allocation a WHERE a.payment_id=p.id AND a.state='active'),0))::text AS remaining
    FROM project_payment p WHERE p.id=${input.paymentId}::uuid AND p.entity_id=${input.entityId}::uuid AND p.project_id=${input.projectId}::uuid AND p.state='active'`)
  const [rec]=await tx.execute<{party_id:string|null;kind:string;record_date:string;remaining:string}>(sql`SELECT r.party_id::text,r.kind,r.record_date::text,
    ((SELECT sum(l.base_cents+l.gst_cents+l.pst_cents) FROM project_record_line l WHERE l.record_id=r.id)-
    COALESCE((SELECT sum(a.amount_cents) FROM project_payment_allocation a WHERE a.record_id=r.id AND a.state='active'),0))::text AS remaining
    FROM project_record r WHERE r.id=${input.recordId}::uuid AND r.entity_id=${input.entityId}::uuid AND r.project_id=${input.projectId}::uuid AND r.state='active'`)
  if(!pay || !rec || pay.party_id!==rec.party_id || (pay.direction==='received')!==(rec.kind==='revenue')) throw new ProjectError('ALLOCATION','Choose an active record for the same project, Party and direction.')
  if(input.amount>BigInt(pay.remaining)||input.amount>BigInt(rec.remaining)) throw new ProjectError('OVERPAYMENT','The allocation exceeds the unallocated payment or record outstanding.')
  const [a]=await tx.execute<{id:string}>(sql`INSERT INTO project_payment_allocation(entity_id,project_id,party_id,payment_id,record_id,effective_date,amount_cents,created_by,idempotency_key,submission_hash)
    VALUES(${input.entityId}::uuid,${input.projectId}::uuid,${pay.party_id}::uuid,${input.paymentId}::uuid,${input.recordId}::uuid,
      ${pay.payment_date>rec.record_date?pay.payment_date:rec.record_date}::date,${input.amount},${input.actor},${input.key||null},${fingerprint}) RETURNING id::text`)
  await audit(tx,input.entityId,input.actor,'project_payment_allocation',a.id,'allocate_project_payment',{paymentId:input.paymentId,recordId:input.recordId,amount:input.amount.toString()})
  return a.id
}
type PaymentInput={entityId:string;projectId:string;partyId:string|null;direction:'received'|'paid';date:string;amount:bigint;method?:string;reference?:string;note?:string;actor:string;key:string;recordId?:string;allocation?:bigint}
async function savePayment(tx:Tx,input:PaymentInput,p:ProjectHead) {
  projectDate(input.date); if(input.amount<=0n) throw new ProjectError('AMOUNT','Enter a positive payment amount.')
  if(!['received','paid'].includes(input.direction)) throw new ProjectError('DIRECTION','Choose Received or Paid.')
  const fingerprint=submissionHash([input.projectId,input.partyId,input.direction,input.date,input.amount,input.method?.trim()||null,input.reference?.trim()||null,input.note?.trim()||null,input.recordId||null,input.recordId?(input.allocation??input.amount):null])
    if(input.partyId)await usableParty(tx,input.entityId,input.partyId)
    else if(!input.recordId||input.direction!=='paid')throw new ProjectError('BAD_PARTY','A payment without a Party must name an Other cost record.')
    if(input.direction==='received' && input.partyId!==p.customer_party_id) throw new ProjectError('CUSTOMER','Receipts must name the project customer.')
    const [old]=await tx.execute<{id:string;submission_hash:string}>(sql`SELECT id::text,submission_hash FROM project_payment WHERE entity_id=${input.entityId}::uuid AND idempotency_key=${text(input.key,'Submission key')}`)
    if(old) { if(old.submission_hash!==fingerprint) throw new ProjectError('REPLAY','That submission key was already used with different payment details.'); return old.id }
    const [pay]=await tx.execute<{id:string}>(sql`INSERT INTO project_payment(entity_id,project_id,party_id,direction,payment_date,amount_cents,method,reference,note,created_by,idempotency_key,submission_hash)
      VALUES(${input.entityId}::uuid,${p.id}::uuid,${input.partyId}::uuid,${input.direction},${input.date}::date,${input.amount},${input.method?.trim()||null},
        ${input.reference?.trim()||null},${input.note?.trim()||null},${input.actor},${input.key},${fingerprint}) RETURNING id::text`)
    if(input.recordId) await allocate(tx,{...input,key:undefined,paymentId:pay.id,recordId:input.recordId,amount:input.allocation??input.amount})
    await audit(tx,input.entityId,input.actor,'project_payment',pay.id,'create_project_payment',{direction:input.direction,date:input.date,amount:input.amount.toString()})
    return pay.id
}
export async function createProjectPayment(input:PaymentInput, on:Runner=db) {
  return actingAs(input.actor,async tx=>savePayment(tx,input,await openProject(tx,input.entityId,input.projectId)),on)
}
export async function allocateProjectPayment(input:{entityId:string;projectId:string;paymentId:string;recordId:string;amount:bigint;actor:string;key?:string},on:Runner=db) {
  return actingAs(input.actor,async tx=>{await openProject(tx,input.entityId,input.projectId); return allocate(tx,input)},on)
}
export async function voidProjectItem(input:{entityId:string;projectId:string;id:string;kind:'record'|'payment'|'allocation';version:number;reason:string;actor:string},on:Runner=db) {
  projectId(input.id); text(input.reason,'Reason')
  return actingAs(input.actor,async tx=>{
    await openProject(tx,input.entityId,input.projectId)
    const table={record:'project_record',payment:'project_payment',allocation:'project_payment_allocation'}[input.kind]
    if(!table) throw new ProjectError('KIND','Choose a record, payment or allocation.')
    const [old]=await tx.execute<{version:number;state:string}>(sql`SELECT * FROM ${sql.raw(table)} WHERE id=${input.id}::uuid AND entity_id=${input.entityId}::uuid AND project_id=${input.projectId}::uuid`)
    if(!old || old.state!=='active') throw new ProjectError('NO_RECORD','That active item is not in this project.')
    if(old.version!==input.version) throw new ProjectError('CONFLICT','This item changed. Refresh before cancelling it.')
    if(input.kind!=='allocation') await tx.execute(sql`UPDATE project_payment_allocation SET state='void',version=version+1
      WHERE ${input.kind==='record'?sql`record_id`:sql`payment_id`}=${input.id}::uuid AND state='active'`)
    await tx.execute(sql`UPDATE ${sql.raw(table)} SET state='void',version=version+1 WHERE id=${input.id}::uuid`)
    await audit(tx,input.entityId,input.actor,table,input.id,'void_project_'+input.kind,{state:'void'},old,input.reason)
  },on)
}

export type ProjectFilters = { q?:string; from?:string; to?:string; customer?:string; supplier?:string; status?:string; kind?:string; settlement?:string; tax?:string; deleted?:string }
export function projectFilters(input:ProjectFilters):ProjectFilters {
  const f={...input,q:input.q?.trim().slice(0,200)||undefined}
  if(f.from) projectDate(f.from); if(f.to) projectDate(f.to)
  if(f.from && f.to && f.from>f.to) throw new ProjectError('DATE_RANGE','From must be on or before Through.')
  if(f.customer) projectId(f.customer); if(f.supplier) projectId(f.supplier)
  if(f.status && !['planned','active','completed','archived'].includes(f.status)) throw new ProjectError('STATUS','Unknown project status.')
  if(f.kind && !(PROJECT_CATEGORIES as readonly string[]).includes(f.kind)) throw new ProjectError('KIND','Unknown cost category.')
  if(f.deleted && f.deleted!=='yes')throw new ProjectError('STATUS','Unknown project view.')
  if(f.settlement && !['unpaid','partial','paid'].includes(f.settlement)) throw new ProjectError('STATUS','Unknown payment status.')
  if(f.tax && !['pending','confirmed'].includes(f.tax)) throw new ProjectError('TAX','Unknown tax review status.')
  return f
}
export type ProjectSummary = ProjectHead & { revenue:string; material:string; labor:string; subcontractor:string; janitorial:string; delivery:string; other:string; input_gst:string; input_pst:string; output_gst:string; output_pst:string; nonrecoverable:string; pending_tax:string; received:string; paid:string; receivable:string; payable:string; customer_advance:string; supplier_advance:string }
export type ProjectRecordRow = { id:string; project_id:string; kind:string; party_id:string|null; party:string; record_date:string; due_date:string|null; reference:string|null; description:string; version:number; base:string; gst:string; pst:string; gross:string; settled:string; outstanding:string; pending_tax:string; lines:Array<{kind:ProjectLine['kind'];description:string;base:string;gst:string;pst:string;gstRecoverable:string|null;pstRecoverable:string|null;taxCode?:TaxCode|null}> }
export type ProjectPaymentEdit = {
  amount:string; note:string|null; bankAccountId:string|null; controlAccountId:string|null;
  source:string|null; signature:string; allocations:Array<{target:string;label:string;amount:string}>
}
export type ProjectPaymentRow = { id:string;project_id:string;party_id:string|null;party:string;direction:'received'|'paid';payment_date:string;amount:string;allocated:string;unallocated:string;version:number;reference:string|null;method:string|null;accounting_entry_id?:string|null;accounting_ledger_id?:string|null;accounting_entry_no?:string|null;edit?:ProjectPaymentEdit }
export type ProjectAllocationRow = {id:string;project_id:string;payment_id:string;record_id:string;effective_date:string;amount:string;party:string;description:string;version:number}
export async function projectAllocations(entityId:string,id?:string):Promise<ProjectAllocationRow[]> {
  projectId(entityId);if(id)projectId(id)
  return Array.from(await db.execute<ProjectAllocationRow>(sql`SELECT a.id::text,a.project_id::text,a.payment_id::text,a.record_id::text,a.effective_date::text,a.amount_cents::text AS amount,a.version,COALESCE(p.name,'—') AS party,r.description
    FROM project_payment_allocation a LEFT JOIN party p ON p.id=a.party_id JOIN project_record r ON r.id=a.record_id JOIN project x ON x.id=a.project_id
    WHERE a.entity_id=${entityId}::uuid AND x.deleted_at IS NULL ${id?sql`AND a.project_id=${id}::uuid`:sql``} AND a.state='active' ORDER BY a.effective_date DESC,a.id`))
}
export async function projectParties(entityId:string) {
  const rows=await db.execute<{id:string;name:string;roles:string}>(sql`SELECT p.id::text,p.name,
    COALESCE((SELECT string_agg(DISTINCT role,', ') FROM party_role WHERE party_id=p.id AND entity_id=${entityId}::uuid),'Project') AS roles
    FROM party p WHERE p.is_active AND (EXISTS (SELECT 1 FROM party_role r WHERE r.party_id=p.id AND r.entity_id=${entityId}::uuid)
      OR EXISTS(SELECT 1 FROM crm_account c WHERE c.party_id=p.id AND c.entity_id=${entityId}::uuid)
      OR EXISTS(SELECT 1 FROM project x WHERE x.entity_id=${entityId}::uuid AND x.customer_party_id=p.id)
      OR EXISTS(SELECT 1 FROM project_record r WHERE r.entity_id=${entityId}::uuid AND r.party_id=p.id)) ORDER BY p.name`)
  return Array.from(rows)
}
function projectWhere(entityId:string,f:ProjectFilters,id?:string):SQL {
  return sql`p.entity_id=${entityId}::uuid ${id?sql`AND p.id=${projectId(id)}::uuid`:sql``}
    AND p.deleted_at IS ${f.deleted==='yes'?sql`NOT NULL`:sql`NULL`}
    ${f.q?sql`AND (p.code ILIKE ${'%'+f.q+'%'} OR p.name ILIKE ${'%'+f.q+'%'})`:sql``}
    ${f.customer?sql`AND p.customer_party_id=${f.customer}::uuid`:sql``}
    ${f.status?sql`AND p.status=${f.status}`:sql``}
    ${f.supplier?sql`AND EXISTS (SELECT 1 FROM project_record r WHERE r.project_id=p.id AND r.kind='cost' AND r.party_id=${f.supplier}::uuid AND r.state='active')`:sql``}`
}
export async function projectSummaries(entityId:string,asked:ProjectFilters={},id?:string):Promise<ProjectSummary[]> {
  const f=projectFilters(asked), cutoff=f.to||'9999-12-31', from=f.from||'0001-01-01'
  const rows=await db.execute<ProjectSummary>(sql`
    WITH allocations AS (
      SELECT a.record_id,a.payment_id,sum(a.amount_cents) AS amount FROM project_payment_allocation a
      JOIN project_payment pay ON pay.id=a.payment_id JOIN project_record r ON r.id=a.record_id
      WHERE a.entity_id=${entityId}::uuid AND a.state='active' AND pay.state='active' AND r.state='active'
        AND a.effective_date<=${cutoff}::date AND pay.payment_date<=${cutoff}::date AND r.record_date<=${cutoff}::date GROUP BY a.record_id,a.payment_id
    ), records AS (
      SELECT r.id,r.project_id,r.kind,r.record_date,
        sum(l.base_cents) AS base,sum(l.gst_cents) AS gst,sum(l.pst_cents) AS pst,
        COALESCE(sum(l.base_cents) FILTER(WHERE l.kind='material'),0) AS material,
        COALESCE(sum(l.base_cents) FILTER(WHERE l.kind='labor'),0) AS labor,
        COALESCE(sum(l.base_cents) FILTER(WHERE l.kind='subcontractor'),0) AS subcontractor,
        COALESCE(sum(l.base_cents) FILTER(WHERE l.kind='janitorial'),0) AS janitorial,
        COALESCE(sum(l.base_cents) FILTER(WHERE l.kind='delivery'),0) AS delivery,
        COALESCE(sum(l.base_cents) FILTER(WHERE l.kind='other'),0) AS other,
        sum(CASE WHEN r.kind='cost' THEN (CASE WHEN l.gst_recoverable_cents IS NULL THEN 0 ELSE l.gst_cents-l.gst_recoverable_cents END)+(CASE WHEN l.pst_recoverable_cents IS NULL THEN 0 ELSE l.pst_cents-l.pst_recoverable_cents END) ELSE 0 END) AS nonrecoverable,
        sum(CASE WHEN r.kind='cost' THEN (CASE WHEN l.gst_recoverable_cents IS NULL THEN l.gst_cents ELSE 0 END)+(CASE WHEN l.pst_recoverable_cents IS NULL THEN l.pst_cents ELSE 0 END) ELSE 0 END) AS pending_tax,
        COALESCE((SELECT sum(a.amount) FROM allocations a WHERE a.record_id=r.id),0) AS settled
      FROM project_record r JOIN project_record_line l ON l.record_id=r.id WHERE r.entity_id=${entityId}::uuid AND r.state='active' AND r.record_date<=${cutoff}::date
      GROUP BY r.id
    ) SELECT p.*,p.id::text,p.entity_id::text,p.customer_party_id::text,p.start_date::text,p.end_date::text,c.name AS customer,
      COALESCE(x.revenue,0)::text AS revenue,COALESCE(x.material,0)::text AS material,COALESCE(x.labor,0)::text AS labor,
      COALESCE(x.subcontractor,0)::text AS subcontractor,
      COALESCE(x.janitorial,0)::text AS janitorial,COALESCE(x.delivery,0)::text AS delivery,COALESCE(x.other,0)::text AS other,
      COALESCE(x.input_gst,0)::text AS input_gst,COALESCE(x.input_pst,0)::text AS input_pst,COALESCE(x.output_gst,0)::text AS output_gst,COALESCE(x.output_pst,0)::text AS output_pst,
      COALESCE(x.nonrecoverable,0)::text AS nonrecoverable,COALESCE(x.pending_tax,0)::text AS pending_tax,
      COALESCE(y.received,0)::text AS received,COALESCE(y.paid,0)::text AS paid,
      COALESCE(x.receivable,0)::text AS receivable,COALESCE(x.payable,0)::text AS payable,
      COALESCE(y.customer_advance,0)::text AS customer_advance,COALESCE(y.supplier_advance,0)::text AS supplier_advance
    FROM project p JOIN party c ON c.id=p.customer_party_id
    LEFT JOIN LATERAL (SELECT
      sum(base) FILTER(WHERE kind='revenue' AND record_date>=${from}::date) AS revenue,
      sum(material) FILTER(WHERE record_date>=${from}::date) AS material,sum(labor) FILTER(WHERE record_date>=${from}::date) AS labor,
      sum(subcontractor) FILTER(WHERE record_date>=${from}::date) AS subcontractor,
      sum(janitorial) FILTER(WHERE record_date>=${from}::date) AS janitorial,sum(delivery) FILTER(WHERE record_date>=${from}::date) AS delivery,sum(other) FILTER(WHERE record_date>=${from}::date) AS other,
      sum(gst) FILTER(WHERE kind='cost' AND record_date>=${from}::date) AS input_gst,sum(pst) FILTER(WHERE kind='cost' AND record_date>=${from}::date) AS input_pst,
      sum(gst) FILTER(WHERE kind='revenue' AND record_date>=${from}::date) AS output_gst,sum(pst) FILTER(WHERE kind='revenue' AND record_date>=${from}::date) AS output_pst,
      sum(nonrecoverable) FILTER(WHERE record_date>=${from}::date) AS nonrecoverable,sum(pending_tax) FILTER(WHERE record_date>=${from}::date) AS pending_tax,
      sum(base+gst+pst-settled) FILTER(WHERE kind='revenue') AS receivable,sum(base+gst+pst-settled) FILTER(WHERE kind='cost') AS payable
      FROM records WHERE project_id=p.id) x ON true
    LEFT JOIN LATERAL (SELECT
      sum(pay.amount_cents) FILTER(WHERE pay.direction='received' AND pay.payment_date>=${from}::date) AS received,
      sum(pay.amount_cents) FILTER(WHERE pay.direction='paid' AND pay.payment_date>=${from}::date) AS paid,
      sum(pay.amount_cents-COALESCE((SELECT sum(a.amount) FROM allocations a WHERE a.payment_id=pay.id),0)) FILTER(WHERE pay.direction='received') AS customer_advance,
      sum(pay.amount_cents-COALESCE((SELECT sum(a.amount) FROM allocations a WHERE a.payment_id=pay.id),0)) FILTER(WHERE pay.direction='paid') AS supplier_advance
      FROM project_payment pay WHERE pay.project_id=p.id AND pay.state='active' AND pay.payment_date<=${cutoff}::date) y ON true
    WHERE ${projectWhere(entityId,f,id)} ORDER BY p.code`)
  return Array.from(rows)
}
export async function projectRecords(entityId:string,asked:ProjectFilters={},id?:string):Promise<ProjectRecordRow[]> {
  const f=projectFilters(asked), cutoff=f.to||'9999-12-31'
  const rows=await db.execute<ProjectRecordRow>(sql`WITH data AS (
    SELECT r.id::text,r.project_id::text,r.kind,r.party_id::text,COALESCE(party.name,'—') AS party,r.record_date::text,r.due_date::text,r.reference,r.description,r.version,
      sum(l.base_cents)::text AS base,sum(l.gst_cents)::text AS gst,sum(l.pst_cents)::text AS pst,
      sum(l.base_cents+l.gst_cents+l.pst_cents)::text AS gross,
      COALESCE((SELECT sum(a.amount_cents) FROM project_payment_allocation a JOIN project_payment pay ON pay.id=a.payment_id
        WHERE a.record_id=r.id AND a.state='active' AND pay.state='active' AND a.effective_date<=${cutoff}::date AND pay.payment_date<=${cutoff}::date),0)::text AS settled,
      sum(CASE WHEN r.kind='cost' THEN (CASE WHEN l.gst_recoverable_cents IS NULL THEN l.gst_cents ELSE 0 END)+(CASE WHEN l.pst_recoverable_cents IS NULL THEN l.pst_cents ELSE 0 END) ELSE 0 END)::text AS pending_tax,
      jsonb_agg(jsonb_build_object('kind',l.kind,'description',l.description,'base',l.base_cents::text,'gst',l.gst_cents::text,'pst',l.pst_cents::text,
        'gstRecoverable',l.gst_recoverable_cents::text,'pstRecoverable',l.pst_recoverable_cents::text,'taxCode',l.tax_code) ORDER BY l.position) AS lines
    FROM project_record r JOIN project p ON p.id=r.project_id LEFT JOIN party ON party.id=r.party_id JOIN project_record_line l ON l.record_id=r.id
    WHERE ${projectWhere(entityId,f,id)} AND r.state='active' AND r.record_date<=${cutoff}::date
      ${f.from?sql`AND r.record_date>=${f.from}::date`:sql``}
      ${f.supplier?sql`AND r.kind='cost' AND r.party_id=${f.supplier}::uuid`:sql``}
      ${f.kind==='revenue'?sql`AND r.kind='revenue'`:f.kind?sql`AND EXISTS(SELECT 1 FROM project_record_line k WHERE k.record_id=r.id AND k.kind=${f.kind})`:sql``}
    GROUP BY r.id,party.name
  ) SELECT *, (gross::numeric-settled::numeric)::text AS outstanding FROM data
    WHERE true ${f.settlement==='unpaid'?sql`AND settled::numeric=0`:f.settlement==='partial'?sql`AND settled::numeric>0 AND settled::numeric<gross::numeric`:f.settlement==='paid'?sql`AND settled::numeric=gross::numeric`:sql``}
      ${f.tax==='pending'?sql`AND pending_tax::numeric>0`:f.tax==='confirmed'?sql`AND pending_tax::numeric=0`:sql``}
    ORDER BY record_date DESC,id`)
  return Array.from(rows)
}
export async function projectPayments(entityId:string,asked:ProjectFilters={},id?:string):Promise<ProjectPaymentRow[]> {
  const f=projectFilters(asked), cutoff=f.to||'9999-12-31'
  const rows=await db.execute<ProjectPaymentRow>(sql`SELECT pay.id::text,pay.project_id::text,pay.party_id::text,COALESCE(party.name,'—') AS party,pay.direction,pay.payment_date::text,
    pay.amount_cents::text AS amount,pay.version,pay.reference,pay.method,COALESCE(a.amount,0)::text AS allocated,(pay.amount_cents-COALESCE(a.amount,0))::text AS unallocated,
    (SELECT entry_id::text FROM project_accounting_payment WHERE payment_id=pay.id) AS accounting_entry_id,
    (SELECT j.ledger_id::text FROM project_accounting_payment h JOIN journal_entry j ON j.id=h.entry_id WHERE h.payment_id=pay.id) AS accounting_ledger_id,
    (SELECT j.entry_no FROM project_accounting_payment h JOIN journal_entry j ON j.id=h.entry_id WHERE h.payment_id=pay.id) AS accounting_entry_no
    FROM project_payment pay JOIN project p ON p.id=pay.project_id LEFT JOIN party ON party.id=pay.party_id
    LEFT JOIN LATERAL(SELECT sum(x.amount_cents) AS amount FROM project_payment_allocation x JOIN project_record r ON r.id=x.record_id
      WHERE x.payment_id=pay.id AND x.state='active' AND r.state='active' AND x.effective_date<=${cutoff}::date) a ON true
    WHERE ${projectWhere(entityId,f,id)} AND pay.state='active' AND pay.payment_date<=${cutoff}::date
      ${f.from?sql`AND pay.payment_date>=${f.from}::date`:sql``} ${f.supplier?sql`AND pay.party_id=${f.supplier}::uuid`:sql``}
    ORDER BY pay.payment_date DESC,pay.id`)
  return Array.from(rows)
}
export function projectProfit(p:Pick<ProjectSummary,'revenue'|'material'|'labor'|'subcontractor'|'janitorial'|'delivery'|'other'|'nonrecoverable'|'pending_tax'|'received'|'paid'>) {
  const cost=BigInt(p.material)+BigInt(p.labor)+BigInt(p.subcontractor)+BigInt(p.janitorial)+BigInt(p.delivery)+BigInt(p.other),before=BigInt(p.revenue)-cost
  return {cost,before, adjusted:BigInt(p.pending_tax)>0n?null:before-BigInt(p.nonrecoverable), cash:BigInt(p.received)-BigInt(p.paid)}
}
export function projectCostTotals(records:ProjectRecordRow[]) {
  const totals={material:0n,labor:0n,subcontractor:0n,janitorial:0n,delivery:0n,other:0n,gst:0n,pst:0n,gross:0n,recoverGST:0n,recoverPST:0n,nonrecoverGST:0n,nonrecoverPST:0n,pendingGST:0n,pendingPST:0n}
  for(const r of records)if(r.kind==='cost') {
    const t=projectLineAmounts(r.lines,true)
    for(const k of PROJECT_AMOUNT_KEYS)if(k!=='base')totals[k]+=t[k]
    for(const line of r.lines)if(line.kind!=='revenue')totals[line.kind]+=BigInt(line.base)
  }
  return totals
}
export function projectSentence(error:unknown) {
  if(error instanceof ProjectError) return error.message
  if(error instanceof Error && ['InvoiceError','PaymentError','PostingError','InvoiceTemplateError','ProjectAccountsError','ProjectTaxAccountsError'].includes(error.name)) return error.message
  const chain:unknown[]=[error]; let current=error as {cause?:unknown}
  while(current?.cause && chain.length<5) {chain.push(current.cause);current=current.cause as {cause?:unknown}}
  const message=chain.map(e=>String(e)).join(' ')
  if(message.includes('PROJECT_ACCOUNTING_OWNER'))return 'Edit or cancel this linked transaction from its Project.'
  if(message.includes('PROJECT_PAYMENT_SOURCE'))return 'Use a Payment to settle a Project invoice or bill.'
  if(message.includes('unique')) return 'That project code or submission already exists. Use a different code or refresh.'
  if(message.includes('PROJECT_')) return 'That change conflicts with the project’s state, dates or payment allocations. Refresh and review the affected records.'
  if(message.includes('check constraint')) return 'Check the dates, amounts and tax recovery values.'
  return 'The project could not be saved. Your inputs are still here; check the record and try again.'
}

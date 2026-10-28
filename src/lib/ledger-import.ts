import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Tx } from './acting'
import { companyById } from './companies'
import { planningScope,planningAudit,type PlanningActor,type PlanningScope } from './planning-access'
import { withDocumentWrite } from './edit-leases'
import type { EditContext } from './edit-proof'
import { parseImportCsv,importDate,fail } from './import-csv'
import type { ImportMode,ImportFormat,ImportFileKind,ImportData,ImportItem,ImportGl,ImportApplication,ImportBankItem,ImportIssue,ImportCoverage } from './import-types'
import { writeBlobBytes,readBlobBytes } from './attachments'
import { postOpeningBalance } from './opening'
import { createOpeningDocument } from './opening-documents'
import { openItemsQuery,applyEntryToInvoice } from './payments'
import { postEntryCore } from './posting'
import { createInvoice,postInvoice } from './invoices'
import { addDays } from './recurrence-calendar'

export type ImportRun={id:string;entity_id:string;ledger_id:string;mode:ImportMode;source_system:string;source_company:string;currency:string;from_date:string;cutoff_date:string;clearing_account_id:string;status:string;version:string;validated_digest:string|null;validation:Record<string,unknown>;reconciliation:unknown;last_error:string|null}
type FileRow={id:string;kind:ImportFileKind;sha256:string;filename:string;format:ImportFormat;headers:string[];excluded_rows:unknown[];row_count:number}
type StageRow={file_id:string;kind:ImportFileKind;source_line:number;data:ImportData}
type MappedAccount={source_account:string;target_account_id:string;account_type:string;roles:string[];code:string}
type MappedParty={source_party:string;target_party_id:string}
type Task={key:string;rows:Array<{fileId:string;line:number}>;item?:ImportItem;bankItem?:ImportBankItem;opening?:Array<{accountId:string;amount:string}>;gl?:ImportGl[];application?:ImportApplication}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_k,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value)).digest('hex')
const taskDigest=(d:Loaded,t:Task)=>hash({key:t.key,sourceSystem:d.run.source_system,sourceCompany:d.run.source_company,rows:t.rows.map(r=>({sha:d.files.find(f=>f.id===r.fileId)?.sha256,line:r.line,data:d.stages.find(s=>s.file_id===r.fileId&&s.source_line===r.line)?.data}))})
const runSql=(id:string,ledgerId:string)=>sql`SELECT id::text,entity_id::text,ledger_id::text,mode,source_system,source_company,currency,from_date::text,cutoff_date::text,clearing_account_id::text,status,version::text,validated_digest,validation,reconciliation,last_error FROM migration_run WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid`
async function load(tx:Tx,ledgerId:string,id:string) {
 const [run]=await tx.execute<ImportRun>(runSql(id,ledgerId));if(!run)fail('RUN','This migration is unavailable in these books.')
 const files:FileRow[]=await tx.execute<FileRow>(sql`SELECT id::text,kind,sha256,filename,format,headers,excluded_rows,row_count FROM migration_file WHERE run_id=${id}::uuid ORDER BY kind`)
 const stages:StageRow[]=await tx.execute<StageRow>(sql`SELECT f.id::text AS file_id,f.kind,s.source_line,s.data FROM migration_file f JOIN migration_stage s ON s.file_id=f.id WHERE f.run_id=${id}::uuid ORDER BY f.kind,s.source_line`)
 const accounts=await tx.execute<MappedAccount>(sql`SELECT m.source_account,m.target_account_id::text,a.account_type::text,a.code,ARRAY(SELECT ar.role FROM account_role ar WHERE ar.account_id=a.id ORDER BY ar.role) AS roles FROM migration_account_map m JOIN account a ON a.id=m.target_account_id WHERE m.run_id=${id}::uuid ORDER BY m.source_account`)
 const parties=await tx.execute<MappedParty>(sql`SELECT source_party,target_party_id::text FROM migration_party_map WHERE run_id=${id}::uuid ORDER BY source_party`)
 return {run,files,stages,accounts,parties,digest:hash({identity:{ledgerId,mode:run.mode,sourceSystem:run.source_system,sourceCompany:run.source_company,currency:run.currency,from:run.from_date,cutoff:run.cutoff_date,clearing:run.clearing_account_id},files,stages,accounts,parties})}
}
type Loaded=Awaited<ReturnType<typeof load>>
async function verifySources(d:Loaded,companyName:string) {
 for(const f of d.files) {
  const bytes=await readBlobBytes(companyName,f.sha256)
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==f.sha256)fail('SOURCE_MISSING',`Source ${f.filename} is missing or differs from its digest; no batch was committed.`)
  const parsed=parseImportCsv(new TextDecoder('utf-8',{fatal:true}).decode(bytes),f.kind,f.format),actual=d.stages.filter(s=>s.file_id===f.id).map(s=>({sourceLine:s.source_line,data:s.data}))
  if(hash(parsed.stages)!==hash(actual)||hash(parsed.headers)!==hash(f.headers)||hash(parsed.excluded)!==hash(f.excluded_rows)||actual.length!==f.row_count)fail('SOURCE_STAGE_CHANGED',`Source ${f.filename} and its staged rows differ.`)
 }
}
const rowsFor=(d:Loaded,kind:ImportFileKind)=>d.stages.filter(s=>s.kind===kind)
function duplicateFilePurposes(files:FileRow[]) {
 const snapshotPairs=[['starting_trial_balance','trial_balance'],['starting_open_items','open_items']]
 return files.some((f,i)=>files.slice(i+1).some(other=>other.sha256===f.sha256&&!snapshotPairs.some(pair=>pair.includes(f.kind)&&pair.includes(other.kind))))
}
const location=(s:StageRow)=>({fileId:s.file_id,line:s.source_line})
const itemMovement=(i:ImportItem)=>BigInt(i.amount)*(i.direction==='sales'?1n:-1n)*(i.kind==='invoice'?1n:-1n)
function totalBalances(d:Loaded,kind:ImportFileKind) {
 const target=new Map<string,bigint>()
 for(const s of rowsFor(d,kind))if(s.data.type==='balance'){
  const data=s.data,a=d.accounts.find(a=>a.source_account===data.sourceAccount);if(a)target.set(a.target_account_id,(target.get(a.target_account_id)??0n)+BigInt(data.amount))
 }
 return target
}
async function openingPlan(tx:Tx,d:Loaded) {
 const issues:ImportIssue[]=[],tasks:Task[]=[]
 const issue=(code:string,message:string,row?:StageRow)=>issues.push({level:'error',code,message,...(row?{fileId:row.file_id,sourceLines:[row.source_line]}:{})})
 const required:ImportFileKind[]=['accounts','trial_balance','open_items']
 for(const k of required)if(!d.files.some(f=>f.kind===k))issue('MISSING_FILE',`Upload ${k}; a header-only open_items file explicitly confirms no outstanding items.`)
 for(const f of d.files)if(![...required,'bank_open_items'].includes(f.kind))issue('MODE_FILE',`${f.kind} does not belong to opening mode.`)
 if(duplicateFilePurposes(d.files))issue('DUPLICATE_FILE','A source file was uploaded under unrelated purposes. Equal starting/cutoff snapshots are allowed; they are not both posted.')
 const sourceAccounts=new Map<string,StageRow>()
 for(const s of rowsFor(d,'accounts'))if(s.data.type==='account') {
  if(sourceAccounts.has(s.data.sourceAccount))issue('DUPLICATE_ACCOUNT','The source chart repeats an account.',s)
  sourceAccounts.set(s.data.sourceAccount,s)
  const data=s.data,a=d.accounts.find(a=>a.source_account===data.sourceAccount)
  if(!a)issue('ACCOUNT_MAPPING',`Map source account ${s.data.sourceAccount}.`,s)
  else if(a.account_type!==s.data.accountType)issue('ACCOUNT_TYPE','Source and target account types differ.',s)
 }
 for(const s of d.stages)if('sourceAccount' in s.data&&!sourceAccounts.has(s.data.sourceAccount))issue('UNKNOWN_ACCOUNT',`Source account ${s.data.sourceAccount} is absent from the chart.`,s)
 const seenBalance=new Set<string>()
 for(const s of rowsFor(d,'trial_balance'))if(s.data.type==='balance') {
  if(seenBalance.has(s.data.sourceAccount))issue('DUPLICATE_BALANCE','The trial balance repeats a source account.',s)
  seenBalance.add(s.data.sourceAccount)
 }
 const target=totalBalances(d,'trial_balance')
 if([...target.values()].reduce((a,b)=>a+b,0n)!==0n)issue('TB_UNBALANCED','The source trial balance does not balance; correct the source, without an automatic difference account.')
 if((target.get(d.run.clearing_account_id)??0n)!==0n)issue('CLEARING_TARGET','Conversion clearing must have a zero source closing balance.')
 const contribution=new Map<string,bigint>(),ids=new Set<string>()
 const add=(id:string,n:bigint)=>contribution.set(id,(contribution.get(id)??0n)+n)
 for(const s of rowsFor(d,'open_items'))if(s.data.type==='item') {
  const i=s.data,a=d.accounts.find(a=>a.source_account===i.sourceAccount),p=d.parties.find(p=>p.source_party===i.sourceParty)
  if(ids.has(i.sourceId))issue('DUPLICATE_SOURCE','The outstanding-item file repeats a source ID.',s);ids.add(i.sourceId)
  if(i.currency!==d.run.currency)issue('CURRENCY','The source item currency differs from the target ledger.',s)
  if(i.issuedOn>d.run.cutoff_date)issue('ITEM_DATE','An opening item was issued after the conversion snapshot.',s)
  if(!a||!a.roles.includes(i.direction==='sales'?'trade_receivables':'trade_payables'))issue('CONTROL_ACCOUNT','Map the item to the current receivables/payables control role.',s)
  if(!p)issue('PARTY_MAPPING',`Map source party ${i.sourceParty}.`,s)
  else if(!(await tx.execute(sql`SELECT 1 FROM party_role WHERE party_id=${p.target_party_id}::uuid AND entity_id=${d.run.entity_id}::uuid AND role=${i.direction==='sales'?'customer':'supplier'} AND COALESCE(held_to,'infinity'::date)>=${d.run.cutoff_date}::date`)).length)issue('PARTY_DATE','The target party must hold the required role from original issue through conversion.',s)
  if(a){add(a.target_account_id,itemMovement(i));add(d.run.clearing_account_id,-itemMovement(i))}
  tasks.push({key:'source:'+i.sourceId,rows:[location(s)],item:i})
 }
 for(const a of d.accounts)if(a.roles.some(r=>['trade_receivables','trade_payables'].includes(r))&&(target.get(a.target_account_id)??0n)!==(contribution.get(a.target_account_id)??0n))issue('CONTROL_RECONCILIATION',`Source TB and outstanding details disagree for ${a.code}.`)
 for(const s of rowsFor(d,'bank_open_items'))if(s.data.type==='bank_item') {
  const i=s.data,a=d.accounts.find(a=>a.source_account===i.sourceAccount)
  if(ids.has(i.sourceId))issue('DUPLICATE_SOURCE','Bank and AR/AP opening details must use distinct reliable source IDs.',s);ids.add(i.sourceId)
  if(i.currency!==d.run.currency)issue('CURRENCY','Outstanding bank currency differs from the ledger.',s)
  if(i.date>d.run.cutoff_date)issue('BANK_DATE','An outstanding book transaction must precede the starting snapshot.',s)
  if(!a?.roles.includes('cash_and_cash_equivalents'))issue('BANK_ACCOUNT','Map outstanding book transactions to a current cash/bank account.',s)
  if(a){add(a.target_account_id,BigInt(i.amount));add(d.run.clearing_account_id,-BigInt(i.amount))}
  tasks.push({key:'source:'+i.sourceId,rows:[location(s)],bankItem:i})
 }
 const opening=[...new Set([...target.keys(),...contribution.keys()])].sort().map(accountId=>({accountId,amount:String((target.get(accountId)??0n)-(contribution.get(accountId)??0n))})).filter(l=>l.amount!=='0')
 if(opening.length)tasks.unshift({key:'@opening',rows:[...rowsFor(d,'trial_balance'),...rowsFor(d,'open_items'),...rowsFor(d,'bank_open_items')].map(location),opening})
 const [period]=await tx.execute(sql`SELECT 1 FROM fiscal_period fp JOIN fiscal_year fy ON fy.id=fp.fiscal_year_id WHERE fp.ledger_id=${d.run.ledger_id}::uuid AND ${d.run.cutoff_date}::date BETWEEN fp.start_date AND fp.end_date AND fp.status='open' AND fy.status='open'`)
 if(!period)issue('PERIOD','Prepare an open fiscal year and period containing the conversion snapshot before starting migration.')
 const coverage:ImportCoverage={gl:'not_provided',parties:'partial',openItems:'complete',taxDetails:'not_provided',bankReconciliation:d.files.some(f=>f.kind==='bank_open_items')?'partial':'not_provided',inventoryAssets:'not_provided',attachments:'not_provided'}
 const warnings:ImportIssue[]=[{level:'warning',code:'OPENING_COVERAGE',message:'Opening balances do not reconstruct earlier monthly profit, original invoice face totals, tax detail, bank reconciliation, inventory/assets or source attachments.'}]
 return {issues:[...issues,...warnings],tasks,target,coverage,digest:d.digest}
}
async function historyPlan(tx:Tx,d:Loaded) {
 const asOf=addDays(d.run.from_date,-1),rename=(k:ImportFileKind):ImportFileKind=>k==='starting_trial_balance'?'trial_balance':k==='starting_open_items'?'open_items':k==='starting_bank_open_items'?'bank_open_items':k
 const base:Loaded={...d,run:{...d.run,mode:'opening',cutoff_date:asOf},files:d.files.filter(f=>['accounts','starting_trial_balance','starting_open_items','starting_bank_open_items'].includes(f.kind)).map(f=>({...f,kind:rename(f.kind)})),stages:d.stages.filter(s=>['accounts','starting_trial_balance','starting_open_items','starting_bank_open_items'].includes(s.kind)).map(s=>({...s,kind:rename(s.kind)}))}
 const start=await openingPlan(tx,base),issues=start.issues.filter(i=>i.level==='error'),tasks=[...start.tasks]
 const issue=(code:string,message:string,row?:StageRow)=>issues.push({level:'error',code,message,...(row?{fileId:row.file_id,sourceLines:[row.source_line]}:{})})
 for(const f of d.files)if(f.kind==='bank_open_items')issue('MODE_FILE','History uses starting_bank_open_items; cutoff bank movements must already be in the historical GL.')
 for(const kind of ['general_ledger','applications','trial_balance','open_items'])if(!d.files.some(f=>f.kind===kind))issue('MISSING_FILE',`History requires ${kind}; use explicit header-only files for empty applications/open items.`)
 if(duplicateFilePurposes(d.files))issue('DUPLICATE_FILE','A source file was uploaded under unrelated purposes. Equal starting/cutoff snapshots are allowed; they are not both posted.')
 const chart=new Set(rowsFor(d,'accounts').flatMap(s=>s.data.type==='account'?[s.data.sourceAccount]:[]))
 const groups=new Map<string,StageRow[]>()
 for(const row of rowsFor(d,'general_ledger'))if(row.data.type==='gl') {
  const g=row.data,key=g.sourceId?'source:'+g.sourceId:'group:'+g.sourceGroup
  const group=groups.get(key)??[];group.push(row);groups.set(key,group)
  if(!chart.has(g.sourceAccount)||!d.accounts.some(a=>a.source_account===g.sourceAccount))issue('ACCOUNT_MAPPING',`Map the source GL account ${g.sourceAccount} from the chart.`,row)
  if(g.currency!==d.run.currency)issue('CURRENCY','Multicurrency history requires an unsupported exchange-rate model; split/convert the source explicitly.',row)
  if(g.date<d.run.from_date||g.date>d.run.cutoff_date)issue('GL_DATE','A source transaction falls outside the selected history range.',row)
  if(g.sourceParty&&!d.parties.some(p=>p.source_party===g.sourceParty))issue('PARTY_MAPPING',`Map source party ${g.sourceParty}.`,row)
 }
 type Debt={item:ImportItem;remaining:bigint;payment:boolean}
 const debts=new Map<string,Debt>()
 for(const t of tasks)if(t.item)debts.set(t.item.sourceId,{item:t.item,remaining:BigInt(t.item.amount),payment:t.item.kind==='unapplied'})
 const ordered=[...groups].sort((a,b)=>{const x=a[1][0].data as ImportGl,y=b[1][0].data as ImportGl;return x.date.localeCompare(y.date)||a[0].localeCompare(b[0])})
 for(const [key,rows] of ordered) {
  const gl=rows.map(r=>r.data as ImportGl),first=gl[0]
  if(rows.length!==first.expectedLines||gl.some(g=>g.expectedLines!==rows.length||g.date!==first.date||g.documentType!==first.documentType||g.currency!==first.currency||g.sourceId!==first.sourceId||g.sourceGroup!==first.sourceGroup||g.number!==first.number||g.dueOn!==first.dueOn))issue('TRUNCATED_GROUP',`Source transaction ${key} is truncated or has inconsistent group metadata.`,rows[0])
  if(gl.reduce((s,g)=>s+BigInt(g.amount),0n)!==0n)issue('GL_UNBALANCED',`Source transaction ${key} does not balance exactly.`,rows[0])
  if(tasks.some(t=>t.key===key))issue('SOURCE_OVERLAP',`Transaction ${key} overlaps the starting outstanding snapshot.`,rows[0])
  const controls=gl.filter(g=>d.accounts.find(a=>a.source_account===g.sourceAccount)?.roles.some(r=>['trade_receivables','trade_payables'].includes(r)))
  if(first.documentType!=='journal'&&first.documentType!=='payment'&&gl.some(g=>g.sourceParty&&!controls.includes(g)))issue('DOCUMENT_PARTY_LEG','Historical invoice groups cannot carry a party on a non-control leg.',rows[0])
  if(first.documentType==='journal') {
   if(controls.length)issue('UNLINKED_CONTROL','Control-account journals need explicit document/payment classification for a complete AR/AP handoff.',rows[0])
  } else {
   if(!first.sourceId||controls.length!==1)issue('DOCUMENT_GROUP','Document/payment groups require a source ID and exactly one control leg.',rows[0])
   const control=controls[0],a=control&&d.accounts.find(a=>a.source_account===control.sourceAccount),party=control&&d.parties.find(p=>p.source_party===control.sourceParty)
   if(control&&a) {
    const direction=a.roles.includes('trade_receivables')?'sales':'purchase',payment=first.documentType==='payment',kind=payment?'unapplied':first.documentType.endsWith('credit')?'credit_note':'invoice'
    if(!payment&&first.documentType.startsWith('sales')!==(direction==='sales'))issue('DOCUMENT_CONTROL','Document classification differs from the control role.',rows[0])
    const movement=BigInt(control.amount),expectedSign=(direction==='sales'?1n:-1n)*(kind==='invoice'?1n:-1n)
    if(movement*expectedSign<=0n)issue('DOCUMENT_SIGN','The control movement differs from the declared invoice/credit/payment direction.',rows[0])
    if(!party)issue('PARTY_MAPPING','Document control legs require a mapped source party.',rows[0])
    else if(!(await tx.execute(sql`SELECT 1 FROM party_role WHERE party_id=${party.target_party_id}::uuid AND entity_id=${d.run.entity_id}::uuid AND role=${direction==='sales'?'customer':'supplier'} AND COALESCE(held_to,'infinity'::date)>=${first.date}::date`)).length)issue('PARTY_DATE','The party role must cover the original historical transaction date.',rows[0])
    if(!payment&&(!first.number||!first.dueOn||first.dueOn<first.date))issue('DOCUMENT_METADATA','Historical documents require original number and a valid original due date.',rows[0])
    debts.set(first.sourceId,{item:{type:'item',sourceId:first.sourceId,sourceAccount:control.sourceAccount,sourceParty:control.sourceParty,direction,kind,number:first.number,issuedOn:first.date,dueOn:first.dueOn||first.date,amount:String(movement<0n?-movement:movement),currency:first.currency},remaining:movement<0n?-movement:movement,payment})
   }
  }
  const [period]=await tx.execute(sql`SELECT 1 FROM fiscal_period fp JOIN fiscal_year fy ON fy.id=fp.fiscal_year_id WHERE fp.ledger_id=${d.run.ledger_id}::uuid AND ${first.date}::date BETWEEN fp.start_date AND fp.end_date AND fp.status='open' AND fy.status='open'`)
  if(!period)issue('PERIOD','A historical transaction needs an existing open period/year; the importer cannot bypass locks.',rows[0])
  tasks.push({key,rows:rows.map(location),gl})
 }
 const appIds=new Set<string>()
 for(const row of rowsFor(d,'applications'))if(row.data.type==='application') {
  const app=row.data,source=debts.get(app.sourceTransactionId),target=debts.get(app.targetDocumentId),n=BigInt(app.amount)
  if(appIds.has(app.sourceId))issue('DUPLICATE_APPLICATION','The application source ID is repeated.',row);appIds.add(app.sourceId)
   if(!source||!target||target.item.kind!=='invoice'||source.item.kind==='invoice'||source.item.sourceAccount!==target.item.sourceAccount||source.item.sourceParty!==target.item.sourceParty||source.item.direction!==target.item.direction) {
   issue('APPLICATION_LINK','Each application must link an available payment/credit to the same-party/control invoice.',row)
  } else if(n>source.remaining||n>target.remaining)issue('APPLICATION_CAP','Application exceeds a source available balance or target debt.',row)
  else{source.remaining-=n;target.remaining-=n}
  tasks.push({key:'application:'+app.sourceId,rows:[location(row)],application:app})
 }
 const expected=new Map([...debts].filter(([,v])=>v.remaining>0n)),snapshots=new Map<string,ImportItem>()
 for(const row of rowsFor(d,'open_items'))if(row.data.type==='item') {
  const i=row.data,predicted=expected.get(i.sourceId)
  if(snapshots.has(i.sourceId))issue('DUPLICATE_SOURCE','Cutoff outstanding snapshot repeats a source ID.',row)
  snapshots.set(i.sourceId,i)
  if(!predicted||i.amount!==String(predicted.remaining)||i.sourceAccount!==predicted.item.sourceAccount||i.sourceParty!==predicted.item.sourceParty||i.kind!==predicted.item.kind||i.direction!==predicted.item.direction||i.number!==predicted.item.number||i.issuedOn!==predicted.item.issuedOn||i.dueOn!==predicted.item.dueOn||i.currency!==predicted.item.currency)issue('OPEN_SNAPSHOT','Cutoff open item does not match the original historical record and applied remaining balance.',row)
 }
 for(const [id] of expected)if(!snapshots.has(id))issue('OPEN_SNAPSHOT',`Cutoff outstanding snapshot is missing source ${id}.`)
 const target=totalBalances(d,'trial_balance'),predicted=new Map(start.target)
 const seen=new Set<string>()
 for(const row of rowsFor(d,'trial_balance'))if(row.data.type==='balance'){
  if(!chart.has(row.data.sourceAccount)||seen.has(row.data.sourceAccount))issue('TB_ACCOUNT','Cutoff TB needs unique accounts present in the source chart.',row);seen.add(row.data.sourceAccount)
 }
 for(const [,rows] of groups)for(const row of rows)if(row.data.type==='gl') {const g=row.data,a=d.accounts.find(a=>a.source_account===g.sourceAccount);if(a)predicted.set(a.target_account_id,(predicted.get(a.target_account_id)??0n)+BigInt(g.amount))}
 for(const id of new Set([...target.keys(),...predicted.keys()]))if((target.get(id)??0n)!==(predicted.get(id)??0n))issue('ENDING_TB','Starting TB plus full historical GL does not equal cutoff TB for every account.')
 const coverage:ImportCoverage={gl:'complete',parties:'partial',openItems:'complete',taxDetails:'partial',bankReconciliation:start.coverage.bankReconciliation,inventoryAssets:'not_provided',attachments:'not_provided'}
 issues.push({level:'warning',code:'HISTORY_COVERAGE',message:'GL and outstanding balances are checked; party master data and tax filing detail remain partial. Bank reconciliation, inventory/assets and original attachments were not provided.'})
 return {issues,tasks,target,coverage,digest:d.digest}
}
const plan=(tx:Tx,d:Loaded)=>d.run.mode==='opening'?openingPlan(tx,d):historyPlan(tx,d)
export async function beginImport(ledgerId:string,actor:PlanningActor,input:{mode:ImportMode;sourceSystem:string;sourceCompany:string;fromDate:string;cutoffDate:string;clearingAccountId:string}) {
 const from=importDate(input.fromDate,'ISO'),cutoff=importDate(input.cutoffDate,'ISO')
 if(!['opening','history'].includes(input.mode)||cutoff<from||input.mode==='opening'&&from!==cutoff)fail('MODE_DATE','Opening mode uses one as-of date; history uses a complete from/through range.')
 if(!input.sourceSystem.trim()||input.sourceSystem.length>100||!input.sourceCompany.trim()||input.sourceCompany.length>200)fail('SOURCE','Name the source system and source company for duplicate protection.')
 return db.transaction(async tx=>{
  const s=await planningScope(tx,ledgerId,actor,'/opening',true)
  await tx.execute(sql`SELECT id FROM ledger WHERE id=${ledgerId}::uuid FOR UPDATE`)
  const co=await companyById(s.entity_id,tx)
  const [cancelled]=await tx.execute<{n:string}>(sql`SELECT count(*)::text AS n FROM migration_run WHERE entity_id=${s.entity_id}::uuid AND status='cancelled'`)
  if(!co||BigInt(co.entries)!==BigInt(cancelled.n)||co.ai_records!=='0')fail('TARGET_NOT_EMPTY','Use a new, empty company. Existing financial or workflow records cannot be merged by this migration.')
  const [r]=await tx.execute<{id:string}>(sql`INSERT INTO migration_run(entity_id,ledger_id,mode,source_system,source_company,currency,from_date,cutoff_date,clearing_account_id,actor_user_id,created_by) VALUES(${s.entity_id}::uuid,${ledgerId}::uuid,${input.mode},${input.sourceSystem.trim()},${input.sourceCompany.trim()},${s.currency},${from}::date,${cutoff}::date,${input.clearingAccountId}::uuid,${s.userId}::uuid,${s.email}) RETURNING id::text`)
  await planningAudit(tx,s,'migration_start','migration_run',r.id,{mode:input.mode,sourceSystem:input.sourceSystem,sourceCompany:input.sourceCompany,from,cutoff})
  return {...r,version:'1'}
 })
}
function edit<T extends object>(ledgerId:string,id:string,actor:PlanningActor,context:EditContext,fn:(tx:Tx,s:PlanningScope,d:Loaded)=>Promise<T>,admin=false) {
 if(context.sessionToken!==actor.sessionToken||!context.leaseRequired)fail('EDIT_PROOF','Migration changes require the current session, version and edit lease.')
 return withDocumentWrite({ledgerId,type:'migration',id},context,async tx=>fn(tx,await planningScope(tx,ledgerId,actor,'/opening',admin),await load(tx,ledgerId,id)))
}
export async function importDetail(ledgerId:string,id:string,actor:PlanningActor) {
 return db.transaction(async tx=>{
  await planningScope(tx,ledgerId,actor,'/opening');const d=await load(tx,ledgerId,id)
  const completed=await tx.execute<{source_key:string;entry_id:string|null;invoice_id:string|null;source_rows:Array<{fileId:string;line:number}>}>(sql`SELECT source_key,entry_id::text,invoice_id::text,source_rows FROM migration_reference WHERE run_id=${id}::uuid ORDER BY completed_at,source_key`)
  return {...d,completed}
 })
}
export async function uploadImportFile(ledgerId:string,id:string,actor:PlanningActor,context:EditContext,input:{kind:ImportFileKind;filename:string;bytes:Buffer;format:ImportFormat}) {
 if(!input.filename.toLowerCase().endsWith('.csv')||input.filename.length>255||/[\/\\\r\n\0]/.test(input.filename))fail('FILE_NAME','Upload a CSV filename without paths or line breaks.')
 if(!input.bytes.length||input.bytes.length>8*1024*1024)fail('FILE_SIZE','Choose a UTF-8 CSV no larger than 8 MB.')
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(input.bytes)}catch{fail('ENCODING','Convert the source file to UTF-8 before uploading.')}
 const parsed=parseImportCsv(text,input.kind,input.format),sha=createHash('sha256').update(input.bytes).digest('hex')
 return edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  if(d.run.status!=='draft')fail('FROZEN','Return an uncommitted validation to draft before changing source data.')
  await writeBlobBytes(s.name,sha,input.bytes)
  await tx.execute(sql`INSERT INTO attachment_blob(sha256,byte_size,mime,created_by) VALUES(${sha},${input.bytes.length},'text/csv',${s.email}) ON CONFLICT(sha256) DO NOTHING`)
  await tx.execute(sql`DELETE FROM migration_file WHERE run_id=${id}::uuid AND kind=${input.kind}`)
  const [f]=await tx.execute<{id:string}>(sql`INSERT INTO migration_file(run_id,kind,sha256,filename,format,headers,excluded_rows,row_count) VALUES(${id}::uuid,${input.kind},${sha},${input.filename},${JSON.stringify(input.format)}::jsonb,${JSON.stringify(parsed.headers)}::jsonb,${JSON.stringify(parsed.excluded)}::jsonb,${parsed.stages.length}) RETURNING id::text`)
  if(parsed.stages.length)await tx.execute(sql`INSERT INTO migration_stage(file_id,source_line,data) SELECT ${f.id}::uuid,x.source_line,x.data FROM jsonb_to_recordset(${JSON.stringify(parsed.stages.map(v=>({source_line:v.sourceLine,data:v.data})))}::jsonb) AS x(source_line integer,data jsonb)`)
  await tx.execute(sql`UPDATE migration_run SET validated_digest=NULL,validation='{}',last_error=NULL WHERE id=${id}::uuid`)
  await planningAudit(tx,s,'migration_stage','migration_file',f.id,{kind:input.kind,sha256:sha,rows:parsed.stages.length,excluded:parsed.excluded})
  return {fileId:f.id,rows:parsed.stages.length}
 })
}
export function mapImport(ledgerId:string,id:string,actor:PlanningActor,context:EditContext,input:{accounts:Array<{source:string;target:string}>;parties:Array<{source:string;target:string}>}) {
 if(input.accounts.length>10000||input.parties.length>10000)fail('MAP_SIZE','Split a larger source dataset.')
 for(const list of [input.accounts,input.parties])if(new Set(list.map(v=>v.source)).size!==list.length||list.some(v=>!v.source||v.source.length>200))fail('MAPPING','Mappings require unique, non-empty source identifiers.')
 return edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  if(d.run.status!=='draft')fail('FROZEN','Only an unapproved draft may change mappings.')
  await tx.execute(sql`DELETE FROM migration_account_map WHERE run_id=${id}::uuid`)
  await tx.execute(sql`DELETE FROM migration_party_map WHERE run_id=${id}::uuid`)
  for(const m of input.accounts)await tx.execute(sql`INSERT INTO migration_account_map(run_id,source_account,target_account_id) VALUES(${id}::uuid,${m.source},${m.target}::uuid)`)
  for(const m of input.parties)await tx.execute(sql`INSERT INTO migration_party_map(run_id,source_party,target_party_id) VALUES(${id}::uuid,${m.source},${m.target}::uuid)`)
  await tx.execute(sql`UPDATE migration_run SET validated_digest=NULL,validation='{}' WHERE id=${id}::uuid`)
  await planningAudit(tx,s,'migration_map','migration_run',id,input);return {mapped:true}
 })
}
export function validateImport(ledgerId:string,id:string,actor:PlanningActor,context:EditContext) {
 return edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  if(d.run.status!=='draft')fail('STATE','Validate the draft before approval.')
  await verifySources(d,s.name)
  const p=await plan(tx,d),valid=!p.issues.some(i=>i.level==='error')
  const preview={issues:p.issues,coverage:p.coverage,digest:p.digest,tasks:p.tasks.length,openingDelta:p.tasks.find(t=>t.opening)?.opening??[],target:[...p.target].map(([accountId,amount])=>({accountId,amount:String(amount)}))}
  await tx.execute(sql`UPDATE migration_run SET status=${valid?'validated':'draft'},validated_digest=${valid?p.digest:null},validation=${JSON.stringify(preview)}::jsonb WHERE id=${id}::uuid`)
  await planningAudit(tx,s,'migration_validate','migration_run',id,preview)
  return {valid,...preview}
 })
}
export function reviseImport(ledgerId:string,id:string,actor:PlanningActor,context:EditContext) {
 return edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  if(d.run.status!=='validated')fail('STATE','Only an uncommitted validation may return to draft.')
  await tx.execute(sql`UPDATE migration_run SET status='draft',validated_digest=NULL,validation='{}' WHERE id=${id}::uuid`)
  await planningAudit(tx,s,'migration_revise','migration_run',id);return {draft:true}
 })
}
export function cancelImportDraft(ledgerId:string,id:string,actor:PlanningActor,context:EditContext) {
 return edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  if(!['draft','validated'].includes(d.run.status)||(await tx.execute(sql`SELECT 1 FROM migration_reference WHERE run_id=${id}::uuid LIMIT 1`)).length)fail('CANCEL_COMMITTED','Only an uncommitted draft/validation may be cancelled. Committed isolated targets require the existing deliberate recovery process.')
  await tx.execute(sql`UPDATE migration_run SET status='cancelled' WHERE id=${id}::uuid`)
  await planningAudit(tx,s,'migration_cancel_uncommitted','migration_run',id);return {cancelled:true}
 },true)
}
export function approveImport(ledgerId:string,id:string,actor:PlanningActor,context:EditContext,reviewedDigest:string) {
 return edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  if(d.run.status!=='validated'||d.digest!==reviewedDigest||d.run.validated_digest!==reviewedDigest)fail('APPROVAL','Review the current validated source digest before approval.')
  await verifySources(d,s.name)
  const p=await plan(tx,d);if(p.issues.some(i=>i.level==='error'))fail('VALIDATION','Current source mappings or fiscal setup no longer pass validation.')
  await tx.execute(sql`UPDATE migration_run SET status='running',approved_at=now(),actor_user_id=${s.userId}::uuid,last_error=NULL WHERE id=${id}::uuid`)
  await planningAudit(tx,s,'migration_approve','migration_run',id,{digest:reviewedDigest});return {approved:true}
 },true)
}
async function reference(tx:Tx,d:Loaded,t:Task,result:{entryId:string;invoiceId?:string|null;applicationId?:string|null}) {
 await tx.execute(sql`INSERT INTO migration_reference(run_id,entity_id,ledger_id,source_system,source_company,source_key,source_digest,source_rows,entry_id,invoice_id,application_id,original_issued_on,original_due_on) VALUES(${d.run.id}::uuid,${d.run.entity_id}::uuid,${d.run.ledger_id}::uuid,${d.run.source_system},${d.run.source_company},${t.key},${taskDigest(d,t)},${JSON.stringify(t.rows)}::jsonb,${result.entryId}::uuid,${result.invoiceId??null}::uuid,${result.applicationId??null}::uuid,${t.item?.issuedOn??t.bankItem?.date??t.gl?.[0].date??null}::date,${(t.item?.dueOn??t.gl?.[0].dueOn)||null}::date)`)
}
async function reconcile(tx:Tx,d:Loaded,target:Map<string,bigint>) {
 const rows=await tx.execute<{account_id:string;amount:string}>(sql`SELECT jl.account_id::text, SUM(jl.amount)::text AS amount FROM journal_entry je JOIN journal_line jl ON jl.entry_id=je.id WHERE je.ledger_id=${d.run.ledger_id}::uuid AND je.status IN ('posted','reversed') AND je.entry_date<=${d.run.cutoff_date}::date GROUP BY jl.account_id`)
 const actual=new Map(rows.map(r=>[r.account_id,BigInt(r.amount)]))
 const differences=[...new Set([...target.keys(),...actual.keys()])].sort().flatMap(accountId=>{
  const expected=target.get(accountId)??0n,observed=actual.get(accountId)??0n
  return expected===observed?[]:[{accountId,expected:String(expected),actual:String(observed),difference:String(observed-expected)}]
 })
 const items=await tx.execute<{invoice_id:string;balance:string}>(openItemsQuery(sql`AND i.ledger_id=${d.run.ledger_id}::uuid`))
 const [integrity]=await tx.execute<{ok:boolean}>(sql`SELECT NOT EXISTS(SELECT 1 FROM check_balance_integrity(${d.run.ledger_id}::uuid)) AS ok`)
 const refs=await tx.execute<{source_key:string;invoice_id:string|null;entry_id:string}>(sql`SELECT source_key,invoice_id::text,entry_id::text FROM migration_reference WHERE run_id=${d.run.id}::uuid AND source_key LIKE 'source:%'`)
 const openDifferences:Array<{sourceId:string;message:string}>=[],expected=new Map(rowsFor(d,'open_items').flatMap(s=>s.data.type==='item'?[[s.data.sourceId,s.data] as const]:[]))
 for(const ref of refs) {
  const sourceId=ref.source_key.slice(7),snapshot=expected.get(sourceId),invoice=ref.invoice_id?items.find(i=>i.invoice_id===ref.invoice_id):null
  let balance=invoice?BigInt(invoice.balance):0n
  if(!ref.invoice_id) {
   const [payment]=await tx.execute<{balance:string}>(sql`SELECT (abs(COALESCE(SUM(jl.amount),0))-COALESCE((SELECT SUM(a.amount) FROM invoice_application a WHERE a.entry_id=${ref.entry_id}::uuid),0))::text AS balance FROM journal_line jl JOIN account_role ar ON ar.account_id=jl.account_id AND ar.role IN ('trade_receivables','trade_payables') WHERE jl.entry_id=${ref.entry_id}::uuid`)
   balance=BigInt(payment.balance)
  }
  if(balance!==(snapshot?BigInt(snapshot.amount):0n))openDifferences.push({sourceId,message:'Actual remaining document/payment balance differs from cutoff source snapshot.'})
  if(snapshot) {
   expected.delete(sourceId)
   if(ref.invoice_id) {
    const [metadata]=await tx.execute<{number:string;issued_on:string;due_on:string;party_id:string;control_account_id:string;direction:string;document_kind:string}>(sql`SELECT number,issued_on::text,due_on::text,party_id::text,control_account_id::text,direction,document_kind FROM invoice WHERE id=${ref.invoice_id}::uuid`)
    if(!metadata||metadata.number!==snapshot.number||metadata.issued_on!==snapshot.issuedOn||metadata.due_on!==snapshot.dueOn||metadata.direction!==snapshot.direction||metadata.document_kind!==snapshot.kind||metadata.party_id!==d.parties.find(p=>p.source_party===snapshot.sourceParty)?.target_party_id||metadata.control_account_id!==d.accounts.find(a=>a.source_account===snapshot.sourceAccount)?.target_account_id)openDifferences.push({sourceId,message:'Actual original document metadata differs from cutoff snapshot.'})
   }
  }
 }
 for(const sourceId of expected.keys())openDifferences.push({sourceId,message:'The cutoff source item has no linked financial checkpoint.'})
 return {ok:differences.length===0&&openDifferences.length===0&&(actual.get(d.run.clearing_account_id)??0n)===0n&&integrity.ok,differences,openDifferences,clearing:String(actual.get(d.run.clearing_account_id)??0n),balanceCacheMatchesJournal:integrity.ok,documents:items.map(i=>({invoiceId:i.invoice_id,outstanding:String(i.balance)}))}
}
/** Each complete source transaction and its immutable checkpoint commit together. */
export async function runImportBatch(ledgerId:string,id:string,actor:PlanningActor,context:EditContext,restoredReviewedDigest?:string) {
 let executing=false,failedRows:Task['rows']=[]
 try {return await edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  if(!['running','failed','restored_paused'].includes(d.run.status))fail('STATE','Approve or explicitly resume this incomplete migration first.')
  if(d.run.status==='restored_paused'&&restoredReviewedDigest!==d.digest)fail('RESTORE_REVIEW','Review and explicitly approve the restored source digest before resuming.')
  if(d.digest!==d.run.validated_digest)fail('SOURCE_CHANGED','The approved source or mapping changed; do not continue.')
  await verifySources(d,s.name)
  const p=await plan(tx,d);if(p.issues.some(i=>i.level==='error'))fail('VALIDATION','The current fiscal or mapping setup no longer passes validation.')
  await tx.execute(sql`UPDATE migration_run SET status='running',actor_user_id=${s.userId}::uuid,last_error=NULL WHERE id=${id}::uuid`)
  await tx.execute(sql`SELECT set_config('erp.migration_run',${id},true)`)
  const completed=await tx.execute<{source_key:string;source_digest:string}>(sql`SELECT source_key,source_digest FROM migration_reference WHERE run_id=${id}::uuid`)
  const done=new Map(completed.map(v=>[v.source_key,v.source_digest]))
  for(const t of p.tasks)if(done.has(t.key)&&done.get(t.key)!==taskDigest(d,t))fail('CHECKPOINT_CHANGED','An existing checkpoint differs from this source transaction.')
  const pending=p.tasks.filter(t=>!done.has(t.key)),batch=pending.slice(0,12)
  executing=true;failedRows=batch.flatMap(t=>t.rows)
  for(const t of batch) {
   let result:{entryId:string;invoiceId?:string|null;applicationId?:string|null}
   const asOf=d.run.mode==='opening'?d.run.cutoff_date:addDays(d.run.from_date,-1)
   if(t.opening)result=await postOpeningBalance({ledgerId,entryDate:asOf,lines:t.opening.map(l=>({accountId:l.accountId,amount:BigInt(l.amount)})),description:'Migrated opening: target TB less detailed outstanding contribution',actor:s.email},tx)
   else if(t.bankItem) {
    const i=t.bankItem,account=d.accounts.find(a=>a.source_account===i.sourceAccount)!
    const description=`Outstanding bank book item (${i.date}): ${i.description}`
    const posted=await postEntryCore(tx,{ledgerId,entryDate:asOf,description,documentRef:i.number||i.sourceId,sourceType:'bank',actor:s.email,lines:[{accountId:account.target_account_id,amount:BigInt(i.amount),description},{accountId:d.run.clearing_account_id,amount:-BigInt(i.amount),description:'Conversion clearing'}]})
    result={entryId:posted.entry.id}
   } else if(t.gl) {
    const gl=t.gl,first=gl[0],lines=gl.map(g=>({accountId:d.accounts.find(a=>a.source_account===g.sourceAccount)!.target_account_id,amount:BigInt(g.amount),description:g.description,partyId:g.sourceParty?d.parties.find(p=>p.source_party===g.sourceParty)!.target_party_id:undefined}))
    if(first.documentType==='journal'||first.documentType==='payment') {
     const posted=await postEntryCore(tx,{ledgerId,entryDate:first.date,description:first.description,documentRef:first.number||first.sourceId||first.sourceGroup,sourceType:first.documentType==='payment'?'payment':'manual',lines,actor:s.email});result={entryId:posted.entry.id}
    } else {
     const control=gl.find(g=>d.accounts.find(a=>a.source_account===g.sourceAccount)!.roles.some(r=>['trade_receivables','trade_payables'].includes(r)))!,a=d.accounts.find(a=>a.source_account===control.sourceAccount)!
     const invoice=await createInvoice({ledgerId,direction:first.documentType.startsWith('sales')?'sales':'purchase',kind:first.documentType.endsWith('credit')?'credit_note':'invoice',partyId:d.parties.find(p=>p.source_party===control.sourceParty)!.target_party_id,controlAccountId:a.target_account_id,issuedOn:first.date,dueOn:first.dueOn,number:first.number,theirRef:first.sourceId,template:'system',note:first.description,actor:s.email,lines:lines.filter(l=>l.accountId!==a.target_account_id)},tx)
     const posted=await postInvoice(invoice.id,s.email,tx);result={entryId:posted.entryId,invoiceId:invoice.id}
    }
   } else if(t.application) {
    const app=t.application,links=await tx.execute<{source_key:string;entry_id:string;invoice_id:string|null}>(sql`SELECT source_key,entry_id::text,invoice_id::text FROM migration_reference WHERE run_id=${id}::uuid AND source_key IN (${'source:'+app.sourceTransactionId},${'source:'+app.targetDocumentId})`)
    const source=links.find(r=>r.source_key==='source:'+app.sourceTransactionId),target=links.find(r=>r.source_key==='source:'+app.targetDocumentId)
    if(!source||!target?.invoice_id)fail('APPLICATION_CHECKPOINT','Both source financial transactions must be committed before applying.')
    const applied=await applyEntryToInvoice({invoiceId:target.invoice_id,entryId:source.entry_id,amount:BigInt(app.amount),actor:s.email},tx)
    result={entryId:source.entry_id,applicationId:applied.id}
   } else {
    const i=t.item!,a=d.accounts.find(a=>a.source_account===i.sourceAccount)!,party=d.parties.find(p=>p.source_party===i.sourceParty)!
    result=await createOpeningDocument(tx,{runId:id,ledgerId,asOf,clearingAccountId:d.run.clearing_account_id,controlAccountId:a.target_account_id,partyId:party.target_party_id,item:i,actor:s.email})
   }
   await reference(tx,d,t,result)
  }
  let reconciliation:Awaited<ReturnType<typeof reconcile>>|null=null
  if(pending.length===batch.length) {
   reconciliation=await reconcile(tx,d,p.target)
   await tx.execute(sql`UPDATE migration_run SET status=${reconciliation.ok?'ready':'failed'},reconciliation=${JSON.stringify(reconciliation)}::jsonb,last_error=${reconciliation.ok?null:'Reconciliation differs; ordinary writes remain blocked.'} WHERE id=${id}::uuid`)
  }
  await planningAudit(tx,s,'migration_batch','migration_run',id,{completed:batch.map(t=>t.key),remaining:pending.length-batch.length,reconciliation})
  return {completed:batch.length,remaining:pending.length-batch.length,reconciliation}
 },true)}catch(error) {
  if(executing)await edit(ledgerId,id,actor,context,async(tx,s,d)=>{
   if(!['running','failed','restored_paused'].includes(d.run.status))throw error
   await tx.execute(sql`UPDATE migration_run SET status='failed',last_error='The current batch rolled back. Review the failed source rows and current fiscal/account setup; earlier checkpoints remain committed.',validation=validation||${JSON.stringify({failedRows})}::jsonb WHERE id=${id}::uuid`)
   await planningAudit(tx,s,'migration_batch_failed','migration_run',id,{failedRows});return {failed:true}
  },true)
  throw error
 }
}
export function activateImport(ledgerId:string,id:string,actor:PlanningActor,context:EditContext,reviewedDigest:string) {
 return edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  if(d.run.status!=='ready'||reviewedDigest!==d.run.validated_digest||d.digest!==reviewedDigest)fail('ACTIVATION','Review the completed reconciliation and approved source digest before activation.')
  const p=await plan(tx,d),checked=await reconcile(tx,d,p.target)
  if(!checked.ok||p.issues.some(i=>i.level==='error'))fail('RECONCILIATION','The current financial records do not reconcile to the approved source.')
  await tx.execute(sql`UPDATE migration_run SET status='active',activated_at=now(),reconciliation=${JSON.stringify(checked)}::jsonb WHERE id=${id}::uuid`)
  await planningAudit(tx,s,'migration_activate','migration_run',id,{digest:reviewedDigest,coverage:p.coverage});return {active:true}
 },true)
}
export async function importSourceFile(ledgerId:string,id:string,fileId:string,actor:PlanningActor) {
 return db.transaction(async tx=>{
  const s=await planningScope(tx,ledgerId,actor,'/opening'),d=await load(tx,ledgerId,id),f=d.files.find(f=>f.id===fileId)
  if(!f)fail('FILE','This source file is unavailable in these books.')
  const bytes=await readBlobBytes(s.name,f.sha256)
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==f.sha256)fail('SOURCE_MISSING','The private source CSV is missing or differs from its digest.')
  return {bytes,filename:f.filename}
 })
}
export async function migrationNotice(ledgerId:string) {
 const [r]=await db.execute<{id:string;mode:string;status:string;cutoff_date:string;from_date:string}>(sql`SELECT id::text,mode,status,cutoff_date::text,from_date::text FROM migration_run WHERE ledger_id=${ledgerId}::uuid AND status<>'cancelled'`)
 if(!r)return null
 return {id:r.id,text:r.status!=='active'?`Migration is ${r.status}; financial data are incomplete and ordinary financial writes are paused.`:r.mode==='opening'?`Books carry opening balances as of ${r.cutoff_date}. Earlier monthly profit and detailed tax/bank history were not reconstructed.`:`Imported GL coverage begins ${r.from_date}. Review the migration reconciliation and partial module coverage.`}
}

/** Trusted portable restore relocates approval locators, preserves source digests,
 * and grants no authority to continue the paused migration. */
export async function rebindRestoredImports(tx:Tx,ledgerId:string) {
 const runs=await tx.execute<{id:string}>(sql`SELECT id::text FROM migration_run WHERE ledger_id=${ledgerId}::uuid AND status<>'cancelled'`)
 for(const r of runs) {
  const d=await load(tx,ledgerId,r.id)
  if(['draft','active'].includes(d.run.status))continue
  const refs=await tx.execute<{source_key:string;source_digest:string}>(sql`SELECT source_key,source_digest FROM migration_reference WHERE run_id=${r.id}::uuid`)
  const p=await plan(tx,d)
  if(p.issues.some(i=>i.level==='error'))fail('RESTORE_SOURCE','The restored approved source no longer validates in its target company.')
  for(const ref of refs){const task=p.tasks.find(t=>t.key===ref.source_key);if(!task||taskDigest(d,task)!==ref.source_digest)fail('RESTORE_CHECKPOINT','A restored checkpoint differs from its original source data.')}
  await tx.execute(sql`UPDATE migration_run SET validated_digest=${d.digest},validation=validation||${JSON.stringify({digest:d.digest,issues:p.issues,coverage:p.coverage,openingDelta:p.tasks.find(t=>t.opening)?.opening??[],restoredReapprovalRequired:true})}::jsonb WHERE id=${r.id}::uuid`)
 }
}

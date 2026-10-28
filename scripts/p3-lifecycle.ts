import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client'
import { createCompany,createFiscalYear } from '../src/lib/setup'
import { importAccounts,parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { planningActor } from '../src/lib/planning-access'
import { beginImport,uploadImportFile,mapImport,validateImport,approveImport,runImportBatch,importDetail } from '../src/lib/ledger-import'
import { createBudget,previewBudget,applyBudgetPreview } from '../src/lib/budgets'
import { editLease } from '../src/lib/edit-leases'
import { EDIT_RESOURCES,type EditResource,type EditContext } from '../src/lib/edit-proof'
import { canonicalImportFormat } from '../src/lib/import-csv'
import { HISTORY_CHART,HISTORY_TARGET_ACCOUNTS,ITEM_HEADER,HISTORY_START,HISTORY_END,HISTORY_OPEN,HISTORY_APPS,HISTORY_GL } from './p3-fixtures'
export async function p3Proof(resource:EditResource,token:string):Promise<EditContext> {
 const [row]=await db.execute<{version:string}>(sql`SELECT version::text FROM ${sql.raw(EDIT_RESOURCES[resource.type].table)} WHERE id=${resource.id}::uuid`)
 const tabId=randomUUID(),lease=await editLease(resource,token,'takeover',{version:row.version,tabId})
 return {sessionToken:token,proof:{version:row.version,tabId,...lease},leaseRequired:true}
}
export async function buildP3Lifecycle(email:string,token:string,prefix:string,includeBank=false) {
 const actor=planningActor(token),co=await createCompany({code:prefix,name:prefix+' isolated migration lifecycle'},email),ledgerId=co.ledger.id
 await createFiscalYear(ledgerId,'2025-12-31',email);await createFiscalYear(ledgerId,'2026-12-31',email)
 const accounts=await importAccounts(co.company.id,parseAccountsCsv(HISTORY_TARGET_ACCOUNTS).map(a=>({...a,entityId:co.company.id})),email)
 const cust=await createParty({kind:'organisation',name:prefix+' customer',roles:[{entityId:co.company.id,role:'customer',heldFrom:'2025-01-01'}],actor:email}),sup=await createParty({kind:'organisation',name:prefix+' supplier',roles:[{entityId:co.company.id,role:'supplier',heldFrom:'2025-01-01'}],actor:email})
 const run=await beginImport(ledgerId,actor,{mode:'history',sourceSystem:'Generic CSV fixture',sourceCompany:prefix+' source',fromDate:'2026-01-01',cutoffDate:'2026-03-31',clearingAccountId:accounts.find(a=>a.code==='3999')!.id}),resource:EditResource={ledgerId,type:'migration',id:run.id}
 for(const [kind,csv] of [['accounts',HISTORY_CHART],['starting_trial_balance',HISTORY_START],['starting_open_items',ITEM_HEADER+'\n'],['general_ledger',HISTORY_GL],['applications',HISTORY_APPS],['trial_balance',HISTORY_END],['open_items',HISTORY_OPEN]] as const)await uploadImportFile(ledgerId,run.id,actor,await p3Proof(resource,token),{kind,filename:kind+'.csv',bytes:Buffer.from(csv),format:canonicalImportFormat(kind,csv.split('\n')[0].split(','))})
 if(includeBank){const csv='source_id,source_account,date,amount,currency,number,description\nBANKSTART,1000,2025-12-20,100.00,CAD,DEP-START,Outstanding starting deposit';await uploadImportFile(ledgerId,run.id,actor,await p3Proof(resource,token),{kind:'starting_bank_open_items',filename:'starting-bank.csv',bytes:Buffer.from(csv),format:canonicalImportFormat('starting_bank_open_items',csv.split('\n')[0].split(','))})}
 await mapImport(ledgerId,run.id,actor,await p3Proof(resource,token),{accounts:accounts.map(a=>({source:a.code,target:a.id})),parties:[{source:'CUST',target:cust.id},{source:'SUP',target:sup.id}]})
 const valid=await validateImport(ledgerId,run.id,actor,await p3Proof(resource,token));if(!valid.valid)throw Error('Lifecycle fixture does not validate')
 await approveImport(ledgerId,run.id,actor,await p3Proof(resource,token),valid.digest)
 const first=await runImportBatch(ledgerId,run.id,actor,await p3Proof(resource,token));if(first.completed!==12||first.remaining!==(includeBank?2:1))throw Error('Lifecycle did not stop at twelve committed checkpoints')
 const [fy]=await db.execute<{id:string}>(sql`SELECT id::text FROM fiscal_year WHERE ledger_id=${ledgerId}::uuid AND end_date='2026-12-31'`)
 const budget=await createBudget(ledgerId,actor,{name:prefix+' retained budget',fiscalYearId:fy.id}),op={kind:'spread' as const,accountId:accounts.find(a=>a.code==='4000')!.id,annualAmount:'10001'}
 const preview=await previewBudget(ledgerId,budget.id,actor,op)
 await applyBudgetPreview(ledgerId,budget.id,actor,await p3Proof({ledgerId,type:'budget',id:budget.id},token),op,preview.digest)
 return {entityId:co.company.id,ledgerId,runId:run.id,budgetId:budget.id,detail:await importDetail(ledgerId,run.id,actor)}
}
/** Compare every carried P3 fixture row and all financial fields, after the explicit
 * identity relocation and documented migration-approval reset only. */
export function compareP3Copy(before:import('../src/lib/backup').FigtreeFile,after:import('../src/lib/backup').FigtreeFile) {
 const ids=new Map<string,string>([[String(before.entity.id),String(after.entity.id)]]),differences:string[]=[]
 const plain=(v:unknown)=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?String(x):x))
 const clean=(table:string,v:Record<string,unknown>)=>{
  const row={...v}
  if(table==='migration_run') {
   for(const k of ['status','last_error','actor_user_id','validated_digest'])delete row[k]
   const validation={...(row.validation as Record<string,unknown>)};delete validation.digest;delete validation.restoredReapprovalRequired;row.validation=validation
  }
  return row
 }
 // Pair rows by what they hold with every UUID blanked, not by the order a scan
 // returned them: the copy has new UUIDs, so an index can hand its rows back in
 // another order, and positional pairing swapped two entries' ids (CI, 2026-10-20).
 // Two passes: the first pairs what is unique on its own; the second breaks ties
 // (budget lines alike but for their account) with the references now paired.
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
 const shape=(v:unknown,m:(id:string)=>string):unknown=>Array.isArray(v)?v.map(x=>shape(x,m)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,shape(x,m)])):typeof v==='string'&&UUID.test(v)?m(v):v
 const byShape=(table:string,rows:Record<string,unknown>[],m:(id:string)=>string)=>rows.map(row=>({row,key:JSON.stringify(shape({...clean(table,plain(row)),id:''},m))})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0).map(x=>x.row)
 for(const pass of [1,2]){
  const known=new Map(ids),images=new Set(known.values())
  const mBefore=pass===1?()=>'':(id:string)=>known.get(id)??'',mAfter=pass===1?()=>'':(id:string)=>images.has(id)?id:''
  for(const [table,rows] of Object.entries(before.rows)){
   const other=after.rows[table]??[];if(pass===1&&rows.length!==other.length)differences.push(table+': row count')
   const a=byShape(table,rows,mBefore),b=byShape(table,other,mAfter)
   for(let i=0;i<a.length;i++)if(typeof a[i].id==='string'&&typeof b[i]?.id==='string')ids.set(String(a[i].id),String(b[i].id))
  }
 }
 // These leaf tables may be scanned through a newly ordered UUID index.
 // Pair them by their relocated parent + business ordinal, never by scan order.
 for(const [table,parent,ordinal] of [['journal_line','entry_id','line_no'],['migration_stage','file_id','source_line']]) {
  for(const row of before.rows[table]??[]) {
   const match=(after.rows[table]??[]).find(r=>r[parent]===ids.get(String(row[parent]))&&r[ordinal]===row[ordinal])
   if(!match)differences.push(table+': missing parent/ordinal')
   else ids.set(String(row.id),String(match.id))
  }
 }
 const move=(v:unknown):unknown=>{
  if(Array.isArray(v)){
   const rows=v.map(move)
   if(rows.length&&rows.every(r=>r&&typeof r==='object'&&'accountId' in r&&'amount' in r))rows.sort((a,b)=>String((a as {accountId:string}).accountId).localeCompare(String((b as {accountId:string}).accountId)))
   return rows
  }
  return v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,move(x)])):typeof v==='string'?ids.get(v)??v:v
 }
 for(const [table,rows] of Object.entries(before.rows)){
  const other=after.rows[table]??[]
  const a=rows.map(row=>JSON.stringify(move(clean(table,plain(row))))).sort(),b=other.map(row=>JSON.stringify(move(clean(table,plain(row))))).sort()
  if(JSON.stringify(a)!==JSON.stringify(b))differences.push(table+': full field set')
 }
 return differences
}

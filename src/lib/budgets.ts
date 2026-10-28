import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Tx } from './acting'
import { planningScope,planningAudit,type PlanningActor,type PlanningScope } from './planning-access'
import { withDocumentWrite } from './edit-leases'
import type { EditContext } from './edit-proof'
import { statementAccountFigures } from './statements'
import { fail } from './import-csv'
import { spreadCents,type BudgetCell,type BudgetOperation } from './budget-types'
import { addDays } from './recurrence-calendar'

type BudgetRow={id:string;entity_id:string;ledger_id:string;fiscal_year_id:string;name:string;status:string;version:string;copied_from_id:string|null}
type Period={id:string;name:string;period_no:number;start_date:string;end_date:string}
type Account={id:string;code:string;name:string;account_type:'revenue'|'expense'}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const cents=(s:string)=>{if(!/^-?\d+$/.test(s)||BigInt(s)<-9223372036854775808n||BigInt(s)>9223372036854775807n)fail('BUDGET_AMOUNT','Use exact supported integer cents.');return BigInt(s)}
async function load(tx:Tx,ledgerId:string,id:string) {
 const [budget]=await tx.execute<BudgetRow>(sql`SELECT id::text,entity_id::text,ledger_id::text,fiscal_year_id::text,name,status,version::text,copied_from_id::text FROM budget WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid`)
 if(!budget)fail('BUDGET','This budget is unavailable in these books.')
 const periods=await tx.execute<Period>(sql`SELECT id::text,name,period_no,start_date::text,end_date::text FROM fiscal_period WHERE fiscal_year_id=${budget.fiscal_year_id}::uuid ORDER BY start_date`)
 const accounts=await tx.execute<Account>(sql`SELECT id::text,code,name,account_type::text FROM account WHERE entity_id=${budget.entity_id}::uuid AND account_type IN ('revenue','expense') AND is_active AND is_postable ORDER BY code`)
 const lines=await tx.execute<BudgetCell>(sql`SELECT account_id::text AS "accountId",period_id::text AS "periodId",amount::text FROM budget_line WHERE budget_id=${id}::uuid ORDER BY account_id,period_id`)
 return {budget,periods,accounts,lines}
}
type Loaded=Awaited<ReturnType<typeof load>>
async function actuals(tx:Tx,d:Loaded,periods:Period[]=d.periods) {
 const figures=await statementAccountFigures(d.budget.ledger_id,periods.map(p=>({id:p.id,fromId:p.id,throughId:p.id})),tx)
 const [coverage]=await tx.execute<{mode:string;status:string;from_date:string;cutoff_date:string}>(sql`SELECT mode,status,from_date::text,cutoff_date::text FROM migration_run WHERE ledger_id=${d.budget.ledger_id}::uuid AND status<>'cancelled'`)
 const coveredFrom=coverage?(coverage.mode==='opening'?addDays(coverage.cutoff_date,1):coverage.from_date):null
 const closing=await tx.execute<{period_id:string}>(sql`SELECT DISTINCT period_id::text FROM journal_entry WHERE ledger_id=${d.budget.ledger_id}::uuid AND source_type='period_close' AND status='posted'`)
 const closed=new Set(closing.map(r=>r.period_id)),seen=new Set<string>(),values: Array<BudgetCell&{coverage:'complete'|'partial'|'missing';warning:string|null}>=[]
 for(const f of figures) {
  if(!['revenue','expense'].includes(f.account_type))continue
  const key=f.account_id+':'+f.span_id;if(seen.has(key))continue;seen.add(key)
  const p=periods.find(p=>p.id===f.span_id)!
  const scope=coverage?.status!=='active'&&coverage?'partial':coveredFrom&&p.end_date<coveredFrom?'missing':coveredFrom&&p.start_date<coveredFrom||closed.has(p.id)?'partial':'complete'
  values.push({accountId:f.account_id,periodId:f.span_id,amount:String(BigInt(f.period_movement)*(f.account_type==='revenue'?-1n:1n)),coverage:scope,
   warning:scope==='missing'?'No monthly source coverage.':scope==='partial'?(closed.has(p.id)?'Includes the year-end closing entry; the current P&L shows what remains after closing.':'Migration coverage is incomplete or the month includes opening YTD balances.') :null})
 }
 const warnings: string[]=[]
 const [drift]=await tx.execute<{bad:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM check_balance_integrity(${d.budget.ledger_id}::uuid)) AS bad`)
 if(drift.bad)warnings.push('The balance cache differs from the journal; actuals may be wrong. Rebuild through the current company command.')
 const roleRows=await tx.execute<{account_id:string;n:number}>(sql`SELECT a.id::text AS account_id,count(DISTINCT sl.id)::int AS n FROM account a LEFT JOIN account_role ar ON ar.account_id=a.id LEFT JOIN statement_line sl ON ar.role=ANY(sl.roles) AND sl.line_type='detail' AND sl.template_id=(SELECT id FROM statement_template WHERE code='IFRS_PL_NATURE_EN') WHERE a.entity_id=${d.budget.entity_id}::uuid AND a.account_type IN ('revenue','expense') GROUP BY a.id`)
 for(const row of roleRows)if(row.n!==1){const a=d.accounts.find(a=>a.id===row.account_id);if(a)warnings.push(`${a.code} reaches ${row.n} P&L detail lines; review its current role mapping before comparing profit.`)}
 return {values,warnings}
}
function edit<T extends object>(ledgerId:string,id:string,actor:PlanningActor,context:EditContext,fn:(tx:Tx,s:PlanningScope,d:Loaded)=>Promise<T>) {
 if(context.sessionToken!==actor.sessionToken||!context.leaseRequired)fail('EDIT_PROOF','Budget changes require the current session, version and edit lease.')
 return withDocumentWrite({ledgerId,type:'budget',id},context,async tx=>fn(tx,await planningScope(tx,ledgerId,actor,'/reports'),await load(tx,ledgerId,id)))
}
export async function createBudget(ledgerId:string,actor:PlanningActor,input:{fiscalYearId:string;name:string;copyFromId?:string}) {
 if(!input.name.trim()||input.name.length>200)fail('BUDGET_NAME','Name the budget (1–200 characters).')
 return db.transaction(async tx=>{
  const s=await planningScope(tx,ledgerId,actor,'/reports')
  const source=input.copyFromId?await load(tx,ledgerId,input.copyFromId):null
  if(source&&source.budget.fiscal_year_id!==input.fiscalYearId)fail('BUDGET_COPY_YEAR','Create a blank target year and use a reviewed copy preview to map fiscal periods.')
  const [b]=await tx.execute<{id:string}>(sql`INSERT INTO budget(entity_id,ledger_id,fiscal_year_id,name,copied_from_id,created_by) VALUES(${s.entity_id}::uuid,${ledgerId}::uuid,${input.fiscalYearId}::uuid,${input.name.trim()},${input.copyFromId??null}::uuid,${s.email}) RETURNING id::text`)
  if(source)await tx.execute(sql`INSERT INTO budget_line(budget_id,account_id,period_id,amount) SELECT ${b.id}::uuid,account_id,period_id,amount FROM budget_line WHERE budget_id=${source.budget.id}::uuid`)
  await planningAudit(tx,s,'budget_create','budget',b.id,{...input,sourceVersion:source?.budget.version});return {...b,version:'1'}
 })
}
export async function budgetDetail(ledgerId:string,id:string,actor:PlanningActor) {
 return db.transaction(async tx=>{await planningScope(tx,ledgerId,actor,'/reports');const d=await load(tx,ledgerId,id);return {...d,actual:await actuals(tx,d)}})
}
async function preview(tx:Tx,d:Loaded,operation:BudgetOperation) {
 if(d.budget.status!=='draft')fail('BUDGET_FROZEN','Copy a published or archived budget into a new draft before editing.')
 const before=new Map(d.lines.map(c=>[c.accountId+':'+c.periodId,c.amount])),cells:BudgetCell[]=[],warnings:string[]=[],sources:unknown[]=[]
 if(operation.kind==='manual')cells.push(...operation.cells)
 else if(operation.kind==='spread') {
  const values=spreadCents(cents(operation.annualAmount),d.periods.length)
  cells.push(...d.periods.map((p,i)=>({accountId:operation.accountId,periodId:p.id,amount:String(values[i])})))
 } else if(operation.kind==='percent') {
  if(!operation.accountIds.length||!operation.periodIds.length)fail('BUDGET_SELECTION','Choose at least one account and fiscal period to adjust.')
  if(!Number.isSafeInteger(operation.basisPoints)||operation.basisPoints < -10000||operation.basisPoints>100000)fail('BUDGET_PERCENT','Choose a percentage change from -100% to 1000%.')
  for(const a of operation.accountIds)for(const p of operation.periodIds){const n=cents(before.get(a+':'+p)??'0')*BigInt(10000+operation.basisPoints),rounded=(n+(n<0n?-5000n:5000n))/10000n;cells.push({accountId:a,periodId:p,amount:String(rounded)})}
 } else if(operation.kind==='copy') {
  const source=await load(tx,d.budget.ledger_id,operation.sourceBudgetId);sources.push({budget:source.budget,lines:source.lines})
  for(const p of d.periods) {
   const matching=source.periods.find(s=>s.start_date.slice(5)===p.start_date.slice(5)&&s.end_date.slice(5)===p.end_date.slice(5))
   if(!matching){warnings.push(`${p.name}: the source budget has no comparable fiscal period; left unchanged.`);continue}
   for(const line of source.lines.filter(l=>l.periodId===matching.id))cells.push({...line,periodId:p.id})
  }
 } else if(operation.kind==='prefill') {
  const [year]=await tx.execute<{id:string}>(sql`SELECT id::text FROM fiscal_year WHERE ledger_id=${d.budget.ledger_id}::uuid AND end_date<(SELECT start_date FROM fiscal_year WHERE id=${d.budget.fiscal_year_id}::uuid) ORDER BY end_date DESC LIMIT 1`)
  const periods=year?await tx.execute<Period>(sql`SELECT id::text,name,period_no,start_date::text,end_date::text FROM fiscal_period WHERE fiscal_year_id=${year.id}::uuid ORDER BY start_date`):[]
  const a=await actuals(tx,d,periods);sources.push(a);warnings.push(...a.warnings)
  for(const p of d.periods) {
   const matching=periods.find(s=>s.start_date.slice(5)===p.start_date.slice(5)&&s.end_date.slice(5)===p.end_date.slice(5))
   if(!matching){warnings.push(`${p.name}: no comparable prior fiscal period; left unchanged.`);continue}
   const available=a.values.filter(v=>v.periodId===matching.id&&v.coverage==='complete')
   if(!available.length){warnings.push(`${p.name}: prior monthly coverage is missing or partial; left unchanged.`);continue}
   for(const v of available)if(d.accounts.some(a=>a.id===v.accountId))cells.push({accountId:v.accountId,periodId:p.id,amount:v.amount})
  }
 } else fail('BUDGET_OPERATION','Choose a supported reviewed budget operation.')
 if(cells.length>10000||new Set(cells.map(c=>c.accountId+':'+c.periodId)).size!==cells.length)fail('BUDGET_CELLS','Use at most 10,000 distinct account/period cells.')
 for(const c of cells){cents(c.amount);if(!d.accounts.some(a=>a.id===c.accountId)||!d.periods.some(p=>p.id===c.periodId))fail('BUDGET_SCOPE','Every cell must use an active P&L account and fiscal period in this company/year.')}
 cells.sort((a,b)=>(a.accountId+':'+a.periodId).localeCompare(b.accountId+':'+b.periodId))
 const changes=cells.map(c=>({...c,before:before.get(c.accountId+':'+c.periodId)??null}))
 return {operation,changes,warnings,overwrites:changes.filter(c=>c.before!==null).length,digest:digest({version:d.budget.version,operation,changes,sources})}
}
export async function previewBudget(ledgerId:string,id:string,actor:PlanningActor,operation:BudgetOperation) {
 return db.transaction(async tx=>{await planningScope(tx,ledgerId,actor,'/reports');return preview(tx,await load(tx,ledgerId,id),operation)})
}
export function applyBudgetPreview(ledgerId:string,id:string,actor:PlanningActor,context:EditContext,operation:BudgetOperation,reviewedDigest:string) {
 return edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  const p=await preview(tx,d,operation);if(p.digest!==reviewedDigest)fail('BUDGET_PREVIEW_CHANGED','The target budget or source data changed. Review a fresh preview before overwriting cells.')
  for(const c of p.changes)await tx.execute(sql`INSERT INTO budget_line(budget_id,account_id,period_id,amount) VALUES(${id}::uuid,${c.accountId}::uuid,${c.periodId}::uuid,${c.amount}::bigint) ON CONFLICT(budget_id,account_id,period_id) DO UPDATE SET amount=EXCLUDED.amount`)
  await tx.execute(sql`UPDATE budget SET name=name WHERE id=${id}::uuid`)
  await planningAudit(tx,s,'budget_apply','budget',id,{digest:p.digest,changes:p.changes,warnings:p.warnings});return {saved:p.changes.length}
 })
}
export function changeBudgetState(ledgerId:string,id:string,actor:PlanningActor,context:EditContext,state:'published'|'archived') {
 return edit(ledgerId,id,actor,context,async(tx,s,d)=>{
  if(!['published','archived'].includes(state)||state==='published'&&d.budget.status!=='draft'||d.budget.status==='archived')fail('BUDGET_STATE','This budget cannot make the requested state change.')
  await tx.execute(sql`UPDATE budget SET status=${state},published_at=CASE WHEN ${state}='published' THEN now() ELSE published_at END,archived_at=CASE WHEN ${state}='archived' THEN now() ELSE archived_at END WHERE id=${id}::uuid`)
  await planningAudit(tx,s,'budget_'+state,'budget',id,{previous:d.budget.status});return {status:state}
 })
}
export async function planningLists(ledgerId:string,actor:PlanningActor,seat:'/reports'|'/opening') {
 return db.transaction(async tx=>{
  const s=await planningScope(tx,ledgerId,actor,seat)
  const years=await tx.execute<{id:string;name:string}>(sql`SELECT id::text,name FROM fiscal_year WHERE ledger_id=${ledgerId}::uuid ORDER BY start_date DESC`)
  const accounts=await tx.execute<{id:string;code:string;name:string;account_type:string}>(sql`SELECT id::text,code,name,account_type::text FROM account WHERE entity_id=${s.entity_id}::uuid AND is_active AND is_postable ORDER BY code`)
  const parties=await tx.execute<{id:string;name:string}>(sql`SELECT DISTINCT p.id::text,p.name FROM party p JOIN party_role pr ON pr.party_id=p.id WHERE pr.entity_id=${s.entity_id}::uuid AND pr.role IN ('customer','supplier') ORDER BY p.name`)
  const budgets=seat==='/reports'?await tx.execute<BudgetRow>(sql`SELECT id::text,entity_id::text,ledger_id::text,fiscal_year_id::text,name,status,version::text,copied_from_id::text FROM budget WHERE ledger_id=${ledgerId}::uuid ORDER BY created_at DESC`):[]
  const runs=seat==='/opening'?await tx.execute<{id:string;status:string;mode:string}>(sql`SELECT id::text,status,mode FROM migration_run WHERE ledger_id=${ledgerId}::uuid ORDER BY created_at DESC`):[]
  return {years,accounts,parties,budgets,runs}
 })
}

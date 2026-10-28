import './env'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db,sql as connection } from '../src/db/client'
import { reporter,expectSaying,errorText } from './suite'
import { createFirstOwner,createUser,signIn } from '../src/lib/users'
import { createCompany,createFiscalYear } from '../src/lib/setup'
import { importAccounts,parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { recordPayment,documentsWithBalances } from '../src/lib/payments'
import { planningActor } from '../src/lib/planning-access'
import { beginImport,uploadImportFile,mapImport,validateImport,approveImport,runImportBatch,activateImport,importDetail,importSourceFile,cancelImportDraft } from '../src/lib/ledger-import'
import { editLease } from '../src/lib/edit-leases'
import { EDIT_RESOURCES,type EditResource,type EditContext } from '../src/lib/edit-proof'
import { canonicalImportFormat,parseImportCsv,importAmount,importDate } from '../src/lib/import-csv'
import type { ImportFileKind } from '../src/lib/import-types'
import { postEntry } from '../src/lib/posting'
import { importBankRows,candidateEntries,matchEntry,bankRows } from '../src/lib/bank'
import { actingAs } from '../src/lib/acting'
import { HISTORY_CHART,HISTORY_TARGET_ACCOUNTS,ITEM_HEADER,HISTORY_START,HISTORY_END,HISTORY_OPEN,HISTORY_APPS,HISTORY_GL,EXPECTED_HISTORY_CENTS } from './p3-fixtures'
import { createBudget,budgetDetail,previewBudget,applyBudgetPreview,changeBudgetState } from '../src/lib/budgets'
import { spreadCents,budgetVariance,type BudgetOperation } from '../src/lib/budget-types'
import { renderStatement,statementFiguresQuery } from '../src/lib/statements'
import { aging } from '../src/lib/aging'

const r=reporter(80),no=expectSaying(r,errorText,110),PW='P3 isolated verification password phrase'
async function proof(resource:EditResource,token:string):Promise<EditContext> {
 const [row]=await db.execute<{version:string}>(sql`SELECT version::text FROM ${sql.raw(EDIT_RESOURCES[resource.type].table)} WHERE id=${resource.id}::uuid`)
 const tabId=randomUUID(),lease=await editLease(resource,token,'takeover',{version:row.version,tabId})
 return {sessionToken:token,proof:{version:row.version,tabId,...lease},leaseRequired:true}
}
const chart='1000,Cash,asset,,cash_and_cash_equivalents\n1200,Receivables,asset,,trade_receivables\n2000,Payables,liability,,trade_payables\n3000,Equity,equity,,retained_earnings\n3999,Conversion clearing,equity,,retained_earnings\n4000,Revenue,revenue,,revenue_from_contracts\n5000,Expenses,expense,,other_operating_expenses'
const accountCsv='source_account,name,account_type\n1000,Cash,asset\n1200,Receivables,asset\n2000,Payables,liability\n3000,Equity,equity\n3999,Conversion clearing,equity\n4000,Revenue,revenue\n5000,Expenses,expense'
const tb='source_account,amount\n1000,1000.00\n1200,700.00\n2000,-500.00\n3000,-1100.00\n3999,0.00\n4000,-200.00\n5000,100.00'
const items='source_id,source_account,source_party,direction,kind,number,issued_on,due_on,amount,currency\nINV1,1200,CUST,sales,invoice,OLD-101,2025-12-15,2026-01-15,1000.00,CAD\nCR1,1200,CUST,sales,credit_note,OLD-CR1,2026-01-02,2026-01-02,200.00,CAD\nRC1,1200,CUST,sales,unapplied,,2026-02-01,2026-02-01,100.00,CAD\nBILL1,2000,SUP,purchase,invoice,SUP-102,2026-01-10,2026-02-10,600.00,CAD\nPC1,2000,SUP,purchase,credit_note,SUP-CR1,2026-01-15,2026-01-15,50.00,CAD\nPP1,2000,SUP,purchase,unapplied,,2026-03-01,2026-03-01,50.00,CAD'
async function main() {
 r.check(importAmount('9,223,372.00','grouped_dot')===922337200n&&importAmount('-123,45','decimal_comma')===-12345n,'P3C01 exact selected money formats')
 await no('P3C02 rejects extra fractional cents','maximum two',async()=>importAmount('1.001','decimal_dot'))
 await no('P3C03 rejects ambiguous unselected grouping','selected',async()=>importAmount('1,200.00','decimal_dot'))
 r.check(importDate('0001-01-02','ISO')==='0001-01-02'&&importDate('03/04/2026','DMY')==='2026-04-03','P3C04 date format explicit and early years exact')
 await no('P3C05 impossible date refused','calendar date',async()=>importDate('2026-02-29','ISO'))
 const format=canonicalImportFormat('accounts',['source_account','name','account_type'])
 const multi=parseImportCsv('source_account,name,account_type\n1,"Two\nlines",asset\n2,Next,expense','accounts',format)
 r.check(multi.stages[1].sourceLine===4,'P3C06 multiline CSV retains physical row starts')
 await no('P3C07 unterminated quote refused','Unterminated',async()=>parseImportCsv('source_account,name,account_type\n1,"Broken,asset','accounts',format))
 await no('P3C08 embedded quote in unquoted field refused','Unexpected quote',async()=>parseImportCsv('source_account,name,account_type\n1,Bro"ken,asset','accounts',format))
 const owner=await createFirstOwner({email:'p3-owner@example.test',password:PW,firstName:'P3 owner'}),limited=await createUser({email:'p3-limited@example.test',password:PW,firstName:'P3 limited',actor:owner.email})
 const login=await signIn({email:owner.email,password:PW,clientIp:'192.0.2.80'}),user=await signIn({email:limited.email,password:PW,clientIp:'192.0.2.81'}),actor=planningActor(login.token)
 const co=await createCompany({code:'P3OPEN',name:'P3 opening isolated'},owner.email),ledger=co.ledger.id,entity=co.company.id
 await createFiscalYear(ledger,'2026-12-31',owner.email)
 const accounts=await importAccounts(entity,parseAccountsCsv(chart).map(a=>({...a,entityId:entity})),owner.email),at=(code:string)=>accounts.find(a=>a.code===code)!.id
 const cust=await createParty({kind:'organisation',name:'P3 customer',roles:[{entityId:entity,role:'customer',heldFrom:'2025-01-01'}],actor:owner.email}),sup=await createParty({kind:'organisation',name:'P3 supplier',roles:[{entityId:entity,role:'supplier',heldFrom:'2025-01-01'}],actor:owner.email})
 const input={mode:'opening' as const,sourceSystem:'Generic CSV fixture',sourceCompany:'P3-source-opening',fromDate:'2026-03-31',cutoffDate:'2026-03-31',clearingAccountId:at('3999')}
 await no('P3A01 limited user cannot start migration','owner or administrator',()=>beginImport(ledger,planningActor(user.token),input))
 const run=await beginImport(ledger,actor,input),resource:EditResource={ledgerId:ledger,type:'migration',id:run.id}
 const ordinary=()=>postEntry({ledgerId:ledger,entryDate:'2026-04-01',description:'ordinary prohibited while importing',actor:owner.email,lines:[{accountId:at('1000'),amount:100n},{accountId:at('4000'),amount:-100n}]})
 await no('P3A02 ordinary posting is blocked before activation','P3_MIGRATION_INCOMPLETE',ordinary)
 await no('P3A03 current migration makes target non-empty','new, empty',()=>beginImport(ledger,actor,input))
 const upload=async(kind:ImportFileKind,csv:string)=>uploadImportFile(ledger,run.id,actor,await proof(resource,login.token),{kind,filename:kind+'.csv',bytes:Buffer.from(csv),format:canonicalImportFormat(kind,csv.split('\n')[0].split(','))})
 await upload('accounts',accountCsv);await upload('trial_balance',tb);await upload('open_items',items)
 const missing=await validateImport(ledger,run.id,actor,await proof(resource,login.token))
 r.check(!missing.valid&&missing.issues.some(v=>v.code==='ACCOUNT_MAPPING'),'P3A04 incomplete mappings produce blocking source-row errors')
 const mapping={accounts:accounts.map(a=>({source:a.code,target:a.id})),parties:[{source:'CUST',target:cust.id},{source:'SUP',target:sup.id}]}
 const stale=await proof(resource,login.token)
 await mapImport(ledger,run.id,actor,stale,mapping)
 await no('P3A05 stale version cannot overwrite mappings','changed',()=>mapImport(ledger,run.id,actor,stale,mapping))
 await upload('trial_balance',tb.replace('1200,700.00','1200,700.01'))
 const off=await validateImport(ledger,run.id,actor,await proof(resource,login.token))
 r.check(!off.valid&&off.issues.some(v=>v.code==='TB_UNBALANCED')&&off.issues.some(v=>v.code==='CONTROL_RECONCILIATION'),'P3A06 one-cent TB and AR mismatch both block approval')
 await upload('trial_balance',tb)
 const valid=await validateImport(ledger,run.id,actor,await proof(resource,login.token))
 await no('P3A25 database freezes approved staged source facts','P3_STAGING_FROZEN',()=>db.execute(sql`UPDATE migration_stage SET data=data WHERE file_id IN (SELECT id FROM migration_file WHERE run_id=${run.id}::uuid)`))
 await no('P3A26 database prevents run identity changes','P3_RUN_IDENTITY',()=>db.execute(sql`UPDATE migration_run SET cutoff_date=cutoff_date+1 WHERE id=${run.id}::uuid`))
 await no('P3A27 database rejects skipping required run states','P3_RUN_TRANSITION',()=>db.execute(sql`UPDATE migration_run SET status='active' WHERE id=${run.id}::uuid`))
 r.check(valid.valid&&valid.tasks===7,'P3A07 fixture validates seven controlled checkpoint transactions')
 r.check(valid.openingDelta.find(v=>v.accountId===at('1200'))===undefined&&valid.openingDelta.find(v=>v.accountId===at('3999'))?.amount==='20000','P3A08 opening delta subtracts AR/AP details and clearing contribution')
 await no('P3A09 frozen staging cannot change after validation','draft',()=>upload('open_items',items))
 await no('P3A10 unreviewed digest cannot approve','Review',async()=>approveImport(ledger,run.id,actor,await proof(resource,login.token),'0'.repeat(64)))
 await approveImport(ledger,run.id,actor,await proof(resource,login.token),valid.digest)
 const before=await importDetail(ledger,run.id,actor)
 r.check(before.completed.length===0,'P3A11 approval itself posts no journal')
 await no('P3A12 activation before reconciliation is blocked','completed reconciliation',async()=>activateImport(ledger,run.id,actor,await proof(resource,login.token),valid.digest))
 const batch=await runImportBatch(ledger,run.id,actor,await proof(resource,login.token))
 r.check(batch.completed===7&&batch.remaining===0&&!!batch.reconciliation?.ok,'P3A13 actual posted fixture reconciles every account and balance cache')
 const detail=await importDetail(ledger,run.id,actor),documents=await documentsWithBalances(ledger)
 await no('P3A28 database reference owner requires controlled running transaction','P3_SOURCE_REFERENCE_OWNER',()=>db.execute(sql`INSERT INTO migration_reference(run_id,entity_id,ledger_id,source_system,source_company,source_key,source_digest,source_rows,entry_id) VALUES(${run.id}::uuid,${entity}::uuid,${ledger}::uuid,'Generic CSV fixture','P3-source-opening','bogus',${'0'.repeat(64)},'[]',${detail.completed[0].entry_id}::uuid)`))
 r.check(detail.run.status==='ready'&&detail.completed.length===7&&documents.length===4,'P3A14 ready status has seven references and four current invoice records')
 const old=documents.find(v=>v.number==='OLD-101')!
 r.check(old.issued_on==='2025-12-15'&&old.due_on==='2026-01-15'&&old.balance===100000n,'P3A15 original invoice number/dates and carried remaining amount survive')
 const arAge=await aging(ledger,'trade_receivables','2026-03-31'),apAge=await aging(ledger,'trade_payables','2026-03-31')
 r.check(arAge.totals[4]===100000n&&arAge.totals[3]===-20000n&&arAge.totals[2]===-10000n&&arAge.controlBalance===70000n,'P3A29 opening invoice, credit and unapplied receipt age by original source dates')
 r.check(apAge.totals[3]===-55000n&&apAge.totals[1]===5000n&&apAge.controlBalance===-50000n,'P3A30 opening bill, credit and prepayment retain original supplier age and exact control total')
 const [financial]=await db.execute<{revenue:string;expense:string;clearing:string}>(sql`SELECT COALESCE(SUM(jl.amount) FILTER(WHERE a.code='4000'),0)::text AS revenue,COALESCE(SUM(jl.amount) FILTER(WHERE a.code='5000'),0)::text AS expense,COALESCE(SUM(jl.amount) FILTER(WHERE a.code='3999'),0)::text AS clearing FROM journal_line jl JOIN account a ON a.id=jl.account_id WHERE a.entity_id=${entity}::uuid`)
 r.check(financial.revenue==='-20000'&&financial.expense==='10000'&&financial.clearing==='0','P3A16 opening items do not re-recognize income; clearing is zero')
 await no('P3A17 ordinary writes stay blocked in ready status','P3_MIGRATION_INCOMPLETE',ordinary)
 await no('P3A18 source reference cannot be deleted','P3_SOURCE_REFERENCE_KEPT',()=>db.execute(sql`DELETE FROM migration_reference WHERE run_id=${run.id}::uuid`))
 const source=await importSourceFile(ledger,run.id,detail.files[0].id,actor)
 r.check(Buffer.isBuffer(source.bytes)&&source.bytes.length>0,'P3A19 private original CSV is retrieved through current company authorization')
 await no('P3A20 unauthorized source download refused','permission',()=>importSourceFile(ledger,run.id,detail.files[0].id,planningActor(user.token)))
 await activateImport(ledger,run.id,actor,await proof(resource,login.token),valid.digest)
 await ordinary()
 r.check((await importDetail(ledger,run.id,actor)).run.status==='active','P3A21 explicit activation releases ordinary current-period posting')
 await recordPayment({invoiceId:old.invoice_id,bankAccountId:at('1000'),amount:10000n,paidOn:'2026-04-05',actor:owner.email})
 r.check((await documentsWithBalances(ledger)).find(v=>v.number==='OLD-101')?.balance===90000n,'P3A22 imported open invoice settles through existing payment owner')
 await no('P3A23 cannot reopen active migration','P3_ACTIVE_RUN_KEPT',()=>db.execute(sql`UPDATE migration_run SET status='draft' WHERE id=${run.id}::uuid`))
 await no('P3A24 populated target cannot start another migration','new, empty',()=>beginImport(ledger,actor,input))
 await historyAndBudget(actor,login.token,owner.email,planningActor(user.token))
 await fiscalBudgetCases(actor,login.token,owner.email)
 await bankAndCancelCases(actor,login.token,owner.email)
 await identicalSnapshots(actor,login.token,owner.email)
 await db.execute(sql`DELETE FROM document_edit_lease`)
 console.log(r.summary());if(r.failures)process.exitCode=1
}
main().catch(e=>{console.error(errorText(e));process.exitCode=1}).finally(()=>connection.end())
async function historyAndBudget(actor:ReturnType<typeof planningActor>,token:string,email:string,limited:ReturnType<typeof planningActor>) {
 const co=await createCompany({code:'P3HIST',name:'P3 history isolated'},email),ledger=co.ledger.id,entity=co.company.id
 await createFiscalYear(ledger,'2025-12-31',email);await createFiscalYear(ledger,'2026-12-31',email)
 const accounts=await importAccounts(entity,parseAccountsCsv(HISTORY_TARGET_ACCOUNTS).map(a=>({...a,entityId:entity})),email),at=(code:string)=>accounts.find(a=>a.code===code)!.id
 const cust=await createParty({kind:'organisation',name:'P3 history customer',roles:[{entityId:entity,role:'customer',heldFrom:'2025-01-01'}],actor:email}),sup=await createParty({kind:'organisation',name:'P3 history supplier',roles:[{entityId:entity,role:'supplier',heldFrom:'2025-01-01'}],actor:email})
 const run=await beginImport(ledger,actor,{mode:'history',sourceSystem:'Generic CSV fixture',sourceCompany:'P3-source-history',fromDate:'2026-01-01',cutoffDate:'2026-03-31',clearingAccountId:at('3999')}),resource:EditResource={ledgerId:ledger,type:'migration',id:run.id}
 const upload=async(kind:ImportFileKind,csv:string)=>uploadImportFile(ledger,run.id,actor,await proof(resource,token),{kind,filename:kind+'.csv',bytes:Buffer.from(csv),format:canonicalImportFormat(kind,csv.split('\n')[0].split(','))})
 for(const [kind,csv] of [['accounts',HISTORY_CHART],['starting_trial_balance',HISTORY_START],['starting_open_items',ITEM_HEADER+'\n'],['general_ledger',HISTORY_GL],['applications',HISTORY_APPS],['trial_balance',HISTORY_END],['open_items',HISTORY_OPEN]] as const)await upload(kind,csv)
 await mapImport(ledger,run.id,actor,await proof(resource,token),{accounts:accounts.map(a=>({source:a.code,target:a.id})),parties:[{source:'CUST',target:cust.id},{source:'SUP',target:sup.id}]})
 await upload('general_ledger',HISTORY_GL.split('\n').filter(l=>!l.includes('2026-01-05,2100')).join('\n'))
 const truncated=await validateImport(ledger,run.id,actor,await proof(resource,token))
 r.check(!truncated.valid&&truncated.issues.some(i=>i.code==='TRUNCATED_GROUP')&&truncated.issues.some(i=>i.code==='GL_UNBALANCED'),'P3H01 truncated source transaction blocks complete grouping and balance')
 await upload('general_ledger',HISTORY_GL.replace('600.00,CAD','600.00,USD'))
 const currency=await validateImport(ledger,run.id,actor,await proof(resource,token))
 r.check(!currency.valid&&currency.issues.some(i=>i.code==='CURRENCY'),'P3H02 mixed-currency history cannot silently post at target currency')
 await upload('general_ledger',HISTORY_GL)
 await upload('open_items',HISTORY_OPEN.replace('400.00,CAD','401.00,CAD'))
 const badOpen=await validateImport(ledger,run.id,actor,await proof(resource,token))
 r.check(!badOpen.valid&&badOpen.issues.some(i=>i.code==='OPEN_SNAPSHOT'),'P3H03 cutoff item must equal remaining historical debt after applications')
 await upload('open_items',HISTORY_OPEN)
 const bankHeader='source_id,source_account,date,amount,currency,number,description\n'
 await upload('starting_bank_open_items',bankHeader+'INV1,1000,2025-12-20,1.00,CAD,DUP-ID,Source identity collision')
 const overlap=await validateImport(ledger,run.id,actor,await proof(resource,token))
 r.check(!overlap.valid&&overlap.issues.some(i=>i.code==='SOURCE_OVERLAP'),'P3H18 starting bank/source transaction ID overlap still blocks history replay')
 await upload('starting_bank_open_items',bankHeader)
 const valid=await validateImport(ledger,run.id,actor,await proof(resource,token))
 r.check(valid.valid&&valid.tasks===13,'P3H04 fixed complete history validates opening plus eight transactions and four applications',JSON.stringify(valid.issues.filter(i=>i.level==='error')))
 const d=await importDetail(ledger,run.id,actor)
 r.check(d.files.find(f=>f.kind==='general_ledger')?.excluded_rows.length===2,'P3H05 subtotal and opening display rows are explicitly excluded and retained')
 await approveImport(ledger,run.id,actor,await proof(resource,token),valid.digest)
 const first=await runImportBatch(ledger,run.id,actor,await proof(resource,token))
 r.check(first.completed===12&&first.remaining===1&&!first.reconciliation,'P3H06 complete-source chunk is bounded and stops before final application')
 const [checkpoint]=await db.execute<{entries:number;refs:number}>(sql`SELECT (SELECT count(*)::int FROM journal_entry WHERE ledger_id=${ledger}::uuid) AS entries,(SELECT count(*)::int FROM migration_reference WHERE run_id=${run.id}::uuid) AS refs`)
 r.check(checkpoint.entries===9&&checkpoint.refs===12,'P3H07 committed references and journals are atomic; ending TB was not posted')
 await db.execute(sql`CREATE FUNCTION p3_test_refuse_application() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'P3_TEST_CHECKPOINT_REFUSAL'; END $$`)
 await db.execute(sql`CREATE TRIGGER p3_test_refuse BEFORE INSERT ON invoice_application FOR EACH ROW EXECUTE FUNCTION p3_test_refuse_application()`)
 try {
  await no('P3H12 actual database refusal rolls back the remaining chunk','P3_TEST_CHECKPOINT_REFUSAL',async()=>runImportBatch(ledger,run.id,actor,await proof(resource,token)))
  const failed=await importDetail(ledger,run.id,actor)
  r.check(failed.run.status==='failed'&&failed.completed.length===12&&!!failed.run.last_error&&Array.isArray(failed.run.validation.failedRows),'P3H13 failed chunk retains twelve prior checkpoints and explicit failed source rows')
 } finally {
  await db.execute(sql`DROP TRIGGER p3_test_refuse ON invoice_application`);await db.execute(sql`DROP FUNCTION p3_test_refuse_application()`)
 }
 const second=await runImportBatch(ledger,run.id,actor,await proof(resource,token))
 r.check(second.completed===1&&second.remaining===0&&!!second.reconciliation?.ok,'P3H08 resume commits only the remaining application and reconciles')
 const actual=await db.execute<{code:string;amount:string}>(sql`SELECT a.code,COALESCE(sum(jl.amount),0)::text AS amount FROM account a LEFT JOIN journal_line jl ON jl.account_id=a.id WHERE a.entity_id=${entity}::uuid GROUP BY a.id,a.code ORDER BY a.code`)
 r.check(actual.every(a=>EXPECTED_HISTORY_CENTS[a.code as keyof typeof EXPECTED_HISTORY_CENTS]===a.amount),'P3H09 ending amounts equal independently fixed expected cents for all nine accounts')
 const docs=await documentsWithBalances(ledger)
 r.check(docs.find(i=>i.number==='H-INV1')?.balance===40000n&&docs.find(i=>i.number==='H-BILL1')?.balance===20000n,'P3H10 historical invoices and bills retain partial unpaid balances')
 await activateImport(ledger,run.id,actor,await proof(resource,token),valid.digest)
 await recordPayment({invoiceId:docs.find(i=>i.number==='H-INV1')!.invoice_id,bankAccountId:at('1000'),amount:10000n,paidOn:'2026-04-01',actor:email})
 r.check((await documentsWithBalances(ledger)).find(i=>i.number==='H-INV1')?.balance===30000n,'P3H11 historical open invoice can use normal post-activation settlement')
 const [fy]=await db.execute<{id:string}>(sql`SELECT id::text FROM fiscal_year WHERE ledger_id=${ledger}::uuid AND end_date='2026-12-31'`)
 const budget=await createBudget(ledger,actor,{fiscalYearId:fy.id,name:'P3 baseline budget'}),br:EditResource={ledgerId:ledger,type:'budget',id:budget.id}
 const initial=await budgetDetail(ledger,budget.id,actor),jan=initial.periods[0],feb=initial.periods[1],mar=initial.periods[2]
 r.check(initial.periods.length===12&&initial.actual.values.find(v=>v.accountId===at('4000')&&v.periodId===jan.id)?.amount==='100000','P3B01 actual revenue uses shared current P&L period figures')
 const statement=await renderStatement(ledger,'IFRS_PL_NATURE_EN',mar.id,jan.id)
 const profit=initial.actual.values.filter(v=>[jan.id,feb.id,mar.id].includes(v.periodId)).reduce((n,v)=>n+BigInt(v.amount)*(v.accountId===at('4000')?1n:-1n),0n)
 r.check(statement?.lines.find(l=>l.code==='PFY')?.shown===profit&&profit===19000n,'P3B02 quarterly actual profit equals existing same-range P&L and fixed 190.00')
 const monthly=await Promise.all([jan,feb,mar].map(p=>renderStatement(ledger,'IFRS_PL_NATURE_EN',p.id)))
 r.check(monthly.map(s=>s?.lines.find(l=>l.code==='PFY')?.shown.toString()).join(',')==='50000,-10000,-21000','P3H14 imported monthly P&L equals independent January/February/March 500/-100/-210')
 const bs=await renderStatement(ledger,'IFRS_SFP_EN',mar.id,jan.id)
 r.check(bs?.lines.find(l=>l.code==='TA')?.raw===141000n&&bs?.lines.find(l=>l.code==='TLE')?.raw===-141000n&&!bs.problems.length,'P3H15 imported balance sheet equals fixed 1410.00 assets and liabilities/equity')
 const histAR=await aging(ledger,'trade_receivables','2026-03-31'),histAP=await aging(ledger,'trade_payables','2026-03-31')
 r.check(histAR.controlBalance===28000n&&histAR.totals.reduce((a,b)=>a+b,0n)===28000n&&histAP.controlBalance===-14000n&&histAP.totals.reduce((a,b)=>a+b,0n)===-14000n,'P3H16 historical aging and open-item totals equal fixed AR/AP control balances')
 r.check(spreadCents(10001n,12).reduce((a,b)=>a+b,0n)===10001n&&spreadCents(-10001n,12).reduce((a,b)=>a+b,0n)===-10001n,'P3B03 annual spreading preserves positive/negative rounding remainder')
 r.check(budgetVariance('revenue',550000n,500000n).favorable===50000n&&budgetVariance('revenue',550000n,500000n).percentageBasisPoints===1000n,'P3B04 revenue variance is +500 / +10%')
 r.check(budgetVariance('expense',120000n,100000n).favorable===-20000n&&budgetVariance('expense',120000n,100000n).percentageBasisPoints===-2000n&&budgetVariance('profit',1n,0n).percentageBasisPoints===null,'P3B05 expense variance is -200 / -20%; zero budget has no percentage')
 const op:BudgetOperation={kind:'spread',accountId:at('4000'),annualAmount:'600001'},p=await previewBudget(ledger,budget.id,actor,op)
 r.check(p.changes.length===12&&p.overwrites===0&&(await budgetDetail(ledger,budget.id,actor)).lines.length===0,'P3B06 spread preview changes no saved budget or GL')
 await no('P3B17 database rejects balance-sheet budget accounts','P3_BUDGET_LINE_SCOPE',()=>db.execute(sql`INSERT INTO budget_line(budget_id,account_id,period_id,amount) VALUES(${budget.id}::uuid,${at('1000')}::uuid,${jan.id}::uuid,100)`))
 const savedProof=await proof(br,token)
 await applyBudgetPreview(ledger,budget.id,actor,savedProof,op,p.digest)
 await no('P3B07 stale budget editor cannot overwrite cells','changed',()=>applyBudgetPreview(ledger,budget.id,actor,savedProof,op,p.digest))
 const percent:BudgetOperation={kind:'percent',accountIds:[at('4000')],periodIds:[jan.id,feb.id],basisPoints:1000},pp=await previewBudget(ledger,budget.id,actor,percent)
 r.check(pp.overwrites===2&&pp.changes.every(v=>v.before!==null),'P3B08 percentage preview names exactly the two cells being overwritten')
 await no('P3B09 unreviewed preview digest cannot save','fresh preview',async()=>applyBudgetPreview(ledger,budget.id,actor,await proof(br,token),percent,'0'.repeat(64)))
 await applyBudgetPreview(ledger,budget.id,actor,await proof(br,token),percent,pp.digest)
 const pre=await previewBudget(ledger,budget.id,actor,{kind:'prefill'})
 r.check(pre.changes.length===0&&pre.warnings.length>=12,'P3B10 missing prior history does not fabricate zero prefill')
 await changeBudgetState(ledger,budget.id,actor,await proof(br,token),'published')
 await no('P3B11 published budget rejects domain edits','new draft',()=>previewBudget(ledger,budget.id,actor,percent))
 await no('P3B12 database retains published facts even for raw SQL','P3_PUBLISHED_BUDGET_IMMUTABLE',()=>db.execute(sql`UPDATE budget_line SET amount=1 WHERE budget_id=${budget.id}::uuid`))
 await no('P3B18 database keeps the published header immutable','P3_PUBLISHED_BUDGET_IMMUTABLE',()=>db.execute(sql`UPDATE budget SET name='Unreviewed change' WHERE id=${budget.id}::uuid`))
 const copy=await createBudget(ledger,actor,{fiscalYearId:fy.id,name:'P3 revised draft',copyFromId:budget.id})
 r.check((await budgetDetail(ledger,copy.id,actor)).lines.length===12&&(await budgetDetail(ledger,budget.id,actor)).budget.status==='published','P3B13 published version copies into separately editable draft')
 const cr:EditResource={ledgerId:ledger,type:'budget',id:copy.id},concurrentProof=await proof(cr,token)
 const left:BudgetOperation={kind:'manual',cells:[{accountId:at('4000'),periodId:jan.id,amount:'11100'}]},right:BudgetOperation={kind:'manual',cells:[{accountId:at('4000'),periodId:jan.id,amount:'22200'}]}
 const lp=await previewBudget(ledger,copy.id,actor,left),rp=await previewBudget(ledger,copy.id,actor,right)
 const pair=await Promise.allSettled([applyBudgetPreview(ledger,copy.id,actor,concurrentProof,left,lp.digest),applyBudgetPreview(ledger,copy.id,actor,concurrentProof,right,rp.digest)])
 r.check(pair.filter(v=>v.status==='fulfilled').length===1&&pair.some(v=>v.status==='rejected'&&errorText(v.reason).includes('changed')),'P3B19 concurrent same-version saves commit exactly one and reject the other')
 const current=await budgetDetail(ledger,copy.id,actor)
 await no('P3B20 missing edit lease cannot save a current budget','lease',()=>applyBudgetPreview(ledger,copy.id,actor,{sessionToken:token,proof:{version:current.budget.version},leaseRequired:true},left,lp.digest))
 await no('P3B14 current permission guards budget reads','permission',()=>budgetDetail(ledger,budget.id,limited))
 const plan=await db.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statementFiguresQuery(ledger,initial.periods.map(p=>({id:p.id,fromId:p.id,throughId:p.id})))}`)
 const {writeFileSync}=await import('node:fs');writeFileSync('docs/evidence/p3/budget-query-plan.json',JSON.stringify(plan,null,2))
 r.check(plan.length===1,'P3B15 real batch actual query plan captured for all fiscal periods')
 const [financial]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM journal_entry WHERE ledger_id=${ledger}::uuid`)
 r.check(financial.n===10,'P3B16 budget create/preview/apply/publish/copy never posts GL')
}

async function fiscalBudgetCases(actor:ReturnType<typeof planningActor>,token:string,email:string) {
 const co=await createCompany({code:'P3NONDEC',name:'P3 non-December fiscal fixture'},email),ledger=co.ledger.id
 await createFiscalYear(ledger,'2025-09-30',email);await createFiscalYear(ledger,'2026-09-30',email)
 const accounts=await importAccounts(co.company.id,parseAccountsCsv(chart).map(a=>({...a,entityId:co.company.id})),email),at=(c:string)=>accounts.find(a=>a.code===c)!.id
 await postEntry({ledgerId:ledger,entryDate:'2025-01-10',description:'Fixed previous January revenue',actor:email,lines:[{accountId:at('1000'),amount:550000n},{accountId:at('4000'),amount:-550000n}]})
 await postEntry({ledgerId:ledger,entryDate:'2025-01-11',description:'Fixed previous January expense',actor:email,lines:[{accountId:at('5000'),amount:120000n},{accountId:at('1000'),amount:-120000n}]})
 const [fy]=await db.execute<{id:string}>(sql`SELECT id::text FROM fiscal_year WHERE ledger_id=${ledger}::uuid AND end_date='2026-09-30'`)
 const b=await createBudget(ledger,actor,{fiscalYearId:fy.id,name:'Non-December draft'}),d=await budgetDetail(ledger,b.id,actor)
 r.check(d.periods[0].start_date==='2025-10-01'&&d.periods.at(-1)?.end_date==='2026-09-30','P3B21 fiscal matrix follows October–September boundaries')
 const p=await previewBudget(ledger,b.id,actor,{kind:'prefill'}),jan=d.periods.find(p=>p.start_date==='2026-01-01')!
 r.check(p.changes.find(v=>v.accountId===at('4000')&&v.periodId===jan.id)?.amount==='550000'&&p.changes.find(v=>v.accountId===at('5000')&&v.periodId===jan.id)?.amount==='120000','P3B22 prior actual prefill maps comparable January, not calendar column ordinal')
 await applyBudgetPreview(ledger,b.id,actor,await proof({ledgerId:ledger,type:'budget',id:b.id},token),{kind:'prefill'},p.digest)
 r.check((await budgetDetail(ledger,b.id,actor)).lines.length===24,'P3B23 complete prior fiscal coverage fills two accounts across actual twelve periods')
 const short=await createCompany({code:'P3SHORT',name:'P3 actual short-fiscal-year fixture'},email)
 const [shortYear]=await actingAs(email,async tx=>{
  const [fy]=await tx.execute<{id:string}>(sql`INSERT INTO fiscal_year(ledger_id,name,start_date,end_date) VALUES(${short.ledger.id}::uuid,'Short FY2026','2026-10-01','2026-12-31') RETURNING id::text`)
  for(const [i,start,end] of [[1,'2026-10-01','2026-10-31'],[2,'2026-11-01','2026-11-30'],[3,'2026-12-01','2026-12-31']] as const)await tx.execute(sql`INSERT INTO fiscal_period(ledger_id,fiscal_year_id,period_no,name,start_date,end_date) VALUES(${short.ledger.id}::uuid,${fy.id}::uuid,${i},${start.slice(0,7)},${start}::date,${end}::date)`)
  return [fy]
 })
 const shortAccounts=await importAccounts(short.company.id,parseAccountsCsv(chart).map(a=>({...a,entityId:short.company.id})),email),sb=await createBudget(short.ledger.id,actor,{fiscalYearId:shortYear.id,name:'Three real fiscal months'})
 const sd=await budgetDetail(short.ledger.id,sb.id,actor),sp=await previewBudget(short.ledger.id,sb.id,actor,{kind:'spread',accountId:shortAccounts.find(a=>a.code==='4000')!.id,annualAmount:'10001'})
 r.check(sd.periods.length===3&&sp.changes.map(c=>c.amount).sort().join(',')==='3333,3334,3334','P3B24 short-year matrix and exact spread use three actual fiscal periods')
}

async function bankAndCancelCases(actor:ReturnType<typeof planningActor>,token:string,email:string) {
 const co=await createCompany({code:'P3BANK',name:'P3 outstanding bank fixture'},email),ledger=co.ledger.id
 await createFiscalYear(ledger,'2026-12-31',email)
 const accounts=await importAccounts(co.company.id,parseAccountsCsv(chart).map(a=>({...a,entityId:co.company.id})),email),at=(code:string)=>accounts.find(a=>a.code===code)!.id
 const input={mode:'opening' as const,sourceSystem:'Generic CSV fixture',sourceCompany:'P3-source-bank',fromDate:'2026-03-31',cutoffDate:'2026-03-31',clearingAccountId:at('3999')}
 const cancelled=await beginImport(ledger,actor,input),cancelResource:EditResource={ledgerId:ledger,type:'migration',id:cancelled.id}
 await cancelImportDraft(ledger,cancelled.id,actor,await proof(cancelResource,token))
 r.check((await importDetail(ledger,cancelled.id,actor)).run.status==='cancelled','P3X01 cancel preserves uncommitted source facts and releases the migration target')
 const run=await beginImport(ledger,actor,input),resource:EditResource={ledgerId:ledger,type:'migration',id:run.id}
 const upload=async(kind:ImportFileKind,csv:string)=>uploadImportFile(ledger,run.id,actor,await proof(resource,token),{kind,filename:kind+'.csv',bytes:Buffer.from(csv),format:canonicalImportFormat(kind,csv.split('\n')[0].split(','))})
 await upload('accounts',accountCsv);await upload('trial_balance','source_account,amount\n1000,1000.00\n3000,-1000.00');await upload('open_items',ITEM_HEADER+'\n')
 const bank='source_id,source_account,date,amount,currency,number,description\nDEP1,1000,2026-03-25,200.00,CAD,DEP-01,Outstanding deposit\nCHQ1,1000,2026-03-26,-50.00,CAD,CHQ-01,Unpresented cheque'
 await upload('bank_open_items',bank.replace('DEP1,1000','DEP1,5000'))
 await mapImport(ledger,run.id,actor,await proof(resource,token),{accounts:accounts.map(a=>({source:a.code,target:a.id})),parties:[]})
 const wrong=await validateImport(ledger,run.id,actor,await proof(resource,token));r.check(!wrong.valid&&wrong.issues.some(i=>i.code==='BANK_ACCOUNT'),'P3K01 expense account cannot masquerade as outstanding bank book item')
 await upload('bank_open_items',bank.replace('2026-03-25','2026-04-01'))
 const late=await validateImport(ledger,run.id,actor,await proof(resource,token));r.check(!late.valid&&late.issues.some(i=>i.code==='BANK_DATE'),'P3K02 post-snapshot outstanding bank item blocks validation')
 await upload('bank_open_items',bank)
 const valid=await validateImport(ledger,run.id,actor,await proof(resource,token))
 r.check(valid.valid&&valid.tasks===3&&valid.openingDelta.find(v=>v.accountId===at('1000'))?.amount==='85000'&&valid.coverage.bankReconciliation==='partial','P3K03 opening delta deducts signed bank details and labels partial coverage')
 await approveImport(ledger,run.id,actor,await proof(resource,token),valid.digest)
 const batch=await runImportBatch(ledger,run.id,actor,await proof(resource,token));r.check(!!batch.reconciliation?.ok,'P3K04 outstanding bank entries reconcile exact TB without new income')
 await no('P3X02 committed migration cannot be cancelled','uncommitted',async()=>cancelImportDraft(ledger,run.id,actor,await proof(resource,token)))
 await activateImport(ledger,run.id,actor,await proof(resource,token),valid.digest)
 await importBankRows({accountId:at('1000'),rows:[{date:'2026-04-02',amount:20000n,description:'Outstanding deposit cleared'}],actor:email})
 const [row]=await bankRows(at('1000')),detail=await importDetail(ledger,run.id,actor),entry=detail.completed.find(c=>c.source_key==='source:DEP1')!.entry_id!
 r.check((await candidateEntries(row.id)).some(c=>c.entry_id===entry),'P3K05 individual outstanding bank entry uses existing matching candidates')
 await matchEntry({bankTransactionId:row.id,entryId:entry,actor:email})
 const [facts]=await db.execute<{n:number;date:string}>(sql`SELECT (SELECT count(*)::int FROM journal_entry WHERE ledger_id=${ledger}::uuid) AS n,original_issued_on::text AS date FROM migration_reference WHERE run_id=${run.id}::uuid AND source_key='source:DEP1'`)
 r.check(facts.n===3&&facts.date==='2026-03-25'&&(await bankRows(at('1000')))[0].state==='matched','P3K06 bank matching keeps three GL records and original source transaction date')
}

async function identicalSnapshots(actor:ReturnType<typeof planningActor>,token:string,email:string) {
 const co=await createCompany({code:'P3SAME',name:'P3 identical snapshot fixture'},email),ledger=co.ledger.id
 await createFiscalYear(ledger,'2025-12-31',email);await createFiscalYear(ledger,'2026-12-31',email)
 const accounts=await importAccounts(co.company.id,parseAccountsCsv(chart).map(a=>({...a,entityId:co.company.id})),email),run=await beginImport(ledger,actor,{mode:'history',sourceSystem:'Generic CSV fixture',sourceCompany:'P3 identical snapshots',fromDate:'2026-01-01',cutoffDate:'2026-03-31',clearingAccountId:accounts.find(a=>a.code==='3999')!.id}),resource:EditResource={ledgerId:ledger,type:'migration',id:run.id}
 const sameTB='source_account,amount\n1000,1000.00\n3000,-1000.00'
 for(const [kind,csv] of [['accounts',accountCsv],['starting_trial_balance',sameTB],['trial_balance',sameTB],['starting_open_items',ITEM_HEADER+'\n'],['open_items',ITEM_HEADER+'\n'],['general_ledger','source_id,expected_lines,date,source_account,amount,currency,document_type,description\n'],['applications','source_id,source_transaction_id,target_document_id,amount\n']] as const)await uploadImportFile(ledger,run.id,actor,await proof(resource,token),{kind,filename:kind+'.csv',bytes:Buffer.from(csv),format:canonicalImportFormat(kind,csv.split('\n')[0].split(','))})
 await mapImport(ledger,run.id,actor,await proof(resource,token),{accounts:accounts.map(a=>({source:a.code,target:a.id})),parties:[]})
 const valid=await validateImport(ledger,run.id,actor,await proof(resource,token))
 r.check(valid.valid&&valid.tasks===1,'P3H17 identical starting/cutoff TB and empty open-item snapshots validate without double posting')
 if(!valid.valid)throw Error('Identical snapshots failed validation: '+valid.issues.map(i=>i.code).join(','))
 await approveImport(ledger,run.id,actor,await proof(resource,token),valid.digest)
 const batch=await runImportBatch(ledger,run.id,actor,await proof(resource,token)),[entry]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM journal_entry WHERE ledger_id=${ledger}::uuid`)
 r.check(!!batch.reconciliation?.ok&&entry.n===1,'P3H19 identical cutoff snapshot checks the one starting entry and adds no duplicate GL')
}

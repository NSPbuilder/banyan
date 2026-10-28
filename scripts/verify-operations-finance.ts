import './env'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {sql as q} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner,createUser} from '../src/lib/users'
import {createCompanyWithYear,createFiscalYear} from '../src/lib/setup'
import {importAccounts,parseAccountsCsv} from '../src/lib/accounts'
import {STARTER_CHART} from '../src/lib/starter-chart'
import {fixtureAsset} from './operations-fixture'
import {saveAssetFinance} from '../src/lib/asset-finance'
import {saveAsset,assetRows} from '../src/lib/assets'
import {depreciationAssets,depreciationPreview,runDepreciation,adjustDepreciation,saveDepreciationPolicy,planDepreciation} from '../src/lib/depreciation'
import {ccaRegister,ccaPreview,recordCcaYear} from '../src/lib/cca'
import {deferredTaxPreview,recordDeferredTaxReview} from '../src/lib/deferred-tax'
import {initializeOperationsFinance,connectOperationsFinance,financeAccounts,updateFinanceSettings,financeSetting} from '../src/lib/operations-finance'
import {operationsReconciliation,operationsLatestDate,reconciliationHash,operationsJournalEvents} from '../src/lib/operations-reconciliation'
import type {OperationsSeat} from '../src/lib/operations-finance-types'
import {postEntry,reverseEntry} from '../src/lib/posting'
import {saveInventoryItem,inventoryWarehouses,recordStockMovement,saveInventorySettings} from '../src/lib/inventory'
import {saveBom,createProductionOrder,productionOrderDetail,recordProductionEvent,type ProductionAction} from '../src/lib/production'
import {createParty} from '../src/lib/parties'
import {saveEmployee} from '../src/lib/payroll/employees'
import {runPayroll,payRunDetail} from '../src/lib/payroll/runs'
import {recordProductionTime,allocateProductionPayroll,reverseProductionPayroll,productionPayrollOptions} from '../src/lib/production-payroll'
import {exportCompany,restoreCompany} from '../src/lib/backup'
import {setGrants} from '../src/lib/access'
import {closePeriod,periodOverview} from '../src/lib/periods'
import {assetFinanceSchedules,ccaBookClaimSuggestion} from '../src/lib/asset-schedules'
import {productionReport} from '../src/lib/production-report'
import {allocationCeiling} from '../src/lib/production-payroll-math'
import {csvFile} from '../src/lib/csv'
import {errorText} from './suite'
import {parseQuantity as Q} from '../src/lib/quantity'
const refuse=async(code:string,fn:()=>Promise<unknown>)=>assert.rejects(fn,(e:unknown)=>(e as {code:string}).code===code)
const dbRefuse=async(code:string,fn:()=>Promise<unknown>)=>assert.rejects(fn,(e:unknown)=>errorText(e).includes(code))
async function main(){
 const me=await createFirstOwner({email:'operations-finance@example.test',firstName:'Finance integration',password:'Independent financial integration test phrase'})
 const company=await createCompanyWithYear({code:'OPFIN',name:'Operations finance'},me.email),l=company.ledger.id
 const accounts=await importAccounts(company.company.id,parseAccountsCsv(STARTER_CHART).map(r=>({...r,entityId:company.company.id})),me.email)
 const ids=Object.fromEntries(accounts.map(a=>[a.code,a.id])),cash=ids['1002'],equity=ids['3500']
 const setup=async(seat:OperationsSeat,date='2026-01-01')=>{
  await initializeOperationsFinance(me,l,seat)
  const rows=await operationsReconciliation(l,seat,date),latest=await operationsLatestDate(l,seat)
  return connectOperationsFinance(me,l,seat,{date,fundingAccountId:cash,openingAccountId:equity,expectedHash:reconciliationHash(rows,date,latest),taxRateBp:2500,taxRateNote:'Test assumption: reviewed enacted reversal rate 25%',ccaStrategy:'maximum'})
 }
 const checkDay=async(seat:OperationsSeat,date:string)=>{const rows=await operationsReconciliation(l,seat,date);assert(rows.every(r=>r.difference==='0'),JSON.stringify(rows));return rows}
 const opening=await setup('/assets');assert.equal(opening.entryId,null)
 const book={version:0,method:'straight_line' as const,startDate:'2026-01-01',residualValue:0n,lifeMonths:36,annualRateBp:2000}
 const tax={version:0,taxCost:300000n,availableOn:'2026-01-01',rule:'riip' as const,eligibilityNote:'Eligible arm’s-length computer; business use 100%, CAD',disposedOn:'',proceeds:0n}
 const input={...fixtureAsset,code:'PC-01',acquiredOn:'2026-01-01',inServiceOn:'2026-01-01',acquisitionCost:300000n}
 await refuse('POLICY',()=>saveAssetFinance(me,l,input,book))
 const assetRequest={group:'computer' as const,ccaClass:'50',counterpartAccountId:cash,recoverableTax:15000n,taxAccountId:ids['1066'],requestKey:randomUUID()}
 const a=await saveAssetFinance(me,l,input,book,tax,assetRequest)
 assert.equal(await saveAssetFinance(me,l,input,book,tax,assetRequest),a)
 await refuse('REPLAY',()=>saveAssetFinance(me,l,{...input,acquisitionCost:310000n},book,tax,assetRequest))
 await checkDay('/assets','2026-01-01')
 const af=await financeAccounts(l,'/assets'),computer=af.find(a=>a.key==='computer')!.account_id!
 await dbRefuse('OPERATIONS_RECONCILIATION',()=>postEntry({ledgerId:l,entryDate:'2026-02-01',description:'Unrelated manual asset post',lines:[{accountId:computer,amount:100n},{accountId:cash,amount:-100n}]}))
 await dbRefuse('OPERATIONS_FINANCIAL_HISTORY',()=>db.execute(q`UPDATE fixed_asset SET acquisition_cost=300001 WHERE id=${a}::uuid`))
 const [je]=await db.execute<{entry_id:string}>(q`SELECT entry_id::text FROM operations_journal_event WHERE source_kind='asset_acquisition' AND source_id=${a}::uuid`)
 await refuse('OPERATIONS_SOURCE',()=>reverseEntry(je.entry_id,'2026-02-01','Direct reversal attempt',me.email))
 const dep=async(date:string)=>{const p=depreciationPreview(await depreciationAssets(l),date);return runDepreciation(me,l,{through:date,key:randomUUID(),expectedHash:p.hash})}
 assert.equal(await dep('2026-12-31'),12);await checkDay('/assets','2026-06-30');await checkDay('/assets','2026-12-31')
 const reg=await ccaRegister(l),pool=reg.pools[0].id,yearInput={poolId:pool,startDate:'2026-01-01',endDate:'2026-12-31',adjustment:0n,poolClosed:false},cp=await ccaPreview(l,yearInput)
 assert.equal(cp.maximum,300000n)
 const cy=await recordCcaYear(me,l,{...yearInput,claim:cp.maximum,note:'Annual eligibility and deductions reviewed',key:randomUUID(),expectedHash:cp.hash})
 const dt={ccaYearId:cy,rateBp:2500,rateNote:'Test enacted rate 25%',bookAdjustment:0n,taxAdjustment:0n,recognizedAsset:0n,openingLiability:0n,openingAsset:0n,recognition:'profit_loss' as const,scopeReviewed:true,note:'All pool assets and recovery through use reviewed'}
 const dp=await deferredTaxPreview(l,dt),request={...dt,key:randomUUID(),expectedHash:dp.hash},review=await recordDeferredTaxReview(me,l,request)
 assert.equal(await recordDeferredTaxReview(me,l,request),review);assert.equal(dp.liability,50001n)
 const drows=await checkDay('/assets','2026-12-31');assert.equal(drows.find(r=>r.key==='deferred_liability')!.gl_amount,'-50001')
 await createFiscalYear(l,'2027-12-31',me.email)
 await adjustDepreciation(me,l,{assetId:a,date:'2027-01-01',amount:-100n,note:'Reviewed signed book correction',key:randomUUID()});await checkDay('/assets','2027-01-01')
 await saveAssetFinance(me,l,{...input,id:a,version:1,status:'disposed',disposedOn:'2027-01-31',disposalProceeds:180000n},undefined,undefined,{group:'computer',counterpartAccountId:cash})
 assert.equal((await depreciationAssets(l)).find(x=>x.id===a)!.net_book_value,'0')
 const disposed=await checkDay('/assets','2027-01-31');assert.equal(disposed.find(r=>r.key==='computer')!.gl_amount,'0');assert.equal(disposed.find(r=>r.key==='computer_accumulated')!.gl_amount,'0')
 console.log('PASS  OF01 fixed assets GL   acquisition/tax, mandatory policies, monthly depreciation, annual DT, signed adjustment, disposal and daily balances')
 await setup('/inventory')
 await saveInventorySettings(me,l,{version:0,warehousesEnabled:false,costMethod:'fifo'})
 const item=(sku:string,kind:string)=>saveInventoryItem(me,l,{sku,name:sku,kind,unit:'each',reorderLevel:0n,trackBatches:false,trackSerials:false,isActive:true,notes:''})
 const raw=await item('RAW','raw_material'),fg=await item('FG','finished_goods'),main=(await inventoryWarehouses(l))[0].id
 const stock={itemId:raw,kind:'receipt' as const,date:'2026-01-01',quantity:Q('10'),cost:10000n,fromWarehouseId:'',toWarehouseId:main,batch:'',serials:[],reference:'Invoice 1',note:'',key:randomUUID(),finance:{counterpartAccountId:cash}}
 const receipt=await recordStockMovement(me,l,stock);assert.equal(await recordStockMovement(me,l,stock),receipt)
 await refuse('REPLAY',()=>recordStockMovement(me,l,{...stock,finance:{counterpartAccountId:equity}}));await checkDay('/inventory','2026-01-01')
 const bom=await saveBom(me,l,{code:'BOM',name:'Saved frame formula',outputItemId:fg,outputQuantity:Q('1'),components:[{itemId:raw,quantity:Q('2')}],notes:'',isActive:true})
 const order=await createProductionOrder(me,l,{bomId:bom,quantity:Q('2'),warehouseId:main,startDate:'2026-01-02',dueDate:'',notes:'',key:randomUUID()})
 const event=async(patch:Partial<ProductionAction>)=>recordProductionEvent(me,l,{orderId:order,version:(await productionOrderDetail(l,order))!.order.version,kind:'material_issue',date:'2026-01-02',itemId:raw,sourceEventId:'',quantity:0n,cost:0n,batch:'',serials:[],note:'',key:randomUUID(),...patch})
 await event({quantity:Q('4')});const day2=await checkDay('/inventory','2026-01-02');assert.equal(day2.find(r=>r.key==='wip')!.gl_amount,'4000')
 const person=await createParty({kind:'person',name:'Production employee',roles:[{entityId:company.company.id,role:'employee',heldFrom:'2026-01-01'}],actor:me.email})
 const employee=await saveEmployee({ledgerId:l,partyId:person.id,frequency:'semi_monthly',hiredOn:'2026-01-01',actor:me.email})
 const pay=await runPayroll({ledgerId:l,payDate:'2026-01-15',periodStart:'2026-01-01',periodEnd:'2026-01-15',bankAccountId:cash,lines:[{employeeId:employee.id,gross:100000n,hours:4000n}],actor:me.email})
 const stub=(await payRunDetail(l,pay.runId))!.stubs[0].id
 const time=await recordProductionTime(me,l,{orderId:order,employeeId:employee.id,date:'2026-01-02',hours:400n,note:'Assembly work',key:randomUUID()})
 await refuse('LABOUR_PENDING',()=>event({kind:'completion',quantity:Q('1')}))
 await refuse('DATE',()=>allocateProductionPayroll(me,l,{timeId:time,payStubId:stub,date:'2026-01-14',key:randomUUID()}))
 const allocation=await allocateProductionPayroll(me,l,{timeId:time,payStubId:stub,date:'2026-01-15',key:randomUUID()})
 await refuse('PAYROLL_ALLOCATED',()=>reverseEntry(pay.entryId,'2026-01-15','Original payroll reversal',me.email))
 const options=await productionPayrollOptions(me,l,order),labour=options.time[0];assert.equal(labour.gross_cost,'10000');assert(BigInt(labour.employer_cost!)>0n)
 await reverseProductionPayroll(me,l,{allocationId:allocation,date:'2026-01-15',reason:'Correct eligible production cost',key:randomUUID()})
 await checkDay('/inventory','2026-01-15')
 await allocateProductionPayroll(me,l,{timeId:time,payStubId:stub,date:'2026-01-15',grossCost:9000n,employerCost:0n,key:randomUUID()})
 await event({kind:'completion',date:'2026-01-15',quantity:Q('1')});await checkDay('/inventory','2026-01-15')
 await event({kind:'completion',date:'2026-01-16',quantity:Q('1')});await checkDay('/inventory','2026-01-16')
 assert.equal((await productionOrderDetail(l,order))!.order.wip_cost,'0')
 const active=(await productionPayrollOptions(me,l,order)).time[0].allocation_id!
 await refuse('LABOUR_CONSUMED',()=>reverseProductionPayroll(me,l,{allocationId:active,date:'2026-01-16',reason:'Attempt after completion',key:randomUUID()}))
 assert.equal((await operationsJournalEvents(l,'/inventory','2026-01-01','2026-01-16')).length,8)
 console.log('PASS  OF02 production + payroll   FIFO, raw/WIP/FG, exact source journals, pending time, pay-period/hours, expense reclassification, reversible allocation and consumed-cost refusal')
 const file=await exportCompany(company.company.id),restored=await restoreCompany(file,me.email,{code:'OPCOPY',name:'Restored operations finance'})
 for(const seat of ['/assets','/inventory'] as const)assert((await operationsReconciliation(restored.ledgerId!,seat,'2027-01-31')).every(r=>r.difference==='0'))
 const corrupt=structuredClone(file);corrupt.rows.operations_journal_event.find(r=>r.source_kind==='inventory')!.lines=[{accountId:cash,amount:'1'}]
 await assert.rejects(()=>restoreCompany(corrupt,me.email,{code:'BADOP',name:'Corrupt operation journal'}))
 const [testCount]=await db.execute<{n:string}>(q`SELECT count(*)::text n FROM entity WHERE code='BADOP'`);assert.equal(testCount.n,'0')
 const badMapping=structuredClone(file);badMapping.rows.operations_account.find(r=>r.key==='computer')!.key='computer_typo'
 await assert.rejects(()=>restoreCompany(badMapping,me.email,{code:'BADMAP',name:'Corrupt module mapping'}))
 console.log('PASS  OF03 portable finance   remapped account/source/journal locators, historical daily balances, corrupted lines rejected atomically')
 // Existing posted opening costs are reconciled rather than booked again.
 const legacy=await createCompanyWithYear({code:'OPLEGA',name:'Legacy register'},me.email),ll=legacy.ledger.id
 const oldAccounts=await importAccounts(legacy.company.id,parseAccountsCsv('code,name,type,parent,roles\n1000,Cash,asset,,cash_and_cash_equivalents\n3000,Equity,equity,,share_capital').map(r=>({...r,entityId:legacy.company.id})),me.email)
 const asset=await saveAsset(me,ll,{...fixtureAsset,acquiredOn:'2026-01-01',inServiceOn:'2026-01-01',acquisitionCost:10000n})
 assert.equal((await assetRows(ll))[0].id,asset);await initializeOperationsFinance(me,ll,'/assets')
 const machine=(await financeAccounts(ll,'/assets')).find(a=>a.key==='machinery')!.account_id!
 await postEntry({ledgerId:ll,entryDate:'2026-01-01',description:'Existing purchase',lines:[{accountId:machine,amount:10000n},{accountId:oldAccounts.find(a=>a.code==='1000')!.id,amount:-10000n}]})
 const rows=await operationsReconciliation(ll,'/assets','2026-01-02'),latest=await operationsLatestDate(ll,'/assets')
 const linked=await connectOperationsFinance(me,ll,'/assets',{date:'2026-01-02',fundingAccountId:oldAccounts.find(a=>a.code==='1000')!.id,openingAccountId:oldAccounts.find(a=>a.code==='3000')!.id,expectedHash:reconciliationHash(rows,'2026-01-02',latest),taxRateBp:2500,taxRateNote:'Reviewed test rate',ccaStrategy:'match_book'})
 assert.equal(linked.entryId,null)
 console.log('PASS  OF04 existing history   reviewed opening compares prior GL and prevents duplicate capitalization')
 // Partial fiscal-year close is a dated automatic period, never an overlapping manual charge.
 const mid=await createCompanyWithYear({code:'OPMID',name:'Mid-month fiscal close',fiscalYearEndMonth:12,fiscalYearEndDay:15},me.email),ml=mid.ledger.id
 const midAccounts=await importAccounts(mid.company.id,parseAccountsCsv(STARTER_CHART).map(r=>({...r,entityId:mid.company.id})),me.email),mc=midAccounts.find(a=>a.code==='1002')!.id,meq=midAccounts.find(a=>a.code==='3500')!.id
 await initializeOperationsFinance(me,ml,'/assets')
 const mr=await operationsReconciliation(ml,'/assets','2026-01-01')
 await connectOperationsFinance(me,ml,'/assets',{date:'2026-01-01',fundingAccountId:mc,openingAccountId:meq,expectedHash:reconciliationHash(mr,'2026-01-01',null),taxRateBp:2500,taxRateNote:'Reviewed test rate',ccaStrategy:'match_book'})
 const ma=await saveAssetFinance(me,ml,{...fixtureAsset,code:'MID',acquiredOn:'2026-01-01',inServiceOn:'2026-01-01',acquisitionCost:120000n},{...book,lifeMonths:24},{...tax,taxCost:120000n,rule:'riip'},{group:'computer',ccaClass:'50',counterpartAccountId:mc,requestKey:randomUUID()})
 const entirelyFuture=await assetFinanceSchedules(ml,ma,3);assert(entirelyFuture);assert.equal(BigInt(entirelyFuture.annual[1].bookExpense),BigInt(entirelyFuture.annual[0].bookValue)-BigInt(entirelyFuture.annual[1].bookValue))
 const futureSuggestion=await ccaBookClaimSuggestion(ml,entirelyFuture.pool!.id,entirelyFuture.annual[1].start,entirelyFuture.annual[1].end,12000000n);assert.equal(futureSuggestion.expense,BigInt(entirelyFuture.annual[1].bookExpense))
 const beforeClose=(await depreciationAssets(ml))[0],mp=depreciationPreview([beforeClose],'2026-12-15',true)
 assert.equal(mp.plan[0].entries.at(-1)!.to,'2026-12-15')
 await runDepreciation(me,ml,{through:'2026-12-15',key:randomUUID(),expectedHash:mp.hash})
 await createFiscalYear(ml,'2027-12-15',me.email)
 const afterClose=(await depreciationAssets(ml))[0],rest=planDepreciation(afterClose,'2026-12-31');assert.equal(rest[0].from,'2026-12-16')
 assert.equal(BigInt(afterClose.accumulated)+rest[0].amount,60000n)
 const dbPolicy={...beforeClose.policy!,method:'declining_balance' as const,life_months:60,annual_rate_bp:2000},dbAsset={...beforeClose,policy:dbPolicy}
 const whole=planDepreciation(dbAsset,'2026-12-31'),split=planDepreciation(dbAsset,'2026-12-15',true),first=split.at(-1)!
 const splitAsset={...dbAsset,accumulated:split.reduce((n,e)=>n+e.amount,0n).toString(),entries:[{id:randomUUID(),asset_id:ma,entry_date:first.to,period_start:first.from,period_end:first.to,kind:'automatic' as const,amount:first.amount.toString(),note:'Partial fiscal close',created_by:me.email}]}
 const second=planDepreciation(splitAsset,'2026-12-31')[0]
 const difference=first.amount+second.amount-whole.at(-1)!.amount;assert(difference>=-1n&&difference<=1n)
 const mpool=(await ccaRegister(ml)).pools[0],mcp=await ccaPreview(ml,{poolId:mpool.id,startDate:mpool.start_date,endDate:'2026-12-15',adjustment:0n,poolClosed:false})
 const suggestion=await ccaBookClaimSuggestion(ml,mpool.id,mpool.start_date,'2026-12-15',mcp.maximum);assert.equal(suggestion.claim,BigInt(afterClose.accumulated))
 const schedule=await assetFinanceSchedules(ml,ma,3);assert(schedule?.annual[0].matchesBook);assert.equal(schedule?.annual[0].claim,suggestion.claim.toString())
 const myn=await recordCcaYear(me,ml,{poolId:mpool.id,startDate:mpool.start_date,endDate:'2026-12-15',adjustment:0n,poolClosed:false,claim:suggestion.claim,note:'Book matching within reviewed tax maximum',key:randomUUID(),expectedHash:mcp.hash})
 const mdt={...dt,ccaYearId:myn},mdtp=await deferredTaxPreview(ml,mdt);assert.equal(mdtp.difference,0n)
 await recordDeferredTaxReview(me,ml,{...mdt,key:randomUUID(),expectedHash:mdtp.hash})
 const recorded=await assetFinanceSchedules(ml,ma,3);assert.equal(recorded?.annual[0].status,'Recorded')
 // GL-closed periods refuse both the source and its journal atomically.
 const period=(await periodOverview(ml)).find(p=>p.start_date<='2026-12-31'&&p.end_date>='2026-12-31')!;assert(period)
 {await closePeriod(ml,period.id,{actor:me.email});const closedPreview=depreciationPreview(await depreciationAssets(ml),'2026-12-31');await refuse('PERIOD_CLOSED',()=>runDepreciation(me,ml,{through:'2026-12-31',key:randomUUID(),expectedHash:closedPreview.hash}));assert.equal((await depreciationAssets(ml))[0].entries.length,12)}
 console.log('PASS  OF05 financial plans   acquisition replay, fiscal partial closes without overlap, DB month-opening basis, permitted book-matching CCA, recorded versus forecast, closed-period atomicity')
 const limited=await createUser({email:'inventory-only@example.test',firstName:'Inventory only',password:'Inventory only isolated testing phrase',actor:me.email})
 await setGrants({userId:limited.id,entityIds:[company.company.id],modules:['/inventory'],actor:me.email})
 await refuse('NO_ACCESS',()=>productionPayrollOptions(limited,l,order))
 await setGrants({userId:limited.id,entityIds:[company.company.id],modules:['/inventory','/payroll'],actor:me.email})
 assert((await productionPayrollOptions(limited,l,order)).time.length===1)
 await setGrants({userId:limited.id,entityIds:[company.company.id],modules:['/inventory'],actor:me.email})
 await refuse('NO_ACCESS',()=>allocateProductionPayroll(limited,l,{timeId:time,payStubId:stub,date:'2026-01-16',key:randomUUID()}))
 const exported=await productionReport(l,'2026-01-01','2026-01-16',order);assert.equal(exported.length,6);assert(exported.every(e=>e.entry_id||e.no_entry_reason))
 const cost=allocationCeiling({id:'',employee_id:'',entry_id:'',pay_date:'',period_start:'',period_end:'',gross:'120000',bonus:'20000',employer:'12000',hours:'4000',used_hours:'0',used_gross:'0',used_employer:'0'},400n);assert.equal(cost.gross,10000n);assert.equal(cost.employer,1000n)
 assert(csvFile([['text'],['  =1+2'],['\t@cmd']]).includes('\t  =1+2'));assert(csvFile([['text'],['\t@cmd']]).includes('\t\t@cmd'))
 console.log('PASS  OF06 authorization and report   inventory-only wage refusal, live revoked permission, payroll bonus-cost exclusion, uncapped source traceability, CSV formula escaping')
 const priorBook=await createCompanyWithYear({code:'OPPRIOR',name:'Opening book preparation'},me.email),pl=priorBook.ledger.id
 const pa=await importAccounts(priorBook.company.id,parseAccountsCsv(STARTER_CHART).map(r=>({...r,entityId:priorBook.company.id})),me.email),pc=pa.find(a=>a.code==='1002')!.id,pe=pa.find(a=>a.code==='3500')!.id
 const priorAsset=await saveAsset(me,pl,{...fixtureAsset,code:'PRIOR',acquiredOn:'2026-01-01',acquisitionCost:120000n})
 await saveDepreciationPolicy(me,pl,{...book,assetId:priorAsset,lifeMonths:60})
 await initializeOperationsFinance(me,pl,'/assets')
 const prepare=async()=>{const r=await operationsReconciliation(pl,'/assets','2026-03-01');return {date:'2026-03-01',fundingAccountId:pc,openingAccountId:pe,expectedHash:reconciliationHash(r,'2026-03-01',await operationsLatestDate(pl,'/assets')),taxRateBp:2500,taxRateNote:'Test reviewed rate',ccaStrategy:'maximum' as const}}
 await refuse('DEPRECIATION_PENDING',async()=>connectOperationsFinance(me,pl,'/assets',await prepare()))
 const prep=depreciationPreview(await depreciationAssets(pl),'2026-02-28');assert.equal(await runDepreciation(me,pl,{through:'2026-02-28',key:randomUUID(),expectedHash:prep.hash}),2)
 assert.equal((await operationsJournalEvents(pl,'/assets','2026-01-01','2026-03-01')).length,0)
 const po=await connectOperationsFinance(me,pl,'/assets',await prepare());assert(po.entryId)
 assert((await operationsReconciliation(pl,'/assets','2026-03-01')).every(r=>r.difference==='0'))
 console.log('PASS  OF07 legacy connection   pending historic book charge refusal, opening-register catch-up, only opening differences posted')
 const fc=await financeSetting(ll,'/assets'),oldAsset=(await depreciationAssets(ll))[0]
 await refuse('FINANCE_DATE',()=>saveDepreciationPolicy(me,ll,{assetId:oldAsset.id,version:0,method:'straight_line',startDate:'2026-01-01',residualValue:0n,lifeMonths:60,annualRateBp:2000}))
 await refuse('STALE',()=>updateFinanceSettings(me,ll,'/assets',{version:fc!.version+1,fundingAccountId:oldAccounts[0].id,taxRateBp:2500,taxRateNote:'Reviewed test',ccaStrategy:'maximum',ociAccountId:'',equityAccountId:''}))
 const moving=await createCompanyWithYear({code:'OPMA',name:'Moving-average financial controls'},me.email),al=moving.ledger.id
 const aa=await importAccounts(moving.company.id,parseAccountsCsv(STARTER_CHART).map(r=>({...r,entityId:moving.company.id})),me.email),ac=aa.find(a=>a.code==='1002')!.id,ae=aa.find(a=>a.code==='3500')!.id
 await initializeOperationsFinance(me,al,'/inventory');const ar=await operationsReconciliation(al,'/inventory','2026-01-01')
 await connectOperationsFinance(me,al,'/inventory',{date:'2026-01-01',fundingAccountId:ac,openingAccountId:ae,expectedHash:reconciliationHash(ar,'2026-01-01',null),taxRateBp:0,taxRateNote:'',ccaStrategy:'maximum'})
 await saveInventorySettings(me,al,{version:0,warehousesEnabled:false,costMethod:'moving_average'})
 const ai=await saveInventoryItem(me,al,{sku:'MA-FIN',name:'MA Financial stock',kind:'raw_material',unit:'each',reorderLevel:0n,trackBatches:false,trackSerials:false,isActive:true,notes:''}),aw=(await inventoryWarehouses(al))[0].id
 const movement={itemId:ai,kind:'receipt' as const,date:'2026-01-01',quantity:Q('10'),cost:10000n,fromWarehouseId:'',toWarehouseId:aw,batch:'',serials:[],reference:'MA cost',note:'',key:randomUUID(),finance:{counterpartAccountId:ac}}
 await recordStockMovement(me,al,movement);await recordStockMovement(me,al,{...movement,date:'2026-01-02',cost:20000n,key:randomUUID()})
 await recordStockMovement(me,al,{...movement,kind:'issue',date:'2026-01-03',cost:0n,fromWarehouseId:aw,toWarehouseId:'',key:randomUUID(),finance:{}})
 const maRows=await operationsReconciliation(al,'/inventory','2026-01-03');assert(maRows.every(r=>r.difference==='0'));assert.equal(maRows.find(r=>r.key==='raw_material')!.gl_amount,'15000')
 console.log('PASS  OF08 moving-average finance   two receipt costs, averaged issue source journal, same-day raw-material and balance-sheet equality')
 console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

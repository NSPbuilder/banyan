import {randomUUID} from 'node:crypto'
import type {UserRecord} from '../src/lib/users'
import {createCompanyWithYear} from '../src/lib/setup'
import {STARTER_CHART} from '../src/lib/starter-chart'
import {importAccounts,parseAccountsCsv} from '../src/lib/accounts'
import {initializeOperationsFinance,connectOperationsFinance} from '../src/lib/operations-finance'
import {operationsReconciliation,operationsLatestDate,reconciliationHash} from '../src/lib/operations-reconciliation'
import {saveAssetFinance} from '../src/lib/asset-finance'
import {fixtureAsset} from './operations-fixture'
import {depreciationAssets,depreciationPreview,runDepreciation} from '../src/lib/depreciation'
import {ccaRegister,ccaPreview,recordCcaYear} from '../src/lib/cca'
import {deferredTaxPreview,recordDeferredTaxReview} from '../src/lib/deferred-tax'
import {saveInventoryItem,inventoryWarehouses,recordStockMovement} from '../src/lib/inventory'
import {saveBom,createProductionOrder} from '../src/lib/production'
import {createParty} from '../src/lib/parties'
import {saveEmployee} from '../src/lib/payroll/employees'
import {runPayroll,payRunDetail} from '../src/lib/payroll/runs'
import {recordProductionTime,allocateProductionPayroll,reverseProductionPayroll} from '../src/lib/production-payroll'
import {createLabourPeriod,accrueProductionTime,reverseLabourAccrual,previewLabourSettlement,settleLabourPeriod} from '../src/lib/production-labour-accrual'
import {cancelProductionTime} from '../src/lib/production-payroll'
import {parseQuantity as Q} from '../src/lib/quantity'
/** Real source writes populate every operations-finance backup table. */
export async function buildOperationsFinanceFixture(me:UserRecord,code:string){
 const co=await createCompanyWithYear({code,name:code+' financial business'},me.email),l=co.ledger.id
 const accts=await importAccounts(co.company.id,parseAccountsCsv(STARTER_CHART).map(a=>({...a,entityId:co.company.id})),me.email),cash=accts.find(a=>a.code==='1002')!.id,equity=accts.find(a=>a.code==='3500')!.id
 for(const seat of ['/assets','/inventory'] as const){await initializeOperationsFinance(me,l,seat);const rows=await operationsReconciliation(l,seat,'2026-01-01');await connectOperationsFinance(me,l,seat,{date:'2026-01-01',fundingAccountId:cash,openingAccountId:equity,expectedHash:reconciliationHash(rows,'2026-01-01',await operationsLatestDate(l,seat)),taxRateBp:2500,taxRateNote:'Synthetic fixture reversal-rate basis',ccaStrategy:'maximum'})}
 await saveAssetFinance(me,l,{...fixtureAsset,code:'FA-FIN',acquiredOn:'2026-01-01',acquisitionCost:300000n},{version:0,method:'straight_line',startDate:'2026-01-01',residualValue:0n,lifeMonths:36,annualRateBp:2000},{version:0,taxCost:300000n,availableOn:'2026-01-01',rule:'riip',eligibilityNote:'Synthetic arm’s-length eligible CAD property',disposedOn:'',proceeds:0n},{group:'computer',ccaClass:'50',counterpartAccountId:cash,requestKey:randomUUID()})
 const dep=depreciationPreview(await depreciationAssets(l),'2026-12-31');await runDepreciation(me,l,{through:'2026-12-31',key:randomUUID(),expectedHash:dep.hash})
 const pool=(await ccaRegister(l)).pools[0],yearInput={poolId:pool.id,startDate:pool.start_date,endDate:'2026-12-31',adjustment:0n,poolClosed:false},cp=await ccaPreview(l,yearInput),year=await recordCcaYear(me,l,{...yearInput,claim:cp.maximum,note:'Synthetic annual tax review',key:randomUUID(),expectedHash:cp.hash})
 const dt={ccaYearId:year,rateBp:2500,rateNote:'Synthetic enacted rate basis',bookAdjustment:0n,taxAdjustment:0n,recognizedAsset:0n,openingLiability:0n,openingAsset:0n,recognition:'profit_loss' as const,scopeReviewed:true,note:'Synthetic scope and recovery review'},dp=await deferredTaxPreview(l,dt);await recordDeferredTaxReview(me,l,{...dt,key:randomUUID(),expectedHash:dp.hash})
 const item=(sku:string,kind:string)=>saveInventoryItem(me,l,{sku,name:sku,kind,unit:'each',reorderLevel:0n,trackBatches:false,trackSerials:false,isActive:true,notes:''}),raw=await item('RM-FIN','raw_material'),fg=await item('FG-FIN','finished_goods'),warehouse=(await inventoryWarehouses(l))[0].id
 await recordStockMovement(me,l,{itemId:raw,kind:'receipt',date:'2026-01-01',quantity:Q('10'),cost:10000n,fromWarehouseId:'',toWarehouseId:warehouse,batch:'',serials:[],reference:'Finance fixture',note:'',key:randomUUID(),finance:{counterpartAccountId:cash}})
 const bom=await saveBom(me,l,{code:'BOM-FIN',name:'Finance recipe',outputItemId:fg,outputQuantity:Q('1'),components:[{itemId:raw,quantity:Q('2')}],isActive:true,notes:''}),order=await createProductionOrder(me,l,{bomId:bom,quantity:Q('2'),warehouseId:warehouse,startDate:'2026-01-02',dueDate:'',notes:'',key:randomUUID()})
 const person=await createParty({kind:'person',name:code+' payroll employee',roles:[{entityId:co.company.id,role:'employee',heldFrom:'2026-01-01'}],actor:me.email}),employee=await saveEmployee({ledgerId:l,partyId:person.id,frequency:'semi_monthly',hiredOn:'2026-01-01',actor:me.email}),pay=await runPayroll({ledgerId:l,payDate:'2026-01-15',periodStart:'2026-01-01',periodEnd:'2026-01-15',bankAccountId:cash,lines:[{employeeId:employee.id,gross:100000n,hours:4000n}],actor:me.email}),stub=(await payRunDetail(l,pay.runId))!.stubs[0].id
 const time=await recordProductionTime(me,l,{orderId:order,employeeId:employee.id,date:'2026-01-02',hours:400n,note:'Assembly',key:randomUUID()}),allocation=await allocateProductionPayroll(me,l,{timeId:time,payStubId:stub,date:'2026-01-15',key:randomUUID()})
 await reverseProductionPayroll(me,l,{allocationId:allocation,date:'2026-01-15',reason:'Unused cost correction',key:randomUUID()})
 const period=await createLabourPeriod(me,l,{employeeId:employee.id,start:'2026-01-01',end:'2026-01-15',payDate:'2026-01-15',basis:'fixed',hourlyRate:0n,paidHours:4000n,normalHours:4000n,gross:90000n,note:'Synthetic normal-capacity estimate',key:randomUUID()})
 const mistaken=await recordProductionTime(me,l,{orderId:order,employeeId:employee.id,date:'2026-01-15',hours:400n,note:'Mistaken daily hours',key:randomUUID()}),accrual=await accrueProductionTime(me,l,{timeId:mistaken,periodId:period,key:randomUUID()})
 await reverseLabourAccrual(me,l,{accrualId:accrual,date:'2026-01-15',note:'Correct unused time',key:randomUUID()});await cancelProductionTime(me,l,{id:mistaken,version:1})
 const corrected=await recordProductionTime(me,l,{orderId:order,employeeId:employee.id,date:'2026-01-15',hours:400n,note:'Reviewed daily hours',key:randomUUID()});await accrueProductionTime(me,l,{timeId:corrected,periodId:period,key:randomUUID()})
 const settlement={periodId:period,payStubId:stub,date:'2026-01-15',eligibleGross:100000n,normalHours:4000n,note:'Actual pay and production capacity reviewed',key:randomUUID()},preview=await previewLabourSettlement(me,l,settlement)
 await settleLabourPeriod(me,l,{...settlement,reviewHash:preview.reviewHash})
 return {entityId:co.company.id,ledgerId:l}
}

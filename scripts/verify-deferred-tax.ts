import './env'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {sql as q} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner} from '../src/lib/users'
import {createCompanyWithYear} from '../src/lib/setup'
import {assetRows,saveAsset} from '../src/lib/assets'
import {saveAssetFinance} from '../src/lib/asset-finance'
import {fixtureAsset} from './operations-fixture'
import {depreciationAssets,depreciationPreview,runDepreciation,adjustDepreciation,saveDepreciationPolicy} from '../src/lib/depreciation'
import {saveCcaPool,saveCcaAssignment,ccaPreview,recordCcaYear} from '../src/lib/cca'
import {deferredTaxPreview,recordDeferredTaxReview,deferredTaxReviews} from '../src/lib/deferred-tax'
import {deferredTaxAmounts,deferredTaxJournal} from '../src/lib/deferred-tax-math'
import {exportCompany,restoreCompany} from '../src/lib/backup'
import type {DeferredTaxInput} from '../src/lib/deferred-tax-types'
import {errorText} from './suite'
const refuse=async(code:string,fn:()=>Promise<unknown>)=>assert.rejects(fn,(e:unknown)=>(e as {code:string}).code===code)
async function main(){
 const me=await createFirstOwner({email:'book-tax@example.test',firstName:'Book tax test',password:'Independent book tax test phrase'}),co=await createCompanyWithYear({code:'DT',name:'Book tax'},me.email),other=await createCompanyWithYear({code:'DTB',name:'Other'},me.email),l=co.ledger.id
 const pool=await saveCcaPool(me,l,{version:0,name:'Computer equipment',classCode:'50',rateBp:5500,calculation:'standard',openingUcc:0n,startDate:'2026-01-01'})
 const book={version:0,method:'straight_line' as const,startDate:'2026-01-01',residualValue:0n,lifeMonths:36,annualRateBp:2000}
 const tax={poolId:pool,version:0,taxCost:300000n,availableOn:'2026-01-01',rule:'riip' as const,eligibilityNote:'Eligible arm’s-length computer, CAD, all business use',disposedOn:'',proceeds:0n}
 await refuse('CCA_SCOPE',()=>saveAssetFinance(me,l,{...fixtureAsset,code:'FAILED',acquiredOn:'2026-01-01',acquisitionCost:300000n},book,{...tax,poolId:randomUUID()}));assert.equal((await assetRows(l)).length,0,'atomic refusal leaves no orphan asset')
 const a=await saveAssetFinance(me,l,{...fixtureAsset,code:'PC-01',acquiredOn:'2026-01-01',inServiceOn:'2026-01-01',acquisitionCost:300000n},book,tax)
 const identity={...fixtureAsset,id:a,code:'PC-01',acquiredOn:'2026-01-01',inServiceOn:'2026-01-01',acquisitionCost:300000n,custodian:'Reviewed custodian'}
 await saveAsset(me,l,{...identity,version:1})
 const cca=async(y:number)=>{const input={poolId:pool,startDate:y+'-01-01',endDate:y+'-12-31',adjustment:0n,poolClosed:false},p=await ccaPreview(l,input);return recordCcaYear(me,l,{...input,claim:p.maximum,note:'Annual tax eligibility reviewed',key:randomUUID(),expectedHash:p.hash})}
 const dep=async(y:number)=>{const through=y+'-12-31',p=depreciationPreview(await depreciationAssets(l),through);await runDepreciation(me,l,{through,key:randomUUID(),expectedHash:p.hash})}
 const first=await cca(2026)
 const input:DeferredTaxInput={ccaYearId:first,rateBp:2500,rateNote:'Test assumption: enacted reversal rate 25%',bookAdjustment:0n,taxAdjustment:0n,recognizedAsset:0n,openingLiability:0n,openingAsset:0n,recognition:'profit_loss',scopeReviewed:true,note:'Pool includes all owned assets; no recognition exception; recover through use'}
 await refuse('DEPRECIATION_PENDING',()=>deferredTaxPreview(l,input));await dep(2026)
 let p=await deferredTaxPreview(l,input);assert.equal(p.bookValue,200004n,'monthly rounded depreciation');assert.equal(p.taxBase,0n);assert.equal(p.liability,50001n)
 // Use exact annual amount via a documented book adjustment, preserving history.
 const firstInput={...input,bookAdjustment:-4n};p=await deferredTaxPreview(l,firstInput);assert.equal(p.liability,50000n);assert.deepEqual(p.journal,[{account:'Income tax expense — deferred',debit:'50000',credit:'0'},{account:'Deferred tax liability',debit:'0',credit:'50000'}])
 const req={...firstInput,key:randomUUID(),expectedHash:p.hash},id=await recordDeferredTaxReview(me,l,req);assert.equal(await recordDeferredTaxReview(me,l,req),id)
 await refuse('REPLAY',()=>recordDeferredTaxReview(me,l,{...req,rateBp:3000}));await refuse('CCA_YEAR',()=>deferredTaxPreview(other.ledger.id,input));await refuse('REVIEW',()=>deferredTaxPreview(l,{...input,scopeReviewed:false}))
 await saveAsset(me,l,{...identity,version:2,notes:'Identity notes reviewed after the tax working paper'})
 assert.equal((await assetRows(l)).find(x=>x.id===a)!.version,3,'non-financial identity remains editable after tax review')
 await assert.rejects(()=>adjustDepreciation(me,l,{assetId:a,date:'2026-12-31',amount:1n,note:'Attempt backdate through frozen review',key:randomUUID()}),(e:unknown)=>errorText(e).includes('BOOK_TAX_REVIEW_HISTORY'))
 await assert.rejects(()=>db.execute(q`UPDATE fixed_asset SET acquisition_cost=300001 WHERE id=${a}::uuid`),(e:unknown)=>errorText(e).includes('BOOK_TAX_REVIEW_HISTORY'))
 const corrected={...firstInput,rateBp:3000};p=await deferredTaxPreview(l,corrected);assert.equal(p.liability,60000n);assert.equal(p.journal[0].debit,'10000');await recordDeferredTaxReview(me,l,{...corrected,key:randomUUID(),expectedHash:p.hash})
 p=await deferredTaxPreview(l,firstInput);await recordDeferredTaxReview(me,l,{...firstInput,key:randomUUID(),expectedHash:p.hash})
 const second=await cca(2027);await dep(2027);const secondInput={...input,ccaYearId:second,bookAdjustment:-8n};p=await deferredTaxPreview(l,secondInput);assert.equal(p.liability,25000n);assert.equal(p.journal[0].account,'Deferred tax liability');assert.equal(p.journal[0].debit,'25000');await recordDeferredTaxReview(me,l,{...secondInput,key:randomUUID(),expectedHash:p.hash})
 await refuse('ORDER',()=>deferredTaxPreview(l,firstInput));await saveCcaAssignment(me,l,{...tax,assetId:a,version:1,eligibilityNote:'Eligibility reviewed again; existing tax facts unchanged'});
 const third=await cca(2028);await dep(2028);const thirdInput={...input,ccaYearId:third};p=await deferredTaxPreview(l,thirdInput);assert.equal(p.liability,0n);assert.equal(p.journal[0].debit,'25000');await recordDeferredTaxReview(me,l,{...thirdInput,key:randomUUID(),expectedHash:p.hash})
 const dta={...thirdInput,taxAdjustment:100000n,recognizedAsset:10000n,note:'Deductible basis reviewed; probable taxable profit supports only CAD 100 recognition'};p=await deferredTaxPreview(l,dta);assert.equal(p.potentialAsset,25000n);assert.equal(p.recognizedAsset,10000n);assert.equal(p.journal[0].account,'Deferred tax asset');await recordDeferredTaxReview(me,l,{...dta,key:randomUUID(),expectedHash:p.hash})
 assert.throws(()=>deferredTaxAmounts(0n,100n,2500,26n));assert.throws(()=>deferredTaxAmounts(100n,0n,10001,0n));assert.equal(deferredTaxJournal(0n,0n,0n,0n,'oci').length,0);assert.equal(deferredTaxJournal(100n,0n,0n,0n,'oci')[0].account,'Other comprehensive income — tax');assert.equal(deferredTaxJournal(0n,0n,0n,100n,'equity')[1].account,'Deferred tax asset');assert.equal(deferredTaxAmounts(100n,0n,0,0n).liability,0n)
 await refuse('STALE',()=>recordDeferredTaxReview(me,l,{...dta,key:randomUUID(),expectedHash:'old'}))
 const pendingPool=await saveCcaPool(me,l,{version:0,name:'Not yet available',classCode:'8',rateBp:2000,calculation:'standard',openingUcc:0n,startDate:'2026-01-01'})
 await saveAssetFinance(me,l,{...fixtureAsset,code:'FUTURE',acquiredOn:'2026-12-01',inServiceOn:'',acquisitionCost:100000n},{...book,method:'none',startDate:'2027-01-01'},{...tax,poolId:pendingPool,taxCost:100000n,availableOn:'2027-01-01',rule:'half_year'})
 const py={poolId:pendingPool,startDate:'2026-01-01',endDate:'2026-12-31',adjustment:0n,poolClosed:false},pp=await ccaPreview(l,py),pid=await recordCcaYear(me,l,{...py,claim:0n,note:'No available additions yet',key:randomUUID(),expectedHash:pp.hash})
 p=await deferredTaxPreview(l,{...input,ccaYearId:pid});assert.equal(p.pendingTaxCost,100000n);assert.equal(p.taxBase,100000n);assert.equal(p.liability,0n)
 const opening={...input,ccaYearId:pid,openingLiability:20000n};p=await deferredTaxPreview(l,opening);assert.equal(p.journal[0].debit,'20000');await recordDeferredTaxReview(me,l,{...opening,key:randomUUID(),expectedHash:p.hash})
 const outsider=await saveAsset(me,l,{...fixtureAsset,code:'OUTSIDE',acquiredOn:'2026-01-01'});await refuse('TAX_HISTORY',()=>saveCcaAssignment(me,l,{...tax,assetId:outsider,poolId:pendingPool,availableOn:'2027-01-01',rule:'half_year'}))
 await db.execute(q`INSERT INTO company_module_access(entity_id,module,enabled,updated_by) VALUES(${co.company.id}::uuid,'/assets',false,${me.email}) ON CONFLICT(entity_id,module) DO UPDATE SET enabled=false`);await refuse('NO_ACCESS',()=>recordDeferredTaxReview(me,l,req));await db.execute(q`UPDATE company_module_access SET enabled=true WHERE entity_id=${co.company.id}::uuid AND module='/assets'`)
 const estimatePool=await saveCcaPool(me,l,{version:0,name:'Estimate review',classCode:'8',rateBp:2000,calculation:'standard',openingUcc:0n,startDate:'2026-01-01'})
 const estimate=await saveAssetFinance(me,l,{...fixtureAsset,code:'ESTIMATE',acquiredOn:'2026-01-01',acquisitionCost:120000n},{...book,lifeMonths:120},{...tax,poolId:estimatePool,taxCost:120000n,rule:'half_year'})
 await dep(2026);const ep={assetId:estimate,version:1,method:'straight_line' as const,startDate:'2027-01-01',residualValue:0n,lifeMonths:36,annualRateBp:2000,revisionReason:'Expected replacement earlier; revised remaining life to 36 months'}
 await refuse('POLICY_HISTORY',()=>saveDepreciationPolicy(me,l,{...ep,startDate:'2026-12-01'}));await refuse('DEPRECIATION_PENDING',()=>saveDepreciationPolicy(me,l,{...ep,startDate:'2027-02-01'}));await saveDepreciationPolicy(me,l,ep)
 const jan=depreciationPreview(await depreciationAssets(l),'2027-01-31');assert.equal(jan.plan.find(x=>x.asset.id===estimate)!.entries[0].amount,3000n);await runDepreciation(me,l,{through:'2027-01-31',key:randomUUID(),expectedHash:jan.hash})
 await saveDepreciationPolicy(me,l,{...ep,version:2,startDate:'2027-02-01',lifeMonths:35,revisionReason:'Confirm remaining life after one revised month'})
 const ey={poolId:estimatePool,startDate:'2026-01-01',endDate:'2026-12-31',adjustment:0n,poolClosed:false},ec=await ccaPreview(l,ey),eid=await recordCcaYear(me,l,{...ey,claim:ec.maximum,note:'Estimate fixture tax review',key:randomUUID(),expectedHash:ec.hash});const er={...input,ccaYearId:eid};p=await deferredTaxPreview(l,er);assert.equal(p.bookValue,108000n);assert.equal(p.assets[0].policy!.life_months,120,'historical review uses prior policy');await recordDeferredTaxReview(me,l,{...er,key:randomUUID(),expectedHash:p.hash})
 const file=await exportCompany(co.company.id),restored=await restoreCompany(file,me.email,{code:'DTR',name:'Restored book tax'});assert.equal((await deferredTaxReviews(restored.ledgerId!)).length,8)
 const bad=structuredClone(file);bad.rows.asset_deferred_tax_review[0].previous_liability='999';await assert.rejects(()=>restoreCompany(bad,me.email,{code:'BADDT',name:'Corrupt book tax'}))
 const [gl]=await db.execute<{n:string}>(q`SELECT count(*)::text n FROM journal_entry WHERE ledger_id=${l}::uuid`);assert.equal(gl.n,'0','register-only workflow writes no GL')
 console.log('PASS  DT01 book/tax working papers   atomic asset/book/tax, three-year reversal, rate correction, partial DTA, pending tax cost, replay/stale/order, immutable history, backup validation, no GL.');console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

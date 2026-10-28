import './env'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {sql as q} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner} from '../src/lib/users'
import {createCompanyWithYear} from '../src/lib/setup'
import {saveAsset} from '../src/lib/assets'
import {fixtureAsset} from './operations-fixture'
import {saveDepreciationPolicy,adjustDepreciation,depreciationAssets,depreciationPreview,runDepreciation} from '../src/lib/depreciation'
import {saveCcaPool,saveCcaAssignment,ccaPreview,recordCcaYear,ccaRegister} from '../src/lib/cca'
import {calculateCca,monthlyDepreciation} from '../src/lib/depreciation-math'
import type {DepreciationPolicy} from '../src/lib/depreciation-types'
import {exportCompany,restoreCompany} from '../src/lib/backup'
const refuse=async(code:string,fn:()=>Promise<unknown>)=>assert.rejects(fn,(e:unknown)=>(e as {code:string}).code===code)
async function main(){
 const me=await createFirstOwner({email:'depreciation@example.test',firstName:'Depreciation test',password:'Independent depreciation test phrase'}),co=await createCompanyWithYear({code:'DEP',name:'Depreciation'},me.email),other=await createCompanyWithYear({code:'DEPB',name:'Other'},me.email),ledger=co.ledger.id
 const asset=await saveAsset(me,ledger,{...fixtureAsset,acquiredOn:'2026-01-01',inServiceOn:'2026-01-01',acquisitionCost:120000n})
 const policy={assetId:asset,version:0,method:'straight_line' as const,startDate:'2026-01-01',residualValue:0n,lifeMonths:12,annualRateBp:2000}
 await saveDepreciationPolicy(me,ledger,policy)
 let preview=depreciationPreview(await depreciationAssets(ledger),'2026-01-31');assert.equal(preview.plan[0].entries[0].amount,10000n)
 const run={through:'2026-01-31',key:randomUUID(),expectedHash:preview.hash};assert.equal(await runDepreciation(me,ledger,run),1);assert.equal(await runDepreciation(me,ledger,run),1)
 await refuse('DEPRECIATION_PENDING',()=>adjustDepreciation(me,ledger,{assetId:asset,date:'2026-03-15',amount:100n,note:'Correction before missing February depreciation',key:randomUUID()}))
 const manual={assetId:asset,date:'2026-02-15',amount:-500n,note:'Reverse excess opening charge',key:randomUUID()};const manualId=await adjustDepreciation(me,ledger,manual);assert.equal(await adjustDepreciation(me,ledger,manual),manualId)
 assert.equal((await depreciationAssets(ledger))[0].accumulated,'9500')
 await refuse('REPLAY',()=>adjustDepreciation(me,ledger,{...manual,amount:-400n}));await refuse('BALANCE',()=>adjustDepreciation(me,ledger,{...manual,amount:-20000n,key:randomUUID()}));await refuse('POLICY_HISTORY',()=>saveDepreciationPolicy(me,ledger,{...policy,version:1,lifeMonths:24}))
 await refuse('POLICY',()=>adjustDepreciation(me,other.ledger.id,{...manual,key:randomUUID()}))
 preview=depreciationPreview(await depreciationAssets(ledger),'2026-02-28');assert.equal(preview.plan[0].entries[0].amount,10000n);await runDepreciation(me,ledger,{through:'2026-02-28',key:randomUUID(),expectedHash:preview.hash})
 preview=depreciationPreview(await depreciationAssets(ledger),'2026-12-31');await runDepreciation(me,ledger,{through:'2026-12-31',key:randomUUID(),expectedHash:preview.hash});assert.equal((await depreciationAssets(ledger))[0].net_book_value,'0')
 await refuse('DEPRECIATION_HISTORY',()=>saveAsset(me,ledger,{...fixtureAsset,id:asset,version:1,acquiredOn:'2026-01-01',inServiceOn:'2026-01-01',acquisitionCost:100000n}))
 const p:DepreciationPolicy={id:'',asset_id:'',method:'declining_balance',start_date:'2026-01-01',residual_value:'10000',life_months:60,annual_rate_bp:2000,version:1}
 assert.equal(monthlyDepreciation(120000n,0n,p,'2026-01-01','2026-01-31'),2000n);assert.equal(monthlyDepreciation(120000n,109900n,p,'2026-02-01','2026-02-28'),100n)
 const basic={classCode:'8',rateBp:2000,opening:0n,additions:[{cost:100000n,acquiredOn:'2026-01-01',availableOn:'2026-01-01',rule:'half_year' as const}],disposals:0n,adjustment:0n,days:365,poolClosed:false}
 assert.throws(()=>calculateCca({...basic,adjustment:-90000n}),/reviewed maximum/);assert.equal(calculateCca({...basic,adjustment:-90000n,manualMaximum:1000n}).maximum,1000n)
 assert.equal(calculateCca(basic).maximum,10000n);assert.equal(calculateCca({...basic,additions:[{...basic.additions[0],rule:'riip'}]}).maximum,30000n)
 assert.equal(calculateCca({...basic,days:181}).maximum,4959n)
 assert.equal(calculateCca({...basic,opening:60000n,additions:[{cost:5000n,acquiredOn:'2025-01-01',availableOn:'2025-01-01',rule:'riip'}],disposals:20000n}).maximum,9000n)
 assert.equal(calculateCca({...basic,classCode:'50',rateBp:5500,additions:[{...basic.additions[0],rule:'riip'}]}).maximum,100000n)
 assert.equal(calculateCca({...basic,classCode:'50',rateBp:5500,additions:[{cost:100000n,acquiredOn:'2023-01-01',availableOn:'2023-01-01',rule:'aiip'}]}).maximum,82500n)
 assert.equal(calculateCca({...basic,classCode:'50',rateBp:5500,additions:[{cost:100000n,acquiredOn:'2024-04-15',availableOn:'2024-04-16',rule:'aiip'}]}).maximum,55000n)
 assert.equal(calculateCca({...basic,classCode:'50',rateBp:5500,additions:[{cost:100000n,acquiredOn:'2024-04-16',availableOn:'2024-04-16',rule:'aiip'}]}).maximum,100000n)
 assert.equal(calculateCca({...basic,classCode:'50',rateBp:5500,additions:[{cost:100000n,acquiredOn:'2025-01-01',availableOn:'2027-01-01',rule:'riip'}]}).maximum,55000n)
 assert.equal(calculateCca({...basic,opening:20000n,additions:[],disposals:30000n}).recapture,10000n)
 assert.equal(calculateCca({...basic,opening:20000n,additions:[],poolClosed:true}).terminalLoss,20000n)
 const pool=await saveCcaPool(me,ledger,{version:0,name:'Class 8',classCode:'8',rateBp:2000,calculation:'standard',openingUcc:0n,startDate:'2026-01-01'})
 const assignment={assetId:asset,poolId:pool,version:0,taxCost:120000n,availableOn:'2026-01-01',rule:'riip' as const,eligibilityNote:'Arm’s-length eligible new equipment, CAD, 100% business use',disposedOn:'',proceeds:0n};await saveCcaAssignment(me,ledger,assignment)
 let input={poolId:pool,startDate:'2026-01-01',endDate:'2026-12-31',adjustment:0n,poolClosed:false};let tax=await ccaPreview(ledger,input);assert.equal(tax.maximum,36000n)
 await refuse('STALE',()=>recordCcaYear(me,ledger,{...input,claim:24000n,note:'Stale preview',key:randomUUID(),expectedHash:'not-the-current-review'}))
 const year={...input,claim:24000n,note:'Reviewed optional claim below maximum',key:randomUUID(),expectedHash:tax.hash},yearId=await recordCcaYear(me,ledger,year);assert.equal(await recordCcaYear(me,ledger,year),yearId)
 assert.equal((await ccaRegister(ledger)).years[0].closing_ucc,'96000')
 await refuse('CCA_HISTORY',()=>saveCcaAssignment(me,ledger,{...assignment,version:1,taxCost:119000n}))
 await saveCcaAssignment(me,ledger,{...assignment,version:1,disposedOn:'2027-03-01',proceeds:180000n})
 input={...input,startDate:'2027-01-01',endDate:'2027-12-31'};tax=await ccaPreview(ledger,input);assert.equal(tax.disposals,120000n);assert.equal(tax.recapture,24000n)
 await recordCcaYear(me,ledger,{...input,claim:0n,note:'Disposal proceeds capped at tax cost; recapture',key:randomUUID(),expectedHash:tax.hash})
 await db.execute(q`SELECT operations_validate_ledger(${ledger}::uuid)`)
 const copy=await restoreCompany(await exportCompany(co.company.id),me.email,{code:'DEPC',name:'Copy'});assert.equal((await depreciationAssets(copy.ledgerId!))[0].accumulated,'120000');assert.equal((await ccaRegister(copy.ledgerId!)).years.length,2)
 assert.equal((await db.execute<{n:string}>(q`SELECT count(*)::text AS n FROM journal_entry`))[0].n,'0')
 console.log('PASS  DP01 depreciation and CCA invariants  monthly/manual/residual, review hash, replay, RII/half-year/class50/short-year, capped disposal/recapture, backup and no-GL checks passed')
 console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

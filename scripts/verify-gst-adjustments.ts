import './env'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { db, sql as connection } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { postEntry, reverseEntry } from '../src/lib/posting'
import { registerTax } from '../src/lib/registrations'
import { gstHstReturn } from '../src/lib/tax'
import { gstAdjustmentFor, saveGstAdjustment } from '../src/lib/gst-adjustments'
import { gstHstCsv } from '../src/lib/exports'
import { taxReturnPdf } from '../src/lib/pdf-reports'
import { breakdown } from '../src/lib/breakdown'
import { exportCompany, restoreCompany } from '../src/lib/backup'
import { resolvePeriodSpan } from '../src/lib/balances'
import { renderCashFlow } from '../src/lib/cash-flow'
import { verifyAudit } from '../src/lib/audit-chain'

const actor='gst-review@example.test'
const chart=`1000,Cash,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
1300,GST recoverable,asset,,gst_hst_recoverable
1500,Equipment,asset,,property_plant_equipment
1510,Accumulated depreciation,asset,,accumulated_depreciation_ppe,contra
2000,Payables,liability,,trade_payables
2100,GST payable,liability,,gst_hst_payable
2500,Loan,liability,,borrowings_non_current
3000,Capital,equity,,share_capital
4000,Revenue,revenue,,revenue_from_contracts
5000,Expenses,expense,,other_operating_expenses
5100,Depreciation,expense,,depreciation_expense`
async function fixture(code:string) {
  const c=await createCompanyWithYear({code,name:`${code} fixture`,province:'BC'},actor)
  const accounts=await importAccounts(c.company.id,parseAccountsCsv(chart).map(a=>({...a,entityId:c.company.id})),actor)
  const at=Object.fromEntries(accounts.map(a=>[a.code,a.id])),year=c.year.endDate.slice(0,4)
  const post=(month:string,description:string,lines:Array<[string,bigint]>)=>postEntry({ledgerId:c.ledger.id,
    entryDate:`${year}-${month}`,description,actor,lines:lines.map(([code,amount])=>({accountId:at[code],amount}))})
  return {...c,at,year,post}
}
async function main() {
  const f=await fixture('GSTADJ'),ledger=f.ledger.id,from=`${f.year}-01-01`,to=`${f.year}-03-31`
  await registerTax({entityId:f.company.id,tax:'GST_HST',number:'123456789RT0001',registeredOn:from,actor})
  await f.post('01-10','Sale',[['1000',105000n],['4000',-100000n],['2100',-5000n]])
  await f.post('02-10','Purchase',[['5000',10000n],['1300',500n],['1000',-10500n]])
  const original=(await gstHstReturn(ledger,from,to))!
  const journalBefore=await db.execute(sql`SELECT l.id::text,l.amount::text FROM journal_line l JOIN journal_entry j ON j.id=l.entry_id WHERE j.ledger_id=${ledger}::uuid ORDER BY l.id`)
  assert.equal(original.lines.net.amount,4500n)
  const input={from,to,version:0,sales:'0.00',collected:'60.01',itcs:'',reason:'Reviewed prior-period tax remittance'}
  await saveGstAdjustment(ledger,actor,input)
  const edited=(await gstHstReturn(ledger,from,to))!
  assert.equal(edited.lines.sales.amount,0n)
  assert.equal(edited.lines.collected.amount,6001n)
  assert.equal(edited.lines.collected.bookAmount,5000n)
  assert.equal(edited.lines.collected.adjustment,1001n)
  assert.equal(edited.lines.itcs.amount,500n)
  assert.equal(edited.lines.net.amount,5501n)
  assert.equal(edited.lines.collected.entries.reduce((n,e)=>n+e.contribution,0n)+edited.lines.collected.adjustment!,6001n)
  const csv=(await gstHstCsv(ledger,from,to))!.csv
  assert.match(csv,/60\.01/);assert.match(csv,/10\.01/);assert.match(csv,/Reviewed prior-period tax remittance/)
  const trace=(await breakdown(ledger,{kind:'tax',line:'105',from,to}))!
  assert.equal(trace.total?.amount,6001n)
  assert.ok(trace.rows.some(row=>JSON.stringify(row,(_,v)=>typeof v==='bigint'?String(v):v).includes('Manual adjustment')))
  for(const format of ['pdf','xlsx'] as const)assert.ok((await taxReturnPdf(ledger,from,to,'GST_HST',false,format))!.buffer.length>100)
  assert.equal(await gstAdjustmentFor(ledger,`${f.year}-04-01`,`${f.year}-06-30`),null)
  const other=await fixture('GSTOTHER')
  assert.equal(await gstAdjustmentFor(other.ledger.id,from,to),null)
  for(const patch of [{collected:'1.001'},{collected:'NaN'},{collected:'1,2'},{reason:''},{from:`${f.year}-02-31`},{version:-1}])
    await assert.rejects(saveGstAdjustment(ledger,actor,{...input,version:1,...patch}))
  const racing=await Promise.allSettled(['70.00','80.00'].map(collected=>saveGstAdjustment(ledger,actor,{...input,version:1,collected})))
  assert.equal(racing.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(racing.filter(r=>r.status==='rejected').length,1)
  await saveGstAdjustment(ledger,actor,{...input,version:2,reset:true})
  assert.equal((await gstHstReturn(ledger,from,to))!.lines.net.amount,4500n)
  assert.equal((await gstHstReturn(ledger,from,to))!.lines.net.bookAmount,undefined)
  assert.equal((await gstAdjustmentFor(ledger,from,to))!.version,3)
  await assert.rejects(saveGstAdjustment(ledger,actor,input),/another window/)
  await saveGstAdjustment(ledger,actor,{...input,version:3,collected:'70.00'})
  const [journals]=await db.execute<{n:number}>(sql`SELECT count(*)::int n FROM journal_entry WHERE ledger_id=${ledger}::uuid`)
  assert.equal(journals.n,2,'worksheet editing never adds or edits a journal')
  assert.deepEqual([...await db.execute(sql`SELECT l.id::text,l.amount::text FROM journal_line l JOIN journal_entry j ON j.id=l.entry_id WHERE j.ledger_id=${ledger}::uuid ORDER BY l.id`)],[...journalBefore])
  const doc=await exportCompany(f.company.id)
  assert.equal(doc.rows.gst_return_adjustment.length,1)
  const restored=await restoreCompany(doc,actor,{code:'GSTCOPY',name:'GST copy'})
  assert.ok(restored.ledgerId)
  const copy=(await gstHstReturn(restored.ledgerId,from,to))!
  assert.equal(copy.lines.collected.amount,7000n)
  assert.equal(copy.adjustment?.reason,input.reason)
  assert.notEqual(copy.adjustment?.id,edited.adjustment?.id)
  const [trail]=await db.execute<{n:number}>(sql`SELECT count(*)::int n FROM audit_log WHERE ledger_id=${ledger}::uuid AND action='adjust_gst_return' AND actor=${actor}`)
  assert.equal(trail.n,4)
  await saveGstAdjustment(ledger,actor,{...input,version:4,collected:'90000000000000000.00'})
  const [exact]=await db.execute<{amount:string}>(sql`SELECT after->>'collected' amount FROM audit_log
    WHERE ledger_id=${ledger}::uuid AND action='adjust_gst_return' ORDER BY id DESC LIMIT 1`)
  assert.equal(exact.amount,'9000000000000000000')
  assert.equal((await verifyAudit()).ok,true)
  console.log('PASS  GST final figures, zero/blank, period/company isolation, exports, conflicts, audit and portable restore')

  const c=await fixture('NONCASH'),L=c.ledger.id
  await c.post('01-01','Shares issued',[['1000',10000n],['3000',-10000n]])
  await c.post('01-02','Cash equipment',[['1500',2000n],['1000',-2000n]])
  const lease=await c.post('01-03','Equipment financed without cash',[['1500',10000n],['2500',-10000n]])
  await c.post('01-04','Depreciation',[['5100',300n],['1510',-300n]])
  await c.post('01-05','Credit sale',[['1200',1000n],['4000',-1000n]])
  await c.post('01-06','Non-cash asset write-off',[['5000',400n],['1500',-400n]])
  const span=(await resolvePeriodSpan(L,`${c.year}-01-01`,`${c.year}-03-31`))!
  const cf=(await renderCashFlow(L,span.toPeriod.id,span.fromPeriod.id))!
  const value=(code:string)=>cf.lines.find(l=>l.code===code)!.raw
  assert.equal(value('CF_NI'),300n,'profit remains the actual journal profit')
  assert.equal(value('CF_NONCASH_PL'),400n)
  assert.equal(value('CF_OPER'),0n)
  assert.equal(value('CF_INV'),-2000n)
  assert.equal(value('CF_FIN'),10000n)
  assert.equal(cf.netChange,8000n)
  assert.equal(cf.beginning+cf.netChange,cf.ending)
  assert.deepEqual(cf.problems,[])
  console.log('PASS  Non-cash financing and asset losses excluded; actual profit and cash reconciliation preserved')
  assert.ok(cf.lines.some(l=>l.label.includes('Equipment financed without cash')))
  for(const [index,line] of cf.lines.entries())if(line.entries){
    assert.equal(line.entries.reduce((n,e)=>n+e.amount,0n),line.raw,`trace sums: ${line.label}`)
    const drill=(await breakdown(L,{kind:'cash-flow-line',line:String(index),from:`${c.year}-01-01`,to:`${c.year}-03-31`}))!
    assert.equal(drill.total?.amount,line.raw)
  }
  await reverseEntry(lease.entry.id,`${c.year}-04-01`,'Reverse financed acquisition',actor)
  const q2=(await resolvePeriodSpan(L,`${c.year}-04-01`,`${c.year}-06-30`))!
  const reversed=(await renderCashFlow(L,q2.toPeriod.id,q2.fromPeriod.id))!
  assert.equal(reversed.netChange,0n)
  assert.equal(reversed.lines.find(l=>l.code==='CF_INV')!.raw,0n)
  assert.equal(reversed.lines.find(l=>l.code==='CF_FIN')!.raw,0n)
  console.log('PASS  Reversal-root classification excludes a later non-cash reversal')
  await c.post('02-01','Mixed cash and financing',[['1500',1000n],['1000',-200n],['2500',-800n]])
  const mixed=(await renderCashFlow(L,span.toPeriod.id,span.fromPeriod.id))!
  assert.ok(mixed.problems.some(p=>p.includes('mixed cash')))
  assert.equal(mixed.beginning+mixed.netChange,mixed.ending)
  console.log('PASS  Mixed cash/financing journal is flagged for source review and cash still reconciles')
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

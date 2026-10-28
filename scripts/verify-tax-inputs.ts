/** Actual form tax overrides, source preservation and ledger regressions.
 * Run directly on an explicit localhost *_test database; never resets it. */
import './env'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db, sql as connection } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { createFirstOwner } from '../src/lib/users'
import { computeEnteredTax, computeTax, parseTaxOverride } from '../src/lib/tax-rates'
import { createInvoice, invoiceDetail, postInvoice } from '../src/lib/invoices'
import { createInvoiceFromForm, updateInvoiceFromForm } from '../src/lib/invoice-forms'
import { quickEntryFromForm } from '../src/lib/quick-forms'
import { invoiceEditorState } from '../src/lib/invoice-editor'
import { typedTotal, editRow, moveRow, resetRowTax, type RowState } from '../src/lib/invoice-rows'
import { INVOICE_FIELDS as F, QUICK_FIELDS as Q, lineAccount, lineAmount, lineDescription, lineTaxCode, lineGst, linePst } from '../src/lib/forms'
import { LineTaxes } from '../src/components/LineTaxes'
import { AmountInput } from '../src/components/AmountInput'
import { gstHstReturn } from '../src/lib/tax'

let checks = 0
function verify(ok: unknown, label: string) { assert.ok(ok, label); console.log(`PASS T${++checks} ${label}`) }
const chart = `1000,Bank,asset,,cash_and_cash_equivalents
1200,Accounts receivable,asset,,trade_receivables
1300,GST recoverable,asset,,gst_hst_recoverable
2000,Accounts payable,liability,,trade_payables
2100,GST payable,liability,,gst_hst_payable
2150,PST payable,liability,,qst_pst_payable
4000,Revenue,revenue,,revenue_from_contracts
5000,Materials,expense,,other_operating_expenses`
const actor = 'tax-owner@example.test'
const runPrefix = randomUUID().slice(0, 8)
const documentNumber = (number: string) => `${runPrefix}-${number}`
type Fixture = { ledgerId: string; entityId: string; date: string; ids: Record<string,string>; customerId: string; supplierId: string }
async function guard() {
  const target = process.env.TEST_DATABASE_URL, app = process.env.APP_DATABASE_URL
  assert.ok(target && app, 'Explicit test and application identities are required')
  const t = new URL(target), a = new URL(app)
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(t.hostname) && t.pathname.endsWith('_test'))
  // Refuse equal names even when localhost aliases/ports obscure identity.
  assert.notEqual(t.pathname, a.pathname, 'Test database name must differ from the application')
  const [r] = await db.execute<{ name: string }>(sql`SELECT current_database() AS name`)
  assert.equal(r.name, t.pathname.slice(1))
  verify(true, 'test database isolation checked before writes; no reset')
}
async function seed(): Promise<Fixture> {
  const [owner] = await db.execute(sql`SELECT id FROM app_user WHERE is_owner LIMIT 1`)
  if (!owner) await createFirstOwner({ email: actor, firstName: 'Tax Tester', password: 'tax preview test only' })
  const suffix = randomUUID().slice(0,8)
  const co = await createCompanyWithYear({ code: `TX${suffix}`, name: `Tax input test ${suffix}` }, actor)
  const accounts = await importAccounts(co.company.id, parseAccountsCsv(chart).map(r => ({ ...r, entityId: co.company.id })), actor)
  const roles = (role: 'customer'|'supplier') => [{ entityId: co.company.id, role, heldFrom: co.year.startDate }]
  const customer = await createParty({ kind: 'organisation', name: `Tax customer ${suffix}`, roles: roles('customer'), actor })
  const supplier = await createParty({ kind: 'organisation', name: `Tax supplier ${suffix}`, roles: roles('supplier'), actor })
  return { ledgerId: co.ledger.id, entityId: co.company.id, date: co.year.startDate, ids: Object.fromEntries(accounts.map(a => [a.code,a.id])), customerId: customer.id, supplierId: supplier.id }
}
function invoiceForm(fix: Fixture, number: string, direction: 'sales'|'purchase', rows: RowState, kind='invoice') {
  const f = new FormData()
  for (const [k,v] of Object.entries({[F.ledgerId]:fix.ledgerId,[F.direction]:direction,[F.kind]:kind,[F.partyId]:direction==='sales'?fix.customerId:fix.supplierId,[F.controlAccountId]:fix.ids[direction==='sales'?'1200':'2000'],[F.issuedOn]:fix.date,[F.dueOn]:fix.date,[F.number]:documentNumber(number),[F.amounts]:rows.inclusive?'inclusive':'exclusive'})) f.set(k,v)
  rows.rows.forEach((r,i) => {f.set(lineAccount(i),r.account);f.set(lineDescription(i),r.description);f.set(lineAmount(i),r.amount);f.set(lineTaxCode(i),r.taxCode);if(r.gst!==undefined)f.set(lineGst(i),r.gst);if(r.pst!==undefined)f.set(linePst(i),r.pst)})
  return f
}
async function detail(fix: Fixture, number: string) {
  const [r] = await db.execute<{id:string}>(sql`SELECT id::text FROM invoice WHERE ledger_id=${fix.ledgerId}::uuid AND number=${documentNumber(number)}`)
  assert.ok(r, 'created invoice exists');const d=await invoiceDetail(r.id);assert.ok(d);return d
}
function nodeInputs(node: unknown): Array<{props: Record<string, unknown>}> {
  if (Array.isArray(node)) return node.flatMap(nodeInputs)
  if (!node || typeof node !== 'object') return []
  const e=node as {type?:unknown;props?:Record<string,unknown>};if(!e.props)return []
  const children=e.props.children
  // AmountInput forwards these native input props unchanged; inspect the
  // actual LineTaxes callback and controlled value through that boundary.
  return [...(e.type==='input'||e.type===AmountInput?[e as {props:Record<string,unknown>}]:[]),...(Array.isArray(children)?children:[children]).flatMap(nodeInputs)]
}
async function main() {
  await guard()
  const file = process.env.TAX_INPUT_FIXTURE_PATH
  const fix: Fixture = process.argv.includes('--seed-only') || !file ? await seed() : JSON.parse(readFileSync(file,'utf8'))
  if (file) writeFileSync(file,JSON.stringify(fix))
  if (process.argv.includes('--seed-only')) { verify(true,'synthetic tax chart and parties created for application baseline');return }
  const [ours] = await db.execute(sql`SELECT id FROM ledger WHERE id=${fix.ledgerId}::uuid AND entity_id=${fix.entityId}::uuid`);assert.ok(ours)
  const on=fix.date
  assert.deepEqual(computeEnteredTax(10000n,'GST_PST',false,on),computeTax(10000n,'GST_PST',false,on));verify(true,'unchanged default tax calculation')
  const manual=computeEnteredTax(10000n,'GST_PST',false,on,{gst:475n,pst:680n})
  assert.deepEqual(manual,{base:10000n,gst:475n,pst:680n,total:11155n});verify(true,'exclusive taxes use exact entered amounts')
  assert.deepEqual(computeEnteredTax(11155n,'GST_PST',true,on,{gst:475n,pst:680n}),manual);verify(true,'inclusive total stays fixed with exact entered taxes')
  assert.deepEqual(computeEnteredTax(11200n,'GST_PST',true,on,{gst:475n}),{base:10023n,gst:475n,pst:702n,total:11200n});verify(true,'one fixed inclusive tax recalculates the remaining automatic tax')
  verify(computeEnteredTax(10000n,'GST_PST',false,on,{gst:0n,pst:0n}).total===10000n,'explicit zero does not revert to automatic tax')
  verify(computeEnteredTax(10000n,'GST_PST',false,'2010-01-01',{gst:475n,pst:680n}).total===11155n,'fully entered taxes require no unavailable dated rate')
  const big=900719925474099300n;verify(computeEnteredTax(big,'GST',false,on,{gst:1n}).total===big+1n,'amounts beyond JS safe integers retain every cent')
  assert.throws(()=>computeEnteredTax(10000n,'GST',false,on,{gst:-1n}));verify(true,'opposite tax sign refused')
  assert.throws(()=>computeEnteredTax(10000n,'OUT_OF_SCOPE',false,on,{gst:1n}));verify(true,'tax code cannot be bypassed')
  assert.throws(()=>computeEnteredTax(100n,'GST',true,on,{gst:100n}));verify(true,'inclusive tax cannot consume the entire amount')
  assert.throws(()=>parseTaxOverride('1.234'));assert.throws(()=>parseTaxOverride('.'));verify(true,'invalid precision and lone punctuation refused')
  verify(parseTaxOverride('')===undefined&&parseTaxOverride('0')===0n,'blank is automatic and zero is manual')
  const rows: RowState={nextKey:2,rows:[{key:17,account:fix.ids['4000'],description:'Work',amount:'100.00',taxCode:'GST_PST',gst:'4.75',pst:'6.80'}]}
  verify(typedTotal(rows.rows,{inclusive:false,on}).total===11155n,'invoice preview agrees with entered gross total')
  const changed=editRow(rows,17,'amount','200.00');verify(changed.rows[0].gst==='4.75'&&changed.rows[0].pst==='6.80','amount edit retains manual taxes')
  verify(resetRowTax(rows,17).rows[0].gst===undefined&&editRow(rows,17,'taxCode','GST').rows[0].pst===undefined,'explicit reset or retag returns to automatic mode')
  let changedGst='';const tree=LineTaxes({index:0,amount:'100.00',code:'GST_PST',inclusive:false,on,fieldClass:'field',onChange:(tax,v)=>{if(tax==='gst')changedGst=v},onReset:()=>{}})
  const field=nodeInputs(tree).find(e=>e.props['aria-label']==='GST on line 1');assert.ok(field);verify(field.props.value==='5.00','visible GST defaults to suggestion')
  ;(field.props.onChange as (e:{target:{value:string}})=>void)({target:{value:'4.75'}});verify(changedGst==='4.75','GST input dispatches actual user value')
  const h=nodeInputs(tree).find(e=>e.props.name===lineGst(0));verify(h?.props.value==='','automatic suggestion is not silently stored as override')
  const two={...rows,rows:[rows.rows[0],{...rows.rows[0],key:29,gst:'3.01'}]};verify(moveRow(two,17,1).rows[1].gst==='4.75','row move keeps taxes with their own account')
  const sale=await createInvoiceFromForm(invoiceForm(fix,'MANUAL-001','sales',rows),()=>'',actor);assert.ok(sale.ok,sale.error)
  const d=await detail(fix,'MANUAL-001');verify(d.total===11155n,'saved sales invoice total is 111.55')
  verify(d.lines.find(l=>l.generated_for==='GST')?.amount===-475n&&d.lines.find(l=>l.generated_for==='PST')?.amount===-680n,'actual taxes land on payable lines')
  const editor=invoiceEditorState(d);verify(editor.rows[0].amount==='100.00'&&editor.rows[0].gst==='4.75'&&editor.rows[0].pst==='6.80','reopening preserves original base and manual taxes')
  const edit=invoiceForm(fix,'MANUAL-001','sales',editor);edit.set(F.invoiceId,d.invoice.id);edit.set(F.note,'Header-only edit')
  assert.ok((await updateInvoiceFromForm(edit,()=>'',actor)).ok);verify((await detail(fix,'MANUAL-001')).total===11155n,'header-only edit does not recalculate manual tax')
  assert.ok((await createInvoiceFromForm(invoiceForm(fix,'MANUAL-COPY','sales',invoiceEditorState(await detail(fix,'MANUAL-001'))),()=>'',actor)).ok);verify((await detail(fix,'MANUAL-COPY')).total===11155n,'copy uses the same original amounts and overrides')
  const purchase={...rows,rows:rows.rows.map(r=>({...r,account:fix.ids['5000']}))}
  const p=await createInvoiceFromForm(invoiceForm(fix,'PURCHASE-001','purchase',purchase),()=>'',actor);assert.ok(p.ok,p.error)
  const pd=await detail(fix,'PURCHASE-001');verify(pd.lines[0].amount===10680n&&pd.lines.find(l=>l.generated_for==='GST')?.amount===475n&&pd.lines.every(l=>l.generated_for!=='PST'),'purchase PST remains cost; GST is recoverable')
  const pe=invoiceForm(fix,'PURCHASE-001','purchase',invoiceEditorState(pd));pe.set(F.invoiceId,pd.invoice.id);assert.ok((await updateInvoiceFromForm(pe,()=>'',actor)).ok);verify((await detail(fix,'PURCHASE-001')).total===11155n,'purchase edit does not tax already-folded PST again')
  const inclusive={...rows,inclusive:true,rows:rows.rows.map(r=>({...r,amount:'111.55'}))};assert.ok((await createInvoiceFromForm(invoiceForm(fix,'INCLUSIVE-001','sales',inclusive),()=>'',actor)).ok)
  const ie=invoiceEditorState(await detail(fix,'INCLUSIVE-001'));verify(ie.inclusive===true&&ie.rows[0].amount==='111.55','inclusive input is preserved for editing')
  const zero={...rows,rows:rows.rows.map(r=>({...r,gst:'0',pst:'0'}))};assert.ok((await createInvoiceFromForm(invoiceForm(fix,'ZERO-001','sales',zero),()=>'',actor)).ok);const zd=await detail(fix,'ZERO-001');verify(zd.total===10000n&&zd.lines.length===1&&invoiceEditorState(zd).rows[0].gst==='0.00','manual zero survives storage and reopening')
  const discount={...rows,rows:[rows.rows[0],{...rows.rows[0],key:18,amount:'-10.00',gst:'-0.47',pst:'-0.68'}]};assert.ok((await createInvoiceFromForm(invoiceForm(fix,'DISCOUNT-001','sales',discount),()=>'',actor)).ok);verify((await detail(fix,'DISCOUNT-001')).total===10040n,'negative discount reduces taxes with its own sign')
  assert.ok((await createInvoiceFromForm(invoiceForm(fix,'CREDIT-001','sales',rows,'credit_note'),()=>'',actor)).ok);const cd=await detail(fix,'CREDIT-001');verify(cd.lines[0].amount===10000n&&cd.lines.find(l=>l.generated_for==='GST')?.amount===475n,'credit-note direction preserves manual tax signs')
  const legacy=await createInvoice({ledgerId:fix.ledgerId,direction:'purchase',partyId:fix.supplierId,controlAccountId:fix.ids['2000'],issuedOn:on,dueOn:on,number:documentNumber('LEGACY-001'),actor,lines:[{accountId:fix.ids['5000'],amount:10700n,taxCode:'GST_PST'},{accountId:fix.ids['1300'],amount:500n,generatedFor:'GST'}]});await postInvoice(legacy.id,actor)
  const ld=await invoiceDetail(legacy.id);assert.ok(ld);const le=invoiceEditorState(ld);verify(le.rows.length===2&&le.rows.every(r=>r.taxCode==='OUT_OF_SCOPE'),'legacy edit keeps stored amounts and separate tax line without guessing')
  const lf=invoiceForm(fix,'LEGACY-001','purchase',le);lf.set(F.invoiceId,legacy.id);assert.ok((await updateInvoiceFromForm(lf,()=>'',actor)).ok);verify((await detail(fix,'LEGACY-001')).total===11200n,'legacy header edit leaves all cents unchanged')
  const quick=new FormData();for(const [k,v] of Object.entries({[Q.ledgerId]:fix.ledgerId,[Q.kind]:'expense',[Q.entryDate]:on,[Q.bankAccountId]:fix.ids['1000'],[Q.partyId]:fix.supplierId,[lineAccount(0)]:fix.ids['5000'],[lineAmount(0)]:'100.00',[lineTaxCode(0)]:'GST_PST',[lineGst(0)]:'4.75',[linePst(0)]:'6.80'}))quick.set(k,v)
  const q=await quickEntryFromForm(quick,actor);assert.ok(q.entryId,q.error)
  const jl=await db.execute<{code:string;amount:string}>(sql`SELECT a.code,j.amount::text FROM journal_line j JOIN account a ON a.id=j.account_id WHERE j.entry_id=${q.entryId}::uuid`);const amounts=Object.fromEntries(jl.map(l=>[l.code,BigInt(l.amount)]))
  verify(amounts['1000']===-11155n&&amounts['5000']===10680n&&amounts['1300']===475n,'expense form posts exact manual taxes, cost and bank amount')
  quick.set(Q.amounts,'inclusive');quick.set(lineAmount(0),'111.55');const qi=await quickEntryFromForm(quick,actor);assert.ok(qi.entryId,qi.error);verify(true,'inclusive expense with actual taxes saves successfully')
  const [before]=await db.execute<{n:string}>(sql`SELECT count(*)::text AS n FROM journal_entry WHERE ledger_id=${fix.ledgerId}::uuid`)
  quick.set(lineGst(0),'400');const bad=await quickEntryFromForm(quick,actor);verify(!!bad.error&&!bad.entryId,'invalid inclusive expense is refused before posting')
  const badInvoice=invoiceForm(fix,'BAD-001','sales',{...rows,rows:rows.rows.map(r=>({...r,gst:'1.234'}))});verify(!!(await createInvoiceFromForm(badInvoice,()=>'',actor)).error,'invalid invoice tax returns form error')
  const [after]=await db.execute<{n:string}>(sql`SELECT count(*)::text AS n FROM journal_entry WHERE ledger_id=${fix.ledgerId}::uuid`);verify(before.n===after.n,'refused taxes create no ledger entries')
  const ret=await gstHstReturn(fix.ledgerId,on,on);assert.ok(ret)
  assert.ok(ret.lines.collected.entries.some(e => e.contribution === 475n))
  assert.ok(ret.lines.itcs.entries.some(e => e.contribution === 475n))
  verify(true,'tax return includes entered GST amounts on payable and recoverable roles')
  console.log(`${checks} checks passed`)
  console.log('=== ALL CHECKS PASSED ===')
}
main().then(()=>connection.end()).catch(async e=>{console.error(e);await connection.end();process.exitCode=1})

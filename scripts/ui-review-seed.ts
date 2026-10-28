/** Synthetic APP data via controlled commands; refuses any unconfirmed database. */
import './dotenv'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

async function main() {
  const proof = JSON.parse(readFileSync('docs/evidence/p6/isolation.json', 'utf8'))
  if (!proof.createdNew || proof.productionTouched || new URL(process.env.DATABASE_URL!).pathname.slice(1) !== proof.applicationDatabase) throw Error('Unconfirmed isolated APP')
  const output = 'docs/evidence/ui-completion-2026-10-08/fixture.json'
  try { readFileSync(output); throw Error('Review fixture already exists') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const old = JSON.parse(readFileSync(proof.browserFixturePath, 'utf8'))
  const [{db,sql: connection},{sql},{userById},{createCompanyReady},{setCompanyModules},{MODULE_PATHS},{createAccount},{createParty},{postEntry},{createInvoice,postInvoice},{createProject,saveProjectRecord,createProjectPayment}] = await Promise.all([
    import('../src/db/client'),import('drizzle-orm'),import('../src/lib/users'),import('../src/lib/setup'),import('../src/lib/company-modules'),import('../src/lib/nav'),import('../src/lib/accounts'),import('../src/lib/parties'),import('../src/lib/posting'),import('../src/lib/invoices'),import('../src/lib/project'),
  ])
  try {
    const [identity] = await db.execute<{name:string}>(sql`SELECT current_database() AS name`)
    if (identity.name !== proof.applicationDatabase) throw Error('APP identity changed')
    const me = await userById(old.userId)
    if (!me || me.kind !== 'superadmin') throw Error('Review fixture needs the existing isolated superadmin')
    const made = await createCompanyReady({code:'UI'+randomUUID().slice(0,8),name:'UI review · synthetic company'},me.email)
    const ledgerId=made.ledger.id, entityId=made.company.id, actor=me.email
    await setCompanyModules(me,{entityId,modules:MODULE_PATHS})
    const revenue=await createAccount({entityId,code:'UI4000',name:'Consulting revenue',accountType:'revenue'},actor)
    const expense=await createAccount({entityId,code:'UI5000',name:'Office supplies',accountType:'expense'},actor)
    const unused=await createAccount({entityId,code:'UI1000',name:'Unused petty cash',accountType:'asset'},actor)
    const customer=await createParty({kind:'organisation',name:'UI review · Northwind customer',actor,roles:[{entityId,role:'customer',heldFrom:'2026-01-01'}]})
    const supplier=await createParty({kind:'organisation',name:'UI review · Long supplier name for scanning and wrap',actor,roles:[{entityId,role:'supplier',heldFrom:'2026-01-01'}]})
    const controls=await db.execute<{id:string;role:string}>(sql`SELECT a.id::text, r.role FROM account a JOIN account_role r ON r.account_id=a.id WHERE a.entity_id=${entityId}::uuid AND r.role IN ('trade_receivables','trade_payables')`)
    const ar=controls.find(a=>a.role==='trade_receivables')!,ap=controls.find(a=>a.role==='trade_payables')!
    const entry=await postEntry({ledgerId,entryDate:'2026-10-01',description:'Synthetic review entry',actor,lines:[{accountId:unused.id,amount:123456n},{accountId:revenue.id,amount:-123456n}]})
    const invoices:string[]=[],bills:string[]=[]
    for(let i=0;i<32;i++) {
      const credit=i===1,amount=i===0?9007199254740993n:BigInt(123456+i)
      const invoice=await createInvoice({ledgerId,direction:'sales',kind:credit?'credit_note':'invoice',partyId:customer.id,controlAccountId:ar.id,issuedOn:'2026-10-01',dueOn:'2026-10-31',number:`UI-${i+1}`,actor,
        lines:[{accountId:revenue.id,amount:credit?amount:-amount,description:credit?'Synthetic credit note':'Synthetic consulting'}]})
      if(i<30)await postInvoice(invoice.id,actor)
      invoices.push(invoice.id)
    }
    const bill=await createInvoice({ledgerId,direction:'purchase',partyId:supplier.id,controlAccountId:ap.id,issuedOn:'2026-10-01',dueOn:'2026-10-31',number:'UI-BILL-1',actor,lines:[{accountId:expense.id,amount:45678n,description:'Synthetic office supplies'}]})
    await postInvoice(bill.id,actor);bills.push(bill.id)
    const projectId=await createProject({entityId,currency:'CAD',code:'UI-01',name:'Synthetic workshop renovation',customerPartyId:customer.id,site:'Test data only',actor})
    const base={entityId,projectId,actor},records:string[]=[]
    for(let i=0;i<28;i++) records.push(await saveProjectRecord({...base,kind:'revenue',partyId:customer.id,date:'2026-10-01',description:`Synthetic contract stage ${i+1}`,key:randomUUID(),
      lines:[{kind:'revenue',description:'Service',base:i===0?9007199254740993n:200000n,gst:10000n,pst:0n,gstRecoverable:null,pstRecoverable:null}]}))
    const cost=await saveProjectRecord({...base,kind:'cost',partyId:supplier.id,date:'2026-10-02',description:'Synthetic material cost',key:randomUUID(),lines:[{kind:'material',description:'Material',base:60000n,gst:3000n,pst:4200n,gstRecoverable:3000n,pstRecoverable:null}]})
    await createProjectPayment({...base,partyId:customer.id,direction:'received',date:'2026-10-03',amount:100000n,recordId:records[1],key:randomUUID()})
    const privatePath=join(mkdtempSync(join(tmpdir(),'figtree-ui-review-')),'fixture.json')
    writeFileSync(privatePath,JSON.stringify({...old,entityId,ledgerId,accountId:unused.id,revenueId:revenue.id,expenseId:expense.id,partyId:customer.id,supplierId:supplier.id,invoiceId:invoices[0],billId:bill.id,projectId,entryId:entry.entry.id}),{mode:0o600})
    writeFileSync(output,JSON.stringify({applicationDatabase:identity.name,privatePath,entityId,ledgerId,projectId,counts:{invoices:invoices.length,bills:bills.length,projectRecords:records.length+1},controlledCommandsOnly:true,productionTouched:false},null,2)+'\n')
    console.log('PASS synthetic populated UI fixture created through controlled commands in confirmed APP')
    void cost
  } finally { await connection.end() }
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Review fixture failed');process.exitCode=1})

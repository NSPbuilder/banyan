/** Seed only the newly-created APP; credentials stay in a private temporary file. */
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomBytes} from 'node:crypto'
import {db,sql as connection} from '../src/db/client'
import {sql} from 'drizzle-orm'
import {createFirstOwner,signIn} from '../src/lib/users'
import {p5Company} from './p5-fixtures'
async function main(){
  const proofPath='docs/evidence/p5/isolation.json',proof=JSON.parse(readFileSync(proofPath,'utf8'))
  if(!proof.createdNew||proof.productionTouched||new URL(process.env.DATABASE_URL!).pathname.slice(1)!==proof.applicationDatabase||proof.browserFixturePath)throw Error('APP seed not authorized by fresh P5 proof')
  const [empty]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM app_user`);if(empty.n)throw Error('P5 APP already has users; no re-seeding')
  const email='p5-browser@example.test',password=randomBytes(24).toString('base64url')
  await createFirstOwner({email,password,firstName:'P5 review owner'})
  const login=await signIn({email,password,clientIp:'192.0.2.95'}),co=await p5Company('P5UI',email)
  const invoiceId=await co.invoice('P5-1000'),otherInvoiceId=await co.invoice('P5-OTHER',42000n,co.otherCustomer.id)
  const dir=mkdtempSync(join(tmpdir(),'figtree-p5-ui-')),file=join(dir,'fixture.json')
  writeFileSync(file,JSON.stringify({email,password,token:login.token,ledgerId:co.ledger.id,entityId:co.company.id,invoiceId,otherInvoiceId,
    customerId:co.customer.id,otherCustomerId:co.otherCustomer.id,bank:co.at('1000'),clearing:co.at('1100'),fees:co.at('5000')}),{mode:0o600})
  proof.browserFixturePath=file;writeFileSync(proofPath,JSON.stringify(proof,null,2)+'\n')
  console.log('PASS P5UI00 seeded confirmed APP only; private browser fixture recorded.')
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Browser fixture failed');process.exitCode=1}).finally(()=>connection.end())

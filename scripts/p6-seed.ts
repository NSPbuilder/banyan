/** APP fixture only; never imports the application's default configuration. */
import './dotenv'
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomBytes} from 'node:crypto'
import {createFirstOwner,signIn} from '../src/lib/users'
import {db,sql as connection} from '../src/db/client'
import {sql} from 'drizzle-orm'
import {createCompany} from '../src/lib/setup'
async function main(){
  const path='docs/evidence/p6/isolation.json',proof=JSON.parse(readFileSync(path,'utf8'))
  if(!proof.createdNew||proof.productionTouched||new URL(process.env.DATABASE_URL!).pathname.slice(1)!==proof.applicationDatabase)throw Error('Unconfirmed P6 APP')
  if(proof.browserFixturePath)throw Error('Fixture exists; no second seed')
  const email='p6-browser@example.test',password=randomBytes(24).toString('base64url')
  const owner=await createFirstOwner({email,password,firstName:'P6 reviewer'})
  const login=await signIn({email,password,clientIp:'192.0.2.96'})
  const c=await createCompany({code:'P6UI',name:'P6 isolated review'},owner.email)
  const [account]=await db.execute<{id:string}>(sql`SELECT id::text FROM account WHERE entity_id=${c.company.id}::uuid ORDER BY code LIMIT 1`)
  const fixture=join(mkdtempSync(join(tmpdir(),'figtree-p6-browser-')),'fixture.json')
  writeFileSync(fixture,JSON.stringify({email,password,token:login.token,userId:owner.id,ledgerId:c.ledger.id,entityId:c.company.id,accountId:account?.id}),{mode:0o600})
  writeFileSync(path,JSON.stringify({...proof,browserFixturePath:fixture},null,2)+'\n')
  console.log('PASS P6 UI fixture created using actual users, signIn and company commands in confirmed APP')
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Fixture failed');process.exitCode=1}).finally(()=>connection.end())

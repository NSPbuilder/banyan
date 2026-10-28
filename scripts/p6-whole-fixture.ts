/** Creates nonempty restore state through existing controlled business doors. */
import './dotenv'
import {readFileSync} from 'node:fs'
import {randomBytes,randomUUID} from 'node:crypto'
import {parse} from 'dotenv'
import {sql} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner,signIn} from '../src/lib/users'
import {p5Company} from './p5-fixtures'
import {editLease} from '../src/lib/edit-leases'
import {requestActor,configureAutomation} from '../src/lib/automation-access'
import {createMailPreview,queueMail} from '../src/lib/mail'
import {setPrimaryContactEmail} from '../src/lib/parties'
async function main(){
  const proof=JSON.parse(readFileSync('docs/evidence/p6/isolation.json','utf8')),cfg=parse(readFileSync(proof.environmentPath))
  const url=new URL(process.env.DATABASE_URL!),source=new URL(cfg.TEST_DATABASE_URL)
  if(!proof.createdNew||proof.productionTouched||url.host!==source.host||!/^figtree_p6_legacy_[a-f0-9]{8}_test$/.test(url.pathname.slice(1)))throw Error('Unconfirmed restore fixture')
  const password=randomBytes(24).toString('base64url'),owner=await createFirstOwner({email:'restore@example.test',password,firstName:'Restore fixture'})
  const login=await signIn({email:owner.email,password}),actor=requestActor(login.token),co=await p5Company('P6RESTORE',owner.email)
  const invoice=await co.invoice('P6-RESTORE-1')
  await setPrimaryContactEmail(co.customer.id,'customer@example.test',owner.email)
  await editLease({ledgerId:co.ledger.id,type:'account',id:co.at('1000')},login.token,'acquire',{version:'1',tabId:randomUUID()})
  process.env.AUTOMATION_ENABLED='true'
  await configureAutomation(co.ledger.id,actor,{version:'0',enabled:true,mailEnabled:true,timezone:'America/Vancouver',senderEmail:'restore@example.test'})
  const preview=await createMailPreview(co.ledger.id,actor,{kind:'invoice',partyId:co.customer.id,invoiceId:invoice,asOf:'2026-10-08',to:'customer@example.test',cc:[],subject:'Isolated restore evidence',body:'No provider is contacted.',requestKey:randomUUID()})
  await queueMail(co.ledger.id,preview.id,actor)
  await db.execute(sql`INSERT INTO auth_passkey(user_id,credential_id,public_key,algorithm,counter,device_type,backed_up,rp_id,origin,name,aaguid)
    VALUES(${owner.id}::uuid,'restore-public-fixture',decode('00','hex'),-7,0,'multiDevice',true,'localhost','http://localhost:3096','Restore fixture','00000000-0000-0000-0000-000000000000')`)
  await db.execute(sql`INSERT INTO auth_webauthn_challenge(browser_hash,flow,challenge,rp_id,origin) VALUES('restore-browser','login','restore-challenge','localhost','http://localhost:3096')`)
  console.log('PASS actual company, posted invoice, active lease and queued mail/job created in dedicated restore clone; provider not contacted')
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Fixture failed');process.exitCode=1}).finally(()=>connection.end())

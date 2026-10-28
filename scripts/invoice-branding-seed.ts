/** A review fixture in the previously confirmed isolated APP; no real books. */
import './dotenv'
import {readFileSync,writeFileSync} from 'node:fs'
import {sql} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {userForToken} from '../src/lib/users'
import {createCompany} from '../src/lib/setup'
import {allInvoiceTemplates,createInvoiceTemplate} from '../src/lib/invoice-templates'
async function main(){
  const proof=JSON.parse(readFileSync('docs/evidence/p5/isolation.json','utf8'))
  if(!proof.createdNew||proof.productionTouched||new URL(process.env.DATABASE_URL!).pathname.slice(1)!==proof.applicationDatabase)throw Error('Unconfirmed branding APP')
  const session=JSON.parse(readFileSync(proof.browserFixturePath,'utf8')),me=await userForToken(session.token)
  if(!me||me.kind!=='superadmin')throw Error('Isolated template administrator unavailable')
  const [found]=await db.execute<{entity_id:string;ledger_id:string}>(sql`SELECT e.id::text AS entity_id,l.id::text AS ledger_id FROM entity e JOIN ledger l ON l.entity_id=e.id WHERE e.code='BRANDVM'`)
  const company=found??await (async()=>{const c=await createCompany({code:'BRANDVM',name:'VIEWMAX (isolated template sample)'},me.email);return {entity_id:c.company.id,ledger_id:c.ledger.id}})()
  const name='VIEWMAX branding acceptance',old=(await allInvoiceTemplates(me)).find(t=>t.entity_id===company.entity_id&&t.name===name)
  const id=old?.id??await createInvoiceTemplate(me,{entityId:company.entity_id,name,settings:{layout:'standard',paymentInstructions:'Bank transfer (sample)',footer:'Sample template. No real customer data.'}})
  writeFileSync('docs/evidence/invoice-branding/browser-fixture.json',JSON.stringify({templateId:id,templateName:name,entityId:company.entity_id,ledgerId:company.ledger_id,companyName:'VIEWMAX (isolated template sample)',privateSessionProof:'docs/evidence/p5/isolation.json'},null,2)+'\n')
  console.log('PASS branding fixture uses confirmed isolated APP and existing administrator/template commands')
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Branding seed failed');process.exitCode=1}).finally(()=>connection.end())

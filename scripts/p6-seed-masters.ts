import './dotenv'
import {readFileSync,writeFileSync} from 'node:fs'
import {createAccount} from '../src/lib/accounts'
import {createParty} from '../src/lib/parties'
import {sql as connection} from '../src/db/client'
async function main(){
  const proof=JSON.parse(readFileSync('docs/evidence/p6/isolation.json','utf8'))
  if(!proof.createdNew||proof.productionTouched||new URL(process.env.DATABASE_URL!).pathname.slice(1)!==proof.applicationDatabase)throw Error('Unconfirmed APP')
  const f=JSON.parse(readFileSync(proof.browserFixturePath,'utf8'));if(f.partyId||f.accountId)throw Error('Master fixture exists')
  const account=await createAccount({entityId:f.entityId,code:'1000',name:'P6 Cash',accountType:'asset',roles:['cash_and_cash_equivalents']},f.email)
  const party=await createParty({kind:'organisation',name:'P6 shared customer',roles:[{entityId:f.entityId,role:'customer',heldFrom:'2026-01-01'}],actor:f.email})
  writeFileSync(proof.browserFixturePath,JSON.stringify({...f,accountId:account.id,partyId:party.id}),{mode:0o600})
  console.log('PASS account and party fixture uses existing domain owners in confirmed APP')
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Fixture failed');process.exitCode=1}).finally(()=>connection.end())

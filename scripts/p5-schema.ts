import './env'
import {randomBytes} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {sql} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner} from '../src/lib/users'
import {p5Company} from './p5-fixtures'

async function main(){
  const name=new URL(process.env.DATABASE_URL!).pathname.slice(1)
  const proof=JSON.parse(readFileSync('docs/evidence/p5/isolation.json','utf8'))
  if(!proof.createdNew||proof.productionTouched||proof.testDatabase!==name||!/^[a-z][a-z0-9_]*_test$/.test(name)||process.env.TEST_DATABASE_CONFIRMATION!==name)throw Error('Unconfirmed schema probe')
  const owner=await createFirstOwner({email:'p5-schema@example.test',password:randomBytes(24).toString('base64url'),firstName:'P5 schema'})
  const co=await p5Company('P5SCHEMA',owner.email)
  const [row]=await db.execute<{id:string}>(sql`INSERT INTO payment_connection(entity_id,ledger_id,mode,clearing_account_id,fee_account_id)
    VALUES(${co.company.id}::uuid,${co.ledger.id}::uuid,'test',${co.at('1100')}::uuid,${co.at('5000')}::uuid) RETURNING id::text`)
  if(!row)throw Error('No setting inserted')
  console.log('PASS P5SC01 actual settings insert reaches all generic trigger branches')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

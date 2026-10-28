/** Bounded OS scheduler entry, like automation:worker. Never loads defaults. */
import {readFileSync} from 'node:fs'
import {userInfo} from 'node:os'
async function main(){
  const args=process.argv.slice(2),get=(k:string)=>args[args.indexOf(k)+1]
  const raw=process.env.DATABASE_URL
  if(!raw||!args.includes('--database')||new URL(raw).pathname.slice(1)!==get('--database'))throw Error('Set DATABASE_URL explicitly and pass --database <exact name>.')
  const actor=`scheduler:${userInfo().username}`,{runAuditVerification,recordAuditUnavailable}=await import('../src/lib/audit-chain')
  let checkpoint
  try{checkpoint=args.includes('--checkpoint')?JSON.parse(readFileSync(get('--checkpoint'),'utf8')):undefined}
  catch(error){await recordAuditUnavailable(actor);throw error}
  const result=await runAuditVerification(actor,checkpoint,args.includes('--require-independent'))
  console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Audit verification failed');process.exitCode=1}).finally(async()=>{
  if(process.env.DATABASE_URL){const {sql}=await import('../src/db/client');await sql.end()}
})

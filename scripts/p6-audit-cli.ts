/** Actual scheduler errors and visible result persistence in confirmed APP. */
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parse} from 'dotenv'
import postgres from 'postgres'
import {reporter} from './suite'
const r=reporter(80)
async function main(){
  const proof=JSON.parse(readFileSync('docs/evidence/p6/isolation.json','utf8')),cfg=parse(readFileSync(proof.environmentPath))
  if(!proof.createdNew||proof.productionTouched||new URL(cfg.DATABASE_URL).pathname.slice(1)!==proof.applicationDatabase)throw Error('Unconfirmed APP')
  const connection=postgres(cfg.DATABASE_URL,{max:1}),dir=mkdtempSync(join(tmpdir(),'figtree-p6-checker-'))
  const run=(args:string[],hasURL=true)=>spawnSync('npx',['tsx','scripts/audit-verify.ts',...args],{env:{...process.env,...cfg,DATABASE_URL:hasURL?cfg.DATABASE_URL:undefined,NODE_OPTIONS:'--conditions=react-server'},encoding:'utf8'})
  const latest=async()=>(await connection`SELECT result FROM audit_verification_run ORDER BY checked_at DESC,id DESC LIMIT 1`)[0].result
  try{
    const exact=['--database',proof.applicationDatabase]
    const missing=run(exact,false);r.check(missing.status!==0&&missing.stderr.includes('Set DATABASE_URL explicitly'),'P6C01 scheduler refuses implicit default URL')
    const wrong=run(['--database','another_database']);r.check(wrong.status!==0&&wrong.stderr.includes('Set DATABASE_URL explicitly'),'P6C02 scheduler refuses wrong explicit database identity')
    for(const [label,path]of [['P6C03 missing checkpoint file persists visible unavailable',join(dir,'missing.json')],['P6C04 malformed checkpoint file persists visible unavailable',join(dir,'invalid.json')]]){
      if(path.endsWith('invalid.json'))writeFileSync(path,'{invalid',{mode:0o600})
      const out=run([...exact,'--checkpoint',path]),result=await latest()
      r.check(out.status!==0&&result.ok===false&&result.issues.some((i:{type:string})=>i.type==='unavailable'),label)
    }
    const required=run([...exact,'--require-independent']),requiredResult=await latest()
    r.check(required.status!==0&&requiredResult.issues.some((i:{type:string})=>i.type==='missing_independent_checkpoint'),'P6C05 required missing independent checkpoint records failure')
    const good=run(exact);r.check(good.status===0&&(await latest()).ok===true,'P6C06 actual normal scheduler run persists current success')
    console.log(r.summary());process.exitCode=r.failures?1:0
  }finally{await connection.end()}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Scheduler acceptance failed');process.exitCode=1})

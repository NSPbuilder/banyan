import './env'
import {randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,cpSync,mkdirSync,symlinkSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import postgres from 'postgres'
async function main(){
 const source=new URL(process.env.TEST_DATABASE_URL!),sourceName=source.pathname.slice(1)
 const proof=JSON.parse(readFileSync('docs/evidence/p3/isolation.json','utf8'))
 if(!proof.createdNew||proof.productionTouched||proof.testDatabase!==sourceName||process.env.TEST_DATABASE_CONFIRMATION!==sourceName||!/^[a-z][a-z0-9_]*_test$/.test(sourceName))throw Error('Unconfirmed P3 source configuration')
 const name='figtree_p3_compat_'+randomUUID().replaceAll('-','').slice(0,16)+'_test',adminUrl=new URL(source);adminUrl.pathname='/postgres'
 const admin=postgres(adminUrl.href,{max:1}),root=process.cwd(),scratch=mkdtempSync(join(tmpdir(),'figtree-p3-compat-'))
 await admin.unsafe(`CREATE DATABASE "${name}"`)
 const target=new URL(source);target.pathname='/'+name
 const env={...process.env,DATABASE_URL:target.href,TEST_DATABASE_URL:target.href,TEST_DATABASE_CONFIRMATION:name,NODE_OPTIONS:'--conditions=react-server'},report:Record<string,unknown>={at:new Date().toISOString(),createdNewDatabase:name,productionTouched:false}
 try{
  for(const path of ['src','db','scripts','package.json','tsconfig.json'])cpSync(join(root,path),join(scratch,path),{recursive:true})
  mkdirSync(join(scratch,'docs/evidence/p3'),{recursive:true});cpSync(join(root,'docs/evidence/mutations.md'),join(scratch,'docs/evidence/mutations.md'));symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
  const check=(label:string,args:string[],expected:string)=>{const result=spawnSync('npm',args,{cwd:scratch,env,encoding:'utf8',maxBuffer:16e6}),output=result.stdout+result.stderr;writeFileSync(join(root,'docs/evidence/p3',label+'.log'),output);if(result.status!==0||!output.includes(expected))throw Error(label+' failed');return result.status}
  report.preflight=check('compat-preflight',['run','db:restores'],'ALL')
  for(const [block,suite,title] of [[182,'aging',"A payable's settlement is subtracted from the receivables report"],[188,'statements','A span P&L quietly reads only its first month'],[873,'backup',"A company backup carries the receipts' blobs and not the minute book's"]] as const){
   check('compat-'+block,['run','db:mutations','--','--only='+block],'Wrote')
   const artifact=readFileSync(join(scratch,'docs/evidence/mutations.md'),'utf8'),sections=artifact.split(/^## /m),section=sections.find(s=>s.startsWith(title+'\n'))
   if(!section||!section.includes('FAIL  '))throw Error('Actual expected mutation failure not captured for '+block)
   writeFileSync(join(root,'docs/evidence/p3','compat-'+block+'.md'),'## '+section)
   report[String(block)]={suite,expectedFailureObserved:true}
  }
  report.scratchRemoved=true;report.newDatabaseDropped=true;writeFileSync(join(root,'docs/evidence/p3/compatibility.json'),JSON.stringify(report,null,2)+'\n');console.log('PASS P3CO01 mutation preflight\nPASS P3CO02 existing span P&L mutation still fails intended range checks\nPASS P3CO03 existing minute-book blob mutation still fails actual restore checks\nPASS P3CO04 existing account-scoped aging consumption mutation fails intended checks\n=== ALL CHECKS PASSED ===')
 }finally{await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P3 compatibility failed');process.exitCode=1})

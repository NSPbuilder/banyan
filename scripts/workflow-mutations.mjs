import {mkdtemp,cp,symlink,readFile,writeFile,rm,constants} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parse} from 'dotenv'
import assert from 'node:assert/strict'
const root=process.cwd(),out=join(root,'docs/evidence/workflow-placement-2026-10-09'),proof=JSON.parse(await readFile(join(out,'isolation.json'),'utf8')),cfg=parse(await readFile(proof.environmentPath))
assert(proof.createdNew&&!proof.productionTouched);assert.equal(new URL(cfg.TEST_DATABASE_URL).pathname.slice(1),proof.testDatabase);assert.equal(cfg.TEST_DATABASE_CONFIRMATION,proof.testDatabase)
const baseline=await readFile(join(out,'verify-final.log'),'utf8');assert(baseline.includes('=== ALL CHECKS PASSED ===')&&!/FAIL\s/.test(baseline))
const mutations=[
  ['customer-email','src/lib/mail.ts',"if(input.kind==='invoice'){","if(false){",'WF01'],
  ['reminder-email','src/lib/mail.ts','if(input.enabled){const email=','if(false){const email=','WF02'],
  ['smtp-cipher','src/lib/company-services.ts',"sealIntegration(input.password,s.entity_id,'smtp-password')",'Buffer.from(input.password)','WF06'],
  ['company-schedule','src/lib/mail.ts','if(!r.uses_company_defaults)return r','if(true)return r','WF18'],
  ['portable-secret','src/lib/backup.ts',"if(table==='automation_setting')return {...row,smtp_password_ciphertext:null,smtp_username:null,smtp_host:null,enabled:false,mail_enabled:false}","if(table==='automation_setting')return row",'WF23'],
]
const results=[]
for(const [name,path,before,after,target] of mutations){const scratch=await mkdtemp(join(tmpdir(),'figtree-workflow-mutant-'))
  try{for(const p of ['src','scripts','db/migrations','package.json','package-lock.json','tsconfig.json','next.config.ts','postcss.config.mjs','next-env.d.ts','eslint.config.mjs'])await cp(join(root,p),join(scratch,p),{recursive:true,mode:constants.COPYFILE_FICLONE});await symlink(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
  const source=await readFile(join(scratch,path),'utf8');assert.equal(source.split(before).length,2);await writeFile(join(scratch,path),source.replace(before,after))
  const run=spawnSync('npm',['run','db:verify-workflow'],{cwd:scratch,env:{...process.env,...cfg,NODE_OPTIONS:''},encoding:'utf8',maxBuffer:20e6}),text=run.stdout+run.stderr;await writeFile(join(out,'mutation-'+name+'.log'),text)
  const caught=run.status!==0&&new RegExp('FAIL\\s+'+target+'\\b').test(text);results.push({name,target,exit:run.status,caught});console.log(caught?'CAUGHT':'FAILED',name,target);assert(caught,'Mutation was not detected by '+target)
  }finally{await rm(scratch,{recursive:true,force:true})}
}
await writeFile(join(out,'mutations.json'),JSON.stringify(results,null,2)+'\n');console.log('All',results.length,'mutations detected')

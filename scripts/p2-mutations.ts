import './dotenv'
import { cp,mkdtemp,readFile,writeFile,symlink,rm,mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cases=[
  {title:'Old failed worker pauses new template authorization',label:'P2R27',file:'src/lib/automation-worker.ts',before:"AND generation=${job.generation}::bigint AND status='paused' FOR UPDATE",after:"FOR UPDATE"},
  {title:'Expired worker generation accepted',label:'P2J04',file:'src/lib/jobs.ts',before:'AND generation=${j.generation}::bigint AND locked_until>clock_timestamp() FOR UPDATE',after:'AND locked_until>clock_timestamp() FOR UPDATE'},
  {title:'Source total mismatch ignored',label:'P2I08',file:'src/lib/automation-drafts.ts',before:'if((movement<0n?-movement:movement)!==total)',after:'if(false)'},
  {title:'SMTP DATA timeout blindly retried',label:'P2M10',file:'src/lib/mail.ts',before:"if(e.code==='ETIMEDOUT')return 'delivery_unknown'",after:"if(e.code==='ETIMEDOUT')return 'retry'"},
  {title:'Converted inbox reopened',label:'P2I14',migration:'DROP TRIGGER p2_inbox_final ON inbox_item;'},
  {title:'Approved email content changed',label:'P2M03',migration:'DROP TRIGGER p2_mail_snapshot_kept ON email_message;'},
  {title:'Occurrence business uniqueness removed',label:'P2R15',migration:"DO $$ DECLARE c text; BEGIN SELECT conname INTO c FROM pg_constraint WHERE conrelid='recurring_occurrence'::regclass AND contype='u'; EXECUTE format('ALTER TABLE recurring_occurrence DROP CONSTRAINT %I',c); END $$;"},
  {title:'Inbox company/ledger scope removed',label:'P2I17',migration:'DROP TRIGGER p2_scope ON inbox_item;'},
  {title:'Original private source identity changed',label:'P2I19',migration:'DROP TRIGGER p2_inbox_source_kept ON inbox_item;'},
  {title:'Email invoice/customer mismatch permitted',label:'P2M22',migration:'DROP TRIGGER p2_mail_customer_identity ON email_message;'},
  {title:'Target business module authorization removed',label:'P2A01',file:'src/lib/automation-access.ts',before:"new Set(['/automation',...(options.seat?[options.seat]:[])])",after:"new Set(['/automation'])"},
]
async function main() {
  const target=process.env.TEST_DATABASE_URL,name=target?new URL(target).pathname.slice(1):''
  if(!target||process.env.TEST_DATABASE_CONFIRMATION!==name||!/^[a-z][a-z0-9_]*_test$/.test(name))throw Error('Unconfirmed P2 mutation database')
  const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'figtree-p2-mutations-')),evidence=join(root,'docs/evidence/p2')
  await mkdir(evidence,{recursive:true});const originals=new Map<string,string>()
  for(const c of cases)if('file' in c&&c.file)originals.set(c.file,await readFile(join(root,c.file),'utf8'))
  const report=['# P2 guard discrimination','','Real PostgreSQL and TCP SMTP cases run in a disposable source copy. No shared code is edited.',''];let failures=0
  try {
    for(const part of ['src','db','scripts','package.json','tsconfig.json'])await cp(join(root,part),join(scratch,part),{recursive:true})
    await symlink(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
    const run=()=>spawnSync('npm',['run','db:verify-p2'],{cwd:scratch,env:{...process.env,NODE_OPTIONS:'--conditions=react-server'},encoding:'utf8',maxBuffer:16e6})
    const baseline=run();await writeFile(join(evidence,'mutation-baseline.log'),baseline.stdout+baseline.stderr)
    if(baseline.status!==0||!baseline.stdout.includes('=== ALL CHECKS PASSED ==='))throw Error('P2 mutation baseline failed')
    report.push('Baseline: exit 0; all checks passed.','')
    for(let i=0;i<cases.length;i++) {
      for(const [file,source] of originals)await writeFile(join(scratch,file),source)
      await rm(join(scratch,'db/migrations/9999_p2_discrimination_only.sql'),{force:true})
      const c=cases[i]
      if('file' in c&&c.file){const source=originals.get(c.file)!;if(source.split(c.before!).length!==2)throw Error('Mutation anchor must be unique: '+c.title);await writeFile(join(scratch,c.file),source.replace(c.before!,c.after!))}
      else if('migration' in c)await writeFile(join(scratch,'db/migrations/9999_p2_discrimination_only.sql'),c.migration!)
      const result=run(),output=result.stdout+result.stderr,log=`mutation-${i+1}.log`
      await writeFile(join(evidence,log),output)
      const lines=output.split('\n').filter(line=>line.startsWith('FAIL')&&line.includes(c.label)),proven=result.status!==0&&lines.length>0
      if(!proven)failures++;console.log(`${proven?'PASS':'FAIL'} P2MU${i+1} ${c.title}`)
      report.push(`## P2MU${i+1}: ${c.title}`,'',`Exit ${result.status}; ${proven?'expected assertion failed':'NOT PROVEN'}. [Actual output](${log}).`,'','```text',...lines,'```','')
    }
    for(const [file,source] of originals)if(await readFile(join(root,file),'utf8')!==source)throw Error('Shared source changed during discrimination: '+file)
    report.push(`${cases.length-failures}/${cases.length} expected failures observed. Shared source bytes unchanged.`)
    await writeFile(join(evidence,'mutations.md'),report.join('\n')+'\n')
    console.log(failures?'=== DISCRIMINATION FAILED ===':'=== ALL CHECKS PASSED ===');process.exitCode=failures?1:0
  } finally {await rm(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P2 discrimination failed');process.exitCode=1})

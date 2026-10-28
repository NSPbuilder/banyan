/** Real discrimination runs in a disposable source copy and a confirmed test
 * database. No shared source edits, production URLs or fabricated replies. */
import './dotenv'
import {cp,mkdtemp,readFile,writeFile,symlink,rm,mkdir} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const cases=[
  {title:'Stale version validation removed',label:'P1E07',file:'src/lib/edit-leases.ts',before:'if (row.version !== context.proof.version)',after:'if (false)'},
  {title:'Recovery code consumption accepted twice',label:'P1A15',file:'src/lib/auth-security.ts',before:'if (rows.length !== 1) throw authRefusal()\n  } else {',after:'// Fault: ignore failed atomic consumption\n  } else {'},
  {title:'Integer cents converted through floating point',label:'P1A02',file:'src/lib/money.ts',before:"const cents = BigInt(whole || '0') * SCALE + BigInt(frac.padEnd(2, '0') || '0')",after:"const cents = BigInt(Math.round(Number(whole + '.' + frac) * 100))"},
  {title:'Cross-ledger lease database trigger removed',label:'P1E16',migration:'DROP TRIGGER p1_lease_scope ON document_edit_lease;'},
  {title:'Required administrator MFA skipped in business transaction',label:'P1A28',file:'src/lib/auth-security.ts',before:"AND (${process.env.AUTH_ADMIN_MFA_REQUIRED !== 'true' || allowMfaSetup}\n        OR u.kind NOT IN ('owner','superadmin') OR u.mfa_secret_ciphertext IS NOT NULL OR s.strong_authenticated_at IS NOT NULL)",after:'AND true'},
]
async function main(){
  const name=new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1)
  if(process.env.TEST_DATABASE_CONFIRMATION!==name || !/^[a-z][a-z0-9_]*_test$/.test(name))throw Error('Unconfirmed mutation database')
  const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'figtree-p1-mutations-')),evidence=join(root,process.env.P1_EVIDENCE_DIR??'docs/evidence/p1')
  await mkdir(evidence,{recursive:true});const report=['# P1 guard discrimination','','Each injected defect runs actual PostgreSQL assertions in a disposable source copy.','']
  const originals=new Map<string,string>();for(const c of cases)if('file' in c && c.file)originals.set(c.file,await readFile(join(root,c.file),'utf8'))
  let failures=0
  try{
    for(const file of ['src','db','scripts','docs/implementation','package.json','tsconfig.json'])await cp(join(root,file),join(scratch,file),{recursive:true})
    await symlink(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
    const run=()=>spawnSync('npm',['run','db:verify-p1'],{cwd:scratch,env:{...process.env,NODE_OPTIONS:'--conditions=react-server'},encoding:'utf8',maxBuffer:8e6})
    const baseline=run(),baselineText=baseline.stdout+baseline.stderr;await writeFile(join(evidence,'mutation-baseline.log'),baselineText)
    if(baseline.status!==0 || !baselineText.includes('=== ALL CHECKS PASSED ==='))throw Error('Discrimination baseline failed')
    report.push('Baseline: exit 0, all checks passed.','')
    for(let i=0;i<cases.length;i++){
      for(const [file,text] of originals)await writeFile(join(scratch,file),text)
      await rm(join(scratch,'db/migrations/0121_discrimination_only.sql'),{force:true})
      const c=cases[i]
      if('file' in c && c.file){const text=originals.get(c.file)!;if(text.split(c.before!).length!==2)throw Error('Nonunique mutation anchor: '+c.title);await writeFile(join(scratch,c.file),text.replace(c.before!,c.after!))}
      else if('migration' in c)await writeFile(join(scratch,'db/migrations/0121_discrimination_only.sql'),c.migration!)
      const result=run(),output=result.stdout+result.stderr,log=`mutation-${i+1}.log`
      await writeFile(join(evidence,log),output)
      const assertion=output.split('\n').filter(line=>line.startsWith('FAIL') && line.includes(c.label))
      const proven=result.status!==0 && assertion.length>0;if(!proven)failures++
      console.log(`${proven?'PASS':'FAIL'} M${i+1} ${c.title}`)
      report.push(`## M${i+1}: ${c.title}`,'',`Exit ${result.status}; ${proven?'guard proven':'NOT PROVEN'}. [Actual output](${log}).`,'','```text',...assertion,'```','')
    }
    for(const [file,text] of originals)if(await readFile(join(root,file),'utf8')!==text)throw Error('Shared source changed: '+file)
    report.push(`Shared source bytes unchanged. ${cases.length-failures}/${cases.length} expected failures observed.`)
    await writeFile(join(evidence,'mutations.md'),report.join('\n')+'\n')
    console.log(failures?'=== DISCRIMINATION FAILED ===':'=== ALL CHECKS PASSED ===');process.exitCode=failures?1:0
  }finally{await rm(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Discrimination failed');process.exitCode=1})

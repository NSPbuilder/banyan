/** Guard discrimination owns freshly created, empty, confirmed databases and source copies. */
import {cp,mkdtemp,readFile,writeFile,symlink,rm,mkdir,stat} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomBytes} from 'node:crypto'
import {parse} from 'dotenv'
import postgres from 'postgres'
const cases=[
  {title:'Audit display comparison removed',suite:'audit',label:'P6A15',sqlBefore:'a.canonical_bytes IS DISTINCT FROM audit_event_v1(a)',sqlAfter:'false'},
  {title:'Audit head comparison removed',suite:'audit',label:'P6A21',sqlBefore:'seq<>h.sequence OR prev<>h.hash',sqlAfter:'false'},
  {title:'Audit independent checkpoint comparison removed',suite:'audit',label:'P6A23',file:'src/lib/audit-chain.ts',before:'if(!matched)result.issues.push',after:'if(false)result.issues.push'},
  {title:'Passkey challenge expiry removed',suite:'passkeys',label:'P6W10',file:'src/lib/passkeys.ts',before:'AND expires_at>clock_timestamp()',after:''},
  {title:'Passkey challenge single consumption removed',suite:'passkeys',label:'P6W02',file:'src/lib/passkeys.ts',before:'AND consumed_at IS NULL AND expires_at',after:'AND expires_at'},
  {title:'Passkey user verification removed',suite:'passkeys',label:'P6W09',file:'src/lib/passkeys.ts',before:'requireUserVerification:true',after:'requireUserVerification:false',count:2,extra:[['||!v.registrationInfo.userVerified',''],['||!verified.authenticationInfo.userVerified','']]},
  {title:'Master version comparison removed',suite:'masters',label:'P6M04',file:'src/lib/edit-leases.ts',before:'if (row.version !== context.proof.version)',after:'if (false)'},
  {title:'Master live lease generation check removed',suite:'masters',label:'P6M23',file:'src/lib/edit-leases.ts',before:'if ((context.leaseRequired && (!owner || !lease?.live)) || (lease?.live && !owner))',after:'if (false)'},
]
async function main(){
  const root=process.cwd(),proof=JSON.parse(await readFile('docs/evidence/p6/isolation.json','utf8'))
  if(!proof.createdNew||proof.productionTouched||(await stat(proof.environmentPath)).mode%512!==0o600)throw Error('Unconfirmed isolation')
  const cfg=parse(await readFile(proof.environmentPath)),source=new URL(cfg.TEST_DATABASE_URL)
  if(source.pathname.slice(1)!==proof.testDatabase||cfg.TEST_DATABASE_CONFIRMATION!==proof.testDatabase)throw Error('Identity mismatch')
  const id=randomBytes(4).toString('hex'),names=[`figtree_p6_mutation_app_${id}_test`,`figtree_p6_mutation_${id}_test`]
  const adminUrl=new URL(source);adminUrl.pathname='/postgres';const admin=postgres(adminUrl.href,{max:1}),created:string[]=[]
  const scratch=await mkdtemp(join(tmpdir(),'figtree-p6-mutations-')),evidence=join(root,'docs/evidence/p6'),originals=new Map<string,string>()
  const url=(name:string)=>{const u=new URL(source);u.pathname='/'+name;return u.href}
  const env={...process.env,...cfg,DATABASE_URL:url(names[0]),APP_DATABASE_URL:url(names[0]),TEST_DATABASE_URL:url(names[1]),TEST_DATABASE_CONFIRMATION:names[1],NODE_OPTIONS:'--conditions=react-server',P6_WEBAUTHN_TEST_PORT:'3094',TEST_ATTACHMENTS_DIR:join(scratch,'attachments'),TEST_PROJECT_ATTACHMENTS_DIR:join(scratch,'projects')}
  const rows:Record<string,unknown>[]=[],report=['# P6 guard discrimination','','All runs use real PostgreSQL, WebAuthn cryptographic verification and a disposable source copy. No shared source mutation.','']
  let failures=0
  try{
    for(const name of names){if(!/^figtree_p6_mutation(_app)?_[a-f0-9]{8}_test$/.test(name))throw Error('Unsafe name');await admin.unsafe(`CREATE DATABASE "${name}"`);created.push(name)
      const c=postgres(url(name),{max:1});try{const [r]=await c`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`;if(r.n!==0)throw Error('Not empty')}finally{await c.end()}}
    await writeFile(join(evidence,'mutation-isolation.json'),JSON.stringify({createdNew:true,productionTouched:false,databases:names,initialPublicTables:[0,0]},null,2)+'\n')
    for(const p of ['src','db','scripts','package.json','tsconfig.json'])await cp(join(root,p),join(scratch,p),{recursive:true})
    await symlink(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
    await mkdir(join(scratch,'docs/implementation'),{recursive:true})
    for(const c of cases)if(c.file)originals.set(c.file,await readFile(join(root,c.file),'utf8'))
    const run=(suite:string)=>spawnSync('npm',['run','db:verify-p6-'+suite],{cwd:scratch,env,encoding:'utf8',maxBuffer:16e6})
    for(const suite of ['audit','passkeys','masters']){const b=run(suite);await writeFile(join(evidence,`mutation-baseline-${suite}.log`),b.stdout+b.stderr);if(b.status!==0||!b.stdout.includes('=== ALL CHECKS PASSED ==='))throw Error('Mutation baseline failed: '+suite)}
    for(let i=0;i<cases.length;i++){
      for(const[file,text]of originals)await writeFile(join(scratch,file),text)
      const migration=join(scratch,'db/migrations/0999_p6_discrimination_only.sql');await rm(migration,{force:true})
      const c=cases[i]
      if(c.sqlBefore){const original=await readFile(join(root,'db/migrations/0137_p6_verifier_name_resolution.sql'),'utf8');if(original.split(c.sqlBefore).length!==2)throw Error('Nonunique SQL anchor');await writeFile(migration,original.replace(c.sqlBefore,c.sqlAfter!))}
      else{
        let original=originals.get(c.file!)!;if(original.split(c.before!).length!==(c.count??1)+1)throw Error('Nonunique source anchor: '+c.title)
        original=original.split(c.before!).join(c.after!);for(const [before,after]of c.extra??[])original=original.replace(before,after)
        await writeFile(join(scratch,c.file!),original)
      }
      const out=run(c.suite),body=out.stdout+out.stderr,log=`mutation-${i+1}.log`;await writeFile(join(evidence,log),body)
      const failed=body.split('\n').filter(l=>l.startsWith('FAIL')&&l.includes(c.label)),proven=out.status!==0&&failed.length>0;if(!proven)failures++
      console.log(`${proven?'PASS':'FAIL'} P6MU${i+1} ${c.title}`)
      rows.push({title:c.title,target:c.label,suite:c.suite,exit:out.status,proven,log,failedLines:failed})
      report.push(`## P6MU${i+1}: ${c.title}`,'',`Exit ${out.status}; expected assertion ${proven?'failed':'NOT OBSERVED'}. [Output](${log}).`,'','```text',...failed,'```','')
    }
    for(const[file,text]of originals)if(await readFile(join(root,file),'utf8')!==text)throw Error('Shared source changed during discrimination: '+file)
    report.push(`${cases.length-failures}/${cases.length} expected failures observed. Root source bytes unchanged.`)
    await writeFile(join(evidence,'mutations.md'),report.join('\n')+'\n');await writeFile(join(evidence,'mutations.json'),JSON.stringify({cases:rows,sharedSourceUnchanged:true},null,2)+'\n')
    console.log(failures?'=== DISCRIMINATION FAILED ===':'=== ALL CHECKS PASSED ===');process.exitCode=failures?1:0
  }finally{for(const name of created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();await rm(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P6 discrimination failed');process.exitCode=1})

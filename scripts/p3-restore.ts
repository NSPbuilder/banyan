import './env'
import {randomUUID,createHash} from 'node:crypto'
import {spawnSync,execFileSync} from 'node:child_process'
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,mkdirSync,copyFileSync,cpSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import postgres from 'postgres'
import {pgTool} from '../src/lib/backup-paths'
import {seedLegacyFinancialFixture,legacyFinancialColumns} from './legacy-upgrade-fixture'
const args=process.argv.slice(2),sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
const financial=['entity','ledger','account','account_role','party','party_role','fiscal_year','fiscal_period','journal_entry','journal_line','period_balance','invoice','invoice_line','invoice_application','bank_transaction','bank_match','bank_statement']
async function child(mode:string,name:string,path:string){
 if(new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1)!==name||process.env.TEST_DATABASE_CONFIRMATION!==name||!/^figtree_p3_restore_[a-z0-9_]+_test$/.test(name))throw Error('Unconfirmed new P3 restore fixture')
 const {db,sql:connection}=await import('../src/db/client'),{sql}=await import('drizzle-orm')
 try{
  if(mode==='--seed'){
   const {createFirstOwner}=await import('../src/lib/users'),{createCompany,createFiscalYear}=await import('../src/lib/setup')
   const email='p3-restore@example.test',password='Private disposable P3 restore passphrase',owner=await createFirstOwner({email,password,firstName:'P3 restore'}),co=await createCompany({code:'P3OLD',name:'P3 prior-schema fixture'},owner.email)
   await createFiscalYear(co.ledger.id,'2026-09-30',email)
   await seedLegacyFinancialFixture(connection,{entityId:co.company.id,ledgerId:co.ledger.id,actor:email,date:'2026-08-01',description:'Fixed pre-P3 123.45'})
   writeFileSync(path,JSON.stringify({email,password}),{mode:0o600})
  }else{
   const f=JSON.parse(readFileSync(path,'utf8')),{signIn}=await import('../src/lib/users'),{planningActor}=await import('../src/lib/planning-access'),{buildP3Lifecycle,p3Proof}=await import('./p3-lifecycle'),{importDetail,runImportBatch}=await import('../src/lib/ledger-import')
   const session=await signIn({email:f.email,password:f.password,clientIp:'192.0.2.95'}),actor=planningActor(session.token)
   if(mode==='--features'){
    const built=await buildP3Lifecycle(f.email,session.token,'P3RS',true)
    writeFileSync(path,JSON.stringify({...f,ledgerId:built.ledgerId,runId:built.runId}),{mode:0o600})
   }else{
    const resource={ledgerId:f.ledgerId,type:'migration' as const,id:f.runId},d=await importDetail(f.ledgerId,f.runId,actor)
    if(d.run.status!=='restored_paused'||d.completed.length!==12)throw Error('Restored incomplete migration was not paused at its exact checkpoint')
    let refused=false;try{await runImportBatch(f.ledgerId,f.runId,actor,await p3Proof(resource,session.token))}catch(e){refused=String(e).includes('explicitly approve')}
    if(!refused)throw Error('Restore resume did not require fresh human approval')
    const batch=await runImportBatch(f.ledgerId,f.runId,actor,await p3Proof(resource,session.token),d.run.validated_digest!)
    if(batch.completed!==2||batch.remaining!==0||!batch.reconciliation?.ok)throw Error('Restored source replay did not reconcile exactly once')
    const [bank]=await db.execute<{date:string}>(sql`SELECT original_issued_on::text AS date FROM migration_reference WHERE run_id=${f.runId}::uuid AND source_key='source:BANKSTART'`)
    if(bank.date!=='2025-12-20')throw Error('Bank source metadata was not preserved')
   }
  }
 }finally{await connection.end()}
}
async function main(){
 if(args.length){await child(args[0],args[1],args[2]);return}
 const target=new URL(process.env.TEST_DATABASE_URL!),confirmed=target.pathname.slice(1)
 const proof=JSON.parse(readFileSync('docs/evidence/p3/isolation.json','utf8'))
 if(!proof.createdNew||proof.productionTouched||proof.testDatabase!==confirmed||process.env.TEST_DATABASE_CONFIRMATION!==confirmed||!/^[a-z][a-z0-9_]*_test$/.test(confirmed))throw Error('P3 isolation is not confirmed')
 const root=process.cwd(),scratch=mkdtempSync(join(tmpdir(),'figtree-p3-restore-')),evidence=join(root,'docs/evidence/p3'),fixture=join(scratch,'fixture.json'),paper=join(scratch,'paper'),restoredPaper=join(scratch,'restored-paper'),adminUrl=new URL(target);adminUrl.pathname='/postgres'
 const admin=postgres(adminUrl.href,{max:1}),created:string[]=[],report:Record<string,unknown>={at:new Date().toISOString(),sourceConfiguration:confirmed,productionTouched:false}
 const pgEnv={...process.env,PGHOST:target.hostname,PGPORT:target.port||'5432',PGUSER:decodeURIComponent(target.username)||process.env.USER,PGPASSWORD:decodeURIComponent(target.password)}
 const env=(name:string,files=paper)=>{const u=new URL(target);u.pathname='/'+name;return {...process.env,DATABASE_URL:u.href,TEST_DATABASE_URL:u.href,TEST_DATABASE_CONFIRMATION:name,ATTACHMENTS_DIR:files,TEST_ATTACHMENTS_DIR:files,AUTOMATION_ENABLED:'false',NODE_OPTIONS:'--conditions=react-server'}}
 const fresh=async(label:string)=>{const name='figtree_p3_restore_'+label+'_'+randomUUID().replaceAll('-','').slice(0,12)+'_test';await admin.unsafe(`CREATE DATABASE "${name}"`);created.push(name);return name}
 const run=(label:string,command:string[],environment:NodeJS.ProcessEnv,cwd=root)=>{const r=spawnSync(command[0],command.slice(1),{env:environment,cwd,encoding:'utf8',maxBuffer:16e6});writeFileSync(join(evidence,label+'.log'),r.stdout+r.stderr);if(r.status!==0)throw Error(label+' failed; inspect actual log')}
 const snapshot=async(name:string,tables?:string[],columns?:Record<string,string[]>)=>{const c=postgres(env(name).DATABASE_URL,{max:1});try{const names=tables??(await c`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`).map(r=>String(r.tablename));const hashes:Record<string,string>={};for(const table of names){if(!/^[a-z_][a-z0-9_]*$/.test(table))throw Error('Unsafe fixture table');const [row]=await c.unsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS data FROM (SELECT ${columns?columns[table].map(column=>{if(!/^[a-z_][a-z0-9_]*$/.test(column))throw Error('Unsafe column');return '"'+column+'"'}).join(','):'*'} FROM "${table}") t`);hashes[table]=sha(row.data)}return hashes}finally{await c.end()}}
 const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
 try{
  const old=await fresh('old124'),oldDir=join(scratch,'old');mkdirSync(join(oldDir,'db/migrations'),{recursive:true})
  for(const file of readdirSync(join(root,'db/migrations')).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<=124))copyFileSync(join(root,'db/migrations',file),join(oldDir,'db/migrations',file))
  const tsx=join(root,'node_modules/tsx/dist/cli.mjs')
  run('whole-old124-migrate',[process.execPath,tsx,join(root,'scripts/migrate.ts'),'--database',old],env(old),oldDir)
  run('whole-old124-seed',[process.execPath,'--conditions=react-server','--import','tsx','scripts/p3-restore.ts','--seed',old,fixture],env(old))
  const legacyConnection=postgres(env(old).DATABASE_URL,{max:1})
  const legacyColumns=await legacyFinancialColumns(legacyConnection,financial);await legacyConnection.end()
  const before=await snapshot(old,financial,legacyColumns),oldDump=join(scratch,'old.dump');execFileSync(pgTool('pg_dump'),['--format=custom','--file',oldDump],{env:{...pgEnv,PGDATABASE:old}})
  const upgraded=await fresh('upgrade');execFileSync(pgTool('pg_restore'),['--no-owner','--no-privileges','--dbname',upgraded,oldDump],{env:pgEnv})
  run('whole-upgrade-migrate',[process.execPath,tsx,'scripts/migrate.ts','--database',upgraded],env(upgraded))
  const endpointConnection=postgres(env(upgraded).DATABASE_URL,{max:1})
  const endpoint=await endpointConnection`SELECT filename,checksum FROM _migration ORDER BY filename`;await endpointConnection.end()
  if(!equal(before,await snapshot(upgraded,financial,legacyColumns)))throw Error('P3 upgrade changed pre-existing financial fields')
  run('whole-upgrade-features',[process.execPath,'--conditions=react-server','--import','tsx','scripts/p3-restore.ts','--features',upgraded,fixture],env(upgraded))
  const all=await snapshot(upgraded),fin=await snapshot(upgraded,financial),dump=join(scratch,'p3.dump');execFileSync(pgTool('pg_dump'),['--format=custom','--file',dump],{env:{...pgEnv,PGDATABASE:upgraded}})
  const restored=await fresh('restored');execFileSync(pgTool('pg_restore'),['--no-owner','--no-privileges','--dbname',restored,dump],{env:pgEnv});cpSync(paper,restoredPaper,{recursive:true})
  if(!equal(all,await snapshot(restored)))throw Error('Whole-database roundtrip changed a full table field set')
  let blobs=0;const compare=(dir:string)=>{for(const e of readdirSync(join(paper,dir),{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())compare(path);else if(e.isFile()){if(!readFileSync(join(paper,path)).equals(readFileSync(join(restoredPaper,path))))throw Error('Private original bytes differ');blobs++}}};compare('');if(!blobs)throw Error('No source bytes tested')
  run('whole-restored-pause',[process.execPath,'--conditions=react-server','--import','tsx','scripts/invalidate-restored-auth.ts','--database',restored,'--reason','P3 isolated prior-schema-to-current full-row recovery'],env(restored,restoredPaper))
  if(!equal(fin,await snapshot(restored,financial)))throw Error('Restore pause changed financial fields')
  const c=postgres(env(restored).DATABASE_URL,{max:1});const [state]=await c`SELECT (SELECT count(*) FROM user_session WHERE revoked_at IS NULL)::int AS sessions,(SELECT count(*) FROM document_edit_lease)::int AS leases,(SELECT count(*) FROM migration_run WHERE status='restored_paused' AND actor_user_id IS NULL)::int AS paused`;await c.end()
  if(state.sessions||state.leases||state.paused!==1)throw Error('Restore authority was not invalidated')
  run('whole-restored-resume',[process.execPath,'--conditions=react-server','--import','tsx','scripts/p3-restore.ts','--resume',restored,fixture],env(restored,restoredPaper))
  // Table names such as auth_recovery_code must not masquerade as credential
  // assignments in the public receipt. These are full-row digests, not secrets.
  report.result={from:124,to:endpoint.length,migrations:endpoint,createdDatabases:created,preExistingFinancialColumns:legacyColumns,preExistingFinancialTableHashes:before,wholeRoundtripRowsDigest:sha(JSON.stringify(all)),wholeRoundtripTables:Object.keys(all),fullTablesCompared:Object.keys(all).length,privateFilesCompared:blobs,restoredAuthority:state,resumedOnlyRemainingCheckpoints:2,dumpSha256:sha(readFileSync(dump)),privateDumpsRemoved:true,newDatabasesDropped:true}
  console.log('PASS P3RS01 real schema 124 upgrade preserves all fields of '+financial.length+' financial tables\nPASS P3RS02 whole dump/restore preserves every full public table and private source bytes\nPASS P3RS03 restore revokes authority and requires fresh approval before exactly two remaining checkpoints reconcile\n=== ALL CHECKS PASSED ===')
  writeFileSync(join(evidence,'whole-restore.json'),JSON.stringify(report,null,2)+'\n')
 }finally{for(const name of created.reverse())await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P3 recovery failed');process.exitCode=1})

import './env'
import {randomUUID,createHash} from 'node:crypto'
import {spawnSync,execFileSync} from 'node:child_process'
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,mkdirSync,copyFileSync,cpSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import postgres from 'postgres'
import {pgTool} from '../src/lib/backup-paths'
import {seedLegacyFinancialFixture,legacyFinancialColumns} from './legacy-upgrade-fixture'

const root=process.cwd(),evidence=join(root,'docs/evidence/p5'),args=process.argv.slice(2)
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
const financial=['entity','ledger','account','account_role','party','party_role','fiscal_year','fiscal_period','journal_entry','journal_line','period_balance','invoice','invoice_line','invoice_application','bank_transaction','bank_match','bank_statement']
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
async function child(mode:string,name:string,fixture:string){
  if(new URL(process.env.DATABASE_URL!).pathname.slice(1)!==name||process.env.TEST_DATABASE_CONFIRMATION!==name||!/^figtree_p5_restore_[a-z0-9_]+_test$/.test(name))throw Error('Unconfirmed new restore database')
  const {sql:connection}=await import('../src/db/client')
  try{
    const {createFirstOwner,signIn}=await import('../src/lib/users')
    if(mode==='--seed'){
      const {createCompany,createFiscalYear}=await import('../src/lib/setup')
      const email='p5-restore@example.test',password='Disposable private P5 restore phrase',owner=await createFirstOwner({email,password,firstName:'P5 restore'}),co=await createCompany({code:'P5OLD',name:'P5 prior-schema fixture'},owner.email)
      await createFiscalYear(co.ledger.id,'2026-12-31',email)
      await seedLegacyFinancialFixture(connection,{entityId:co.company.id,ledgerId:co.ledger.id,actor:email,date:'2026-10-01',description:'Original pre-P5 123.45'})
      writeFileSync(fixture,JSON.stringify({email,password}),{mode:0o600})
    }else{
      const f=JSON.parse(readFileSync(fixture,'utf8')),session=await signIn({email:f.email,password:f.password,clientIp:'192.0.2.97'}),{buildP5Lifecycle}=await import('./p5-lifecycle')
      if('challenge' in session)throw Error('Unexpected isolated MFA challenge')
      await buildP5Lifecycle(f.email,session.token,'P5RS')
    }
  }finally{await connection.end()}
}
async function main(){
  if(args.length){await child(args[0],args[1],args[2]);return}
  const proof=JSON.parse(readFileSync(join(evidence,'isolation.json'),'utf8')),target=new URL(process.env.TEST_DATABASE_URL!),confirmed=target.pathname.slice(1)
  if(!proof.createdNew||proof.productionTouched||confirmed!==proof.testDatabase||process.env.TEST_DATABASE_CONFIRMATION!==confirmed)throw Error('P5 isolation not confirmed')
  const scratch=mkdtempSync(join(tmpdir(),'figtree-p5-restore-')),paper=join(scratch,'paper'),projects=join(scratch,'projects'),fixture=join(scratch,'fixture.json'),adminUrl=new URL(target);adminUrl.pathname='/postgres'
  mkdirSync(paper);mkdirSync(projects)
  const admin=postgres(adminUrl.href,{max:1}),created:string[]=[],checks:Record<string,unknown>[]=[],tsx=join(root,'node_modules/tsx/dist/cli.mjs')
  const pgEnv={...process.env,PGHOST:target.hostname,PGPORT:target.port||'5432',PGUSER:decodeURIComponent(target.username)||process.env.USER,PGPASSWORD:decodeURIComponent(target.password)}
  const env=(name:string,files=paper,projectFiles=projects)=>{const u=new URL(target);u.pathname='/'+name;return {...process.env,DATABASE_URL:u.href,TEST_DATABASE_URL:u.href,TEST_DATABASE_CONFIRMATION:name,ATTACHMENTS_DIR:files,TEST_ATTACHMENTS_DIR:files,PROJECT_ATTACHMENTS_DIR:projectFiles,TEST_PROJECT_ATTACHMENTS_DIR:projectFiles,AUTOMATION_ENABLED:'false',ONLINE_PAYMENTS_ENABLED:'false',INBOUND_MAIL_ENABLED:'false',NODE_OPTIONS:'--conditions=react-server'}}
  const fresh=async(label:string)=>{const name='figtree_p5_restore_'+label+'_'+randomUUID().replaceAll('-','').slice(0,12)+'_test';await admin.unsafe(`CREATE DATABASE "${name}"`);created.push(name);const c=postgres(env(name).DATABASE_URL,{max:1});const [count]=await c`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'`;await c.end();if(count.n!==0)throw Error('New database was not empty');return name}
  const run=(label:string,command:string[],environment:NodeJS.ProcessEnv,cwd=root)=>{const r=spawnSync(command[0],command.slice(1),{env:environment,cwd,encoding:'utf8',maxBuffer:16e6});writeFileSync(join(evidence,label+'.log'),r.stdout+r.stderr);if(r.status!==0)throw Error(label+' failed; inspect actual log')}
  const snapshot=async(name:string,tables?:string[],columns?:Record<string,string[]>)=>{const c=postgres(env(name).DATABASE_URL,{max:1});try{const names=tables??(await c`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`).map(r=>String(r.tablename)),hashes:Record<string,string>={};for(const table of names){if(!/^[a-z_][a-z0-9_]*$/.test(table))throw Error('Unsafe table');const [row]=await c.unsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS data FROM (SELECT ${columns?columns[table].map(column=>{if(!/^[a-z_][a-z0-9_]*$/.test(column))throw Error('Unsafe column');return '"'+column+'"'}).join(','):'*'} FROM "${table}") t`);hashes[table]=sha(row.data)}return hashes}finally{await c.end()}}
  const fileHashes=(dir:string)=>{const hashes:Record<string,string>={};const walk=(rel:string)=>{for(const e of readdirSync(join(dir,rel),{withFileTypes:true})){const path=join(rel,e.name);if(e.isSymbolicLink())throw Error('Unexpected private storage symlink');if(e.isDirectory())walk(path);else if(e.isFile())hashes[path]=sha(readFileSync(join(dir,path)))}};if(existsSync(dir))walk('');return hashes}
  const roundtrip=async(label:string,source:string,files:string,projectFiles:string,requireActive:boolean)=>{
    const all=await snapshot(source),fin=await snapshot(source,financial),dump=join(scratch,label+'.dump'),restored=await fresh(label),restoredFiles=join(scratch,label+'-paper'),restoredProjects=join(scratch,label+'-projects')
    const before=postgres(env(source).DATABASE_URL,{max:1});const [authority]=await before`SELECT (SELECT count(*) FROM portal_session WHERE revoked_at IS NULL)::int AS portals,(SELECT count(*) FROM payment_connection WHERE enabled)::int AS payments,(SELECT count(*) FROM inbound_connection WHERE enabled)::int AS inbound`;await before.end()
    if(requireActive&&(!authority.portals||!authority.payments||!authority.inbound))throw Error('Active capability recovery case not populated')
    execFileSync(pgTool('pg_dump'),['--format=custom','--file',dump],{env:{...pgEnv,PGDATABASE:source}})
    execFileSync(pgTool('pg_restore'),['--no-owner','--no-privileges','--dbname',restored,dump],{env:pgEnv})
    cpSync(files,restoredFiles,{recursive:true});cpSync(projectFiles,restoredProjects,{recursive:true})
    const originalBlobs=fileHashes(files),originalProjects=fileHashes(projectFiles)
    if(!equal(all,await snapshot(restored))||!equal(originalBlobs,fileHashes(restoredFiles))||!equal(originalProjects,fileHashes(restoredProjects)))throw Error('Full-row or private-byte roundtrip mismatch')
    if(!Object.keys(originalBlobs).length)throw Error('No private bytes tested')
    run('whole-'+label+'-pause',[process.execPath,'--conditions=react-server','--import','tsx','scripts/invalidate-restored-auth.ts','--database',restored,'--reason','P5 isolated full-row restore acceptance'],env(restored,restoredFiles,restoredProjects))
    if(!equal(fin,await snapshot(restored,financial)))throw Error('Restore boundary changed financial fields')
    const c=postgres(env(restored).DATABASE_URL,{max:1});const [state]=await c`SELECT (SELECT count(*) FROM user_session WHERE revoked_at IS NULL)::int AS sessions,(SELECT count(*) FROM portal_session WHERE revoked_at IS NULL)::int AS portals,(SELECT count(*) FROM portal_invitation WHERE revoked_at IS NULL)::int AS invitations,(SELECT count(*) FROM document_edit_lease)::int AS leases,(SELECT count(*) FROM payment_connection WHERE enabled OR binding_attached OR verified_at IS NOT NULL)::int AS payments,(SELECT count(*) FROM inbound_connection WHERE enabled OR binding_attached)::int AS inbound,(SELECT count(*) FROM background_job WHERE status IN ('queued','running','retry'))::int AS jobs`;await c.end()
    if(Object.values(state).some(n=>n!==0))throw Error('Restored executable authority was not disabled')
    checks.push({label,source,restored,fullTablesCompared:Object.keys(all).length,fullRowsDigest:sha(JSON.stringify(all)),financialTablesCompared:financial.length,financialRowsDigest:sha(JSON.stringify(fin)),privateFilesCompared:Object.keys(originalBlobs).length,projectFilesCompared:Object.keys(originalProjects).length,privateBytesDigest:sha(JSON.stringify(originalBlobs)),authorityBefore:authority,authorityAfter:state,dumpSha256:sha(readFileSync(dump))})
    console.log('PASS P5RS '+label+' every public table and private file roundtrips; executable authority disabled; financial fields unchanged')
  }
  let completed=false
  let endpoint: {filename:string;checksum:string}[]=[]
  try{
    const old=await fresh('old130'),oldDir=join(scratch,'old');mkdirSync(join(oldDir,'db/migrations'),{recursive:true})
    for(const file of readdirSync(join(root,'db/migrations')).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<=130))copyFileSync(join(root,'db/migrations',file),join(oldDir,'db/migrations',file))
    run('whole-old130-migrate',[process.execPath,tsx,join(root,'scripts/migrate.ts'),'--database',old],env(old),oldDir)
    run('whole-old130-seed',[process.execPath,'--conditions=react-server','--import','tsx','scripts/p5-restore.ts','--seed',old,fixture],env(old))
    const legacyConnection=postgres(env(old).DATABASE_URL,{max:1})
    const legacyColumns=await legacyFinancialColumns(legacyConnection,financial);await legacyConnection.end()
    const before=await snapshot(old,financial,legacyColumns)
    run('whole-upgrade-current-migrate',[process.execPath,tsx,'scripts/migrate.ts','--database',old],env(old))
    const endpointConnection=postgres(env(old).DATABASE_URL,{max:1})
    endpoint=await endpointConnection`SELECT filename,checksum FROM _migration ORDER BY filename`;await endpointConnection.end()
    if(!equal(before,await snapshot(old,financial,legacyColumns)))throw Error('Upgrade changed existing financial fields')
    console.log('PASS P5RS01 real schema 130-to-current upgrade preserves all fields of existing financial tables')
    run('whole-upgrade-current-features',[process.execPath,'--conditions=react-server','--import','tsx','scripts/p5-restore.ts','--features',old,fixture],env(old))
    await roundtrip('active',old,paper,projects,true)
    await roundtrip('financial',confirmed,proof.testAttachments,proof.testProjectAttachments,false)
    completed=true
  }finally{
    for(const name of created.slice().reverse())await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.end();rmSync(scratch,{recursive:true,force:true})
    writeFileSync(join(evidence,'whole-restore.json'),JSON.stringify({at:new Date().toISOString(),completed,productionTouched:false,createdDatabases:created,newDatabasesDropped:true,privateDumpsRemoved:true,from:130,to:endpoint.length,migrations:endpoint,checks},null,2)+'\n')
  }
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P5 recovery failed');process.exitCode=1})

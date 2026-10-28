import './env'
import { randomUUID,createHash } from 'node:crypto'
import { execFileSync,spawnSync } from 'node:child_process'
import { mkdtempSync,readFileSync,writeFileSync,readdirSync,mkdirSync,copyFileSync,cpSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { pgTool } from '../src/lib/backup-paths'
import { seedLegacyFinancialFixture } from './legacy-upgrade-fixture'

async function child(mode:string,name:string,fixture:string) {
  const allowed=['--seed-120','--upgrade-fixture','--prepare-current']
  const test=new URL(process.env.TEST_DATABASE_URL!),app=new URL(process.env.APP_DATABASE_URL!)
  const namePattern=mode==='--prepare-current'?/^[a-z][a-z0-9_]*_test$/:/^figtree_p2_[a-z0-9_]+_test$/
  if(!allowed.includes(mode)||name!==test.pathname.slice(1)||process.env.TEST_DATABASE_CONFIRMATION!==name||!namePattern.test(name)||(app.host===test.host&&app.pathname===test.pathname))throw Error('Unconfirmed upgrade clone')
  const {db,sql:connection}=await import('../src/db/client'),{sql}=await import('drizzle-orm')
  try {
    if(mode==='--seed-120') {
      const {createFirstOwner}=await import('../src/lib/users'),{createCompany,createFiscalYear}=await import('../src/lib/setup')
      const owner=await createFirstOwner({email:'upgrade@example.test',firstName:'Upgrade',password:'Isolated upgrade owner long password'})
      const company=await createCompany({code:'UPGRADE',name:'P2 upgrade fixture'},owner.email);await createFiscalYear(company.ledger.id,'2026-09-30',owner.email)
      const legacy=await seedLegacyFinancialFixture(connection,{entityId:company.company.id,ledgerId:company.ledger.id,actor:owner.email,date:'2026-08-01',description:'Fixed pre-P2 123.45',draft:true})
      writeFileSync(fixture,JSON.stringify({ledgerId:company.ledger.id,entityId:company.company.id,sourceId:legacy.draftId,email:owner.email,password:'Isolated upgrade owner long password'}),{mode:0o600})
    } else {
      const f=JSON.parse(readFileSync(fixture,'utf8')),{signIn}=await import('../src/lib/users'),{requestActor,configureAutomation}=await import('../src/lib/automation-access'),{saveRecurring,generateOccurrence,queueRecurring}=await import('../src/lib/recurring'),{editLease}=await import('../src/lib/edit-leases')
      const session=await signIn({email:f.email,password:f.password,clientIp:'192.0.2.56'}),actor=requestActor(session.token)
      process.env.AUTOMATION_ENABLED='true'
      const [setting]=await db.execute<{version:string}>(sql`SELECT version::text FROM automation_setting WHERE entity_id=${f.entityId}::uuid`)
      await configureAutomation(f.ledgerId,actor,{version:setting?.version??'0',enabled:true,mailEnabled:true,timezone:'America/Vancouver',senderEmail:'accounts@example.test'})
      const template=await saveRecurring(f.ledgerId,actor,{sourceId:f.sourceId??f.journalId,documentType:'entry',title:'Restorable recurring draft',rule:{frequency:'monthly',dayMode:'month_end',anchorDate:'2026-08-01',dayOfMonth:31},dueDays:0,active:true})
      if(mode==='--upgrade-fixture') {
        const resource={ledgerId:f.ledgerId,type:'recurring' as const,id:template.id},tabId=randomUUID(),lease=await editLease(resource,session.token,'takeover',{version:'1',tabId})
        const result=await generateOccurrence(f.ledgerId,template.id,'2026-08-31',actor,{sessionToken:session.token,proof:{version:'1',tabId,...lease},leaseRequired:true})
        const [draft]=await db.execute<{status:string;date:string}>(sql`SELECT status,entry_date::text AS date FROM journal_entry WHERE id=${result.entryId}::uuid`)
        const [fy]=await db.execute<{end:string}>(sql`SELECT end_date::text AS end FROM fiscal_year WHERE ledger_id=${f.ledgerId}::uuid`)
        if(draft.status!=='draft'||draft.date!=='2026-08-31'||fy.end!=='2026-09-30')throw Error('Upgraded non-December year lost scheduled draft date')
      } else {
        const {createMailPreview,queueMail,saveReminder}=await import('../src/lib/mail'),{workerHeartbeat,claimJob}=await import('../src/lib/jobs')
        for(const status of ['running','queued']) {
          const preview=await createMailPreview(f.ledgerId,actor,{kind:'invoice',partyId:f.customerId,invoiceId:f.invoiceId,asOf:'2026-10-08',to:'customer@example.test',cc:[],subject:status+' restore fixture',body:'Explicit isolated restore fixture.',requestKey:randomUUID()})
          await queueMail(f.ledgerId,preview.id,actor)
          if(status==='running'){const worker=randomUUID();await workerHeartbeat(worker);const job=await claimJob(worker);if(job?.email_message_id!==preview.id)throw Error('Restore fixture did not claim its send');await db.execute(sql`UPDATE email_message SET status='sending' WHERE id=${preview.id}::uuid`)}
        }
        const resource={ledgerId:f.ledgerId,type:'reminder' as const,id:f.reminderId},[rule]=await db.execute<{version:string}>(sql`SELECT version::text FROM reminder_rule WHERE id=${f.reminderId}::uuid`),tabId=randomUUID(),lease=await editLease(resource,session.token,'takeover',{version:rule.version,tabId})
        await saveReminder(f.ledgerId,actor,{id:f.reminderId,partyId:f.customerId,enabled:true,paused:false,reason:'',days:[3,7,14],startHour:0,endHour:24},{sessionToken:session.token,proof:{version:rule.version,tabId,...lease},leaseRequired:true})
        await queueRecurring()
      }
    }
  }finally{await connection.end()}
}
async function main() {
  const args=process.argv.slice(2)
  if(args.length){await child(args[0],args[1],args[2]);return}
  const source=new URL(process.env.TEST_DATABASE_URL!),sourceName=source.pathname.slice(1)
  if(process.env.TEST_DATABASE_CONFIRMATION!==sourceName)throw Error('Unconfirmed restore source')
  const root=process.cwd(),scratch=mkdtempSync(join(tmpdir(),'figtree-p2-restore-')),evidence=join(root,'docs/evidence/p2'),fixture=join(scratch,'fixture.json'),adminUrl=new URL(source);adminUrl.pathname='/postgres'
  const admin=postgres(adminUrl.href,{max:1}),created:string[]=[],report:Record<string,unknown>={at:new Date().toISOString(),source:sourceName}
  const pgEnv={...process.env,PGHOST:source.hostname,PGPORT:source.port||'5432',PGUSER:decodeURIComponent(source.username)||process.env.USER,PGPASSWORD:decodeURIComponent(source.password)}
  const cloneEnv=(name:string)=>{const url=new URL(source);url.pathname='/'+name;return {...process.env,DATABASE_URL:url.href,TEST_DATABASE_URL:url.href,TEST_DATABASE_CONFIRMATION:name,NODE_OPTIONS:'--conditions=react-server'}}
  const fresh=async(label:string)=>{const name='figtree_p2_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20)+'_test';if(name.length>63)throw Error('Fixture name exceeds PostgreSQL identifier limit');await admin.unsafe(`CREATE DATABASE "${name}"`);created.push(name);return name}
  const run=(label:string,cmd:string[],env:NodeJS.ProcessEnv,cwd=root)=>{const result=spawnSync(cmd[0],cmd.slice(1),{env,cwd,encoding:'utf8',maxBuffer:16e6});writeFileSync(join(evidence,label+'.log'),result.stdout+result.stderr);if(result.status!==0)throw Error(label+' failed; inspect its actual log')}
  const dump=(name:string,file:string)=>execFileSync(pgTool('pg_dump'),['--format=custom','--file',file],{env:{...pgEnv,PGDATABASE:name},stdio:'pipe'})
  const restore=(name:string,file:string)=>execFileSync(pgTool('pg_restore'),['--no-owner','--no-privileges','--dbname',name,file],{env:pgEnv,stdio:'pipe'})
  const head=async(name:string)=>{const c=postgres(cloneEnv(name).DATABASE_URL,{max:1});try{return await c`SELECT entry_no,entry_date::text,description,status,total_debit::text,total_credit::text FROM journal_entry WHERE status IN ('posted','reversed') ORDER BY id`}finally{await c.end()}}
  try {
    // A real 120 snapshot, not a fake _migration marker on a new schema.
    const old=await fresh('old120'),oldDir=join(scratch,'old');mkdirSync(join(oldDir,'db/migrations'),{recursive:true})
    for(const file of readdirSync(join(root,'db/migrations')).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,4))<=120))copyFileSync(join(root,'db/migrations',file),join(oldDir,'db/migrations',file))
    run('restore-old120-migrate',[process.execPath,join(root,'node_modules/tsx/dist/cli.mjs'),join(root,'scripts/migrate.ts'),'--database',old],cloneEnv(old),oldDir)
    run('restore-old120-seed',[process.execPath,'--conditions=react-server','--import','tsx','scripts/verify-p2-restore.ts','--seed-120',old,fixture],cloneEnv(old))
    const original=await head(old),oldDump=join(scratch,'120.dump');dump(old,oldDump)
    const upgraded=await fresh('upgrade'),newDump=join(scratch,'p2.dump');restore(upgraded,oldDump)
    run('restore-upgrade-migrate',['npx','tsx','scripts/migrate.ts','--database',upgraded],cloneEnv(upgraded))
    const checked=postgres(cloneEnv(upgraded).DATABASE_URL,{max:1})
    const [{version:upgradedVersion}]=await checked`SELECT max(left(filename,4)::int)::int AS version FROM _migration`;await checked.end()
    const expectedVersion=Math.max(...readdirSync(join(root,'db/migrations')).filter(f=>/^\d{4}_.*\.sql$/.test(f)).map(f=>Number(f.slice(0,4))))
    if(upgradedVersion!==expectedVersion)throw Error('Upgrade migration version is incomplete')
    run('restore-upgrade-feature',[process.execPath,'--conditions=react-server','--import','tsx','scripts/verify-p2-restore.ts','--upgrade-fixture',upgraded,fixture],cloneEnv(upgraded))
    if(JSON.stringify(original)!==JSON.stringify(await head(upgraded)))throw Error('P2 migration or draft generation changed pre-existing accounting')
    dump(upgraded,newDump);const final=await fresh('upgrade_restored');restore(final,newDump)
    run('restore-upgrade-pause',[process.execPath,'--conditions=react-server','--import','tsx','scripts/invalidate-restored-auth.ts','--database',final,'--reason',`P2 120-to-${upgradedVersion} isolated recovery`],cloneEnv(final))
    if(JSON.stringify(original)!==JSON.stringify(await head(final)))throw Error('Restored upgraded accounting differs')
    report.upgrade={from:120,to:upgradedVersion,oldDatabase:old,upgradedDatabase:upgraded,restoredDatabase:final,oldDumpSha256:createHash('sha256').update(readFileSync(oldDump)).digest('hex'),fixedPreExistingDebit:'12345',scheduledDraftDate:'2026-08-31',nonDecemberFiscalYearEnd:'2026-09-30',postedRowsUnchanged:true}
    console.log(`PASS P2RS01 real schema 120 dump -> ${upgradedVersion} migration -> recurring draft -> dump/restore, unchanged posted rows and September year end`)
    // Rich current snapshot: accepted/unknown history plus queued/in-flight work.
    run('restore-current-seed',['npm','run','db:verify-p2'],{...process.env,P2_BROWSER_FIXTURE:fixture})
    const f=JSON.parse(readFileSync(fixture,'utf8')),paper=join(scratch,'restored-paper');cpSync(f.attachmentsRoot,paper,{recursive:true})
    run('restore-current-prepare',[process.execPath,'--conditions=react-server','--import','tsx','scripts/verify-p2-restore.ts','--prepare-current',sourceName,fixture],{...process.env,ATTACHMENTS_DIR:f.attachmentsRoot})
    const currentDump=join(scratch,'current.dump'),restored=await fresh('current_restored');dump(sourceName,currentDump);restore(restored,currentDump)
    const c=postgres(cloneEnv(restored).DATABASE_URL,{max:1})
    try {
      const before=await c`SELECT status,count(*)::int AS n FROM email_message GROUP BY status ORDER BY status`
      if(!before.some(r=>r.status==='accepted')||!before.some(r=>r.status==='delivery_unknown')||!before.some(r=>r.status==='queued')||!before.some(r=>r.status==='sending'))throw Error('Restore fixture lacks required actual history or prepared in-flight state')
      const accounting=await head(restored)
      run('restore-current-pause',[process.execPath,'--conditions=react-server','--import','tsx','scripts/invalidate-restored-auth.ts','--database',restored,'--reason','P2 isolated active-queue snapshot recovery'],{...cloneEnv(restored),ATTACHMENTS_DIR:paper})
      const [after]=await c`SELECT (SELECT count(*) FROM automation_setting WHERE enabled OR mail_enabled)::int AS enabled,
        (SELECT count(*) FROM recurring_template WHERE active)::int AS templates,(SELECT count(*) FROM reminder_rule WHERE enabled OR NOT paused)::int AS rules,
        (SELECT count(*) FROM background_job WHERE status IN ('queued','running'))::int AS executable,(SELECT count(*) FROM email_message WHERE status IN ('queued','sending','preview'))::int AS mail,
        (SELECT count(*) FROM automation_worker)::int AS workers,(SELECT count(*) FROM user_session WHERE revoked_at IS NULL)::int AS sessions`
      if(Object.values(after).some(Boolean)||JSON.stringify(accounting)!==JSON.stringify(await head(restored)))throw Error('Restored side effects were executable or accounting changed')
      const finalMail=await c`SELECT status,count(*)::int AS n FROM email_message GROUP BY status ORDER BY status`
      if(finalMail.find(r=>r.status==='accepted')?.n!==before.find(r=>r.status==='accepted')?.n||finalMail.find(r=>r.status==='delivery_unknown')?.n!==before.find(r=>r.status==='delivery_unknown')!.n+1)throw Error('Accepted or interrupted send history was not preserved')
      let blobs=0
      const compareFiles=(relative:string)=>{for(const entry of readdirSync(join(paper,relative),{withFileTypes:true})){
        const file=join(relative,entry.name)
        if(entry.isDirectory())compareFiles(file)
        else if(entry.isFile()){if(!readFileSync(join(paper,file)).equals(readFileSync(join(f.attachmentsRoot,file))))throw Error('Restored private paper bytes differ');blobs++}
      }}
      compareFiles('')
      if(!blobs)throw Error('No private source or mail blobs were restored')
      report.current={restoredDatabase:restored,before,after,finalMail,privateFilesCopiedAndCompared:blobs,inFlightMailFixtureExplicitlyMarkedSending:true,accountingRowsUnchanged:true}
      console.log('PASS P2RS02 real active-queue dump/restore pauses all work and preserves accepted/unknown history\nPASS P2RS03 copied private original/mail bytes match; restored financial rows unchanged\n=== ALL CHECKS PASSED ===')
    }finally{await c.end()}
    writeFileSync(join(evidence,'restore.json'),JSON.stringify(report,null,2)+'\n')
  }finally{for(const name of created.reverse())await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(scratch,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'P2 snapshot restore failed');process.exitCode=1})

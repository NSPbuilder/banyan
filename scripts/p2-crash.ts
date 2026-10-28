/** Real SMTP acceptance followed by SIGKILL before the local commit. */
import './env'
import { randomUUID } from 'node:crypto'
import { spawn,spawnSync,type ChildProcess } from 'node:child_process'
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SMTPServer } from 'smtp-server'
import { sql } from 'drizzle-orm'
import { db,sql as connection } from '../src/db/client'
import { signIn } from '../src/lib/users'
import { configureAutomation,requestActor } from '../src/lib/automation-access'
import { createMailPreview,queueMail } from '../src/lib/mail'
import { claimJob,workerHeartbeat } from '../src/lib/jobs'

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function main() {
  const source=process.env.TEST_DATABASE_URL!,name=new URL(source).pathname.slice(1)
  if(process.env.TEST_DATABASE_CONFIRMATION!==name)throw Error('Unconfirmed crash database')
  const scratch=mkdtempSync(join(tmpdir(),'figtree-p2-crash-')),fixture=join(scratch,'fixture.json'),evidence='docs/evidence/p2'
  const seed=spawnSync('npm',['run','db:verify-p2'],{env:{...process.env,P2_BROWSER_FIXTURE:fixture},encoding:'utf8',maxBuffer:16e6})
  writeFileSync(join(evidence,'crash-seed.log'),seed.stdout+seed.stderr)
  if(seed.status!==0)throw Error('Crash fixture seed failed')
  const f=JSON.parse(readFileSync(fixture,'utf8'));process.env.ATTACHMENTS_DIR=f.attachmentsRoot;process.env.AUTOMATION_ENABLED='true'
  const session=await signIn({email:f.email,password:f.password,clientIp:'192.0.2.55'}),actor=requestActor(session.token)
  const [setting]=await db.execute<{version:string}>(sql`SELECT version::text FROM automation_setting WHERE entity_id=${f.entityId}::uuid`)
  await configureAutomation(f.ledgerId,actor,{version:setting.version,enabled:true,mailEnabled:true,timezone:'America/Vancouver',senderEmail:'accounts@example.test'})
  const preview=await createMailPreview(f.ledgerId,actor,{kind:'invoice',partyId:f.customerId,invoiceId:f.invoiceId,asOf:'2026-10-08',to:'customer@example.test',cc:[],subject:'Crash window actual SMTP',body:'Isolated crash validation.',requestKey:randomUUID()})
  const queued=await queueMail(f.ledgerId,preview.id,actor)
  let child:ChildProcess|undefined,captured:Buffer|undefined,captureCount=0,held=false,release!:()=>void,handlerError:unknown
  const hold=new Promise<void>(resolve=>{release=resolve}),appName='figtree_p2_crash_'+randomUUID().replaceAll('-','')
  const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],logger:false,onData(stream,_session,done){
    const chunks:Buffer[]=[];stream.on('data',b=>chunks.push(Buffer.from(b)))
    stream.on('end',()=>{captureCount++;captured=Buffer.concat(chunks);void connection.begin(async tx=>{
      await tx`SELECT id FROM background_job WHERE id=${queued.jobId} FOR UPDATE`
      held=true;done();await hold
    }).catch(error=>{handlerError=error;release()})})
  }})
  try {
    await new Promise<void>((resolve,reject)=>{smtp.once('error',reject);smtp.listen(0,'127.0.0.1',resolve)})
    const port=(smtp as unknown as {server:{address:()=>{port:number}}}).server.address().port,url=new URL(source);url.searchParams.set('application_name',appName)
    const env={...process.env,DATABASE_URL:url.href,NODE_OPTIONS:'--conditions=react-server',SMTP_HOST:'127.0.0.1',SMTP_PORT:String(port),SMTP_LOCAL_CAPTURE:'true',SMTP_TIMEOUT_MS:'10000'}
    child=spawn(process.execPath,['--conditions=react-server','--import','tsx','scripts/automation-worker.ts','--database',name,'--max','1'],{env,stdio:['ignore','pipe','pipe']})
    let log='';child.stdout!.on('data',b=>log+=String(b));child.stderr!.on('data',b=>log+=String(b))
    let lockObserved=false
    for(let n=0;n<300;n++){
      if(handlerError)throw handlerError
      const [wait]=await connection`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${appName} AND wait_event_type='Lock'`
      if(held&&captured&&wait.n>0){lockObserved=true;break}
      if(child.exitCode!==null)throw Error('Worker exited before SMTP/local commit window')
      await pause(50)
    }
    if(!lockObserved)throw Error('Actual post-SMTP PostgreSQL lock wait was not observed')
    const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child!.once('close',(code,signal)=>resolve({code,signal})))
    child.kill('SIGKILL');const death=await closed;release();await pause(100)
    if(death.signal!=='SIGKILL')throw Error('Actual worker process was not killed')
    const [before]=await connection`SELECT j.status AS job,m.status AS mail,j.generation FROM background_job j JOIN email_message m ON m.id=j.email_message_id WHERE j.id=${queued.jobId}`
    if(before.job!=='running'||before.mail!=='sending')throw Error('Crash window did not retain unfinished local state')
    // Advance only the confirmed fixture lease, rather than wait two minutes.
    await connection`UPDATE background_job SET locked_until=clock_timestamp()-interval '1 second' WHERE id=${queued.jobId}`
    const worker=randomUUID();await workerHeartbeat(worker);await claimJob(worker)
    const [after]=await connection`SELECT j.status AS job,m.status AS mail,j.generation FROM background_job j JOIN email_message m ON m.id=j.email_message_id WHERE j.id=${queued.jobId}`
    if(after.job!=='delivery_unknown'||after.mail!=='delivery_unknown'||BigInt(after.generation)<=BigInt(before.generation))throw Error('Crashed accepted SMTP work was not fenced unknown')
    const next=await claimJob(worker);await pause(100)
    if(next?.email_message_id===preview.id||captureCount!==1)throw Error('Interrupted SMTP authorization was retried')
    writeFileSync(join(evidence,'smtp-crash.eml'),captured!)
    writeFileSync(join(evidence,'crash-worker.log'),log)
    writeFileSync(join(evidence,'crash.json'),JSON.stringify({at:new Date().toISOString(),database:name,actualSigkill:death.signal,actualSmtpDataCaptured:!!captured,actualCaptureCount:captureCount,postAcceptanceDatabaseLockObserved:lockObserved,fixtureLeaseExplicitlyExpired:true,before,after},(_key,value)=>typeof value==='bigint'?value.toString():value,2)+'\n')
    console.log('PASS P2CR01 real worker SIGKILL after local SMTP acceptance, before database completion\nPASS P2CR02 expired interrupted send becomes unknown and cannot be reclaimed\n=== ALL CHECKS PASSED ===')
  }finally{release();if(child&&child.exitCode===null)child.kill('SIGKILL');await new Promise<void>(resolve=>smtp.close(()=>resolve()))}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Crash verification failed');process.exitCode=1}).finally(()=>connection.end())

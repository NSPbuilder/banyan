/** Actual dump/restore and 135 -> P6 cutover. Only freshly created, confirmed
 * empty P6 clone databases on the already verified isolation server. */
import {readFileSync,writeFileSync,mkdtempSync,readdirSync,statSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash,randomBytes} from 'node:crypto'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {parse} from 'dotenv'
import postgres from 'postgres'
import {pgTool} from '../src/lib/backup-paths'
import {reporter} from './suite'
const r=reporter(85)
async function main(){
  const proof=JSON.parse(readFileSync('docs/evidence/p6/isolation.json','utf8'))
  if(!proof.createdNew||proof.productionTouched||proof.initialPublicTables[proof.testDatabase]!==0||(statSync(proof.environmentPath).mode&0o777)!==0o600)throw Error('P6 isolation is unconfirmed')
  const cfg=parse(readFileSync(proof.environmentPath)),source=new URL(cfg.TEST_DATABASE_URL)
  if(source.pathname.slice(1)!==proof.testDatabase||cfg.TEST_DATABASE_CONFIRMATION!==proof.testDatabase)throw Error('Source identity mismatch')
  const suffix=randomBytes(4).toString('hex'),names=['legacy','whole','bad'].map(k=>`figtree_p6_${k}_${suffix}_test`)
  const adminUrl=new URL(source);adminUrl.pathname='/postgres';const admin=postgres(adminUrl.href,{max:1})
  const urls=names.map(name=>{if(!/^figtree_p6_(legacy|whole|bad)_[a-f0-9]{8}_test$/.test(name))throw Error('Unsafe clone');const u=new URL(source);u.pathname='/'+name;return u.href})
  const clients=urls.map(url=>postgres(url,{max:4,onnotice:()=>{}})),scratch=mkdtempSync(join(tmpdir(),'figtree-p6-restore-'))
  const initial:Record<string,number>={}
  try{
    for(let i=0;i<names.length;i++){
      await admin.unsafe(`CREATE DATABASE "${names[i]}"`)
      const [empty]=await clients[i]`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`
      if(empty.n!==0)throw Error('Clone is not empty');initial[names[i]]=empty.n
    }
    writeFileSync('docs/evidence/p6/restore-isolation.json',JSON.stringify({createdAt:new Date().toISOString(),productionTouched:false,createdNew:true,source:proof.testDatabase,clones:names,initialPublicTables:initial},null,2)+'\n')
    const legacy=clients[0],whole=clients[1],bad=clients[2],files=readdirSync('db/migrations').filter(f=>f.endsWith('.sql')).sort()
    await legacy`CREATE TABLE _migration(filename text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`
    async function apply(file:string){const body=readFileSync(join('db/migrations',file),'utf8'),checksum=createHash('sha256').update(body).digest('hex').slice(0,16);await legacy.begin(async tx=>{await tx.unsafe(body);await tx`INSERT INTO _migration(filename,checksum) VALUES(${file},${checksum})`})}
    for(const file of files.filter(f=>f<'0136'))await apply(file)
    const before=await legacy`INSERT INTO audit_log(actor,action,table_name,record_id,after,scope) VALUES('upgrade-fixture','legacy_sample','test','legacy','{"amount":"900719925474099301"}','system') RETURNING id::text`
    const cutover=legacy.begin(async tx=>{const file='0136_p6_audit_chains.sql',body=readFileSync(join('db/migrations',file),'utf8');await tx.unsafe(body);await tx`INSERT INTO _migration(filename,checksum) VALUES(${file},${createHash('sha256').update(body).digest('hex').slice(0,16)})`})
    // Concurrent event waits for ACCESS EXCLUSIVE cutover or enters its seal.
    const concurrent=legacy`INSERT INTO audit_log(actor,action,table_name,record_id,scope) VALUES('upgrade-fixture','during_cutover','test','concurrent','system')`
    await Promise.all([cutover,concurrent])
    for(const file of files.filter(f=>f>'0136_p6_audit_chains.sql'))await apply(file)
    const [{result}]=await legacy`SELECT audit_verify_v1() AS result`
    r.check(result.ok,'P6R01 actual legacy cutover and concurrent insertion leave no evidence gap')
    const [legacyRow]=await legacy`SELECT a.chain_id,s.row_count::text FROM audit_log a CROSS JOIN audit_legacy_seal s WHERE a.id=${before[0].id}`
    r.check(legacyRow.chain_id===null&&BigInt(legacyRow.row_count)>=1n,'P6R02 genuine pre-136 rows remain legacy covered by exact seal')
    await legacy.begin(async tx=>{
      await tx`SET LOCAL TIME ZONE 'Pacific/Auckland'`
      const [{result}]=await tx`SELECT audit_verify_v1() AS result`
      r.check(result.ok,'P6R03 original seal and event verification are independent of session timezone')
    })
    const [{heads}]=await legacy`SELECT jsonb_agg(jsonb_build_object('chainId',chain_id::text,'scope',scope_key,'entityId',entity_id::text,'ledgerId',ledger_id::text,'sequence',sequence::text,'hash',hash)) AS heads FROM audit_chain_head`
    const checkpoint={format:'FigTree.audit.checkpoint.v1',createdAt:new Date().toISOString(),heads},anchor=join(scratch,'independent-checkpoint.json')
    writeFileSync(anchor,JSON.stringify(checkpoint),{mode:0o600})
    const seeded=spawnSync('npx',['tsx','scripts/p6-whole-fixture.ts'],{env:{...process.env,...cfg,DATABASE_URL:urls[0],NODE_OPTIONS:'--conditions=react-server'},encoding:'utf8'})
    writeFileSync('docs/evidence/p6/restore-fixture.log',seeded.stdout+seeded.stderr)
    if(seeded.status!==0)throw Error('Actual business restore fixture failed; see restore-fixture.log')
    const [nonempty]=await legacy`SELECT (SELECT count(*) FROM user_session WHERE revoked_at IS NULL)::int AS sessions,(SELECT count(*) FROM auth_passkey WHERE revoked_at IS NULL)::int AS keys,(SELECT count(*) FROM auth_webauthn_challenge)::int AS challenges,(SELECT count(*) FROM document_edit_lease)::int AS leases,(SELECT count(*) FROM email_message WHERE status='queued')::int AS mail,(SELECT count(*) FROM background_job WHERE status='queued')::int AS jobs`
    r.check(Object.values(nonempty).every(n=>Number(n)>0),'P6R10 real source has nonempty active sessions/keys/challenges/leases and queued mail/jobs')
    const dump=join(scratch,'original.dump'),dumped=spawnSync(pgTool('pg_dump'),['-Fc','-f',dump,urls[0]],{encoding:'utf8'})
    if(dumped.status!==0)throw Error('Isolated dump failed: '+dumped.stderr)
    for(let i=1;i<clients.length;i++){
      const loaded=spawnSync(pgTool('pg_restore'),['--exit-on-error','--no-owner','--no-privileges','-d',urls[i],dump],{encoding:'utf8'})
      if(loaded.status!==0)throw Error('Isolated restore failed: '+loaded.stderr)
    }
    const [restored]=await whole`SELECT audit_verify_v1() AS result`
    r.check(restored.result.ok,'P6R04 actual full pg_dump/pg_restore verifies before any invalidation writes')
    const [matches]=await whole`SELECT count(*)::int AS n FROM audit_log WHERE chain_id=${heads[0].chainId}::uuid AND chain_seq=${heads[0].sequence}::bigint AND event_hash=${heads[0].hash}`
    r.check(matches.n===1,'P6R05 original chain IDs/scopes/sequence/hash preserved by whole restore')
    const verifyEnv={...process.env,...cfg,DATABASE_URL:urls[1],NODE_OPTIONS:'--conditions=react-server'}
    const checked=spawnSync('npx',['tsx','scripts/audit-verify.ts','--database',names[1],'--checkpoint',anchor,'--require-independent'],{env:verifyEnv,encoding:'utf8'})
    writeFileSync('docs/evidence/p6/restore-original-verify.log',checked.stdout+checked.stderr)
    r.check(checked.status===0,'P6R06 original restore matches actual separately retained checkpoint file')
    const invalidate=(i:number)=>spawnSync('npx',['tsx','scripts/invalidate-restored-auth.ts','--database',names[i],'--reason','P6 isolated restore rehearsal'],{env:{...verifyEnv,DATABASE_URL:urls[i]},encoding:'utf8'})
    const invalidated=invalidate(1);writeFileSync('docs/evidence/p6/restore-invalidate.log',invalidated.stdout+invalidated.stderr)
    const [auth]=await whole`SELECT (SELECT count(*) FROM user_session WHERE revoked_at IS NULL)::int AS sessions,(SELECT count(*) FROM auth_passkey WHERE revoked_at IS NULL)::int AS keys,(SELECT count(*) FROM auth_webauthn_challenge)::int AS challenges,(SELECT count(*) FROM document_edit_lease)::int AS leases`
    r.check(invalidated.status===0&&Object.values(auth).every(n=>n===0),'P6R07 verified whole restore revokes active credentials/challenges/leases')
    const [paused]=await whole`SELECT (SELECT count(*) FROM email_message WHERE status='paused')::int AS mail,(SELECT count(*) FROM background_job WHERE status='paused')::int AS jobs,(SELECT count(*) FROM automation_setting WHERE enabled OR mail_enabled)::int AS enabled`
    r.check(paused.mail===nonempty.mail&&paused.jobs===nonempty.jobs&&paused.enabled===0,'P6R11 whole restore pauses actual queued mail/jobs and disables automation')
    const [after]=await whole`SELECT audit_verify_v1() AS result`
    r.check(after.result.ok,'P6R08 invalidation is a new system event on original valid chain')
    await bad.begin(async tx=>{await tx`SET LOCAL session_replication_role='replica'`;await tx`UPDATE audit_log SET action='tampered' WHERE chain_id IS NOT NULL AND chain_seq=1`})
    const rejected=invalidate(2);writeFileSync('docs/evidence/p6/restore-tampered-reject.log',rejected.stdout+rejected.stderr)
    const [untouched]=await bad`SELECT count(*)::int AS n FROM user_session WHERE revoked_at IS NULL`
    r.check(rejected.status!==0&&rejected.stderr.includes('Restored audit verification failed')&&untouched.n===1,'P6R09 invalid original restore rejects before changing credentials or books')
    console.log(r.summary());process.exitCode=r.failures?1:0
  }finally{
    for(const c of clients)await c.end()
    for(const name of names)if(initial[name]===0)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.end()
  }
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Restore rehearsal failed');process.exitCode=1})

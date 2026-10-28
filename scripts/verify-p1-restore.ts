import './env'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import postgres from 'postgres'
import {pgTool} from '../src/lib/backup-paths'
async function main(){
  const source=new URL(process.env.TEST_DATABASE_URL!),sourceName=source.pathname.slice(1)
  if(process.env.TEST_DATABASE_CONFIRMATION!==sourceName)throw Error('Unconfirmed restore source')
  const name='figtree_p1_restore_'+randomUUID().replaceAll('-','')+'_test',adminUrl=new URL(source),cloneUrl=new URL(source);adminUrl.pathname='/postgres';cloneUrl.pathname='/'+name
  const admin=postgres(adminUrl.href,{max:1}),scratch=mkdtempSync(join(tmpdir(),'figtree-p1-restore-')),dump=join(scratch,'test.dump')
  const pgEnv={...process.env,PGHOST:source.hostname,PGPORT:source.port||'5432',PGUSER:decodeURIComponent(source.username)||process.env.USER,PGPASSWORD:decodeURIComponent(source.password),PGDATABASE:sourceName}
  let created=false,clone:ReturnType<typeof postgres>|undefined
  try{
    await admin.unsafe(`CREATE DATABASE "${name}"`);created=true
    execFileSync(pgTool('pg_dump'),['--format=custom','--file',dump],{env:pgEnv,stdio:'pipe'})
    execFileSync(pgTool('pg_restore'),['--no-owner','--no-privileges','--dbname',name,dump],{env:pgEnv,stdio:'pipe'})
    clone=postgres(cloneUrl.href,{max:1})
    const [before]=await clone`SELECT (SELECT count(*) FROM user_session WHERE revoked_at IS NULL)::int AS sessions,
      (SELECT count(*) FROM document_edit_lease)::int AS leases,(SELECT count(*) FROM auth_recovery_code)::int AS codes,
      (SELECT count(*) FROM app_user WHERE mfa_secret_ciphertext IS NOT NULL)::int AS "activeFactors",
      (SELECT count(*) FROM app_user WHERE mfa_pending_ciphertext IS NOT NULL)::int AS "pendingFactors"`
    if(!before.sessions || !before.leases || !before.codes || !before.activeFactors || !before.pendingFactors)throw Error('Restore fixture must contain actual browser sessions, leases, recovery codes, active and pending factors; run p1:browser first')
    const balance=await clone`SELECT status,count(*)::text AS n,sum(total_debit)::text AS debit,sum(total_credit)::text AS credit FROM journal_entry GROUP BY status ORDER BY status`
    execFileSync('npx',['tsx','scripts/invalidate-restored-auth.ts','--database',name,'--reason','P1 real test snapshot restore'],{env:{...process.env,DATABASE_URL:cloneUrl.href},stdio:'pipe'})
    const [after]=await clone`SELECT (SELECT count(*) FROM user_session WHERE revoked_at IS NULL)::int AS sessions,
      (SELECT count(*) FROM document_edit_lease)::int AS leases,(SELECT count(*) FROM auth_recovery_code)::int AS codes,
      (SELECT count(*) FROM audit_log WHERE action='restore_auth_invalidated' AND record_id=${name})::int AS audit,
      (SELECT count(*) FROM app_user WHERE mfa_secret_ciphertext IS NOT NULL)::int AS "activeFactors",
      (SELECT count(*) FROM app_user WHERE mfa_pending_ciphertext IS NOT NULL)::int AS "pendingFactors"`
    const final=await clone`SELECT status,count(*)::text AS n,sum(total_debit)::text AS debit,sum(total_credit)::text AS credit FROM journal_entry GROUP BY status ORDER BY status`
    if(after.sessions || after.leases || after.codes || after.pendingFactors || after.activeFactors!==before.activeFactors || after.audit!==1 || JSON.stringify(balance)!==JSON.stringify(final))throw Error('Restored authentication invalidation failed or accounting changed')
    writeFileSync(join(process.env.P1_EVIDENCE_DIR??'docs/evidence/p1','restore.json'),JSON.stringify({source:sourceName,restored:name,before,after,accountingTotalsUnchanged:true},null,2)+'\n')
    console.log('PASS real PostgreSQL dump/restore: sessions, leases, recovery codes and pending factors invalidated; active factors preserved and accounting totals unchanged.\n=== ALL CHECKS PASSED ===')
  }finally{await clone?.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(scratch,{recursive:true,force:true})}
}
main().catch(()=>{console.error('Real snapshot restore verification failed; no production target used.');process.exitCode=1})

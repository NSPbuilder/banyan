/** Run on a restored database before admitting traffic. No automatic fallback
 * to a database name; the operator must name the exact restored target. */
import './dotenv'
import {userInfo} from 'node:os'
import {sql} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {acting} from '../src/lib/acting'
import {pauseRestoredAutomation} from '../src/lib/automation-restore'
import {auditRow} from '../src/lib/audit-row'
import {verifyAudit} from '../src/lib/audit-chain'
const args=process.argv.slice(2),get=(key:string)=>args[args.indexOf(key)+1]
async function main(){
  const target=new URL(process.env.DATABASE_URL!).pathname.slice(1)
  if(!args.includes('--database') || get('--database')!==target || !args.includes('--reason') || !get('--reason')?.trim())
    throw Error('Usage: --database <exact restored name> --reason <restore reference>')
  await db.transaction(async tx=>{
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
    const verification=await verifyAudit(tx)
    if(!verification.ok)throw Error('Restored audit verification failed; authentication and books were not changed: '+JSON.stringify(verification.issues))
    const actor=`shell:${userInfo().username}`;await acting(tx,actor)
    const sessions=await tx.execute(sql`UPDATE user_session SET revoked_at=clock_timestamp(),reauthenticated_at=NULL WHERE revoked_at IS NULL`)
    await tx.execute(sql`UPDATE webdav_credential SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL`)
    const leases=await tx.execute(sql`DELETE FROM document_edit_lease RETURNING id`)
    // A dump can precede a code's consumption. Never revive that code on restore.
    await tx.execute(sql`DELETE FROM auth_recovery_code`)
    await tx.execute(sql`DELETE FROM auth_webauthn_challenge`)
    // A whole-database restore can revive a credential revoked after the dump.
    // Require re-enrollment; retain revocation evidence and public keys.
    const passkeys=await tx.execute(sql`UPDATE auth_passkey SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL RETURNING id`)
    await tx.execute(sql`UPDATE user_session SET strong_authenticated_at=NULL,authenticated_passkey_id=NULL`)
    await tx.execute(sql`UPDATE app_user SET mfa_pending_ciphertext=NULL,mfa_pending_until=NULL WHERE mfa_pending_ciphertext IS NOT NULL`)
    const automation=await pauseRestoredAutomation(tx)
    await auditRow(tx,{actor,action:'restore_auth_invalidated',table:'user_session',recordId:target,scope:'system',reason:get('--reason'),after:{sessions:sessions.count,leases:leases.length,passkeys:passkeys.length,auditVerified:true,automation}})
  })
  console.log(`Restored authentication invalidated in ${target}; credentials and leases cannot survive restore.`)
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Invalidation failed');process.exitCode=1}).finally(()=>connection.end())

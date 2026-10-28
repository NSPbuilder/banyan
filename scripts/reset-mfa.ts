/** Offline administrator recovery; never an HTTP bypass. Requires an exact
 * database confirmation and reason. Existing user identity and audit reused.
 */
import './dotenv'
import {userInfo} from 'node:os'
import {sql} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {auditRow} from '../src/lib/audit-row'
import {acting} from '../src/lib/acting'
const args=process.argv.slice(2),get=(key:string)=>args[args.indexOf(key)+1]
async function main(){
  const target=new URL(process.env.DATABASE_URL!).pathname.slice(1)
  if(!args.includes('--database') || get('--database')!==target || !args.includes('--email')
    || !args.includes('--reason') || !get('--reason')?.trim())throw new Error('Usage: --database <exact name> --email <administrator> --reason <recovery reason>')
  await db.transaction(async tx=>{
    const [user]=await tx.execute<{id:string;kind:string}>(sql`SELECT id::text,kind FROM app_user
      WHERE email=lower(${get('--email').trim()}) AND is_active FOR UPDATE`)
    if(!user || !['superadmin','owner'].includes(user.kind))throw new Error('Recovery is limited to active administrators.')
    const actor=`shell:${userInfo().username}`;await acting(tx,actor)
    await tx.execute(sql`UPDATE app_user SET mfa_secret_ciphertext=NULL,mfa_enabled_at=NULL,
      mfa_pending_ciphertext=NULL,mfa_pending_until=NULL,mfa_last_counter=-1 WHERE id=${user.id}::uuid`)
    await tx.execute(sql`DELETE FROM auth_recovery_code WHERE user_id=${user.id}::uuid`)
    const keys=await tx.execute(sql`UPDATE auth_passkey SET revoked_at=clock_timestamp() WHERE user_id=${user.id}::uuid AND revoked_at IS NULL RETURNING id`)
    await tx.execute(sql`UPDATE auth_webauthn_challenge SET consumed_at=clock_timestamp() WHERE user_id=${user.id}::uuid AND consumed_at IS NULL`)
    await tx.execute(sql`UPDATE user_session SET revoked_at=clock_timestamp() WHERE user_id=${user.id}::uuid AND revoked_at IS NULL`)
    await tx.execute(sql`UPDATE webdav_credential SET revoked_at=clock_timestamp() WHERE user_id=${user.id}::uuid AND revoked_at IS NULL`)
    await auditRow(tx,{actor,action:'mfa_offline_recovery',table:'app_user',recordId:user.id,after:{passkeysRevoked:keys.length},context:{reason:get('--reason')}})
  })
  console.log(`Offline MFA recovery recorded in ${target}; sessions and WebDAV credentials revoked.`)
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Recovery failed');process.exitCode=1}).finally(()=>connection.end())

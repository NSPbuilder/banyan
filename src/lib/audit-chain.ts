import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Tx } from './acting'
import { liveAuth } from './auth-security'
import { assertCheckpoint,verifyAuditProof,type AuditCheckpoint,type AuditProof,type AuditHead,type AuditVerification } from './audit-chain-types'

type Reader=Pick<Tx,'execute'>
export async function recordAuditUnavailable(actor:string){
  const result={format:'FigTree.audit.verification.v1',ok:false,chains:'0',issues:[{scope:'verification',type:'unavailable'}],legacyProtectedSince:'',tailProof:'Verification did not complete.'} satisfies AuditVerification
  await db.execute(sql`INSERT INTO audit_verification_run(actor,result) VALUES(${actor},${JSON.stringify(result)}::jsonb)`)
}
async function heads(tx:Reader,entityId?:string):Promise<AuditHead[]> {
  return tx.execute<AuditHead>(sql`SELECT chain_id::text AS "chainId",scope_key AS scope,
    entity_id::text AS "entityId",ledger_id::text AS "ledgerId",sequence::text,hash
    FROM audit_chain_head WHERE (${entityId??null}::uuid IS NULL OR entity_id=${entityId??null}::uuid) ORDER BY scope_key`)
}
export async function verifyAudit(tx:Reader=db,checkpoint?:AuditCheckpoint,requireIndependent=false):Promise<AuditVerification> {
  const [row]=await tx.execute<{result:AuditVerification}>(sql`SELECT audit_verify_v1() AS result`)
  const result=row.result
  result.independentCheckpointCompared=false
  if(requireIndependent&&!checkpoint)result.issues.push({scope:'checkpoint',type:'missing_independent_checkpoint'})
  if(checkpoint) {
    assertCheckpoint(checkpoint)
    if(!checkpoint.heads.length)result.issues.push({scope:'checkpoint',type:'empty_independent_checkpoint'})
    for(const h of checkpoint.heads) {
      const [actual]=await tx.execute<{sequence:string;hash:string;scope:string;entityId:string|null;ledgerId:string|null;event_hash:string|null}>(sql`
        SELECT h.sequence::text,h.hash,h.scope_key AS scope,h.entity_id::text AS "entityId",h.ledger_id::text AS "ledgerId",a.event_hash
        FROM audit_chain_head h LEFT JOIN audit_log a ON a.chain_id=h.chain_id AND a.chain_seq=${h.sequence}::bigint
        WHERE h.chain_id=${h.chainId}::uuid`)
      const matched=actual&&actual.scope===h.scope&&actual.entityId===h.entityId&&actual.ledgerId===h.ledgerId
        &&BigInt(actual.sequence)>=BigInt(h.sequence)
        &&(h.sequence==='0'?h.hash==='0'.repeat(64):actual.event_hash===h.hash)
      if(!matched)result.issues.push({scope:h.scope,chainId:h.chainId,sequence:h.sequence,type:'independent_checkpoint_mismatch'})
    }
    result.independentCheckpointCompared=checkpoint.heads.length>0&&!result.issues.some(x=>x.type==='independent_checkpoint_mismatch')
    result.checkpointCreatedAt=checkpoint.createdAt
    result.tailProof='Compared only the supplied checkpoint chains at their recorded sequences; other chains and later tail completeness are not independently proven.'
  }
  result.ok=result.issues.length===0
  return result
}
/** Visible run is persisted even on verification failure. An exception records
 * unavailable rather than presenting a stale success as a current result. */
export async function runAuditVerification(actor:string,checkpoint?:AuditCheckpoint,requireIndependent=false) {
  try {
    return await db.transaction(async tx=>{
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
      const result=await verifyAudit(tx,checkpoint,requireIndependent)
      await tx.execute(sql`INSERT INTO audit_verification_run(actor,result) VALUES(${actor},${JSON.stringify(result)}::jsonb)`)
      return result
    })
  } catch(error) {
    await recordAuditUnavailable(actor)
    throw error
  }
}
export async function verifyAuditAsOwner(token:string,checkpoint?:AuditCheckpoint) {
  let actor:string|undefined
  try{return await db.transaction(async tx=>{
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
    const who=await liveAuth(tx,token);if(!['owner','superadmin'].includes(who.kind))throw Error('Owner access required.')
    actor=who.email
    const result=await verifyAudit(tx,checkpoint)
    await tx.execute(sql`INSERT INTO audit_verification_run(actor,result) VALUES(${who.email},${JSON.stringify(result)}::jsonb)`)
    return result
  })}catch(error){
    if(actor)await recordAuditUnavailable(actor)
    throw error
  }
}
export async function createAuditCheckpoint(token:string) {
  return db.transaction(async tx=>{
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
    const who=await liveAuth(tx,token,true)
    if(!['owner','superadmin'].includes(who.kind))throw Error('Owner access required.')
    if(!(await verifyAudit(tx)).ok)throw Error('Audit verification failed; no checkpoint created.')
    const doc:AuditCheckpoint={format:'FigTree.audit.checkpoint.v1',createdAt:new Date().toISOString(),heads:await heads(tx)}
    const [row]=await tx.execute<{id:string}>(sql`INSERT INTO audit_checkpoint(actor,document) VALUES(${who.email},${JSON.stringify(doc)}::jsonb) RETURNING id::text`)
    return {id:row.id,document:doc}
  })
}
export async function auditVerificationStatus() {
  const [clock]=await db.execute<{observedAt:string}>(sql`SELECT clock_timestamp()::text AS "observedAt"`)
  const [latest]=await db.execute<{checked_at:string;actor:string;result:AuditVerification}>(sql`SELECT checked_at::text,actor,result FROM audit_verification_run ORDER BY checked_at DESC,id DESC LIMIT 1`)
  const [seal]=await db.execute<{sealed_at:string;row_count:string;digest:string}>(sql`SELECT sealed_at::text,row_count::text,digest FROM audit_legacy_seal`)
  const [success]=await db.execute<{checked_at:string}>(sql`SELECT checked_at::text FROM audit_verification_run WHERE result->>'ok'='true' ORDER BY checked_at DESC LIMIT 1`)
  return {latest:latest??null,seal,lastSuccess:success?.checked_at??null,observedAt:clock.observedAt}
}
/** Repeatable-read source snapshot; chain payload bytes and original scopes are
 * exported untouched. Legacy history remains the separate labelled audit list. */
export async function exportAuditProof(entityId:string,tx?:Reader):Promise<AuditProof> {
  if(!tx)return db.transaction(async t=>{
    await t.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
    return exportAuditProof(entityId,t)
  })
  if(!(await verifyAudit(tx)).ok)throw Error('Audit verification failed; cannot export a verified origin proof.')
  const proof:AuditProof={format:'FigTree.audit.proof.v1',checkpoint:{format:'FigTree.audit.checkpoint.v1',createdAt:new Date().toISOString(),heads:await heads(tx,entityId)},
    events:await tx.execute<AuditProof['events'][number]>(sql`SELECT a.chain_id::text AS "chainId",chain_seq::text AS sequence,
      previous_hash AS "previousHash",event_hash AS hash,convert_from(canonical_bytes,'UTF8') AS canonical,
      convert_from(audit_event_v1(a),'UTF8') AS display FROM audit_log a JOIN audit_chain_head h USING(chain_id)
      WHERE h.entity_id=${entityId}::uuid ORDER BY h.scope_key,a.chain_seq`),
    origins:await tx.execute<NonNullable<AuditProof['origins']>[number]>(sql`SELECT source_checksum,proof,mapping FROM audit_origin_proof WHERE entity_id=${entityId}::uuid ORDER BY restored_at,id`)}
  verifyAuditProof(proof)
  return proof
}

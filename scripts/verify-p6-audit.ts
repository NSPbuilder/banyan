import './env'
import {sql} from 'drizzle-orm'
import {randomBytes} from 'node:crypto'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {db,sql as connection} from '../src/db/client'
import {reporter,messageOf,expectSaying} from './suite'
import {causesOf} from '../src/lib/db-errors'
import {auditRow} from '../src/lib/audit-row'
import {verifyAudit,verifyAuditAsOwner,createAuditCheckpoint,exportAuditProof,runAuditVerification,auditVerificationStatus} from '../src/lib/audit-chain'
import {auditDigest,canonicalAudit,verifyAuditProof,type AuditProof} from '../src/lib/audit-chain-types'
import {createFirstOwner,signIn} from '../src/lib/users'
import {createCompany} from '../src/lib/setup'
import {exportCompany,restoreCompany,packFigtree,readFigtree} from '../src/lib/backup'
import type {Tx} from '../src/lib/acting'
const r=reporter(80),no=expectSaying(r,causesOf,140)
async function main(){
  const password=randomBytes(30).toString('base64url'),owner=await createFirstOwner({email:'p6-audit@example.test',password,firstName:'Audit reviewer'})
  const {token}=await signIn({email:owner.email,password}),c=await createCompany({code:'P6A',name:'P6 Audit company'},owner.email)
  const ledgerId=c.ledger.id,chainId=async()=>(await db.execute<{id:string}>(sql`SELECT chain_id::text AS id FROM audit_chain_head WHERE scope_key=${'ledger:'+ledgerId}`))[0].id
  const append=()=>db.transaction(tx=>auditRow(tx,{actor:owner.email,action:'test_event',table:'ledger',recordId:ledgerId,ledgerId,entityId:c.company.id,after:{amount:'900719925474099312345'}}))
  // Company creation emits a company event but no ledger event: prove empty.
  r.check((await db.execute(sql`SELECT 1 FROM audit_chain_head WHERE scope_key=${'ledger:'+ledgerId}`)).length===0,'P6A01 ledger chain is empty before two concurrent first writes')
  await Promise.all([append(),append()])
  r.check((await verifyAudit()).ok,'P6A02 two first events have one head and continuous sequence')
  await Promise.all(Array.from({length:80},append))
  r.check((await verifyAudit()).ok,'P6A03 eighty concurrent appends verify with exact payload precision')
  const id=await chainId()
  const [count]=await db.execute<{n:string;heads:string}>(sql`SELECT count(*)::text AS n,(SELECT sequence::text FROM audit_chain_head WHERE chain_id=${id}::uuid) AS heads FROM audit_log WHERE chain_id=${id}::uuid`)
  r.check(count.n==='82'&&count.heads==='82','P6A04 no duplicated or missing sequence after bulk concurrency')
  const doc=await exportAuditProof(c.company.id)
  verifyAuditProof(doc);r.pass('P6A05 authoritative source bytes verify independently in Node')
  const [row]=await db.execute<{bytes:string;hash:string}>(sql`SELECT convert_from(canonical_bytes,'UTF8') AS bytes,event_hash AS hash FROM audit_log WHERE chain_id=${id}::uuid ORDER BY chain_seq LIMIT 1`)
  r.check(row.bytes.includes('900719925474099312345')&&auditDigest(row.bytes)===row.hash,'P6A06 bigint cents and domain separator survive SQL to Node')
  const exact={z:['a',null,true],a:'quote" newline\n',n:'1.2300','𐀀':'astral','':'bmp'}
  const [encoded]=await db.execute<{v:string}>(sql`SELECT audit_canonical_v1(${JSON.stringify(exact)}::jsonb) AS v`)
  r.check(encoded.v===canonicalAudit(exact),'P6A07 bytewise keys, escaping, arrays/null and decimal strings agree')
  await no('P6A08 Node refuses ambiguous floating-point payload','numbers must',async()=>{canonicalAudit({amount:9007199254740992})})
  const before=(await db.execute<{n:string}>(sql`SELECT sequence::text AS n FROM audit_chain_head WHERE chain_id=${id}::uuid`))[0].n
  try{await db.transaction(async tx=>{await auditRow(tx,{actor:owner.email,action:'rolled_back',table:'ledger',recordId:ledgerId,entityId:c.company.id,ledgerId});await tx.execute(sql`UPDATE entity SET name='Must roll back' WHERE id=${c.company.id}::uuid`);throw Error('rollback-test')})}catch(e){if(messageOf(e)!=='rollback-test')throw e}
  const [after]=await db.execute<{n:string;name:string}>(sql`SELECT h.sequence::text AS n,e.name FROM audit_chain_head h JOIN entity e ON e.id=h.entity_id WHERE h.chain_id=${id}::uuid`)
  r.check(after.n===before&&after.name==='P6 Audit company','P6A09 audit/head and business changes roll back together')
  // Force actual audit append failure after changing a business row. The DB
  // trigger's scope assertion fails, so the business update cannot commit.
  const other=await createCompany({code:'P6B',name:'P6 other'},owner.email)
  await no('P6A10 audit append failure prevents corresponding business commit','AUDIT_CHAIN_SCOPE',()=>db.transaction(async tx=>{
    await tx.execute(sql`UPDATE entity SET name='Forbidden commit' WHERE id=${other.company.id}::uuid`)
    await auditRow(tx,{actor:owner.email,action:'bad_scope',table:'ledger',recordId:ledgerId,entityId:other.company.id,ledgerId})
  }))
  r.check((await db.execute<{name:string}>(sql`SELECT name FROM entity WHERE id=${other.company.id}::uuid`))[0].name==='P6 other','P6A11 business value unchanged after audit failure')
  const checkpoint=await createAuditCheckpoint(token),file=join(mkdtempSync(join(tmpdir(),'figtree-p6-anchor-')),'checkpoint.json')
  writeFileSync(file,JSON.stringify(checkpoint.document),{mode:0o600})
  const independent=JSON.parse(readFileSync(file,'utf8'))
  r.check((await verifyAudit(db,independent,true)).independentCheckpointCompared===true,'P6A12 actual independently retained file matches event anchors')
  r.check(!(await verifyAudit(db,undefined,true)).ok,'P6A13 missing required independent checkpoint is a failure')
  async function damage(label:string,mutate:(tx:Tx)=>Promise<unknown>,expected:string,anchor=false){
    const rollback=Symbol('rollback')
    try{await db.transaction(async tx=>{
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);await mutate(tx)
      const result=await verifyAudit(tx,anchor?independent:undefined,anchor)
      r.check(!result.ok&&result.issues.some(i=>i.type===expected),label,JSON.stringify(result.issues));throw rollback
    })}catch(e){if(e!==rollback)throw e}
    if(!(await verifyAudit()).ok)throw Error('Damage fixture escaped rollback')
  }
  await damage('P6A14 modifying payload detected',tx=>tx.execute(sql`UPDATE audit_log SET after='{"amount":"1"}' WHERE chain_id=${id}::uuid AND chain_seq=2`),'display_payload')
  await damage('P6A15 modifying only displayed action detected',tx=>tx.execute(sql`UPDATE audit_log SET action='hidden' WHERE chain_id=${id}::uuid AND chain_seq=2`),'display_payload')
  await damage('P6A16 modifying authoritative bytes detected',tx=>tx.execute(sql`UPDATE audit_log SET canonical_bytes=convert_to('{}','UTF8') WHERE chain_id=${id}::uuid AND chain_seq=2`),'display_payload')
  await damage('P6A17 modifying stored event digest detected',tx=>tx.execute(sql`UPDATE audit_log SET event_hash=repeat('f',64) WHERE chain_id=${id}::uuid AND chain_seq=2`),'hash')
  await damage('P6A18 deleting middle event detected',tx=>tx.execute(sql`DELETE FROM audit_log WHERE chain_id=${id}::uuid AND chain_seq=2`),'sequence')
  await damage('P6A19 swapping event sequences detected',async tx=>{await tx.execute(sql`UPDATE audit_log SET chain_seq=999999 WHERE chain_id=${id}::uuid AND chain_seq=2`);await tx.execute(sql`UPDATE audit_log SET chain_seq=2 WHERE chain_id=${id}::uuid AND chain_seq=1`);await tx.execute(sql`UPDATE audit_log SET chain_seq=1 WHERE chain_id=${id}::uuid AND chain_seq=999999`)},'previous_hash')
  await damage('P6A20 truncating tail with unchanged head detected',tx=>tx.execute(sql`DELETE FROM audit_log WHERE chain_id=${id}::uuid AND chain_seq=82`),'head')
  await damage('P6A21 modifying head detected',tx=>tx.execute(sql`UPDATE audit_chain_head SET hash=repeat('f',64) WHERE chain_id=${id}::uuid`),'head')
  await damage('P6A22 deleting head detected',tx=>tx.execute(sql`DELETE FROM audit_chain_head WHERE chain_id=${id}::uuid`),'missing_head')
  await damage('P6A23 forged tail and head caught by independent anchor',async tx=>{
    await tx.execute(sql`DELETE FROM audit_log WHERE chain_id=${id}::uuid AND chain_seq=82`)
    await tx.execute(sql`UPDATE audit_chain_head SET sequence=81,hash=(SELECT event_hash FROM audit_log WHERE chain_id=${id}::uuid AND chain_seq=81) WHERE chain_id=${id}::uuid`)
    r.check((await verifyAudit(tx)).ok,'P6A24 same-database chain alone cannot prove rewritten tail completeness')
  },'independent_checkpoint_mismatch',true)
  await damage('P6A25 legacy seal modification detected',tx=>tx.execute(sql`UPDATE audit_legacy_seal SET digest=repeat('f',64)`),'legacy_seal')
  await damage('P6A26 extra unsealed legacy event detected',async tx=>{
    await tx.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER zz_p6_audit_chain`)
    await tx.execute(sql`INSERT INTO audit_log(actor,action,table_name,record_id) VALUES('tamper','legacy','test','none')`)
  },'legacy_seal')
  await no('P6A27 ordinary audit edit remains database-refused','AUDIT_LOG_APPEND_ONLY',()=>db.execute(sql`UPDATE audit_log SET action='no' WHERE chain_id=${id}::uuid AND chain_seq=1`))
  await runAuditVerification(owner.email,independent,true)
  r.check((await auditVerificationStatus()).latest?.result.ok===true,'P6A28 verifier result and independent comparison are visible')
  const portable=readFigtree(await packFigtree(await exportCompany(c.company.id)))
  const restored=await restoreCompany(portable,owner.email,{code:'P6COPY',name:'P6 audit copy'})
  const [origin]=await db.execute<{proof:AuditProof;mapping:Record<string,string>}>(sql`SELECT proof,mapping FROM audit_origin_proof WHERE entity_id=${restored.entityId}::uuid`)
  verifyAuditProof(origin.proof)
  r.check(canonicalAudit(origin.proof.checkpoint)===canonicalAudit(portable.auditProof!.checkpoint)&&origin.mapping[c.company.id]===restored.entityId,'P6A29 portable restore retains original scopes/checkpoint and mapping')
  r.check((await verifyAudit()).ok,'P6A30 restored display history and restore event use new valid chains')
  const again=await exportCompany(restored.entityId);verifyAuditProof(again.auditProof!)
  r.check(again.auditProof?.origins?.length===1,'P6A31 re-export preserves nested source provenance')
  const damaged=structuredClone(portable);damaged.auditProof!.events[0].canonical='{}'
  await no('P6A32 tampered source proof refuses company restore before writes','mismatch',()=>restoreCompany(damaged,owner.email,{code:'P6BAD',name:'P6 bad'}))
  r.check((await db.execute(sql`SELECT 1 FROM entity WHERE code='P6BAD'`)).length===0,'P6A33 failed provenance restore creates no company')
  const displayMismatch=structuredClone(portable);displayMismatch.audit!.rows.find(r=>String(r.id)===JSON.parse(displayMismatch.auditProof!.events[0].canonical).target.auditId)!.action='forged display'
  await no('P6A36 changed portable display cannot contradict retained original bytes','displayed source history',()=>restoreCompany(displayMismatch,owner.email,{code:'P6BADVIEW',name:'Bad display'}))
  const another=structuredClone(portable);another.entity.id=other.company.id
  await no('P6A37 original proof from another company is refused','another company',()=>restoreCompany(another,owner.email,{code:'P6BADCO',name:'Bad scope'}))
  await db.execute(sql`ALTER TABLE audit_chain_head RENAME TO p6_verifier_unavailable_fixture`)
  try{
    await no('P6A34 actual verifier exception is refused','audit_chain_head',()=>verifyAuditAsOwner(token))
    const status=await auditVerificationStatus()
    r.check(status.latest?.result.ok===false&&status.latest.result.issues.some(i=>i.type==='unavailable'),'P6A35 actual verifier exception persists visible unavailable result')
  }finally{await db.execute(sql`ALTER TABLE p6_verifier_unavailable_fixture RENAME TO audit_chain_head`)}
  console.log(r.summary());process.exitCode=r.failures?1:0
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

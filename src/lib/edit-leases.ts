import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Tx, acting } from './acting'
import { liveAuth } from './auth-security'
import { newToken, tokenHash } from './users'
import { auditRow } from './audit-row'
import { lockFinanceResource, assertModuleEditable } from './module-extensions'
import type { EditContext, EditProof, EditResource } from './edit-proof'
import { EDIT_RESOURCES } from './edit-proof'

export class EditConflict extends Error {
  constructor(readonly status: 409 | 423 | 403, message: string) { super(message); this.name = 'EditConflict' }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const leaseSeconds = () => {
  const n = Number(process.env.EDIT_LEASE_SECONDS ?? 120)
  if (!Number.isSafeInteger(n) || n < 60 || n > 600) throw new Error('EDIT_LEASE_SECONDS must be 60–600.')
  return n
}
const key = (r: EditResource) => sql`${sql.raw(EDIT_RESOURCES[r.type].leaseKey)}=${r.id}::uuid`

async function lockResource(tx: Tx, r: EditResource, sessionToken: string, firstPartyAssociation = false) {
  if (!uuid.test(r.id) || !uuid.test(r.ledgerId) || !Object.hasOwn(EDIT_RESOURCES,r.type)) throw new EditConflict(403, 'Unknown edit resource.')
  const user = await liveAuth(tx, sessionToken)
  await acting(tx, user.email)
  const seat = EDIT_RESOURCES[r.type].seat
  const [scope] = await tx.execute<{ allowed: boolean; archived: boolean;entity_id:string }>(sql`
    SELECT e.id::text AS entity_id,e.archived_at IS NOT NULL AS archived,
      COALESCE((SELECT enabled FROM company_module_access WHERE entity_id=e.id AND module=${seat}),true)
      AND (${user.kind !== 'user'} OR EXISTS (SELECT 1 FROM user_entity_module_access
        WHERE user_id=${user.user_id}::uuid AND entity_id=e.id AND module=${seat})) AS allowed
    FROM ledger l JOIN entity e ON e.id=l.entity_id WHERE l.id=${r.ledgerId}::uuid`)
  if (!scope?.allowed || scope.archived) throw new EditConflict(403, 'This company or module is unavailable to you.')
  // Same existing source-first order as every Project accounting door.
  if (r.type === 'invoice') await lockFinanceResource(tx,'invoice', r.id)
  else if(r.type==='entry') await lockFinanceResource(tx,'payment', r.id)
  const table = sql.raw(EDIT_RESOURCES[r.type].table)
  const belongs=r.type==='account'?sql`entity_id=${scope.entity_id}::uuid`:
    r.type==='party'?(firstPartyAssociation?sql`true`:sql`EXISTS(SELECT 1 FROM party_role WHERE party_id=${r.id}::uuid AND entity_id=${scope.entity_id}::uuid)`):
    sql`ledger_id=${r.ledgerId}::uuid`
  const [row] = await tx.execute<{ version: string }>(sql`SELECT version::text FROM ${table}
    WHERE id=${r.id}::uuid AND ${belongs} FOR UPDATE`)
  if (!row) throw new EditConflict(403, 'The document is unavailable in this company.')
  if (firstPartyAssociation) {
    // Read eligibility AFTER the parent lock: an earlier snapshot can miss a
    // role committed while this request waited for the shared party row.
    const known = await tx.execute(sql`SELECT 1 FROM party p WHERE p.id=${r.id}::uuid AND p.is_active
      AND EXISTS(SELECT 1 FROM party_role WHERE party_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM party_role WHERE party_id=p.id AND entity_id=${scope.entity_id}::uuid)`)
    if (!known.length) throw new EditConflict(403, 'This party is no longer available to add here. Reload the party list.')
  }
  await assertModuleEditable(tx, r)
  return { user, row, table }
}
async function leaseFor(tx: Tx, r: EditResource) {
  const [lease] = await tx.execute<{
    holder_user_id: string; session_hash: string; tab_id: string; token_hash: string; generation: string;
    expires_at: string; live: boolean; editor: string
  }>(sql`SELECT d.holder_user_id::text,d.session_hash,d.tab_id::text,d.token_hash,d.generation::text,
      d.expires_at::text,d.expires_at>clock_timestamp() AS live,concat_ws(' ',u.first_name,u.last_name) AS editor
    FROM document_edit_lease d JOIN app_user u ON u.id=d.holder_user_id WHERE ${key(r)} FOR UPDATE OF d`)
  return lease
}
function owns(lease: Awaited<ReturnType<typeof leaseFor>>, proof: EditProof, userId: string, token: string) {
  return !!lease && lease.holder_user_id === userId && lease.session_hash === tokenHash(token)
    && lease.tab_id === proof.tabId && lease.token_hash === tokenHash(proof.token ?? '') && lease.generation === proof.generation
}
export async function editLease(r: EditResource, sessionToken: string, operation: 'acquire'|'heartbeat'|'release'|'takeover', proof: EditProof) {
  if (!uuid.test(proof.tabId ?? '')) throw new EditConflict(403, 'An editor tab is required.')
  return db.transaction(async tx => {
    const { user, row } = await lockResource(tx, r, sessionToken)
    const lease = await leaseFor(tx, r)
    const owner = owns(lease, proof, user.user_id, sessionToken)
    if (operation === 'release') {
      if (owner) await tx.execute(sql`UPDATE document_edit_lease SET expires_at=clock_timestamp() WHERE ${key(r)}`)
      return { released: owner }
    }
    if (operation === 'heartbeat') {
      if (!owner || !lease?.live) throw new EditConflict(423, 'Your edit lease expired or was taken over. Keep your input and check again.')
      const [renewed] = await tx.execute<{expires_at:string}>(sql`UPDATE document_edit_lease
        SET last_active_at=clock_timestamp(),expires_at=clock_timestamp()+${leaseSeconds()}*interval '1 second'
        WHERE ${key(r)} RETURNING expires_at::text`)
      return { version: row.version, generation: lease.generation, token: proof.token, expiresAt: renewed.expires_at, editor: lease.editor }
    }
    if (operation === 'takeover' && user.kind !== 'superadmin' && user.kind !== 'owner') throw new EditConflict(403, 'Only an administrator can take over editing.')
    if (lease?.live && !owner && operation !== 'takeover') throw new EditConflict(423, `${lease.editor} is editing until ${lease.expires_at}. Your input is preserved.`)
    if (owner && lease?.live && operation === 'acquire') return {version:row.version,generation:lease.generation,token:proof.token,expiresAt:lease.expires_at,editor:lease.editor}
    const token = newToken(), generation = String(BigInt(lease?.generation ?? '0') + 1n)
    await tx.execute(sql`DELETE FROM document_edit_lease WHERE ${key(r)}`)
    const [created] = await tx.execute<{expires_at:string}>(sql`INSERT INTO document_edit_lease
      (ledger_id,invoice_id,journal_entry_id,inbox_item_id,recurring_template_id,reminder_rule_id,migration_run_id,budget_id,payment_connection_id,inbound_connection_id,account_id,party_id,holder_user_id,session_hash,tab_id,token_hash,generation,expires_at)
      VALUES (${r.ledgerId}::uuid,${r.type === 'invoice' ? r.id : null}::uuid,${r.type === 'entry' ? r.id : null}::uuid,
        ${r.type==='inbox'?r.id:null}::uuid,${r.type==='recurring'?r.id:null}::uuid,${r.type==='reminder'?r.id:null}::uuid,
        ${r.type==='migration'?r.id:null}::uuid,${r.type==='budget'?r.id:null}::uuid,
        ${r.type==='payment'?r.id:null}::uuid,${r.type==='inbound'?r.id:null}::uuid,
        ${r.type==='account'?r.id:null}::uuid,${r.type==='party'?r.id:null}::uuid,
        ${user.user_id}::uuid,${tokenHash(sessionToken)},${proof.tabId}::uuid,${tokenHash(token)},${generation}::bigint,
        clock_timestamp()+${leaseSeconds()}*interval '1 second') RETURNING expires_at::text`)
    await auditRow(tx,{actor:user.email,action:operation==='takeover'?'edit_takeover':'edit_acquire',table:EDIT_RESOURCES[r.type].table,recordId:r.id,
      context:{ledgerId:r.ledgerId,generation,previousEditor:lease?.holder_user_id ?? null}})
    return {version:row.version,generation,token,expiresAt:created.expires_at,editor:user.email}
  })
}

/** Only request adapters call this boundary. The wrapped commands are the
 * existing FigTree domain owners (also used by trusted in-transaction Project
 * and settlement commands); no alternate accounting implementation here.
 */
async function writeDocument<T extends object>(r: EditResource, context: EditContext, command: (tx: Tx, actor: string) => Promise<T>, firstPartyAssociation = false): Promise<T & {version?:string}> {
  if (!/^[1-9]\d*$/.test(context.proof.version)) throw new EditConflict(409, 'A saved document version is required. Reload or compare before saving.')
  return db.transaction(async tx => {
    const {user,row,table} = await lockResource(tx,r,context.sessionToken,firstPartyAssociation)
    if (row.version !== context.proof.version) throw new EditConflict(409, 'This document changed. Your input is preserved; open the saved document to compare before reloading.')
    const lease = await leaseFor(tx,r)
    const owner = owns(lease,context.proof,user.user_id,context.sessionToken)
    if ((context.leaseRequired && (!owner || !lease?.live)) || (lease?.live && !owner)) throw new EditConflict(423, `${lease?.editor ?? 'Another editor'} holds this document, or your lease expired. Check again before saving.`)
    const result = await command(tx,user.email)
    const [after] = await tx.execute<{version:string}>(sql`SELECT version::text FROM ${table} WHERE id=${r.id}::uuid`)
    return {...result,version:after?.version}
  })
}

export async function withDocumentWrite<T extends object>(r: EditResource, context: EditContext, command: (tx: Tx, actor: string) => Promise<T>): Promise<T & {version?:string}> {
  return writeDocument(r,context,command)
}

/** A first company association has no local editor yet. It still needs the
 * saved shared-party version and must respect any existing editor's lease. */
export async function withPartyAssociation<T extends object>(ledgerId: string, partyId: string, context: Omit<EditContext,'leaseRequired'>, command: (tx: Tx, actor: string) => Promise<T>): Promise<T & {version?:string}> {
  return writeDocument({ledgerId,type:'party',id:partyId},{...context,leaseRequired:false},command,true)
}

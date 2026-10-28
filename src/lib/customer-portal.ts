import 'server-only'
import {randomUUID} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import {newToken,tokenHash} from './users'
import { lockFinanceResource } from './module-extensions'
import {openItemsQuery} from './payments'
import {integrationScope,integrationAudit,IntegrationError,integrationId} from './integration-access'
import type {AutomationActor} from './automation-access'
import {invoicePdf} from './pdf-reports'

export const PORTAL_COOKIE='figtree_portal'
export type PortalScope={invitation_id:string;entity_id:string;ledger_id:string;invoice_id:string;party_id:string;company_name:string;
  number:string|null;status:string;direction:string;document_kind:string;version:string;issued_invoice_version:string;currency:string;issued_on:string;due_on:string}
const unavailable=()=>new IntegrationError('PORTAL','This invoice link is unavailable. Ask its sender for a new link.',404)
export function publicPaymentOrigin(){
  try{const url=new URL(process.env.P5_PUBLIC_ORIGIN??'');if(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash)return url.origin}catch{}
  throw new IntegrationError('ORIGIN','Configure the public HTTPS origin before sharing payment links.',503)
}
export async function inviteInvoice(ledgerId:string,invoiceId:string,actor:AutomationActor,version:string) {
  if(!integrationId(invoiceId)||!/^\d+$/.test(version))throw unavailable()
  const token=newToken(),id=randomUUID(),origin=publicPaymentOrigin()
  const result=await db.transaction(async tx=>{
    const s=await integrationScope(tx,ledgerId,actor,'payment')
    await lockFinanceResource(tx,'invoice',invoiceId)
    const [invoice]=await tx.execute<{party_id:string;version:string}>(sql`SELECT party_id::text,version::text FROM invoice
      WHERE id=${invoiceId}::uuid AND ledger_id=${ledgerId}::uuid AND status='posted' AND direction='sales' AND document_kind='invoice' FOR UPDATE`)
    if(!invoice)throw unavailable()
    if(invoice.version!==version)throw new IntegrationError('STALE','The invoice changed. Review its current version before sharing a link.',409)
    const [row]=await tx.execute<{expires_at:string}>(sql`INSERT INTO portal_invitation(id,entity_id,ledger_id,invoice_id,party_id,token_hash,expires_at,created_by,issued_invoice_version)
      VALUES(${id}::uuid,${s.entity_id}::uuid,${ledgerId}::uuid,${invoiceId}::uuid,${invoice.party_id}::uuid,${tokenHash(token)},
        clock_timestamp()+interval '7 days',${s.userId}::uuid,${version}::bigint) RETURNING expires_at::text`)
    await integrationAudit(tx,s,'portal_invited','portal_invitation',id,{invoiceId,invoiceVersion:version,expiresAt:row.expires_at})
    return row
  })
  return {id,url:origin+'/pay/'+id+'#'+token,expiresAt:result.expires_at}
}
export async function revokeInvitation(ledgerId:string,id:string,actor:AutomationActor) {
  if(!integrationId(id))throw unavailable()
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'portal:'+id.toLowerCase()},0))`)
    const s=await integrationScope(tx,ledgerId,actor,'payment')
    const [row]=await tx.execute(sql`UPDATE portal_invitation SET revoked_at=COALESCE(revoked_at,clock_timestamp())
      WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid RETURNING id`)
    if(!row)throw unavailable()
    await integrationAudit(tx,s,'portal_revoked','portal_invitation',id)
  })
}
async function invitationScope(tx:Tx,id:string) {
  const [p]=await tx.execute<PortalScope&{created_by:string|null}>(sql`SELECT p.id::text AS invitation_id,p.entity_id::text,p.ledger_id::text,p.invoice_id::text,p.party_id::text,p.created_by::text,
    e.name AS company_name,i.number,i.status,i.direction,i.document_kind,i.version::text,p.issued_invoice_version::text,l.currency,i.issued_on::text,i.due_on::text
    FROM portal_invitation p JOIN invoice i ON i.id=p.invoice_id AND i.ledger_id=p.ledger_id AND i.party_id=p.party_id
    JOIN ledger l ON l.id=p.ledger_id AND l.entity_id=p.entity_id JOIN entity e ON e.id=p.entity_id
    WHERE p.id=${id}::uuid AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() AND e.archived_at IS NULL
      AND i.direction='sales' AND i.document_kind='invoice' AND i.status IN ('posted','void') FOR SHARE OF p,e`)
  if(!p)throw unavailable()
  const [issuer]=await tx.execute<{kind:string}>(sql`SELECT kind FROM app_user WHERE id=${p.created_by}::uuid AND is_active FOR SHARE`)
  if(!issuer)throw unavailable()
  const [module]=await tx.execute<{enabled:boolean}>(sql`SELECT enabled FROM company_module_access WHERE entity_id=${p.entity_id}::uuid AND module='/invoices' FOR SHARE`)
  if(module&&!module.enabled)throw unavailable()
  if(issuer.kind==='user'&&!(await tx.execute(sql`SELECT 1 FROM user_entity_access a JOIN user_entity_module_access m
    ON m.user_id=a.user_id AND m.entity_id=a.entity_id WHERE a.user_id=${p.created_by}::uuid AND a.entity_id=${p.entity_id}::uuid AND m.module='/invoices' FOR SHARE OF a,m`)).length)throw unavailable()
  if((await tx.execute(sql`SELECT 1 FROM migration_run WHERE ledger_id=${p.ledger_id}::uuid AND status NOT IN ('active','cancelled')`)).length)throw unavailable()
  return p
}
/** GET never calls this. The browser sends a fragment-held secret only after a gesture. */
export async function exchangeInvitation(id:string,token:string) {
  if(!integrationId(id)||!/^[A-Za-z0-9_-]{32,200}$/.test(token))throw unavailable()
  const session=newToken()
  const scope=await db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'portal:'+id.toLowerCase()},0))`)
    const p=await invitationScope(tx,id)
    if(!(await tx.execute(sql`SELECT 1 FROM portal_invitation WHERE id=${id}::uuid AND token_hash=${tokenHash(token)}`)).length)throw unavailable()
    const [count]=await tx.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM portal_session WHERE portal_invitation_id=${id}::uuid AND expires_at>clock_timestamp() AND revoked_at IS NULL`)
    if(count.n>=20)throw new IntegrationError('PORTAL_RATE','Please wait before opening another invoice session.',429)
    await tx.execute(sql`INSERT INTO portal_session(entity_id,ledger_id,portal_invitation_id,token_hash,expires_at)
      SELECT entity_id,ledger_id,id,${tokenHash(session)},LEAST(expires_at,clock_timestamp()+interval '20 minutes') FROM portal_invitation WHERE id=${id}::uuid`)
    return p
  })
  return {session,scope}
}
export async function portalScope(token:string,id:string,on:typeof db|Tx=db) {
  if(!integrationId(id)||!/^[A-Za-z0-9_-]{32,200}$/.test(token))throw unavailable()
  return on.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${'portal:'+id.toLowerCase()},0))`)
    const p=await invitationScope(tx,id)
    const [session]=await tx.execute(sql`SELECT 1 FROM portal_session WHERE token_hash=${tokenHash(token)} AND portal_invitation_id=${id}::uuid
      AND entity_id=${p.entity_id}::uuid AND ledger_id=${p.ledger_id}::uuid AND expires_at>clock_timestamp() AND revoked_at IS NULL FOR SHARE`)
    if(!session)throw unavailable()
    return p
  })
}
/** Projection only. Never return party ids, GL, private notes, receipts or ERP actor data. */
export async function portalInvoice(token:string,id:string) {
  return db.transaction(async tx=>{
    const p=await portalScope(token,id,tx)
    const [balance]=p.status==='posted'?await tx.execute<{balance:string}>(sql`SELECT balance::text FROM (${openItemsQuery(sql`AND i.id=${p.invoice_id}::uuid`)}) due`):[]
    const changed=await tx.execute(sql`SELECT 1 FROM processor_transaction WHERE invoice_id=${p.invoice_id}::uuid AND kind IN ('refund','dispute') LIMIT 1`)
    const review=await tx.execute(sql`SELECT 1 FROM checkout_request WHERE invoice_id=${p.invoice_id}::uuid AND status='needs_accounting_review' LIMIT 1`)
    return {company:p.company_name,number:p.number,status:p.status,currency:p.currency,issuedOn:p.issued_on,dueOn:p.due_on,
      amount:balance?.balance??'0',updated:p.version!==p.issued_invoice_version,paymentReview:!!(changed.length||review.length)}
  })
}
export async function portalPdf(token:string,id:string){
  return db.transaction(async tx=>{
    const p=await portalScope(token,id,tx)
    await lockFinanceResource(tx,'invoice',p.invoice_id)
    const [invoice]=await tx.execute<{party_id:string;status:string}>(sql`SELECT party_id::text,status FROM invoice WHERE id=${p.invoice_id}::uuid FOR SHARE`)
    if(invoice.party_id!==p.party_id||invoice.status!=='posted')throw unavailable()
    // Rendering uses existing customer-only queries; the source lock prevents a concurrent correction from changing its customer.
    return invoicePdf(p.invoice_id)
  })
}

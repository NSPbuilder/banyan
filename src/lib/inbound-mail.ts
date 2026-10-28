import 'server-only'
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {withDocumentWrite} from './edit-leases'
import type {EditContext} from './edit-proof'
import {AutomationError,type AutomationActor,type AutomationScope} from './automation-access'
import {integrationScope,integrationActor,integrationAudit,deliveryAudit,IntegrationError,integrationId} from './integration-access'
import {sealIntegration,openIntegration} from './payment-provider'
import {publicPaymentOrigin} from './customer-portal'
import {validateInboxFile} from './inbox-file'
import {persistInboxReceipt} from './inbox'
import {writeBlobBytes,readBlobBytes} from './attachments'

type InboundConnection={id:string;entity_id:string;ledger_id:string;authorized_by:string|null;provider_account:string;recipient_base:string;alias_address:string|null;username_ciphertext:Buffer|null;password_ciphertext:Buffer|null;enabled:boolean;binding_attached:boolean;version:string}
const connectionColumns=sql.raw('id::text,entity_id::text,ledger_id::text,authorized_by::text,provider_account,recipient_base,alias_address,username_ciphertext,password_ciphertext,enabled,binding_attached,version::text')
export type InboundSettings={providerAccount:string;recipientBase:string;username:string;password:string}
function settings(input:InboundSettings){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(input.providerAccount)||!/^[-A-Za-z0-9]+@inbound\.postmarkapp\.com$/i.test(input.recipientBase))throw new IntegrationError('SETTINGS','Enter the Postmark server identifier and its inbound address.')
  if(input.username&&!/^[A-Za-z0-9_-]{8,100}$/.test(input.username)||input.password&&!/^[A-Za-z0-9_-]{24,200}$/.test(input.password))throw new IntegrationError('CREDENTIAL','Use an ASCII username and a random password of at least 24 characters.')
}
const alias=(base:string)=>base.toLowerCase().replace('@','+'+randomUUID().replaceAll('-','')+'@')
export async function createInboundConnection(ledgerId:string,actor:AutomationActor,input:InboundSettings){
  settings(input);const id=randomUUID()
  return db.transaction(async tx=>{
    const s=await integrationScope(tx,ledgerId,actor,'inbound',true)
    await tx.execute(sql`INSERT INTO inbound_connection(id,entity_id,ledger_id,authorized_by,provider_account,recipient_base,alias_address,username_ciphertext,password_ciphertext)
      VALUES(${id}::uuid,${s.entity_id}::uuid,${ledgerId}::uuid,${s.userId}::uuid,${input.providerAccount},${input.recipientBase.toLowerCase()},${alias(input.recipientBase)},
        ${input.username?sealIntegration(input.username,id,'postmark-user'):null},${input.password?sealIntegration(input.password,id,'postmark-password'):null})`)
    await integrationAudit(tx,s,'inbound_config_created','inbound_connection',id,{providerAccount:input.providerAccount})
    return {id}
  })
}
export async function saveInboundConnection(ledgerId:string,id:string,context:EditContext,input:InboundSettings,rotate:boolean,enabled:boolean){
  settings(input)
  return withDocumentWrite({ledgerId,type:'inbound',id},context,async tx=>{
    const s=await integrationScope(tx,ledgerId,integrationActor(context.sessionToken),'inbound',true)
    const [c]=await tx.execute<InboundConnection>(sql`SELECT ${connectionColumns} FROM inbound_connection WHERE id=${id}::uuid FOR UPDATE`)
    if(c.provider_account!==input.providerAccount&&(await tx.execute(sql`SELECT 1 FROM inbound_message WHERE inbound_connection_id=${id}::uuid LIMIT 1`)).length)throw new IntegrationError('BINDING','A server with received messages cannot be reassigned. Keep its historical binding.',409)
    const newBinding=!c.binding_attached||c.recipient_base!==input.recipientBase.toLowerCase()
    if(newBinding&&(!input.username||!input.password))throw new IntegrationError('CREDENTIAL','Re-enter credentials when binding a restored or different inbound address.')
    if(enabled){publicPaymentOrigin();if(process.env.INBOUND_MAIL_ENABLED!=='true'||process.env.POSTMARK_INGRESS_IP_FILTER_CONFIGURED!=='true')throw new IntegrationError('INGRESS','Enable inbound mail only after configuring HTTPS, Basic Auth and a deployment IP allowlist.',503)}
    await tx.execute(sql`UPDATE inbound_connection SET provider_account=${input.providerAccount},recipient_base=${input.recipientBase.toLowerCase()},
      alias_address=${rotate||newBinding?alias(input.recipientBase):c.alias_address},username_ciphertext=${input.username?sealIntegration(input.username,id,'postmark-user'):c.username_ciphertext},
      password_ciphertext=${input.password?sealIntegration(input.password,id,'postmark-password'):c.password_ciphertext},enabled=${enabled},binding_attached=true,authorized_by=${s.userId}::uuid,version=version+1 WHERE id=${id}::uuid`)
    await integrationAudit(tx,s,'inbound_config_saved','inbound_connection',id,{enabled,aliasRotated:rotate||newBinding})
    return {id}
  })
}
export async function inboundOverview(ledgerId:string,actor:AutomationActor){
  return db.transaction(async tx=>{
    const s=await integrationScope(tx,ledgerId,actor,'inbound')
    const [connection]=await tx.execute(sql`SELECT id::text,provider_account,recipient_base,alias_address,enabled,binding_attached,version::text,username_ciphertext IS NOT NULL AS has_username,password_ciphertext IS NOT NULL AS has_password FROM inbound_connection WHERE ledger_id=${ledgerId}::uuid`)
    const messages=await tx.execute(sql`SELECT m.id::text,m.provider_message_id,m.sender,m.subject,m.status,m.note,m.received_at::text,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'status',a.status,'reason',a.reason,'inboxId',a.inbox_item_id,'downloadable',a.sha256 IS NOT NULL) ORDER BY a.attachment_no) FROM inbound_attachment a WHERE a.inbound_message_id=m.id),'[]'::jsonb) AS attachments
      FROM inbound_message m WHERE m.ledger_id=${ledgerId}::uuid ORDER BY m.received_at DESC,m.id LIMIT 100`)
    return {connection:connection??null,messages,canConfigure:s.kind!=='user'}
  })
}
function equalSecret(a:string,b:string){const left=createHash('sha256').update(a).digest(),right=createHash('sha256').update(b).digest();return timingSafeEqual(left,right)}
async function authenticate(id:string,authorization:string|null){
  if(!integrationId(id)||!authorization||authorization.length>1000||!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization))throw new IntegrationError('AUTH','Invalid inbound delivery.',403)
  const [c]=await db.execute<InboundConnection>(sql`SELECT ${connectionColumns} FROM inbound_connection WHERE id=${id}::uuid`)
  if(!c?.binding_attached)throw new IntegrationError('AUTH','Invalid inbound delivery.',403)
  const value=Buffer.from(authorization.slice(6),'base64').toString('utf8'),separator=value.indexOf(':')
  if(separator<0||!equalSecret(value.slice(0,separator),openIntegration(c.username_ciphertext,id,'postmark-user'))||!equalSecret(value.slice(separator+1),openIntegration(c.password_ciphertext,id,'postmark-password')))
    throw new IntegrationError('AUTH','Invalid inbound delivery.',403)
  return c
}
type MailFile={index:number;name:string;mime:string;size:number;bytes:Buffer|null;sha:string|null;pages:number;status:'received'|'ignored'|'rejected';reason:string}
const bounded=(v:unknown,max:number)=>typeof v==='string'?v.slice(0,max):''
/** Strict bounded payload; HTML and URLs are deliberately never fetched or rendered. */
export async function receivePostmark(id:string,authorization:string|null,body:Buffer){
  const c=await authenticate(id,authorization)
  if(!body.length||body.length>9*1024*1024)throw new IntegrationError('SIZE','Inbound delivery exceeds the 9 MiB transport limit.',413)
  let p:Record<string,unknown>;try{p=JSON.parse(body.toString('utf8'))}catch{throw new IntegrationError('PAYLOAD','Invalid inbound JSON.')}
  if(!p||typeof p!=='object'||Array.isArray(p)||typeof p.MessageID!=='string'||!/^[A-Za-z0-9._@-]{1,200}$/.test(p.MessageID)||typeof p.OriginalRecipient!=='string'||p.OriginalRecipient.length>320
    ||!Array.isArray(p.Attachments)||p.Attachments.length>10)throw new IntegrationError('PAYLOAD','Invalid inbound structure or attachment count.')
  const sourceHash=createHash('sha256').update(body).digest('hex')
  const [prior]=await db.execute<{id:string;source_hash:string}>(sql`SELECT id::text,source_hash FROM inbound_message WHERE inbound_connection_id=${id}::uuid AND provider_message_id=${p.MessageID}`)
  if(prior){if(prior.source_hash!==sourceHash)throw new IntegrationError('MESSAGE_CONFLICT','This message identifier was already received with different content.',409);return {id:prior.id,duplicate:true}}
  if(!c.enabled||process.env.INBOUND_MAIL_ENABLED!=='true'||!c.alias_address||p.OriginalRecipient.toLowerCase()!==c.alias_address.toLowerCase())throw new IntegrationError('RECIPIENT','This inbound route or alias is unavailable.',403)
  const [company]=await db.execute<{name:string}>(sql`SELECT name FROM entity WHERE id=${c.entity_id}::uuid`)
  const files:MailFile[]=[];let total=0
  for(const [index,raw] of p.Attachments.entries()){
    const a=raw&&typeof raw==='object'?raw as Record<string,unknown>:{}
    const name=bounded(a.Name,240),mime=bounded(a.ContentType,100),length=typeof a.ContentLength==='number'&&Number.isSafeInteger(a.ContentLength)&&a.ContentLength>=0&&a.ContentLength<=6*1024*1024?a.ContentLength:0
    const f:MailFile={index,name:name||'Unnamed attachment',mime:mime||'application/octet-stream',size:length,bytes:null,sha:null,pages:0,status:'rejected',reason:'Invalid attachment structure, name, encoding or declared length.'}
    files.push(f)
    if(!name||/[\\/\x00-\x1f\x7f]/.test(name)||typeof a.Content!=='string'||a.Content.length>8*1024*1024||!Number.isSafeInteger(a.ContentLength)||a.ContentLength===0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.Content))continue
    const bytes=Buffer.from(a.Content,'base64');total+=bytes.length
    if(total>6*1024*1024)throw new IntegrationError('SIZE','Decoded inbound attachments exceed the 6 MiB limit.',413)
    if(bytes.length!==a.ContentLength||bytes.toString('base64')!==a.Content)continue
    try{const verified=await validateInboxFile(name,mime,bytes);Object.assign(f,{bytes,size:bytes.length,mime:verified.mime,pages:verified.pages,sha:createHash('sha256').update(bytes).digest('hex'),status:bounded(a.ContentID,500)&&verified.mime.startsWith('image/')?'ignored':'received',reason:bounded(a.ContentID,500)&&verified.mime.startsWith('image/')?'Inline image retained as source; excluded from automatic inbox receipt.':'Review the original attachment before creating accounting.'})}
    catch{f.reason='The attachment failed current file-type, size, page-count or active-content safety checks.'}
    if(f.bytes&&f.sha)await writeBlobBytes(company.name,f.sha,f.bytes)
  }
  const sender=bounded((p.FromFull as Record<string,unknown>|undefined)?.Email??p.From,320),subject=bounded(p.Subject,500)
  const spam=Array.isArray(p.Headers)&&p.Headers.some(h=>h&&typeof h==='object'&&String(h.Name).toLowerCase()==='x-spam-status'&&/^yes/i.test(String(h.Value)))
  return db.transaction(async tx=>{
    const [current]=await tx.execute<InboundConnection>(sql`SELECT ${connectionColumns} FROM inbound_connection WHERE id=${id}::uuid FOR UPDATE`)
    const [again]=await tx.execute<{id:string;source_hash:string}>(sql`SELECT id::text,source_hash FROM inbound_message WHERE inbound_connection_id=${id}::uuid AND provider_message_id=${p.MessageID as string}`)
    if(again){if(again.source_hash!==sourceHash)throw new IntegrationError('MESSAGE_CONFLICT','Duplicate message changed content.',409);return {id:again.id,duplicate:true}}
    if(!current.enabled||!current.binding_attached||current.alias_address!==c.alias_address||current.version!==c.version)throw new IntegrationError('RECIPIENT','The inbound configuration changed during delivery.',403)
    let s:AutomationScope|null=null
    try{s=await tx.transaction(inner=>integrationScope(inner,c.ledger_id,{source:'job',userId:current.authorized_by,requestId:randomUUID()},'inbound'))}catch(error){if(!(error instanceof AutomationError)&&!(error instanceof IntegrationError))throw error}
    const [e]=await tx.execute<{name:string}>(sql`SELECT name FROM entity WHERE id=${c.entity_id}::uuid FOR SHARE`)
    if(e.name!==company.name)throw new IntegrationError('COMPANY_CHANGED','Retry this delivery after the company rename.',503)
    const accepted=files.filter(f=>f.status==='received'),status=!s||spam?'quarantined':!files.length?'empty':!accepted.length?'rejected':'received'
    const note=!s?'Company or authorizer is unavailable; files retained without inbox conversion.':spam?'Spam marker present. Manual review is required.':!files.length?'No attachments received. HTML and remote resources were not processed.':'Sender is untrusted input. Review each original; no accounting or supplier was created.'
    const [message]=await tx.execute<{id:string}>(sql`INSERT INTO inbound_message(entity_id,ledger_id,inbound_connection_id,provider_message_id,provider_account,source_hash,sender,subject,recipient,sent_at,spam,status,note)
      VALUES(${c.entity_id}::uuid,${c.ledger_id}::uuid,${id}::uuid,${p.MessageID as string},${c.provider_account},${sourceHash},${sender},${subject},${p.OriginalRecipient as string},${bounded(p.Date,100)||null},${spam},${status},${note}) RETURNING id::text`)
    for(const f of files){
      let inboxId:string|null=null
      if(f.sha)await tx.execute(sql`INSERT INTO attachment_blob(sha256,byte_size,mime,created_by) VALUES(${f.sha},${f.size},${f.mime},'postmark verified delivery') ON CONFLICT(sha256) DO NOTHING`)
      if(s&&f.status==='received')inboxId=(await persistInboxReceipt(tx,s,{name:f.name,mime:f.mime,sha256:f.sha!,byteSize:f.size,pages:f.pages},false)).id
      await tx.execute(sql`INSERT INTO inbound_attachment(entity_id,ledger_id,inbound_message_id,attachment_no,filename,mime,byte_count,sha256,status,reason,inbox_item_id)
        VALUES(${c.entity_id}::uuid,${c.ledger_id}::uuid,${message.id}::uuid,${f.index},${f.name},${f.mime},${f.size},${f.sha},${f.status},${f.reason},${inboxId}::uuid)`)
    }
    await deliveryAudit(tx,c,'postmark','inbound_received','inbound_message',message.id,{status,attachmentCount:files.length})
    return {id:message.id,duplicate:false}
  })
}
export async function inboundFile(ledgerId:string,id:string,actor:AutomationActor){
  const file=await db.transaction(async tx=>{
    const s=await integrationScope(tx,ledgerId,actor,'inbound')
    const [a]=await tx.execute<{sha256:string;filename:string;mime:string}>(sql`SELECT sha256,filename,mime FROM inbound_attachment WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid AND sha256 IS NOT NULL`)
    if(!a)throw new IntegrationError('FILE','This source attachment is unavailable.',404)
    return {...a,company:s.name}
  })
  const bytes=await readBlobBytes(file.company,file.sha256)
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new IntegrationError('FILE','Restore the missing or damaged source file.',409)
  return {bytes,name:file.filename,mime:file.mime}
}

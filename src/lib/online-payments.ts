import 'server-only'
import {randomUUID,createHash} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import {withDocumentWrite} from './edit-leases'
import type {EditContext} from './edit-proof'
import {validTimezone,type AutomationActor} from './automation-access'
import {integrationScope,integrationAudit,deliveryAudit,IntegrationError,integrationId,integrationActor} from './integration-access'
import {connectionById,paymentConnectionColumns,sealIntegration,stripeClient,providerCall,verifyStripeBody,assertCurrentPaymentMapping,type PaymentConnection,type StripeSnapshot} from './payment-provider'
import {portalScope,publicPaymentOrigin} from './customer-portal'
import {checkoutColumns,type CheckoutRequest} from './online-payment-types'
import {openItemsQuery} from './payments'
import { lockFinanceResource } from './module-extensions'

export type PaymentSettings={mode:'test'|'live';clearingId:string;feeId:string;bankId:string;timezone:string;key:string;webhook:string}
function settings(input:PaymentSettings){
  if(!['test','live'].includes(input.mode)||![input.clearingId,input.feeId].every(integrationId)||(input.bankId&&!integrationId(input.bankId)))throw new IntegrationError('SETTINGS','Choose valid account mappings and a test/live mode.')
  validTimezone(input.timezone)
  if(input.key&&!new RegExp(`^(sk|rk)_${input.mode}_[A-Za-z0-9]+$`).test(input.key))throw new IntegrationError('KEY','The secret key must match the chosen mode.')
  if(input.webhook&&!/^whsec_[A-Za-z0-9]+$/.test(input.webhook))throw new IntegrationError('KEY','Enter the endpoint signing secret.')
}
export async function createPaymentConnection(ledgerId:string,actor:AutomationActor,input:PaymentSettings){
  settings(input);const id=randomUUID()
  const key=input.key?sealIntegration(input.key,id,'stripe-key'):null,webhook=input.webhook?sealIntegration(input.webhook,id,'stripe-webhook'):null
  return db.transaction(async tx=>{
    const s=await integrationScope(tx,ledgerId,actor,'payment',true)
    if(s.currency!=='CAD')throw new IntegrationError('CURRENCY','Online payments currently require a CAD ledger.')
    await tx.execute(sql`INSERT INTO payment_connection(id,entity_id,ledger_id,authorized_by,mode,clearing_account_id,fee_account_id,bank_account_id,timezone,key_ciphertext,webhook_ciphertext)
      VALUES(${id}::uuid,${s.entity_id}::uuid,${ledgerId}::uuid,${s.userId}::uuid,${input.mode},${input.clearingId}::uuid,${input.feeId}::uuid,${input.bankId||null}::uuid,${input.timezone},${key},${webhook})`)
    await integrationAudit(tx,s,'payment_config_created','payment_connection',id,{mode:input.mode})
    return {id}
  })
}
export async function savePaymentConnection(ledgerId:string,id:string,context:EditContext,input:PaymentSettings){
  settings(input)
  return withDocumentWrite({ledgerId,type:'payment',id},context,async tx=>{
    const s=await integrationScope(tx,ledgerId,integrationActor(context.sessionToken),'payment',true)
    const [c]=await tx.execute<PaymentConnection>(sql`SELECT ${paymentConnectionColumns} FROM payment_connection WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid FOR UPDATE`)
    if(c.mode!==input.mode&&!input.key)throw new IntegrationError('KEY','Enter a new key when changing test/live mode.')
    await tx.execute(sql`UPDATE payment_connection SET mode=${input.mode},clearing_account_id=${input.clearingId}::uuid,fee_account_id=${input.feeId}::uuid,bank_account_id=${input.bankId||null}::uuid,
      timezone=${input.timezone},key_ciphertext=${input.key?sealIntegration(input.key,id,'stripe-key'):c.key_ciphertext},webhook_ciphertext=${input.webhook?sealIntegration(input.webhook,id,'stripe-webhook'):c.webhook_ciphertext},
      enabled=false,verified_at=NULL,authorized_by=${s.userId}::uuid,version=version+1 WHERE id=${id}::uuid`)
    await integrationAudit(tx,s,'payment_config_saved','payment_connection',id,{mode:input.mode,enabled:false})
    return {id}
  })
}
/** Read authorization before I/O, then recheck the same version and lease before binding. */
export async function verifyPaymentConnection(ledgerId:string,id:string,context:EditContext){
  await db.transaction(tx=>integrationScope(tx,ledgerId,integrationActor(context.sessionToken),'payment',true))
  const c=await connectionById(id)
  if(c.ledger_id!==ledgerId||c.version!==context.proof.version)throw new IntegrationError('STALE','Reload the current connection before verifying.',409)
  // Restored bindings remain inert until this actual merchant read succeeds.
  const client=stripeClient({...c,binding_attached:true})
  const account=await providerCall(()=>client.accounts.retrieve(null))
  if(!/^acct_[A-Za-z0-9]+$/.test(account.id)||account.default_currency?.toUpperCase()!=='CAD'||!account.charges_enabled)
    throw new IntegrationError('MERCHANT','This account must accept card payments and settle in CAD.',409)
  return withDocumentWrite({ledgerId,type:'payment',id},context,async tx=>{
    const s=await integrationScope(tx,ledgerId,integrationActor(context.sessionToken),'payment',true)
    await tx.execute(sql`UPDATE payment_connection SET stripe_account_id=${account.id},binding_attached=true,verified_at=clock_timestamp(),enabled=false,
      authorized_by=${s.userId}::uuid,version=version+1 WHERE id=${id}::uuid`)
    await integrationAudit(tx,s,'payment_merchant_verified','payment_connection',id,{account:account.id,mode:c.mode})
    return {id}
  })
}
async function paymentHealth(tx:Tx,c:PaymentConnection){
  publicPaymentOrigin()
  await assertCurrentPaymentMapping(tx,c)
  if(process.env.ONLINE_PAYMENTS_ENABLED!=='true'||process.env.AUTOMATION_ENABLED!=='true'||!c.verified_at||!c.binding_attached||!c.key_ciphertext||!c.webhook_ciphertext||!c.stripe_account_id)
    throw new IntegrationError('PAYMENT_PAUSED','Online payments are unavailable; contact the invoice sender.',503)
  await integrationScope(tx,c.ledger_id,{source:'job',userId:c.authorized_by,requestId:randomUUID()},'payment')
  if(!(await tx.execute(sql`SELECT 1 FROM automation_setting WHERE entity_id=${c.entity_id}::uuid AND enabled FOR SHARE`)).length
    ||!(await tx.execute(sql`SELECT 1 FROM automation_worker WHERE heartbeat_at>clock_timestamp()-interval '120 seconds' LIMIT 1`)).length)
    throw new IntegrationError('WORKER','Payments require an enabled company and a healthy worker.',503)
  const [ledger]=await tx.execute<{currency:string}>(sql`SELECT currency FROM ledger WHERE id=${c.ledger_id}::uuid`)
  if(ledger.currency!==c.currency||c.currency!=='CAD')throw new IntegrationError('CURRENCY','The merchant and ledger currencies differ.',409)
}
export async function enablePaymentConnection(ledgerId:string,id:string,context:EditContext,enabled:boolean){
  return withDocumentWrite({ledgerId,type:'payment',id},context,async tx=>{
    const s=await integrationScope(tx,ledgerId,integrationActor(context.sessionToken),'payment',true)
    const [c]=await tx.execute<PaymentConnection>(sql`SELECT ${paymentConnectionColumns} FROM payment_connection WHERE id=${id}::uuid FOR UPDATE`)
    if(enabled)await paymentHealth(tx,c)
    await tx.execute(sql`UPDATE payment_connection SET enabled=${enabled},version=version+1 WHERE id=${id}::uuid`)
    await integrationAudit(tx,s,'payment_enabled_changed','payment_connection',id,{enabled})
    return {id}
  })
}
export async function paymentOverview(ledgerId:string,actor:AutomationActor){
  return db.transaction(async tx=>{
    const s=await integrationScope(tx,ledgerId,actor,'payment')
    const [connection]=await tx.execute(sql`SELECT id::text,mode,currency,stripe_account_id,clearing_account_id::text,fee_account_id::text,bank_account_id::text,timezone,enabled,binding_attached,verified_at::text,version::text,
      key_ciphertext IS NOT NULL AS has_key,webhook_ciphertext IS NOT NULL AS has_webhook FROM payment_connection WHERE ledger_id=${ledgerId}::uuid`)
    const transactions=await tx.execute(sql`SELECT id::text,kind,provider_object_id,amount::text,currency,occurred_at::text,status,entry_id::text,review_reason FROM processor_transaction WHERE ledger_id=${ledgerId}::uuid ORDER BY occurred_at DESC,id LIMIT 100`)
    const jobs=await tx.execute(sql`SELECT j.id::text,j.status,j.last_error FROM background_job j WHERE j.ledger_id=${ledgerId}::uuid AND j.job_type='payment_event' ORDER BY j.created_at DESC LIMIT 50`)
    return {connection:connection??null,transactions,jobs,canConfigure:s.kind!=='user'}
  })
}
export async function persistPaymentEvent(c:PaymentConnection,snapshot:StripeSnapshot,sourceHash:string,source:'webhook'|'reconcile'='webhook'){
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'stripe-event:'+c.stripe_account_id+':'+c.mode+':'+snapshot.id},0))`)
    // Do not require enabled or current ERP access: authentic money survives revocation/archival.
    const [current]=await tx.execute<PaymentConnection>(sql`SELECT ${paymentConnectionColumns} FROM payment_connection WHERE id=${c.id}::uuid FOR SHARE`)
    if(!current.binding_attached||current.stripe_account_id!==c.stripe_account_id||current.mode!==snapshot.mode)throw new IntegrationError('BINDING','This merchant binding is no longer available.',409)
    const [event]=await tx.execute<{id:string}>(sql`INSERT INTO payment_event(entity_id,ledger_id,payment_connection_id,stripe_account_id,mode,provider_event_id,event_type,provider_object_id,api_version,snapshot,source_hash)
      VALUES(${c.entity_id}::uuid,${c.ledger_id}::uuid,${c.id}::uuid,${c.stripe_account_id},${snapshot.mode},${snapshot.id},${snapshot.type},${snapshot.objectId},${snapshot.apiVersion},${JSON.stringify(snapshot)}::jsonb,${sourceHash})
      ON CONFLICT(payment_connection_id,provider_event_id) DO NOTHING RETURNING id::text`)
    if(!event){
      const [prior]=await tx.execute<{id:string;snapshot:StripeSnapshot}>(sql`SELECT id::text,snapshot FROM payment_event WHERE payment_connection_id=${c.id}::uuid AND provider_event_id=${snapshot.id}`)
      // API pulls and signed deliveries may serialize differently; the retained minimal fact must agree.
      if(JSON.stringify(prior.snapshot)!==JSON.stringify(snapshot)){
        // JSONB key order is not JS insertion order.
        const [same]=await tx.execute(sql`SELECT 1 FROM payment_event WHERE id=${prior.id}::uuid AND snapshot=${JSON.stringify(snapshot)}::jsonb`)
        if(!same)throw new IntegrationError('EVENT_CONFLICT','This event identifier was already retained with different facts.',409)
      }
      return {id:prior.id,duplicate:true}
    }
    await tx.execute(sql`INSERT INTO background_job(entity_id,ledger_id,actor_user_id,request_id,job_type,dedupe_key,payment_event_id)
      VALUES(${c.entity_id}::uuid,${c.ledger_id}::uuid,${current.authorized_by}::uuid,${randomUUID()}::uuid,'payment_event',${'stripe:'+snapshot.id},${event.id}::uuid)`)
    await deliveryAudit(tx,c,'stripe','payment_event_received','payment_event',event.id,{eventId:snapshot.id,eventType:snapshot.type,source})
    return {id:event.id,duplicate:false}
  })
}
export async function receiveStripe(id:string,body:Buffer,signature:string|null){
  const c=await connectionById(id),snapshot=verifyStripeBody(c,body,signature)
  return persistPaymentEvent(c,snapshot,createHash('sha256').update(body).digest('hex'))
}
/** A single saved quote survives unknown API outcomes through Stripe's original idempotency key. */
export async function reserveCheckout(invitationId:string,sessionToken:string){
  return db.transaction(async tx=>{
    const p=await portalScope(sessionToken,invitationId,tx)
    await lockFinanceResource(tx,'invoice',p.invoice_id)
    const [invoice]=await tx.execute<{version:string;status:string;fx_currency:string|null}>(sql`SELECT version::text,status,fx_currency FROM invoice WHERE id=${p.invoice_id}::uuid FOR UPDATE`)
    if(invoice.fx_currency)throw new IntegrationError('CURRENCY','Online checkout currently accepts CAD invoices only. Contact the sender to arrange foreign settlement.',409)
    const [c]=await tx.execute<PaymentConnection>(sql`SELECT ${paymentConnectionColumns} FROM payment_connection WHERE ledger_id=${p.ledger_id}::uuid FOR SHARE`)
    if(!c?.enabled||invoice.status!=='posted')throw new IntegrationError('PAYMENT_PAUSED','This invoice cannot currently accept online payments.',409)
    await paymentHealth(tx,c)
    if((await tx.execute(sql`SELECT 1 FROM checkout_request WHERE invoice_id=${p.invoice_id}::uuid AND status='needs_accounting_review' UNION ALL SELECT 1 FROM processor_transaction WHERE invoice_id=${p.invoice_id}::uuid AND (kind IN ('refund','dispute') OR status='needs_accounting_review') LIMIT 1`)).length)throw new IntegrationError('REVIEW','This invoice has a payment, refund or dispute under review. Contact its sender before paying again.',409)
    const [due]=await tx.execute<{balance:string}>(sql`SELECT balance::text FROM (${openItemsQuery(sql`AND i.id=${p.invoice_id}::uuid`)}) d`)
    if(!due||BigInt(due.balance)<=0n||BigInt(due.balance)>99999999n)throw new IntegrationError('BALANCE','This invoice has no supported unpaid balance.',409)
    const [prior]=await tx.execute<CheckoutRequest>(sql`SELECT ${sql.raw(checkoutColumns)} FROM checkout_request WHERE invoice_id=${p.invoice_id}::uuid AND status IN ('creating','open') FOR UPDATE`)
    if(prior){
      if(prior.invoice_version!==invoice.version||prior.expected_amount!==due.balance||(prior.expires_at&&new Date(prior.expires_at)<=new Date())){
        await tx.execute(sql`UPDATE checkout_request SET status=${prior.status==='creating'&&!prior.stripe_checkout_id?'needs_accounting_review':'invalidated'},checkout_url=NULL,updated_at=clock_timestamp() WHERE id=${prior.id}::uuid`)
        return {c,r:prior,stale:true}
      }
      return {c,r:prior,stale:false}
    }
    const id=randomUUID()
    const [r]=await tx.execute<CheckoutRequest>(sql`INSERT INTO checkout_request(id,entity_id,ledger_id,payment_connection_id,invoice_id,party_id,invoice_fingerprint,invoice_version,expected_amount,currency,stripe_account_id,mode,source_request_key)
      VALUES(${id}::uuid,${p.entity_id}::uuid,${p.ledger_id}::uuid,${c.id}::uuid,${p.invoice_id}::uuid,${p.party_id}::uuid,p5_invoice_fingerprint(${p.invoice_id}::uuid),${invoice.version}::bigint,${due.balance}::bigint,${c.currency},${c.stripe_account_id},${c.mode},${id}) RETURNING ${sql.raw(checkoutColumns)}`)
    return {c,r,stale:false}
  })
}
export async function startCheckout(invitationId:string,sessionToken:string){
  const reserved=await reserveCheckout(invitationId,sessionToken)
  const {c,r}=reserved,client=stripeClient(c),origin=publicPaymentOrigin()
  if(reserved.stale){
    if(r.stripe_checkout_id)await providerCall(()=>client.checkout.sessions.expire(r.stripe_checkout_id!))
    throw new IntegrationError('QUOTE_CHANGED','The invoice changed. Refresh it before creating a new payment request.',409)
  }
  if(r.status==='open'&&r.checkout_url&&r.expires_at&&new Date(r.expires_at)>new Date())return {url:r.checkout_url}
  if(Date.now()-new Date(r.created_at).getTime()>23*60*60*1000){
    // Stripe idempotency retention is bounded; an unknown old request cannot be recreated safely.
    await db.execute(sql`UPDATE checkout_request SET status='needs_accounting_review',checkout_url=NULL,last_error='Unknown or expired creation requires provider reconciliation.' WHERE id=${r.id}::uuid AND status IN ('creating','open')`)
    throw new IntegrationError('UNKNOWN_CHECKOUT','Reconcile this saved request before retrying payment.',409)
  }
  const checkout=await providerCall(()=>client.checkout.sessions.create({mode:'payment',allowed_payment_method_types:['card'],client_reference_id:r.source_request_key,
    metadata:{figtree_request:r.source_request_key},payment_intent_data:{metadata:{figtree_request:r.source_request_key}},
    adaptive_pricing:{enabled:false},allow_promotion_codes:false,automatic_tax:{enabled:false},line_items:[{quantity:1,price_data:{currency:'cad',unit_amount:Number(r.expected_amount),product_data:{name:'Invoice payment'}}}],
    success_url:origin+'/pay/'+invitationId,cancel_url:origin+'/pay/'+invitationId}, {idempotencyKey:'figtree-checkout-'+r.source_request_key}))
  if(!checkout.url||new URL(checkout.url).origin!=='https://checkout.stripe.com'||checkout.livemode!==(c.mode==='live'))throw new IntegrationError('CHECKOUT','The provider returned an unsupported Checkout result.',409)
  const valid=await db.transaction(async tx=>{
    await portalScope(sessionToken,invitationId,tx);await lockFinanceResource(tx,'invoice',r.invoice_id)
    const [invoice]=await tx.execute<{version:string;status:string}>(sql`SELECT version::text,status FROM invoice WHERE id=${r.invoice_id}::uuid FOR UPDATE`)
    const [due]=await tx.execute<{balance:string}>(sql`SELECT balance::text FROM (${openItemsQuery(sql`AND i.id=${r.invoice_id}::uuid`)}) d`)
    const good=invoice.status==='posted'&&invoice.version===r.invoice_version&&due?.balance===r.expected_amount
    const [updated]=await tx.execute(sql`UPDATE checkout_request SET stripe_checkout_id=${checkout.id},payment_intent_id=${typeof checkout.payment_intent==='string'?checkout.payment_intent:null},checkout_url=${good?checkout.url:null},
      expires_at=to_timestamp(${checkout.expires_at}),status=${good?'open':'invalidated'},updated_at=clock_timestamp() WHERE id=${r.id}::uuid AND status IN ('creating','open') RETURNING id`)
    return good&&!!updated
  })
  if(!valid){await providerCall(()=>client.checkout.sessions.expire(checkout.id));throw new IntegrationError('QUOTE_CHANGED','The invoice changed during payment setup. Refresh it.',409)}
  return {url:checkout.url}
}

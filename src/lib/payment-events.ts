import 'server-only'
import {createHash} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {connectionById,stripeClient,providerCall,providerObjectId,providerCents,minimizeStripeEvent,type StripeSnapshot} from './payment-provider'
import {receiptEvidence,checkoutColumns,providerInstant,type CheckoutRequest} from './online-payment-types'
import {persistPaymentEvent} from './online-payments'
import {accountReceipt,retainProcessorFact,accountProcessorMovement} from './processor-ledger'
import {integrationScope,integrationAudit,IntegrationError,integrationId} from './integration-access'
import {jobActor,lockClaim,completeJob,workerHeartbeat,type Job} from './jobs'
import type {AutomationActor} from './automation-access'

/** Invalidated quote rows are a durable cancellation queue. Provider I/O holds no financial locks. */
export async function expireInvalidatedCheckouts(max=12,workerId:string){
  const rows=await db.execute<CheckoutRequest>(sql`SELECT ${sql.raw(checkoutColumns)} FROM checkout_request
    WHERE status='invalidated' AND stripe_checkout_id IS NOT NULL ORDER BY created_at LIMIT ${max}`)
  let expired=0,deferred=0
  for(const r of rows){
    await workerHeartbeat(workerId)
    try{
      const {c,client}=await merchantClient(r.payment_connection_id)
      const session=await providerCall(()=>client.checkout.sessions.retrieve(r.stripe_checkout_id!))
      if(session.id!==r.stripe_checkout_id||session.livemode!==(c.mode==='live')||session.client_reference_id!==r.source_request_key)throw new IntegrationError('BINDING','The invalidated session does not match its original binding.',409)
      if(session.status==='open')await providerCall(()=>client.checkout.sessions.expire(session.id))
      if(session.status==='complete'){
        await processCurrentEvent(c.id,null,{type:'checkout.session.completed',objectId:session.id},
          {source:'job',userId:c.authorized_by??'00000000-0000-4000-8000-000000000000',workerId,requestId:r.source_request_key})
      }else{
        await db.execute(sql`UPDATE checkout_request SET status='expired',checkout_url=NULL WHERE id=${r.id}::uuid AND status='invalidated'`)
        expired++
      }
    }catch{deferred++} // Retain the durable invalidated row; the next bounded batch retries.
    await workerHeartbeat(workerId)
  }
  return {expired,deferred}
}

async function merchantClient(id:string){
  const c=await connectionById(id),client=stripeClient(c)
  const merchant=await providerCall(()=>client.accounts.retrieve(null))
  if(merchant.id!==c.stripe_account_id||merchant.default_currency?.toUpperCase()!==c.currency)throw new IntegrationError('BINDING','The current credential belongs to a different merchant or currency.',409)
  return {c,client}
}
/** Worker/API I/O occurs outside financial transactions; event arrival order has no accounting authority. */
async function processCurrentEvent(connectionId:string,eventId:string|null,snapshot:Pick<StripeSnapshot,'type'|'objectId'>,actor:AutomationActor,claim?:Job){
  const {c,client}=await merchantClient(connectionId)
  let piId:string|null=null,sessionId:string|null=null
  if(snapshot.type.startsWith('checkout.session.')){
    const session=await providerCall(()=>client.checkout.sessions.retrieve(snapshot.objectId))
    if(session.livemode!==(c.mode==='live'))throw new IntegrationError('MODE','This Checkout belongs to another mode.',409)
    if(session.status==='expired'){
      await db.execute(sql`UPDATE checkout_request SET status='expired',checkout_url=NULL WHERE payment_connection_id=${c.id}::uuid AND stripe_checkout_id=${session.id} AND status IN ('creating','open')`)
      return {status:'expired'}
    }
    sessionId=session.id;piId=providerObjectId(session.payment_intent)
  }else if(snapshot.type==='payment_intent.succeeded')piId=snapshot.objectId
  else if(snapshot.type.startsWith('payout.')){
    const payout=await providerCall(()=>client.payouts.retrieve(snapshot.objectId))
    if(payout.livemode!==(c.mode==='live'))throw new IntegrationError('MODE','This payout belongs to another mode.',409)
    const fact=await retainProcessorFact(c,eventId,null,{kind:'payout',objectId:payout.id,payoutId:payout.id,amount:providerCents(payout.amount,true),currency:payout.currency.toUpperCase(),occurredAt:providerInstant(payout.arrival_date),
      balanceId:providerObjectId(payout.balance_transaction),details:{providerStatus:payout.status,method:payout.method},reason:'Confirm this current provider payout against the bank before posting.'})
    return {id:fact.id,status:fact.status}
  }else if(snapshot.type.startsWith('refund.')||snapshot.type==='charge.refunded'||snapshot.type.startsWith('charge.dispute.')){
    let chargeId:string|null=null
    if(snapshot.type.startsWith('refund.')){const refund=await providerCall(()=>client.refunds.retrieve(snapshot.objectId));chargeId=providerObjectId(refund.charge)}
    else if(snapshot.type==='charge.refunded')chargeId=snapshot.objectId
    else{const dispute=await providerCall(()=>client.disputes.retrieve(snapshot.objectId));chargeId=providerObjectId(dispute.charge)}
    if(!chargeId)throw new IntegrationError('CHARGE','This economic event has no bound charge.',409)
    const charge=await providerCall(()=>client.charges.retrieve(chargeId!))
    if(charge.livemode!==(c.mode==='live'))throw new IntegrationError('MODE','This charge belongs to another mode.',409)
    piId=providerObjectId(charge.payment_intent)
    const [r]=await db.execute<CheckoutRequest>(sql`SELECT ${sql.raw(checkoutColumns)} FROM checkout_request WHERE payment_connection_id=${c.id}::uuid AND payment_intent_id=${piId}`)
    // Unknown external objects are retained in the minimal signed event, never assigned by metadata alone.
    if(!r)return {status:'needs_accounting_review',reason:'No saved Checkout binds this external economic event.'}
    if(snapshot.type.startsWith('charge.dispute.')){
      const dispute=await providerCall(()=>client.disputes.retrieve(snapshot.objectId))
      const fact=await retainProcessorFact(c,eventId,r,{kind:'dispute',objectId:dispute.id,paymentIntentId:piId!,amount:providerCents(dispute.amount,true),currency:dispute.currency.toUpperCase(),occurredAt:providerInstant(dispute.created),
        details:{providerStatus:dispute.status,chargeId,balanceTransactions:dispute.balance_transactions.map(b=>({id:b.id,amount:String(b.amount),fee:String(b.fee),net:String(b.net),currency:b.currency}))},
        reason:'A dispute is not a final loss. Review current provider fund movements and use existing accounting controls.'})
      const movements=dispute.balance_transactions.map(b=>({id:b.id,amount:String(b.amount),fee:String(b.fee),net:String(b.net),currency:b.currency}))
      await db.transaction(async tx=>{
        if(claim)await lockClaim(tx,claim)
        const scope=await integrationScope(tx,c.ledger_id,actor,'payment')
        await integrationAudit(tx,scope,'processor_dispute_observed','processor_transaction',fact.id,{providerStatus:dispute.status,balanceTransactions:movements})
        await tx.execute(sql`UPDATE processor_transaction SET review_reason=${'Current provider dispute status: '+dispute.status+'. Retrieved '+String(new Date())+'. Balance movements: '+JSON.stringify(movements)+'. No final loss was inferred.'} WHERE id=${fact.id}::uuid`)
      })
      return {id:fact.id,status:fact.status,currentProviderStatus:dispute.status}
    }
    const refunds=await providerCall(()=>client.refunds.list({charge:chargeId!,limit:100}))
    if(refunds.has_more)throw new IntegrationError('REFUNDS','More refunds exist than this bounded pull can reconcile. Review the provider account.',409)
    const facts=[]
    for(const refund of refunds.data){
      if(refund.status!=='succeeded')continue
      const balanceId=providerObjectId(refund.balance_transaction)
      if(!balanceId)throw new IntegrationError('REFUND_BALANCE','A succeeded refund has no confirmed processor balance transaction.',409)
      const balance=await providerCall(()=>client.balanceTransactions.retrieve(balanceId))
      const amount=providerCents(refund.amount,true)
      if(!Number.isSafeInteger(balance.fee)||!Number.isSafeInteger(balance.net)||providerObjectId(balance.source)!==refund.id||balance.amount!==-Number(amount)||balance.net!==balance.amount-balance.fee||balance.currency!==refund.currency)throw new IntegrationError('REFUND_BALANCE','The refund and processor fund movement disagree.',409)
      facts.push(await retainProcessorFact(c,eventId,r,{kind:'refund',objectId:refund.id,paymentIntentId:piId!,balanceId,amount,currency:refund.currency.toUpperCase(),occurredAt:providerInstant(balance.created),
        details:{providerStatus:refund.status,chargeId,providerFee:String(balance.fee),providerNet:String(balance.net),exchangeRate:balance.exchange_rate,feeDetails:balance.fee_details.map(d=>({type:d.type,amount:String(d.amount),currency:d.currency}))},reason:'Confirm the refund and release its original receipt allocations before accounting.'}))
    }
    return {status:'needs_accounting_review',refunds:facts.map(f=>f.id)}
  }else return {status:'retained',reason:'This signed event has no supported accounting operation.'}
  if(!piId)return {status:'awaiting_payment'}
  let [r]=await db.execute<CheckoutRequest>(sql`SELECT ${sql.raw(checkoutColumns)} FROM checkout_request WHERE payment_connection_id=${c.id}::uuid
    AND (payment_intent_id=${piId} OR (${sessionId}::text IS NOT NULL AND stripe_checkout_id=${sessionId}))`)
  if(!r){
    const sessions=await providerCall(()=>client.checkout.sessions.list({payment_intent:piId!,limit:10}))
    if(sessions.has_more)throw new IntegrationError('SESSION_BINDING','Checkout lookup is ambiguous.',409)
    for(const session of sessions.data){
      const [candidate]=await db.execute<CheckoutRequest>(sql`SELECT ${sql.raw(checkoutColumns)} FROM checkout_request WHERE payment_connection_id=${c.id}::uuid AND (stripe_checkout_id=${session.id} OR (stripe_checkout_id IS NULL AND source_request_key=${session.client_reference_id}))`)
      if(candidate){
        if(r)throw new IntegrationError('SESSION_BINDING','Several saved requests refer to this payment.',409)
        if(!candidate.stripe_checkout_id){
          if(session.livemode!==(c.mode==='live')||session.mode!=='payment'||session.currency?.toUpperCase()!==candidate.currency||providerCents(session.amount_total,true)!==BigInt(candidate.expected_amount))continue
          await db.execute(sql`UPDATE checkout_request SET stripe_checkout_id=${session.id},payment_intent_id=${piId},checkout_url=NULL WHERE id=${candidate.id}::uuid AND stripe_checkout_id IS NULL`)
          r={...candidate,stripe_checkout_id:session.id,payment_intent_id:piId}
        }else r=candidate
      }
    }
  }
  if(!r||!r.stripe_checkout_id){
    const pi=await providerCall(()=>client.paymentIntents.retrieve(piId!)),chargeId=providerObjectId(pi.latest_charge)
    if(pi.status!=='succeeded'||!chargeId||pi.livemode!==(c.mode==='live'))return {status:'needs_accounting_review',reason:'No captured payment and saved Checkout binding was confirmed.'}
    const charge=await providerCall(()=>client.charges.retrieve(chargeId))
    if(!charge.paid||!charge.captured||charge.status!=='succeeded'||charge.livemode!==pi.livemode||providerObjectId(charge.payment_intent)!==pi.id)throw new IntegrationError('CHARGE','The current unbound payment graph cannot confirm captured funds.',409)
    const fact=await retainProcessorFact(c,eventId,null,{kind:'receipt',objectId:pi.id,paymentIntentId:pi.id,amount:providerCents(pi.amount_received,true),currency:pi.currency.toUpperCase(),occurredAt:providerInstant(charge.created),balanceId:providerObjectId(charge.balance_transaction),details:{chargeId:charge.id,unbound:true},reason:'Actual captured funds have no saved Checkout binding. Reconcile their original request and customer before accounting.'})
    return {id:fact.id,status:'needs_accounting_review',reason:fact.review_reason}
  }
  const session=await providerCall(()=>client.checkout.sessions.retrieve(r.stripe_checkout_id!))
  const pi=await providerCall(()=>client.paymentIntents.retrieve(piId!)),chargeId=providerObjectId(pi.latest_charge)
  if(!chargeId)throw new IntegrationError('CHARGE','The current payment has no captured charge.',409)
  const charge=await providerCall(()=>client.charges.retrieve(chargeId)),balanceId=providerObjectId(charge.balance_transaction)
  const balance=balanceId?await providerCall(()=>client.balanceTransactions.retrieve(balanceId)):null
  const evidence=receiptEvidence(c,r,session,pi,charge,balance)
  return accountReceipt(c,eventId,r,evidence,actor,claim)
}
export async function runPaymentEvent(j:Job){
  if(!j.payment_event_id)throw new IntegrationError('EVENT','This task has no payment event.',409)
  const [e]=await db.execute<{payment_connection_id:string;snapshot:StripeSnapshot;detached:boolean}>(sql`SELECT payment_connection_id::text,snapshot,detached FROM payment_event WHERE id=${j.payment_event_id}::uuid AND ledger_id=${j.ledger_id}::uuid`)
  if(!e||e.detached)throw new IntegrationError('DETACHED','Review and reverify this restored payment event before processing.',409)
  await db.transaction(tx=>lockClaim(tx,j))
  const result=await processCurrentEvent(e.payment_connection_id,j.payment_event_id,e.snapshot,jobActor(j),j)
  await db.transaction(tx=>completeJob(tx,j,result,result.status==='needs_accounting_review'?'paused':'succeeded'))
  return result
}
export async function reconcileStripeEvent(ledgerId:string,connectionId:string,eventId:string,actor:AutomationActor){
  if(!integrationId(connectionId)||!/^evt_[A-Za-z0-9]+$/.test(eventId))throw new IntegrationError('EVENT','Enter a Stripe event ID.')
  await db.transaction(tx=>integrationScope(tx,ledgerId,actor,'payment'))
  const {c,client}=await merchantClient(connectionId)
  if(c.ledger_id!==ledgerId)throw new IntegrationError('CONNECTION','Unknown company connection.',404)
  const event=await providerCall(()=>client.events.retrieve(eventId)),snapshot=minimizeStripeEvent(event,c)
  return persistPaymentEvent(c,snapshot,createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),'reconcile')
}
/** Explicit current-state retry also covers delayed/expired provider event retrieval windows. */
export async function reconcileCheckout(ledgerId:string,requestId:string,actor:AutomationActor){
  await db.transaction(tx=>integrationScope(tx,ledgerId,actor,'payment'))
  const [r]=await db.execute<CheckoutRequest>(sql`SELECT ${sql.raw(checkoutColumns)} FROM checkout_request WHERE id=${requestId}::uuid AND ledger_id=${ledgerId}::uuid`)
  if(!r?.stripe_checkout_id)throw new IntegrationError('REQUEST','This saved request needs provider lookup before it can be reconciled.',409)
  return processCurrentEvent(r.payment_connection_id,null,{type:'checkout.session.completed',objectId:r.stripe_checkout_id},actor)
}

export async function recoverCheckout(ledgerId:string,requestId:string,providerSessionId:string,actor:AutomationActor){
  await db.transaction(tx=>integrationScope(tx,ledgerId,actor,'payment'))
  if(!integrationId(requestId)||!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(providerSessionId))throw new IntegrationError('REQUEST','Enter the saved request and its provider Checkout session ID.')
  const [r]=await db.execute<CheckoutRequest>(sql`SELECT ${sql.raw(checkoutColumns)} FROM checkout_request WHERE id=${requestId}::uuid AND ledger_id=${ledgerId}::uuid`)
  if(!r)throw new IntegrationError('REQUEST','Unknown saved request.',404)
  const {c,client}=await merchantClient(r.payment_connection_id),session=await providerCall(()=>client.checkout.sessions.retrieve(providerSessionId))
  if(session.client_reference_id!==r.source_request_key||session.livemode!==(c.mode==='live')||session.mode!=='payment'||session.currency?.toUpperCase()!==r.currency||providerCents(session.amount_total,true)!==BigInt(r.expected_amount))throw new IntegrationError('BINDING','This provider session does not match the original saved quote.',409)
  await db.transaction(async tx=>{await integrationScope(tx,ledgerId,actor,'payment');await tx.execute(sql`UPDATE checkout_request SET stripe_checkout_id=${session.id},payment_intent_id=${providerObjectId(session.payment_intent)},status='needs_accounting_review',checkout_url=NULL WHERE id=${r.id}::uuid AND (stripe_checkout_id IS NULL OR stripe_checkout_id=${session.id})`)})
  return reconcileCheckout(ledgerId,requestId,actor)
}

/** Confirmation always re-reads the provider, rather than trusting an earlier event's status. */
export async function confirmProcessorMovement(ledgerId:string,id:string,actor:AutomationActor){
  await db.transaction(tx=>integrationScope(tx,ledgerId,actor,'payment'))
  const [f]=await db.execute<{payment_connection_id:string;kind:string;provider_object_id:string;amount:string;currency:string;details:Record<string,unknown>}>(sql`SELECT payment_connection_id::text,kind,provider_object_id,amount::text,currency,details FROM processor_transaction WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid AND NOT detached`)
  if(!f)throw new IntegrationError('FACT','Unknown current processor transaction.',404)
  const {client}=await merchantClient(f.payment_connection_id)
  if(f.kind==='payout'){
    const payout=await providerCall(()=>client.payouts.retrieve(f.provider_object_id))
    if(payout.status!=='paid'||providerCents(payout.amount,true)!==BigInt(f.amount)||payout.currency.toUpperCase()!==f.currency)throw new IntegrationError('PAYOUT','The current payout is not a matching paid bank transfer.',409)
  }else if(f.kind==='refund'){
    const refund=await providerCall(()=>client.refunds.retrieve(f.provider_object_id))
    if(refund.status!=='succeeded'||providerCents(refund.amount,true)!==BigInt(f.amount)||refund.currency.toUpperCase()!==f.currency)throw new IntegrationError('REFUND','The current refund does not confirm this retained amount.',409)
    const balanceId=providerObjectId(refund.balance_transaction)
    if(!balanceId)throw new IntegrationError('REFUND','No current refund fund movement was confirmed.',409)
    const balance=await providerCall(()=>client.balanceTransactions.retrieve(balanceId))
    if(String(balance.fee)!==f.details.providerFee||String(balance.net)!==f.details.providerNet||balance.exchange_rate!==null||providerObjectId(balance.source)!==refund.id)throw new IntegrationError('REFUND','The current refund fee, net or currency movement requires reconciliation.',409)
  }else if(f.kind==='fee'){
    const balance=await providerCall(()=>client.balanceTransactions.retrieve(f.provider_object_id))
    if(providerCents(balance.fee,true)!==BigInt(f.amount)||balance.currency.toUpperCase()!==f.currency)throw new IntegrationError('FEE','The current processor fee differs from the retained fact.',409)
  }else throw new IntegrationError('FACT','Reconcile receipts by saved Checkout; disputes require an explicit review of fund movements.',409)
  return accountProcessorMovement(ledgerId,id,actor)
}

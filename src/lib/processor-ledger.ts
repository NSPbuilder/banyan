import 'server-only'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import {recordPayment,applyEntryToInvoice,unapply,openItemsQuery} from './payments'
import {postEntryCore} from './posting'
import { lockFinanceResource } from './module-extensions'
import {integrationScope,integrationAudit,deliveryAudit,IntegrationError,integrationId} from './integration-access'
import {paymentConnectionColumns,assertCurrentPaymentMapping,type PaymentConnection} from './payment-provider'
import {transactionColumns,type ProcessorTransaction,type ReceiptEvidence,type CheckoutRequest} from './online-payment-types'
import {companyClock,type AutomationActor} from './automation-access'
import {lockClaim,type Job} from './jobs'

type EconomicFact={kind:ProcessorTransaction['kind'];objectId:string;amount:bigint;currency:string;occurredAt:string;paymentIntentId?:string;balanceId?:string|null;payoutId?:string;details?:Record<string,unknown>;reason?:string|null}
/** Immutable real economic amounts are retained before attempting any accounting. */
export async function retainProcessorFact(c:PaymentConnection,eventId:string|null,r:CheckoutRequest|null,input:EconomicFact){
  if(input.amount<=0n||!/^[A-Za-z][A-Za-z0-9_]{2,199}$/.test(input.objectId)||!/^[A-Z]{3}$/.test(input.currency)||!Number.isFinite(new Date(input.occurredAt).getTime()))
    throw new IntegrationError('FACT','The provider supplied an unsupported economic fact.',409)
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'stripe:'+c.stripe_account_id+':'+c.mode+':'+input.kind+':'+input.objectId},0))`)
    const [fact]=await tx.execute<ProcessorTransaction>(sql`INSERT INTO processor_transaction(entity_id,ledger_id,payment_connection_id,payment_event_id,checkout_request_id,invoice_id,stripe_account_id,mode,kind,provider_object_id,payment_intent_id,balance_transaction_id,payout_id,amount,currency,occurred_at,details,review_reason)
      VALUES(${c.entity_id}::uuid,${c.ledger_id}::uuid,${c.id}::uuid,${eventId}::uuid,${r?.id??null}::uuid,${r?.invoice_id??null}::uuid,${c.stripe_account_id},${c.mode},${input.kind},${input.objectId},${input.paymentIntentId??null},${input.balanceId??null},${input.payoutId??null},${input.amount},${input.currency},${input.occurredAt}::timestamptz,${JSON.stringify(input.details??{})}::jsonb,${input.reason??'Review current accounting before posting.'})
      ON CONFLICT(payment_connection_id,kind,provider_object_id) DO NOTHING RETURNING ${sql.raw(transactionColumns)}`)
    if(fact){await deliveryAudit(tx,c,'stripe','processor_fact_retained','processor_transaction',fact.id,{kind:input.kind,objectId:input.objectId,amount:input.amount.toString(),currency:input.currency});return fact}
    const [prior]=await tx.execute<ProcessorTransaction>(sql`SELECT ${sql.raw(transactionColumns)} FROM processor_transaction WHERE payment_connection_id=${c.id}::uuid AND kind=${input.kind} AND provider_object_id=${input.objectId}`)
    if(prior.amount!==input.amount.toString()||prior.currency!==input.currency||prior.payment_intent_id!==(input.paymentIntentId??null))
      throw new IntegrationError('FACT_CONFLICT','The provider economic object changed its retained amount or identity. Reconcile it manually.',409)
    return prior
  })
}
async function linked(tx:Tx,f:ProcessorTransaction,entryId:string,date:string,status:'posted'|'matched',reason:string|null=null){
  await tx.execute(sql`SELECT set_config('erp.processor_transaction',${f.id},true)`)
  await tx.execute(sql`UPDATE processor_transaction SET status=${status},entry_id=${entryId}::uuid,accounting_date=${date}::date,review_reason=${reason} WHERE id=${f.id}::uuid`)
}
async function retainFailure(f:ProcessorTransaction,error:unknown){
  const reason=error instanceof IntegrationError?error.message:'Current accounting or authorization refused the operation. Review the original provider date, invoice, permissions and locked period; no substitute date was used.'
  await db.transaction(async tx=>{
    await tx.execute(sql`UPDATE processor_transaction SET review_reason=${reason} WHERE id=${f.id}::uuid AND entry_id IS NULL`)
    if(f.checkout_request_id)await tx.execute(sql`UPDATE checkout_request SET status='needs_accounting_review',checkout_url=NULL,last_error=${reason} WHERE id=${f.checkout_request_id}::uuid`)
    await deliveryAudit(tx,{id:f.payment_connection_id,entity_id:f.entity_id,ledger_id:f.ledger_id},'stripe','processor_accounting_review','processor_transaction',f.id,{reason})
  })
  return {id:f.id,status:'needs_accounting_review',reason,entryId:undefined}
}
/** Tests supply parser-validated protocol fixtures; production supplies freshly retrieved Stripe objects. */
export async function accountReceipt(c:PaymentConnection,eventId:string|null,r:CheckoutRequest,e:ReceiptEvidence,actor:AutomationActor,claim?:Job){
  const fact=await retainProcessorFact(c,eventId,r,{kind:'receipt',objectId:e.paymentIntentId,paymentIntentId:e.paymentIntentId,amount:e.amount,currency:e.currency,occurredAt:e.occurredAt,balanceId:e.balanceId,
    details:{checkoutId:e.checkoutId,chargeId:e.chargeId,providerVersion:e.providerVersion,fee:e.fee?.toString()??null,net:e.net?.toString()??null},reason:e.reviewReason})
  if(fact.entry_id){
    if(e.reviewReason)return retainFailure(fact,new IntegrationError('REVIEW',e.reviewReason,409))
    if(e.fee!==null&&e.fee>0n&&e.balanceId){
      const fee=await retainProcessorFact(c,eventId,r,{kind:'fee',objectId:e.balanceId,paymentIntentId:e.paymentIntentId,balanceId:e.balanceId,amount:e.fee,currency:e.currency,occurredAt:e.occurredAt,details:{receiptId:fact.id,gross:e.amount.toString(),net:e.net?.toString()}})
      await accountProcessorMovement(c.ledger_id,fee.id,actor,claim)
    }
    return {id:fact.id,status:fact.status,entryId:fact.entry_id}
  }
  try{
    if(e.reviewReason)throw new IntegrationError('REVIEW',e.reviewReason,409)
    const result=await db.transaction(async tx=>{
      await lockFinanceResource(tx,'invoice',r.invoice_id)
      const s=await integrationScope(tx,c.ledger_id,actor,'payment')
      if(claim)await lockClaim(tx,claim)
      const [current]=await tx.execute<PaymentConnection>(sql`SELECT ${paymentConnectionColumns} FROM payment_connection WHERE id=${c.id}::uuid FOR SHARE`)
      await assertCurrentPaymentMapping(tx,current)
      if(!current.binding_attached||current.stripe_account_id!==c.stripe_account_id||current.mode!==c.mode||current.currency!==e.currency||s.currency!==e.currency)
        throw new IntegrationError('BINDING','The current merchant and ledger bindings require review.',409)
      const [i]=await tx.execute<{party_id:string;control_account_id:string;status:string;direction:string;document_kind:string;version:string}>(sql`SELECT party_id::text,control_account_id::text,status,direction,document_kind,version::text FROM invoice WHERE id=${r.invoice_id}::uuid AND ledger_id=${c.ledger_id}::uuid FOR UPDATE`)
      const [f]=await tx.execute<ProcessorTransaction>(sql`SELECT ${sql.raw(transactionColumns)} FROM processor_transaction WHERE id=${fact.id}::uuid FOR UPDATE`)
      if(f.entry_id)return {id:f.id,status:f.status,entryId:f.entry_id}
      if(!i||i.party_id!==r.party_id||i.status!=='posted'||i.direction!=='sales'||i.document_kind!=='invoice')throw new IntegrationError('INVOICE','The paid invoice is void, changed customer, or otherwise unavailable. Retain and reconcile this receipt.',409)
      const date=companyClock(current.timezone,new Date(e.occurredAt)).date
      const prior=await tx.execute<{id:string;entry_date:string;source_type:string}>(sql`SELECT id::text,entry_date::text,source_type FROM journal_entry WHERE ledger_id=${c.ledger_id}::uuid AND status='posted' AND position(${'('+e.paymentIntentId+')'} in description)>0 FOR SHARE`)
      if(prior.length){
        if(prior.length!==1)throw new IntegrationError('MANUAL_REFERENCE','Several existing entries reference this payment. Resolve the ambiguity before accounting.',409)
        if(prior[0].source_type!=='payment')throw new IntegrationError('MANUAL_REFERENCE','An existing journal references this provider payment outside the controlled payment source. Reconcile it before creating another receipt.',409)
        const allocations=await tx.execute<{invoice_id:string}>(sql`SELECT invoice_id::text FROM invoice_application WHERE entry_id=${prior[0].id}::uuid`)
        if(allocations.some(a=>a.invoice_id!==r.invoice_id))throw new IntegrationError('MANUAL_REFERENCE','The existing referenced receipt settles another invoice. Review its allocation before confirming this Checkout.',409)
        const lines=await tx.execute<{account_id:string;party_id:string|null;amount:string}>(sql`SELECT account_id::text,party_id::text,amount::text FROM journal_line WHERE entry_id=${prior[0].id}::uuid`)
        if(lines.length!==2||!lines.some(l=>l.account_id===current.clearing_account_id&&l.party_id===null&&BigInt(l.amount)===e.amount)
          ||!lines.some(l=>l.account_id===i.control_account_id&&l.party_id===r.party_id&&BigInt(l.amount)===-e.amount))
          throw new IntegrationError('MANUAL_REFERENCE','The existing payment reference has different accounts, customer or amount. Review it; no second receipt was posted.',409)
        await linked(tx,f,prior[0].id,prior[0].entry_date,'matched')
        await tx.execute(sql`UPDATE checkout_request SET status='paid',checkout_url=NULL,payment_intent_id=${e.paymentIntentId} WHERE id=${r.id}::uuid`)
        await integrationAudit(tx,s,'processor_existing_payment_matched','processor_transaction',f.id,{entryId:prior[0].id})
        return {id:f.id,status:'matched',entryId:prior[0].id}
      }
      const [fingerprint]=await tx.execute<{value:string}>(sql`SELECT p5_invoice_fingerprint(${r.invoice_id}::uuid) AS value`)
      if(i.version!==r.invoice_version&&(!r.invoice_fingerprint||fingerprint.value!==r.invoice_fingerprint))throw new IntegrationError('INVOICE_VERSION','The invoice was corrected after Checkout. Reconcile the captured receipt against its current document.',409)
      const [due]=await tx.execute<{balance:string}>(sql`SELECT balance::text FROM (${openItemsQuery(sql`AND i.id=${r.invoice_id}::uuid`)}) d`)
      const balance=BigInt(due.balance);let entryId:string
      if(e.amount<=balance){entryId=(await recordPayment({invoiceId:r.invoice_id,bankAccountId:current.clearing_account_id,amount:e.amount,paidOn:date,actor:s.email,reference:e.paymentIntentId},tx)).entryId}
      else{
        const description='Stripe receipt ('+e.paymentIntentId+')'
        const posted=await postEntryCore(tx,{ledgerId:c.ledger_id,entryDate:date,description,sourceType:'payment',actor:s.email,
          lines:[{accountId:current.clearing_account_id,amount:e.amount,description},{accountId:i.control_account_id,amount:-e.amount,partyId:r.party_id,description}]})
        entryId=posted.entry.id
        if(balance>0n)await applyEntryToInvoice({invoiceId:r.invoice_id,entryId,amount:balance,actor:s.email},tx)
      }
      const reason=e.amount>balance?'The excess remains an unapplied customer receipt. Review and allocate or refund it through current controlled commands.':null
      await linked(tx,f,entryId,date,'posted',reason)
      await tx.execute(sql`UPDATE checkout_request SET status='paid',checkout_url=NULL,payment_intent_id=${e.paymentIntentId} WHERE id=${r.id}::uuid`)
      await integrationAudit(tx,s,'processor_receipt_posted','processor_transaction',f.id,{entryId,amount:e.amount.toString(),originalReceivedAt:e.occurredAt,unapplied:(e.amount>balance?e.amount-balance:0n).toString()})
      return {id:f.id,status:'posted',entryId}
    })
    if(e.fee!==null&&e.fee>0n&&e.balanceId){
      const fee=await retainProcessorFact(c,eventId,r,{kind:'fee',objectId:e.balanceId,paymentIntentId:e.paymentIntentId,balanceId:e.balanceId,amount:e.fee,currency:e.currency,occurredAt:e.occurredAt,details:{receiptId:fact.id,gross:e.amount.toString(),net:e.net?.toString()}})
      await accountProcessorMovement(c.ledger_id,fee.id,actor,claim)
    }
    return result
  }catch(error){return retainFailure(fact,error)}
}
/** Explicit fixed movements only: fees debit expense; paid payouts debit bank; receipts never debit revenue. */
export async function accountProcessorMovement(ledgerId:string,id:string,actor:AutomationActor,claim?:Job){
  if(!integrationId(id))throw new IntegrationError('FACT','Unknown processor fact.',404)
  const [fact]=await db.execute<ProcessorTransaction>(sql`SELECT ${sql.raw(transactionColumns)} FROM processor_transaction WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid`)
  if(!fact)throw new IntegrationError('FACT','Unknown processor fact.',404)
  if(fact.entry_id)return {id:fact.id,status:fact.status,entryId:fact.entry_id}
  try{return await db.transaction(async tx=>{
    if(fact.invoice_id)await lockFinanceResource(tx,'invoice',fact.invoice_id)
    const s=await integrationScope(tx,ledgerId,actor,'payment')
    if(claim)await lockClaim(tx,claim)
    const [c]=await tx.execute<PaymentConnection>(sql`SELECT ${paymentConnectionColumns} FROM payment_connection WHERE id=${fact.payment_connection_id}::uuid FOR SHARE`)
    await assertCurrentPaymentMapping(tx,c)
    const [f]=await tx.execute<ProcessorTransaction>(sql`SELECT ${sql.raw(transactionColumns)} FROM processor_transaction WHERE id=${id}::uuid FOR UPDATE`)
    if(f.entry_id)return {id,status:f.status,entryId:f.entry_id}
    if(f.detached||!c.binding_attached||f.stripe_account_id!==c.stripe_account_id||f.mode!==c.mode||f.currency!=='CAD'||s.currency!==f.currency)throw new IntegrationError('BINDING','Verify the original merchant/currency binding before accounting.',409)
    if(!['fee','payout','refund'].includes(f.kind))throw new IntegrationError('REVIEW','This fact needs an explicit provider reconciliation; a dispute alone is not a final loss.',409)
    if(f.review_reason&&f.kind==='payout'&&f.details.providerStatus!=='paid')throw new IntegrationError('PAYOUT','The current provider payout is not paid.',409)
    const amount=BigInt(f.amount),date=companyClock(c.timezone,new Date(f.occurred_at)).date
    let debit=c.fee_account_id,partyId:string|undefined,refundFee=0n
    if(f.kind==='fee'){
      const [receipt]=await tx.execute(sql`SELECT 1 FROM processor_transaction WHERE payment_connection_id=${c.id}::uuid AND kind='receipt' AND payment_intent_id=${f.payment_intent_id} AND entry_id IS NOT NULL AND NOT detached`)
      if(!receipt)throw new IntegrationError('RECEIPT','Account or match the original receipt before its fee.',409)
    }else if(f.kind==='payout'){
      if(!c.bank_account_id)throw new IntegrationError('BANK','Choose the payout bank account before confirmation.',409)
      debit=c.bank_account_id
    }else{
      if(Array.isArray(f.details.feeDetails)&&f.details.feeDetails.some(d=>d&&typeof d==='object'&&'type' in d&&d.type==='tax'))throw new IntegrationError('REFUND_TAX','The refund fee includes tax. Reconcile its source through the existing tax-code accounting controls.',409)
      if(typeof f.details.providerFee!=='string'||!/^[-]?\d{1,18}$/.test(f.details.providerFee)||typeof f.details.providerNet!=='string'||!/^[-]?\d{1,18}$/.test(f.details.providerNet)||f.details.exchangeRate!==null)throw new IntegrationError('REFUND_FEE','Reconcile the actual refund fee, net and currency; no unknown fee was assumed to be zero.',409)
      refundFee=BigInt(f.details.providerFee)
      if(BigInt(f.details.providerNet)!==-amount-refundFee||amount+refundFee<0n)throw new IntegrationError('REFUND_FEE','The refund gross, fee and net fund movement disagree.',409)
      if(f.details.providerStatus!=='succeeded'||!f.invoice_id)throw new IntegrationError('REFUND','Only a succeeded, bound provider refund can be accounted.',409)
      const [receipt]=await tx.execute<ProcessorTransaction>(sql`SELECT ${sql.raw(transactionColumns)} FROM processor_transaction WHERE payment_connection_id=${c.id}::uuid AND kind='receipt' AND payment_intent_id=${f.payment_intent_id} AND entry_id IS NOT NULL AND NOT detached FOR UPDATE`)
      if(!receipt)throw new IntegrationError('RECEIPT','Resolve the original receipt before confirming this refund.',409)
      const [previous]=await tx.execute<{total:string}>(sql`SELECT COALESCE(sum(amount),0)::text AS total FROM processor_transaction WHERE payment_connection_id=${c.id}::uuid AND kind='refund' AND payment_intent_id=${f.payment_intent_id} AND entry_id IS NOT NULL`)
      if(amount+BigInt(previous.total)>BigInt(receipt.amount))throw new IntegrationError('REFUND','The retained refunds exceed the receipt; reconcile their provider balance transactions.',409)
      const [invoice]=await tx.execute<{party_id:string;control_account_id:string}>(sql`SELECT party_id::text,control_account_id::text FROM invoice WHERE id=${f.invoice_id}::uuid FOR UPDATE`)
      const allocations=await tx.execute<{id:string;invoice_id:string;amount:string}>(sql`SELECT a.id::text,a.invoice_id::text,a.amount::text FROM invoice_application a WHERE entry_id=${receipt.entry_id}::uuid ORDER BY a.id FOR UPDATE`)
      if(allocations.some(a=>a.invoice_id!==f.invoice_id))throw new IntegrationError('REFUND_ALLOCATION','This receipt settles multiple invoices. Adjust its allocations through existing controls before confirming the refund.',409)
      const allocated=allocations.reduce((sum,a)=>sum+BigInt(a.amount),0n),available=BigInt(receipt.amount)-BigInt(previous.total)-allocated
      let release=amount>available?amount-available:0n
      for(const a of allocations){if(release===0n)break;const take=release<BigInt(a.amount)?release:BigInt(a.amount);await unapply(a.id,s.email,tx);if(BigInt(a.amount)>take)await applyEntryToInvoice({invoiceId:a.invoice_id,entryId:receipt.entry_id!,amount:BigInt(a.amount)-take,actor:s.email},tx);release-=take}
      if(release!==0n)throw new IntegrationError('REFUND_ALLOCATION','The refund allocation cannot be reconciled.',409)
      debit=invoice.control_account_id;partyId=invoice.party_id
    }
    const description='Stripe '+f.kind+' ('+f.provider_object_id+')'
    const posted=await postEntryCore(tx,{ledgerId,entryDate:date,description,sourceType:f.kind==='refund'?'payment':'manual',actor:s.email,
      lines:[{accountId:debit,amount,partyId,description},{accountId:c.clearing_account_id,amount:-(amount+refundFee),description},...(refundFee!==0n?[{accountId:c.fee_account_id,amount:refundFee,description}]:[])]})
    await linked(tx,f,posted.entry.id,date,'posted')
    await integrationAudit(tx,s,'processor_'+f.kind+'_posted','processor_transaction',id,{entryId:posted.entry.id,amount:f.amount,originalOccurredAt:f.occurred_at})
    return {id,status:'posted',entryId:posted.entry.id}
  })}catch(error){return retainFailure(fact,error)}
}

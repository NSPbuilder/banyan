import 'server-only'
import Stripe from 'stripe'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import {encryptKey,decryptKey} from './ai-service'
import {IntegrationError,integrationId} from './integration-access'

export const STRIPE_API_VERSION=Stripe.API_VERSION
export type PaymentConnection={id:string;entity_id:string;ledger_id:string;authorized_by:string|null;stripe_account_id:string|null;
  mode:'test'|'live';currency:string;key_ciphertext:Buffer|null;webhook_ciphertext:Buffer|null;clearing_account_id:string;
  fee_account_id:string;bank_account_id:string|null;timezone:string;binding_attached:boolean;enabled:boolean;verified_at:string|null;version:string}
export const paymentConnectionColumns=sql.raw('id::text,entity_id::text,ledger_id::text,authorized_by::text,stripe_account_id,mode,currency,key_ciphertext,webhook_ciphertext,clearing_account_id::text,fee_account_id::text,bank_account_id::text,timezone,binding_attached,enabled,verified_at::text,version::text')
/** Unused mapped accounts may be retyped; validate their current classification before execution. */
export async function assertCurrentPaymentMapping(tx:Tx,c:PaymentConnection){
  const accounts=await tx.execute<{id:string;entity_id:string;account_type:string;is_active:boolean;is_postable:boolean}>(sql`SELECT id::text,entity_id::text,account_type,is_active,is_postable FROM account
    WHERE id IN (${c.clearing_account_id}::uuid,${c.fee_account_id}::uuid,${c.bank_account_id}::uuid) ORDER BY id FOR SHARE`)
  const roles=await tx.execute<{account_id:string;role:string}>(sql`SELECT account_id::text,role FROM account_role
    WHERE account_id IN (${c.clearing_account_id}::uuid,${c.bank_account_id}::uuid) ORDER BY account_id,role FOR SHARE`)
  const valid=(id:string,type:string)=>accounts.some(a=>a.id===id&&a.entity_id===c.entity_id&&a.account_type===type&&a.is_active&&a.is_postable)
  if(!valid(c.clearing_account_id,'asset')||!valid(c.fee_account_id,'expense')||roles.some(r=>r.account_id===c.clearing_account_id&&['trade_receivables','trade_payables'].includes(r.role))
    ||(c.bank_account_id&&(!valid(c.bank_account_id,'asset')||!roles.some(r=>r.account_id===c.bank_account_id&&r.role==='cash_and_cash_equivalents'))))
    throw new IntegrationError('ACCOUNT_MAPPING','The current clearing, fee or bank account classification changed. Retain this provider fact and review the mappings before accounting.',409)
}
export async function connectionById(id:string) {
  if(!integrationId(id))throw new IntegrationError('CONNECTION','This service is unavailable.',404)
  const [c]=await db.execute<PaymentConnection>(sql`SELECT ${paymentConnectionColumns} FROM payment_connection WHERE id=${id}::uuid`)
  if(!c)throw new IntegrationError('CONNECTION','This service is unavailable.',404)
  return c
}
function master(id:string,purpose:string) {
  const key=process.env.INTEGRATION_KEY_SECRET??''
  if(key.trim().length<32)throw new IntegrationError('SECRET','Configure a dedicated integration encryption key before using external services.',503)
  return key+':FigTree:P5:'+id+':'+purpose
}
export const sealIntegration=(value:string,id:string,purpose:string)=>encryptKey(value,master(id,purpose))
export function openIntegration(value:Buffer|null,id:string,purpose:string) {
  const plain=value?decryptKey(Buffer.from(value),master(id,purpose)):null
  if(!plain)throw new IntegrationError('SECRET','Re-enter this service credential; the saved value cannot be read.',503)
  return plain
}
export function stripeClient(c:PaymentConnection) {
  if(!c.binding_attached)throw new IntegrationError('DETACHED','Verify this restored merchant binding before using it.',409)
  const key=openIntegration(c.key_ciphertext,c.id,'stripe-key')
  if(!new RegExp(`^(sk|rk)_${c.mode}_[A-Za-z0-9]+$`).test(key))throw new IntegrationError('MODE','The secret key does not match the configured test/live mode.',409)
  return new Stripe(key,{apiVersion:STRIPE_API_VERSION,timeout:15000,maxNetworkRetries:2})
}
export async function providerCall<T>(call:()=>Promise<T>):Promise<T> {
  try{return await call()}catch(e){
    if(e instanceof IntegrationError)throw e
    throw new IntegrationError('PROVIDER','The payment provider could not confirm this operation. Preserve its request and reconcile before retrying.',503)
  }
}
export function providerCents(value:unknown,positive=false):bigint {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||(positive&&value===0))throw new IntegrationError('PROVIDER_AMOUNT','The provider amount is not an exact supported integer.',409)
  return BigInt(value)
}
export function providerObjectId(value:unknown):string|null {
  if(typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{2,199}$/.test(value))return value
  if(value&&typeof value==='object'&&'id' in value)return providerObjectId(value.id)
  return null
}
export const supportedStripeEvents=new Set(['checkout.session.completed','checkout.session.expired','payment_intent.succeeded','charge.refunded','refund.created','refund.updated','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','payout.paid','payout.failed','payout.updated'])
export type StripeSnapshot={id:string;type:string;apiVersion:string;mode:'test'|'live';objectId:string;object:Record<string,unknown>}
/** Retain identifiers and economic state, never cards, billing addresses or raw customer data. */
export function minimizeStripeEvent(event:Stripe.Event,c:PaymentConnection):StripeSnapshot {
  if(event.livemode!==(c.mode==='live')||(event.account&&event.account!==c.stripe_account_id))throw new IntegrationError('MODE','This event does not belong to this merchant and mode.',400)
  if(!/^evt_[A-Za-z0-9]+$/.test(event.id)||typeof event.type!=='string')throw new IntegrationError('EVENT','The signed event structure is unsupported.')
  const source=event.data?.object as unknown as Record<string,unknown>,objectId=providerObjectId(source)
  if(!source||!objectId)throw new IntegrationError('EVENT','The signed event has no reliable object identifier.')
  const object:Record<string,unknown>={id:objectId}
  for(const field of ['object','status','payment_status','currency','client_reference_id','failure_code']) {
    const value=source[field];if(typeof value==='string'&&value.length<=250)object[field]=value
  }
  for(const field of ['amount','amount_total','amount_received','amount_refunded','fee','net','created','arrival_date']) {
    const value=source[field];if(typeof value==='number'&&Number.isSafeInteger(value))object[field]=String(value)
  }
  for(const field of ['payment_intent','latest_charge','charge','balance_transaction','payout','customer'])object[field]=providerObjectId(source[field])
  return {id:event.id,type:event.type,apiVersion:event.api_version??'unknown',mode:c.mode,objectId,object}
}
export function verifyStripeBody(c:PaymentConnection,body:Buffer,signature:string|null) {
  if(!signature||body.length===0||body.length>1024*1024||!c.stripe_account_id||!c.binding_attached)throw new IntegrationError('SIGNATURE','Invalid payment delivery.',400)
  let event:Stripe.Event
  try {event=Stripe.webhooks.constructEvent(body,signature,openIntegration(c.webhook_ciphertext,c.id,'stripe-webhook'),300)}
  catch(e){if(e instanceof IntegrationError)throw e;throw new IntegrationError('SIGNATURE','Invalid payment delivery.',400)}
  return minimizeStripeEvent(event,c)
}

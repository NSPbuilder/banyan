import type Stripe from 'stripe'
import type {PaymentConnection} from './payment-provider'
import {providerCents,providerObjectId} from './payment-provider'
import {IntegrationError} from './integration-access'

export type CheckoutRequest={id:string;entity_id:string;ledger_id:string;payment_connection_id:string;invoice_id:string;party_id:string;invoice_fingerprint:string|null;
  invoice_version:string;expected_amount:string;currency:string;stripe_account_id:string;mode:'test'|'live';source_request_key:string;
  stripe_checkout_id:string|null;payment_intent_id:string|null;checkout_url:string|null;status:string;expires_at:string|null;created_at:string}
export const checkoutColumns='id::text,entity_id::text,ledger_id::text,payment_connection_id::text,invoice_id::text,party_id::text,invoice_fingerprint,invoice_version::text,expected_amount::text,currency,stripe_account_id,mode,source_request_key,stripe_checkout_id,payment_intent_id,checkout_url,status,expires_at::text,created_at::text'
export type ReceiptEvidence={paymentIntentId:string;checkoutId:string;chargeId:string;amount:bigint;currency:string;occurredAt:string;
  balanceId:string|null;fee:bigint|null;net:bigint|null;reviewReason:string|null;providerVersion:string}
export type ProcessorTransaction={id:string;entity_id:string;ledger_id:string;payment_connection_id:string;payment_event_id:string|null;
  checkout_request_id:string|null;invoice_id:string|null;stripe_account_id:string;mode:'test'|'live';kind:'receipt'|'fee'|'payout'|'refund'|'dispute';
  provider_object_id:string;payment_intent_id:string|null;balance_transaction_id:string|null;payout_id:string|null;amount:string;currency:string;
  occurred_at:string;details:Record<string,unknown>;status:string;entry_id:string|null;accounting_date:string|null;review_reason:string|null;detached:boolean}
export const transactionColumns='id::text,entity_id::text,ledger_id::text,payment_connection_id::text,payment_event_id::text,checkout_request_id::text,invoice_id::text,stripe_account_id,mode,kind,provider_object_id,payment_intent_id,balance_transaction_id,payout_id,amount::text,currency,occurred_at::text,details,status,entry_id::text,accounting_date::text,review_reason,detached'
export function providerInstant(seconds:number):string {
  const date=new Date(seconds*1000)
  if(!Number.isSafeInteger(seconds)||seconds<=0||!Number.isFinite(date.getTime())||date.getUTCFullYear()>9999)
    throw new IntegrationError('PROVIDER_DATE','The payment provider supplied an unsupported timestamp.',409)
  return date.toISOString()
}
/** A pure graph validator. Protocol fixtures test this; only the production adapter retrieves these objects from Stripe. */
export function receiptEvidence(c:PaymentConnection,r:CheckoutRequest,session:Stripe.Checkout.Session,pi:Stripe.PaymentIntent,charge:Stripe.Charge,balance:Stripe.BalanceTransaction|null):ReceiptEvidence {
  if(r.payment_connection_id!==c.id||r.stripe_account_id!==c.stripe_account_id||r.mode!==c.mode||r.currency!==c.currency)
    throw new IntegrationError('BINDING','The payment request does not belong to this merchant binding.',409)
  if(session.livemode!==(c.mode==='live')||pi.livemode!==session.livemode||charge.livemode!==session.livemode)
    throw new IntegrationError('MODE','The provider objects belong to a different test/live environment.',409)
  if(session.mode!=='payment'||session.payment_status!=='paid'||pi.status!=='succeeded'||!charge.paid||!charge.captured||charge.status!=='succeeded')
    throw new IntegrationError('NOT_PAID','The provider has not confirmed a captured card payment.',409)
  if(!session.payment_method_types.includes('card')||session.payment_method_types.some(type=>type!=='card')||charge.payment_method_details?.type!=='card')
    throw new IntegrationError('PAYMENT_METHOD','Only the enabled card payment path is supported.',409)
  if(session.id!==r.stripe_checkout_id||session.client_reference_id!==r.source_request_key||providerObjectId(session.payment_intent)!==pi.id
    ||providerObjectId(pi.latest_charge)!==charge.id||providerObjectId(charge.payment_intent)!==pi.id
    ||(r.payment_intent_id!==null&&r.payment_intent_id!==pi.id))throw new IntegrationError('OBJECT_BINDING','The current payment objects do not match the saved Checkout request.',409)
  if(providerObjectId(session.customer)!==providerObjectId(pi.customer)||providerObjectId(pi.customer)!==providerObjectId(charge.customer))
    throw new IntegrationError('CUSTOMER_BINDING','The payment customer differs across its provider objects.',409)
  const amount=providerCents(pi.amount_received,true),sessionAmount=providerCents(session.amount_total,true),captured=providerCents(charge.amount_captured,true)
  const currency=String(pi.currency).toUpperCase(),sameCurrency=currency===String(session.currency).toUpperCase()&&currency===String(charge.currency).toUpperCase()
  let reviewReason:string|null=null
  if(amount!==sessionAmount||amount!==captured||sessionAmount!==BigInt(r.expected_amount))reviewReason='The actual received amount differs from the bound Checkout quote; reconcile it before accounting.'
  if(!sameCurrency||currency!=='CAD'||currency!==r.currency)reviewReason='The actual provider currency is outside this CAD merchant/ledger binding.'
  if(providerCents(charge.amount_refunded)>0n||charge.disputed)reviewReason='A refund or dispute is already reported; reconcile the current economic events before accounting.'
  let fee:bigint|null=null,net:bigint|null=null,balanceId:string|null=null
  if(balance){
    if(providerObjectId(charge.balance_transaction)!==balance.id||providerObjectId(balance.source)!==charge.id)
      throw new IntegrationError('BALANCE_BINDING','The processor balance transaction does not belong to this charge.',409)
    if(!Number.isSafeInteger(balance.net))throw new IntegrationError('PROVIDER_AMOUNT','The processor net amount is not an exact supported integer.',409)
    fee=providerCents(balance.fee);net=BigInt(balance.net);balanceId=balance.id
    if(balance.fee_details?.some(detail=>detail.type==='tax'))reviewReason='The processor fee includes tax. Review its original evidence and use the existing tax-code accounting controls.'
    if(providerCents(balance.amount)!==amount||net!==amount-fee
      ||balance.currency.toUpperCase()!==currency||balance.exchange_rate!==null)
      reviewReason='The processor gross, fee, net or currency requires review; no FX or difference entry was inferred.'
  }
  return {paymentIntentId:pi.id,checkoutId:session.id,chargeId:charge.id,amount,currency,occurredAt:providerInstant(charge.created),
    balanceId,fee,net,reviewReason,providerVersion:'2026-09-30.endive'}
}

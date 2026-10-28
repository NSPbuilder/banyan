'use server'
import {cookies} from 'next/headers'
import {revalidatePath} from 'next/cache'
import {unstable_rethrow} from 'next/navigation'
import {requireLedger,SESSION_COOKIE} from '@/lib/gate'
import {integrationActor,IntegrationError,integrationId} from '@/lib/integration-access'
import {AutomationError} from '@/lib/automation-access'
import {proofFrom} from '@/lib/edit-proof'
import {EditConflict} from '@/lib/edit-leases'
import {createPaymentConnection,savePaymentConnection,verifyPaymentConnection,enablePaymentConnection} from '@/lib/online-payments'
import {reconcileStripeEvent,reconcileCheckout,recoverCheckout,confirmProcessorMovement} from '@/lib/payment-events'
import {createInboundConnection,saveInboundConnection} from '@/lib/inbound-mail'
import {inviteInvoice,revokeInvitation} from '@/lib/customer-portal'
import type {FormState} from './actions'
export async function integrationAction(_previous:FormState,f:FormData):Promise<FormState>{
  const get=(key:string)=>String(f.get(key)??'').trim(),ledgerId=get('ledgerId'),id=get('id'),command=get('command')
  if(!integrationId(ledgerId)||(id&&!integrationId(id)))return {error:'Choose a current company and record.'}
  await requireLedger(ledgerId,command.startsWith('inbound')?'/automation':['/automation','/invoices'])
  const sessionToken=(await cookies()).get(SESSION_COOKIE)?.value??'',actor=integrationActor(sessionToken),context={sessionToken,proof:proofFrom(f),leaseRequired:true}
  let result:{version?:string}|undefined
  try{
    const payment={mode:get('mode') as 'test'|'live',clearingId:get('clearingId'),feeId:get('feeId'),bankId:get('bankId'),timezone:get('timezone'),key:get('key'),webhook:get('webhook')}
    const inbound={providerAccount:get('providerAccount'),recipientBase:get('recipientBase'),username:get('username'),password:get('password')}
    switch(command){
      case 'payment-create':await createPaymentConnection(ledgerId,actor,payment);break
      case 'payment-save':result=await savePaymentConnection(ledgerId,id,context,payment);break
      case 'payment-verify':result=await verifyPaymentConnection(ledgerId,id,context);break
      case 'payment-enable':result=await enablePaymentConnection(ledgerId,id,context,get('operation')==='enable');break
      case 'inbound-create':await createInboundConnection(ledgerId,actor,inbound);break
      case 'inbound-save':result=await saveInboundConnection(ledgerId,id,context,inbound,get('rotate')==='on',get('enabled')==='on');break
      case 'payment-event':await reconcileStripeEvent(ledgerId,id,get('eventId'),actor);break
      case 'payment-reconcile':await reconcileCheckout(ledgerId,id,actor);break
      case 'payment-recover':await recoverCheckout(ledgerId,id,get('sessionId'),actor);break
      case 'payment-confirm':{const outcome=await confirmProcessorMovement(ledgerId,id,actor);if(outcome.status==='needs_accounting_review')return {error:'The provider fact is retained for accounting review. Open its current reason.'};break}
      case 'portal-invite':{const link=await inviteInvoice(ledgerId,id,actor,get('invoiceVersion'));revalidatePath(`/ledger/${ledgerId}/invoices/${id}`);return {ok:'Share this limited link before '+link.expiresAt+': '+link.url}}
      case 'portal-revoke':await revokeInvitation(ledgerId,id,actor);break
      default:throw new IntegrationError('COMMAND','Choose a supported integration action.')
    }
  }catch(error){unstable_rethrow(error);return {error:error instanceof IntegrationError||error instanceof AutomationError||error instanceof EditConflict?error.message:'This operation was refused. Review the mappings, original record and service configuration.'}}
  revalidatePath(`/ledger/${ledgerId}/automation`,'layout');revalidatePath(`/ledger/${ledgerId}/invoices`,'layout')
  revalidatePath('/settings/services')
  return {ok:'Saved. Review the current status.',version:result?.version}
}

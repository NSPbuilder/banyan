/** Local protocol facts through production commands; never impersonates provider API success. */
import {randomBytes,randomUUID} from 'node:crypto'
import {sql} from 'drizzle-orm'
import Stripe from 'stripe'
import {PDFDocument} from 'pdf-lib'
import {db} from '../src/db/client'
import {p5Company} from './p5-fixtures'
import {integrationActor} from '../src/lib/integration-access'
import {createPaymentConnection,receiveStripe,reserveCheckout,enablePaymentConnection} from '../src/lib/online-payments'
import {connectionById} from '../src/lib/payment-provider'
import {retainProcessorFact} from '../src/lib/processor-ledger'
import {inviteInvoice,exchangeInvitation} from '../src/lib/customer-portal'
import {createInboundConnection,saveInboundConnection,receivePostmark} from '../src/lib/inbound-mail'
import {configureAutomation} from '../src/lib/automation-access'
import {workerHeartbeat} from '../src/lib/jobs'
import {editLease} from '../src/lib/edit-leases'
import {EDIT_RESOURCES,type EditResource,type EditContext} from '../src/lib/edit-proof'
export async function p5Proof(resource:EditResource,token:string):Promise<EditContext>{
  const [row]=await db.execute<{version:string}>(sql`SELECT version::text FROM ${sql.raw(EDIT_RESOURCES[resource.type].table)} WHERE id=${resource.id}::uuid`)
  const tabId=randomUUID(),lease=await editLease(resource,token,'takeover',{version:row.version,tabId})
  return {sessionToken:token,proof:{...lease,version:row.version,tabId},leaseRequired:true}
}
export async function buildP5Lifecycle(email:string,token:string,prefix:string){
  const before={AUTOMATION_ENABLED:process.env.AUTOMATION_ENABLED,ONLINE_PAYMENTS_ENABLED:process.env.ONLINE_PAYMENTS_ENABLED,INBOUND_MAIL_ENABLED:process.env.INBOUND_MAIL_ENABLED,POSTMARK_INGRESS_IP_FILTER_CONFIGURED:process.env.POSTMARK_INGRESS_IP_FILTER_CONFIGURED}
  try{
    process.env.AUTOMATION_ENABLED='true';process.env.ONLINE_PAYMENTS_ENABLED='true';process.env.INBOUND_MAIL_ENABLED='true';process.env.POSTMARK_INGRESS_IP_FILTER_CONFIGURED='true'
    const co=await p5Company(prefix,email),ledgerId=co.ledger.id,actor=integrationActor(token),invoiceId=await co.invoice(prefix+'-INV'),tag=randomBytes(12).toString('hex'),webhook='whsec_'+randomBytes(24).toString('hex')
    const setting=await createPaymentConnection(ledgerId,actor,{mode:'test',clearingId:co.at('1100'),feeId:co.at('5000'),bankId:co.at('1000'),timezone:'America/Vancouver',key:'sk_test_'+tag,webhook})
    // A declared local merchant fixture supports protocol/DB tests only. No Stripe API is called.
    await db.execute(sql`UPDATE payment_connection SET stripe_account_id=${'acct_LocalFixture'+tag},verified_at=clock_timestamp() WHERE id=${setting.id}::uuid`)
    await configureAutomation(ledgerId,actor,{version:'0',enabled:true,mailEnabled:false,timezone:'America/Vancouver',senderEmail:''});await workerHeartbeat(randomUUID())
    await enablePaymentConnection(ledgerId,setting.id,await p5Proof({ledgerId,type:'payment',id:setting.id},token),true)
    const [version]=await db.execute<{version:string}>(sql`SELECT version::text FROM invoice WHERE id=${invoiceId}::uuid`)
    const invitation=await inviteInvoice(ledgerId,invoiceId,actor,version.version),opened=await exchangeInvitation(invitation.id,invitation.url.split('#')[1]),quote=await reserveCheckout(invitation.id,opened.session),pi='pi_LocalFixture'+tag
    await db.execute(sql`UPDATE checkout_request SET stripe_checkout_id=${'cs_test_'+tag},payment_intent_id=${pi},status='open' WHERE id=${quote.r.id}::uuid`)
    const body=Buffer.from(JSON.stringify({id:'evt_LocalFixture'+tag,type:'payment_intent.succeeded',livemode:false,api_version:Stripe.API_VERSION,data:{object:{id:pi,object:'payment_intent',amount_received:100000,currency:'cad',status:'succeeded'}}}))
    const event=await receiveStripe(setting.id,body,Stripe.webhooks.generateTestHeaderString({payload:body.toString(),secret:webhook})),c=await connectionById(setting.id)
    await retainProcessorFact(c,event.id,{...quote.r,stripe_checkout_id:'cs_test_'+tag,payment_intent_id:pi},{kind:'receipt',objectId:pi,paymentIntentId:pi,amount:100000n,currency:'CAD',occurredAt:'2026-10-01T16:00:00.000Z',reason:'Local protocol fixture retained for review; actual external receipt unverified.'})
    const credentials={providerAccount:'LocalFixture'+tag,recipientBase:tag+'@inbound.postmarkapp.com',username:'local_'+tag,password:randomBytes(30).toString('base64url')},mail=await createInboundConnection(ledgerId,actor,credentials)
    await saveInboundConnection(ledgerId,mail.id,await p5Proof({ledgerId,type:'inbound',id:mail.id},token),credentials,false,true)
    const [route]=await db.execute<{alias_address:string}>(sql`SELECT alias_address FROM inbound_connection WHERE id=${mail.id}::uuid`),pdf=await PDFDocument.create();pdf.addPage([300,300]);const bytes=Buffer.from(await pdf.save())
    await receivePostmark(mail.id,'Basic '+Buffer.from(credentials.username+':'+credentials.password).toString('base64'),Buffer.from(JSON.stringify({MessageID:'local-'+tag,OriginalRecipient:route.alias_address,FromFull:{Email:'untrusted@example.test'},Subject:'Local lifecycle protocol fixture',Attachments:[{Name:'Lifecycle.pdf',ContentType:'application/pdf',ContentLength:bytes.length,Content:bytes.toString('base64')}]})))
    return {entityId:co.company.id,ledgerId,invoiceId,paymentConnectionId:setting.id,inboundConnectionId:mail.id,requestId:quote.r.id,invitationId:invitation.id,session:opened.session}
  }finally{for(const[key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
}

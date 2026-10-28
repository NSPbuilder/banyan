import './env'
import {randomBytes,randomUUID} from 'node:crypto'
import Stripe from 'stripe'
import {readFileSync} from 'node:fs'
import {PDFDocument,PDFName,PDFString} from 'pdf-lib'
import {sql} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {reporter,expectSaying,errorText} from './suite'
import {createFirstOwner,createUser,setUserStatus,signIn} from '../src/lib/users'
import {buildP5Lifecycle} from './p5-lifecycle'
import {importBankRows,bankRows,matchEntry,matchesFor} from '../src/lib/bank'
import {postEntry} from '../src/lib/posting'
import {updateAccount} from '../src/lib/accounts'
import {p5Company} from './p5-fixtures'
import {integrationActor} from '../src/lib/integration-access'
import {createPaymentConnection,savePaymentConnection,enablePaymentConnection,receiveStripe,reserveCheckout} from '../src/lib/online-payments'
import {connectionById,verifyStripeBody,openIntegration} from '../src/lib/payment-provider'
import {receiptEvidence,checkoutColumns,type CheckoutRequest} from '../src/lib/online-payment-types'
import {accountReceipt,retainProcessorFact,accountProcessorMovement} from '../src/lib/processor-ledger'
import {inviteInvoice,exchangeInvitation,portalInvoice,portalPdf,revokeInvitation} from '../src/lib/customer-portal'
import {createInboundConnection,saveInboundConnection,receivePostmark,inboundFile,inboundOverview} from '../src/lib/inbound-mail'
import {uploadInbox,reviewInbox} from '../src/lib/inbox'
import {editLease} from '../src/lib/edit-leases'
import {EDIT_RESOURCES,type EditResource,type EditContext} from '../src/lib/edit-proof'
import {configureAutomation} from '../src/lib/automation-access'
import {workerHeartbeat} from '../src/lib/jobs'
import {recordPayment,balanceOf,unappliedReceipts} from '../src/lib/payments'
import {editInvoice,voidInvoice} from '../src/lib/invoices'
import {archiveCompany,deleteCompany} from '../src/lib/companies'
import {closePeriod} from '../src/lib/periods'
import {exportCompany,restoreCompany,restorePaper} from '../src/lib/backup'
import {pauseRestoredAutomation} from '../src/lib/automation-restore'

const r=reporter(90),no=expectSaying(r,errorText,130),password=randomBytes(30).toString('base64url')
let token=''
async function proof(resource:EditResource,sessionToken=token):Promise<EditContext>{
  const [row]=await db.execute<{version:string}>(sql`SELECT version::text FROM ${sql.raw(EDIT_RESOURCES[resource.type].table)} WHERE id=${resource.id}::uuid`)
  const tabId=randomUUID(),lease=await editLease(resource,sessionToken,'takeover',{version:row.version,tabId})
  return {sessionToken,proof:{...lease,version:row.version,tabId},leaseRequired:true}
}
async function concurrentPortalRevocation(ledgerId:string,invitationId:string,issuerId:string,actor:ReturnType<typeof integrationActor>,readPortal:()=>Promise<unknown>) {
  let release!:()=>void,ready!:()=>void,controllerPid=0
  const held=new Promise<void>(resolve=>{ready=resolve}),unblock=new Promise<void>(resolve=>{release=resolve})
  const controller=connection.begin(async tx=>{
    controllerPid=(await tx<{pid:number}[]>`SELECT pg_backend_pid() AS pid`)[0].pid
    await tx`SELECT id FROM app_user WHERE id=${issuerId}::uuid FOR UPDATE`
    ready();await unblock
  })
  const settle=(operation:Promise<unknown>)=>operation.then(()=>({ok:true,error:''}),error=>({ok:false,error:errorText(error)}))
  const waiting=async(except:number,blockerIds:number[])=>{
    const deadline=Date.now()+5000
    while(Date.now()<deadline){
      const rows=await db.execute<{pid:number;wait_event:string;query:string}>(sql`SELECT pid,wait_event,query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND pid<>${controllerPid} AND pid<>${except} AND state='active' AND wait_event_type='Lock' AND pg_blocking_pids(pid)&&ARRAY[${sql.join(blockerIds.map(id=>sql`${id}`),sql`, `)}]::int[]`)
      if(rows.length===1)return rows[0]
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    throw Error('Controlled portal concurrency did not reach the expected database wait')
  }
  let revoked:ReturnType<typeof settle>|undefined,read:ReturnType<typeof settle>|undefined
  let revokeWait:Awaited<ReturnType<typeof waiting>>|undefined,readWait:Awaited<ReturnType<typeof waiting>>|undefined
  let results:Array<Awaited<ReturnType<typeof settle>>>=[]
  try {
    await Promise.race([held,controller])
    revoked=settle(revokeInvitation(ledgerId,invitationId,actor))
    revokeWait=await waiting(0,[controllerPid])
    read=settle(readPortal())
    readWait=await waiting(revokeWait.pid,[controllerPid,revokeWait.pid])
  } finally {
    release();await controller
    results=await Promise.all([...(revoked?[revoked]:[]),...(read?[read]:[])])
  }
  const [revokeResult,readResult]=results,errors=results.filter(v=>!v.ok).map(v=>v.error)
  return {revokeAtLiveAuth:!!revokeWait?.query.includes('FOR UPDATE OF u,s'),readAtPortalLock:readWait?.wait_event==='advisory',revoked:revokeResult?.ok===true,readRefused:readResult?.ok===false&&readResult.error.includes('unavailable'),deadlock:errors.some(error=>/40P01|deadlock/i.test(error)),errors}
}

async function main(){
  const target=new URL(process.env.DATABASE_URL!).pathname.slice(1)
  const p6Proof=target.startsWith('figtree_p6_')?JSON.parse(readFileSync('docs/evidence/p6/isolation.json','utf8')):null
  const confirmedP6=!!p6Proof&&p6Proof.createdNew===true&&p6Proof.productionTouched===false&&p6Proof.testDatabase===target&&p6Proof.initialPublicTables[target]===0
  const extra=process.env.FIGTREE_TEST_ISOLATION_PROOF?JSON.parse(readFileSync(process.env.FIGTREE_TEST_ISOLATION_PROOF,'utf8')):null
  const confirmedExtra=!!extra&&extra.createdNew===true&&extra.productionTouched===false&&extra.initialTables===0&&extra.testDatabase===target&&extra.applicationDatabase!==target
  if((target!=='figtree_p5_20261008_6a2ed49d_test'&&!confirmedP6&&!confirmedExtra&&!(process.env.CI==='true'&&target==='figtree_ci_test'))||process.env.TEST_DATABASE_CONFIRMATION!==target)throw Error('Unconfirmed P5 database')
  console.log('Local protocol fixtures and real isolated PostgreSQL. No mocked provider calls; no actual Stripe/Postmark delivery is claimed.')
  const owner=await createFirstOwner({email:'p5-owner@example.test',password,firstName:'P5 owner'}),login=await signIn({email:owner.email,password,clientIp:'192.0.2.55'})
  if(!login||'challenge' in login)throw Error('Local owner did not sign in')
  token=login.token;const actor=integrationActor(token),co=await p5Company('P5A',owner.email),other=await p5Company('P5B',owner.email),ledgerId=co.ledger.id
  const webhook='whsec_'+randomBytes(24).toString('hex'),settings={mode:'test' as const,clearingId:co.at('1100'),feeId:co.at('5000'),bankId:co.at('1000'),timezone:'America/Vancouver',key:'sk_test_'+randomBytes(24).toString('hex'),webhook}
  await no('P5A01 wrong-company clearing mapping refused by actual database','P5_ACCOUNT_MAPPING',()=>createPaymentConnection(other.ledger.id,actor,settings))
  const setting=await createPaymentConnection(ledgerId,actor,settings),resource={ledgerId,type:'payment' as const,id:setting.id}
  let c=await connectionById(setting.id)
  r.check(!c.enabled&&!c.verified_at&&c.key_ciphertext!==null,'P5A02 configuration is encrypted and disabled until actual verification')
  const stale=await proof(resource);await savePaymentConnection(ledgerId,c.id,stale,settings)
  await no('P5A03 stale configuration version cannot overwrite saved mapping','changed',()=>savePaymentConnection(ledgerId,c.id,stale,settings))
  await no('P5A04 unverified merchant cannot enable','unavailable',async()=>enablePaymentConnection(ledgerId,c.id,await proof(resource),true))
  // Explicit local merchant fixture only, to exercise quote/graph/accounting logic without pretending an API read succeeded.
  await db.execute(sql`UPDATE payment_connection SET stripe_account_id='acct_P5FixtureA',verified_at=clock_timestamp() WHERE id=${c.id}::uuid`);c=await connectionById(c.id)
  const invoiceId=await co.invoice('P5-1000'),version=async(id:string)=>(await db.execute<{version:string}>(sql`SELECT version::text FROM invoice WHERE id=${id}::uuid`))[0].version
  const invite=await inviteInvoice(ledgerId,invoiceId,actor,await version(invoiceId)),secret=invite.url.split('#')[1]
  r.check(!invite.url.split('#')[0].includes(secret),'P5A05 invitation secret is held in URL fragment')
  await no('P5A06 wrong invitation token refused','unavailable',()=>exchangeInvitation(invite.id,randomBytes(32).toString('base64url')))
  const opened=await exchangeInvitation(invite.id,secret),publicView=await portalInvoice(opened.session,invite.id)
  r.check(publicView.amount==='100000'&&!('party_id' in publicView)&&!('invoice_id' in publicView),'P5A07 portal exposes current amount and safe projection only')
  const pdf=await portalPdf(opened.session,invite.id)
  r.check(pdf.buffer.subarray(0,5).toString()==='%PDF-','P5A08 authorized portal PDF uses actual customer renderer')
  await no('P5A09 disabled payment channel refuses quote reservation','cannot currently',()=>reserveCheckout(invite.id,opened.session))
  process.env.ONLINE_PAYMENTS_ENABLED='true';process.env.AUTOMATION_ENABLED='true'
  await configureAutomation(ledgerId,actor,{version:'0',enabled:true,mailEnabled:false,timezone:'America/Vancouver',senderEmail:''})
  await no('P5A10 missing live worker heartbeat blocks enable','healthy worker',async()=>enablePaymentConnection(ledgerId,c.id,await proof(resource),true))
  await workerHeartbeat(randomUUID());await enablePaymentConnection(ledgerId,c.id,await proof(resource),true);c=await connectionById(c.id)
  const quotes=await Promise.all([reserveCheckout(invite.id,opened.session),reserveCheckout(invite.id,opened.session)])
  r.check(quotes[0].r.id===quotes[1].r.id&&quotes[0].r.expected_amount==='100000','P5A11 concurrent requests reserve one server-calculated current quote')
  await no('P5A12 merchant mappings freeze after a saved Checkout','P5_FROZEN_BINDING',async()=>savePaymentConnection(ledgerId,c.id,await proof(resource),{...settings,clearingId:co.at('1000')}))
  const quoted=quotes[0].r;await db.execute(sql`UPDATE checkout_request SET stripe_checkout_id='cs_test_P5ReceiptA',payment_intent_id='pi_P5ReceiptA',status='open',expires_at=clock_timestamp()+interval '1 hour' WHERE id=${quoted.id}::uuid`)
  const request={...quoted,stripe_checkout_id:'cs_test_P5ReceiptA',payment_intent_id:'pi_P5ReceiptA',status:'open'}
  function graph(req:CheckoutRequest,piId=req.payment_intent_id!,amount=Number(req.expected_amount),currency='cad',fee=3000,merchant=c){
    const session={id:req.stripe_checkout_id,livemode:false,mode:'payment',payment_status:'paid',payment_method_types:['card'],client_reference_id:req.source_request_key,payment_intent:piId,amount_total:amount,currency,customer:null} as unknown as Stripe.Checkout.Session
    const pi={id:piId,livemode:false,status:'succeeded',latest_charge:'ch_'+piId,amount_received:amount,currency,customer:null} as unknown as Stripe.PaymentIntent
    const charge={id:'ch_'+piId,livemode:false,paid:true,captured:true,status:'succeeded',payment_method_details:{type:'card'},payment_intent:piId,amount_captured:amount,amount_refunded:0,disputed:false,currency,customer:null,balance_transaction:'txn_'+piId,created:1790870400} as unknown as Stripe.Charge
    const balance={id:'txn_'+piId,source:charge.id,amount,fee,net:amount-fee,currency,exchange_rate:null} as unknown as Stripe.BalanceTransaction
    return {session,pi,charge,balance,evidence:()=>receiptEvidence(merchant,req,session,pi,charge,balance)}
  }
  const g=graph(request),e=g.evidence()
  r.check(e.amount===100000n&&e.fee===3000n&&e.net===97000n,'P5B01 graph preserves exact gross, actual fee and net cents')
  await no('P5B02 mismatched successful object cannot authorize money','do not match',async()=>receiptEvidence(c,request,{...g.session,payment_intent:'pi_Foreign'},g.pi,g.charge,g.balance))
  await no('P5B03 wrong-mode provider graph refused','different test/live',async()=>receiptEvidence(c,request,g.session,{...g.pi,livemode:true},g.charge,g.balance))
  await no('P5B04 fractional provider amount refused','exact supported integer',async()=>receiptEvidence(c,request,g.session,{...g.pi,amount_received:100000.5},g.charge,g.balance))
  await no('P5B05 uncaptured card is not a receipt','captured card payment',async()=>receiptEvidence(c,request,g.session,g.pi,{...g.charge,captured:false},g.balance))
  await no('P5B06 unrelated balance transaction refused','does not belong',async()=>receiptEvidence(c,request,g.session,g.pi,g.charge,{...g.balance,source:'ch_Foreign'}))
  r.check(!!receiptEvidence(c,request,g.session,g.pi,{...g.charge,disputed:true},g.balance).reviewReason,'P5B07 old success cannot hide a current dispute')
  r.check(!!receiptEvidence(c,request,g.session,g.pi,{...g.charge,amount_refunded:100},g.balance).reviewReason,'P5B08 old success cannot hide a current refund')
  r.check(!!receiptEvidence(c,request,g.session,g.pi,g.charge,{...g.balance,net:97001}).reviewReason,'P5B09 one-cent settlement mismatch needs review')
  const paid=await Promise.all([accountReceipt(c,null,request,e,actor),accountReceipt(c,null,request,e,actor)])
  r.check(paid[0].entryId===paid[1].entryId&&(await balanceOf(invoiceId)).balance===0n,'P5B10 concurrent economic receipt is posted/applied exactly once')
  const payout=await retainProcessorFact(c,null,null,{kind:'payout',objectId:'po_P5PayoutA',payoutId:'po_P5PayoutA',amount:97000n,currency:'CAD',occurredAt:e.occurredAt,details:{providerStatus:'paid'}})
  const bank=await accountProcessorMovement(ledgerId,payout.id,actor)
  const [clearing]=await db.execute<{amount:string}>(sql`SELECT COALESCE(sum(jl.amount),0)::text AS amount FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id WHERE je.ledger_id=${ledgerId}::uuid AND je.status='posted' AND jl.account_id=${co.at('1100')}::uuid`)
  const [fees]=await db.execute<{n:string;amount:string}>(sql`SELECT count(*)::text AS n,COALESCE(sum(jl.amount),0)::text AS amount FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id WHERE je.ledger_id=${ledgerId}::uuid AND je.status='posted' AND jl.account_id=${co.at('5000')}::uuid`)
  r.check(bank.status==='posted'&&clearing.amount==='0'&&fees.amount==='3000'&&fees.n==='1','P5B11 real journals clear 1000 gross minus 30 fee minus 970 payout to zero')
  const [revenue]=await db.execute<{amount:string}>(sql`SELECT sum(jl.amount)::text AS amount FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id WHERE je.ledger_id=${ledgerId}::uuid AND je.status='posted' AND jl.account_id=${co.at('4000')}::uuid`)
  r.check(revenue.amount==='-100000','P5B12 receipt, fee and payout do not recognize revenue twice')

  await importBankRows({accountId:co.at('1000'),actor:owner.email,rows:[{date:'2026-10-01',amount:97000n,description:'Stripe actual payout po_P5PayoutA'}]})
  const bankRow=(await bankRows(co.at('1000'))).find(b=>b.description==='Stripe actual payout po_P5PayoutA')!
  await matchEntry({bankTransactionId:bankRow.id,entryId:bank.entryId!,actor:owner.email})
  r.check((await matchesFor(bankRow.id)).length===1,'P5B26 payout journal matches the real existing bank CSV workflow')
  r.check(!!graph(request,request.payment_intent_id!,100000,'usd',0).evidence().reviewReason,'P5B27 graph directly marks unsupported currency before any accounting')
  r.check(!!receiptEvidence(c,request,g.session,g.pi,g.charge,{...g.balance!,fee_details:[{type:'tax',amount:300,currency:'cad',application:null,description:'Local tax protocol fixture'}]}).reviewReason,'P5B32 actual tax-bearing processor fee requires current tax-code review rather than a blind expense')
  const replay=await accountProcessorMovement(ledgerId,payout.id,actor)
  r.check(replay.entryId===bank.entryId,'P5B13 payout replay reuses the existing economic entry')
  await no('P5B14 retained amount cannot be rewritten','P5_ECONOMIC_FACT_IMMUTABLE',()=>db.execute(sql`UPDATE processor_transaction SET amount=amount+1 WHERE id=${paid[0].id}::uuid`))
  await no('P5B15 received processor facts cannot be deleted','P5_FACT_IMMUTABLE',()=>db.execute(sql`DELETE FROM processor_transaction WHERE id=${paid[0].id}::uuid`))
  const refund=await retainProcessorFact(c,null,request,{kind:'refund',objectId:'re_P5RefundA',paymentIntentId:e.paymentIntentId,balanceId:'txn_P5RefundA',amount:25000n,currency:'CAD',occurredAt:e.occurredAt,details:{providerStatus:'succeeded',providerFee:'0',providerNet:'-25000',exchangeRate:null}})
  const refunded=await accountProcessorMovement(ledgerId,refund.id,actor)
  r.check(refunded.status==='posted'&&(await balanceOf(invoiceId)).balance===25000n,'P5B16 confirmed refund releases original application and posts exact clearing/AR movement')
  const feeRefund=await retainProcessorFact(c,null,request,{kind:'refund',objectId:'re_P5FeeReturn',paymentIntentId:e.paymentIntentId,balanceId:'txn_P5FeeReturn',amount:10000n,currency:'CAD',occurredAt:e.occurredAt,details:{providerStatus:'succeeded',providerFee:'-300',providerNet:'-9700',exchangeRate:null}})
  const feeReturned=await accountProcessorMovement(ledgerId,feeRefund.id,actor)
  const [refundLines]=await db.execute<{clearing:string;fee:string}>(sql`SELECT COALESCE(sum(amount) FILTER(WHERE account_id=${co.at('1100')}::uuid),0)::text AS clearing,COALESCE(sum(amount) FILTER(WHERE account_id=${co.at('5000')}::uuid),0)::text AS fee FROM journal_line WHERE entry_id=${feeReturned.entryId!}::uuid`)
  r.check(feeReturned.status==='posted'&&refundLines.clearing==='-9700'&&refundLines.fee==='-300'&&(await balanceOf(invoiceId)).balance===35000n,'P5B30 actual signed refund fee return and net are posted without guessing zero')
  r.check((await portalInvoice(opened.session,invite.id)).paymentReview,'P5B17 portal exposes refund review without provider-private data')
  const excessId=await co.invoice('P5-EXCESS'),quote=async(id:string,pi:string)=>{
    const invitation=await inviteInvoice(ledgerId,id,actor,await version(id)),session=await exchangeInvitation(invitation.id,invitation.url.split('#')[1]),saved=await reserveCheckout(invitation.id,session.session)
    await db.execute(sql`UPDATE checkout_request SET stripe_checkout_id=${'cs_test_'+pi},payment_intent_id=${pi},status='open' WHERE id=${saved.r.id}::uuid`)
    return {...saved.r,stripe_checkout_id:'cs_test_'+pi,payment_intent_id:pi,status:'open'}
  }
  const excess=await quote(excessId,'pi_P5Excess');await recordPayment({invoiceId:excessId,bankAccountId:co.at('1000'),amount:20000n,paidOn:'2026-10-01',actor:owner.email})
  const [invalidated]=await db.execute<{status:string}>(sql`SELECT status FROM checkout_request WHERE id=${excess.id}::uuid`)
  r.check(invalidated.status==='invalidated','P5B31 current partial manual payment invalidates the old provider quote immediately')
  const over=await accountReceipt(c,null,excess,graph(excess,excess.payment_intent_id!,100000,'cad',0).evidence(),actor)
  const held=await unappliedReceipts(ledgerId,co.customer.id,'sales')
  r.check(over.status==='posted'&&(await balanceOf(excessId)).balance===0n&&held.some(h=>h.entry_id===over.entryId&&h.unapplied===20000n),'P5B18 true overpayment is retained as 200 CAD unapplied credit')
  const manualId=await co.invoice('P5-MANUAL'),manual=await quote(manualId,'pi_P5Manual')
  const old=await recordPayment({invoiceId:manualId,bankAccountId:co.at('1100'),amount:100000n,paidOn:'2026-10-01',reference:manual.payment_intent_id!,actor:owner.email})
  const matched=await accountReceipt(c,null,manual,graph(manual,manual.payment_intent_id!,100000,'cad',0).evidence(),actor)
  r.check(matched.status==='matched'&&matched.entryId===old.entryId,'P5B19 exact existing manual Stripe reference prevents duplicate receipt')

  const lateId=await co.invoice('P5-LATEFEE'),lateRequest=await quote(lateId,'pi_P5LateFee'),lateGraph=graph(lateRequest,lateRequest.payment_intent_id!,100000,'cad',3000)
  const firstMoney=await accountReceipt(c,null,lateRequest,receiptEvidence(c,lateRequest,lateGraph.session,lateGraph.pi,lateGraph.charge,null),actor)
  const [noFee]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM processor_transaction WHERE payment_intent_id=${lateRequest.payment_intent_id} AND kind='fee'`)
  const laterMoney=await accountReceipt(c,null,lateRequest,lateGraph.evidence(),actor)
  const [lateFee]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM processor_transaction WHERE payment_intent_id=${lateRequest.payment_intent_id} AND kind='fee' AND entry_id IS NOT NULL`)
  r.check(noFee.n===0&&lateFee.n===1&&firstMoney.entryId===laterMoney.entryId,'P5B28 delayed actual fee is posted once without guessing zero or reposting money')
  const journalId=await co.invoice('P5-JOURNALREF'),journalRequest=await quote(journalId,'pi_P5ManualJournal')
  await postEntry({ledgerId,entryDate:'2026-10-01',actor:owner.email,description:'Manual prior Stripe (pi_P5ManualJournal)',lines:[{accountId:co.at('1100'),amount:100000n},{accountId:co.at('1200'),amount:-100000n,partyId:co.customer.id}]})
  r.check((await accountReceipt(c,null,journalRequest,graph(journalRequest,journalRequest.payment_intent_id!,100000,'cad',0).evidence(),actor)).status==='needs_accounting_review','P5B29 general journal reference is retained for review rather than duplicated')
  const wrongId=await co.invoice('P5-WRONGREF'),wrong=await quote(wrongId,'pi_P5WrongRef')
  await recordPayment({invoiceId:wrongId,bankAccountId:co.at('1000'),amount:100000n,paidOn:'2026-10-01',reference:wrong.payment_intent_id!,actor:owner.email})
  r.check((await accountReceipt(c,null,wrong,graph(wrong,wrong.payment_intent_id!,100000,'cad',0).evidence(),actor)).status==='needs_accounting_review','P5B20 differing manual reference accounts preserve receipt for review')
  const foreignId=await co.invoice('P5-FX'),foreign=await quote(foreignId,'pi_P5FX')
  const fx=await accountReceipt(c,null,foreign,graph(foreign,foreign.payment_intent_id!,100000,'usd',0).evidence(),actor)
  r.check(fx.status==='needs_accounting_review'&&(await balanceOf(foreignId)).balance===100000n,'P5B21 wrong currency retains true provider fact without inferred FX/posting')
  const changedId=await co.invoice('P5-CHANGED'),changed=await quote(changedId,'pi_P5Changed')
  await editInvoice(changedId,{partyId:co.customer.id,controlAccountId:co.at('1200'),issuedOn:'2026-10-01',dueOn:'2026-10-31',lines:[{accountId:co.at('4000'),amount:-90000n,description:'Corrected service'}],actor:owner.email})
  r.check((await accountReceipt(c,null,changed,graph(changed,changed.payment_intent_id!,100000,'cad',0).evidence(),actor)).status==='needs_accounting_review','P5B22 receipt for corrected invoice version requires reconciliation')
  const changedInvite=await inviteInvoice(ledgerId,changedId,actor,await version(changedId)),changedSession=await exchangeInvitation(changedInvite.id,changedInvite.url.split('#')[1])
  await voidInvoice(changedId,{reason:'P5 isolated void test',actor:owner.email})
  r.check((await portalInvoice(changedSession.session,changedInvite.id)).status==='void','P5B23 invitation sees current void state')
  await no('P5B24 void invoice cannot offer its old PDF','unavailable',()=>portalPdf(changedSession.session,changedInvite.id))
  const sameCaseRace=await concurrentPortalRevocation(ledgerId,changedInvite.id,owner.id,actor,()=>portalInvoice(changedSession.session,changedInvite.id))
  r.check(sameCaseRace.revokeAtLiveAuth&&sameCaseRace.readAtPortalLock&&sameCaseRace.revoked&&sameCaseRace.readRefused&&!sameCaseRace.deadlock,'P5B25a concurrent issuer revocation completes and status is refused without deadlock',JSON.stringify(sameCaseRace))
  for(const mode of ['status','exchange'] as const){
    const mixedInvite=await inviteInvoice(ledgerId,invoiceId,actor,await version(invoiceId)),mixedSecret=mixedInvite.url.split('#')[1],mixedSession=await exchangeInvitation(mixedInvite.id.toUpperCase(),mixedSecret)
    const mixedRace=await concurrentPortalRevocation(ledgerId,mixedInvite.id,owner.id,actor,()=>mode==='status'?portalInvoice(mixedSession.session,mixedInvite.id.toUpperCase()):exchangeInvitation(mixedInvite.id.toUpperCase(),mixedSecret))
    r.check(mixedRace.revokeAtLiveAuth&&mixedRace.readAtPortalLock&&mixedRace.revoked&&mixedRace.readRefused&&!mixedRace.deadlock,'P5B25-'+mode+' uppercase customer UUID and lowercase issuer revocation share the same lock',JSON.stringify(mixedRace))
  }
  await no('P5B25 revocation invalidates already-open portal session','unavailable',()=>portalInvoice(changedSession.session,changedInvite.id))
  const event={id:'evt_P5Signed',type:'payment_intent.succeeded',livemode:false,api_version:Stripe.API_VERSION,data:{object:{id:e.paymentIntentId,object:'payment_intent',amount_received:100000,currency:'cad',status:'succeeded',customer:{id:'cus_Private',email:'private@example.test'},billing_details:{name:'Private'}}}} as unknown as Stripe.Event
  const raw=Buffer.from(JSON.stringify(event)),signature=Stripe.webhooks.generateTestHeaderString({payload:raw.toString(),secret:webhook})
  const minimal=verifyStripeBody(c,raw,signature)
  r.check(!JSON.stringify(minimal).includes('private@example.test')&&!JSON.stringify(minimal).includes('billing_details'),'P5C01 signed protocol fixture is minimized without billing/card data')
  await no('P5C02 modified original body fails official signature verification','Invalid payment',()=>receiveStripe(c.id,Buffer.concat([raw,Buffer.from(' ')]),signature))
  const first=await receiveStripe(c.id,raw,signature),again=await receiveStripe(c.id,raw,signature)
  r.check(first.id===again.id&&again.duplicate,'P5C03 event delivery dedupe returns same durable event')
  const [job]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM background_job WHERE payment_event_id=${first.id}::uuid`)
  r.check(job.n===1,'P5C04 event acknowledgement has one committed durable task')
  await db.execute(sql`UPDATE payment_connection SET enabled=false WHERE id=${c.id}::uuid`)
  const late={...event,id:'evt_P5AfterDisable'},lateRaw=Buffer.from(JSON.stringify(late)),lateSig=Stripe.webhooks.generateTestHeaderString({payload:lateRaw.toString(),secret:webhook})
  r.check(!(await receiveStripe(c.id,lateRaw,lateSig)).duplicate,'P5C05 disabling new payments still retains authentic existing callbacks')
  await db.execute(sql`UPDATE payment_connection SET enabled=true WHERE id=${c.id}::uuid`)
  await no('P5C06 cross-mode signed event refused','merchant and mode',async()=>verifyStripeBody(c,Buffer.from(JSON.stringify({...event,livemode:true})),Stripe.webhooks.generateTestHeaderString({payload:JSON.stringify({...event,livemode:true}),secret:webhook})))
  await no('P5C07 signed duplicate event facts cannot be rewritten','P5_FACT_IMMUTABLE',()=>db.execute(sql`UPDATE payment_event SET event_type='other' WHERE id=${first.id}::uuid`))

  await no('P5C08 expired official signature rejected','Invalid payment',()=>receiveStripe(c.id,raw,Stripe.webhooks.generateTestHeaderString({payload:raw.toString(),secret:webhook,timestamp:Math.floor(Date.now()/1000)-600})))
  const changedEvent=Buffer.from(JSON.stringify({...event,data:{object:{...event.data.object,amount_received:100001}}}))
  await no('P5C09 same event ID with changed minimal facts cannot overwrite','different facts',()=>receiveStripe(c.id,changedEvent,Stripe.webhooks.generateTestHeaderString({payload:changedEvent.toString(),secret:webhook})))
  const parallelEvent=Buffer.from(JSON.stringify({...event,id:'evt_P5Parallel'})),parallelSig=Stripe.webhooks.generateTestHeaderString({payload:parallelEvent.toString(),secret:webhook})
  const concurrentEvents=await Promise.all([receiveStripe(c.id,parallelEvent,parallelSig),receiveStripe(c.id,parallelEvent,parallelSig)])
  r.check(concurrentEvents[0].id===concurrentEvents[1].id&&concurrentEvents.filter(v=>v.duplicate).length===1,'P5C10 concurrent signed deliveries retain one event and durable job')
  const limitedInvite=await inviteInvoice(ledgerId,foreignId,actor,await version(foreignId)),limitedToken=limitedInvite.url.split('#')[1]
  const sessions=await Promise.allSettled(Array.from({length:22},()=>exchangeInvitation(limitedInvite.id,limitedToken)))
  r.check(sessions.filter(v=>v.status==='fulfilled').length===20&&sessions.filter(v=>v.status==='rejected').length===2,'P5C11 concurrent valid-token session exchanges enforce the actual 20-session budget')
  await db.execute(sql`UPDATE portal_invitation SET expires_at=created_at+interval '1 second' WHERE id=${limitedInvite.id}::uuid`)
  await new Promise(resolve=>setTimeout(resolve,1100))
  await no('P5C12 expiry invalidates invitation and retained portal session','unavailable',()=>exchangeInvitation(limitedInvite.id,limitedToken))
  process.env.INBOUND_MAIL_ENABLED='true';process.env.POSTMARK_INGRESS_IP_FILTER_CONFIGURED='true'
  const mailInput={providerAccount:'P5ServerA',recipientBase:'P5RouteA@inbound.postmarkapp.com',username:'p5user_'+randomBytes(12).toString('hex'),password:randomBytes(30).toString('base64url')}
  const inbound=await createInboundConnection(ledgerId,actor,mailInput),mailResource={ledgerId,type:'inbound' as const,id:inbound.id}
  await saveInboundConnection(ledgerId,inbound.id,await proof(mailResource),mailInput,false,true)
  const [route]=await db.execute<{alias_address:string}>(sql`SELECT alias_address FROM inbound_connection WHERE id=${inbound.id}::uuid`)
  const auth='Basic '+Buffer.from(mailInput.username+':'+mailInput.password).toString('base64')
  const doc=await PDFDocument.create();doc.addPage([300,300]);const bytes=Buffer.from(await doc.save()),file={Name:'Invoice.pdf',ContentType:'application/pdf',ContentLength:bytes.length,Content:bytes.toString('base64')}
  const payload={MessageID:'P5MailA',OriginalRecipient:route.alias_address,FromFull:{Email:'unknown@example.test'},Subject:'Untrusted supplied subject',HtmlBody:'<img src="https://never-fetch.invalid/tracker">',Attachments:[file,{...file,Name:'Another.pdf'},{Name:'Unsafe.pdf',ContentType:'application/pdf',ContentLength:4,Content:'YmFkIQ=='}]}
  const mailBody=Buffer.from(JSON.stringify(payload))
  await no('P5D01 wrong Basic credentials refused','Invalid inbound',()=>receivePostmark(inbound.id,'Basic '+Buffer.from('wrong:wrong').toString('base64'),mailBody))
  await no('P5D02 authenticated unknown alias refused','alias is unavailable',()=>receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,OriginalRecipient:'foreign@inbound.postmarkapp.com'}))))
  const mail=await receivePostmark(inbound.id,auth,mailBody),repeat=await receivePostmark(inbound.id,auth,mailBody)
  r.check(mail.id===repeat.id&&repeat.duplicate,'P5D03 inbound MessageID/raw-content dedupe does not create duplicate receipts')
  const attachments=await db.execute<{id:string;status:string;inbox_item_id:string|null}>(sql`SELECT id::text,status,inbox_item_id::text FROM inbound_attachment WHERE inbound_message_id=${mail.id}::uuid ORDER BY attachment_no`)
  r.check(attachments.length===3&&attachments[0].inbox_item_id!==null&&attachments[1].inbox_item_id!==null&&attachments[2].status==='rejected','P5D04 multiple safe attachments enter current inbox; malformed PDF has retained refusal')
  const download=await inboundFile(ledgerId,attachments[0].id,actor)
  r.check(download.bytes.equals(bytes),'P5D05 private source download retains exact validated bytes')
  const upload=await uploadInbox(ledgerId,actor,{name:'Uploaded.pdf',type:'application/pdf',bytes},false)
  const [duplicate]=await db.execute<{duplicate_reason:string|null}>(sql`SELECT duplicate_reason FROM inbox_item WHERE id=${upload.id}::uuid`)
  r.check(!!duplicate.duplicate_reason,'P5D06 upload and inbound share real existing duplicate detection')
  await no('P5D07 same MessageID with changed content is refused','different content',()=>receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,Subject:'Changed'}))))
  const empty=await receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,MessageID:'P5Empty',Attachments:[]})))
  const [emptyMessage]=await db.execute<{status:string;note:string}>(sql`SELECT status,note FROM inbound_message WHERE id=${empty.id}::uuid`)
  r.check(emptyMessage.status==='empty'&&emptyMessage.note.includes('No attachments'),'P5D08 empty mail is visible with a reason; remote HTML not processed')
  const spoof=await receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,MessageID:'P5Spoof',ledgerId:other.ledger.id,companyId:other.company.id})))
  const [scope]=await db.execute<{ledger_id:string}>(sql`SELECT ledger_id::text FROM inbound_message WHERE id=${spoof.id}::uuid`)
  r.check(scope.ledger_id===ledgerId,'P5D09 mail-supplied company IDs never authorize another company')
  const invalidLength=await receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,MessageID:'P5Length',Attachments:[{...file,ContentLength:1}]})))
  const [invalidFile]=await db.execute<{status:string}>(sql`SELECT status FROM inbound_attachment WHERE inbound_message_id=${invalidLength.id}::uuid`)
  r.check(invalidFile.status==='rejected','P5D10 attachment declared length disagreement creates rejected source')

  const linkForm=new FormData();linkForm.set('operation','link');linkForm.set('linkType','invoice');linkForm.set('targetId',invoiceId)
  await reviewInbox(ledgerId,attachments[0].inbox_item_id!,actor,await proof({ledgerId,type:'inbox',id:attachments[0].inbox_item_id!}),linkForm)
  const afterConverted=await receivePostmark(inbound.id,auth,mailBody)
  const [conversion]=await db.execute<{status:string;target_invoice_id:string}>(sql`SELECT status,target_invoice_id::text FROM inbox_item WHERE id=${attachments[0].inbox_item_id}::uuid`)
  r.check(afterConverted.duplicate&&conversion.status==='converted'&&conversion.target_invoice_id===invoiceId,'P5D16 converted source replay preserves its existing target and creates no draft')
  const png=readFileSync('src/app/icon.png')
  const inline=await receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,MessageID:'P5Inline',Attachments:[{Name:'Signature.png',ContentType:'image/png',ContentLength:png.length,Content:png.toString('base64'),ContentID:'signature-logo'}]})))
  const [ignored]=await db.execute<{id:string;status:string;inbox_item_id:string|null;sha256:string|null}>(sql`SELECT id::text,status,inbox_item_id::text,sha256 FROM inbound_attachment WHERE inbound_message_id=${inline.id}::uuid`)
  r.check(ignored.status==='ignored'&&ignored.inbox_item_id===null&&!!ignored.sha256&&(await inboundFile(ledgerId,ignored.id,actor)).bytes.equals(png),'P5D17 valid inline image is retained privately with an ignored reason and no inbox receipt')
  const malicious=await PDFDocument.create();malicious.addPage();malicious.catalog.set(PDFName.of('OpenAction'),PDFString.of('unsafe'));const unsafe=Buffer.from(await malicious.save())
  const dangerous=await receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,MessageID:'P5ActivePdf',Attachments:[{Name:'Active.pdf',ContentType:'application/pdf',ContentLength:unsafe.length,Content:unsafe.toString('base64')}]})))
  const [rejected]=await db.execute<{status:string;sha256:string|null}>(sql`SELECT status,sha256 FROM inbound_attachment WHERE inbound_message_id=${dangerous.id}::uuid`)
  r.check(rejected.status==='rejected'&&rejected.sha256===null,'P5D18 active-content PDF is rejected before source storage or accounting')
  const spamMail=await receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,MessageID:'P5Spam',Headers:[{Name:'X-Spam-Status',Value:'Yes'}]})))
  const [quarantine]=await db.execute<{status:string;spam:boolean}>(sql`SELECT status,spam FROM inbound_message WHERE id=${spamMail.id}::uuid`)
  r.check(quarantine.status==='quarantined'&&quarantine.spam,'P5D19 spam marker is retained for manual quarantine and never creates automatic accounting')
  await no('P5D20 transport limit refused with authenticated channel','9 MiB',()=>receivePostmark(inbound.id,auth,Buffer.alloc(9*1024*1024+1)))
  await no('P5D21 too many attachments are explicitly refused','attachment count',()=>receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,MessageID:'P5TooMany',Attachments:Array(11).fill(file)}))))
  await saveInboundConnection(ledgerId,inbound.id,await proof(mailResource),mailInput,true,true)
  r.check((await receivePostmark(inbound.id,auth,mailBody)).duplicate,'P5D11 old known delivery remains idempotent after alias rotation')
  await no('P5D12 unknown message on rotated old alias refused','alias is unavailable',()=>receivePostmark(inbound.id,auth,Buffer.from(JSON.stringify({...payload,MessageID:'P5OldAlias'}))))
  await saveInboundConnection(ledgerId,inbound.id,await proof(mailResource),mailInput,false,false)
  r.check(!!(await uploadInbox(ledgerId,actor,{name:'Manual.pdf',type:'application/pdf',bytes},false)).id,'P5D13 disabling inbound does not disable current manual upload')
  await no('P5D14 unsafe source cannot be downloaded','unavailable',()=>inboundFile(ledgerId,attachments[2].id,actor))
  await no('P5D15 retained message cannot be rewritten','P5_FACT_IMMUTABLE',()=>db.execute(sql`UPDATE inbound_message SET sender='trusted' WHERE id=${mail.id}::uuid`))
  const portable=await exportCompany(co.company.id,{withFiles:true})
  r.check(portable.rows.payment_connection[0].key_ciphertext===null&&portable.rows.payment_connection[0].webhook_ciphertext===null&&portable.rows.inbound_connection[0].password_ciphertext===null,'P5E01 portable file excludes executable provider secrets at export')
  r.check(!portable.rows.portal_invitation&&!portable.rows.portal_session,'P5E02 portable file excludes all invitation/session capabilities')
  const restored=await restoreCompany(portable,owner.email,{code:'P5RESTORE',name:'P5 restored copy'});await restorePaper(portable,restored.name,restored.ledgerId)
  const [restoredSetting]=await db.execute<{enabled:boolean;binding_attached:boolean;key_ciphertext:Buffer|null}>(sql`SELECT enabled,binding_attached,key_ciphertext FROM payment_connection WHERE ledger_id=${restored.ledgerId}::uuid`)
  r.check(!restoredSetting.enabled&&!restoredSetting.binding_attached&&restoredSetting.key_ciphertext===null,'P5E03 real company restore has inert merchant binding and no executable key')
  const restoredFacts=await db.execute<{entry_id:string|null;detached:boolean}>(sql`SELECT entry_id::text,detached FROM processor_transaction WHERE ledger_id=${restored.ledgerId}::uuid`)
  r.check(restoredFacts.length>5&&restoredFacts.every(f=>f.detached)&&restoredFacts.some(f=>f.entry_id),'P5E04 restored economic history is retained and detached, with mapped accounting references')
  const [restoredAttachment]=await db.execute<{id:string}>(sql`SELECT id::text FROM inbound_attachment WHERE ledger_id=${restored.ledgerId}::uuid AND sha256 IS NOT NULL AND mime='application/pdf' LIMIT 1`)
  r.check((await inboundFile(restored.ledgerId!,restoredAttachment.id,actor)).bytes.equals(bytes),'P5E05 restored inbound private bytes are readable through current scope')
  await no('P5E06 company with retained money/mail facts cannot be deleted','Archive',()=>deleteCompany(co.company.id,owner.email))
  const lockId=await co.invoice('P5-LOCK'),locked=await quote(lockId,'pi_P5Locked')
  const [period]=await db.execute<{id:string}>(sql`SELECT id::text FROM fiscal_period WHERE ledger_id=${ledgerId}::uuid AND '2026-10-01'::date BETWEEN start_date AND end_date`)
  await closePeriod(ledgerId,period.id,{actor:owner.email,overrideReason:'Confirmed isolated P5 fixture'})
  const blocked=await accountReceipt(c,null,locked,graph(locked,locked.payment_intent_id!,100000,'cad',0).evidence(),actor)
  const [blockedFact]=await db.execute<{occurred_at:string;entry_id:string|null}>(sql`SELECT occurred_at::text,entry_id::text FROM processor_transaction WHERE id=${blocked.id}::uuid`)
  r.check(blocked.status==='needs_accounting_review'&&!blockedFact.entry_id&&new Date(blockedFact.occurred_at).toISOString()===e.occurredAt,'P5E07 locked original receipt date retains true fact without substituting today')

  const mappingFixture=await buildP5Lifecycle(owner.email,token,'P5MAP')
  const [mappedFee]=await db.execute<{id:string}>(sql`SELECT id::text FROM account WHERE entity_id=${mappingFixture.entityId}::uuid AND code='5000'`)
  const [mappedRequest]=await db.execute<CheckoutRequest>(sql`SELECT ${sql.raw(checkoutColumns)} FROM checkout_request WHERE id=${mappingFixture.requestId}::uuid`),mappedConnection=await connectionById(mappingFixture.paymentConnectionId)
  await updateAccount(mappedFee.id,{accountType:'asset'},owner.email,mappingFixture.ledgerId)
  try{
    await no('P5B33 actual unused fee-account reclassification blocks new quotes','classification changed',()=>reserveCheckout(mappingFixture.invitationId,mappingFixture.session))
    const mappedReceipt=await accountReceipt(mappedConnection,null,mappedRequest,graph(mappedRequest,mappedRequest.payment_intent_id!,100000,'cad',0,mappedConnection).evidence(),actor)
    r.check(mappedReceipt.status==='needs_accounting_review'&&!mappedReceipt.entryId&&'reason' in mappedReceipt&&mappedReceipt.reason.includes('classification changed')&&(await balanceOf(mappingFixture.invoiceId)).balance===100000n,'P5B34 current mapping refusal retains funds without posting or applying the receipt')
    const mappedPayout=await retainProcessorFact(mappedConnection,null,null,{kind:'payout',objectId:'po_P5MapChanged',payoutId:'po_P5MapChanged',amount:100000n,currency:'CAD',occurredAt:e.occurredAt,details:{providerStatus:'paid'}})
    const mappedMovement=await accountProcessorMovement(mappingFixture.ledgerId,mappedPayout.id,actor)
    r.check(mappedMovement.status==='needs_accounting_review'&&!mappedMovement.entryId&&'reason' in mappedMovement&&mappedMovement.reason.includes('classification changed'),'P5B35 current mapping refusal retains payout facts without posting an incorrectly classified movement')
  }finally{await updateAccount(mappedFee.id,{accountType:'expense'},owner.email,mappingFixture.ledgerId)}

  const secondary=await createUser({email:'p5-revoked-owner@example.test',password,firstName:'P5 revoked owner',kind:'owner',actor:owner.email}),secondarySession=await signIn({email:secondary.email,password,clientIp:'192.0.2.56'})
  const revokedFixture=await buildP5Lifecycle(secondary.email,secondarySession.token,'P5REVOKED')
  const [revokedRequest]=await db.execute<CheckoutRequest>(sql`SELECT ${sql.raw(checkoutColumns)} FROM checkout_request WHERE id=${revokedFixture.requestId}::uuid`),revokedConnection=await connectionById(revokedFixture.paymentConnectionId)
  await setUserStatus({userId:secondary.id,isActive:false,actor:owner.email})
  await no('P5E12 revoking invitation authorizer closes the already-open customer session','unavailable',()=>portalInvoice(revokedFixture.session,revokedFixture.invitationId))
  const revokedMoney=await accountReceipt(revokedConnection,null,revokedRequest,graph(revokedRequest,revokedRequest.payment_intent_id!,100000,'cad',0,revokedConnection).evidence(),{source:'job',userId:secondary.id,requestId:randomUUID()})
  r.check(revokedMoney.status==='needs_accounting_review'&&(await balanceOf(revokedFixture.invoiceId)).balance===100000n,'P5E13 revoked worker authorizer preserves actual funds without posting')
  const [revokedMail]=await db.execute<{username_ciphertext:Buffer;password_ciphertext:Buffer;alias_address:string}>(sql`SELECT username_ciphertext,password_ciphertext,alias_address FROM inbound_connection WHERE id=${revokedFixture.inboundConnectionId}::uuid`)
  const revokedAuth='Basic '+Buffer.from(openIntegration(revokedMail.username_ciphertext,revokedFixture.inboundConnectionId,'postmark-user')+':'+openIntegration(revokedMail.password_ciphertext,revokedFixture.inboundConnectionId,'postmark-password')).toString('base64')
  const delivered=await receivePostmark(revokedFixture.inboundConnectionId,revokedAuth,Buffer.from(JSON.stringify({...payload,MessageID:'P5RevokedChannel',OriginalRecipient:revokedMail.alias_address})))
  const [revokedMessage]=await db.execute<{status:string;n:number}>(sql`SELECT status,(SELECT count(*)::int FROM inbound_attachment WHERE inbound_message_id=m.id AND inbox_item_id IS NOT NULL) AS n FROM inbound_message m WHERE id=${delivered.id}::uuid`)
  r.check(revokedMessage.status==='quarantined'&&revokedMessage.n===0,'P5E14 authenticated revoked channel retains source facts without impersonating a user or creating inbox drafts')
  await archiveCompany(co.company.id,'P5 isolated archived fixture',owner.email)
  await no('P5E08 archive immediately closes existing customer sessions','unavailable',()=>portalInvoice(opened.session,invite.id))
  const archivedEvent=Buffer.from(JSON.stringify({...event,id:'evt_P5Archived'}))
  r.check(!(await receiveStripe(c.id,archivedEvent,Stripe.webhooks.generateTestHeaderString({payload:archivedEvent.toString(),secret:webhook}))).duplicate,'P5E09 authentic archived-company callbacks are durably retained')
  await db.transaction(tx=>pauseRestoredAutomation(tx))
  const [paused]=await db.execute<{enabled:boolean;binding_attached:boolean;n:number}>(sql`SELECT enabled,binding_attached,(SELECT count(*)::int FROM portal_session WHERE revoked_at IS NULL) AS n FROM payment_connection WHERE id=${c.id}::uuid`)
  r.check(!paused.enabled&&!paused.binding_attached&&paused.n===0,'P5E10 actual restore boundary disables integrations and revokes all live portal sessions')
  r.check((await inboundOverview(other.ledger.id,actor)).messages.length===0,'P5E11 other company sees none of the inbound message facts')
}
main().catch(error=>{r.fail('P5 execution',errorText(error).slice(0,1600));process.exitCode=1}).finally(async()=>{console.log(r.summary());if(r.failures)process.exitCode=1;await connection.end()})

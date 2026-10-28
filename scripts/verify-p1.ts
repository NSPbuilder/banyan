import './env'
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {sql} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {reporter} from './suite'
import {causesOf} from '../src/lib/db-errors'
import {createFirstOwner,createUser,signIn,signOut,userForToken,setPassword} from '../src/lib/users'
import {setGrants} from '../src/lib/access'
import {closePeriod,periodOverview,reopenPeriod} from '../src/lib/periods'
import {authAttempt,manageMfa,reauthenticate} from '../src/lib/auth-security'
import {totp,decryptMfa} from '../src/lib/totp'
import {trustedClientIp} from '../src/lib/auth-client'
import {editLease,withDocumentWrite,EditConflict} from '../src/lib/edit-leases'
import type {EditContext,EditProof,EditResource} from '../src/lib/edit-proof'
import {leaseClientTiming} from '../src/lib/edit-proof'
import {createCompany,createFiscalYear} from '../src/lib/setup'
import {importAccounts,parseAccountsCsv} from '../src/lib/accounts'
import {createParty} from '../src/lib/parties'
import {createInvoice,editInvoice,invoiceDetail,postInvoice} from '../src/lib/invoices'
import {recordPayment} from '../src/lib/payments'
import {saveDraft,postEntry} from '../src/lib/posting'
import {parseMoney} from '../src/lib/money'

const r=reporter(64),PW='P1 isolated fixture password sentence'
process.env.AUTH_MFA_KEY ??= randomBytes(32).toString('base64')
process.env.ATTACHMENTS_DIR=mkdtempSync(join(tmpdir(),'figtree-p1-paper-'))
async function refused(label:string,fn:()=>Promise<unknown>,status?:number,includes?:string){
  try{await fn();r.fail(label,'Unexpected success')}catch(e){
    const evidence=causesOf(e)+' '+(e && typeof e==='object' && 'code' in e ? String(e.code) : '')
    const ok=status?e instanceof EditConflict && e.status===status:includes?evidence.includes(includes):true
    r.check(ok,label,ok?'refused atomically':causesOf(e).slice(0,160))
  }
}
async function main(){
  const target=new URL(process.env.DATABASE_URL!).pathname
  if(!target.endsWith('_test') || !process.env.TEST_DATABASE_URL)throw new Error('P1 tests require isolated TEST_DATABASE_URL')
  r.check(totp(Buffer.from('12345678901234567890'),59,8)==='94287082','P1A01 RFC 6238 SHA1 independent vector')
  r.check(parseMoney('9007199254740993.17')===900719925474099317n,'P1A02 integer money above safe float range')
  process.env.NEXT_PUBLIC_EDIT_HEARTBEAT_SECONDS='15';process.env.NEXT_PUBLIC_EDIT_IDLE_MINUTES='2'
  r.check(leaseClientTiming().heartbeatMs===15000 && leaseClientTiming().idleMs===120000,'P1E26 configurable public heartbeat and idle timing')
  delete process.env.NEXT_PUBLIC_EDIT_HEARTBEAT_SECONDS;delete process.env.NEXT_PUBLIC_EDIT_IDLE_MINUTES
  delete process.env.AUTH_TRUSTED_IP_HEADER
  r.check(trustedClientIp(new Headers({'x-real-ip':'192.0.2.1'}))==='unconfigured','P1A03 proxy headers are not trusted implicitly')
  process.env.AUTH_TRUSTED_IP_HEADER='x-real-ip'
  r.check(trustedClientIp(new Headers({'x-real-ip':'192.0.2.1'}))==='192.0.2.1','P1A04 explicitly configured proxy identity')
  delete process.env.AUTH_TRUSTED_IP_HEADER
  process.env.AUTH_PAIR_LIMIT='2';process.env.AUTH_ACCOUNT_LIMIT='3';process.env.AUTH_IP_LIMIT='4'
  await authAttempt('login','missing@example.test','192.0.2.10');await authAttempt('login','missing@example.test','192.0.2.10')
  await refused('P1A05 shared persistent pair limit',()=>authAttempt('login','missing@example.test','192.0.2.10'))
  await authAttempt('login','one@example.test','192.0.2.10')
  await refused('P1A06 IP aggregate limit across accounts',()=>authAttempt('login','two@example.test','192.0.2.10'))
  await refused('P1A07 account aggregate across IPs',()=>authAttempt('login','missing@example.test','192.0.2.11'))
  await db.execute(sql`UPDATE auth_rate_bucket SET expires_at=clock_timestamp()-interval '1 second'`)
  await authAttempt('login','missing@example.test','192.0.2.10');r.pass('P1A08 expiry permits retries without permanent lock')
  delete process.env.AUTH_PAIR_LIMIT;delete process.env.AUTH_ACCOUNT_LIMIT;delete process.env.AUTH_IP_LIMIT
  const owner=await createFirstOwner({email:'p1-owner@example.test',firstName:'P1 Owner',password:PW})
  const peer=await createUser({email:'p1-peer@example.test',firstName:'P1 Peer',password:PW,kind:'owner',actor:owner.email})
  const limited=await createUser({email:'p1-limited@example.test',firstName:'P1 Limited',password:PW,actor:owner.email})
  const a=await signIn({email:owner.email,password:PW,clientIp:'192.0.2.20'})
  const b=await signIn({email:peer.email,password:PW,clientIp:'192.0.2.21'})
  const c=await signIn({email:limited.email,password:PW,clientIp:'192.0.2.22'})
  await refused('P1A27 sensitive reset retains current user hierarchy inside transaction',()=>setPassword({userId:owner.id,password:PW+' changed',actor:peer.email,sessionToken:b.token}),undefined,'OUTRANKED')
  const co=await createCompany({code:'P1',name:'P1 isolated company'},owner.email)
  await setGrants({userId:limited.id,entityIds:[co.company.id],modules:['/invoices'],actor:owner.email})
  await createFiscalYear(co.ledger.id,'2026-12-31',owner.email)
  const accounts=await importAccounts(co.company.id,parseAccountsCsv(`1000,Cash,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
2000,Payables,liability,,trade_payables
4000,Revenue,revenue,,revenue_from_contracts
5000,Expenses,expense,,other_operating_expenses`).map(v=>({...v,entityId:co.company.id})),owner.email)
  const at=(code:string)=>accounts.find(x=>x.code===code)!.id
  const customer=await createParty({kind:'organisation',name:'P1 customer',roles:[{entityId:co.company.id,role:'customer',heldFrom:'2026-01-01'}],actor:owner.email})
  const supplier=await createParty({kind:'organisation',name:'P1 supplier',roles:[{entityId:co.company.id,role:'supplier',heldFrom:'2026-01-01'}],actor:owner.email})
  const input={ledgerId:co.ledger.id,direction:'sales' as const,partyId:customer.id,controlAccountId:at('1200'),issuedOn:'2026-10-07',dueOn:'2026-11-07',lines:[{accountId:at('4000'),amount:-10000n}],actor:owner.email}
  const inv=await createInvoice(input)
  const resource:EditResource={ledgerId:co.ledger.id,type:'invoice',id:inv.id}
  const version=()=>db.execute<{version:string}>(sql`SELECT version::text FROM invoice WHERE id=${inv.id}::uuid`).then(x=>x[0].version)
  const original=await version()
  const pa:EditProof={version:original,tabId:randomUUID()}
  const la=await editLease(resource,a.token,'acquire',pa);Object.assign(pa,la)
  const pb:EditProof={version:original,tabId:randomUUID()}
  await refused('P1E01 second user cannot silently acquire',()=>editLease(resource,b.token,'acquire',pb),423)
  await refused('P1E02 same user in another tab is separate',()=>editLease(resource,a.token,'acquire',{version:original,tabId:randomUUID()}),423)
  const lb=await editLease(resource,b.token,'takeover',pb);Object.assign(pb,lb)
  const ctx=(proof:EditProof,sessionToken=b.token,leaseRequired=true):EditContext=>({proof,sessionToken,leaseRequired})
  const change=(on:Parameters<Parameters<typeof db.transaction>[0]>[0],actor:string)=>editInvoice(inv.id,{...input,note:'new P1 note',actor},on)
  await refused('P1E03 old holder save rejected after takeover',()=>withDocumentWrite(resource,ctx(pa,a.token),change),423)
  await refused('P1E04 late heartbeat rejected',()=>editLease(resource,a.token,'heartbeat',pa),423)
  await editLease(resource,a.token,'release',pa)
  const [live]=await db.execute<{holder:string}>(sql`SELECT holder_user_id::text AS holder FROM document_edit_lease WHERE invoice_id=${inv.id}::uuid`)
  r.check(live.holder===peer.id,'P1E05 late release cannot release new holder')
  const saved=await withDocumentWrite(resource,ctx(pb),change)
  r.check(BigInt(saved.version!)>BigInt(original),'P1E06 version advances with controlled domain edit')
  await refused('P1E07 stale read version rejects even valid lease',()=>withDocumentWrite(resource,ctx(pb),change),409)
  await refused('P1E08 missing version never defaults to latest',()=>withDocumentWrite(resource,ctx({...pb,version:''}),change),409)
  pb.version=saved.version!
  const before=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM audit_log WHERE record_id=${inv.id}`)
  await refused('P1E09 failed command rolls back document and audit',()=>withDocumentWrite(resource,ctx(pb),async(tx,actor)=>{await change(tx,actor);throw Error('injected commit refusal')}),undefined,'injected commit refusal')
  const after=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM audit_log WHERE record_id=${inv.id}`)
  r.check(await version()===pb.version && before[0].n===after[0].n,'P1E10 rollback has no partial accounting evidence')
  await withDocumentWrite(resource,ctx(pb), (tx,actor)=>postInvoice(inv.id,actor,tx))
  pb.version=await version()
  await recordPayment({invoiceId:inv.id,bankAccountId:at('1000'),amount:100n,paidOn:'2026-10-07',actor:owner.email})
  r.check(BigInt(await version())>BigInt(pb.version),'P1E11 settlement bypasses human lease and invalidates version')
  await refused('P1E12 old form cannot undo new payment',()=>withDocumentWrite(resource,ctx(pb),change),409)
  pb.version=await version()
  const settlementRace=await Promise.allSettled([
    recordPayment({invoiceId:inv.id,bankAccountId:at('1000'),amount:100n,paidOn:'2026-10-07',actor:owner.email}),
    withDocumentWrite(resource,ctx(pb),change),
  ])
  r.check(settlementRace[0].status==='fulfilled' && (settlementRace[1].status==='fulfilled' || settlementRace[1].reason instanceof EditConflict && settlementRace[1].reason.status===409),'P1E24 simultaneous settlement/save obey transaction ordering')
  const [settled]=await db.execute<{amount:string}>(sql`SELECT sum(amount)::text AS amount FROM invoice_application WHERE invoice_id=${inv.id}::uuid`)
  r.check(settled.amount==='200' && (await invoiceDetail(inv.id))!.total===10000n,'P1E25 racing save preserves real settlement and exact invoice total')
  pb.version=await version()
  await db.execute(sql`UPDATE document_edit_lease SET expires_at=clock_timestamp()-interval '1 second' WHERE invoice_id=${inv.id}::uuid`)
  await refused('P1E13 expired lease save rejected',()=>withDocumentWrite(resource,ctx(pb),change),423)
  const replacement=await editLease(resource,b.token,'acquire',pb);Object.assign(pb,replacement)
  await refused('P1E14 limited user cannot take over',()=>editLease(resource,c.token,'takeover',{version:pb.version,tabId:randomUUID()}),403)
  const other=await createCompany({code:'P1OTHER',name:'P1 other company'},owner.email)
  await refused('P1E15 resource membership is checked',()=>editLease({...resource,ledgerId:other.ledger.id},a.token,'acquire',pa),403)
  await refused('P1E16 direct cross-ledger lease SQL rejected',()=>db.execute(sql`UPDATE document_edit_lease SET ledger_id=${other.ledger.id}::uuid WHERE invoice_id=${inv.id}::uuid`),undefined,'EDIT_LEASE_SCOPE')
  const bill=await createInvoice({...input,direction:'purchase',partyId:supplier.id,controlAccountId:at('2000'),lines:[{accountId:at('5000'),amount:577n}]})
  const br:EditResource={...resource,id:bill.id}
  const bd=await invoiceDetail(bill.id),bp:EditProof={version:bd!.invoice.version!,tabId:randomUUID()}
  Object.assign(bp,await editLease(br,a.token,'acquire',bp))
  await withDocumentWrite(br,ctx(bp,a.token),(tx,actor)=>editInvoice(bill.id,{...input,partyId:supplier.id,controlAccountId:at('2000'),lines:[{accountId:at('5000'),amount:578n}],actor},tx))
  r.check((await invoiceDetail(bill.id))!.total===578n,'P1E17 supplier bill uses same protected domain command')
  const draft=await saveDraft({ledgerId:co.ledger.id,entryDate:'2026-10-07',description:'P1 manual',actor:owner.email,lines:[{accountId:at('1000'),amount:577n},{accountId:at('4000'),amount:-577n}]})
  const er:EditResource={ledgerId:co.ledger.id,type:'entry',id:draft.id},ep:EditProof={version:String(draft.version),tabId:randomUUID()}
  Object.assign(ep,await editLease(er,a.token,'acquire',ep))
  const dsave=await withDocumentWrite(er,ctx(ep,a.token),(tx,actor)=>saveDraft({ledgerId:co.ledger.id,entryDate:'2026-10-07',description:'changed draft',actor,lines:[{accountId:at('1000'),amount:578n},{accountId:at('4000'),amount:-578n}]},draft.id,tx))
  r.check(BigInt(dsave.version!)>BigInt(draft.version),'P1E18 manual draft advances expected version')
  await refused('P1E19 manual draft stale save refused',()=>withDocumentWrite(er,ctx(ep,a.token),(tx,actor)=>saveDraft({ledgerId:co.ledger.id,entryDate:'2026-10-07',description:'bad stale',actor,lines:[]},draft.id,tx)),409)
  await refused('P1E20 unbalanced entry rejected at existing posting door',()=>postEntry({ledgerId:co.ledger.id,entryDate:'2026-10-07',description:'bad balance',actor:owner.email,lines:[{accountId:at('1000'),amount:577n},{accountId:at('4000'),amount:-576n}]}),undefined,'Debits and credits differ')
  pb.version=await version()
  const concurrent=await Promise.allSettled([withDocumentWrite(resource,ctx(pb),change),withDocumentWrite(resource,ctx(pb),change)])
  r.check(concurrent.filter(x=>x.status==='fulfilled').length===1 && concurrent.some(x=>x.status==='rejected' && x.reason instanceof EditConflict && x.reason.status===409),'P1E21 simultaneous writers commit exactly one expected version')
  pb.version=await version()
  const period=(await periodOverview(co.ledger.id)).find(p=>p.name.endsWith('-10'))!
  await closePeriod(co.ledger.id,period.id,{actor:owner.email,overrideReason:'P1 isolated draft fixture; verify closed-period protection'})
  await refused('P1E22 protected edit retains closed period wall',()=>withDocumentWrite(resource,ctx(pb),change),undefined,'PERIOD_CLOSED')
  await reopenPeriod(co.ledger.id,period.id,'P1 isolated verification',owner.email)
  const [posted]=await db.execute<{entry_id:string}>(sql`SELECT entry_id::text FROM invoice WHERE id=${inv.id}::uuid`)
  await refused('P1E23 direct SQL imbalance refused at commit',()=>db.transaction(async tx=>{
    await tx.execute(sql`SELECT set_config('erp.open_edit','on',true)`)
    await tx.execute(sql`UPDATE journal_line SET amount=amount+1 WHERE id=(SELECT id FROM journal_line WHERE entry_id=${posted.entry_id}::uuid ORDER BY id LIMIT 1)`)
  }),undefined,'out of balance')
  const setup=await(async()=>{
    const previous=process.env.AUTH_ADMIN_MFA_REQUIRED
    process.env.AUTH_ADMIN_MFA_REQUIRED='true'
    try{
      pb.version=await version()
      await refused('P1A28 required admin MFA checked inside business transaction',()=>withDocumentWrite(resource,ctx(pb),change),undefined,'REAUTH_REQUIRED')
      await reauthenticate(a.token,PW,'','192.0.2.38')
      const pending=await manageMfa(a.token,'begin')
      r.check(!!pending.setupKey,'P1A29 required admin policy admits authenticated enrollment only')
      return pending
    }finally{if(previous===undefined)delete process.env.AUTH_ADMIN_MFA_REQUIRED;else process.env.AUTH_ADMIN_MFA_REQUIRED=previous}
  })()
  r.check(!!setup.setupKey,'P1A09 pending authenticator key only returned on setup')
  const [pending]=await db.execute<{mfa_pending_ciphertext:string;mfa_secret_ciphertext:string|null}>(sql`SELECT mfa_pending_ciphertext,mfa_secret_ciphertext FROM app_user WHERE id=${owner.id}::uuid`)
  r.check(!pending.mfa_secret_ciphertext && !pending.mfa_pending_ciphertext.includes(setup.setupKey!),'P1A10 pending secret encrypted and not yet bound')
  await refused('P1A11 invalid code cannot complete enrollment',()=>manageMfa(a.token,'confirm','incorrect'))
  const secret=decryptMfa(pending.mfa_pending_ciphertext,owner.id)
  const enrollmentCode=totp(secret)
  const enrolled=await manageMfa(a.token,'confirm',enrollmentCode)
  const codes=enrolled.recoveryCodes!
  const hashes=await db.execute<{code_hash:string}>(sql`SELECT code_hash FROM auth_recovery_code WHERE user_id=${owner.id}::uuid`)
  r.check(codes.length===10 && hashes.length===10 && !hashes.some(h=>codes.includes(h.code_hash)),'P1A12 high entropy recovery codes stored hashed')
  await refused('P1A24 enrollment TOTP cannot be replayed at sign-in',()=>signIn({email:owner.email,password:PW,factor:enrollmentCode,clientIp:'192.0.2.35'}),undefined,'BAD_CREDENTIALS')
  const nextCode=totp(secret,Math.floor(Date.now()/1000)+30)
  const otpSession=await signIn({email:owner.email,password:PW,factor:nextCode,clientIp:'192.0.2.36'})
  r.check(!!await userForToken(otpSession.token),'P1A25 unused accepted-window TOTP issues a real session')
  await refused('P1A26 accepted TOTP cannot be replayed',()=>signIn({email:owner.email,password:PW,factor:nextCode,clientIp:'192.0.2.37'}),undefined,'BAD_CREDENTIALS')
  const [sessions]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM user_session WHERE user_id=${owner.id}::uuid`)
  await refused('P1A13 password alone never issues MFA session',()=>signIn({email:owner.email,password:PW,clientIp:'192.0.2.25'}))
  const [unchanged]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM user_session WHERE user_id=${owner.id}::uuid`)
  r.check(sessions.n===unchanged.n,'P1A14 rejected second factor leaves no session')
  const race=await Promise.allSettled([signIn({email:owner.email,password:PW,factor:codes[0],clientIp:'192.0.2.26'}),signIn({email:owner.email,password:PW,factor:codes[0],clientIp:'192.0.2.27'})])
  r.check(race.filter(x=>x.status==='fulfilled').length===1,'P1A15 concurrent recovery code consumed exactly once')
  await refused('P1A16 recent authentication required after factor change',()=>manageMfa(a.token,'disable'))
  await reauthenticate(a.token,PW,codes[1],'192.0.2.28');await manageMfa(a.token,'disable')
  await signOut(b.token)
  r.check((await userForToken(b.token))===null,'P1A17 revoked session cannot read user identity')
  await refused('P1A18 revoked session cannot write documents',()=>withDocumentWrite(resource,ctx(pb),change))
  await refused('P1A19 revoked session cannot manage MFA',()=>manageMfa(b.token,'begin'))
  await refused('P1A20 revoked session cannot reset passwords in write transaction',()=>setPassword({userId:owner.id,password:PW+' changed',actor:peer.email,sessionToken:b.token}),undefined,'REAUTH_REQUIRED')
  await reauthenticate(a.token,PW,'','192.0.2.30')
  const resetSetup=await manageMfa(a.token,'begin')
  r.check(!!resetSetup.setupKey,'P1A21 offline recovery fixture starts real enrollment')
  const [offlinePending]=await db.execute<{mfa_pending_ciphertext:string}>(sql`SELECT mfa_pending_ciphertext FROM app_user WHERE id=${owner.id}::uuid`)
  await manageMfa(a.token,'confirm',totp(decryptMfa(offlinePending.mfa_pending_ciphertext,owner.id)))
  execFileSync('npx',['tsx','scripts/reset-mfa.ts','--database',new URL(process.env.DATABASE_URL!).pathname.slice(1),'--email',owner.email,'--reason','P1 isolated recovery verification'],{env:{...process.env},stdio:'pipe'})
  const [recovered]=await db.execute<{clean:boolean;audit:number}>(sql`SELECT mfa_secret_ciphertext IS NULL AND mfa_pending_ciphertext IS NULL AS clean,
    (SELECT count(*)::int FROM audit_log WHERE action='mfa_offline_recovery' AND record_id=${owner.id}) AS audit FROM app_user WHERE id=${owner.id}::uuid`)
  r.check(recovered.clean && recovered.audit===1 && await userForToken(a.token)===null,'P1A22 offline recovery clears factors, revokes and audits')
  const restored=await signIn({email:owner.email,password:PW,clientIp:'192.0.2.31'})
  const tempProof:EditProof={version:await version(),tabId:randomUUID()}
  await editLease(resource,restored.token,'takeover',tempProof)
  execFileSync('npx',['tsx','scripts/invalidate-restored-auth.ts','--database',new URL(process.env.DATABASE_URL!).pathname.slice(1),'--reason','P1 isolated restored snapshot verification'],{env:{...process.env},stdio:'pipe'})
  const [leaseCount]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM document_edit_lease`)
  r.check(leaseCount.n===0 && await userForToken(restored.token)===null,'P1A23 whole restore invalidation removes sessions and transient leases')
  // A committed, live fixture for browser verification. Only generated test
  // credentials, private temporary file; never real book/customer information.
  const browser=await signIn({email:owner.email,password:PW,clientIp:'192.0.2.32'})
  await editLease(resource,browser.token,'takeover',{version:await version(),tabId:randomUUID()}).then(async l=>{
    const [lease]=await db.execute<{tab_id:string}>(sql`SELECT tab_id::text FROM document_edit_lease WHERE invoice_id=${inv.id}::uuid`)
    await editLease(resource,browser.token,'release',{version:await version(),tabId:lease.tab_id,token:l.token,generation:l.generation})
  })
  writeFileSync(process.env.P1_BROWSER_FIXTURE ?? '/tmp/figtree-p1-browser.json',JSON.stringify({ledgerId:co.ledger.id,invoiceId:inv.id,billId:bill.id,entryId:draft.id,email:owner.email,peerEmail:peer.email,password:PW}),{mode:0o600})
}
main().catch(e=>{r.fail('P1 unexpected fixture/infrastructure failure',causesOf(e).slice(0,250))}).finally(async()=>{
  console.log(r.summary());await connection.end();process.exitCode=r.failures?1:0
})

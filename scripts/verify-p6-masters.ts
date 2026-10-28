import './env'
import {sql} from 'drizzle-orm'
import {randomBytes,randomUUID} from 'node:crypto'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner,signIn,createUser} from '../src/lib/users'
import {createCompany} from '../src/lib/setup'
import {createAccount} from '../src/lib/accounts'
import {createParty,setAddress,partyDetail} from '../src/lib/parties'
import {editLease} from '../src/lib/edit-leases'
import type {EditResource,EditProof} from '../src/lib/edit-proof'
import {accountEditFromForm,attachPartyFromForm,partyEditFromForm} from '../src/lib/master-forms'
import {acting} from '../src/lib/acting'
import {PARTY_FIELDS as F} from '../src/lib/forms'
import {archiveCompany} from '../src/lib/companies'
import {verifyAudit} from '../src/lib/audit-chain'
import {reporter,expectSaying} from './suite'
import {causesOf} from '../src/lib/db-errors'
const r=reporter(85),no=expectSaying(r,causesOf,145)
async function main(){
  const pw=randomBytes(24).toString('base64url'),owner=await createFirstOwner({email:'p6-master@example.test',password:pw,firstName:'P6 editor'}),token=(await signIn({email:owner.email,password:pw})).token
  const a=await createCompany({code:'P6MA',name:'P6 Master A'},owner.email),b=await createCompany({code:'P6MB',name:'P6 Master B'},owner.email)
  const account=await createAccount({entityId:a.company.id,code:'1000',name:'Cash A',accountType:'asset'},owner.email)
  const party=await createParty({kind:'organisation',name:'P6 shared supplier',roles:[{entityId:a.company.id,role:'supplier',heldFrom:'2026-01-01'},{entityId:b.company.id,role:'supplier',heldFrom:'2026-01-01'}],actor:owner.email})
  const ar:EditResource={ledgerId:a.ledger.id,type:'account',id:account.id},pr:EditResource={ledgerId:a.ledger.id,type:'party',id:party.id},prb={...pr,ledgerId:b.ledger.id}
  const version=async(res:EditResource)=>(await db.execute<{v:string}>(sql`SELECT version::text AS v FROM ${sql.raw(res.type==='account'?'account':'party')} WHERE id=${res.id}::uuid`))[0].v
  async function lease(res:EditResource,t=token):Promise<EditProof>{const proof={version:await version(res),tabId:randomUUID()},got=await editLease(res,t,'takeover',proof);return {...proof,...got}}
  const data=(res:EditResource,proof:EditProof,extra:Record<string,string>)=>{
    const f=new FormData();for(const [k,v]of Object.entries({ledgerId:res.ledgerId,accountId:res.id,[F.partyId]:res.id,expectedVersion:proof.version,editTab:proof.tabId!,editToken:proof.token!,editGeneration:proof.generation!,...extra}))f.set(k,v);return f
  }
  let ap=await lease(ar)
  r.check(!!ap.token,'P6M01 account uses existing real lease service')
  await no('P6M02 second tab cannot acquire a live account lease','editing until',()=>editLease(ar,token,'acquire',{version:ap.version,tabId:randomUUID()}))
  const saved=await accountEditFromForm('update',data(ar,ap,{code:'1000',name:'Renamed Cash A',accountType:'asset',side:'normal'}),token)
  r.check(!!saved.version&&BigInt(saved.version)>BigInt(ap.version),'P6M03 same adapter as actual UI updates account and returns version')
  await no('P6M04 stale account form cannot overwrite name','changed',()=>accountEditFromForm('update',data(ar,ap,{code:'1000',name:'Stale',accountType:'asset'}),token))
  ap={...ap,version:saved.version!}
  const withRoles=await accountEditFromForm('roles',data(ar,ap,{role_classification:'cash_and_cash_equivalents'}),token)
  r.check(BigInt(withRoles.version!)>BigInt(ap.version),'P6M05 role child write invalidates account version')
  ap={...ap,version:withRoles.version!}
  const disabled=await accountEditFromForm('active',data(ar,ap,{active:'no'}),token)
  r.check(!!disabled.version,'P6M06 account deactivation keeps same lease transaction')
  ap={...ap,version:disabled.version!}
  await accountEditFromForm('active',data(ar,ap,{active:'yes'}),token)
  await no('P6M07 another company cannot acquire this account','unavailable',()=>editLease({...ar,ledgerId:b.ledger.id},token,'acquire',{version:'1',tabId:randomUUID()}))
  const employee=await createUser({email:'p6-master-user@example.test',password:pw,firstName:'Limited editor',kind:'user',actor:owner.email})
  const limited=(await signIn({email:employee.email,password:pw})).token
  await no('P6M08 current grants are checked inside lease transaction','unavailable',()=>editLease(pr,limited,'acquire',{version:'1',tabId:randomUUID()}))
  let pp=await lease(pr)
  await no('P6M09 shared party lease blocks another company tab','editing until',()=>editLease(prb,token,'acquire',{version:pp.version,tabId:randomUUID()}))
  let result=await partyEditFromForm('update',data(pr,pp,{[F.name]:'P6 shared supplier renamed',[F.armsLength]:'on'}),token)
  r.check(!!result.ok&&!!result.version,'P6M10 identity update uses existing party domain and guarded adapter')
  await no('P6M11 shared stale identity form refused','changed',()=>partyEditFromForm('update',data(pr,pp,{[F.name]:'Wrong stale'}),token))
  pp={...pp,version:result.version!}
  result=await partyEditFromForm('address',data(pr,pp,{[F.purpose]:'mailing',[F.line1]:'100 Shared Street',[F.city]:'Vancouver'}),token)
  r.check(!!result.ok&&BigInt(result.version!)>BigInt(pp.version),'P6M12 address write bumps shared party version in same transaction')
  const viewA=await partyDetail(party.id,a.company.id),viewB=await partyDetail(party.id,b.company.id)
  r.check(viewA?.addresses[0]?.line1==='100 Shared Street'&&viewB?.addresses[0]?.line1==='100 Shared Street','P6M13 shared address remains one actual record across companies')
  const [addressAudit]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM audit_log WHERE table_name='party_address' AND after->>'line1'='100 Shared Street' AND actor=${owner.email}`)
  r.check(addressAudit.n===1,'P6M14 child values and actual actor are included in existing audit chain')
  pp={...pp,version:result.version!}
  result=await partyEditFromForm('grantRole',data(pr,pp,{[F.entityId]:a.company.id,[F.role]:'customer',[F.heldFrom]:'2026-02-01'}),token)
  r.check(!!result.ok,'P6M15 granting another role is version/lease protected')
  const [role]=await db.execute<{id:string}>(sql`SELECT id::text FROM party_role WHERE party_id=${party.id}::uuid AND entity_id=${a.company.id}::uuid AND role='customer'`)
  pp={...pp,version:result.version!}
  result=await partyEditFromForm('correctRole',data(pr,pp,{[F.roleId]:role.id,[F.heldFrom]:'2026-02-02'}),token)
  r.check(!!result.ok,'P6M16 role correction resolves and locks actual party')
  pp={...pp,version:result.version!}
  result=await partyEditFromForm('endRole',data(pr,pp,{[F.roleId]:role.id,[F.heldTo]:'2026-10-08'}),token)
  r.check(!!result.ok,'P6M17 ending role preserves existing posted-use checks')
  pp={...pp,version:result.version!}
  result=await partyEditFromForm('deleteRole',data(pr,pp,{[F.roleId]:role.id}),token)
  r.check(!!result.ok,'P6M18 deleting unused role preserves existing domain constraints')
  pp={...pp,version:result.version!}
  result=await partyEditFromForm('deleteAddress',data(pr,pp,{[F.purpose]:'mailing'}),token)
  r.check(!!result.ok,'P6M19 address removal uses same transaction and proof')
  pp={...pp,version:result.version!}
  result=await partyEditFromForm('deactivate',data(pr,pp,{}),token)
  r.check(!!result.ok,'P6M20 party retirement remains guarded and preserves history')
  pp={...pp,version:result.version!}
  result=await partyEditFromForm('reactivate',data(pr,pp,{}),token)
  r.check(!!result.ok,'P6M21 reactivation retains existing name collision checks')
  pp={...pp,version:result.version!}
  await db.execute(sql`UPDATE document_edit_lease SET expires_at=clock_timestamp()-interval '1 second' WHERE party_id=${party.id}::uuid`)
  await no('P6M22 expired master lease refuses write without changing input','expired',()=>partyEditFromForm('update',data(pr,pp,{[F.name]:'Expired'}),token))
  pp=await lease(pr)
  const stolen=await lease(prb)
  await no('P6M23 cross-company takeover revokes old generation','holds',()=>partyEditFromForm('update',data(pr,pp,{[F.name]:'Taken over'}),token))
  const stale=stolen
  await setAddress({partyId:party.id,purpose:'mailing',line1:'Background change'})
  await no('P6M24 trusted background address change invalidates old form','changed',()=>partyEditFromForm('update',data(prb,stale,{[F.name]:'Background stale'}),token))
  const [contactBefore]=await db.execute<{v:string}>(sql`SELECT version::text AS v FROM party WHERE id=${party.id}::uuid`)
  // Existing contact table remains owned by its trusted domain consumers.
  await db.execute(sql`INSERT INTO party_contact(party_id,email) VALUES(${party.id}::uuid,'p6@example.test')`)
  r.check(BigInt(await version(pr))>BigInt(contactBefore.v),'P6M25 trusted contact child write invalidates party version')
  const latest=await lease(prb),f=data(prb,latest,{[F.name]:'Concurrent name'})
  const concurrent=await Promise.allSettled([partyEditFromForm('update',f,token),partyEditFromForm('update',f,token)])
  r.check(concurrent.filter(x=>x.status==='fulfilled').length===1,'P6M26 concurrent same-proof writes commit exactly once')
  const bRole=(await db.execute<{id:string}>(sql`SELECT id::text FROM party_role WHERE party_id=${party.id}::uuid AND entity_id=${b.company.id}::uuid`))[0]
  await no('P6M27 role locator from another company cannot mutate','unavailable',async()=>partyEditFromForm('correctRole',data(pr,await lease(pr),{[F.roleId]:bRole.id,[F.heldFrom]:'2026-01-02'}),token))
  const deletes=await createParty({kind:'organisation',name:'P6 unused delete',roles:[{entityId:a.company.id,role:'customer',heldFrom:'2026-01-01'}],actor:owner.email}),dr={...pr,id:deletes.id}
  const dp=await lease(dr),gone=await partyEditFromForm('delete',data(dr,dp,{}),token)
  r.check(!!gone.ok&&!gone.version&&(await db.execute(sql`SELECT 1 FROM document_edit_lease WHERE party_id=${deletes.id}::uuid`)).length===0,'P6M28 deleting unused party cascades actual lease, keeps audit')
  const deleteAcc=await createAccount({entityId:a.company.id,code:'1100',name:'P6 unused account',accountType:'asset'},owner.email),dar={...ar,id:deleteAcc.id}
  await accountEditFromForm('delete',data(dar,await lease(dar),{}),token)
  r.check((await db.execute(sql`SELECT 1 FROM account WHERE id=${deleteAcc.id}::uuid`)).length===0,'P6M29 unused account deletion reuses actual guards and cascades lease')
  await archiveCompany(b.company.id,'P6 archive acceptance',owner.email)
  await no('P6M30 archived company cannot acquire master lease','unavailable',()=>editLease(prb,token,'takeover',{version:'1',tabId:randomUUID()}))
  r.check((await verifyAudit()).ok,'P6M31 all selected master writes and trusted invalidations retain valid audit chains')
  const target=await createCompany({code:'P6MC',name:'P6 reuse target'},owner.email),otherTarget=await createCompany({code:'P6MD',name:'P6 other reuse target'},owner.email)
  const known=await createParty({kind:'organisation',name:'P6 first association',roles:[{entityId:a.company.id,role:'supplier'}],actor:owner.email})
  const knownResource={...pr,id:known.id}
  const linkData=(partyId:string,expectedVersion:string,extra:Record<string,string>={})=>{
    const f=new FormData()
    for(const [key,value]of Object.entries({ledgerId:target.ledger.id,[F.entityId]:target.company.id,[F.partyId]:partyId,[F.role]:'supplier',expectedVersion,...extra}))f.set(key,value)
    return f
  }
  let knownVersion=await version(knownResource)
  await no('P6M32 first association requires the saved shared-party version','saved document version',()=>attachPartyFromForm(linkData(known.id,''),token))
  await no('P6M33 first association checks current target-company grants','unavailable',()=>attachPartyFromForm(linkData(known.id,knownVersion),limited))
  const wrongEntity=await attachPartyFromForm(linkData(known.id,knownVersion,{[F.entityId]:a.company.id}),token)
  r.check(!!wrongEntity.error&&(await db.execute(sql`SELECT 1 FROM party_role WHERE party_id=${known.id}::uuid AND entity_id=${target.company.id}::uuid`)).length===0,'P6M34 first association cannot redirect the role to another company')
  const held=await lease(knownResource)
  await no('P6M35 a source-company editor lease blocks first association','holds',()=>attachPartyFromForm(linkData(known.id,knownVersion),token))
  await editLease(knownResource,token,'release',held)
  await setAddress({partyId:known.id,purpose:'mailing',line1:'Version changed elsewhere'})
  await no('P6M36 changed shared-party data refuses a stale association form','changed',()=>attachPartyFromForm(linkData(known.id,knownVersion),token))
  knownVersion=await version(knownResource)
  const linked=await attachPartyFromForm(linkData(known.id,knownVersion),token)
  const [links]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM party_role WHERE party_id=${known.id}::uuid AND entity_id IN (${a.company.id}::uuid,${target.company.id}::uuid)`)
  r.check(!!linked.ok&&links.n===2&&BigInt(linked.version!)>BigInt(knownVersion),'P6M37 a current list form adds the same party to a second company without an editor lease')
  await no('P6M38 first-association adapter cannot add roles to an already linked party','no longer available',()=>attachPartyFromForm(linkData(known.id,linked.version!,{[F.role]:'customer'}),token))
  await no('P6M39 ordinary role editing still requires the existing editor lease','expired',()=>partyEditFromForm('grantRole',linkData(known.id,linked.version!,{[F.role]:'customer'}),token))
  const [unrelated]=await db.transaction(async tx=>{await acting(tx,owner.email);return tx.execute<{id:string}>(sql`INSERT INTO party(kind,name,created_by) VALUES('organisation','P6 unrelated orphan',${owner.email}) RETURNING id::text`)})
  await no('P6M40 a party with no existing company role is not reusable','no longer available',()=>attachPartyFromForm(linkData(unrelated.id,'1'),token))
  await no('P6M41 an unknown party cannot be associated','unavailable',()=>attachPartyFromForm(linkData(randomUUID(),'1'),token))
  const inactive=await createParty({kind:'organisation',name:'P6 inactive reuse',roles:[{entityId:a.company.id,role:'supplier'}],actor:owner.email})
  await db.transaction(async tx=>{await acting(tx,owner.email);await tx.execute(sql`UPDATE party SET is_active=false WHERE id=${inactive.id}::uuid`)})
  await no('P6M42 inactive shared party cannot be associated','no longer available',async()=>attachPartyFromForm(linkData(inactive.id,await version({...pr,id:inactive.id})),token))
  const concurrentParty=await createParty({kind:'organisation',name:'P6 concurrent association',roles:[{entityId:a.company.id,role:'supplier'}],actor:owner.email}),cv=await version({...pr,id:concurrentParty.id})
  const additions=await Promise.allSettled([
    attachPartyFromForm(linkData(concurrentParty.id,cv),token),
    attachPartyFromForm(linkData(concurrentParty.id,cv,{ledgerId:otherTarget.ledger.id,[F.entityId]:otherTarget.company.id}),token),
  ])
  const [addedCount]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM party_role WHERE party_id=${concurrentParty.id}::uuid AND entity_id<>${a.company.id}::uuid`)
  r.check(additions.filter(x=>x.status==='fulfilled'&&x.value.ok).length===1&&addedCount.n===1,'P6M43 concurrent same-version associations commit once across companies')
  const raced=await createParty({kind:'organisation',name:'P6 waited association',roles:[{entityId:a.company.id,role:'supplier'}],actor:owner.email}),rv=await version({...pr,id:raced.id})
  let releaseWriter!:()=>void,writerReady!:()=>void
  const holdWriter=new Promise<void>(resolve=>releaseWriter=resolve),readyWriter=new Promise<void>(resolve=>writerReady=resolve)
  const writer=db.transaction(async tx=>{
    await acting(tx,owner.email);await tx.execute(sql`SELECT id FROM party WHERE id=${raced.id}::uuid FOR UPDATE`)
    await tx.execute(sql`INSERT INTO party_role(party_id,entity_id,role,created_by) VALUES(${raced.id}::uuid,${target.company.id}::uuid,'supplier',${owner.email})`)
    writerReady();await holdWriter
  })
  await readyWriter
  const waited=attachPartyFromForm(linkData(raced.id,String(BigInt(rv)+1n),{[F.role]:'customer'}),token).then(value=>({value,error:null}),error=>({value:null,error}))
  let observedWait=false
  try{
    for(let i=0;i<60;i++){
      const [waiting]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM party%' AND query LIKE '%FOR UPDATE%'`)
      if(waiting.n>0){observedWait=true;break}
      await new Promise(resolve=>setTimeout(resolve,10))
    }
  }finally{releaseWriter()}
  await writer;const waitResult=await waited
  const [unexpected]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM party_role WHERE party_id=${raced.id}::uuid AND entity_id=${target.company.id}::uuid AND role='customer'`)
  r.check(observedWait&&String(waitResult.error?.message).includes('no longer available')&&unexpected.n===0,'P6M44 eligibility is reread after a lock wait even when the caller guesses the new version')
  await archiveCompany(target.company.id,'P6 first-association archive check',owner.email)
  await no('P6M45 archived target refuses first association','unavailable',async()=>attachPartyFromForm(linkData(raced.id,await version({...pr,id:raced.id})),token))
  r.check((await verifyAudit()).ok,'P6M46 first-association writes retain valid actor-bound audit chains')
  console.log(r.summary());process.exitCode=r.failures?1:0
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

import 'server-only'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {withDocumentWrite,withPartyAssociation,EditConflict} from './edit-leases'
import {proofFrom} from './edit-proof'
import {updateAccount,setAccountRoles,setAccountActive,deleteAccount,DEFAULT_BALANCE,type AccountType} from './accounts'
import {rolesFromFormData,PARTY_FIELDS} from './forms'
import {setPrimaryContactEmail} from './parties'
import {grantRoleFromForm,updatePartyFromForm,setAddressFromForm,endRoleFromForm,correctRoleFromForm,deleteRoleFromForm,
  deleteAddressFromForm,deactivatePartyFromForm,reactivatePartyFromForm,deletePartyFromForm} from './party-forms'
const get=(f:FormData,k:string)=>String(f.get(k)??'')
export async function accountEditFromForm(operation:'update'|'roles'|'active'|'delete',f:FormData,token:string){
  const ledgerId=get(f,'ledgerId'),accountId=get(f,'accountId')
  return withDocumentWrite({ledgerId,type:'account',id:accountId},{sessionToken:token,proof:proofFrom(f),leaseRequired:true},async(tx,actor)=>{
    if(operation==='roles') {await setAccountRoles(accountId,rolesFromFormData(f),actor,ledgerId,tx);return {ok:'Roles updated.'}}
    if(operation==='delete'){await deleteAccount(accountId,actor,ledgerId,tx);return {ok:'Account deleted.'}}
    if(operation==='active'){
      const active=f.get('active')==='yes',row=await setAccountActive(accountId,active,actor,ledgerId,tx)
      return {ok:active?`${row.code} is active again.`:`${row.code} is inactive: its history stays, and nothing new can be posted to it.`}
    }
    const type=get(f,'accountType') as AccountType,side=get(f,'side')||'normal'
    const row=await updateAccount(accountId,{code:get(f,'code'),name:get(f,'name'),accountType:type||undefined,
      normalBalance:side==='contra'?(DEFAULT_BALANCE[type]==='debit'?'credit':'debit'):DEFAULT_BALANCE[type],
      isPostable:f.get('isPostable')!=='no',parentCode:f.has('parentCode')?get(f,'parentCode'):undefined},actor,ledgerId,tx)
    return {ok:`${row.code} saved.`}
  })
}
const partyCommands={contact:(f:FormData,actor:string,tx:import('./acting').Runner)=>setPrimaryContactEmail(get(f,'partyId'),get(f,'email'),actor,tx),grantRole:grantRoleFromForm,update:updatePartyFromForm,address:setAddressFromForm,endRole:endRoleFromForm,
  correctRole:correctRoleFromForm,deleteRole:deleteRoleFromForm,deleteAddress:deleteAddressFromForm,
  deactivate:deactivatePartyFromForm,reactivate:reactivatePartyFromForm,delete:deletePartyFromForm}
export type PartyOperation=keyof typeof partyCommands
export async function attachPartyFromForm(f:FormData,token:string){
  return withPartyAssociation(get(f,PARTY_FIELDS.ledgerId),get(f,PARTY_FIELDS.partyId),
    {sessionToken:token,proof:proofFrom(f)},(tx,actor)=>grantRoleFromForm(f,actor,tx))
}
export async function partyEditFromForm(operation:PartyOperation,f:FormData,token:string){
  const ledgerId=get(f,PARTY_FIELDS.ledgerId),roleId=get(f,PARTY_FIELDS.roleId)
  let partyId=get(f,PARTY_FIELDS.partyId)
  if(roleId){
    const [role]=await db.execute<{party_id:string}>(sql`SELECT party_id::text FROM party_role WHERE id=${roleId}::uuid`)
    if(!role)throw new EditConflict(403,'This role is unavailable.');partyId=role.party_id
  }
  return withDocumentWrite({ledgerId,type:'party',id:partyId},{sessionToken:token,proof:proofFrom(f),leaseRequired:true},async(tx,actor)=>{
    if(roleId){
      const tied=await tx.execute(sql`SELECT 1 FROM party_role pr JOIN ledger l ON l.entity_id=pr.entity_id
        WHERE pr.id=${roleId}::uuid AND pr.party_id=${partyId}::uuid AND l.id=${ledgerId}::uuid`)
      if(!tied.length)throw new EditConflict(403,'This role changed or is unavailable in this company.')
    }
    return partyCommands[operation](f,actor,tx)
  })
}

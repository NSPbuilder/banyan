'use server'
import {cookies,headers} from 'next/headers'
import {redirect} from 'next/navigation'
import {revalidatePath} from 'next/cache'
import {requireUser,SESSION_COOKIE} from '@/lib/gate'
import {trustedClientIp} from '@/lib/auth-client'
import {newToken,UserError} from '@/lib/users'
import {beginPasskey,finishPasskeyRegistration,finishPasskeyAuthentication,renamePasskey,revokePasskey,passkeyConfig} from '@/lib/passkeys'
import type {RegistrationResponseJSON,AuthenticationResponseJSON} from '@simplewebauthn/server'
import {startSession} from '@/lib/session-cookie'
type Flow='register'|'login'|'reauth'
const cookie=(flow:Flow)=>'erp_webauthn_'+flow
async function request(flow:Flow){
  const h=await headers(),cfg=passkeyConfig()
  if(h.get('origin')!==cfg.origin)throw new UserError('PASSKEY_ORIGIN','Use the configured Banyan address for passkeys.')
  if(flow!=='login')await requireUser(true)
  const jar=await cookies()
  return {jar,ip:trustedClientIp(h),token:jar.get(SESSION_COOKIE)?.value??'',userAgent:h.get('user-agent')??'',cfg}
}
const failure=(e:unknown)=>({error:e instanceof UserError?e.message:'Passkey operation unavailable. Verify your identity and try again.'})
export async function beginPasskeyAction(flow:Flow){
  try{
    if(!['register','login','reauth'].includes(flow))throw new UserError('PASSKEY_FLOW','Choose a passkey operation.')
    const req=await request(flow),binding=newToken(),result=await beginPasskey(flow,binding,req.ip,req.token)
    req.jar.set(cookie(flow),binding,{httpOnly:true,sameSite:'strict',secure:req.cfg.origin.startsWith('https:'),path:'/',maxAge:300})
    return result
  }catch(e){return failure(e)}
}
export async function registerPasskeyAction(id:string,response:RegistrationResponseJSON,name:string){
  try{
    const req=await request('register'),binding=req.jar.get(cookie('register'))?.value??''
    if(JSON.stringify(response).length>65536)throw new UserError('PASSKEY_SIZE','Passkey response is too large.')
    await finishPasskeyRegistration({id,response,name,binding,token:req.token,ip:req.ip})
    req.jar.delete(cookie('register'));revalidatePath('/settings/security')
    return {ok:'Passkey added. Other sessions have been signed out.'}
  }catch(e){return failure(e)}
}
export async function authenticatePasskeyAction(flow:'login'|'reauth',id:string,response:AuthenticationResponseJSON,next=''){
  let token:string|undefined
  try{
    if(!['login','reauth'].includes(flow))throw new UserError('PASSKEY_FLOW','Choose a passkey operation.')
    const req=await request(flow),binding=req.jar.get(cookie(flow))?.value??''
    if(JSON.stringify(response).length>65536)throw new UserError('PASSKEY_SIZE','Passkey response is too large.')
    const result=await finishPasskeyAuthentication({flow,id,response,binding,token:req.token,replaces:req.token,ip:req.ip,userAgent:req.userAgent})
    req.jar.delete(cookie(flow));token=result.token
    if(flow==='reauth'){revalidatePath('/settings/security');return {ok:'Identity verified for five minutes with your passkey.'}}
  }catch(e){return failure(e)}
  if(token){await startSession(token);redirect(next.startsWith('/')&&!next.startsWith('//')&&!next.includes('\\')?next:'/')}
  return {error:'Passkey sign-in did not complete.'}
}
export async function managePasskeyAction(operation:'rename'|'revoke',id:string,name:string,password='',code=''){
  try{
    if(!['rename','revoke'].includes(operation))throw new UserError('PASSKEY_FLOW','Choose a passkey operation.')
    const req=await request('reauth')
    if(operation==='rename')await renamePasskey(req.token,id,name)
    else await revokePasskey(req.token,id,password,code,req.ip)
    revalidatePath('/settings/security');return {ok:operation==='rename'?'Passkey renamed.':'Passkey removed. Sessions using it are signed out.'}
  }catch(e){return failure(e)}
}

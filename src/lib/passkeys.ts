import 'server-only'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse,
  type RegistrationResponseJSON,type AuthenticationResponseJSON,type AuthenticatorTransport} from '@simplewebauthn/server'
import {decodeCredentialPublicKey} from '@simplewebauthn/server/helpers'
import {authAttempt,authSucceeded,authRefusal,liveAuth,consumeFactor} from './auth-security'
import {newToken,tokenHash,SESSION_DAYS,verifyPassword,UserError} from './users'
import {auditRow} from './audit-row'

export function passkeyConfig(){
  if(process.env.PASSKEYS_ENABLED!=='true')throw new UserError('PASSKEYS_DISABLED','Passkeys are not enabled on this installation.')
  const rpID=process.env.WEBAUTHN_RP_ID??'',origin=process.env.WEBAUTHN_ORIGIN??''
  const url=new URL(origin)
  if(!rpID||rpID!==rpID.toLowerCase()||!/^[a-z0-9.-]+$/.test(rpID)||rpID.includes('..')
    ||url.origin!==origin||url.username||url.password||!(url.hostname===rpID||url.hostname.endsWith('.'+rpID))
    ||!(url.protocol==='https:'||(rpID==='localhost'&&url.protocol==='http:')))throw new UserError('PASSKEY_CONFIG','Configure the exact HTTPS origin and RP ID before enabling passkeys.')
  return {rpID,origin}
}
export const passkeysEnabled=()=>process.env.PASSKEYS_ENABLED==='true'
const nameOf=(name:string)=>{const value=name.trim();if(!value||value.length>80)throw new UserError('PASSKEY_NAME','Name this passkey using 1–80 characters.');return value}
const bindingOf=(binding:string)=>{if(!/^[a-zA-Z0-9_-]{43}$/.test(binding))throw authRefusal();return tokenHash(binding)}
type Flow='register'|'login'|'reauth'
type Challenge={id:string;user_id:string|null;session_hash:string|null;challenge:string;rp_id:string;origin:string}
type Credential={id:string;user_id:string;credential_id:string;public_key:Buffer;counter:bigint;transports:AuthenticatorTransport[];device_type:string;backed_up:boolean}

export async function passkeysFor(userId:string){
  return db.execute<{id:string;name:string;created_at:string;last_used_at:string|null;device_type:string;backed_up:boolean;rp_id:string}>(sql`
    SELECT id::text,name,created_at::text,last_used_at::text,device_type,backed_up,rp_id FROM auth_passkey
    WHERE user_id=${userId}::uuid AND revoked_at IS NULL ORDER BY created_at,id`)
}
export async function beginPasskey(flow:Flow,binding:string,ip:string,sessionToken?:string){
  const cfg=passkeyConfig(),browserHash=bindingOf(binding)
  await authAttempt('passkey',flow+':'+ip,ip)
  return db.transaction(async tx=>{
    const who=flow==='login'?null:await liveAuth(tx,sessionToken??'',flow==='register',true)
    const [u]=who?await tx.execute<{webauthn_user_id:Buffer;email:string}>(sql`SELECT webauthn_user_id,email FROM app_user WHERE id=${who.user_id}::uuid`):[]
    const keys=who?await tx.execute<{credential_id:string;transports:AuthenticatorTransport[]}>(sql`SELECT credential_id,transports FROM auth_passkey WHERE user_id=${who.user_id}::uuid AND revoked_at IS NULL AND rp_id=${cfg.rpID} AND origin=${cfg.origin}`):[]
    if(flow==='reauth'&&!keys.length)throw authRefusal()
    const options=flow==='register'?await generateRegistrationOptions({rpName:'Banyan',rpID:cfg.rpID,userName:u.email,
      userID:new Uint8Array(u.webauthn_user_id),attestationType:'none',timeout:300000,supportedAlgorithmIDs:[-7,-257],
      excludeCredentials:keys.map(k=>({id:k.credential_id,transports:k.transports})),
      authenticatorSelection:{residentKey:'required',userVerification:'required'}}):
      await generateAuthenticationOptions({rpID:cfg.rpID,timeout:300000,userVerification:'required',
        ...(flow==='reauth'?{allowCredentials:keys.map(k=>({id:k.credential_id,transports:k.transports}))}:{})})
    const [challenge]=await tx.execute<{id:string}>(sql`INSERT INTO auth_webauthn_challenge(user_id,session_hash,browser_hash,flow,challenge,rp_id,origin)
      VALUES(${who?.user_id??null}::uuid,${who?tokenHash(sessionToken!):null},${browserHash},${flow},${options.challenge},${cfg.rpID},${cfg.origin}) RETURNING id::text`)
    await tx.execute(sql`DELETE FROM auth_webauthn_challenge WHERE id IN(SELECT id FROM auth_webauthn_challenge WHERE expires_at<clock_timestamp()-interval '1 day' LIMIT 100)`)
    return {id:challenge.id,options}
  })
}
/** Consume in its own committed statement BEFORE verification. A bad response
 * consumes this challenge too; rolling back registration/login cannot revive it. */
async function consumeChallenge(flow:Flow,id:string,binding:string,sessionToken?:string){
  const cfg=passkeyConfig(),browserHash=bindingOf(binding)
  if(!/^[a-f0-9-]{36}$/i.test(id))throw authRefusal()
  const [c]=await db.execute<Challenge>(sql`UPDATE auth_webauthn_challenge SET consumed_at=clock_timestamp()
    WHERE id=${id}::uuid AND flow=${flow} AND browser_hash=${browserHash} AND consumed_at IS NULL AND expires_at>clock_timestamp()
      AND rp_id=${cfg.rpID} AND origin=${cfg.origin}
      AND (${flow==='login'} OR session_hash=${tokenHash(sessionToken??'')})
    RETURNING id::text,user_id::text,session_hash,challenge,rp_id,origin`)
  if(!c)throw authRefusal();return c
}
export async function finishPasskeyRegistration(input:{id:string;binding:string;token:string;ip:string;name:string;response:RegistrationResponseJSON}){
  const name=nameOf(input.name)
  await authAttempt('passkey','register:'+input.ip,input.ip)
  const c=await consumeChallenge('register',input.id,input.binding,input.token)
  let v
  try{v=await verifyRegistrationResponse({response:input.response,expectedChallenge:c.challenge,expectedOrigin:c.origin,expectedRPID:c.rp_id,
    requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]})}catch{throw authRefusal()}
  if(!v.verified||!v.registrationInfo.userVerified)throw authRefusal()
  const info=v.registrationInfo,credential=info.credential,algorithm=decodeCredentialPublicKey(credential.publicKey).get(3)
  return db.transaction(async tx=>{
    const who=await liveAuth(tx,input.token,true,true);if(who.user_id!==c.user_id)throw authRefusal()
    const [key]=await tx.execute<{id:string}>(sql`INSERT INTO auth_passkey(user_id,credential_id,public_key,algorithm,counter,device_type,backed_up,transports,rp_id,origin,name,aaguid)
      VALUES(${who.user_id}::uuid,${credential.id},${Buffer.from(credential.publicKey)},${Number(algorithm)},${credential.counter},${info.credentialDeviceType},
        ${info.credentialBackedUp},${JSON.stringify(credential.transports??[])}::jsonb,${c.rp_id},${c.origin},${name},${info.aaguid}) RETURNING id::text`)
    await tx.execute(sql`UPDATE user_session SET strong_authenticated_at=clock_timestamp(),reauthenticated_at=clock_timestamp(),authenticated_passkey_id=${key.id}::uuid WHERE id=${who.id}::uuid`)
    await tx.execute(sql`UPDATE user_session SET revoked_at=clock_timestamp() WHERE user_id=${who.user_id}::uuid AND id<>${who.id}::uuid AND revoked_at IS NULL`)
    await authSucceeded(tx,'passkey','register:'+input.ip,input.ip)
    await auditRow(tx,{actor:who.email,action:'passkey_registered',table:'app_user',recordId:who.user_id,after:{passkeyId:key.id,name,algorithm:Number(algorithm),deviceType:info.credentialDeviceType},scope:'system'})
    return {id:key.id}
  })
}
export async function finishPasskeyAuthentication(input:{flow:'login'|'reauth';id:string;binding:string;token?:string;replaces?:string;ip:string;userAgent?:string;response:AuthenticationResponseJSON}){
  await authAttempt('passkey',input.response?.id??'invalid',input.ip)
  const c=await consumeChallenge(input.flow,input.id,input.binding,input.token)
  return db.transaction(async tx=>{
    // Same user -> session -> credential lock order as management. Candidate
    // lookup is not authority; active credential and grants are re-read below.
    const [candidate]=await tx.execute<{user_id:string}>(sql`SELECT user_id::text FROM auth_passkey WHERE credential_id=${input.response.id}`)
    if(!candidate||(c.user_id&&candidate.user_id!==c.user_id))throw authRefusal()
    const [u]=await tx.execute<{id:string;email:string;is_active:boolean;webauthn_user_id:Buffer}>(sql`SELECT id::text,email,is_active,webauthn_user_id FROM app_user WHERE id=${candidate.user_id}::uuid FOR UPDATE`)
    if(!u?.is_active)throw authRefusal()
    const who=input.flow==='reauth'?await liveAuth(tx,input.token??'',false,true):null
    if(who&&who.user_id!==u.id)throw authRefusal()
    const [key]=await tx.execute<Credential>(sql`SELECT id::text,user_id::text,credential_id,public_key,counter,transports,device_type,backed_up FROM auth_passkey
      WHERE credential_id=${input.response.id} AND user_id=${u.id}::uuid AND revoked_at IS NULL AND rp_id=${c.rp_id} AND origin=${c.origin} FOR UPDATE`)
    if(!key)throw authRefusal()
    const handle=input.response.response.userHandle
    if(handle!==null&&handle!==undefined&&handle!==u.webauthn_user_id.toString('base64url'))throw authRefusal()
    let verified
    try{verified=await verifyAuthenticationResponse({response:input.response,expectedChallenge:c.challenge,expectedOrigin:c.origin,expectedRPID:c.rp_id,requireUserVerification:true,
      credential:{id:key.credential_id,publicKey:new Uint8Array(key.public_key),counter:Number(key.counter),transports:key.transports}})}catch{throw authRefusal()}
    if(!verified.verified||!verified.authenticationInfo.userVerified)throw authRefusal()
    const info=verified.authenticationInfo
    await tx.execute(sql`UPDATE auth_passkey SET counter=${info.newCounter},device_type=${info.credentialDeviceType},backed_up=${info.credentialBackedUp},last_used_at=clock_timestamp() WHERE id=${key.id}::uuid`)
    let token:string|undefined
    if(who)await tx.execute(sql`UPDATE user_session SET reauthenticated_at=clock_timestamp(),strong_authenticated_at=clock_timestamp(),authenticated_passkey_id=${key.id}::uuid WHERE id=${who.id}::uuid`)
    else {
      token=newToken()
      if(input.replaces)await tx.execute(sql`UPDATE user_session SET revoked_at=clock_timestamp() WHERE token_hash=${tokenHash(input.replaces)} AND revoked_at IS NULL`)
      await tx.execute(sql`INSERT INTO user_session(user_id,token_hash,expires_at,user_agent,reauthenticated_at,strong_authenticated_at,authenticated_passkey_id)
        VALUES(${u.id}::uuid,${tokenHash(token)},clock_timestamp()+${`${SESSION_DAYS} days`}::interval,${input.userAgent??null},clock_timestamp(),clock_timestamp(),${key.id}::uuid)`)
      await tx.execute(sql`UPDATE app_user SET last_seen_at=clock_timestamp() WHERE id=${u.id}::uuid`)
    }
    await authSucceeded(tx,'passkey',input.response.id,input.ip)
    await authSucceeded(tx,'passkey',input.flow+':'+input.ip,input.ip)
    await auditRow(tx,{actor:u.email,action:who?'passkey_reauthenticated':'passkey_signed_in',table:'app_user',recordId:u.id,after:{passkeyId:key.id,userVerified:true},scope:'system'})
    return {token,userId:u.id}
  })
}
export async function renamePasskey(token:string,id:string,name:string){
  const clean=nameOf(name)
  return db.transaction(async tx=>{
    const who=await liveAuth(tx,token,true,true)
    const [key]=await tx.execute<{id:string}>(sql`UPDATE auth_passkey SET name=${clean} WHERE id=${id}::uuid AND user_id=${who.user_id}::uuid AND revoked_at IS NULL RETURNING id::text`)
    if(!key)throw authRefusal()
    await auditRow(tx,{actor:who.email,action:'passkey_renamed',table:'app_user',recordId:who.user_id,after:{passkeyId:id,name:clean},scope:'system'})
  })
}
/** Last key needs a freshly verified alternative password (and TOTP when
 * configured). Mandatory admin MFA also requires a TOTP alternative. */
export async function revokePasskey(token:string,id:string,password:string,code:string,ip:string){
  const [candidate]=await db.execute<{password_hash:string;email:string}>(sql`SELECT u.password_hash,u.email FROM app_user u JOIN user_session s ON s.user_id=u.id WHERE s.token_hash=${tokenHash(token)}`)
  await authAttempt('reauth',candidate?.email??'invalid',ip)
  const alternative=!!candidate&&!!password&&await verifyPassword(password,candidate.password_hash)
  return db.transaction(async tx=>{
    const who=await liveAuth(tx,token,true,true)
    const [u]=await tx.execute<{password_hash:string;mfa_secret_ciphertext:string|null}>(sql`SELECT password_hash,mfa_secret_ciphertext FROM app_user WHERE id=${who.user_id}::uuid`)
    const cfg=passkeyConfig()
    const keys=await tx.execute<{id:string;rp_id:string;origin:string}>(sql`SELECT id::text,rp_id,origin FROM auth_passkey WHERE user_id=${who.user_id}::uuid AND revoked_at IS NULL ORDER BY id FOR UPDATE`)
    if(!keys.some(k=>k.id===id))throw authRefusal()
    const lastUsable=!keys.some(k=>k.id!==id&&k.rp_id===cfg.rpID&&k.origin===cfg.origin)
    if(lastUsable){
      if(!alternative||u.password_hash!==candidate?.password_hash)throw new UserError('ALTERNATIVE_REQUIRED','Verify your password before removing your last passkey.')
      if(process.env.AUTH_ADMIN_MFA_REQUIRED==='true'&&['owner','superadmin'].includes(who.kind)&&!u.mfa_secret_ciphertext)
        throw new UserError('ALTERNATIVE_REQUIRED','Enable an authenticator and keep its recovery codes before removing your last passkey.')
      if(u.mfa_secret_ciphertext)await consumeFactor(tx,who.user_id,u.mfa_secret_ciphertext,code,!/^\d{6}$/.test(code.trim()))
    }
    await tx.execute(sql`UPDATE auth_passkey SET revoked_at=clock_timestamp() WHERE id=${id}::uuid`)
    await tx.execute(sql`UPDATE user_session SET revoked_at=clock_timestamp(),reauthenticated_at=NULL,strong_authenticated_at=NULL WHERE authenticated_passkey_id=${id}::uuid AND revoked_at IS NULL`)
    await tx.execute(sql`UPDATE auth_webauthn_challenge SET consumed_at=clock_timestamp() WHERE user_id=${who.user_id}::uuid AND consumed_at IS NULL`)
    await auditRow(tx,{actor:who.email,action:'passkey_revoked',table:'app_user',recordId:who.user_id,after:{passkeyId:id,lastPasskey:lastUsable,alternativeVerified:lastUsable},scope:'system'})
  })
}

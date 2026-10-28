import './env'
import {chromium,type Page} from '@playwright/test'
import {createServer} from 'node:http'
import {randomBytes,createPrivateKey,createHash,sign} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner,signIn,createUser,userForToken,setUserStatus,setPassword,setUserKind} from '../src/lib/users'
import {beginPasskey,finishPasskeyRegistration,finishPasskeyAuthentication,passkeysFor,renamePasskey,revokePasskey} from '../src/lib/passkeys'
import {liveAuth,manageMfa} from '../src/lib/auth-security'
import {newToken} from '../src/lib/users'
import {decryptMfa,totp} from '../src/lib/totp'
import {reporter,expectSaying} from './suite'
import {causesOf} from '../src/lib/db-errors'
import type {RegistrationResponseJSON,AuthenticationResponseJSON} from '@simplewebauthn/server'
const r=reporter(80),no=expectSaying(r,causesOf,140)
async function creation(page:Page,options:unknown):Promise<RegistrationResponseJSON>{
  return page.evaluate(async(options)=>{
    const o=PublicKeyCredential.parseCreationOptionsFromJSON(options as PublicKeyCredentialCreationOptionsJSON)
    return (await navigator.credentials.create({publicKey:o}) as PublicKeyCredential).toJSON()
  },options) as Promise<RegistrationResponseJSON>
}
async function assertion(page:Page,options:unknown):Promise<AuthenticationResponseJSON>{
  return page.evaluate(async(options)=>{
    const o=PublicKeyCredential.parseRequestOptionsFromJSON(options as PublicKeyCredentialRequestOptionsJSON)
    return (await navigator.credentials.get({publicKey:o}) as PublicKeyCredential).toJSON()
  },options) as Promise<AuthenticationResponseJSON>
}
function changeClient<T extends {response:{clientDataJSON:string}}>(v:T,patch:Record<string,string>):T{
  const copy=structuredClone(v),data=JSON.parse(Buffer.from(copy.response.clientDataJSON,'base64url').toString('utf8'))
  copy.response.clientDataJSON=Buffer.from(JSON.stringify({...data,...patch})).toString('base64url');return copy
}
async function main(){
  const port=Number(process.env.P6_WEBAUTHN_TEST_PORT??3095)
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid test port')
  const origin='http://localhost:'+port
  process.env.PASSKEYS_ENABLED='true';process.env.WEBAUTHN_RP_ID='localhost';process.env.WEBAUTHN_ORIGIN=origin
  process.env.AUTH_PAIR_LIMIT='3600';process.env.AUTH_ACCOUNT_LIMIT='3600';process.env.AUTH_IP_LIMIT='3600'
  const http=createServer((_q,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Real WebAuthn protocol test</title>')})
  await new Promise<void>(resolve=>http.listen(port,'127.0.0.1',resolve))
  const browser=await chromium.launch({headless:true}),page=await browser.newPage(),cdp=await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}})
  try{
    await page.goto(origin)
    const password=randomBytes(24).toString('base64url'),owner=await createFirstOwner({email:'p6-passkey@example.test',password,firstName:'Passkey owner'})
    let token=(await signIn({email:owner.email,password,clientIp:'192.0.2.96'})).token
    const binding=newToken(),ip='192.0.2.96'
    const register=await beginPasskey('register',binding,ip,token),reg=await creation(page,register.options)
    const key=await finishPasskeyRegistration({id:register.id,binding,token,ip,name:'First device',response:reg})
    r.check((await passkeysFor(owner.id)).length===1,'P6W01 real browser registration writes verified public key')
    await no('P6W02 registration challenge cannot be replayed','do not match',()=>finishPasskeyRegistration({id:register.id,binding,token,ip,name:'Replay',response:reg}))
    const begun=await beginPasskey('login',binding,ip),signed=await assertion(page,begun.options)
    const login=await finishPasskeyAuthentication({flow:'login',id:begun.id,binding,ip,response:signed})
    token=login.token!
    r.check((await userForToken(token))?.strong_auth===true,'P6W03 real UV assertion creates current existing user/session')
    await no('P6W04 login challenge cannot be replayed','do not match',()=>finishPasskeyAuthentication({flow:'login',id:begun.id,binding,ip,response:signed}))
    for(const [label,patch] of [['P6W05 wrong origin rejected',{origin:'https://evil.example'}],['P6W06 wrong challenge rejected',{challenge:newToken()}],['P6W07 wrong flow rejected',{type:'webauthn.create'}]] as const){
      const b=await beginPasskey('login',binding,ip),response=await assertion(page,b.options)
      await no(label,'do not match',()=>finishPasskeyAuthentication({flow:'login',id:b.id,binding,ip,response:changeClient(response,patch)}))
      await no(label+' and failure does not revive challenge','do not match',()=>finishPasskeyAuthentication({flow:'login',id:b.id,binding,ip,response}))
    }
    const rp=await beginPasskey('login',binding,ip),rpResponse=await assertion(page,rp.options)
    const wrongRp=structuredClone(rpResponse),auth=Buffer.from(wrongRp.response.authenticatorData,'base64url');auth.fill(0,0,32);wrongRp.response.authenticatorData=auth.toString('base64url')
    await no('P6W08 wrong authenticator RP hash rejected','do not match',()=>finishPasskeyAuthentication({flow:'login',id:rp.id,binding,ip,response:wrongRp}))
    const uv=await beginPasskey('login',binding,ip)
    await cdp.send('WebAuthn.setUserVerified',{authenticatorId,isUserVerified:false})
    // Ask the browser for an assertion without requiring UV, then pass it to
    // the real server verifier which DOES require UV. Browser proof is real.
    const noUv=await assertion(page,{...uv.options,userVerification:'discouraged'})
    await no('P6W09 missing user verification rejected','do not match',()=>finishPasskeyAuthentication({flow:'login',id:uv.id,binding,ip,response:noUv}))
    await cdp.send('WebAuthn.setUserVerified',{authenticatorId,isUserVerified:true})
    const expired=await beginPasskey('login',binding,ip),expiredResponse=await assertion(page,expired.options)
    await db.execute(sql`UPDATE auth_webauthn_challenge SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired.id}::uuid`)
    await no('P6W10 expired challenge rejected','do not match',()=>finishPasskeyAuthentication({flow:'login',id:expired.id,binding,ip,response:expiredResponse}))
    const bound=await beginPasskey('login',binding,ip),boundResponse=await assertion(page,bound.options)
    await no('P6W11 different browser flow secret rejected','do not match',()=>finishPasskeyAuthentication({flow:'login',id:bound.id,binding:newToken(),ip,response:boundResponse}))
    const device2=await browser.newPage(),cdp2=await device2.context().newCDPSession(device2)
    await cdp2.send('WebAuthn.enable')
    await cdp2.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}})
    await device2.goto(origin)
    const registered=await beginPasskey('register',binding,ip,token),reg2=await creation(device2,registered.options)
    const second=await finishPasskeyRegistration({id:registered.id,binding,token,ip,name:'Second device',response:reg2})
    r.check((await passkeysFor(owner.id)).length===2,'P6W12 multiple actual resident credentials supported')
    await renamePasskey(token,second.id,'Renamed second device')
    r.check((await passkeysFor(owner.id)).some(k=>k.name==='Renamed second device'),'P6W13 credential name changes use current authorization and audit')
    const employee=await createUser({email:'p6-other@example.test',password,firstName:'Other',kind:'user',actor:owner.email})
    const foreign=(await signIn({email:employee.email,password})).token
    await no('P6W14 another user cannot delete credential','do not match',()=>revokePasskey(foreign,key.id,password,'',ip))
    await no('P6W15 unauthenticated deletion refused','Sign in again',()=>revokePasskey(newToken(),key.id,password,'',ip))
    await db.execute(sql`UPDATE user_session SET reauthenticated_at=clock_timestamp()-interval '6 minutes' WHERE token_hash=${(await import('../src/lib/users')).tokenHash(token)}`)
    await no('P6W16 adding key requires recent reauthentication','Sign in again',()=>beginPasskey('register',binding,ip,token))
    const reauth=await beginPasskey('reauth',binding,ip,token),reauthResponse=await assertion(page,reauth.options)
    await finishPasskeyAuthentication({flow:'reauth',id:reauth.id,binding,token,ip,response:reauthResponse})
    r.check(!!(await db.transaction(tx=>liveAuth(tx,token,true))),'P6W17 actual passkey assertion renews recent authentication')
    process.env.AUTH_ADMIN_MFA_REQUIRED='true'
    r.check(!!(await db.transaction(tx=>liveAuth(tx,token))),'P6W18 verified UV passkey satisfies existing required admin MFA')
    await no('P6W19 password alone cannot bypass enrolled admin passkey','do not match',()=>signIn({email:owner.email,password,clientIp:ip}))
    // Remove a noncurrent credential, preserving the verified current session.
    const [current]=await db.execute<{id:string}>(sql`SELECT authenticated_passkey_id::text AS id FROM user_session WHERE token_hash=${(await import('../src/lib/users')).tokenHash(token)}`)
    const remove=current.id===key.id?second.id:key.id,keep=current.id
    await revokePasskey(token,remove,'','',ip)
    r.check((await passkeysFor(owner.id)).length===1,'P6W20 selected credential revocation leaves alternate key')
    const old=await beginPasskey('login',binding,ip),oldResponse=await assertion(remove===key.id?page:device2,{...old.options,allowCredentials:[{id:remove===key.id?reg.id:reg2.id,type:'public-key'}]})
    await no('P6W21 revoked old credential cannot sign in','do not match',()=>finishPasskeyAuthentication({flow:'login',id:old.id,binding,ip,response:oldResponse}))
    await no('P6W22 last admin passkey requires valid strong alternative','Enable an authenticator',()=>revokePasskey(token,keep,password,'',ip))
    await manageMfa(token,'begin')
    const [u]=await db.execute<{secret:string}>(sql`SELECT mfa_pending_ciphertext AS secret FROM app_user WHERE id=${owner.id}::uuid`)
    const secret=decryptMfa(u.secret,owner.id),mfa=await manageMfa(token,'confirm',totp(secret))
    const recovery=mfa.recoveryCodes!
    const recovered=await signIn({email:owner.email,password,factor:recovery[0],clientIp:ip})
    token=recovered.token
    r.check((await userForToken(token))?.strong_auth===true,'P6W23 lost-device recovery uses actual password plus one-time TOTP recovery code')
    await no('P6W24 consumed recovery code cannot be reused','do not match',()=>signIn({email:owner.email,password,factor:recovery[0],clientIp:ip}))
    await revokePasskey(token,keep,password,recovery[1],ip)
    r.check((await passkeysFor(owner.id)).length===0,'P6W25 last key removed only with verified independent strong alternative')
    await no('P6W26 last authenticator removal without usable key refused','Keep a usable passkey',()=>manageMfa(token,'disable'))
    const disabled=await beginPasskey('login',binding,ip)
    process.env.PASSKEYS_ENABLED='false'
    await no('P6W27 feature flag refuses unfinished protocol','not enabled',()=>finishPasskeyAuthentication({flow:'login',id:disabled.id,binding,ip,response:signed}))
    process.env.PASSKEYS_ENABLED='true'
    await setUserStatus({userId:employee.id,isActive:false,actor:owner.email})
    r.check((await userForToken(foreign))===null,'P6W28 existing user deactivation still revokes session')
    await setPassword({userId:owner.id,password:password+'changed',actor:owner.email})
    r.check((await userForToken(token))===null,'P6W29 current existing password reset still ends every session')
    const audits=await db.execute<{action:string;n:number}>(sql`SELECT action,count(*)::int AS n FROM audit_log WHERE action IN ('passkey_registered','passkey_signed_in','passkey_reauthenticated','passkey_revoked','passkey_renamed') GROUP BY action`)
    const counts=Object.fromEntries(audits.map(a=>[a.action,a.n]))
    r.check(counts.passkey_registered===2&&counts.passkey_signed_in===1&&counts.passkey_reauthenticated===1&&counts.passkey_revoked===2&&counts.passkey_renamed===1,'P6W30 each actual passkey lifecycle operation writes existing audit trail')
    process.env.AUTH_ADMIN_MFA_REQUIRED='false'
    await setUserStatus({userId:employee.id,isActive:true,actor:owner.email})
    let employeeToken=(await signIn({email:employee.email,password})).token
    const device3=await browser.newPage(),cdp3=await device3.context().newCDPSession(device3)
    await cdp3.send('WebAuthn.enable')
    const thirdDevice=await cdp3.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}})
    await device3.goto(origin)
    const negative=await beginPasskey('register',binding,ip,employeeToken),negativeResponse=await creation(device3,negative.options)
    await no('P6W31 registration wrong origin refused','do not match',()=>finishPasskeyRegistration({id:negative.id,binding,token:employeeToken,ip,name:'Invalid origin',response:changeClient(negativeResponse,{origin:'https://evil.example'})}))
    await no('P6W32 failed registration consumes challenge','do not match',()=>finishPasskeyRegistration({id:negative.id,binding,token:employeeToken,ip,name:'Replay',response:negativeResponse}))
    // The browser already holds the rejected credential; use a new authenticator.
    await cdp3.send('WebAuthn.removeVirtualAuthenticator',thirdDevice)
    const syncDevice=await cdp3.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}})
    const er=await beginPasskey('register',binding,ip,employeeToken),ereg=await creation(device3,er.options)
    const ek=await finishPasskeyRegistration({id:er.id,binding,token:employeeToken,ip,name:'Employee device',response:ereg})
    const signedZero=async()=>{
      const b=await beginPasskey('login',binding,ip),response=await assertion(device3,{...b.options,allowCredentials:[{id:ereg.id,type:'public-key'}]})
      const {credentials}=await cdp3.send('WebAuthn.getCredentials',syncDevice)
      const credential=credentials.find(k=>Buffer.from(k.credentialId,'base64').toString('base64url')===ereg.id)!
      const data=Buffer.from(response.response.authenticatorData,'base64url');data[32]|=0x18;data.writeUInt32BE(0,33)
      response.response.authenticatorData=data.toString('base64url')
      // Real exported test key signs backup-eligible/backed-up zero-counter
      // bytes. The maintained server library performs all crypto verification.
      const pk=createPrivateKey({key:Buffer.from(credential.privateKey,'base64'),format:'der',type:'pkcs8'})
      response.response.signature=sign('sha256',Buffer.concat([data,createHash('sha256').update(Buffer.from(response.response.clientDataJSON,'base64url')).digest()]),pk).toString('base64url')
      return finishPasskeyAuthentication({flow:'login',id:b.id,binding,ip,response})
    }
    await db.execute(sql`UPDATE auth_passkey SET counter=0 WHERE id=${ek.id}::uuid`)
    employeeToken=(await signedZero()).token!
    const [cleared]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM auth_rate_bucket WHERE bucket_hash=${(await import('../src/lib/users')).tokenHash('passkey:account:login:'+ip)}`)
    r.check(cleared.n===0,'P6W38 successful verified login clears its flow failure budget')
    employeeToken=(await signedZero()).token!
    const [sync]=await db.execute<{counter:string;device_type:string;backed_up:boolean}>(sql`SELECT counter::text,device_type,backed_up FROM auth_passkey WHERE id=${ek.id}::uuid`)
    r.check(sync.counter==='0'&&sync.device_type==='multiDevice'&&sync.backed_up,'P6W33 real signed synced zero-counter assertions accepted twice by standard library')
    await setUserKind({userId:employee.id,kind:'owner',actor:owner})
    r.check((await userForToken(employeeToken))?.kind==='owner','P6W34 current role promotion is read by existing passkey session')
    await setUserKind({userId:employee.id,kind:'user',actor:owner})
    r.check((await db.transaction(tx=>liveAuth(tx,employeeToken))).kind==='user','P6W35 current role downgrade is read inside authorization transaction')
    // A retained old-domain key must never count as a usable alternative.
    await db.execute(sql`INSERT INTO auth_passkey(user_id,credential_id,public_key,algorithm,counter,device_type,backed_up,rp_id,origin,name,aaguid)
      SELECT user_id,credential_id||'-old-domain',public_key,algorithm,counter,device_type,backed_up,'old.example','https://old.example','Old domain',aaguid FROM auth_passkey WHERE id=${ek.id}::uuid`)
    await no('P6W36 stale-domain key cannot bypass last usable key alternative','Verify your password',()=>revokePasskey(employeeToken,ek.id,'','',ip))
    await setUserStatus({userId:employee.id,isActive:false,actor:owner.email})
    const inactive=await beginPasskey('login',binding,ip),inactiveResponse=await assertion(device3,inactive.options)
    await no('P6W37 inactive user cannot sign in with still-held credential','do not match',()=>finishPasskeyAuthentication({flow:'login',id:inactive.id,binding,ip,response:inactiveResponse}))
    console.log('Real Chromium CDP authenticator and PostgreSQL; physical devices and other browser engines are not claimed.')
    console.log(r.summary());process.exitCode=r.failures?1:0
  }finally{await cdp.send('WebAuthn.disable');await browser.close();await new Promise<void>(resolve=>http.close(()=>resolve()))}
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

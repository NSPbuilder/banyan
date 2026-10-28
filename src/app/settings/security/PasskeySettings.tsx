'use client'
import {useState} from 'react'
import {startRegistration,type PublicKeyCredentialCreationOptionsJSON} from '@simplewebauthn/browser'
import {beginPasskeyAction,registerPasskeyAction,managePasskeyAction} from '@/app/passkey-actions'
import {PasskeySignIn} from '@/components/PasskeySignIn'
import { Floating } from '@/components/Floating'
import { TimestampText } from '@/components/AccountingData'
import {BUTTON,QUIET,DANGER,LABEL,FIELD,REFUSAL} from '@/lib/ui'
type Key={id:string;name:string;created_at:string;last_used_at:string|null;device_type:string;backed_up:boolean;rp_id:string}
export function PasskeySettings({keys,rpID}:{keys:Key[];rpID:string}){
  const [name,setName]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState(false),[pending,setPending]=useState(false)
  async function run(task:()=>Promise<string>){setPending(true);setMessage('');setError(false);try{setMessage(await task())}catch(e){setError(true);setMessage(e instanceof Error?e.message:'Passkey operation failed.')}finally{setPending(false)}}
  async function register(){
    const begin=await beginPasskeyAction('register');if('error' in begin)throw Error(begin.error)
    const response=await startRegistration({optionsJSON:begin.options as PublicKeyCredentialCreationOptionsJSON})
    const result=await registerPasskeyAction(begin.id,response,name);if('error' in result)throw Error(result.error)
    setName('');return result.ok
  }
  return <section className="mt-8 max-w-xl border-t border-line pt-6" aria-label="Passkeys">
    <h2 className="text-section-title font-semibold">Passkeys</h2>
    <p className="mt-2 text-sm text-ink-muted">Use your device PIN or biometric check to sign in. Verify your identity before adding or managing a passkey. Keep another device or an authenticator with offline recovery codes.</p>
    <p className="mt-1 break-all text-xs text-ink-muted">Bound to {rpID}. A different domain needs fresh enrollment.</p>
    {keys.length>0&&<PasskeySignIn reauth/>}
    {message&&<p className={error?REFUSAL:'mt-3 text-sm'} role={error?'alert':'status'}>{message}</p>}
    <label className="mt-4 block text-sm">New passkey name<input name="passkeyName" value={name} onChange={e=>setName(e.target.value)} maxLength={80} className={`mt-1 w-full ${FIELD}`} placeholder="e.g. Office laptop"/></label>
    <button type="button" className={`mt-3 ${BUTTON}`} disabled={pending||!name.trim()} onClick={()=>void run(register)}>Add passkey</button>
    <ul className="mt-5 divide-y divide-line-subtle">{keys.map(k=><li key={k.id} className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0"><p className="text-label font-medium break-words">{k.name}</p><p className="mt-1 text-metadata text-ink-muted">{k.device_type==='multiDevice'?'Sync capable':'Single device'}{k.backed_up?' · Backed up':''}</p><p className="mt-1 text-metadata text-ink-muted">Last used: <TimestampText value={k.last_used_at}/></p></div>
      <Floating label="Manage" ariaLabel={`Manage passkey ${k.name}`} title={`Passkey · ${k.name}`} buttonClassName={QUIET}>
      <form className="mt-4 space-y-3" onSubmit={e=>e.preventDefault()}>
      {message&&<p className={error?REFUSAL:'text-label'} role={error?'alert':'status'}>{message}</p>}
      <label className={LABEL}>Passkey name<input name="name" defaultValue={k.name} maxLength={80} className={`mt-1 w-full ${FIELD}`}/></label>
      <p className="text-xs text-ink-muted">Last used: <TimestampText value={k.last_used_at}/> · {k.device_type==='multiDevice'?'Sync capable':'Single device'}{k.backed_up?' · Backed up':''}</p>
      <label className={LABEL}>Alternative password (required for your last passkey)<input name="alternativePassword" type="password" autoComplete="current-password" className={`mt-1 w-full ${FIELD}`}/></label>
      <label className={LABEL}>Alternative authenticator or recovery code<input name="alternativeCode" autoComplete="one-time-code" maxLength={64} className={`mt-1 w-full ${FIELD}`}/></label>
      <div className="flex flex-wrap gap-3">{(['rename','revoke'] as const).map(op=><button key={op} type="button" className={op==='revoke'?DANGER:QUIET} disabled={pending} onClick={e=>{
        const f=new FormData(e.currentTarget.form!);void run(async()=>{const result=await managePasskeyAction(op,k.id,String(f.get('name')??''),String(f.get('alternativePassword')??''),String(f.get('alternativeCode')??''));if('error' in result)throw Error(result.error);return result.ok})
      }}>{op==='rename'?'Rename':'Remove passkey'}</button>)}</div>
    </form></Floating></li>)}</ul>
    {keys.length===0&&<p className="mt-4 text-sm text-ink-muted">No passkeys registered.</p>}
  </section>
}

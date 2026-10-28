'use client'
import {useState} from 'react'
import {startAuthentication} from '@simplewebauthn/browser'
import type {PublicKeyCredentialRequestOptionsJSON} from '@simplewebauthn/browser'
import {beginPasskeyAction,authenticatePasskeyAction} from '@/app/passkey-actions'
import {QUIET,REFUSAL} from '@/lib/ui'
export function PasskeySignIn({next='',reauth=false}:{next?:string;reauth?:boolean}){
  const [pending,setPending]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(false)
  async function signIn(){
    setPending(true);setMessage('');setError(false)
    try{
      const flow=reauth?'reauth':'login',begin=await beginPasskeyAction(flow)
      if('error' in begin)throw Error(begin.error)
      const response=await startAuthentication({optionsJSON:begin.options as PublicKeyCredentialRequestOptionsJSON})
      const result=await authenticatePasskeyAction(flow,begin.id,response,next)
      if('error' in result)throw Error(result.error);setMessage(result.ok)
    }catch(e){setError(true);setMessage(e instanceof Error?e.message:'Passkey sign-in did not complete.')}
    finally{setPending(false)}
  }
  return <div className="mt-4 space-y-2">
    <button type="button" disabled={pending} className={QUIET} onClick={()=>void signIn()}>{pending?'Waiting for your passkey…':reauth?'Verify with a passkey':'Sign in with a passkey'}</button>
    {message&&<p role={error?'alert':'status'} className={error?REFUSAL:'text-sm'}>{message}</p>}
  </div>
}

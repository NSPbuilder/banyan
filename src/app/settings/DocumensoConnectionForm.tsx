'use client'

import { useState } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { BUTTON, FIELD, LABEL, QUIET } from '@/lib/ui'
import type { ConnectionSummary } from '@/lib/esign-types'

const input = FIELD + ' mt-1 block w-full'
export function SigningConnectionForm({ ledgerId, connection, action }: { ledgerId: string; connection: ConnectionSummary; action: FormAction }) {
  const [secret, setSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const generate = () => { const bytes = crypto.getRandomValues(new Uint8Array(32)); setSecret(Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')); setShowSecret(true) }
  return <ActionForm action={action} submit={connection ? 'Update connection' : 'Connect Documenso'} working="Checking connection…" buttonClassName={BUTTON} className="mt-4 space-y-4" onSucceeded={() => { setSecret(''); setShowSecret(false) }}>
    <input type="hidden" name="ledgerId" value={ledgerId}/>
    <label className={LABEL}>Team API token<input className={input} type="password" name="apiKey" autoComplete="off" required={!connection?.readable} placeholder={connection?.readable ? 'Leave blank to keep the saved token' : 'api_…'}/></label>
    <label className={LABEL}>Webhook secret<input className={input} type={showSecret ? 'text' : 'password'} name="webhookSecret" autoComplete="off" required={!connection} minLength={32} value={secret} onChange={e => setSecret(e.target.value)} placeholder={connection ? 'Leave blank to keep the saved secret' : 'Generate a secret below'}/></label>
    <div className="flex flex-wrap gap-2"><button type="button" className={QUIET} onClick={generate}>Generate secret</button><button type="button" className={QUIET} onClick={() => setShowSecret(v => !v)}>{showSecret ? 'Hide secret' : 'Show secret'}</button></div>
    <p className="text-xs text-neutral-500">Copy this secret before saving. You’ll need it in Documenso.</p>
  </ActionForm>
}

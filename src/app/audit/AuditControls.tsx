'use client'
import {useActionForm} from '@/components/ActionForm'
import {auditAction,type AuditState} from './actions'
import {BUTTON,QUIET,FIELD,REFUSAL} from '@/lib/ui'
export function AuditControls(){
  const {state,pending,formProps}=useActionForm<AuditState>(auditAction)
  return <form {...formProps} className="mt-3 space-y-3" aria-label="Audit verification controls">
    <div className="flex flex-wrap gap-3"><button className={BUTTON} disabled={pending} name="operation" value="verify">Verify audit now</button>
      <button className={QUIET} disabled={pending} name="operation" value="checkpoint">Create checkpoint</button></div>
    <label className="block text-sm">Independently retained checkpoint<input className={`mt-1 block max-w-full ${FIELD}`} type="file" name="checkpoint" accept="application/json,.json"/></label>
    <button className={QUIET} disabled={pending} name="operation" value="compare">Compare checkpoint</button>
    {state.error&&<p role="alert" className={REFUSAL}>{state.error}</p>}
    {state.ok&&<p role="status" className="text-sm">{state.ok}</p>}
    {state.checkpointId&&<a className={QUIET} href={`/audit/checkpoint/${state.checkpointId}`}>Download checkpoint JSON</a>}
  </form>
}

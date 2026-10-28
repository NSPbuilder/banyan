'use client'
import { useEffect, useRef, useState } from 'react'
// Load the actual Server Action when interacting, keeping static renderers
// independent from server-only authentication/database modules.
const editLeaseAction = async (...args: Parameters<typeof import('@/app/edit-actions').editLeaseAction>) =>
  (await import('@/app/edit-actions')).editLeaseAction(...args)
import type { EditProof, EditResource } from '@/lib/edit-proof'
import { EDIT_RESOURCES } from '@/lib/edit-proof'
import { leaseClientTiming } from '@/lib/edit-proof'
import { QUIET, REFUSAL } from '@/lib/ui'

// A Server Action can remount its editor. Preserve an explicit pause in this
// document's Window, independently in every browser tab and Desk iframe.
const pausedResources=()=>{
  const view=window as Window & {__figtreePausedEditors?:Set<string>}
  return view.__figtreePausedEditors ??= new Set<string>()
}
type EditorMemory={tabId:string;token?:string;generation?:string;epoch:number;queue:Promise<void>}
const editorMemory=(key:string)=>{
  const view=window as Window & {__figtreeEditorProofs?:Map<string,EditorMemory>}
  const editors=view.__figtreeEditorProofs ??= new Map<string,EditorMemory>()
  let memory=editors.get(key)
  if(!memory){memory={tabId:crypto.randomUUID(),epoch:0,queue:Promise.resolve()};editors.set(key,memory)}
  return memory
}

/** Each document has its own proof, including same-user tabs/iframes. Retain
 * custody through React remounts, never in localStorage or another Window.
 */
export function EditLease({resource, version, passive=false,boundary=false,onProof}:{resource:EditResource;version:string;passive?:boolean;boundary?:boolean;onProof?:(proof:EditProof)=>void}) {
  const node = useRef<HTMLDivElement>(null)
  const proof = useRef<EditProof>({version})
  const stopped = useRef(false)
  const [shown,setShown] = useState<EditProof>({version})
  const [message,setMessage] = useState('Checking edit protection…')
  const [expires,setExpires] = useState<string>()
  const [problem,setProblem] = useState(false)
  const [restart,setRestart] = useState(0)
  const request = useRef<(operation:'acquire'|'takeover')=>void>(()=>{})
  const resourceKey=`${resource.ledgerId}:${resource.type}:${resource.id}`
  useEffect(()=>{onProof?.(shown)},[shown,onProof])
  useEffect(()=>{
    if (passive) return
    const {heartbeatMs,idleMs}=leaseClientTiming()
    const memory=editorMemory(resourceKey)
    proof.current={...proof.current,tabId:memory.tabId,token:memory.token,generation:memory.generation}
    let live=true, lastInteraction=Date.now()
    const epoch=++memory.epoch
    const visible=()=> (!window.frameElement || (!!window.frameElement.getClientRects().length && getComputedStyle(window.frameElement).visibility==='visible')) && document.visibilityState==='visible' && !!node.current?.getClientRects().length
    const run=(operation:'acquire'|'heartbeat'|'takeover')=>{
      const task=async()=>{
      if(!live || epoch!==memory.epoch || stopped.current || !visible())return
      const sent={...proof.current,token:memory.token,generation:memory.generation}
      const result=await editLeaseAction(resource,operation,sent).catch(()=>({error:'Connection lost. Your input is preserved.'}))
      if('token' in result && result.token){memory.token=result.token;memory.generation=result.generation}
      if (!live || epoch!==memory.epoch) {
        if (epoch===memory.epoch && 'token' in result && result.token) await editLeaseAction(resource,'release',{...sent,token:result.token,generation:result.generation}).catch(()=>{})
        return
      }
      if(stopped.current){
        if(operation!=='heartbeat' && 'token' in result && result.token)
          await editLeaseAction(resource,'release',{...sent,token:result.token,generation:result.generation}).catch(()=>{})
        return
      }
      if ('error' in result) {stopped.current=true;setProblem(true);setMessage(result.error ?? 'Edit protection unavailable.');return}
      if ('token' in result && result.token) {
        proof.current={...proof.current,token:result.token,generation:result.generation}
        setShown({...proof.current});setExpires(result.expiresAt)
        const stale=result.version !== proof.current.version
        setProblem(stale);setMessage(stale ? 'The saved document changed. Keep your input and compare before reloading.' : `Editing as ${result.editor}.`)
      }
      }
      // Serialize this mounted editor's requests. StrictMode cleanup must
      // finish releasing an in-flight acquisition before its successor runs.
      memory.queue=memory.queue.then(task,task)
      return memory.queue
    }
    request.current=operation=>{pausedResources().delete(resourceKey);stopped.current=false; void run(operation) }
    stopped.current=pausedResources().has(resourceKey)
    if(stopped.current)void Promise.resolve().then(()=>{if(live){setProblem(true);setMessage('Editing stopped. Your input stays here; check again before saving.')}})
    else if(visible()) void run('acquire')
    const form=boundary?node.current?.closest('[data-edit-boundary]'):node.current?.closest('form')
    const interaction=()=>{lastInteraction=Date.now()}
    const saved=(event:Event)=>{
      const updated=(event as CustomEvent<{version?:string}>).detail?.version
      if(updated){proof.current.version=updated;setShown({...proof.current});setProblem(false);setMessage('Saved. Your edit lease is still active.')}
    }
    form?.addEventListener('input',interaction);form?.addEventListener('pointerdown',interaction);form?.addEventListener('figtree:document-version',saved)
    const interval=setInterval(()=>{
      if(!stopped.current && visible() && Date.now()-lastInteraction<idleMs) void run(proof.current.token?'heartbeat':'acquire')
    },heartbeatMs)
    const visibility=()=>{if(!stopped.current && visible() && Date.now()-lastInteraction<idleMs)void run(proof.current.token?'heartbeat':'acquire')}
    document.addEventListener('visibilitychange',visibility)
    return ()=>{
      live=false;clearInterval(interval);document.removeEventListener('visibilitychange',visibility)
      form?.removeEventListener('input',interaction);form?.removeEventListener('pointerdown',interaction);form?.removeEventListener('figtree:document-version',saved)
      memory.queue=memory.queue.then(async()=>{if(epoch===memory.epoch && memory.token)await editLeaseAction(resource,'release',{...proof.current,tabId:memory.tabId,token:memory.token,generation:memory.generation}).catch(()=>{})})
    }
  },[resource.ledgerId,resource.type,resource.id,passive,restart]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={node} className="mb-3 text-xs" data-edit-protection>
    <input type="hidden" name="expectedVersion" value={passive ? version : shown.version} />
    {!passive && <><input type="hidden" name="editTab" value={shown.tabId ?? ''}/><input type="hidden" name="editToken" value={shown.token ?? ''}/><input type="hidden" name="editGeneration" value={shown.generation ?? ''}/>
      <p role="status" className={problem?REFUSAL:'text-ink-muted'}>{message} {expires && `Lease until ${new Date(expires).toLocaleTimeString()}.`}</p>
      {!problem && shown.token && <button type="button" className={QUIET} onClick={()=>{pausedResources().add(resourceKey);stopped.current=true;const memory=editorMemory(resourceKey);memory.queue=memory.queue.then(async()=>{const result=await editLeaseAction(resource,'release',{...proof.current,tabId:memory.tabId,token:memory.token,generation:memory.generation}).catch(()=>({error:'Connection lost'}));setProblem(true);setMessage('error' in result ? 'Editing paused. Release could not be confirmed; the lease will expire. Your input stays here.' : 'Editing stopped. Your input stays here; check again before saving.')})}}>Stop editing</button>}
      {problem && <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={QUIET} onClick={()=>{pausedResources().delete(resourceKey);setRestart(n=>n+1)}}>Check again</button>
        <button type="button" className={QUIET} onClick={()=>request.current('takeover')}>Administrator takeover</button>
        <a className={QUIET} href={`/ledger/${resource.ledgerId}/${EDIT_RESOURCES[resource.type].path}${['payment','inbound'].includes(resource.type)?'':'/'+resource.id}`} target="_blank" rel="noopener">Compare saved document</a>
      </div>}
    </>}
  </div>
}

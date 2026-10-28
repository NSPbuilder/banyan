import Link from 'next/link'
import type {PanelState} from '@/lib/ai-service'
import {personalSettingsPath} from '@/lib/settings-context'

/** Workflow status only; credentials are configured in Settings. */
export function AiServiceStatus({ledgerId,state}:{ledgerId:string;state:PanelState}){
  return <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-metadata text-ink-secondary">
    <p>{state.kind==='ready'?`${state.model} · ${state.host}`:state.kind==='unreadable'?'Your saved AI key needs to be entered again in Settings.':'Configure your AI service in Settings to use this workflow.'}</p>
    <Link className="underline underline-offset-2" href={personalSettingsPath(ledgerId,'ai')}>AI settings</Link>
  </div>
}

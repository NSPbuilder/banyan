'use client'

import { useState } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { ASSISTANT_FIELDS as F } from '@/lib/forms'
import type { PanelState } from '@/lib/ai-service'
import { BUTTON_WIDE, FIELD } from '@/lib/ui'

export type { PanelState }

/**
 * The person's service: what is saved, and the form to save or change it.
 *
 * Saved encrypted under the application's secret (0063); shown here as the
 * host, the model, the key's last four characters and the prices. The key
 * box is blank on purpose when a key is saved — leaving it blank keeps the
 * saved key, so changing the model or the prices does not mean typing it
 * again. Actions arrive as props so a check can render this without a
 * server runtime (the ActionForm rule).
 */
export function ServicePanel({ ledgerId, state, secretSet, saveAction, clearAction }: {
  ledgerId: string; state: PanelState; secretSet: boolean; saveAction: FormAction; clearAction: FormAction
}) {
  const [editing, setEditing] = useState(state.kind !== 'ready')
  const box = FIELD
  const saved = state.kind === 'ready' ? state : null

  return (
    <section className="max-w-2xl text-body">
      <h2 className="text-section-title font-semibold">AI service</h2>
      <p className="mt-1 text-metadata text-ink-secondary">Your personal service is used across your companies.</p>

      {!secretSet && (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Keys cannot be kept yet: the owner has to put <code>AI_KEY_SECRET</code> in <code>.env.local</code>
          (any long random string, for example from <code>openssl rand -hex 32</code>) and restart the application.
        </p>
      )}

      {state.kind === 'unreadable' && (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Your saved key (ending …{state.hint}, {state.model} at {state.host}) can no longer be read: the
          application&apos;s secret has changed. Enter the key again below.
        </p>
      )}

      {saved && !editing && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>{saved.model} at <span className="font-mono">{saved.host}</span></span>
          <span className="text-neutral-500">key ending …{saved.hint}</span>
          <span className="text-neutral-500">
            {saved.prices
              ? `${saved.prices.unit}${saved.prices.input} in / ${saved.prices.unit}${saved.prices.output} out per million`
              : 'no prices, so askings show tokens only'}
          </span>
          <button type="button" onClick={() => setEditing(true)} className="underline decoration-dotted">Change</button>
          <ActionForm action={clearAction} submit="Remove key" working="…" buttonClassName="underline decoration-dotted text-neutral-500">
            <input type="hidden" name={F.ledgerId} value={ledgerId} />
          </ActionForm>
        </div>
      )}

      {(editing || state.kind !== 'ready') && (
        <ActionForm action={saveAction} submit="Save AI settings" working="Saving…" className="mt-2"
                    buttonClassName={`mt-3 ${BUTTON_WIDE}`}
                    onSucceeded={() => setEditing(false)}>
          <input type="hidden" name={F.ledgerId} value={ledgerId} />

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">API base URL
              <input name={F.baseUrl} autoComplete="off" className={box}
                     defaultValue={saved?.baseUrl ?? (state.kind === 'unreadable' ? state.baseUrl : '')} /></label>
            <label className="flex flex-col gap-1">Model
              <input name={F.model} autoComplete="off" className={box}
                     defaultValue={saved?.model ?? (state.kind === 'unreadable' ? state.model : '')} /></label>
            <label className="flex flex-col gap-1 sm:col-span-2">API key{saved ? ' · Saved' : ''}
              <input name={F.apiKey} type="password" autoComplete="new-password" className={box} /></label>
          </div>
          <details className="mt-2 text-xs text-neutral-500" open={saved?.prices !== null && saved?.prices !== undefined}>
            <summary className="cursor-pointer">Prices</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-4">
              <label className="flex flex-col gap-1">Per million in
                <input name={F.priceInput} inputMode="decimal" className={box} defaultValue={saved?.prices?.input ?? ''} /></label>
              <label className="flex flex-col gap-1">Per million out
                <input name={F.priceOutput} inputMode="decimal" className={box} defaultValue={saved?.prices?.output ?? ''} /></label>
              <label className="flex flex-col gap-1">Cached
                <input name={F.priceCached} inputMode="decimal" className={box} defaultValue={saved?.prices?.cached ?? ''} /></label>
              <label className="flex flex-col gap-1">Unit
                <input name={F.priceUnit} className={box} defaultValue={saved?.prices?.unit ?? ''} /></label>
            </div>
          </details>
          {saved && (
            <button type="button" onClick={() => setEditing(false)} className="ml-3 mt-3 text-xs text-neutral-500 underline decoration-dotted">Cancel</button>
          )}
        </ActionForm>
      )}
    </section>
  )
}

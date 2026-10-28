'use client'

import { useState } from 'react'
import { useActionForm, type FormAction } from '@/components/ActionForm'
import { LIQUID_TINTS, MODES, THEMES, type Appearance, type ThemeName } from '@/lib/appearance'
import { BUTTON, REFUSAL } from '@/lib/ui'

const CHOICE = 'flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-neutral-300 px-3 py-2 text-sm hover:border-neutral-500 has-checked:border-clay-600 has-checked:bg-clay-50 dark:border-neutral-700 dark:has-checked:bg-neutral-800'

export function AppearanceForm({ current, action }: { current: Appearance; action: FormAction }) {
  const { state, pending, formProps } = useActionForm(action)
  const [theme, setTheme] = useState<ThemeName>(current.theme)
  const [liquidTint, setLiquidTint] = useState(current.liquidTint)

  return (
    <form {...formProps} onReset={(event) => event.preventDefault()} className="mt-6 max-w-2xl space-y-4">
      <input type="hidden" name="liquidTint" value={liquidTint} />
      <fieldset className="border-b border-neutral-200 pb-4 dark:border-neutral-800">
        <legend className="mb-2 text-sm font-semibold">Theme</legend>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((t) => (
            <label key={t.name} className={CHOICE}>
              <input type="radio" name="theme" value={t.name} checked={theme === t.name}
                     onChange={() => setTheme(t.name)} />
              <span>{t.label}</span>
              <span aria-hidden="true" className="flex overflow-hidden rounded-sm border border-neutral-300">
                {t.swatch.map((c) => <span key={c} style={{ background: c }} className="h-3 w-3" />)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="border-b border-neutral-200 pb-4 dark:border-neutral-800">
        <legend className="mb-2 text-sm font-semibold">Mode</legend>
        <div className="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <label key={m.name} className={CHOICE}>
              <input type="radio" name="mode" value={m.name} defaultChecked={current.mode === m.name} />
              <span>{m.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {theme === 'liquid' && (
        <fieldset className="border-b border-neutral-200 pb-4 dark:border-neutral-800">
          <legend className="mb-2 text-sm font-semibold">Glass colour</legend>
          <div className="flex flex-wrap items-center gap-2">
            {LIQUID_TINTS.map((option) => (
              <button key={option.value} type="button" onClick={() => setLiquidTint(option.value)}
                      aria-label={`${option.label} background`} title={option.label}
                      aria-pressed={liquidTint === option.value}
                      className={`flex h-10 w-10 items-center justify-center rounded-md border ${liquidTint === option.value ? 'border-clay-600 ring-2 ring-clay-500' : 'border-neutral-300'}`}>
                <span aria-hidden="true" className="h-6 w-6 rounded-sm" style={{ backgroundColor: option.value }} />
              </button>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <span>Custom</span>
              <input type="color" value={liquidTint} aria-label="Custom glass colour"
                     onChange={(event) => setLiquidTint(event.target.value)}
                     className="h-10 w-10 cursor-pointer rounded-md border border-neutral-300" />
            </label>
          </div>
        </fieldset>
      )}
      {state.error && <p role="alert" className={REFUSAL}>{state.error}</p>}
      {state.ok && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{state.ok}</p>}
      <button type="submit" disabled={pending} className={BUTTON}>{pending ? 'Saving…' : 'Save'}</button>
    </form>
  )
}

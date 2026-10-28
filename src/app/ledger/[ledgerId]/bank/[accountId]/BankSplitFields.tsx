'use client'
import { IconButton } from '@/components/IconButton'

import { useState } from 'react'
import { Picker } from '@/components/Picker'
import { MATCH_FIELDS as F } from '@/lib/forms'
import { nativeMoney,nativeInput,parseNative } from '@/lib/fx-money'
import { MAX_BANK_SPLITS } from '@/lib/bank-splits'
import { FIELD, QUIET } from '@/lib/ui'
import type { ContraAccount } from './FeedScreen'

export function BankSplitFields({ form, enabled, onToggle, pending, remainder, accounts, initialAccount,currency='CAD' }: {
  currency?:string
  form: string; enabled: boolean; onToggle: (enabled: boolean) => void; pending: boolean
  remainder: bigint; accounts: ContraAccount[]; initialAccount: string
}) {
  const formatMoney=nativeMoney(currency),moneyInput=(n:bigint)=>nativeInput(n,currency),parseMoney=(v:string)=>parseNative(v,currency)
  const total = remainder < 0n ? -remainder : remainder
  const [parts, setParts] = useState(() => [
    { key: 0, amount: moneyInput(total / 2n) }, { key: 1, amount: moneyInput(total - total / 2n) },
  ])
  const [nextKey, setNextKey] = useState(2)
  let allocated = 0n
  let valid = true
  for (const p of parts) {
    try { const n = parseMoney(p.amount); if (n <= 0n) valid = false; allocated += n }
    catch { valid = false }
  }
  return (
    <div className="w-full min-w-0" data-bank-splits>
      <label className="inline-flex items-center gap-2 text-xs">
        <input type="checkbox" name={F.splitMode} value="yes" form={form} checked={enabled}
               disabled={pending} onChange={(e) => onToggle(e.target.checked)} />
        Split between accounts
      </label>
      {enabled && <fieldset disabled={pending} className="mt-3 space-y-2">
        {parts.map((part, i) => <div key={part.key} className="flex flex-wrap items-center gap-2">
          <div className="w-64 max-w-full">
            <Picker name={F.splitAccountId} form={form} required className="w-full"
                    ariaLabel={`Split account ${i + 1}`} defaultValue={i === 0 ? initialAccount : ''}
                    options={accounts.map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` }))} />
          </div>
          <input name={F.splitAmount} form={form} aria-label={`Split amount ${i + 1}`} required
                 inputMode="decimal" value={part.amount}
                 onChange={(e) => setParts((old) => old.map((p) => p.key === part.key ? { ...p, amount: e.target.value } : p))}
                 className={`${FIELD} w-32 text-right font-mono text-xs`} />
          {parts.length > 2 && <IconButton icon="delete" label={`Remove split ${i + 1}`}
            onClick={() => setParts((old) => old.filter((p) => p.key !== part.key))} className={QUIET}/>}
        </div>)}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={QUIET} disabled={parts.length >= MAX_BANK_SPLITS}
                  onClick={() => { setParts((old) => [...old, { key: nextKey, amount: '' }]); setNextKey((n) => n + 1) }}>+ Add split</button>
          <span aria-live="polite" className={`text-xs ${valid && allocated === total ? 'text-neutral-500' : 'text-amber-700 dark:text-amber-400'}`}>
            Allocated {formatMoney(allocated)} / {formatMoney(total)} · Remaining {formatMoney(total - allocated)}
          </span>
        </div>
        <p className="text-xs text-neutral-500">Amounts include the selected tax.</p>
      </fieldset>}
    </div>
  )
}

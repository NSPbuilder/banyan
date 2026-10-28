'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { AmountInput } from '@/components/AmountInput'
import { amountInput } from '@/lib/amount-input'
import { GST_EDITABLE_LINES, type GstAdjustment, type GstKey } from '@/lib/gst-adjustment-fields'
import { formatMoney, moneyInput } from '@/lib/money'
import { BUTTON, FIELD, LABEL, QUIET } from '@/lib/ui'

export function GstAdjustments({ ledgerId, from, to, books, saved, action }: {
  ledgerId: string; from: string; to: string; books: Record<GstKey, string>
  saved: GstAdjustment | null; action: FormAction
}) {
  const router = useRouter()
  const [values, setValues] = useState<Record<GstKey, string>>(() => Object.fromEntries(
    GST_EDITABLE_LINES.map(({ key }) => [key, saved?.[key] == null ? '' : moneyInput(BigInt(saved[key]!))]),
  ) as Record<GstKey, string>)
  const parsed = Object.fromEntries(GST_EDITABLE_LINES.map(({ key }) => [key,
    values[key].trim() ? amountInput(values[key]) : { cents: BigInt(books[key]) },
  ])) as Record<GstKey, ReturnType<typeof amountInput>>
  const net = parsed.collected.cents === null || parsed.itcs.cents === null ? null
    : parsed.collected.cents - parsed.itcs.cents
  return <details className="mt-6 border-t border-line pt-4 print:hidden" data-gst-adjustments>
    <summary className="cursor-pointer text-label font-medium">Edit return figures</summary>
    <p className="mt-3 max-w-2xl text-metadata text-ink-secondary">
      Enter final amounts for this return period. A blank field follows the books; zero is an explicit override.
      Line 109 is calculated from lines 105 and 108. Saved amounts stay fixed until you change or reset them.
    </p>
    <ActionForm action={action} submit="Save return figures" working="Saving…" buttonClassName={BUTTON}
      className="mt-4 space-y-4" onSucceeded={() => router.refresh()}
      secondaryActions={<button type="submit" name="intent" value="reset" formNoValidate className={QUIET}>Reset to books</button>}>
      <input type="hidden" name="ledgerId" value={ledgerId} />
      <input type="hidden" name="from" value={from} /><input type="hidden" name="to" value={to} />
      <input type="hidden" name="version" value={saved?.version ?? 0} />
      <div className="grid gap-4 sm:grid-cols-3">
        {GST_EDITABLE_LINES.map(({ key, line, label }) => <label key={key} className={LABEL}>
          {line} · {label}
          <span className="my-1 block text-caption font-normal text-ink-secondary">Books: {formatMoney(BigInt(books[key]))}</span>
          <AmountInput name={key} aria-label={`Line ${line} final amount`} className={`${FIELD} w-full text-right tabular-nums`}
            value={values[key]} placeholder={moneyInput(BigInt(books[key]))} error={parsed[key].error}
            onChange={e => setValues({ ...values, [key]: e.target.value })} />
        </label>)}
      </div>
      <p className="text-body" aria-live="polite">109 · Net tax: <strong>{net === null ? 'Check amounts' : formatMoney(net)}</strong></p>
      <label className={LABEL}>Reason for change
        <textarea name="reason" required maxLength={4000} rows={2}
          defaultValue={saved && GST_EDITABLE_LINES.some(({ key }) => saved[key] !== null) ? saved.reason : ''} className={`${FIELD} mt-1 w-full`} />
      </label>
    </ActionForm>
  </details>
}

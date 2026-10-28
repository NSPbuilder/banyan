'use client'

import { formatMoney } from '@/lib/money'
import { useActionForm } from '@/components/ActionForm'
import { closeYearAction } from '@/app/actions'
import { BUTTON, REFUSAL } from '@/lib/ui'

/**
 * A year with revenue or expense still in it is not finished. Until the closing
 * entry is posted, every later balance sheet is out by exactly that result: the
 * profit sits in the asset balances and in nothing on the other side.
 */
export function CloseYear({
  ledgerId, unclosed,
}: {
  ledgerId: string
  unclosed: Array<{ id: string; name: string; end_date: string; result: string }>
}) {
  // One hook, several forms: they hold nothing but hidden ids, so the shared
  // ref (it lands on the last form) has nothing typed to mis-reset.
  const { state, pending, formProps: actionProps } = useActionForm(closeYearAction)
  if (unclosed.length === 0 && !state.ok) return null

  return (
    <div className="py-1 text-sm">
      {state.ok ? (
        <p role="status" className="py-2 text-emerald-800 dark:text-emerald-300">{state.ok}</p>
      ) : (
        <>
          {state.error && (
            <p role="alert" className={`mt-2 ${REFUSAL}`}>
              {state.error}
            </p>
          )}
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {unclosed.map((y) => {
              const result = BigInt(y.result)
              return (
                <li key={y.id} className="py-3">
                  <form {...actionProps} className="flex flex-wrap items-center justify-between gap-3">
                    <input type="hidden" name="ledgerId" value={ledgerId} />
                    <input type="hidden" name="fiscalYearId" value={y.id} />
                    <span><strong className="font-medium">{y.name}</strong>
                      <span className="ml-3 text-xs text-neutral-500">
                        ended {y.end_date} ·{' '}
                        {result === 0n
                          ? 'net zero'
                          : `${result < 0n ? 'profit' : 'loss'} of ${formatMoney(result < 0n ? -result : result)}`}
                      </span>
                    </span>
                    <button type="submit" disabled={pending} className={BUTTON}>
                      {pending ? 'Closing…' : `Close ${y.name}`}
                    </button>
                  </form>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

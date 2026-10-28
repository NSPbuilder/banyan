'use client'

import { IconButton } from './IconButton'
import { AmountInput } from './AmountInput'
import { amountInput } from '@/lib/amount-input'
import { lineGst, linePst } from '@/lib/forms'
import { moneyInput, parseMoney } from '@/lib/money'
import { computeEnteredTax, parseTaxOverride, type TaxCode } from '@/lib/tax-rates'

export const TAX_FIELDS_GRID = 'grid grid-cols-[6rem_6rem_1.5rem] items-center gap-2'
export const TAX_FIELDS_GRID_COMPACT = 'grid grid-cols-[5rem_5rem_1.5rem] items-center gap-2'

/** Visible suggestions and separately submitted overrides keep automatic values
 * automatic. A refused save retains the parent row's controlled strings. */
export function LineTaxes({ index, lineNumber = index + 1, amount, code, inclusive, on, gst, pst, fieldClass, onChange, onReset, compact=false, disabled=false }: {
  index: number; lineNumber?: number; amount: string; code: TaxCode; inclusive: boolean; on: string
  gst?: string; pst?: string; fieldClass: string
  onChange: (tax: 'gst' | 'pst', value: string) => void
  onReset: () => void
  compact?: boolean; disabled?: boolean
}) {
  let suggested: { gst: bigint; pst: bigint } | null = null
  try { if (amount.trim()) suggested = computeEnteredTax(parseMoney(amount), code, inclusive, on,
    { gst: parseTaxOverride(gst), pst: parseTaxOverride(pst) }) } catch { /* unfinished input */ }
  return <div className={compact?TAX_FIELDS_GRID_COMPACT:TAX_FIELDS_GRID}>
    {(['gst', 'pst'] as const).map(tax => {
      const selected = tax === 'gst' ? code === 'GST' || code === 'GST_PST' : code === 'PST' || code === 'GST_PST'
      const value = tax === 'gst' ? gst : pst
      return <span key={tax} data-cell={tax}>
        <input type="hidden" name={tax === 'gst' ? lineGst(index) : linePst(index)} value={value ?? ''} />
        <AmountInput error={value === undefined ? undefined : amountInput(value).error} type="text" inputMode="decimal" aria-label={`${tax.toUpperCase()} on line ${lineNumber}`}
          disabled={disabled || !selected} value={value ?? (suggested ? moneyInput(suggested[tax]) : '')}
          className={`w-full text-right tabular-nums disabled:opacity-40 ${fieldClass}`}
          onChange={e => onChange(tax, e.target.value)} />
      </span>
    })}
    <IconButton icon="reset" label={`Use tax rates on line ${lineNumber}`}
      disabled={disabled || (gst === undefined && pst === undefined)} onClick={onReset} className="min-w-0 px-0"/>
  </div>
}

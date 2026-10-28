'use client'
import type { KeyboardEvent } from 'react'

import { lineAccount, lineAmount, lineDescription, lineTaxCode } from '@/lib/forms'
import { TAX_CODES, type TaxCode } from '@/lib/tax-rates'
import { duplicateRow, addRow, editRow, moveRowTo, removeRow, resetRowTax, typedTotal, type RowState } from '@/lib/invoice-rows'
import { Money } from '@/components/AccountingData'
import { IconButton } from '@/components/IconButton'
import { AmountInput } from '@/components/AmountInput'
import { amountInput } from '@/lib/amount-input'
import { QUIET } from '@/lib/ui'
import { focusLineCell, lineKeyboard } from '@/components/LineNavigation'
import { Picker, type PickerCreate } from '@/components/Picker'
import type { Choice } from '@/lib/forms'
import { LineTaxes, TAX_FIELDS_GRID } from '@/components/LineTaxes'
import { LineDragHandle, LineDragStatus, useLineDrag, type LineDragBindings } from '@/components/LineDrag'

type InvoiceLinesProps = {
  state: RowState
  setState: (next: RowState) => void
  lineAccounts: Choice[]
  fieldClass: string
  inclusive?: boolean
  issuedOn?: string
  /** The door that creates an account, for the picker's own creating row. */
  newAccount?: PickerCreate
  disabled?: boolean
}

/** Browser interaction lives here; the content renderer keeps field wiring testable. */
export function InvoiceLines(props: InvoiceLinesProps) {
  const drag = useLineDrag({ keys: props.state.rows.map(row => String(row.key)), disabled: props.disabled,
    onReorder: (key, to) => props.setState(moveRowTo(props.state, Number(key), to)) })
  return <InvoiceLinesContent {...props} drag={drag} />
}

/** Stable keys identify lines; their current positions name the submitted fields. */
export function InvoiceLinesContent({
  state, setState, lineAccounts, fieldClass, newAccount, inclusive = false, issuedOn, drag, disabled,
}: InvoiceLinesProps & { drag: LineDragBindings }) {
  const { containerRef, helpId, message, rowProps, handleProps } = drag
  const total = typedTotal(state.rows, issuedOn === undefined ? undefined : { inclusive, on: issuedOn })
  const copy = (key: number) => {
    setState(duplicateRow(state, key)); focusLineCell(containerRef, String(state.nextKey), 'description')
  }
  const navigate = (event: KeyboardEvent) => lineKeyboard({ ref: containerRef, keys: state.rows.map(row => String(row.key)), disabled,
    duplicate: key => copy(Number(key)), append: () => { setState(addRow(state)); return String(state.nextKey) },
  })(event)

  // One template for the headings and every row. Without the headings the
  // four boxes were four boxes and nothing said which was which (owner,
  // 2026-09-07: 「edit expense 的 ui 有点乱」).
  // The last track is a WIDTH, not `auto`. The headings and the rows are two
  // grid containers, so an `auto` track resolved to 0 over the empty heading
  // cell and to the button cluster's width over each row — and the flexible
  // description track absorbed the difference, offsetting every heading from
  // "Line description" rightward (critic, 2026-09-07).
  const TEMPLATE = 'grid grid-cols-[2rem_13rem_minmax(6rem,1fr)_6.5rem_8rem_14.5rem_4.5rem] items-center gap-2'

  return (
    <>
      <div ref={containerRef} onKeyDown={navigate} className="table-scroll mt-2" data-table-scroll tabIndex={0} role="region" aria-label="Invoice line items">
      <LineDragStatus id={helpId} message={message} />
      <div className="invoice-lines">
      <div className={`${TEMPLATE} mt-2 text-xs font-medium uppercase tracking-wide text-neutral-500`}>
        <span />
        <span>Account</span>
        <span>Line description</span>
        <span className="text-right">Amount</span>
        <span>Tax</span>
        <span className={TAX_FIELDS_GRID}><span className="text-right">GST</span><span className="text-right">PST</span><span /></span>
        <span />
      </div>
      <div className="mt-1 space-y-2">
        {state.rows.map((row, i) => (
          // A GRID with a fixed template: one line is one row, whatever the
          // viewport does — the tax column's arrival wrapped the old flex
          // layout onto two lines. The description column takes the slack.
          <div key={row.key} data-line-row={row.key} data-line={row.key} {...rowProps(String(row.key))} className={`${TEMPLATE} line-order-row`}>
            <LineDragHandle index={i} data-acts-on={row.key} data-does="reorder" {...handleProps(String(row.key))} />
            {/* Type to narrow; create the account you were looking for from
                inside the list (owner, 2026-09-07). */}
            <span data-cell="account"><Picker name={lineAccount(i)} value={row.account}
                    disabled={disabled} ariaLabel={`Account on line ${i + 1}`}
                    options={lineAccounts} create={newAccount}
                    onChange={(id) => setState(editRow(state, row.key, 'account', id))} /></span>
            <input data-cell="description" disabled={disabled} name={lineDescription(i)} value={row.description} className={fieldClass} aria-label={`Description on line ${i + 1}`}
                   onChange={(e) => setState(editRow(state, row.key, 'description', e.target.value))} />
            <span data-cell="amount"><AmountInput disabled={disabled} name={lineAmount(i)} value={row.amount}
                   error={amountInput(row.amount).error || (row.account && amountInput(row.amount).cents === 0n ? 'Enter a non-zero amount.' : undefined)}
                   className={`text-right font-mono tabular-nums ${fieldClass}`} aria-label={`Amount on line ${i + 1}`}
                   onChange={(e) => setState(editRow(state, row.key, 'amount', e.target.value))} /></span>
            <select data-cell="tax" disabled={disabled} name={lineTaxCode(i)} value={row.taxCode} className={fieldClass}
                    aria-label={`Tax on line ${i + 1}`}
                    onChange={(e) => setState(editRow(state, row.key, 'taxCode', e.target.value))}>
              {TAX_CODES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
            <LineTaxes disabled={disabled} index={i} amount={row.amount} code={row.taxCode as TaxCode} inclusive={inclusive}
                       on={issuedOn ?? ''} gst={row.gst} pst={row.pst} fieldClass={fieldClass}
                       onChange={(tax, value) => setState(editRow(state, row.key, tax, value))}
                       onReset={() => setState(resetRowTax(state, row.key))} />
            <span className="flex items-center gap-0.5">
              <IconButton icon="duplicate" label={`Duplicate line ${i + 1}`} data-acts-on={row.key} data-does="duplicate" disabled={disabled} onClick={() => copy(row.key)} />
              <IconButton icon="delete" data-acts-on={row.key} data-does="remove"
                      disabled={disabled} label={`Remove line ${i + 1}`}
                      onClick={() => setState(removeRow(state, row.key))} />
            </span>
          </div>
        ))}
      </div>
      </div>
      </div>

      <div className="journal-totals mt-3">
        <button type="button" data-does="add" disabled={disabled} onClick={() => { setState(addRow(state)); focusLineCell(containerRef, String(state.nextKey), 'account') }}
                className={QUIET}>
          Add a line
        </button>
        <p role="status" aria-live="polite" className="text-label text-ink-secondary">
          {total.unreadable ? 'Partial total' : 'Total'}{' '}
          <Money data-typed-total cents={total.total} className="font-mono text-ink"/>{' '}
          across {total.filled - total.unreadable} of {total.filled}
          {total.filled === 1 ? ' line' : ' lines'}
          {total.unreadable > 0 && (
            <span className="text-amber-700 dark:text-amber-500">
              {' '}— {total.unreadable} not yet an amount, so {total.unreadable === 1 ? 'it is' : 'they are'} not in that figure
            </span>
          )}
        </p>
        {/* The rule 13-numbers-and-taxes.md states (D22): a tag reads the tax
            from the line's sign, and a refund or a credit note points the
            other way. It was in the doc and on no screen. */}

      </div>
    </>
  )
}

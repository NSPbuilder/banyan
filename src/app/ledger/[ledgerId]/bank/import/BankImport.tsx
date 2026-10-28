'use client'

import { useState } from 'react'
import {
  findHeaderRow, guessMapping, parseCsv, profileColumns, screenFor, sniffDelimiter, withRole,
  type ColumnProfile, type ColumnRole, type Delimiter, type Mapping,
} from '@/lib/bank-csv'
import { csvFile, filename } from '@/lib/csv'
import { nativeInput } from '@/lib/fx-money'
import { type DateOrder } from '@/lib/dates'
import type { FormAction } from '@/components/ActionForm'
import { ImportScreen } from './ImportScreen'
import { LandRows, type ImportableAccount } from './LandRows'
import { BUTTON, REFUSAL } from '@/lib/ui'

type Loaded = {
  name: string
  delimiter: Delimiter
  grid: string[][]
  headerRow: number | null
  profiles: ColumnProfile[]
}

/**
 * Holds the file and the mapping. Every decision it shows is made in
 * `bank-csv.ts`, so that the rules can be tested somewhere other than here.
 *
 * The file is never uploaded anywhere. It is read in the browser; what can
 * leave is a CSV the user chooses to save, or the rows themselves once an
 * account is picked to save them against.
 */
export function BankImport({ ledgerId, accounts, action, newAccount }: {
  ledgerId: string
  accounts: ImportableAccount[]
  action: FormAction
  /** Passed through to the landing form: the bank account may not exist yet. */
  newAccount?: FormAction
}) {
  const currencies=[...new Set(accounts.map(a=>a.currency??'CAD'))]
  const [currency,setCurrency]=useState(currencies.includes('CAD')?'CAD':currencies[0]??'CAD')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [mapping, setMapping] = useState<Mapping | null>(null)
  const [refused, setRefused] = useState<string | null>(null)

  async function pick(file: File | undefined) {
    if (!file) return
    const text = await file.text()
    const delimiter = sniffDelimiter(text)
    const grid = parseCsv(text, delimiter)
    const headerRow = findHeaderRow(grid)
    const profiles = profileColumns(grid, headerRow)

    if (profiles.length === 0) {
      setLoaded(null)
      setMapping(null)
      setRefused(`${file.name} has no columns this can read. `
        + `A bank export saved as CSV rather than as a spreadsheet or a PDF is what this wants.`)
      return
    }

    setRefused(null)
    setLoaded({ name: file.name, delimiter, grid, headerRow, profiles })
    setMapping(guessMapping(profiles))
  }

  const screen = loaded && mapping
    ? screenFor(loaded.profiles, loaded.grid, loaded.headerRow, mapping,currency)
    : null

  function save() {
    if (!screen?.applied || !loaded) return
    const text = csvFile([
      ['date', 'amount', 'description'],
      ...screen.applied.rows.map((r) => [r.date, nativeInput(r.amount,currency), r.description]),
    ])
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename([loaded.name.replace(/\.csv$/i, ''), 'mapped'])
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mt-6">
      {currencies.length>1&&<label className="mb-4 block text-sm">Statement currency <select aria-label="Statement currency" value={currency} onChange={e=>setCurrency(e.target.value)} className="ml-2 rounded-control border border-line bg-surface p-2">{currencies.map(c=><option key={c} value={c}>{c}</option>)}</select></label>}
      {currency!=='CAD'&&<p className="mb-3 text-sm text-ink-secondary">Amounts are read in {currency}. Bind a new bank account’s currency in the FX workspace before importing.</p>}
      <label htmlFor="file" className="block text-xs font-medium uppercase tracking-wide text-neutral-500">
        Bank export
      </label>
      <input
        id="file" name="file" type="file" accept=".csv,.txt,text/csv,text/plain"
        onChange={(e) => void pick(e.target.files?.[0])}
        className="mt-1 block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-neutral-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white dark:file:bg-white dark:file:text-neutral-900"
      />

      {refused && (
        <p role="alert" className={`mt-3 ${REFUSAL}`}>
          {refused}
        </p>
      )}

      {loaded && mapping && screen && (
        <>
          <ImportScreen currency={currency}
            fileName={loaded.name}
            rowCount={loaded.grid.length - (loaded.headerRow === null ? 0 : loaded.headerRow + 1)}
            delimiter={loaded.delimiter}
            headerRow={loaded.headerRow}
            profiles={loaded.profiles}
            mapping={mapping}
            screen={screen}
            onRole={(index, role: ColumnRole) => setMapping(withRole(mapping, index, role))}
            onOrder={(order: DateOrder | null) => setMapping({ ...mapping, order })}
            onFlip={(flip) => setMapping({ ...mapping, flip })}
          />

          {screen.applied && screen.applied.rows.length > 0 && (
            <LandRows
              ledgerId={ledgerId} currency={currency} accounts={accounts.filter(a=>(a.currency??'CAD')===currency)} fileName={loaded.name}
              rows={screen.applied.rows} action={action} newAccount={newAccount} />
          )}

          {screen.applied && screen.applied.rows.length > 0 && (
            <div className="mt-6 flex items-center gap-3">
              <button
                type="button" onClick={save}
                className={BUTTON}
              >
                Save these rows as CSV
              </button>

            </div>
          )}
        </>
      )}
    </div>
  )
}

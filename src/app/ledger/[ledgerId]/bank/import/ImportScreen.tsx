'use client'

import {
  type ColumnProfile, type ColumnRole, type Delimiter, type Mapping, type Screen,
} from '@/lib/bank-csv'
import { type DateOrder } from '@/lib/dates'
import { ColumnMapper } from './ColumnMapper'
import { ImportPreview } from './ImportPreview'

/**
 * The whole body of the import screen, taking values that are already decided.
 *
 * It computes nothing. `screenFor` decided what to show; this arranges it. The
 * separation is what makes the screen testable at all — a script can render
 * this against a fixture and read what a person would see, which is the only
 * check that catches a guard the page forgot to call.
 */
export function ImportScreen({
  fileName, rowCount, delimiter, headerRow, profiles, mapping, screen,
  onRole, onOrder, onFlip,currency='CAD',
}: {
  currency?:string
  fileName: string
  rowCount: number
  delimiter: Delimiter
  headerRow: number | null
  profiles: ColumnProfile[]
  mapping: Mapping
  screen: Screen
  onRole: (index: number, role: ColumnRole) => void
  onOrder: (order: DateOrder | null) => void
  onFlip: (flip: boolean) => void
}) {
  return (
    <>
      <ColumnMapper
        fileName={fileName} rowCount={rowCount} delimiter={delimiter}
        headerRow={headerRow} profiles={profiles} mapping={mapping}
        onRole={onRole} onOrder={onOrder} onFlip={onFlip} />
      <ImportPreview currency={currency} problems={screen.problems} applied={screen.applied} />
    </>
  )
}

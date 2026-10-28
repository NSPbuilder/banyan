'use client'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} title="Print" className={TOOL_BUTTON}>
      <ToolAction kind="print">Print</ToolAction>
    </button>
  )
}

'use client'

import { ActionForm, type FormAction } from '@/components/ActionForm'
import { BUTTON } from '@/lib/ui'
import { RateFields, type RateRow } from '../Rates'

/** A new rate: the same boxes a row's Edit opens, with no id — which the door reads as "add". */
export function NewRateForm({ ledgerId, action, initial }: { ledgerId: string; action: FormAction; initial?: RateRow }) {
  return (
    <ActionForm action={action} submit="Add the rate" working="…"
                className="mt-4 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
      <RateFields ledgerId={ledgerId} initial={initial} />
    </ActionForm>
  )
}

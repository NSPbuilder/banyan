'use client'

import type { ComponentProps } from 'react'

/**
 * A date field — the ONLY one. Every date in this application is entered here.
 *
 * It was thirty-one hand-rolled text boxes before this (owner, 2026-09-03:
 * "很多日期栏只能手填，无日历弹出可选"), each carrying the same four
 * attributes to teach a text input what a date is: inputMode, a yyyy-mm-dd
 * placeholder, a pattern, a title. Four attributes that a browser already
 * knows, spelled thirty-one times — and any one of them could be forgotten on
 * the next field, which is exactly what a calendar-less date box is.
 *
 * `type="date"` posts `yyyy-mm-dd`, which is what every parser in this
 * repository already reads and what Postgres already casts. So the calendar
 * arrives without a second date grammar anywhere: no picker library, no
 * locale parsing, no client-side formatting.
 *
 * Clicking anywhere in the field opens the calendar. Chrome's own affordance
 * is a small icon at the right edge — findable only if you know it is there —
 * and `showPicker()` is the browser's supported way to say "the whole field is
 * the button". It throws when the call is not from a user gesture, or on a
 * browser that does not have it; both are fine, and both leave a field that
 * still types and still submits.
 */
export function DateInput({ onClick, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      {...props}
      type="date"
      onClick={(e) => {
        try { e.currentTarget.showPicker() } catch { /* no gesture, or no picker */ }
        onClick?.(e)
      }}
    />
  )
}

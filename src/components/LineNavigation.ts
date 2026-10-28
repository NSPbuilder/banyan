'use client'

import type { KeyboardEvent, RefObject } from 'react'

/** Picker/IME/native select handling wins; Enter moves vertically, Tab stays native. */
export function focusLineCell(ref: RefObject<HTMLElement | null>, key: string, column: string) {
  if (!ref.current) return
  requestAnimationFrame(() => {
    const cell = ref.current?.querySelector<HTMLElement>(`[data-line="${key}"] [data-cell="${column}"]`)
    const editable = 'input:not([type="hidden"]):not([disabled]),select:not([disabled]),textarea:not([disabled])'
    const input = cell?.matches(editable) ? cell : cell?.querySelector<HTMLElement>(editable)
    input?.focus()
  })
}

export function lineKeyboard({ ref, keys, disabled, duplicate, append }: {
  ref: RefObject<HTMLElement | null>; keys: string[]; disabled?: boolean
  duplicate: (key: string) => void; append: () => string
}) {
  return (event: KeyboardEvent) => {
    if (disabled || event.defaultPrevented || event.nativeEvent.isComposing) return
    const target = event.target as HTMLElement
    const column = target.closest<HTMLElement>('[data-cell]')?.dataset.cell
    const key = target.closest<HTMLElement>('[data-line]')?.dataset.line
    const index = keys.indexOf(key ?? '')
    if (!column || index < 0 || target.tagName === 'BUTTON') return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault(); duplicate(keys[index]); return
    }
    if (event.key !== 'Enter' || target.tagName === 'SELECT') return
    event.preventDefault()
    const next = index + (event.shiftKey ? -1 : 1)
    if (next < 0) return
    focusLineCell(ref, next >= keys.length ? append() : keys[next], column)
  }
}

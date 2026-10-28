'use client'

import { useEffect, useId, useRef, type InputHTMLAttributes } from 'react'

/** Native validity, visible error text and screen-reader state agree. */
export function AmountInput({ error, ...props }: InputHTMLAttributes<HTMLInputElement> & { error?: string }) {
  const ref = useRef<HTMLInputElement>(null), id = useId()
  useEffect(() => { ref.current?.setCustomValidity(error ?? '') }, [error])
  return <span className="block min-w-0">
    <input {...props} ref={ref} inputMode="decimal" aria-invalid={error ? true : undefined}
      aria-describedby={error ? id : props['aria-describedby']} />
    {error && <span id={id} className="mt-1 block text-caption text-danger-ink">{error}</span>}
  </span>
}

'use client'

import { useRouter } from 'next/navigation'
import { FIELD, LABEL } from '@/lib/ui'

export function LinkFilter({ label, value, options }: {
  label: string; value: string; options: Array<{ value: string; label: string; href: string }>
}) {
  const router = useRouter()
  return <label className={`${LABEL} flex flex-col gap-1`}>{label}
    <select value={value} className={FIELD} onChange={(event) => {
      const option = options.find((o) => o.value === event.target.value)
      if (option) router.replace(option.href, { scroll: false })
    }}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
  </label>
}

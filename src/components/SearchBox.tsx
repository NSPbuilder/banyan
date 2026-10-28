'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { FIELD } from '@/lib/ui'

/**
 * The search box — the ONE of them.
 *
 * Three places carry it: the workspace toolbar (which sends you to the search page), the
 * search page itself, and the journal (whose own box the owner asked for in
 * the same breath). All three put the same `q` in the URL, which is what
 * makes a search a place you can bookmark, reload and send to yourself.
 *
 * Two navigations, deliberately different. Going TO another page is a
 * navigation and pushes, so Back returns to where you were typing. Refining
 * the page you are already reading REPLACES, and does not scroll — the same
 * rule the range picker follows, and for the same complaint that created it.
 */
export function SearchBox({ to, label, placeholder, value, autoFocus, toolbar = false }: {
  /** Where the search happens. Omitted means: right here. */
  to?: string
  label?: string
  placeholder?: string
  value?: string
  autoFocus?: boolean
  toolbar?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const elsewhere = !!to && to !== pathname

  const go = (raw: string) => {
    const q = raw.trim()
    // Refining here keeps the rest of the query string — the range you
    // picked survives the word you typed. Going elsewhere starts clean,
    // because another page's parameters are not this page's.
    const params = new URLSearchParams(elsewhere ? '' : search.toString())
    params.delete('page')
    if (q) params.set('q', q)
    else params.delete('q')
    const qs = params.toString()
    const href = qs ? `${to ?? pathname}?${qs}` : (to ?? pathname)
    if (elsewhere) router.push(href)
    else router.replace(href, { scroll: false })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        go(String(new FormData(e.currentTarget).get('q') ?? ''))
      }}
      className="contents"
    >
      <label className="block text-xs text-neutral-500">
        {label && <span className="block">{label}</span>}
        <input
          name="q" type="search" defaultValue={value} autoFocus={autoFocus}
          // The value is uncontrolled and keyed on what the URL says, so a
          // reader who edits the address bar sees the box agree with it.
          key={value ?? ''}
          placeholder={placeholder ?? 'Search…'}
          aria-label={label ?? (toolbar ? 'Search this company' : (placeholder ?? 'Search'))}
          className={toolbar ? `w-full ${FIELD}` : label ? `mt-1 w-full ${FIELD}` : `w-full ${FIELD}`}
        />
      </label>
    </form>
  )
}

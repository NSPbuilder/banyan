'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ledgerOf } from '@/lib/tabs'

/**
 * The way out of a dead address.
 *
 * `not-found.tsx` takes no props in Next 16 — the file convention says so
 * outright — so the company this address belonged to cannot be handed to it.
 * The only place that survives is the url, and reading the url needs the
 * client. `ledgerOf` is the same parse the desk's tab labels use, so a path
 * that names a company here names one there.
 *
 * A boundary INSIDE `/ledger/[ledgerId]` was tried first, so that the rail
 * would already be on the page. It does not work: with the `@modal` parallel
 * slot on that segment, a `not-found.tsx` anywhere under it renders WITHOUT
 * the company shell — the rail disappears, which is worse than the root
 * boundary, not better (page pass, 2026-09-15). One boundary, and the link
 * read off the url, is the shape that actually works.
 */
export function WayOut() {
  const ledgerId = ledgerOf(usePathname() ?? '')
  return (
    <p className="mt-6 flex flex-wrap gap-4 text-sm">
      {ledgerId && (
        <Link href={`/ledger/${ledgerId}`} className="underline">Back to this company</Link>
      )}
      <Link href="/companies" className="underline">All companies</Link>
    </p>
  )
}

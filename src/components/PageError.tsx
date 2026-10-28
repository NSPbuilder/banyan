'use client'

import Link from 'next/link'
import { BUTTON, QUIET } from '@/lib/ui'
import { PageState } from './PageState'

/** Next 16.3 supplies retry, which re-fetches the route's data. */
export function PageError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <main className="w-full px-8 py-6">
    <PageState title="This page could not load" icon="alert" role="alert"
               action={<><button type="button" className={BUTTON} onClick={retry}>Retry</button><Link href="/companies" className={QUIET}>Companies</Link></>}>
      Try again, or return to Companies.
    </PageState>
  </main>
}

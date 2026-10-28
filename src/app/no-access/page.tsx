import Link from 'next/link'
import { requireUser } from '@/lib/gate'

export const dynamic = 'force-dynamic'

/**
 * What somebody sees when they open something they were not given.
 *
 * Next 16 has a designed answer for this — `forbidden()` with a `forbidden.tsx`
 * — and it is EXPERIMENTAL: the docs are marked canary and it needs
 * `experimental.authInterrupts` in the config. This repository has no
 * experimental flags, and a refusal page is not worth becoming the first one in
 * an accounting system somebody will run for years. So it is an ordinary page,
 * and the decision is written here rather than left to look like ignorance.
 *
 * It is GATED like everything else, and that is not circular: `refuseFor` only
 * refuses paths under `/ledger/…`, so this page can never refuse itself. A
 * refusal page that could be refused would be a redirect loop.
 */
export default async function NoAccess({
  searchParams,
}: { searchParams: Promise<{ why?: string }> }) {
  await requireUser()
  const { why } = await searchParams

  // Every code the gate can send here, with its own sentence. `N17` requires
  // this list to hold every `why=` in gate.ts — the point of redirecting rather
  // than throwing was that the person gets a sentence, and a code that falls
  // through to the generic line is that fix done halfway. NEEDS_OWNER and
  // NO_PATH did exactly that until somebody opened /users as a bookkeeper.
  const REASONS: Record<string, { said: string; ask: boolean }> = {
    NO_COMPANY: { said: 'That company is not one of yours.', ask: true },
    NO_MODULE: {
      said: 'That part of the books is not one you have been given.', ask: true,
    },
    NEEDS_OWNER: {
      said: 'That is for an owner account — managing people and taking backups.',
      ask: true,
    },
    NO_PATH: {
      said: 'This request did not arrive through the front door, so there was no '
        + 'way to tell what it was for. Opening the page again from a link '
        + 'usually settles it.',
      ask: false,
    },
  }
  const reason = REASONS[why ?? ''] ?? { said: 'You have not been given that.', ask: true }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center p-8 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Not yours to open</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        {reason.said}
        {reason.ask && ' Ask an owner if you need it — they can grant it on the '
          + 'People screen, and it takes effect the next time you load a page.'}
      </p>
      <p className="mt-6 text-sm">
        <Link href="/companies" className="underline">Back to your companies</Link>
      </p>
    </main>
  )
}

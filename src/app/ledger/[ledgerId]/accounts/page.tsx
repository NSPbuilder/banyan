
import { formatNumber } from '@/lib/numbers'
import { PageHeader } from '@/components/PageHeader'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { availableRoles, chartOfAccounts, untaggedAccounts } from '@/lib/accounts'
import { ChartSearch } from './ChartSearch'
import { ledgerHead } from '@/lib/ledger-head'
import { BUTTON, QUIET } from '@/lib/ui'

export const dynamic = 'force-dynamic'

export default async function AccountsPage({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()

  const { ledgerId } = await params

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const [accounts, untagged, roles] = await Promise.all([
    chartOfAccounts(head.entity_id),
    untaggedAccounts(head.entity_id),
    availableRoles(),
  ])

  const roleOptions = roles.map((r) => ({
    code: r.code, label: r.label, family: r.family,
    category: r.category, isCore: r.isCore,
  }))

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title="Chart of accounts" backTo={`/ledger/${ledgerId}`} backLabel={`Back to ${head.entity}`}>
        <Link href={`/ledger/${ledgerId}/accounts/import`} className={QUIET}>Import chart</Link>
        <Link href={`/ledger/${ledgerId}/accounts/new`} className={BUTTON}>Add an account</Link>
      </PageHeader>

      {accounts.length === 0 ? (
        <div className="mt-8">
          <p className="text-sm text-neutral-500">
            No accounts yet — nothing can be posted until this company has some.{' '}
            <Link href={`/ledger/${ledgerId}/accounts/new`} className="underline">
              Add them one at a time
            </Link>, or{' '}
            <Link href={`/ledger/${ledgerId}/accounts/import`} className="underline">
              paste a whole chart at once
            </Link>.
          </p>
        </div>
      ) : (
        <>
          {untagged.length > 0 && (
            <div className="mt-6 rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
              <p className="font-medium text-amber-900 dark:text-amber-200">
                {untagged.length === 1
                  ? '1 account reaches no statement.'
                  : `${formatNumber(untagged.length)} accounts reach no statement.`}
              </p>
              <p className="mt-1 text-amber-800 dark:text-amber-300">
                They are absent from both sides of every statement, so nothing looks wrong.
                The trial balance still includes them.
              </p>
              <p className="mt-2 font-mono text-xs text-amber-800 dark:text-amber-300">
                {untagged.map((u) => `${u.code} (${u.reason})`).join('   ')}
              </p>
            </div>
          )}

          <ChartSearch ledgerId={ledgerId} accounts={accounts} roles={roleOptions} />
        </>
      )}
    </main>
  )
}

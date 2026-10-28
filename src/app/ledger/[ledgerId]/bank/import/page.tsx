import { PageHeader } from '@/components/PageHeader'

import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAccountAction, importBankAction } from '@/app/actions'
import { importableAccounts } from '@/lib/bank'
import { BankImport } from './BankImport'
import { ledgerHead } from '@/lib/ledger-head'

export const dynamic = 'force-dynamic'

export default async function ImportBank({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const accounts = await importableAccounts(head.entity_id)

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Read a bank file</>} backTo={`/ledger/${ledgerId}/bank`} backLabel={`Back to Banking`} />

      {accounts.some((a) => a.landed !== '0') && (
        <section className="mt-6">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Already read in
          </p>
          <ul className="mt-1 space-y-1 text-sm">
            {accounts.filter((a) => a.landed !== '0').map((a) => (
              <li key={a.id}>
                <Link href={`/ledger/${ledgerId}/bank/${a.id}`} className="underline">
                  {a.code} — {a.name}
                </Link>
                <span className="text-neutral-500"> · {a.landed} rows · bank feed</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <BankImport ledgerId={ledgerId} accounts={accounts} action={importBankAction}
                  newAccount={createAccountAction} />
    </main>
  )
}


import { PageHeading } from '@/components/DialogHeading'
import { notFound } from 'next/navigation'
import { availableRoles, chartOfAccounts } from '@/lib/accounts'
import { ledgerHead } from '@/lib/ledger-head'
import { AccountForm } from '../AccountForm'
import { ours } from '@/lib/ours'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

/**
 * A new account, body only — the full page and the overlay both render exactly
 * this (the one-renderer rule applied to screens).
 *
 * It used to be a panel that unfolded inside the chart, which put a form with
 * a dozen controls in the middle of a list of two hundred rows and pushed
 * everything below it down the page. The owner asked for it to float
 * (2026-09-16); floating is what every other create door here already does.
 */
export async function NewAccountBody({ ledgerId, copyId }: { ledgerId: string; copyId?: string }) {
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const [accounts, roles] = await Promise.all([
    chartOfAccounts(head.entity_id),
    availableRoles(),
  ])
  if (copyId && !(await ours('account', copyId, ledgerId))) notFound()
  const [source] = copyId ? await db.execute<{
    name: string; account_type: string; normal_balance: string
    is_postable: boolean; parent_code: string | null; roles: string[]
  }>(sql`SELECT a.name, a.account_type::text, a.normal_balance::text,
                a.is_postable, p.code AS parent_code,
                COALESCE(array_agg(ar.role) FILTER (WHERE ar.role IS NOT NULL), '{}') AS roles
           FROM account a LEFT JOIN account p ON p.id = a.parent_id
           LEFT JOIN account_role ar ON ar.account_id = a.id
          WHERE a.id = ${copyId}::uuid AND a.entity_id = ${head.entity_id}::uuid
          GROUP BY a.id, p.code`) : []

  return (
    <>
      <PageHeading className="mt-2" title={<>{source ? 'Copy account' : 'New account'}</>} />

      <p className="mt-2 text-xs text-neutral-500">
        Its type and normal balance are fixed once anything has been posted.
      </p>
      <div className="mt-4">
        <AccountForm key={copyId ?? 'new'}
          ledgerId={ledgerId}
          entityId={head.entity_id}
          accounts={accounts}
          initial={source ? {
            name: source.name, accountType: source.account_type,
            normalBalance: source.normal_balance, isPostable: source.is_postable,
            roles: source.roles, parentCode: source.parent_code,
          } : undefined}
          roles={roles.map((r) => ({
            code: r.code, label: r.label, family: r.family,
            category: r.category, isCore: r.isCore,
          }))}
        />
      </div>
    </>
  )
}

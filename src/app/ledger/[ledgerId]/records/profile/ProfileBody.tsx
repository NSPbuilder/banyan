
import { PageHeading } from '@/components/DialogHeading'
import { Fragment } from 'react'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { ledgerHead } from '@/lib/ledger-head'
import { profileOf } from '@/lib/records'
import { readingById } from '@/lib/bill-reading'
import { companyProfileFrom, unplacedFacts } from '@/lib/reading-facts'
import { saveProfileAction } from '@/app/records-actions'
import { ProfileForm } from './ProfileForm'

/**
 * The company profile's form, body only — floated over Basic Info by its Edit
 * button, and a full page on a deep link.
 *
 * A READING SENT HERE (2026-09-16): a certificate of incorporation lands on
 * this form with what was read already in it, for a person to check. Nothing
 * is saved until they press Save. A fact no field takes is listed rather than
 * dropped, so what was read is never lost just because nothing here matched it.
 */
export async function ProfileBody({ ledgerId, readingId }: { ledgerId: string; readingId: string | null }) {
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const [stored, [entity], types, reading] = await Promise.all([
    profileOf(head.entity_id),
    db.execute<{ is_ccpc: boolean | null }>(sql`SELECT is_ccpc FROM entity WHERE id = ${head.entity_id}::uuid`),
    db.execute<{ code: string; name: string }>(sql`SELECT code, name FROM company_type ORDER BY code`),
    readingId ? readingById(ledgerId, readingId) : null,
  ])

  const facts = reading?.proposal?.facts ?? {}
  const read = Object.keys(facts).length > 0 ? companyProfileFrom(facts) : null
  const profile = read
    ? {
        incorporation_number: read.incorporation_number ?? stored?.incorporation_number ?? null,
        business_number: read.business_number ?? stored?.business_number ?? null,
        recognition_date: read.recognition_date ?? stored?.recognition_date ?? null,
        company_type: stored?.company_type ?? null,
      }
    : stored
  const leftOver = read
    ? unplacedFacts(facts, [read.incorporation_number, read.business_number, read.recognition_date])
    : []

  return (
    <>
      <PageHeading className="mt-2" title={<>Company profile</>} />
      <p className="mt-1 text-sm text-neutral-500">{head.entity}</p>

      {reading && (
        <div className="mt-4 rounded border border-clay-300 bg-clay-50 p-4 text-sm dark:border-clay-800 dark:bg-neutral-900"
             data-reading={reading.id}>
          <p className="font-medium">
            Filled in from {reading.filename ?? 'a sentence you wrote'}
            {reading.proposal?.suggestedKind && <> — read as {reading.proposal.suggestedKind}</>}.
          </p>

          {leftOver.length > 0 && (
            <>
              <p className="mt-2 text-xs text-neutral-500">
                Also read, with no field here to take {leftOver.length === 1 ? 'it' : 'them'}:
              </p>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                {leftOver.map(([k, v]) => (
                  <Fragment key={k}>
                    <dt className="text-neutral-500">{k}</dt>
                    <dd className="font-mono">{v}</dd>
                  </Fragment>
                ))}
              </dl>
            </>
          )}
        </div>
      )}

      <ProfileForm
        ledgerId={ledgerId}
        entityId={head.entity_id}
        profile={profile}
        isCcpc={entity?.is_ccpc ?? null}
        companyTypes={types.map((t) => ({ id: t.code, label: t.name }))}
        action={saveProfileAction}
      />
    </>
  )
}

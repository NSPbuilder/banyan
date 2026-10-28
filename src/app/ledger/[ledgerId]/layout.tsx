import { notFound } from 'next/navigation'
import { NavRail } from '@/components/NavRail'
import { requireUser } from '@/lib/gate'
import { accessFor, seatsForEntity } from '@/lib/access'
import { LEDGER_NAV, railMayOpen } from '@/lib/nav'
import { SearchBox } from '@/components/SearchBox'
import { ledgerTitle } from '@/lib/app-name'
import { ledgerHead } from '@/lib/ledger-head'
import { ApplicationFrame } from '@/components/ApplicationFrame'
import { PlanningNotice } from '@/components/PlanningNotice'

/**
 * The shell: every module on the left, always; the module's page as
 * `children`; and the `modal` slot floating a sub-page over it when an
 * intercepting route matches. On a hard load the slot renders its default
 * (null) and the same URL is the full page — a deep link never needs the
 * overlay to exist.
 */
/**
 * The tab says which company. Everything under a ledger inherits it, so a
 * person with three companies open can tell the tabs apart without reading
 * the page — which is the whole job of a title (owner, 2026-09-07).
 */
export async function generateMetadata({ params }: LayoutProps<'/ledger/[ledgerId]'>) {
  const { ledgerId } = await params
  return { title: await ledgerTitle(ledgerId) }
}

export default async function LedgerShell({
  children, modal, params,
}: {
  children: React.ReactNode
  modal: React.ReactNode
  params: Promise<{ ledgerId: string }>
}) {
  // A layout runs for its whole subtree and this one QUERIES — so it is an
  // entrypoint, whatever it is called. Ungated it answered 404-or-307 to an
  // anonymous caller, which is an existence oracle for ledger ids (critic).
  const me = await requireUser()
  const { ledgerId } = await params
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()
  // The seats this person has IN THIS company. A union across their companies
  // would offer CRM in B because they hold it in A, then send them to a door
  // the gate correctly refuses.
  const seats = seatsForEntity(await accessFor(me), head.entity_id, LEDGER_NAV.map((i) => i.path))

  return <ApplicationFrame
    navigation={<NavRail ledgerId={ledgerId} entityName={head.entity} seats={seats} />}
    context={{ name: head.entity, code: head.entity_code, currency: head.currency }}
    search={railMayOpen(seats, ledgerId, '/search')
      ? <SearchBox to={`/ledger/${ledgerId}/search`} placeholder="Search company…" toolbar /> : undefined}
    modal={modal}>
    <PlanningNotice ledgerId={ledgerId}/>{children}
  </ApplicationFrame>
}


import { ApplicationFrame } from '@/components/ApplicationFrame'
import { GlobalNavigation } from '@/components/GlobalNavigation'
import { requireOwner } from '@/lib/gate'
import { CompanyForm } from './CompanyForm'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import {createCompanyAction} from '@/app/actions'
import {coreChartRows,starterChartRows} from '@/lib/setup'
import {localToday} from '@/lib/today'

export default async function NewCompany({ searchParams }: { searchParams: Promise<{ copy?: string }> }) {
  const me = await requireOwner()
  const { copy } = await searchParams
  if (copy && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(copy)) notFound()
  const [initial] = copy ? await db.execute<{
    name: string; province: string | null; fiscal_year_end_month: number; fiscal_year_end_day: number
  }>(sql`SELECT name, province, fiscal_year_end_month, fiscal_year_end_day
         FROM entity WHERE id = ${copy}::uuid`) : []
  if (copy && !initial) notFound()
  return (
    <ApplicationFrame navigation={<GlobalNavigation owner={me.is_owner} />} context={{ name: 'Workspace' }}>
    <main className="w-full max-w-6xl px-8 py-6 font-sans">
      <CompanyForm action={createCompanyAction} today={localToday()} starterAccounts={coreChartRows().map(a=>({code:a.code,name:a.name}))} standardAccounts={starterChartRows('standard').map(a=>({code:a.code,name:a.name}))} initial={initial ? {
        name: initial.name, province: initial.province,
        fiscalYearEndMonth: initial.fiscal_year_end_month,
        fiscalYearEndDay: initial.fiscal_year_end_day,
      } : undefined} />
    </main>
    </ApplicationFrame>
  )
}

import { notFound } from 'next/navigation'
import { ApplicationFrame } from '@/components/ApplicationFrame'
import { GlobalNavigation } from '@/components/GlobalNavigation'
import { requireUser } from '@/lib/gate'
import { allCompanies } from '@/lib/access'
import { companyModulePolicies } from '@/lib/company-modules'
import { CompanyAccessScreen } from './CompanyAccessScreen'
import { companyModulesAction } from './actions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Company access' }

export default async function CompanyAccess() {
  const me = await requireUser()
  if (me.kind !== 'superadmin') notFound()
  const [companies, policies] = await Promise.all([allCompanies(), companyModulePolicies()])
  return <ApplicationFrame navigation={<GlobalNavigation owner />} context={{ name: 'Workspace' }}>
    <main className="w-full max-w-none px-8 py-6 font-sans"><CompanyAccessScreen companies={companies} policies={policies} action={companyModulesAction} /></main>
  </ApplicationFrame>
}

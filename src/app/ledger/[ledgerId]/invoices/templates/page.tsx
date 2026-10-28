import { requireUser } from '@/lib/gate'
import { CompanyTemplatesBody } from './CompanyTemplatesBody'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  return <main className="w-full px-8 py-6 font-sans"><CompanyTemplatesBody ledgerId={ledgerId} /></main>
}

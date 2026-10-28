import { redirect } from 'next/navigation'
import { noUsersYet } from '@/lib/users'
import { FirstRunForm } from './FirstRunForm'

export const dynamic = 'force-dynamic'

/**
 * The first account, and the only way to make one without already having one.
 *
 * Reachable ONLY while there are no users at all — `createFirstOwner` refuses
 * otherwise, so the guard is in the library and not only in this redirect. A
 * page that is the only way in has to be shut by something that does not depend
 * on the page.
 */
export default async function FirstRun() {
  if (!(await noUsersYet())) redirect('/login')

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Set up your account</h1>

      <FirstRunForm />
    </main>
  )
}

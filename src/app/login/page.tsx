import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/gate'
import { noUsersYet } from '@/lib/users'
import { SignInForm } from './SignInForm'
import {PasskeySignIn} from '@/components/PasskeySignIn'
import {passkeysEnabled} from '@/lib/passkeys'

export const dynamic = 'force-dynamic'

/**
 * The sign-in page.
 *
 * One of two pages that does NOT call `requireUser` — it is where somebody
 * goes to become a user. `N14` knows about both by name, so the exemption is
 * written down rather than inferred from the absence of a call.
 */
export default async function Login({
  searchParams,
}: { searchParams: Promise<{ next?: string }> }) {
  if (await currentUser()) redirect('/')
  // Nobody has ever signed up: there is no password to get wrong yet.
  if (await noUsersYet()) redirect('/first-run')
  const { next } = await searchParams

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <SignInForm next={next ?? ''} />
      {passkeysEnabled()&&<PasskeySignIn next={next??''}/>}
    </main>
  )
}

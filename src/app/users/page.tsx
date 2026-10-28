
import { ApplicationFrame } from '@/components/ApplicationFrame'
import { GlobalNavigation } from '@/components/GlobalNavigation'
import { QUIET_COMPACT } from '@/lib/ui'
import { requireOwner } from '@/lib/gate'
import { listUsers, sessionsOf } from '@/lib/users'
import { allCompanies, grantsOf } from '@/lib/access'
import { companyModulePolicies } from '@/lib/company-modules'
import { GRANTABLE_MODULES } from '@/lib/nav'
import {
  createUserAction, deleteUserAction, setGrantsAction, setKindAction, setPasswordAction,
  setIdentityAction, setStatusAction, signOutAction,
} from '@/app/user-actions'
import { UserAdmin } from './UserAdmin'

export const dynamic = 'force-dynamic'

/**
 * Who can get in.
 *
 * Owner only — `requireOwner` redirects anybody else. A bookkeeper who could
 * make themselves an owner would make the distinction decorative.
 */
export default async function Users() {
  const me = await requireOwner()
  const people = await listUsers()
  const mine = await sessionsOf(me.id)
  const policies = await companyModulePolicies()
  const companies = (await allCompanies()).map(c => ({ ...c, enabledModules: policies[c.id] }))
  // What each person has, read one at a time rather than joined: the screen
  // shows a person at a time, and a join would answer a question nobody asks.
  const grants = Object.fromEntries(await Promise.all(
    people.map(async (p) => [p.id, await grantsOf(p.id)] as const)))

  return (
    // Keep the global shell; the shared table viewport contains narrow-screen scrolling.
    <ApplicationFrame navigation={<GlobalNavigation owner={me.is_owner} />} context={{ name: 'Workspace' }}>
    <main className="w-full max-w-none px-8 py-6 font-sans">
      <UserAdmin me={me} people={people} sessions={mine.length}
                 companies={companies} modules={GRANTABLE_MODULES} grants={grants}
                 // Handed in, not imported by the screen: see PeopleActions.
                 actions={{
                   create: createUserAction, status: setStatusAction,
                   password: setPasswordAction, grants: setGrantsAction,
                   kind: setKindAction, remove: deleteUserAction, identity: setIdentityAction,
                 }}
                 signOut={
        // Rendered here, in a server component: a form with no fields binding a
        // server action, which is the exception `V96` already makes for
        // `RebuildButton`. In a client component it would be the wiring that
        // wipes typed fields on refusal.
        <form action={signOutAction} className="mt-3">
          <button type="submit"
                  className={QUIET_COMPACT}>
            Sign out
          </button>
        </form>
      } />
    </main>
    </ApplicationFrame>
  )
}

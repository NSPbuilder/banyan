/**
 * Render the people screen with stand-in actions and read the buttons back —
 * `US33` runs this once as an owner and once as a superadmin.
 *
 * A process of its own, like render-reconcile-panel: react-dom/server does not
 * exist under the react-server condition the suites run in, and the screen
 * takes its six doors as props precisely so this file needs nothing that
 * imports `server-only`.
 *
 *   npx tsx scripts/render-user-admin.tsx '<json>'
 *   { me, people, companies, modules, grants }  →  { headers, rows, grantBoxes, canAdminister }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { UserAdmin, type PeopleActions } from '../src/app/users/UserAdmin'
import { USER_FIELDS as F } from '../src/lib/forms'

type Person = Parameters<typeof UserAdmin>[0]['people'][number]
const input = JSON.parse(process.argv[2]) as {
  me: Person; people: Person[]
  companies: Array<{ id: string; code: string; name: string }>
  modules: Array<{ path: string; label: string }>
  grants: Record<string, { entities: string[]; modules: string[] }>
}

const stub = async () => ({})
const actions: PeopleActions = {
  create: stub, status: stub, password: stub, grants: stub, kind: stub, remove: stub, identity: stub,
}

const fullMarkup = renderToStaticMarkup(
  <UserAdmin me={input.me} people={input.people} sessions={1}
             companies={input.companies} modules={input.modules} grants={input.grants}
             actions={actions} signOut={null} />)

// Native dialogs (including nested exit prompts) are closed on the list.
// Inspect the actions a person can reach from the list, not their hidden
// close/confirmation controls, whose labels do not change role authority.
let markup = '', cursor = 0, depth = 0, start = 0
for (const tag of fullMarkup.matchAll(/<\/?dialog\b[^>]*>/g)) {
  if (!tag[0].startsWith('</')) { if (depth++ === 0) { start = tag.index!; markup += fullMarkup.slice(cursor, start) } }
  else if (--depth === 0) cursor = tag.index! + tag[0].length
}
markup += fullMarkup.slice(cursor)

const headers = [...markup.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])
const rows = [...markup.matchAll(
  /<tr\b[^>]*\bdata-person-id="[^"]*"[^>]*>([\s\S]*?)<\/tr>/g,
)].map((m) => {
  const r = m[1]
  const email = (/<td\b[^>]*\bdata-column="email"[^>]*>([\s\S]*?)<\/td>/.exec(r)?.[1] ?? '').replace(/<[^>]*>/g, '')
  // Read semantic column identity rather than incidental styling.
  const cell = /<td\b[^>]*\bdata-column="type"[^>]*>([\s\S]*?)<\/td>/.exec(r)?.[1] ?? ''
  const options = [...cell.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((o) => o[1])
  const buttons = [...r.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((b) => b[1])
  return { email, type: options.length > 0 ? { options } : cell.replace(/<[^>]*>/g, '').trim(), buttons }
})

console.log(JSON.stringify({
  headers,
  rows,
  grantBoxes: markup.split(`name="${F.grant}"`).length - 1,
  canAdminister: markup.includes('Can administer'),
}))

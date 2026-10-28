/**
 * Render one company row's doors with stand-in actions and read them back —
 * `CO11` runs this for the counts a live company can have.
 *
 * A process of its own, like render-period-actions: react-dom/server does not
 * exist under the react-server condition the suites run in, and the row takes
 * its doors as props so this file needs nothing that imports `server-only`.
 *
 *   npx tsx scripts/render-company-state.tsx '<json>'
 *   { books, aiRecords }  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { CompanyState } from '../src/app/companies/CompanyState'

const input = JSON.parse(process.argv[2]) as { books: string; aiRecords: string }
const stub = async () => ({})

const html = renderToStaticMarkup(
  <CompanyState entityId={'E'.repeat(36)} code="CODE" name="Some Ltd."
                books={input.books} aiRecords={input.aiRecords}
                archivedAt={null} archivedReason={null}
                archiveAction={stub} unarchiveAction={stub} deleteAction={stub} />,
)
console.log(JSON.stringify({ html }))

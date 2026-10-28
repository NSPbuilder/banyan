/**
 * Render the backup screen and read it back — `BK19` runs this.
 *
 * A process of its own, like the other render harnesses: react-dom/server does
 * not exist under the react-server condition, and this screen takes its door as
 * a prop so nothing here imports `server-only`.
 *
 * WHAT IT IS FOR. The extension was renamed from `.figtree` to `.fig` (owner,
 * 2026-09-12), and the half of that rename which can quietly go wrong is the
 * file picker: an `accept` that lists only the new name hides every backup the
 * person already has, and the screen would look entirely correct. The lesson is
 * on record from the bill reader, which claimed to take PDFs while its own
 * `accept` filtered them out.
 *
 *   npx tsx scripts/render-backup-screen.tsx  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { BackupScreen } from '../src/app/ledger/[ledgerId]/backup/BackupScreen'

const stub = async () => ({})
console.log(JSON.stringify({
  html: renderToStaticMarkup(
    <BackupScreen ledgerId={'L'.repeat(36)} code="ACME" name="Acme Ltd."
                  paperCount={2} paperBytes={2048} restoreAction={stub}
                  restoreAvailable />,
  ),
}))

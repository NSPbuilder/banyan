/**
 * Renders the registration page's body and prints, for each `<form>` it
 * contains, every field that form would submit — as JSON:
 *
 *   npx tsx scripts/render-tax-fields.tsx '<view+proposals JSON>'
 *
 * Every form on the page at once, because the defect that survived six rounds
 * of narrower checks was a whole value of the right type substituted at a call
 * site: `row={view.rows[0]}` makes every cease form end the FIRST registration,
 * whichever card it sits under. Nothing is unpacked and the types agree, so no
 * check over the source can see it. What the forms say can.
 *
 * A separate process because the verify suites run under
 * `--conditions=react-server`, where `react-dom/server` refuses to load, and
 * they need that condition because the libraries they test are `server-only`.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RegistrationSections,
} from '../src/app/ledger/[ledgerId]/tax/registration/RegistrationSections'

const input = JSON.parse(process.argv[2])

const markup = renderToStaticMarkup(
  <RegistrationSections
    ledgerId="LEDGER" entityId="ENTITY" today={input.today ?? '2026-01-01'}
    view={input.view} proposals={input.proposals}
    registerAction="/register" ceaseAction="/cease" correctAction="/correct" deleteAction="/delete" />)

/** One entry per form, in the order they appear, with the fields it submits. */
const forms: Array<{ action: string; submit: string; fields: Record<string, string> }> = []

for (const m of markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
  const fields: Record<string, string> = {}
  for (const tag of m[2].matchAll(/<input\b[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(tag[0])
    if (!name) continue
    fields[name[1]] = /value="([^"]*)"/.exec(tag[0])?.[1] ?? ''
  }
  const submit = /<button[^>]*>([\s\S]*?)<\/button>/.exec(m[2])?.[1] ?? ''
  forms.push({
    action: /action="([^"]*)"/.exec(m[1])?.[1] ?? '',
    submit: submit.replace(/<[^>]+>/g, '').trim(),
    fields,
  })
}

process.stdout.write(JSON.stringify(forms))

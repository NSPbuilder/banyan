/**
 * Picking one thing out of a list — the widget every screen now uses to choose
 * a party or an account.
 *   npm run db:verify-picker   (resets the TEST database first)
 *
 * Every party and account select in the tree became one of these on
 * 2026-09-07, because the owner asked for the two things a select cannot do:
 * narrow the list as you type, and create the thing you were looking for when
 * it turns out not to exist. What is checked here is what makes that safe to
 * have done everywhere at once — one component, one matching rule, and the
 * same value posted as before. `PK12` prints how many there are rather than
 * asserting a number, which would be a figure to keep up to date instead of
 * a fact about the tree.
 */
import './env'
import { messageOf as errorText, reporter, sourceFiles } from './suite'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import type { PickerOption } from '../src/components/Picker'
import { matches } from '../src/lib/picker-matching'
import { createAccount } from '../src/lib/accounts'
import { createPartyFromForm } from '../src/lib/party-forms'
import { PARTY_FIELDS } from '../src/lib/forms'

const r = reporter(56)
const { check } = r

/** Every .tsx and .ts under src, for the two checks that read the whole tree. */

/** One `<Picker … />` element, as written. */
function pickersIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/<Picker\b/g)) {
    // To the `/>` that closes it, counting the braces of any prop object in
    // between — a create block holds `/>`-free JSX but plenty of braces.
    let depth = 0
    for (let i = m.index!; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
      else if (depth === 0 && text[i] === '/' && text[i + 1] === '>') {
        out.push(text.slice(m.index!, i + 2)); break
      }
    }
  }
  return out
}

async function main() {
  // ------------------------------------------------------------ the rule --
  //
  // Every word typed has to appear somewhere in the option, in any order. A
  // plain substring test would answer no to "office coastal" for "Coastal
  // Office Supply", which is exactly how somebody types when they half
  // remember a name.
  const supplier: PickerOption = { id: 's', label: 'Coastal  Office Supply Co.', hint: 'supplier' }
  const account: PickerOption = { id: 'a', label: '5200 — Office and Supplies', hint: 'expense' }

  check(matches(supplier, 'office coastal') && matches(supplier, 'coastal office'),
    'PK1 every word typed must appear, in any order',
    'both orders find Coastal Office Supply Co.')

  check(matches(supplier, 'supplier') && !matches(account, 'supplier'),
    'PK2 the hint beside the name is searched too, so a role narrows the list',
    'the supplier answers to "supplier"; the expense account does not')

  check(matches(account, '') && matches(account, '   ')
        && !matches(account, 'office rent'),
    'PK3 nothing typed matches everything, and a word nobody has matches nothing',
    'blank matches; "office rent" does not match 5200 Office and Supplies')

  check(matches(supplier, 'COASTAL   office') && matches(account, '52 office'),
    'PK4 case and runs of spaces are folded, and a code is just another word',
    '"COASTAL   office" and "52 office" both match')

  // --------------------------------------------------------- the markup --
  const render = (cases: unknown) => JSON.parse(execFileSync('npx',
    ['tsx', 'scripts/render-picker.tsx', JSON.stringify({ cases })],
    { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } })).html as Record<string, string>

  const options = [
    { id: 'a1', label: '5300 — Office' },
    { id: 'a2', label: '4000 — Revenue' },
  ]
  const html = render([
    { as: 'named', name: 'accountId', options, required: true },
    { as: 'nameless', options },
    { as: 'chosen', name: 'accountId', options, defaultValue: 'a2' },
    { as: 'creating', name: 'accountId', options, create: {
      title: 'New account', hidden: { ledgerId: 'L' },
      fields: [{ name: 'code', label: 'Code' }, { name: 'name', label: 'Name', takesTyped: true }],
    } },
  ])

  // THE POINT OF THE WHOLE EXERCISE: what reaches the server is what a
  // `<select>` sent. Every reader on the server was left alone, which is what
  // made it possible to change twenty screens in one go.
  const hidden = /<input type="hidden" name="accountId" value="([^"]*)"/
  check(hidden.test(html.named) && hidden.exec(html.chosen)?.[1] === 'a2',
    'PK5 it posts a hidden field under the name the select had, carrying the id',
    `chosen posts "${hidden.exec(html.chosen)?.[1]}"`)

  // The journal entry serialises its own lines into one JSON field, so a
  // picker there must post NOTHING beside it.
  check(!/<input type="hidden"/.test(html.nameless),
    'PK6 given no name it posts nothing, for a form that serialises its own rows',
    'no hidden input in the nameless render')

  // A select puts every choice in the markup and a great deal of this
  // project's evidence reads exactly that. The list is rendered and hidden
  // rather than built on a click, so those checks still see what is offered.
  const shown = [...html.named.matchAll(/data-option="([^"]*)"/g)].map((m) => m[1])
  // ASKED OF A CHOSEN ONE TOO. Choosing puts the option's label in the box,
  // and filtering on the box would leave a chosen picker rendering exactly
  // one option — so this guarantee held only for empty ones, which is not
  // what any of it claims (critic, 2026-09-07). The widget filters on what
  // was TYPED, which is empty until somebody types.
  const alsoChosen = [...html.chosen.matchAll(/data-option="([^"]*)"/g)].map((m) => m[1])
  check(shown.join(',') === 'a1,a2' && alsoChosen.join(',') === 'a1,a2'
        && /role="listbox"[^>]*hidden=""/.test(html.named),
    'PK7 every choice is in the markup although the list is closed, chosen or not',
    `${shown.length} options empty, ${alsoChosen.length} with one chosen, listbox hidden`)

  // A person reads names, not ids. The box opens showing the label of what is
  // chosen — an id there would be the form telling somebody a UUID.
  check(html.chosen.includes('value="4000 — Revenue"'),
    'PK8 it opens showing the NAME of what is chosen, and posts the id',
    'the box says 4000 — Revenue')

  // The forms here call reportValidity() before they dispatch, so a required
  // picker must be able to fail that the way a required select did — which
  // means the requirement sits on the box a person can be scrolled to.
  const visible = /<input id="[^"]*-input"[^>]*>/.exec(html.named)?.[0] ?? ''
  check(/required=""/.test(visible) && !/required/.test(hidden.exec(html.named)?.[0] ?? ''),
    'PK9 required sits on the box a person types in, not on the hidden one',
    'the combobox carries required')

  check(/data-create/.test(html.creating) && html.creating.includes('New account')
        && !/data-create/.test(html.named),
    'PK10 the creating row is offered only where a door was given',
    'offered on the creating render, absent from the plain one')

  // ---------------------------------------------------------- the tree --
  //
  // A screen that goes back to a bare <select> over accounts or parties is
  // the owner's complaint returning: a whole chart in the order it happens to
  // be in, and no way to type. Short fixed lists — a tax code, a role, a
  // share class — are not that and are deliberately not caught.
  //
  // WHAT THIS CANNOT SEE, said plainly: it recognises the list by the NAME of
  // the thing being mapped over. A regression written over `chart`, `payees`
  // or a local destructured to something else passes it (critic, 2026-09-07).
  // There is no structural difference between mapping a chart of accounts and
  // mapping the four share classes, so a rule that did not read names could
  // only catch both or neither. The names below are every spelling the tree
  // actually uses plus the obvious near-misses; a new one is a new entry here.
  const files = sourceFiles('src')
  // Read off the LIST BEING MAPPED, not off the whole block: a role select on
  // the parties screen sits three lines from the word "party" and is not a
  // party list. `<option>` elements come from `<something>.map(`, and it is
  // that something this asks about.
  const LONG = /^\w*(accounts?|parties|payees?|suppliers?|customers?|banks?|employees|people|chart|holders?|invoices)$/i
  const bareSelects: string[] = []
  for (const f of files) {
    if (f.endsWith('src/components/Picker.tsx')) continue
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/<select\b[\s\S]*?<\/select>/g)) {
      const mapped = [...m[0].matchAll(/([A-Za-z_$][\w$]*)\s*\.(?:map|filter)\(/g)].map((x) => x[1])
      if (mapped.some((name) => LONG.test(name))) {
        bareSelects.push(`${f}:${text.slice(0, m.index!).split('\n').length}`)
      }
    }
  }
  check(bareSelects.length === 0,
    'PK11 no party or account list is a bare select anywhere in the tree',
    bareSelects.length === 0 ? `${files.length} files, none` : bareSelects.join(', '))

  // A picker that neither posts a name nor reports to a parent is a choice
  // that goes nowhere: it looks like it works and the form never learns of it.
  const deaf: string[] = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (f.endsWith('src/components/Picker.tsx')) continue
    for (const el of pickersIn(text)) {
      if (!/\bname=/.test(el) && !/\bonChange=/.test(el)) {
        deaf.push(`${f}: ${el.slice(0, 60).replace(/\s+/g, ' ')}`)
      }
    }
  }
  const pickerCount = files.reduce((n, f) =>
    n + (f.endsWith('src/components/Picker.tsx') ? 0 : pickersIn(readFileSync(f, 'utf8')).length), 0)
  check(deaf.length === 0 && pickerCount >= 15,
    'PK12 every picker in the tree either posts a name or reports to its parent',
    deaf.length === 0 ? `${pickerCount} pickers, all wired` : deaf.join('; '))

  // ---------------------------------------------------------- the doors --
  const co = await createCompanyWithYear({ code: 'PIC', name: 'Pick One Ltd.' }, 'alicio@example.test')

  // A creating row that forgets to say what type of account it is making must
  // get a sentence back — it is shown inside the row, to the person typing.
  let typeless = ''
  try {
    await createAccount({
      entityId: co.company.id, code: '5999', name: 'No type given',
      accountType: '' as 'expense', isPostable: true, roles: [],
    }, 'alicio@example.test')
  } catch (e) { typeless = errorText(e) }
  check(typeless === '"" is not an account type. Use asset, liability, equity, revenue or expense.',
    'PK13 a creating row that names no account type is refused in a sentence',
    typeless || 'it was accepted')

  // A party created from a form has no registration-date prerequisite.
  const noStart = new FormData()
  noStart.set(PARTY_FIELDS.ledgerId, co.ledger.id)
  noStart.set(PARTY_FIELDS.entityId, co.company.id)
  noStart.set(PARTY_FIELDS.name, 'Undated Supplies Ltd.')
  noStart.set(PARTY_FIELDS.role, 'supplier')
  const undated = await createPartyFromForm(noStart, 'alicio@example.test')
  check(undated.ok === 'Added.' && !!undated.madeId && undated.madeLabel === 'Undated Supplies Ltd.',
    'PK14 a party created without a start date comes back ready to select',
    undated.ok ?? undated.error ?? '')

  // And the ordinary road works: the row posts what it says it posts, and the
  // picker is handed back the id and the label it needs to choose it.
  const made = new FormData()
  made.set(PARTY_FIELDS.ledgerId, co.ledger.id)
  made.set(PARTY_FIELDS.entityId, co.company.id)
  made.set(PARTY_FIELDS.name, 'Coastal Office Supply Co.')
  made.set(PARTY_FIELDS.role, 'supplier')
  made.set(PARTY_FIELDS.kind, 'organisation')
  made.set(PARTY_FIELDS.heldFrom, co.year.startDate)
  const created = await createPartyFromForm(made, 'alicio@example.test')
  check(!!created.madeId && created.madeLabel === 'Coastal Office Supply Co.',
    'PK15 what the row made comes back with a name, so the picker can choose it',
    `${created.madeId ? 'id' : 'no id'}, label "${created.madeLabel ?? ''}"`)

  // PK16 — the active option is NAMED for assistive tech: every option
  //        carries an id the input can point at, and the input wires
  //        aria-activedescendant to the active one. The render is closed
  //        (static markup), so the ids are read from the rendered options and
  //        the wiring from the component's source — stated as such.
  {
    const html = render([{ as: 'ids', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }]).ids
    const optionIds = [...html.matchAll(/role="option"[^>]*\bid="([^"]+)"/g)].map((m) => m[1])
    const withOpt = optionIds.filter((x) => /-opt-\d+$/.test(x))
    const source = readFileSync('src/components/Picker.tsx', 'utf8')
    check(optionIds.length === 2 && withOpt.length === 2
      && source.includes('aria-activedescendant={open && shown[active] ? `${listId}-opt-${active}` : undefined}'),
      'PK16 every option is named and the input points at the active one',
      `option ids ${optionIds.join(', ') || 'none'}; the input wires aria-activedescendant ${source.includes('aria-activedescendant')}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

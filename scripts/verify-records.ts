/**
 * Corporate records: registers that are as-of, shares that balance, a renderer
 * with one path and two exits.
 *   npm run db:verify-records   (resets the database first)
 *
 * The claims this suite exists to make earned. The PRD's P4 acceptance block
 * has FOUR bullets, and they map here as: the ceased director (CR03), the
 * database refusing an unbalanced movement (CR07), one render behind both
 * exits (CR16), and the header carrying as-of/audience/timestamp with the
 * transparency register's not-for-public sentence (CR12/CR14). The rest:
 *
 *   the securities register appends and never edits
 *   the transparency register withholds its fields from a public audience
 *   the audit log carries none of the fields the register calls private
 */
import './env'
import { trailNamesPeople } from './actor-trail'
import { actingAs } from '../src/lib/acting'
import { errorText as chainText, expectSaying, reporter } from './suite'
import { sql as raw } from 'drizzle-orm'
import { registerPdf } from '../src/modules/records/reports'
import { pdfText } from './pdf-text'
import { db, sql as conn } from '../src/db/client'
import { createCompany } from '../src/lib/setup'
import { createParty, setAddress } from '../src/lib/parties'
import {
  addMinuteBookEntry, appointDirector, ceaseDirector, ceaseSignificantIndividual,
  createShareClass, directorsAsAt, holdingsAsAt, issueShares, minuteBookOf,
  cancelShares, profileOf, recordSignificantIndividual, saveProfile, securitiesRegister,
  shareMovements, allOffices, movementRows, shareClassRows,
  setOffice, shareTotalsAsAt, significantIndividualsAsAt, transferShares,
} from '../src/lib/records'
import { logRegisterExport, renderRegister } from '../src/lib/registers'
import { inWords, shareCertificate } from '../src/lib/certificate'
import {
  RECORD_FIELDS, ceaseDirectorFromForm, correctRowFromForm, enterRowsFromForm, minuteKinds, removeClassFromForm,
  removeRowFromForm, renameClassFromForm, saveProfileFromForm,
} from '../src/lib/record-forms'
import { rowField, PARTY_FIELDS as PF } from '../src/lib/forms'
import { shareholderAddresses, setShareholderAddressFromForm } from '../src/lib/shareholder-address'
import { recordsScreenData } from '../src/app/ledger/[ledgerId]/records/screen-data'
import { choiceOf, formRowsFrom, rowsFrom, rowsMenu, RECORD_COLUMNS, RECORD_TABLES } from '../src/lib/record-rows'
import { discardReading, readBill, readingById } from '../src/lib/bill-reading'
import { execFileSync } from 'node:child_process'
import { serviceFrom, type Send } from '../src/lib/assistant'

const r = reporter(62)
const { fail, check } = r

const errorText = (e: unknown) => chainText(e, ' <- ')

const expectError = expectSaying(r, errorText, 86)

async function main() {
  const co = await createCompany({ code: 'REC', name: 'Records Ltd.' }, 'alicio@example.test')
  const E = co.company.id

  const director = await createParty({
    kind: 'person', name: 'Dana Chen',
    roles: [{ entityId: E, role: 'director', heldFrom: '2020-01-01' }],
    actor: 'alicio@example.test',
  })
  await setAddress({
    partyId: director.id, purpose: 'delivery',
    line1: '4102 Main St', city: 'Vancouver', region: 'BC', postalCode: 'V5V 3P6',
  })
  const founder = await createParty({
    kind: 'person', name: 'Alicio Xu',
    roles: [{ entityId: E, role: 'shareholder', heldFrom: '2020-01-01' }],
    actor: 'alicio@example.test',
  })
  const investor = await createParty({
    kind: 'organisation', name: 'Harbour Capital Ltd.',
    roles: [{ entityId: E, role: 'shareholder', heldFrom: '2023-01-01' }],
    actor: 'alicio@example.test',
  })

  // ---------------------------------------------------------------- profile --
  {
    await saveProfile({ entityId: E, incorporationNumber: 'BC1234567',
      recognitionDate: '2020-01-15', companyType: 'limited', actor: 'alicio@example.test' })
    await saveProfile({ entityId: E, incorporationNumber: 'BC1234567',
      businessNumber: '123456789', recognitionDate: '2020-01-15', actor: 'alicio@example.test' })
    const p = await profileOf(E)
    check(p?.incorporation_number === 'BC1234567' && p?.business_number === '123456789'
          && p?.recognition_date === '2020-01-15',
      'CR01 the profile saves once and updates in place',
      `${p?.incorporation_number} / ${p?.recognition_date}`)
  }

  // ---------------------------------------------------------------- offices --
  {
    await setOffice({ entityId: E, office: 'registered',
      deliveryAddress: '4102 Main St', deliveryCity: 'Vancouver',
      effectiveFrom: '2020-01-15', actor: 'alicio@example.test' })

    await expectError('CR02 an office outside BC is refused by the database',
      'delivery_province', () => db.execute(raw`
        INSERT INTO corporate_office (entity_id, office, delivery_address, delivery_city,
                                      delivery_province, effective_from, created_by)
        VALUES (${E}::uuid, 'records', '1 Bay St', 'Toronto', 'ON', '2020-01-15', 'alicio@example.test')`))
  }

  // -------------------------------------------------------------- directors --
  let danaTerm = ''
  {
    danaTerm = await appointDirector({
      entityId: E, partyId: director.id, appointedOn: '2020-01-15', actor: 'alicio@example.test',
    })
    await actingAs('alicio@example.test', (tx) => ceaseDirector({ directorshipId: danaTerm, ceasedOn: '2024-06-30', actor: 'alicio@example.test' }, tx))

    // THE acceptance test: within the term they are there, after it they are not.
    const during = await directorsAsAt(E, '2024-03-31')
    const after = await directorsAsAt(E, '2024-07-01')
    check(during.some((d) => d.name === 'Dana Chen') && !after.some((d) => d.name === 'Dana Chen'),
      'CR03 a ceased director appears within their term and not after it',
      `during: ${during.length}, after: ${after.length}`)

    // The prescribed address froze at appointment; changing the PARTY's
    // address later must not rewrite the register.
    await setAddress({ partyId: director.id, purpose: 'delivery',
      line1: '900 Somewhere Else', city: 'Kelowna', region: 'BC' })
    const stillDuring = await directorsAsAt(E, '2024-03-31')
    check(stillDuring[0]?.prescribed_delivery.includes('4102 Main St'),
      'CR04 the prescribed address froze when the party later moved',
      stillDuring[0]?.prescribed_delivery)

    await expectError('CR05 two overlapping terms for one person are refused',
      'directorship_no_overlap', () => appointDirector({
        entityId: E, partyId: director.id, appointedOn: '2022-01-01', actor: 'alicio@example.test',
      }))
    // Its pair: a second term AFTER the first is an ordinary re-appointment.
    const second = await appointDirector({
      entityId: E, partyId: director.id, appointedOn: '2025-01-01', actor: 'alicio@example.test',
    })
    check(!!second, 'CR05b while a later second term is an ordinary re-appointment')
  }

  // ----------------------------------------------------------------- shares --
  let classA = ''
  {
    classA = await createShareClass({ entityId: E, name: 'Class A', actor: 'alicio@example.test' })
    await issueShares({ shareClassId: classA, partyId: founder.id, onDate: '2020-01-15',
      quantity: 100n, details: 'Incorporation — founder shares at $1.00', actor: 'alicio@example.test' })
    await transferShares({ shareClassId: classA, fromPartyId: founder.id,
      toPartyId: investor.id, onDate: '2023-06-01', quantity: 25n,
      details: 'Share purchase agreement dated 2023-05-15', actor: 'alicio@example.test' })

    const holdings = await holdingsAsAt(E, '2026-01-01')
    const totals = await shareTotalsAsAt(E, '2026-01-01')
    const held = holdings.reduce((s, h) => s + BigInt(h.holding), 0n)
    check(holdings.length === 2 && held === 100n && BigInt(totals[0].issued) === 100n,
      'CR06 holdings derive per holder and add up to what was issued',
      holdings.map((h) => `${h.holder}:${h.holding}`).join(' '))

    // Before the transfer date, the founder still holds all of it.
    const before = await holdingsAsAt(E, '2023-05-31')
    check(before.length === 1 && BigInt(before[0].holding) === 100n,
      'CR06b and the register as at an earlier date is the earlier register',
      before.map((h) => `${h.holder}:${h.holding}`).join(' '))

    // THE acceptance test: the database refuses a movement that mints shares.
    await expectError('CR07 a one-sided transfer is refused by the database',
      'TRANSFER_UNBALANCED', () => db.execute(raw`
        INSERT INTO share_transaction (share_class_id, party_id, on_date, delta, kind,
                                       transfer_group, details, created_by)
        VALUES (${classA}::uuid, ${investor.id}::uuid, '2024-01-01', 10,
                'transfer_in', gen_random_uuid(), 'materialised from nowhere', 'alicio@example.test')`))

    await expectError('CR08 transferring more than a holder has is refused',
      'SHARES_OVERDRAWN', () => transferShares({
        shareClassId: classA, fromPartyId: investor.id, toPartyId: founder.id,
        onDate: '2024-01-01', quantity: 26n, details: 'more than they hold', actor: 'alicio@example.test',
      }))

    // Backdating cannot break the past either: selling shares in 2022 that
    // were not held until 2023 leaves 2022 negative, and 2022 is checked.
    await expectError('CR08b and a backdated transfer cannot make the past negative',
      'SHARES_OVERDRAWN', () => transferShares({
        shareClassId: classA, fromPartyId: investor.id, toPartyId: founder.id,
        onDate: '2022-01-01', quantity: 10n, details: 'sold before they held it', actor: 'alicio@example.test',
      }))

    await expectError('CR09 the securities register does not edit',
      'SHARES_APPEND_ONLY', () => db.execute(raw`
        UPDATE share_transaction SET delta = 1000 WHERE share_class_id = ${classA}::uuid`))
    await expectError('CR09b and does not delete',
      'SHARES_APPEND_ONLY', () => db.execute(raw`
        DELETE FROM share_transaction WHERE share_class_id = ${classA}::uuid`))
  }

  // --------------------------------------------- significant individuals --
  {
    const si = await recordSignificantIndividual({
      entityId: E, partyId: founder.id, becameOn: '2020-01-15',
      howControl: 'Registered owner of 75% of the issued shares',
      birthDate: '1988-03-09', lastKnownAddress: '4102 Main St, Vancouver BC',
      actor: 'alicio@example.test',
    })
    await recordSignificantIndividual({
      entityId: E, partyId: director.id, becameOn: '2020-01-15',
      howControl: 'Indirect control through family trust', actor: 'alicio@example.test',
    })
    await actingAs('alicio@example.test', (tx) => ceaseSignificantIndividual({ id: si, ceasedOn: '2026-02-01', actor: 'alicio@example.test' }, tx))

    const during = await significantIndividualsAsAt(E, '2025-12-31')
    const after = await significantIndividualsAsAt(E, '2026-03-01')
    check(during.length === 2 && after.length === 1,
      'CR10 a ceased significant individual drops from later as-of dates',
      `during: ${during.length}, after: ${after.length}`)

    await expectError('CR11 neither-citizen-nor-PR without citizenships is refused',
      'citizen_or_pr', () => db.execute(raw`
        INSERT INTO significant_individual (entity_id, party_id, citizen_or_pr,
          how_control, became_on, created_by)
        VALUES (${E}::uuid, ${investor.id}::uuid, false, 'control', '2024-01-01', 'alicio@example.test')`))
  }

  // ---------------------------------------------------------- the renderer --
  {
    const reg = await renderRegister('directors', E, '2024-03-31', 'director')
    check(reg.asOf === '2024-03-31' && reg.audience === 'director'
          && reg.generatedAt.length > 0 && reg.entityName === 'Records Ltd.'
          && reg.headerNotes.some((n) => n.includes('As at 2024-03-31')),
      'CR12 a rendered register carries as-of, audience and a timestamp',
      reg.headerNotes[0])

    // The ceased column respects the as-of boundary: a cessation AFTER the
    // as-of date has not happened yet as far as this page is concerned.
    const rowDana = reg.rows.find((r) => r[0] === 'Dana Chen')
    check(rowDana !== undefined && rowDana[3] === '—',
      'CR13 a cessation after the as-of date is not yet on the page',
      rowDana?.join(' | '))
    const regLater = await renderRegister('directors', E, '2024-12-31', 'director')
    const rowLater = regLater.rows.find((r) => r[0] === 'Dana Chen')
    check(rowLater !== undefined && rowLater[3] === '2024-06-30',
      'CR13b while a cessation before it is', rowLater?.join(' | '))

    // The cessation DAY itself: <= includes it, and the off-by-one that
    // writes < instead is invisible everywhere but here.
    const onDay = await renderRegister('directors', E, '2024-06-30', 'director')
    const rowOnDay = onDay.rows.find((r) => r[0] === 'Dana Chen')
    check(rowOnDay !== undefined && rowOnDay[3] === '2024-06-30',
      'CR13c and the cessation day itself already shows the date', rowOnDay?.join(' | '))

    const trans = await renderRegister('transparency', E, '2025-12-31', 'director')
    check(trans.headerNotes.some((n) => n.includes('NOT available for public inspection')),
      'CR14 the transparency register says on its face who may see it',
      trans.headerNotes[2])
    check(trans.columns.includes('Born')
          && trans.rows.some((r) => r.includes('1988-03-09')),
      'CR14b and a director-audience render shows the sensitive fields',
      trans.columns.join(', '))

    const pub = await renderRegister('transparency', E, '2025-12-31', 'public')
    check(!pub.columns.includes('Born') && pub.withheld.includes('birth_date')
          && !JSON.stringify(pub.rows).includes('1988-03-09'),
      'CR15 a public render withholds the private fields and says so',
      `withheld: ${pub.withheld.join(', ')}`)
  }

  // -------------------------------------- one renderer, two exits, by source --
  {
    // The preview page and the print page must both draw from renderRegister
    // and neither may run a query of its own — two paths would be two answers.
    const { readFileSync } = await import('node:fs')
    const preview = readFileSync(
      'src/app/ledger/[ledgerId]/records/register/[kind]/page.tsx', 'utf8')
    const view = readFileSync(
      'src/app/ledger/[ledgerId]/records/register/[kind]/RegisterView.tsx', 'utf8')
    const problems: string[] = []
    if (!preview.includes('renderRegisterForLedger(')) problems.push('preview does not draw from the one renderer')
    if (/\bsql`|db\.execute|SELECT /.test(preview)) problems.push('preview queries on its own')
    if (/\bsql`|db\.execute|SELECT /.test(view)) problems.push('view queries on its own')
    // The print exit is the shared DocHeader since 2026-09-13; when the view
    // renders it, the exit is read where it lives rather than taken on trust.
    const header = view.includes('<DocHeader') ? readFileSync('src/components/DocHeader.tsx', 'utf8') : ''
    if (!view.includes('@media print') && !view.includes('print:') && !header.includes('@media print')) {
      problems.push('the view has no print exit')
    }
    check(problems.length === 0,
      'CR16 one renderer feeds both exits, and neither queries alone',
      problems.join('; ') || 'one path')
  }

  // -------------------------------------------------------- the PDF exit --
  // The owner replaced print-the-page with generated files (2026-09-02); the
  // registers are reports like any other. `registerPdf` eats from the SAME
  // `renderRegisterForLedger`; these read the file back independently.
  {
    const reg = await renderRegister('directors', E, '2024-03-31', 'director')
    const built = await registerPdf(co.ledger.id, 'directors', '2024-03-31', 'director')
    const pdf = built ? pdfText(built.buffer) : ''
    // A long cell wraps on paper, and each printed line is its own TJ array —
    // flatten whitespace on both sides so a wrapped address still counts as
    // present (the wrap eats the space it broke at).
    const flat = (t: string) => t.replace(/\s+/g, ' ')
    const missing = reg.rows.flat().filter((cell) => cell && !flat(pdf).includes(flat(cell)))
    check(built !== null && pdf.includes(reg.title) && missing.length === 0,
      'CR21 the register PDF carries the renderer, cell for cell',
      missing.length === 0 ? `${reg.rows.length} rows on paper` : `missing: ${missing.join(', ').slice(0, 60)}`)

    // The public copy withholds the same fields on paper as on screen, and
    // says so — a quiet omission is how a register leaks by looking complete.
    const pub = await renderRegister('transparency', E, '2025-12-31', 'public')
    const pubBuilt = await registerPdf(co.ledger.id, 'transparency', '2025-12-31', 'public')
    const pubPdf = pubBuilt ? pdfText(pubBuilt.buffer) : ''
    check(pubBuilt !== null && pub.withheld.length > 0
          && pub.withheld.every((f) => pubPdf.includes(f))
          && pubPdf.includes('Withheld from this audience'),
      'CR21b and the public copy names what it withheld',
      pub.withheld.join(', ') || 'nothing withheld — the check proves nothing')
  }

  // ------------------------------------------------------------ export trail --
  {
    await logRegisterExport({ entityId: E, kind: 'transparency', asOf: '2025-12-31',
      audience: 'director', actor: 'alicio@example.test' })
    const [row] = await db.execute<{ context: { kind: string; asOf: string } }>(raw`
      SELECT context FROM audit_log
       WHERE action = 'export_register' AND record_id = ${E}
       ORDER BY occurred_at DESC LIMIT 1`)
    check(row?.context?.kind === 'transparency' && row?.context?.asOf === '2025-12-31',
      'CR17 an export leaves a trail of who asked for what, as at when',
      JSON.stringify(row?.context))
  }

  // ---------------------------------------- the audit log keeps no secrets --
  {
    // 0035 stripped three fields by name while the visibility table marked
    // eight private — two hand-kept spellings of one question, and audit rows
    // carried `how_control` and the residency flags into a log nothing
    // filters. 0036 derives the exclusion FROM the table; this check is the
    // comparison that was missing: whatever the visibility table calls
    // private must be absent from the payload, whatever the list grows to.
    const [audit] = await db.execute<{ after: Record<string, unknown> }>(raw`
      SELECT after FROM audit_log
       WHERE table_name = 'significant_individual'
       ORDER BY occurred_at DESC LIMIT 1`)
    const priv = await db.execute<{ field: string }>(raw`
      SELECT DISTINCT field FROM register_field_visibility WHERE visibility = 'private'`)
    const leaked = priv.map((p) => p.field).filter((f) => audit?.after
      && Object.prototype.hasOwnProperty.call(audit.after, f))
    check(audit !== undefined && leaked.length === 0,
      'CR20 the audit log carries none of the fields the register calls private',
      leaked.join(', ') || `payload keys: ${Object.keys(audit?.after ?? {}).length}`)
  }

  // ------------------------------------------------------------ minute book --
  {
    await addMinuteBookEntry({ entityId: E, recordKind: 'directors_resolution',
      onDate: '2024-02-01', title: 'Dividend declared', keptAt: 'Minute book vol. 1',
      actor: 'alicio@example.test' })
    await expectError('CR18 a record kind the Act does not know is refused',
      'record_kind', () => addMinuteBookEntry({
        entityId: E, recordKind: 'grocery_list', onDate: '2024-02-01',
        title: 'not a corporate record', keptAt: 'the fridge', actor: 'alicio@example.test',
      }))
    const entries = await minuteBookOf(E)
    check(entries.length === 1 && entries[0].record_kind === 'directors_resolution',
      'CR19 and the minute book lists what it holds', entries[0]?.title)
  }

  // ----------------------- cessation, per BC's own register template --------
  {
    // CR22 — a holder whose balance reaches zero by TRANSFER stays on the
    //        register with a date ceased (owner, 2026-09-03); the acquirer's
    //        "became" is their first acquisition. Former holders are the
    //        point of a register — leaving is a date, not an erasure.
    await transferShares({ shareClassId: classA, fromPartyId: investor.id,
      toPartyId: founder.id, onDate: '2026-02-01', quantity: 25n,
      details: 'Buy-back of the minority stake', actor: 'alicio@example.test' })
    const reg22 = await securitiesRegister(E, '2026-03-01')
    const inv = reg22.find((r) => r.holder === 'Harbour Capital Ltd.')
    const fdr = reg22.find((r) => r.holder === 'Alicio Xu')
    const csr = await renderRegister('central_securities', E, '2026-03-01', 'director')
    const invRow = csr.rows.find((r) => r.includes('Harbour Capital Ltd.'))
    check(!!inv && BigInt(inv.holding) === 0n && inv.ceased_on === '2026-02-01'
          && inv.became_on === '2023-06-01'
          && !!fdr && BigInt(fdr.holding) === 100n && fdr.ceased_on === null
          && !!invRow && invRow.includes('2026-02-01')
          && csr.columns.includes('Ceased') && csr.columns.includes('Became holder'),
      'CR22 a transferred-out holder keeps a seat and gains a date ceased',
      inv ? `became ${inv.became_on}, ceased ${inv.ceased_on}; register row carries it` : 'no row')

    // And BEFORE the buy-back the same reader shows no cessation — the
    // as-at question still means what it says.
    const reg22b = await securitiesRegister(E, '2026-01-01')
    const invBefore = reg22b.find((r) => r.holder === 'Harbour Capital Ltd.')
    check(!!invBefore && BigInt(invBefore.holding) === 25n && invBefore.ceased_on === null,
      'CR22b as at an earlier date they still hold, unceased',
      invBefore ? `${invBefore.holding} held, ceased ${invBefore.ceased_on}` : 'no row')

    // CR23 — the OTHER road to zero: cancellation. The company takes the
    //        founder's shares in; the register shows them ceased and the
    //        class total drops to nothing.
    await cancelShares({ shareClassId: classA, partyId: founder.id,
      onDate: '2026-03-15', quantity: 100n, details: 'Redemption on wind-down', actor: 'alicio@example.test' })
    const reg23 = await securitiesRegister(E, '2026-04-01')
    const fdr23 = reg23.find((r) => r.holder === 'Alicio Xu')
    const totals23 = await shareTotalsAsAt(E, '2026-04-01')
    check(!!fdr23 && BigInt(fdr23.holding) === 0n && fdr23.ceased_on === '2026-03-15'
          && BigInt(totals23[0].issued) === 0n,
      'CR23 a cancellation zeroes the holder and the class total together',
      fdr23 ? `ceased ${fdr23.ceased_on}, total issued ${totals23[0].issued}` : 'no row')

    // CR24 — the transparency register keeps FORMER significant individuals
    //        with their dates (the as-at reader for daily screens still
    //        drops them — two questions, deliberately two readers).
    const tr = await renderRegister('transparency', E, '2026-06-01', 'director')
    const ceasedRows = tr.rows.filter((r) => r.some((c) => c === '2026-02-01'))
    const asAtNow = await significantIndividualsAsAt(E, '2026-06-01')
    check(tr.columns.includes('Ceased') && ceasedRows.length >= 1
          && !asAtNow.some((x) => x.name === ceasedRows[0]?.[0]),
      'CR24 the transparency register keeps former SIs, dated',
      `${ceasedRows.length} ceased row(s) on the register; the as-at list drops them`)
  }

  // CR25 — the new date columns obey the OLD discretion (0048): a public
  //        render of the CSR or the transparency register carries none of
  //        them, and names them as withheld. An unlisted field defaults to
  //        visible, which is exactly how they leaked before the seed.
  {
    const pubCsr = await renderRegister('central_securities', E, '2026-06-01', 'public')
    const pubTr = await renderRegister('transparency', E, '2026-06-01', 'public')
    check(!pubCsr.columns.includes('Became holder') && !pubCsr.columns.includes('Ceased')
          && pubCsr.withheld.includes('became_on') && pubCsr.withheld.includes('ceased_on')
          && !pubTr.columns.includes('Ceased') && pubTr.withheld.includes('ceased_on'),
      'CR25 a public render withholds the new date columns too',
      `CSR shows [${pubCsr.columns.join(', ')}]; withheld ${pubCsr.withheld.length}/${pubTr.withheld.length} fields`)
  }

  // CR26 — securitiesRegister and holdingsAsAt are one aggregation spelled
  //        twice (a GROUP BY with and without former holders). Tie them: the
  //        register's nonzero rows must be exactly the holdings.
  {
    const asOf = '2026-01-01'
    const reg = (await securitiesRegister(E, asOf)).filter((r) => BigInt(r.holding) !== 0n)
      .map((r) => `${r.class_name}|${r.holder}|${r.holding}`).sort()
    const held = (await holdingsAsAt(E, asOf))
      .map((h) => `${h.class_name}|${h.holder}|${h.holding}`).sort()
    check(reg.length > 0 && reg.join(';') === held.join(';'),
      'CR26 the register\'s live rows are the holdings, exactly',
      `${reg.length} holders agree on both readers`)
  }

  // ------------------- the particulars s.111(1) asks for, and the as-at truth --
  {
    // A holder needs an address for the register to print one; s.111(1) asks
    // for the LAST KNOWN address of each holder by that name.
    await setAddress({
      partyId: founder.id, purpose: 'mailing',
      line1: '77 Water St', city: 'Vancouver', region: 'BC', postalCode: 'V6B 1A1',
    })
    // An allotment carrying its full particulars: what was given for the
    // shares, and the certificate it produced.
    await issueShares({
      shareClassId: classA, partyId: investor.id, onDate: '2026-04-01', quantity: 10n,
      details: 'Second allotment', consideration: '$10.00 per share, cash',
      certificateNo: 'C-9', actor: 'alicio@example.test',
    })
    // And a SECOND live holder, deliberately: with one holder at a time the
    // class's running total and each holder's own running total are the same
    // number, and a balance that quietly stopped being per-holder went
    // unnoticed by the spot-proof of block 279. Two holders standing at once
    // is what makes that column discriminate.
    await issueShares({
      shareClassId: classA, partyId: founder.id, onDate: '2026-04-02', quantity: 40n,
      details: 'Founder tops up', consideration: 'for services rendered',
      certificateNo: 'C-10', actor: 'alicio@example.test',
    })

    const csr = await renderRegister('central_securities', E, '2026-04-30', 'director')
    const detail = csr.detail
    const at = (cols: string[], label: string) => cols.indexOf(label)

    // CR27 — the register PRINTS its particulars, and the two tables agree.
    //        The movements were in the table from the first day and on no
    //        page: "date and particulars of each issue and transfer" is half
    //        of what the section asks for (owner, 2026-09-03). The tie is
    //        the point — each holder's LAST running balance below must be
    //        the holding shown above, or the page cannot be added up.
    const holderCol = at(csr.columns, 'Holder')
    const heldCol = at(csr.columns, 'Shares held')
    const classCol = at(csr.columns, 'Class / series')
    const dHolder = detail ? at(detail.columns, 'Holder') : -1
    const dClass = detail ? at(detail.columns, 'Class / series') : -1
    const dBalance = detail ? at(detail.columns, 'Balance') : -1
    const mismatched = (csr.rows.filter((r) => r[holderCol] !== 'TOTAL ISSUED')).filter((r) => {
      const last = [...(detail?.rows ?? [])].reverse()
        .find((d) => d[dHolder] === r[holderCol] && d[dClass] === r[classCol])
      return !last || last[dBalance] !== r[heldCol]
    })
    const allot = detail?.rows.find((d) => d.includes('C-9'))
    // "From whom" is the particular the Act asks for, so it must name the
    // OTHER side. Pinning the two sentences by their text passed while every
    // transfer named its own holder: this fixture transfers both ways between
    // the same two parties, so the mutated rows spelled the very strings the
    // check was looking for (spot-proof of block 283).
    const dHow = detail ? at(detail.columns, 'How') : -1
    const transfers = (detail?.rows ?? []).filter((d) => d[dHow].startsWith('Transfer '))
    const selfDealt = transfers.filter((d) => {
      const how = d[dHow]
      const named = how.startsWith('Transfer from ') ? how.slice('Transfer from '.length)
        : how.slice('Transfer to '.length)
      return named === d[dHolder]
    })
    check(!!detail && mismatched.length === 0 && !!allot
          && transfers.length >= 2 && selfDealt.length === 0
          && allot.includes('Allotment') && allot.includes('$10.00 per share, cash'),
      'CR27 the register prints its particulars, and they add up to the holdings',
      // Each arm names what actually went wrong. The first version printed
      // the happy sentence on failure too — "every holder's last balance is
      // the holding above" beside a FAIL — which is the diagnostic that lies
      // about the very thing it failed on.
      !detail ? 'no particulars section'
        : mismatched.length > 0
          ? `${mismatched.length} holder(s) whose last balance is not the holding above: `
            + mismatched.map((r) => `${r[holderCol]} held ${r[heldCol]}`).join(', ')
        : selfDealt.length > 0
          ? `${selfDealt.length} transfer(s) naming their own holder as the other side`
        : transfers.length < 2 ? `only ${transfers.length} transfer row(s) — nothing to discriminate`
        : !allot ? 'the allotment carrying C-9 and its consideration is not on the page'
        : `${detail.rows.length} movements, ${transfers.length} of them transfers naming the other side;`
          + ` every holder's last balance is the holding above`)

    // CR28 — the holder's last known address, which the Act asks for by that
    //        name — and which a public inspection copy must not carry, like
    //        every other thing this register says about a person.
    const addrCol = at(csr.columns, 'Last known address')
    const founderRow = csr.rows.find((r) => r[holderCol] === 'Alicio Xu')
    const pub = await renderRegister('central_securities', E, '2026-04-30', 'public')
    check(addrCol >= 0 && !!founderRow && founderRow[addrCol].includes('77 Water St')
          && !pub.columns.includes('Last known address') && pub.withheld.includes('address')
          && pub.detail === undefined && pub.withheld.includes('particulars'),
      'CR28 the holder address is on the register and off the public copy',
      founderRow ? `${founderRow[addrCol].slice(0, 34)}; public withholds ${pub.withheld.length} fields` : 'no row')

    // CR29 — an as-at register SAYS SO when there is more after its date.
    //        This is the owner's buy-back that "did nothing": two
    //        cancellations dated after the day the register was asked
    //        about, correctly absent and silently so (2026-09-03).
    await cancelShares({
      shareClassId: classA, partyId: investor.id, onDate: '2026-12-01', quantity: 5n,
      details: 'Buy-back, effective later', actor: 'alicio@example.test',
    })
    const early = await renderRegister('central_securities', E, '2026-04-30', 'director')
    const note = early.headerNotes.find((n) => n.includes('2026-12-01'))
    const leaked = (early.detail?.rows ?? []).filter((r) => r[0] > '2026-04-30')
    check(!!note && note.includes('not shown') && leaked.length === 0,
      'CR29 a register says when there are movements after its date',
      note ? note.slice(0, 88) : 'the page said nothing about the later movement')

    // CR30 — and the door that recorded it says the same thing at the moment
    //        of recording: the message names the date, and names it as
    //        future when it is. Read through the FORM readers, which are what
    //        the screens call (a check cannot call a server action): the add
    //        form of rows, and the Cease button on a register.
    const f = new FormData()
    f.set(RECORD_FIELDS.ledgerId, co.ledger.id)  // the screen's form always says which books
    f.set(RECORD_FIELDS.table, 'shares')
    f.set(rowField(0, 'kind'), 'cancellation')
    f.set(rowField(0, 'shareClass'), 'Class A')
    f.set(rowField(0, 'from'), 'Harbour Capital Ltd.')
    f.set(rowField(0, 'quantity'), '1')
    f.set(rowField(0, 'onDate'), '2099-01-01')
    f.set(rowField(0, 'details'), 'A buy-back dated far ahead')
    const said = await enterRowsFromForm(f, 'alicio@example.test')
    // A director of its own, appointed long before and ceasing far ahead, so no
    // register or certificate a later check reads as at 2026 changes.
    const passing = await createParty({ kind: 'person', name: 'Pat Futurecease',
      roles: [{ entityId: E, role: 'director', heldFrom: '2021-01-01' }], actor: 'alicio@example.test' })
    const later = await appointDirector({ entityId: E, partyId: passing.id, appointedOn: '2021-01-01',
      prescribedDelivery: '1 Harbour Way, Vancouver', actor: 'alicio@example.test' }).catch(() => undefined)
    const cf = new FormData()
    cf.set(RECORD_FIELDS.ledgerId, co.ledger.id)
    cf.set(RECORD_FIELDS.directorshipId, later ?? '')
    cf.set(RECORD_FIELDS.ceasedOn, '2099-06-30')
    const ceased = later ? await ceaseDirectorFromForm(cf, 'alicio@example.test') : { error: 'no term to cease' }
    check(said.ok?.includes('2099-01-01') === true && said.ok?.includes('after today') === true
          && ceased.ok?.includes('2099-06-30') === true && ceased.ok?.includes('after today') === true,
      'CR30 recording a future-dated movement or cessation says so in the message',
      `rows: ${said.ok ?? said.error ?? 'nothing came back'} / cease: ${ceased.ok ?? ceased.error ?? 'nothing came back'}`)

    // CR31 — and the PDF carries the second table too. One structure, two
    //        exits: a particulars section that exists only on the screen is
    //        the thing CR16 was written to prevent, one table further on.
    const pdf = await registerPdf(co.ledger.id, 'central_securities', '2026-04-30', 'director')
    const text = pdf ? pdfText(pdf.buffer) : ''
    check(text.includes('Date and particulars') && text.includes('C-9')
          && text.includes('77 Water St'),
      'CR31 the register PDF carries the particulars and the address',
      pdf ? `${text.length} characters of text` : 'no pdf')

    // CR32 — the certificate fields land on the row whose holder they belong
    //        to. A transfer surrenders the transferor's certificate, issues
    //        one to the transferee, and — when only PART of a holding moves —
    //        issues a balance certificate back to the transferor. That is the
    //        cancel-and-reissue the owner asked about, on the layer it
    //        actually happens on (2026-09-03). Three fields, three different
    //        rows' business, and nothing else in this suite writes them:
    //        without this they are columns a form can fill and no page reads.
    await transferShares({
      shareClassId: classA, fromPartyId: founder.id, toPartyId: investor.id,
      onDate: '2026-04-20', quantity: 15n, details: 'Partial transfer',
      consideration: '$15.00 per share', surrenderedNo: 'C-10',
      certificateNo: 'C-11', balanceNo: 'C-12', actor: 'alicio@example.test',
    })
    const moves = await shareMovements(E, '2026-04-30')
    const out = moves.find((m) => m.on_date === '2026-04-20' && m.kind === 'transfer_out')
    const inn = moves.find((m) => m.on_date === '2026-04-20' && m.kind === 'transfer_in')
    // And the balances still tie after a PARTIAL move — the case where a
    // running balance and a holding can most easily part company.
    const after = await securitiesRegister(E, '2026-04-30')
    const stillTies = after.filter((h) => {
      const last = [...moves].reverse().find((m) => m.holder === h.holder && m.class_name === h.class_name)
      return !last || String(last.running) !== String(h.holding)
    })
    check(out?.surrendered_no === 'C-10' && out?.certificate_no === 'C-12'
          && inn?.certificate_no === 'C-11' && inn?.surrendered_no === null
          && out?.consideration === '$15.00 per share'
          && inn?.consideration === '$15.00 per share'
          && stillTies.length === 0,
      'CR32 a partial transfer surrenders one certificate and issues two',
      out && inn
        ? `out: surrendered ${out.surrendered_no}, balance ${out.certificate_no}; `
          + `in: ${inn.certificate_no}; ${stillTies.length} holdings adrift`
        : 'the transfer is not in the movements')

    // CR33 — an as-at register that is EMPTY because everything happened
    //        later says so. All three registers, because movementsAfter has a
    //        branch each and two of them were otherwise never run: a branch
    //        that always answers zero is the silence this node exists to fix.
    const silent: string[] = []
    for (const kind of ['directors', 'central_securities', 'transparency'] as const) {
      const r = await renderRegister(kind, E, '2019-01-01', 'director')
      const says = r.headerNotes.some((n) => n.includes('not shown here'))
      // The securities register still prints a TOTAL ISSUED line per class:
      // a share class carries no date of its own, so it exists as at any
      // date and honestly stands at nothing. What must not be there is a
      // PERSON — a holder who had not yet acquired anything.
      const people = r.rows.filter((row) => !row.includes('TOTAL ISSUED'))
      if (!says || people.length > 0) silent.push(`${kind}: ${people.length} rows, note ${says}`)
    }
    check(silent.length === 0,
      'CR33 an empty as-at register says what it is not showing',
      silent.length === 0 ? 'all three registers name their later movements' : silent.join('; '))
  }

  // ------------------------------------------- the paper the holder keeps --
  {
    // CR34 — a certificate says what the REGISTER says. Its figures come
    //        from `securitiesRegister` and its number from the movement that
    //        issued it, so a certificate and the register cannot disagree —
    //        which is the only thing that makes a certificate worth issuing.
    const asOf = '2026-04-30'
    const made = await shareCertificate(co.ledger.id, classA, investor.id, asOf)
    const reg = (await securitiesRegister(E, asOf))
      .find((h) => h.share_class_id === classA && h.party_id === investor.id)!
    const text = made ? pdfText(made.buffer) : ''
    const words = inWords(BigInt(reg.holding))
    // Justified paragraphs place every word on its own, so the extracted
    // stream has no spaces inside them. Both sides lose their whitespace: the
    // claim is about the WORDS on the paper, not about how they were laid
    // out, and pretending otherwise would fail a certificate for being
    // typeset.
    const squash = (v: string) => v.replace(/\s+/g, '')
    const says = (needle: string) => squash(text).includes(squash(needle))
    check(!!made && made.facts.shares === BigInt(reg.holding)
          && says(reg.holder) && says(String(reg.holding))
          && says(words)
          && says('BRITISH COLUMBIA') && says('Director')
          && says('restrictions on transfer'),
      'CR34 the certificate says what the register says, in figures and words',
      // Which needle is missing, not a cheerful summary beside a FAIL.
      !made ? 'no certificate was produced'
        : (() => {
            const absent = [reg.holder, String(reg.holding), words, 'BRITISH COLUMBIA',
                            'Director', 'restrictions on transfer'].filter((n) => !says(n))
            return absent.length > 0
              ? `the paper does not say: ${absent.join(' / ')}`
              : `${made.facts.shares} shares = "${words}"; ${text.length} characters`
          })())

    // CR34b — the number on the paper is the number the register still has
    //         OUT. One certificate per holder per class is the owner's shape
    //         (2026-09-03), and it is only the truth once the earlier ones
    //         have been surrendered:
    //
    //         the founder's C-10 went in when they transferred part of their
    //         holding away, so C-12 — the balance certificate — is the one
    //         thing evidencing what they hold, and the paper names it;
    //
    //         the investor was ISSUED C-9 and later received C-11 without
    //         either being taken in, so two certificates cover one holding.
    //         Naming the newer one would say the register supports something
    //         it does not; the paper names both and says they are to be
    //         surrendered on the issue of this one. The first version of
    //         this check restated the "last recorded" rule and was green
    //         against exactly that mistake (critic, 2026-09-03).
    const balanceHolder = await shareCertificate(co.ledger.id, classA, founder.id, asOf)
    const balanceText = balanceHolder ? pdfText(balanceHolder.buffer) : ''
    const two = made!.facts
    check(balanceHolder?.facts.certificateNo === 'C-12'
          && balanceHolder.facts.evidencedBy.join() === 'C-12'
          && balanceText.includes('C-12')
          && two.certificateNo === null
          && two.evidencedBy.join() === 'C-9,C-11'
          && squash(text).includes(squash('certificates C-9 and C-11'))
          && squash(text).includes('surrendered'),
      'CR34b the paper names the certificates the register still has out',
      `one holder: ${balanceHolder?.facts.certificateNo ?? 'none'};`
      + ` the other: ${two.certificateNo ?? 'none'} of [${two.evidencedBy.join(', ')}]`)

    // CR35 — there is no certificate for nothing. A holder whose balance is
    //        zero as at the date gets a refusal, not a piece of paper saying
    //        they hold none: issuing that would be issuing paper the register
    //        does not support.
    const gone = await shareCertificate(co.ledger.id, classA, founder.id, '2026-03-16')
    check(gone === null,
      'CR35 a holder with nothing gets no certificate',
      gone === null ? 'refused, as at the day after their shares were cancelled'
                    : `issued for ${gone.facts.shares} shares`)

    // CR36 — the words and the figures are the same number, which is the
    //        whole reason a certificate carries both. Checked over the
    //        awkward shapes rather than the one the fixture happens to hold.
    const spelled: Array<[bigint, string]> = [
      [0n, 'zero'], [7n, 'seven'], [13n, 'thirteen'], [20n, 'twenty'], [21n, 'twenty-one'],
      [100n, 'one hundred'], [115n, 'one hundred and fifteen'],
      [1000n, 'one thousand'], [1005n, 'one thousand and five'],
      [1100n, 'one thousand one hundred'],
      [1_000_000n, 'one million'],
      // Above the top scale the recursion has to keep naming things: without
      // a trillion, 10^12 spells "one thousand billion" and no check below a
      // billion would ever see it (critic, 2026-09-03).
      [1_000_000_000_000n, 'one trillion'],
      [2_000_000_000_001n, 'two trillion and one'],
    ]
    const wrong = spelled.filter(([n, want]) => inWords(n) !== want)
    check(wrong.length === 0,
      'CR36 a number in words is the number',
      wrong.length === 0 ? `${spelled.length} shapes spelled right`
        : wrong.map(([n, want]) => `${n}: ${inWords(n)} != ${want}`).join('; '))
  }

  // CR37 — THE ID BESIDE THE LEDGER. Every records form carries an entity id
  //        and the registers' doors read directorship and share-class ids out
  //        of it; all were judged only by the ledger beside them (audit,
  //        2026-09-13). Each door now asks `ours()`: the entity IS this
  //        ledger's company, the row belongs to it.
  {
    const theirs = await createCompany({ code: 'THEIRS', name: 'Somebody Else Ltd.' }, 'alicio@example.test')
    const theirDirector = await createParty({
      kind: 'person', name: 'Their Director',
      roles: [{ entityId: theirs.company.id, role: 'director', heldFrom: '2020-01-01' }], actor: 'alicio@example.test',
    })
    await setAddress({
      partyId: theirDirector.id, purpose: 'delivery',
      line1: '1 Their Street', city: 'Victoria', region: 'BC', postalCode: 'V8W 1A1',
    })
    const theirTerm = await appointDirector({
      entityId: theirs.company.id, partyId: theirDirector.id, appointedOn: '2020-01-15', actor: 'alicio@example.test',
    })
    const theirClass = await createShareClass({ entityId: theirs.company.id, name: 'Their Class A', actor: 'alicio@example.test' })
    const withOurs = (fields: Record<string, string>) => {
      const fd = new FormData()
      fd.set(RECORD_FIELDS.ledgerId, co.ledger.id)             // this company's ledger, always
      for (const [k, v] of Object.entries(fields)) fd.set(k, v)
      return fd
    }
    const REFUSED = "not in this company's books"
    const cases: Array<[string, () => Promise<{ error?: string; ok?: string }>]> = [
      ['profile of theirs', () => saveProfileFromForm(withOurs({ [RECORD_FIELDS.entityId]: theirs.company.id, [RECORD_FIELDS.incorporationNumber]: 'BC9999999' }), 'alicio@example.test')],
      ['cease their director', () => ceaseDirectorFromForm(withOurs({ [RECORD_FIELDS.directorshipId]: theirTerm, [RECORD_FIELDS.ceasedOn]: '2026-01-31' }), 'alicio@example.test')],
    ]
    const wrong: string[] = []
    for (const [label, fn] of cases) {
      const r = await fn()
      if (!r.error || !r.error.includes(REFUSED)) wrong.push(`${label}: ${r.error ?? r.ok ?? 'nothing said'}`)
    }
    // THE ROWS DOOR HAS NO ENTITY TO POINT ELSEWHERE (2026-09-16). It takes the
    // company from the ledger, so a crafted `entityId` beside it is ignored and
    // the rows land in THIS company — their director gets no second term and
    // their class no movement, even with their names typed in.
    const crafted = await enterRowsFromForm(withOurs({
      [RECORD_FIELDS.entityId]: theirs.company.id, [RECORD_FIELDS.table]: 'shares',
      [rowField(0, 'kind')]: 'issue', [rowField(0, 'shareClass')]: 'Their Class A',
      [rowField(0, 'to')]: 'Their Director', [rowField(0, 'quantity')]: '10', [rowField(0, 'onDate')]: '2026-02-01',
    }), 'alicio@example.test')
    const [still] = await db.execute<{ ceased: string | null; issued: string; terms: string; ours: string }>(raw`
      SELECT (SELECT ceased_on::text FROM directorship WHERE id = ${theirTerm}::uuid) AS ceased,
             (SELECT count(*) FROM share_transaction st WHERE st.share_class_id = ${theirClass}::uuid)::text AS issued,
             (SELECT count(*) FROM directorship WHERE entity_id = ${theirs.company.id}::uuid)::text AS terms,
             (SELECT count(*) FROM share_transaction st JOIN share_class c ON c.id = st.share_class_id
               WHERE c.entity_id = ${E}::uuid AND c.name = 'Their Class A')::text AS ours`)
    // Their director is on THEIR list only, so the rows door uses that party
    // here — the owner's call (2026-09-16: 可以用，但必须写出来) — and must say so.
    const disclosed = crafted.ok?.includes("Found on another company's list and used here: Their Director (now a shareholder here)") === true
    check(wrong.length === 0 && still?.ceased === null && still?.issued === '0'
          && still?.terms === '1' && still?.ours === '1' && disclosed,
      "CR37 the id doors refuse another company's entity or directorship; the rows door enters only here and says whom it used from elsewhere",
      // Composed from what was counted, not from whether the door said ok: a
      // crafted entity id that moved the rows would read "0 here, 1 theirs".
      `${wrong.length ? wrong.join('; ') : 'profile and cease refused'}; the rows door said `
        + `${(crafted.ok ?? crafted.error ?? 'nothing').slice(0, 90)}; movements landed: ${still?.ours ?? '?'} here, `
        + `${still?.issued ?? '?'} theirs; their director ${still?.ceased === null ? 'still serving' : `CEASED ${still?.ceased}`}, `
        + `${still?.terms ?? '?'} term(s) of theirs; the use of their party ${disclosed ? 'is said' : 'is NOT said'}`)
  }

  // ------------------------------------------------ the add forms of rows --
  //
  // docs/design/41. Every register's add form takes rows, and a reading of a
  // minute book fills them; these hold what that door promises.
  {
    const rows = await createCompany({ code: 'ROWS', name: 'Rows Ltd.' }, 'alicio@example.test')
    const RE = rows.company.id
    const RL = rows.ledger.id
    const actor = 'alicio@example.test'
    const form = (table: string, list: Array<Record<string, string>>, extra: Record<string, string> = {}) => {
      const fd = new FormData()
      fd.set(RECORD_FIELDS.ledgerId, RL)
      fd.set(RECORD_FIELDS.table, table)
      list.forEach((row, i) => { for (const [k, v] of Object.entries(row)) fd.set(rowField(i, k), v) })
      for (const [k, v] of Object.entries(extra)) fd.set(k, v)
      return fd
    }
    const enter = async (fd: FormData) => {
      try { return await enterRowsFromForm(fd, actor) } catch (e) { return { error: `THREW ${errorText(e).slice(0, 80)}` } }
    }
    const count = async (q: ReturnType<typeof raw>) => {
      try { const [x] = await db.execute<{ n: string }>(q); return Number(x?.n ?? -1) } catch { return -1 }
    }

    // CR38 — directors go in together and in date order, whatever order the
    //        rows were typed in: Morgan's resignation is row 1 and their
    //        appointment row 2, and the term still opens before it closes. A
    //        name nobody has is added to the list; a name somebody has (Dana
    //        Chen, a director of Records Ltd.) is that person, given the role.
    const said = await enter(form('directors', [
      { name: 'Morgan Lee', ceasedOn: '2024-06-30' },
      { name: 'Morgan Lee', address: '9 Cedar Rd, Victoria', appointedOn: '2022-03-01' },
      { name: 'dana  chen', appointedOn: '2022-03-01' },
    ]))
    const terms = await db.execute<{ name: string; appointed: string; ceased: string | null }>(raw`
      SELECT p.name, d.appointed_on::text AS appointed, d.ceased_on::text AS ceased
        FROM directorship d JOIN party p ON p.id = d.party_id
       WHERE d.entity_id = ${RE}::uuid ORDER BY p.name`)
    const danaRole = await count(raw`
      SELECT count(*)::text AS n FROM party_role WHERE party_id = ${director.id}::uuid
         AND entity_id = ${RE}::uuid AND role = 'director'`)
    const danas = await count(raw`SELECT count(*)::text AS n FROM party WHERE party_name_key(name) = 'dana chen'`)
    const morgan = terms.find((t) => t.name === 'Morgan Lee')
    const dana = terms.find((t) => t.name === 'Dana Chen')
    check(said.ok?.startsWith('Entered 3 directors.') === true && said.ok.includes('Added to this company\'s list: Morgan Lee.')
          && said.ok.includes("Found on another company's list and used here: Dana Chen (now a director here).")
          && terms.length === 2 && morgan?.appointed === '2022-03-01' && morgan?.ceased === '2024-06-30'
          && dana?.appointed === '2022-03-01' && dana?.ceased === null && danaRole === 1 && danas === 1,
      'CR38 a form of directors goes in by date, adds the new name, finds the known one and says it came from elsewhere',
      `${said.ok ?? said.error}; terms ${terms.map((t) => `${t.name} ${t.appointed}..${t.ceased ?? ''}`).join(', ')}; `
        + `Dana given the role here ${danaRole}x, ${danas} Dana Chen on the list`)

    // CR39 — one day, three movements, typed in the wrong order: the transfer
    //        first, the issue it transfers second. `sameDayRank` puts the issue
    //        first and 0080's clock_timestamp keeps the two rows of one
    //        transaction in the order they were written, so the holding is
    //        never negative on its own history. The class is created; the
    //        holding company is an organisation, the person a person.
    const shares = await enter(form('shares', [
      { kind: 'transfer', shareClass: 'Class A Common', onDate: '2022-03-01', from: 'Founder Holdings Ltd.', to: 'Rowan Park', quantity: '40', certificateNo: 'A-2', surrenderedNo: 'A-1', balanceNo: 'A-3' },
      { kind: 'issue', shareClass: 'Class A Common', onDate: '2022-03-01', to: 'Founder Holdings Ltd.', quantity: '100', consideration: '$100, cash', certificateNo: 'A-1' },
    ]))
    const held = await holdingsAsAt(RE, '2022-03-01')
    const kinds = await db.execute<{ name: string; kind: string }>(raw`
      SELECT name, kind FROM party WHERE name IN ('Founder Holdings Ltd.', 'Rowan Park') ORDER BY name`)
    const heldBy = (who: string) => { const h = held.find((x) => x.holder === who); return h ? BigInt(h.holding) : null }
    check(shares.ok?.includes('Entered 2 share movements.') === true && shares.ok.includes('New share class: Class A Common')
          && heldBy('Founder Holdings Ltd.') === 60n && heldBy('Rowan Park') === 40n
          && kinds.map((k) => k.kind).join() === 'organisation,person',
      'CR39 a same-day issue and transfer go in in the order they must, whatever order they were typed',
      `${shares.ok ?? shares.error}; held ${held.map((h) => `${h.holder} ${h.holding}`).join(', ') || 'nothing'}; `
        + `kinds ${kinds.map((k) => `${k.name} ${k.kind}`).join(', ')}`)

    // CR40 — one refused row and nothing goes in. Row 2 cancels shares for
    //        somebody nobody has heard of, which is refused at the database's
    //        door; row 1 — valid on its own, and bringing a new class and a new
    //        holder with it — is taken back with it. And what can be said
    //        without the database is said for EVERY row at once.
    const before = await count(raw`SELECT count(*)::text AS n FROM share_transaction st JOIN share_class c ON c.id = st.share_class_id WHERE c.entity_id = ${RE}::uuid`)
    const refused = await enter(form('shares', [
      { kind: 'issue', shareClass: 'Class B Preferred', onDate: '2023-01-10', to: 'Quinn Newholder', quantity: '5' },
      { kind: 'cancellation', shareClass: 'Class A Common', onDate: '2023-02-01', from: 'Nobody Holds Ltd.', quantity: '5' },
    ]))
    const after = await count(raw`SELECT count(*)::text AS n FROM share_transaction st JOIN share_class c ON c.id = st.share_class_id WHERE c.entity_id = ${RE}::uuid`)
    const leaked = await count(raw`SELECT (SELECT count(*) FROM share_class WHERE entity_id = ${RE}::uuid AND name = 'Class B Preferred')
                                     + (SELECT count(*) FROM party WHERE name = 'Quinn Newholder') AS n`)
    // A refusal the DATABASE makes at the end of a statement names its row
    // too: 0035 defers the holding check to the commit, where a batch could
    // only say that something somewhere was overdrawn.
    const overdrawn = await enter(form('shares', [
      { kind: 'issue', shareClass: 'Class A Common', onDate: '2023-03-01', to: 'Rowan Park', quantity: '1' },
      { kind: 'transfer', shareClass: 'Class A Common', onDate: '2023-03-02', from: 'Founder Holdings Ltd.', to: 'Rowan Park', quantity: '1000' },
    ]))
    const both = await enter(form('directors', [
      { address: 'nowhere', appointedOn: '2023-01-01' },
      { name: 'Sam Two' },
    ]))
    const afterOverdraw = await count(raw`SELECT count(*)::text AS n FROM share_transaction st JOIN share_class c ON c.id = st.share_class_id WHERE c.entity_id = ${RE}::uuid`)
    check(refused.error?.includes('Row 2:') === true && refused.error.includes('Nobody Holds Ltd.')
          && overdrawn.error?.includes('Row 2: SHARES_OVERDRAWN') === true && afterOverdraw === before
          && before === after && before >= 0 && leaked === 0
          && both.error?.includes('Row 1: Director is missing.') === true && both.error.includes('Row 2: give Appointed or Ceased'),
      'CR40 a refused row takes the whole form back, and every row\'s problems are said at once',
      `${refused.error ?? refused.ok}; movements ${before} → ${after}; class or holder left behind ${leaked}; `
        + `overdrawn: ${(overdrawn.error ?? overdrawn.ok ?? '').slice(0, 60)}, movements then ${afterOverdraw}; `
        + `problems: ${(both.error ?? both.ok ?? '').replaceAll('\n', ' / ')}`)

    // CR41 — A READING'S ROWS, ONCE PER TABLE. A stand-in model answers a minute
    //        book the way the prompt asks: rows under two tables, plus a table
    //        that does not exist and a column that does not either — and a
    //        date it could not read. The reading keeps only what the add forms
    //        take; the directors enter once, and the second press is refused
    //        before anything is written; the minute book, a different table
    //        of the same reading, still goes in; and the reading is now kept.
    let asked = ''
    const send: Send = async (req) => {
      asked = req.question
      return {
        model: 'stand-in', stopReason: 'end_turn', explanation: null,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        text: JSON.stringify({
          suggests: 'minute_book', kind: 'minute book', belongs: 'minutes and resolutions', facts: {},
          rows: {
            minute_book: [
              { recordKind: "Directors' Resolution", onDate: '2022-03-01', title: 'Organizational resolutions', keptAt: 'Vol. 1' },
              { record_kind: 'shareholders minutes', on_date: 'March 3rd', title: 'First meeting', kept_at: 'Vol. 1', shoeSize: '11' },
            ],
            Directors: [{ Name: 'Avery Stone', Address: '3 Oak St, Surrey', AppointedOn: '2022-03-02' }],
            grocery: [{ item: 'milk' }],
          },
          party: '', documentRef: '', issuedOn: null, dueOn: null, currency: 'CAD', lines: [],
          subtotal: null, gst: null, pst: null, total: null, notes: '',
        }),
      }
    }
    const service = serviceFrom({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'stand-in-key', model: 'stand-in' })!
    let readingId = ''
    let readSaid = ''
    try {
      readingId = (await readBill({ ledgerId: RL, sentence: 'Our minute book, pages 1-3.', actor, service, prices: null }, send)).id
    } catch (e) { readSaid = errorText(e).slice(0, 80) }
    const reading = readingId ? await readingById(RL, readingId) : null
    const got = reading?.proposal?.rows ?? {}
    const minuteForm = formRowsFrom('minute_book', got.minute_book ?? [], { minuteKinds: await minuteKinds() })
    const kept = Object.keys(got).sort().join()
    const columnsKept = (got.minute_book ?? []).every((row) => Object.keys(row).every((k) => RECORD_COLUMNS.minute_book.some((c) => c.key === k)))
    const firstEntry = await enter(form('directors', [{ name: 'Avery Stone', address: '3 Oak St, Surrey', appointedOn: '2022-03-02' }],
      { [RECORD_FIELDS.readingId]: readingId }))
    const again = await enter(form('directors', [{ name: 'Avery Stone', address: '3 Oak St, Surrey', appointedOn: '2022-03-02' }],
      { [RECORD_FIELDS.readingId]: readingId }))
    const averys = await count(raw`SELECT count(*)::text AS n FROM directorship d JOIN party p ON p.id = d.party_id WHERE p.name = 'Avery Stone'`)
    const minutes = await enter(form('minute_book', minuteForm.map((row) => ({ ...row.values, onDate: row.values.onDate || '2022-03-03' })),
      { [RECORD_FIELDS.readingId]: readingId }))
    const marked = readingId ? Object.keys((await readingById(RL, readingId))?.records_entered ?? {}).sort().join() : ''
    let discarded = 'not tried'
    try { await discardReading(RL, readingId); discarded = 'WENT THROUGH' } catch (e) { discarded = errorText(e).includes('READING_ALREADY_USED') ? 'refused' : errorText(e).slice(0, 60) }
    const everyTable = RECORD_TABLES.every((t) => asked.includes(`"${t}" rows are`)
      && RECORD_COLUMNS[t].every((c) => asked.includes(`"${c.key}":`)))
    check(readSaid === '' && kept === 'directors,minute_book' && columnsKept
          && minuteForm[0]?.values.recordKind === 'directors_resolution'
          && minuteForm[1]?.values.recordKind === 'shareholders_minutes' && minuteForm[1]?.values.onDate === ''
          && minuteForm[1]?.unplaced.some((u) => u.includes('March 3rd')) === true
          && firstEntry.ok?.startsWith('Entered 1 director.') === true
          && again.error?.includes('already in the directors register') === true && averys === 1
          && minutes.ok?.startsWith('Entered 2 minute-book records.') === true
          && marked === 'directors,minute_book' && discarded === 'refused' && everyTable && asked.includes(rowsMenu()),
      'CR41 a reading carries rows the add forms take, and each table enters once',
      `${readSaid || `tables kept ${kept}`}; foreign columns ${columnsKept ? 'dropped' : 'KEPT'}; kinds `
        + `${minuteForm.map((m) => m.values.recordKind || '—').join('/')}; unreadable date ${minuteForm[1]?.values.onDate === '' ? 'left blank' : 'GUESSED'}; `
        + `first ${firstEntry.ok ?? firstEntry.error}; again ${again.error ?? again.ok}; ${averys} term(s) for Avery; `
        + `minutes ${minutes.ok ?? minutes.error}; marked ${marked || 'nothing'}; discard ${discarded}; `
        + `the prompt ${everyTable ? 'names every table and column' : 'MISSES a table or column'}`)

    // CR42 — THE READER'S EDGES. A choice matches exactly, then by every word
    //        of one option, and never between two; a model's column spelled any
    //        way folds to the form's; a table or a row of nothing is nothing.
    const kindsList = await minuteKinds()
    const branches: Array<[string, boolean]> = [
      ['exact', choiceOf('transfer', ['issue', 'transfer', 'cancellation']) === 'transfer'],
      ['words, any case and punctuation', choiceOf("DIRECTORS' consent", kindsList) === 'directors_consent'],
      ['a plural s either way', choiceOf('director consent to act', kindsList) === 'directors_consent'],
      ['two options that both fit are no match', choiceOf('directors shareholders minutes resolution', kindsList) === null],
      ['nothing like it', choiceOf('grocery list', kindsList) === null],
      ['a column spelled with underscores', rowsFrom({ offices: [{ delivery_address: '1 Main' }] }).offices?.[0]?.deliveryAddress === '1 Main'],
      ['an empty row is no row', rowsFrom({ offices: [{}, { shoe: 'x' }] }).offices === undefined],
      ['a table that is not an array', Object.keys(rowsFrom({ directors: 'Avery' })).length === 0],
      ['a count with commas', formRowsFrom('shares', [{ quantity: '1,000' }])[0]?.values.quantity === '1000'],
      ['a count that is not one', formRowsFrom('shares', [{ quantity: 'a hundred' }])[0]?.values.quantity === ''],
    ]
    const broken = branches.filter(([, ok]) => !ok).map(([what]) => what)
    check(broken.length === 0,
      'CR42 a model\'s rows are taken the way the form takes them, and nothing is guessed',
      broken.length === 0 ? `${branches.length} branches` : `not so: ${broken.join(', ')}`)
  }

  // What makes a screen offer Edit on its rows (0083): a movement, a class and
  // the lists the boxes suggest. Shared by CR43, which renders the screen at
  // rest, and CR50, which opens a row.
  const EDITABLE = {
    movements: [{ id: 't1', kind: 'transfer', share_class: 'Class A', on_date: '2021-03-01', from_name: 'Alicio Xu',
      to_name: 'Dana Chen', quantity: '10', consideration: '$1.00', certificate_no: 'C-2', surrendered_no: 'C-1',
      balance_no: 'C-3', details: 'Resolution of 2021-02-28' }],
    classes: [{ id: 'c1', name: 'Class A', series: null, movements: 1 }],
    choices: { names: ['Alicio Xu', 'Dana Chen'], localNames: ['Alicio Xu', 'Dana Chen'], classes: ['Class A'],
      minuteKinds: ['directors_resolution', 'shareholders_minutes'] },
  }

  // CR43 — THE SCREEN AT REST HAS NO BOXES, AND THE ADD FORM SUBMITS EVERY
  //        COLUMN. The owner's words (2026-09-16): 「所有添加记录的功能都以表单
  //        形式以悬浮页面呈现，不要再像 corporate records 一样，直接有空可以
  //        填」. So the records screen, rendered with something in every
  //        section, carries no named field at all — every add is a link to its
  //        floating form, every Cease a button until pressed — and the add form
  //        it links to names one field per column per row, the table, and the
  //        reading, which is the whole of what the door reads back.
  {
    const render = (input: unknown) => {
      try {
        return (JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-records.tsx', JSON.stringify(input)],
          { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
      } catch (e) { return `RENDER FAILED ${errorText(e).slice(0, 80)}` }
    }
    const screen = render({ what: 'screen', data: {
      show: 'all', today: '2026-09-16',
      profile: { incorporation_number: 'BC1', business_number: null, recognition_date: '2020-01-15', company_type: 'limited' },
      isCcpc: null, companyTypes: [{ id: 'limited', label: 'Limited company' }],
      offices: [{ id: 'o1', office: 'registered', delivery_address: '1 Main', delivery_city: 'Vancouver', delivery_postal: null, effective_from: '2020-01-15', effective_to: null }],
      directorships: [{ id: 'd1', name: 'Dana Chen', prescribed_delivery: '1 Main', appointed_on: '2020-01-15', ceased_on: null }],
      holdings: [{ share_class_id: 'c1', party_id: 'p1', class_name: 'Class A', series: null, holder: 'Alicio Xu', holding: '100' }],
      totals: [{ class_name: 'Class A', series: null, issued: '100' }],
      sis: [{ id: 's1', name: 'Alicio Xu', how_control: 'owner of 100%', became_on: '2020-01-15', ceased_on: null, citizen_or_pr: false, citizenships: 'China', tax_resident_ca: true }],
      minuteBook: [{ id: 'm1', record_kind: 'directors_resolution', on_date: '2020-01-15', title: 'Organization', kept_at: 'Vol. 1' }],
      minutePaper: { m1: [{ id: 'p1', filename: '2020-01-15 directors resolution Organization.pdf' }] },
      ...EDITABLE,
    } })
    const L36 = 'L'.repeat(36)
    // Closed dialogs do not count as boxes at rest. Minute-book attachments
    // now live in their dedicated multipart workspace.
    const dialogs = screen.match(/<dialog\b[\s\S]*?<\/dialog>/g) ?? []
    const visible = dialogs.reduce((html, d) => html.replace(d, ''), screen)
    const boxes = (visible.match(/<(?:input|select|textarea)\b[^>]*\bname="/g) ?? []).length
    // Files now have a dedicated multipart workspace. Basic Info keeps a
    // direct management link instead of the former Server Action file box.
    const attachReady = visible.includes(`href="/ledger/${L36}/records/minute-book?q=Organization"`)
    const paperLinked = visible.includes(`href="/ledger/${'L'.repeat(36)}/records/minute-book/p1"`)
    const addLinks = RECORD_TABLES.filter((t) => screen.includes(`href="/ledger/${L36}/records/add/${t}"`))
    const profileLink = screen.includes(`href="/ledger/${L36}/records/profile"`)
    const ceaseButtons = (screen.match(/aria-label="Cease /g) ?? []).length

    // Alicio Xu is on this company's list; Dana Chen only on another's; Harbour
    // Newco on nobody's. One of each mark, and none for the local name.
    const rowsHtml = render({ what: 'rows', table: 'shares', readingId: 'R'.repeat(36),
      names: ['Alicio Xu', 'Dana Chen'], localNames: ['Alicio Xu'],
      rows: [
        { kind: 'issue', shareClass: 'Class A', onDate: '2020-01-15', to: 'Dana Chen', quantity: '100' },
        { kind: 'Transfer', shareClass: 'Class A', onDate: 'mid-2021', from: 'Alicio Xu', to: 'Harbour Newco Ltd.', quantity: '40' },
      ] })
    const missing = [0, 1].flatMap((i) => RECORD_COLUMNS.shares
      .filter((c) => !rowsHtml.includes(`name="${rowField(i, c.key)}"`)).map((c) => `row ${i + 1} ${c.key}`))
    const carries = rowsHtml.includes(`name="${RECORD_FIELDS.table}" value="shares"`)
      && rowsHtml.includes(`name="${RECORD_FIELDS.readingId}" value="${'R'.repeat(36)}"`)
    // The date the model could not read is in the NOTE under its row, and not
    // in the date box: `value="mid-2021"` would satisfy a plain includes() while
    // being the very defect (critic round 1).
    const note = rowsHtml.split('Read, but not put in a box')[1]?.split('</td>')[0] ?? ''
    // Two halves, each with its own words below: the note says what was read,
    // and the box was not handed it (critic round 2).
    const notedUnread = note.includes('mid-2021')
    const boxedUnread = rowsHtml.includes('value="mid-2021"')
    const saysUnread = notedUnread && !boxedUnread
    const marksNew = (rowsHtml.match(/data-new-name/g) ?? []).length
    const marksElsewhere = (rowsHtml.match(/data-elsewhere-name/g) ?? []).length
    check(boxes === 0 && addLinks.length === RECORD_TABLES.length && profileLink && ceaseButtons === 2
          && attachReady && paperLinked
          && missing.length === 0 && carries && saysUnread && marksNew === 1 && marksElsewhere === 1,
      'CR43 the records screen has no boxes at rest, and an add form submits every column of every row',
      `at rest ${boxes} box(es), ${addLinks.length}/${RECORD_TABLES.length} add links, profile link `
        + `${profileLink ? 'there' : 'MISSING'}, ${ceaseButtons} Cease button(s); the minute book `
        + `${paperLinked ? 'links its document' : 'does NOT link its document'} and `
        + `${attachReady ? 'links to document management' : 'has NO document-management link'}; the shares form `
        + `${missing.length ? `lacks ${missing.join(', ')}` : 'names every column of both rows'}, `
        + `${carries ? 'carries its table and reading' : 'does NOT carry its table and reading'}, `
        + `the date it could not read is ${notedUnread ? 'in the note' : 'NOT in the note'} and `
        + `${boxedUnread ? 'PUT IN THE DATE BOX' : 'not put in the date box'}, `
        + `${marksNew} name(s) marked new, ${marksElsewhere} marked as another company's`)
  }

  // ---------------------------------------------- putting a row right (0083) --
  //
  // The owner (2026-09-16): 「minute book不能修改編輯或者刪除欸。所有的紀錄儘量都可以
  // 編輯刪除」, and for the securities register, asked: editable and deletable,
  // keeping what it said. Every check below goes through the FORM readers the
  // screen's Edit and Delete post to, on a company of its own.
  const A = 'alicio@example.test'
  const fx = await createCompany({ code: 'FIX', name: 'Fixes Ltd.' }, A)
  const L2 = fx.ledger.id
  const E2 = fx.company.id
  const sam = await createParty({ kind: 'person', name: 'Sam Park', roles: [{ entityId: E2, role: 'director', heldFrom: '2020-01-01' }], actor: A })
  await setAddress({ partyId: sam.id, purpose: 'delivery', line1: '5 Sam St', city: 'Vancouver', region: 'BC' })
  const lee = await createParty({ kind: 'person', name: 'Lee Wong', roles: [{ entityId: E2, role: 'shareholder', heldFrom: '2020-01-01' }], actor: A })
  const kim = await createParty({ kind: 'person', name: 'Kim Ng', roles: [{ entityId: E2, role: 'shareholder', heldFrom: '2020-01-01' }], actor: A })
  const rowForm = (table: string, id: string, values: Record<string, string>) => {
    const fd = new FormData()
    fd.set(RECORD_FIELDS.ledgerId, L2); fd.set(RECORD_FIELDS.table, table); fd.set(RECORD_FIELDS.recordId, id)
    for (const [k, v] of Object.entries(values)) fd.set(rowField(0, k), v)
    return fd
  }
  type Trail = { action: string; actor: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
  const trail = (table: string, id: string) => db.execute<Trail>(raw`
    SELECT action, actor, before, after FROM audit_log
     WHERE table_name = ${table} AND record_id = ${id}
       AND action IN (${`change_${table}`}, ${`delete_${table}`}) AND actor = ${A}
     ORDER BY id`)
  const said = (x: { ok?: string; error?: string }) => (x.ok ?? x.error ?? '').slice(0, 90)

  // CR44 — A MINUTE-BOOK RECORD IS PUT RIGHT, OR TAKEN OUT, AND THE TRAIL KEEPS
  //        WHAT IT SAID. A typo'd title and the wrong kind are corrected from
  //        the row's boxes; boxes that are not a record are refused whole; the
  //        record is deleted; the audit log holds a change row with the old and
  //        new title and a delete row, both under the person.
  {
    const m = (await addMinuteBookEntry({ entityId: E2, recordKind: 'directors_resolution', onDate: '2021-05-01',
      title: 'Apointment of auditors', keptAt: 'Vol. 1', actor: A }))!
    const read = async () => (await db.execute<{ record_kind: string; on_date: string; title: string; kept_at: string; note: string | null }>(raw`
      SELECT record_kind, on_date::text, title, kept_at, note FROM minute_book_entry WHERE id = ${m}::uuid`))[0]
    const saved = await correctRowFromForm(rowForm('minute_book', m, {
      recordKind: 'shareholders_resolution', onDate: '2021-05-02', title: 'Appointment of auditors', keptAt: 'Vol. 2', note: 'signed copy' }), A)
    const after = await read()
    const refused = await correctRowFromForm(rowForm('minute_book', m, {
      recordKind: 'directors_resolution', onDate: 'soon', title: '', keptAt: 'Vol. 2', note: '' }), A)
    const untouched = await read()
    const removed = await removeRowFromForm(rowForm('minute_book', m, {}), A)
    const left = await read()
    const t = await trail('minute_book_entry', m)
    const rightNow = after?.record_kind === 'shareholders_resolution' && after.on_date === '2021-05-02'
      && after.title === 'Appointment of auditors' && after.kept_at === 'Vol. 2' && after.note === 'signed copy'
    const refusedWhole = refused.error?.includes('Title is missing.') === true && refused.error.includes('Date "soon" is not a date.')
      && untouched?.title === 'Appointment of auditors'
    const trailed = t.length === 2 && t[0].action === 'change_minute_book_entry' && t[0].before?.title === 'Apointment of auditors'
      && t[0].after?.title === 'Appointment of auditors' && t[1].action === 'delete_minute_book_entry' && t[1].after === null
    check(saved.ok !== undefined && rightNow && refusedWhole && removed.ok !== undefined && left === undefined && trailed,
      'CR44 a minute-book record is corrected or deleted from its row, and the trail keeps what it said',
      `saved: ${said(saved)} (${rightNow ? 'every box took' : 'NOT AS TYPED'}); bad boxes: ${said(refused)} `
        + `(${untouched?.title === 'Appointment of auditors' ? 'nothing changed' : 'CHANGED'}); deleted: ${said(removed)} `
        + `(${left === undefined ? 'gone' : 'STILL THERE'}); trail: ${t.map((x) => `${x.action} ${String(x.before?.title ?? '')}→${String(x.after?.title ?? '∅')}`).join(', ') || 'nothing under the person'}`)
  }

  // CR45 — AN OFFICE'S ADDRESSES STAY A CHAIN. Two registered addresses, the
  //        second typed with the wrong start: moving its start earlier ends the
  //        first the day before; a start before the first began is refused; a
  //        row cannot change office; moving it later lengthens the first again;
  //        deleting the second makes the first the current address once more.
  {
    await setOffice({ entityId: E2, office: 'registered', deliveryAddress: '1 First St', deliveryCity: 'Vancouver', effectiveFrom: '2020-01-15', actor: A })
    // Through `acting`, as every door is: ending the first address is a change the trail names a person for.
    await actingAs(A, (tx) => setOffice({ entityId: E2, office: 'registered', deliveryAddress: '2 Secnd St', deliveryCity: 'Vancouver', effectiveFrom: '2023-05-01', actor: A }, tx))
    const chain = async () => (await allOffices(E2)).filter((o) => o.office === 'registered')
      .map((o) => `${o.delivery_address} ${o.effective_from}→${o.effective_to ?? 'now'}`).join(' | ')
    const second = (await allOffices(E2)).find((o) => o.delivery_address === '2 Secnd St')!
    const box = (from: string, office = 'registered') => ({ office, deliveryAddress: '2 Second St', deliveryCity: 'Vancouver', deliveryPostal: '', effectiveFrom: from })
    await correctRowFromForm(rowForm('offices', second.id, box('2022-03-01')), A)
    const afterEarlier = await chain()
    const tooEarly = await correctRowFromForm(rowForm('offices', second.id, box('2019-06-01')), A)
    const otherOffice = await correctRowFromForm(rowForm('offices', second.id, box('2022-03-01', 'records')), A)
    const unmoved = await chain()
    const later = await correctRowFromForm(rowForm('offices', second.id, box('2024-01-01')), A)
    const afterLater = await chain()
    const removed = await removeRowFromForm(rowForm('offices', second.id, {}), A)
    const afterRemoved = await chain()
    check(afterEarlier === '2 Second St 2022-03-01→now | 1 First St 2020-01-15→2022-02-28'
          && tooEarly.error?.includes('began on 2020-01-15') === true && otherOffice.error?.includes('delete it and add it there') === true
          && unmoved === afterEarlier && later.ok !== undefined
          && afterLater === '2 Second St 2024-01-01→now | 1 First St 2020-01-15→2023-12-31'
          && removed.ok?.includes('current one again') === true && afterRemoved === '1 First St 2020-01-15→now',
      "CR45 an office's addresses stay a chain when one is moved, refused out of order, or deleted",
      `earlier: ${afterEarlier}; before the first: ${said(tooEarly)}; other office: ${said(otherOffice)}; `
        + `${unmoved === afterEarlier ? 'unchanged' : `CHANGED to ${unmoved}`}; later: ${afterLater}; deleted: ${said(removed)} → ${afterRemoved}`)
  }

  // CR46 — A DIRECTOR'S TERM IS PUT RIGHT. The start, the end and the frozen
  //        address are corrected; un-ceasing a term that would then run into
  //        the same person's later term is refused; the later term moved onto
  //        a new name with no address to borrow is refused whole — the new
  //        name is not left on the list — and with an address typed it goes,
  //        and says the name was added; the term is deleted.
  {
    const term = (await appointDirector({ entityId: E2, partyId: sam.id, appointedOn: '2021-01-01', actor: A }))!
    await actingAs(A, (tx) => ceaseDirector({ directorshipId: term, ceasedOn: '2022-01-01', actor: A }, tx))
    const later = (await appointDirector({ entityId: E2, partyId: sam.id, appointedOn: '2023-01-01', prescribedDelivery: '9 Later St', actor: A }))!
    const read = async (id: string) => (await db.execute<{ name: string; prescribed_delivery: string; appointed_on: string; ceased_on: string | null }>(raw`
      SELECT p.name, d.prescribed_delivery, d.appointed_on::text, d.ceased_on::text
        FROM directorship d JOIN party p ON p.id = d.party_id WHERE d.id = ${id}::uuid`))[0]
    const overlap = await correctRowFromForm(rowForm('directors', term, { name: 'Sam Park', address: '7 Typed St', appointedOn: '2021-02-01', ceasedOn: '' }), A)
    const fixed = await correctRowFromForm(rowForm('directors', term, { name: 'Sam Park', address: '7 Typed St', appointedOn: '2021-02-01', ceasedOn: '2022-06-30' }), A)
    const t = await read(term)
    const noAddress = await correctRowFromForm(rowForm('directors', later, { name: 'Robin Vale', address: '', appointedOn: '2023-01-01', ceasedOn: '' }), A)
    const [robinAfterRefusal] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM party WHERE name = 'Robin Vale'`)
    const moved = await correctRowFromForm(rowForm('directors', later, { name: 'Robin Vale', address: '3 Robin Rd, Victoria', appointedOn: '2023-01-01', ceasedOn: '' }), A)
    const l = await read(later)
    const removed = await removeRowFromForm(rowForm('directors', later, {}), A)
    const gone = await read(later)
    const tr = await trail('directorship', term)
    check(overlap.error?.includes('overlap another term') === true
          && fixed.ok !== undefined && t?.appointed_on === '2021-02-01' && t.ceased_on === '2022-06-30' && t.prescribed_delivery === '7 Typed St'
          && noAddress.error?.includes('Robin Vale has none on file') === true && robinAfterRefusal.n === 0
          && moved.ok?.includes("Added to this company's list: Robin Vale") === true && l?.name === 'Robin Vale'
          && l.prescribed_delivery === '3 Robin Rd, Victoria' && removed.ok !== undefined && gone === undefined
          // The end date is public on the directors register, so the trail
          // carries it both sides (0085) — a corrected end is not a blank row.
          && tr.some((x) => x.action === 'change_directorship' && x.before?.appointed_on === '2021-01-01' && x.after?.appointed_on === '2021-02-01'
                            && x.before?.ceased_on === '2022-01-01' && x.after?.ceased_on === '2022-06-30'),
      "CR46 a director's term is corrected, refused where it would overlap or lack an address, moved to a new name, and deleted",
      `un-ceased into the later term: ${said(overlap)}; fixed: ${t ? `${t.appointed_on}→${t.ceased_on} at ${t.prescribed_delivery}` : 'GONE'}; `
        + `new name, no address: ${said(noAddress)} (${robinAfterRefusal.n} Robin Vale left on the list); with one: ${said(moved)}; `
        + `deleted: ${gone === undefined ? 'gone' : 'STILL THERE'}; trail ${tr.map((x) => `${String(x.before?.ceased_on ?? '∅')}→${String(x.after?.ceased_on ?? '∅')}`).join(', ') || 'nothing'} under the person`)
  }

  // CR47 — A SIGNIFICANT INDIVIDUAL IS PUT RIGHT WITHOUT THE SCREEN SEEING THE
  //        PRIVATE FIELDS. Their boxes are sent blank, and blank keeps the
  //        birth date and the address on file; a typed address replaces it; a
  //        row without its start is refused; the trail carries none of the
  //        fields the register calls private; the row is deleted.
  {
    const si = (await recordSignificantIndividual({ entityId: E2, partyId: lee.id, becameOn: '2021-01-01',
      howControl: 'owner of 60%', birthDate: '1980-02-02', lastKnownAddress: '1 Secret Ln', actor: A }))!
    const read = async () => (await db.execute<{ how_control: string; became_on: string; ceased_on: string | null; birth_date: string | null; last_known_address: string | null }>(raw`
      SELECT how_control, became_on::text, ceased_on::text, birth_date::text, last_known_address FROM significant_individual WHERE id = ${si}::uuid`))[0]
    const box = (over: Record<string, string>) => ({ name: 'Lee Wong', howControl: 'owner of 65%', becameOn: '2021-01-02', ceasedOn: '2025-01-01', birthDate: '', lastKnownAddress: '', citizenOrPr: 'yes', taxResidentCa: 'yes', citizenships: '', ...over })
    const kept = await correctRowFromForm(rowForm('transparency', si, box({})), A)
    const k = await read()
    const replaced = await correctRowFromForm(rowForm('transparency', si, box({ lastKnownAddress: '2 New Ln' })), A)
    const rep = await read()
    const noSince = await correctRowFromForm(rowForm('transparency', si, box({ becameOn: '' })), A)
    const tr = await trail('significant_individual', si)
    const removed = await removeRowFromForm(rowForm('transparency', si, {}), A)
    const trAll = await trail('significant_individual', si)
    const PRIVATE = ['birth_date', 'last_known_address', 'how_control', 'became_on', 'citizenships', 'citizen_or_pr', 'tax_resident_ca']
    const leaked = trAll.flatMap((x) => [...Object.keys(x.before ?? {}), ...Object.keys(x.after ?? {})]).filter((f) => PRIVATE.includes(f))
    check(kept.ok !== undefined && k?.how_control === 'owner of 65%' && k.became_on === '2021-01-02' && k.ceased_on === '2025-01-01'
          && k.birth_date === '1980-02-02' && k.last_known_address === '1 Secret Ln'
          && replaced.ok !== undefined && rep?.last_known_address === '2 New Ln' && rep.birth_date === '1980-02-02'
          && noSince.error?.includes('Since is missing.') === true && tr.length === 2
          && removed.ok !== undefined && trAll.length === 3 && trAll[2].action === 'delete_significant_individual' && leaked.length === 0,
      'CR47 a significant individual is corrected with blank private boxes kept, and the trail carries no private field',
      `blank boxes: birth ${k?.birth_date}, address ${k?.last_known_address}; typed address: ${rep?.last_known_address}; `
        + `no start: ${said(noSince)}; deleted: ${said(removed)}; trail ${trAll.map((x) => x.action).join(', ')}`
        + (leaked.length ? `; LEAKED ${[...new Set(leaked)].join(', ')}` : '; no private field in it'))
  }

  // CR48 — THE SECURITIES REGISTER IS PUT RIGHT AND STILL NEVER GOES NEGATIVE.
  //        Lee is issued 100, transfers 40 to Kim, and Kim has 10 bought back.
  //        The issue corrected to 50 goes; to 30 it would leave Lee short on the
  //        day of the transfer and is refused; the transfer is corrected — date,
  //        count and certificates — on both its rows at once; it cannot be made
  //        an issue; the issue cannot be deleted from under the transfer; the
  //        cancellation, then the transfer (both rows), then the issue go; the
  //        trail keeps each change and each row removed, under the person.
  {
    const cls = (await createShareClass({ entityId: E2, name: 'Class A', actor: A }))!
    await issueShares({ shareClassId: cls, partyId: lee.id, onDate: '2021-01-01', quantity: 100n, details: 'Issued', actor: A })
    await transferShares({ shareClassId: cls, fromPartyId: lee.id, toPartyId: kim.id, onDate: '2022-01-01', quantity: 40n, details: 'Transfer', actor: A })
    await cancelShares({ shareClassId: cls, partyId: kim.id, onDate: '2023-01-01', quantity: 10n, details: 'Bought back', actor: A })
    const of = async (kind: string) => (await movementRows(E2)).find((m) => m.kind === kind)
    const issue = (await of('issue'))!
    const transfer = (await of('transfer'))!
    const cancel = (await of('cancellation'))!
    const held = async () => (await holdingsAsAt(E2, '2030-01-01')).map((h) => `${h.holder} ${h.holding}`).join(', ')
    const count = async () => (await db.execute<{ n: number }>(raw`
      SELECT count(*)::int AS n FROM share_transaction WHERE share_class_id = ${cls}::uuid`))[0].n
    const issueBox = (over: Record<string, string>) => ({ kind: 'issue', shareClass: 'Class A', onDate: '2021-01-01', from: '', to: 'Lee Wong',
      quantity: '100', consideration: '', certificateNo: '', surrenderedNo: '', balanceNo: '', details: 'Issued', ...over })
    const fewer = await correctRowFromForm(rowForm('shares', issue.id, issueBox({ quantity: '50', certificateNo: 'C-1' })), A)
    const afterFewer = await held()
    const tooFew = await correctRowFromForm(rowForm('shares', issue.id, issueBox({ quantity: '30' })), A)
    const afterTooFew = await held()
    const moved = await correctRowFromForm(rowForm('shares', transfer.id, { kind: 'transfer', shareClass: 'Class A', onDate: '2022-02-01',
      from: 'Lee Wong', to: 'Kim Ng', quantity: '45', consideration: '$2.00', certificateNo: 'C-2', surrenderedNo: 'C-1', balanceNo: 'C-3',
      details: 'Transfer agreement' }), A)
    const t2 = await of('transfer')
    const legs = await db.execute<{ kind: string; delta: string; on_date: string; certificate_no: string | null; surrendered_no: string | null }>(raw`
      SELECT kind, delta::text, on_date::text, certificate_no, surrendered_no FROM share_transaction
       WHERE transfer_group = (SELECT transfer_group FROM share_transaction WHERE id = ${transfer.id}::uuid) ORDER BY kind`)
    const legsRight = legs.length === 2
      && legs[0].kind === 'transfer_in' && legs[0].delta === '45' && legs[0].certificate_no === 'C-2' && legs[0].surrendered_no === null
      && legs[1].kind === 'transfer_out' && legs[1].delta === '-45' && legs[1].certificate_no === 'C-3' && legs[1].surrendered_no === 'C-1'
      && legs.every((x) => x.on_date === '2022-02-01')
    const afterMoved = await held()
    const asIssue = await correctRowFromForm(rowForm('shares', transfer.id, issueBox({})), A)
    const issueFirst = await removeRowFromForm(rowForm('shares', issue.id, {}), A)
    const stillFour = await count()
    const cancelGone = await removeRowFromForm(rowForm('shares', cancel.id, {}), A)
    const transferGone = await removeRowFromForm(rowForm('shares', transfer.id, {}), A)
    const issueGone = await removeRowFromForm(rowForm('shares', issue.id, {}), A)
    const left = await count()
    const [trailed] = await db.execute<{ changes: number; deletes: number }>(raw`
      SELECT count(*) FILTER (WHERE action = 'change_share_transaction')::int AS changes,
             count(*) FILTER (WHERE action = 'delete_share_transaction')::int AS deletes
        FROM audit_log WHERE table_name = 'share_transaction' AND actor = ${A}
         AND (before ->> 'share_class_id') = ${cls}`)
    check(fewer.ok !== undefined && afterFewer === 'Kim Ng 30, Lee Wong 10'
          && tooFew.error?.includes('SHARES_OVERDRAWN') === true && afterTooFew === afterFewer
          && moved.ok !== undefined && legsRight && t2?.from_name === 'Lee Wong' && t2.to_name === 'Kim Ng' && t2.balance_no === 'C-3'
          && afterMoved === 'Kim Ng 35, Lee Wong 5'
          && asIssue.error?.includes('This is a transfer') === true
          && issueFirst.error?.includes('SHARES_OVERDRAWN') === true && stillFour === 4
          && cancelGone.ok !== undefined && transferGone.ok?.includes('Both sides of the transfer went.') === true
          && issueGone.ok !== undefined && left === 0 && trailed.changes === 3 && trailed.deletes === 4,
      'CR48 a share movement is corrected or deleted, a transfer as one, and nobody is ever left holding less than nothing',
      `issue to 50: ${afterFewer}; to 30: ${said(tooFew)} (${afterTooFew === afterFewer ? 'unchanged' : `NOW ${afterTooFew}`}); `
        + `transfer corrected: ${legsRight ? 'both rows right' : `rows ${JSON.stringify(legs)}`}, ${afterMoved}; as an issue: ${said(asIssue)}; `
        + `issue deleted first: ${said(issueFirst)} (${stillFour} rows); then cancellation, transfer, issue: `
        + `${[cancelGone, transferGone, issueGone].map((x) => (x.ok ? 'gone' : said(x))).join(' / ')}, ${left} left; `
        + `trail ${trailed.changes} change row(s), ${trailed.deletes} removal row(s)`)
  }

  // CR49 — A SHARE CLASS IS RENAMED, AND DELETED ONLY WHILE EMPTY. A class with
  //        movements is refused and says how many; renaming takes; a name
  //        another class has is refused in words; an empty class goes.
  {
    const a = (await createShareClass({ entityId: E2, name: 'Common', actor: A }))!
    await issueShares({ shareClassId: a, partyId: kim.id, onDate: '2021-01-01', quantity: 5n, details: 'Issued', actor: A })
    const b = (await createShareClass({ entityId: E2, name: 'Preferred', actor: A }))!
    const classForm = (id: string, name = '', series = '') => {
      const fd = new FormData()
      fd.set(RECORD_FIELDS.ledgerId, L2); fd.set(RECORD_FIELDS.shareClassId, id)
      fd.set(RECORD_FIELDS.className, name); fd.set(RECORD_FIELDS.series, series)
      return fd
    }
    const inUse = await removeClassFromForm(classForm(a), A)
    const renamed = await renameClassFromForm(classForm(a, 'Class A Common', 'Series 1'), A)
    const taken = await renameClassFromForm(classForm(b, 'Class A Common', 'Series 1'), A)
    const emptyGone = await removeClassFromForm(classForm(b), A)
    const rows = (await shareClassRows(E2)).filter((c) => c.id === a || c.id === b)
    // The old name and the new, in the trail — `name` is private on other
    // registers and was stripped from this one's rows until 0085.
    const [renameTrail] = await db.execute<{ before: { name?: string }; after: { name?: string } }>(raw`
      SELECT before, after FROM audit_log WHERE action = 'change_share_class' AND record_id = ${a} AND actor = ${A} ORDER BY id LIMIT 1`)
    check(inUse.error?.includes('has 1 movement') === true && renamed.ok?.includes('Class A Common — Series 1') === true
          && taken.error?.includes('already has a class by that name') === true && emptyGone.ok !== undefined
          && rows.length === 1 && rows[0].name === 'Class A Common' && rows[0].series === 'Series 1' && rows[0].movements === 1
          && renameTrail?.before?.name === 'Common' && renameTrail.after?.name === 'Class A Common',
      'CR49 a share class is renamed, refused a name already taken, and deleted only while nothing is in it',
      `in use: ${said(inUse)}; renamed: ${said(renamed)}; taken: ${said(taken)}; empty: ${said(emptyGone)}; `
        + `left ${rows.map((c) => `${c.name} — ${c.series} (${c.movements})`).join(', ')}; `
        + `trail ${renameTrail ? `${renameTrail.before?.name ?? '∅'} → ${renameTrail.after?.name ?? '∅'}` : 'nothing'}`)
  }

  // CR50 — ANOTHER COMPANY'S ROW IS NOT OURS. Records Ltd.'s director, asked
  //        for under Fixes Ltd.'s ledger by the Edit and the Delete, is refused
  //        by name and left as it was.
  {
    const theirs = await correctRowFromForm(rowForm('directors', danaTerm, { name: 'Dana Chen', address: 'Anywhere', appointedOn: '2020-01-15', ceasedOn: '' }), A)
    const theirsGone = await removeRowFromForm(rowForm('directors', danaTerm, {}), A)
    const [still] = await db.execute<{ ceased_on: string | null }>(raw`SELECT ceased_on::text FROM directorship WHERE id = ${danaTerm}::uuid`)
    check(theirs.error === "That is not in this company's books." && theirsGone.error === "That is not in this company's books."
          && still?.ceased_on === '2024-06-30',
      "CR50 an Edit or Delete naming another company's row is refused and the row is untouched",
      `edit: ${said(theirs)}; delete: ${said(theirsGone)}; their term ${still ? `still ends ${still.ceased_on}` : 'GONE'}`)
  }

  // CR51 — EDIT OPENS THE ROW'S OWN BOXES, AND ONLY ON PRESS. At rest the
  //        screen offers one Edit per row and class and no box; a minute-book
  //        record opened names its table and row and holds what is on file,
  //        with Delete beside Save; a transfer opened carries its kind fixed and
  //        its balance certificate; a significant individual opened has blank
  //        private boxes that say blank keeps them.
  {
    const render = (input: unknown) => {
      try {
        return (JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-records.tsx', JSON.stringify(input)],
          { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
      } catch (e) { return `RENDER FAILED ${errorText(e).slice(0, 80)}` }
    }
    const data = {
      show: 'all', today: '2026-09-16', profile: null, isCcpc: null, companyTypes: [],
      offices: [{ id: 'o1', office: 'registered', delivery_address: '1 Main', delivery_city: 'Vancouver', delivery_postal: null, effective_from: '2020-01-15', effective_to: null }],
      directorships: [{ id: 'd1', name: 'Dana Chen', prescribed_delivery: '1 Main', appointed_on: '2020-01-15', ceased_on: null }],
      holdings: [], totals: [],
      sis: [{ id: 's1', name: 'Alicio Xu', how_control: 'owner of 100%', became_on: '2020-01-15', ceased_on: null, citizen_or_pr: false, citizenships: 'China', tax_resident_ca: true }],
      minuteBook: [{ id: 'm1', record_kind: 'directors_resolution', on_date: '2020-01-15', title: 'Organization', kept_at: 'Vol. 1', note: null }],
      ...EDITABLE,
    }
    const rest = render({ what: 'screen', data })
    const restBoxes = (rest.replace(/<dialog\b[\s\S]*?<\/dialog>/g, '').match(/<(?:input|select|textarea)\b[^>]*\bname="/g) ?? []).length
    const edits = (rest.match(/aria-label="Edit /g) ?? []).length
    const minute = render({ what: 'screen', data: { ...data, initialEditing: 'minute_book:m1' } })
    const minuteOpen = minute.includes(`name="${RECORD_FIELDS.recordId}" value="m1"`) && minute.includes(`name="${RECORD_FIELDS.table}" value="minute_book"`)
      && minute.includes(`name="${rowField(0, 'title')}" value="Organization"`) && minute.includes(`name="${rowField(0, 'keptAt')}" value="Vol. 1"`)
      && /<select[^>]*name="row\.0\.recordKind"/.test(minute) && />Delete</.test(minute) && />Save</.test(minute)
    const transfer = render({ what: 'screen', data: { ...data, initialEditing: 'shares:t1' } })
    const transferOpen = transfer.includes(`type="hidden" name="${rowField(0, 'kind')}" value="transfer"`)
      && transfer.includes(`name="${rowField(0, 'balanceNo')}" value="C-3"`) && transfer.includes('Both sides of the transfer go.')
    const person = render({ what: 'screen', data: { ...data, initialEditing: 'transparency:s1' } })
    const personOpen = person.includes(`name="${rowField(0, 'birthDate')}" value=""`) && person.includes(`name="${rowField(0, 'lastKnownAddress')}" value=""`)
      && person.includes('blank keeps what is on file')
    check(restBoxes === 0 && edits === 6 && minuteOpen && transferOpen && personOpen,
      "CR51 a row's Edit opens its own boxes on press, holding what is on file",
      `at rest ${restBoxes} box(es), ${edits} Edit button(s); minute book ${minuteOpen ? 'opens with its table, row and values' : 'does NOT open right'}; `
        + `transfer ${transferOpen ? 'keeps its kind and balance certificate' : 'does NOT'}; `
        + `significant individual ${personOpen ? 'has blank private boxes that say so' : 'does NOT'}`)
  }

  // Form-entered identity must survive edits and drive the report, with no default Yes.
  {
    const form = rowForm('transparency', '', { name: 'Identity Check', howControl: 'registered owner of 30%',
      becameOn: '2024-01-01', citizenOrPr: 'no', citizenships: 'China', taxResidentCa: 'no' })
    form.delete(RECORD_FIELDS.recordId)
    const added = await enterRowsFromForm(form, A)
    const [person] = await db.execute<{ id: string; citizen_or_pr: boolean; tax_resident_ca: boolean; citizenships: string }>(raw`
      SELECT s.id::text, s.citizen_or_pr, s.tax_resident_ca, s.citizenships FROM significant_individual s
        JOIN party p ON p.id = s.party_id WHERE s.entity_id = ${E2}::uuid AND p.name = 'Identity Check'`)
    const report = await renderRegister('transparency', E2, '2025-12-31', 'director')
    const cells = report.rows.find((row) => row[0] === 'Identity Check') ?? []
    check(added.ok !== undefined && person?.citizen_or_pr === false && person.tax_resident_ca === false
      && cells[report.columns.indexOf('Canadian citizen or PR')] === 'no'
      && cells[report.columns.indexOf('Resident in Canada for tax')] === 'no'
      && cells.includes('China'), 'CR53 Add saves explicit No flags and the report reads them', JSON.stringify(cells))
    const edit = await correctRowFromForm(rowForm('transparency', person.id, { name: 'Identity Check', howControl: 'registered owner of 30%',
      becameOn: '2024-01-01', citizenOrPr: 'yes', citizenships: '', taxResidentCa: 'yes' }), A)
    const after = await renderRegister('transparency', E2, '2025-12-31', 'director')
    const revised = after.rows.find((row) => row[0] === 'Identity Check') ?? []
    check(edit.ok !== undefined && revised[after.columns.indexOf('Canadian citizen or PR')] === 'yes'
      && revised[after.columns.indexOf('Resident in Canada for tax')] === 'yes', 'CR54 Edit updates both report flags', JSON.stringify(revised))
    form.set(rowField(0, 'name'), 'Missing Identity')
    form.delete(rowField(0, 'taxResidentCa'))
    const missing = await enterRowsFromForm(form, A)
    form.set(rowField(0, 'taxResidentCa'), 'no'); form.delete(rowField(0, 'citizenships'))
    const country = await enterRowsFromForm(form, A)
    check(missing.error?.includes('Canadian tax resident') === true && country.error?.includes('Citizenships is needed') === true,
      'CR55 missing identity and required citizenships are refused before writing', `${missing.error}; ${country.error}`)
  }

  // CSR address changes use the same Party record that reports and certificates read.
  {
    const home = await createCompany({ code: 'ADDR', name: 'Address Records Ltd.' }, A)
    const elsewhere = await createCompany({ code: 'ADRB', name: 'Other Address Ltd.' }, A)
    const localClass = await createShareClass({ entityId: home.company.id, name: 'Common', actor: A })
    const otherClass = await createShareClass({ entityId: elsewhere.company.id, name: 'Common', actor: A })
    const holder = await createParty({ kind: 'person', name: 'Address Holder', actor: A,
      roles: [{ entityId: home.company.id, role: 'shareholder', heldFrom: '2024-01-01' },
              { entityId: elsewhere.company.id, role: 'shareholder', heldFrom: '2024-01-01' }] })
    await issueShares({ shareClassId: localClass, partyId: holder.id, onDate: '2024-01-01', quantity: 10n, details: 'Issued', actor: A })
    await issueShares({ shareClassId: otherClass, partyId: holder.id, onDate: '2024-01-01', quantity: 10n, details: 'Issued', actor: A })
    const form = (partyId = holder.id, purpose = 'mailing', line1 = '10 First Street') => {
      const f = new FormData()
      for (const [key, value] of Object.entries({ [PF.ledgerId]: home.ledger.id, [PF.partyId]: partyId,
        [PF.purpose]: purpose, [PF.line1]: line1, [PF.line2]: 'Unit 4', [PF.city]: 'Vancouver',
        [PF.region]: 'BC', [PF.postalCode]: 'V6B 1A1', [PF.country]: 'CA' })) f.set(key, value)
      return f
    }
    const added = await setShareholderAddressFromForm(form(), A)
    // Mailing outranks delivery in the existing purpose table; editing must change what is displayed.
    await setAddress({ partyId: holder.id, purpose: 'delivery', line1: '99 Delivery Street' })
    const changed = await setShareholderAddressFromForm(form(holder.id, 'mailing', '20 Updated Street'), A)
    const preferred = (await shareholderAddresses(home.company.id)).find(a => a.party_id === holder.id)
    const register = await renderRegister('central_securities', home.company.id, '2024-12-31', 'director')
    const expected = '20 Updated Street, Unit 4, Vancouver, BC, V6B 1A1'
    const paper = await shareCertificate(home.ledger.id, localClass, holder.id, '2024-12-31')
    const otherRegister = await securitiesRegister(elsewhere.company.id, '2024-12-31')
    const [trail] = await db.execute<{ actor: string; scope: string; after: { purpose: string }; recorded: string }>(raw`
      SELECT actor, scope, after, (coalesce(before,'{}') || coalesce(after,'{}') || coalesce(context,'{}'))::text AS recorded
        FROM audit_log WHERE action='set_shareholder_address' AND record_id=${preferred!.id} ORDER BY id DESC LIMIT 1`)
    check(Boolean(added.ok && changed.ok) && preferred?.purpose === 'mailing' && preferred.line1 === '20 Updated Street'
      && register.rows.some(row => row.includes('Address Holder') && row.includes(expected))
      && paper?.facts.address === expected && pdfText(paper.buffer).replace(/\s/g, '').includes(expected.replace(/\s/g, ''))
      && otherRegister.find(h => h.party_id === holder.id)?.address === expected
      && trail?.actor === A && trail.scope === 'shared' && !trail.recorded.includes('Updated Street'),
      'CR56 CSR Add/Edit, report, certificate and shared companies use one preferred address with a named audit',
      `add=${added.ok ?? added.error}; edit=${changed.ok ?? changed.error}; address=${paper?.facts.address}; scope=${trail?.scope}`)

    const foreign = await createParty({ kind: 'person', name: 'Other Address Holder', actor: A,
      roles: [{ entityId: elsewhere.company.id, role: 'shareholder', heldFrom: '2024-01-01' }] })
    await issueShares({ shareClassId: otherClass, partyId: foreign.id, onDate: '2024-01-01', quantity: 1n, details: 'Issued', actor: A })
    const refused = await setShareholderAddressFromForm(form(foreign.id), A)
    const wrongPurpose = await setShareholderAddressFromForm(form(holder.id, 'delivery', 'Wrong Street'), A)
    const empty = await setShareholderAddressFromForm(form(holder.id, 'mailing', '   '), A)
    const badId = form(); badId.set(PF.partyId, 'not-an-id')
    const malformed = await setShareholderAddressFromForm(badId, A)
    const [untouched] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM party_address WHERE party_id=${foreign.id}::uuid`)
    check(refused.error?.includes('not in this company') === true && wrongPurpose.error?.includes('has changed') === true
      && empty.error?.includes('first line') === true && malformed.error?.includes('not in this company') === true
      && untouched.n === 0 && (await shareholderAddresses(home.company.id)).find(a => a.party_id === holder.id)?.line1 === '20 Updated Street',
      'CR57 CSR addresses refuse another company, the wrong purpose, blank streets and malformed identities without writes',
      [refused.error, wrongPurpose.error, empty.error, malformed.error].join(' | '))

    const legacy = await createParty({ kind: 'person', name: 'Legacy Delivery Holder', actor: A,
      roles: [{ entityId: home.company.id, role: 'shareholder', heldFrom: '2024-01-01' }] })
    await issueShares({ shareClassId: localClass, partyId: legacy.id, onDate: '2024-01-01', quantity: 5n, details: 'Issued', actor: A })
    await setAddress({ partyId: legacy.id, purpose: 'delivery', line1: '1 Legacy Lane' })
    const legacyEdit = await setShareholderAddressFromForm(form(legacy.id, 'delivery', '2 Legacy Lane'), A)
    await cancelShares({ shareClassId: localClass, partyId: holder.id, onDate: '2025-01-01', quantity: 10n, details: 'Cancelled', actor: A })
    const formerEdit = await setShareholderAddressFromForm(form(holder.id, 'mailing', '30 Current Street'), A)
    const data = await recordsScreenData(home.ledger.id)
    const html = (JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-records.tsx', JSON.stringify({ what: 'screen', data: { ...data, show: 'securities' } })],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const legacyAddress = (await shareholderAddresses(home.company.id)).find(a => a.party_id === legacy.id)
    check(Boolean(legacyEdit.ok && formerEdit.ok) && legacyAddress?.purpose === 'delivery' && legacyAddress.line1 === '2 Legacy Lane'
      && data?.holdings.find(h => h.party_id === holder.id)?.holding === '0'
      && data?.holdings.find(h => h.party_id === holder.id)?.address?.includes('30 Current Street') === true
      && html.includes('Edit address for Address Holder') && html.includes('Edit address for Legacy Delivery Holder')
      && html.includes('name="purpose" value="delivery"')
      && (html.match(/<input[^>]*name="line1"[^>]*>/g) ?? []).length === 2
      && (html.match(/<input[^>]*name="line1"[^>]*>/g) ?? []).every(input => input.includes('required=""'))
      && (html.match(/>Certificate<\/a>/g) ?? []).length === 1,
      'CR58 CSR editors prefill the displayed legacy address and remain available to former holders without zero-share certificates',
      `legacy=${legacyEdit.ok ?? legacyEdit.error}; former=${formerEdit.ok ?? formerEdit.error}; preferred=${legacyAddress?.purpose}`)
  }

  // CR52 — the audit triggers 0083 added to six record tables name whoever is
  //        acting; a door or a check that skipped `acting` writes the database
  //        role instead, and this is where that shows (acting.ts).
  await trailNamesPeople(check, 'CR52 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  fail('the suite threw before it finished', errorText(e).slice(0, 110))
  console.log(`\n=== ${r.failures} CHECK(S) FAILED ===`)
  await conn.end()
  process.exit(1)
})

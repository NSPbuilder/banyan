/**
 * Search: one box, everything the books know.
 *   npm run db:verify-search   (resets the database first)
 *
 * The failure that matters here is not "no results". It is a result from
 * ANOTHER COMPANY — this is the one screen whose job is to reach everywhere,
 * and companies never mixing is a frozen decision (`SR9`). After that: a
 * query that means one thing on the search page and another on the journal
 * page (`SR7`), and a number that only matches the way it was typed (`SR4`).
 */
import './env'
import { reporter } from './suite'
import { byHand } from './by-hand'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { postEntry, saveDraft } from '../src/lib/posting'
import { createInvoice, postInvoice } from '../src/lib/invoices'
import { addMinuteBookEntry, createShareClass, issueShares } from '../src/lib/records'
import { readQuery } from '../src/lib/query'
import { search } from '../src/lib/search'
import { journalEntries } from '../src/lib/reports'
import { parseMoney } from '../src/lib/money'

const r = reporter(58)
const { check } = r

/**
 * Both companies carry the SAME word in every section, and each carries a
 * marker of its own. That is what makes a leak visible: a hit belonging to
 * the other company arrives with the other company's marker on it, whatever
 * section it came from — including the two whose links carry no id to check.
 */
const NORTH = 'NORTHMARK'
const SOUTH = 'SOUTHMARK'
const chartFor = (marker: string) => `1000,Cash — Operating ${marker},asset,,cash_and_cash_equivalents
1200,Trade Receivables ${marker},asset,,trade_receivables
2000,Trade Payables ${marker},liability,,trade_payables
4000,Consulting Revenue ${marker},revenue,,revenue_from_contracts
5000,Stationery Supplies ${marker},expense,,`

async function main() {
  // TWO companies, sharing a word on purpose. Every check that matters here
  // is about the wall between them.
  const one = await createCompanyWithYear({ code: 'SRA', name: 'Northwind Books Ltd.' }, 'alicio@example.test')
  const two = await createCompanyWithYear({ code: 'SRB', name: 'Southwind Books Ltd.' }, 'alicio@example.test')
  const L = one.ledger.id
  const OTHER = two.ledger.id

  const accts = await importAccounts(one.company.id,
    parseAccountsCsv(chartFor(NORTH)).map((r) => ({ ...r, entityId: one.company.id })), 'alicio@example.test')
  const otherAccts = await importAccounts(two.company.id,
    parseAccountsCsv(chartFor(SOUTH)).map((r) => ({ ...r, entityId: two.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  const otherId = Object.fromEntries(otherAccts.map((a) => [a.code, a.id]))
  const yr = Number(one.year.endDate.slice(0, 4))

  const supplier = await createParty({
    kind: 'organisation', name: `Harbour Stationery ${NORTH}`,
    roles: [{ entityId: one.company.id, role: 'supplier', heldFrom: `${yr}-01-01` }],
    actor: 'alicio@example.test',
  })
  // The SAME word in the other company, so a leak has something to leak.
  const otherSupplier = await createParty({
    kind: 'organisation', name: `Harbour Stationery ${SOUTH}`,
    roles: [{ entityId: two.company.id, role: 'supplier', heldFrom: `${yr}-01-01` }],
    actor: 'alicio@example.test',
  })

  const posted = await postEntry({
    ledgerId: L, entryDate: `${yr}-03-14`, description: 'Toner and paper for the office',
    memo: 'ordered by phone', documentRef: 'HS-9912', actor: 'alicio@example.test',
    lines: [
      { accountId: id['5000'], amount: parseMoney('1498.00'), description: 'reams of paper' },
      { accountId: id['1000'], amount: -parseMoney('1498.00') },
    ],
  })
  // A second entry whose CENTS are the digits of the first one's dollars.
  await postEntry({
    ledgerId: L, entryDate: `${yr}-03-15`, description: 'Coffee for the meeting',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['5000'], amount: parseMoney('14.98') },
      { accountId: id['1000'], amount: -parseMoney('14.98') },
    ],
  })
  await saveDraft({
    ledgerId: L, entryDate: `${yr}-04-01`, description: 'Draft about stationery', actor: 'alicio@example.test',
    lines: [{ accountId: id['5000'], amount: parseMoney('5.00') }],
  })
  // The other company's own entry, using the same words.
  await postEntry({
    ledgerId: OTHER, entryDate: `${yr}-03-14`, description: `Toner and paper for the office ${SOUTH}`,
    actor: 'alicio@example.test',
    lines: [
      { accountId: otherId['5000'], amount: parseMoney('999.00') },
      { accountId: otherId['1000'], amount: -parseMoney('999.00') },
    ],
  })

  const bill = await createInvoice({
    ledgerId: L, direction: 'purchase', partyId: supplier.id,
    controlAccountId: id['2000'], issuedOn: `${yr}-03-20`, dueOn: `${yr}-04-20`,
    theirRef: 'HS-1042', note: `quarterly stationery order ${NORTH}`,
    lines: [{ accountId: id['5000'], amount: parseMoney('300.00') }], actor: 'alicio@example.test',
  })
  await postInvoice(bill.id, 'alicio@example.test')

  await byHand((tx) => tx.execute(raw`
    INSERT INTO bank_transaction (account_id, txn_date, amount, description, occurrence, source_file, imported_by)
    VALUES (${id['1000']}::uuid, ${`${yr}-03-14`}::date, ${-149800},
            ${`POS PURCHASE HARBOUR STATIONERY ${NORTH}`}, 1, 'march.csv', 'alicio@example.test')`))

  // And one of EVERY other kind over there too, each carrying the word this
  // suite searches for: five of the eight sections had nothing to leak
  // before, so five of them were being watched by nothing (critic,
  // 2026-09-03).
  const otherBill = await createInvoice({
    ledgerId: OTHER, direction: 'purchase', partyId: otherSupplier.id,
    controlAccountId: otherId['2000'], issuedOn: `${yr}-03-20`, dueOn: `${yr}-04-20`,
    theirRef: `HS-${SOUTH}`, note: `quarterly stationery order ${SOUTH}`,
    lines: [{ accountId: otherId['5000'], amount: parseMoney('50.00') }], actor: 'alicio@example.test',
  })
  await postInvoice(otherBill.id, 'alicio@example.test')
  await byHand((tx) => tx.execute(raw`
    INSERT INTO bank_transaction (account_id, txn_date, amount, description, occurrence, source_file, imported_by)
    VALUES (${otherId['1000']}::uuid, ${`${yr}-03-14`}::date, ${-99900},
            ${`POS PURCHASE HARBOUR STATIONERY ${SOUTH}`}, 1, 'march.csv', 'alicio@example.test')`))
  const otherClass = await createShareClass({
    entityId: two.company.id, name: `Common ${SOUTH}`, actor: 'alicio@example.test' })
  await issueShares({
    shareClassId: otherClass, partyId: otherSupplier.id, onDate: `${yr}-01-05`, quantity: 50n,
    details: `Incorporation ${SOUTH}`, certificateNo: `C-${SOUTH}`, actor: 'alicio@example.test' })
  await addMinuteBookEntry({
    entityId: two.company.id, recordKind: 'directors_resolution', onDate: `${yr}-02-02`,
    title: `Resolution approving the stationery contract ${SOUTH}`,
    keptAt: 'minute book vol. 1', actor: 'alicio@example.test' })

  const classA = await createShareClass({
    entityId: one.company.id, name: `Common ${NORTH}`, actor: 'alicio@example.test' })
  await issueShares({
    shareClassId: classA, partyId: supplier.id, onDate: `${yr}-01-05`, quantity: 100n,
    details: `Incorporation ${NORTH}`, consideration: 'cash at par',
    certificateNo: 'C-77', actor: 'alicio@example.test' })
  await addMinuteBookEntry({
    entityId: one.company.id, recordKind: 'directors_resolution', onDate: `${yr}-02-02`,
    title: `Resolution approving the stationery contract ${NORTH}`,
    keptAt: 'minute book vol. 1', actor: 'alicio@example.test' })
  await db.execute(raw`
    INSERT INTO attachment_blob (sha256, byte_size, mime, created_by)
    VALUES (${'a'.repeat(64)}, 12, 'application/pdf', 'alicio@example.test')
    ON CONFLICT DO NOTHING`)
  await db.execute(raw`
    INSERT INTO attachment (entry_id, sha256, filename, created_by)
    VALUES (${posted.entry.id}::uuid, ${'a'.repeat(64)},
            ${`harbour-invoice-scan-${NORTH}.pdf`}, 'alicio@example.test')`)
  await db.execute(raw`
    INSERT INTO attachment (entry_id, sha256, filename, created_by)
    VALUES ((SELECT id FROM journal_entry WHERE ledger_id = ${OTHER}::uuid LIMIT 1),
            ${'a'.repeat(64)}, ${`harbour-invoice-scan-${SOUTH}.pdf`}, 'alicio@example.test')`)

  const kindsOf = async (q: string, ledger = L) =>
    (await search(ledger, q)).hits.map((h) => `${h.kind}:${h.title}`)

  // SR1 — what a query MEANS is decided once, and it means several things.
  {
    const digits = readQuery('1498')
    const dotted = readQuery('14.98')
    const day = readQuery('2026-02-10')
    const word = readQuery('  toner  ')
    const percent = readQuery('50%')
    // A long reference is NOT an amount. Money is bigint; binding a value
    // wider than that into `abs(amount) IN (…)` takes the page down with an
    // out-of-range error instead of falling back to the text reading the
    // query already has (critic, 2026-09-03).
    const reference = readQuery('98765432109876543210')
    // GUARDED. Without the bound this query does not return a wrong answer,
    // it makes Postgres refuse the whole statement — and an unguarded call
    // here would kill the suite, which records no red line at all and reads
    // as a mutation that turned nothing red (the AT5/AT7/AT8 lesson).
    let huge: Awaited<ReturnType<typeof search>> = { query: reference, hits: [] }
    let refused = ''
    try {
      huge = await search(L, '98765432109876543210')
    } catch (e) {
      refused = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 80)
    }
    check(reference.cents.length === 0 && refused === '' && huge.hits.length === 0
          && digits.cents.map(String).join() === '149800,1498'
          && dotted.cents.map(String).join() === '1498'
          && day.date === '2026-02-10' && day.cents.length === 0
          && word.text === 'toner' && word.cents.length === 0 && word.date === null
          && percent.text === '50%',
      'SR1 a query is a word, and an amount, and sometimes a day',
      refused
        ? `a 20-digit reference took the query down: ${refused}`
        : `1498 -> [${digits.cents.join(', ')}]; 14.98 -> [${dotted.cents.join(', ')}];`
          + ` a 20-digit reference -> [${reference.cents.join(', ')}]`)
  }

  // SR2 — an entry answers to everything written on it.
  {
    const byWords = await kindsOf('toner')
    const byMemo = await kindsOf('by phone')
    const byRef = await kindsOf('HS-9912')
    const byNo = await kindsOf(posted.entry.entryNo!)
    const has = (hits: string[]) => hits.some((h) => h === 'Entry:Toner and paper for the office')
    check(has(byWords) && has(byMemo) && has(byRef) && has(byNo),
      'SR2 an entry answers to its words, its memo, its number and the paper it names',
      `words ${has(byWords)}, memo ${has(byMemo)}, doc ref ${has(byRef)}, entry no ${has(byNo)}`)
  }

  // SR3 — and to what is written on its LINES. A line is not a hit of its
  //       own: somebody searching for a figure wants the entry it is on.
  {
    const byLineWords = (await search(L, 'reams')).hits
    const entryHits = byLineWords.filter((h) => h.kind === 'Entry')
    // ONE hit, not one per matching line: a two-line entry that mentions the
    // word twice must not arrive twice. The first version asserted that no
    // hit had kind 'Line' — and no such kind exists, so that half of the
    // check could never fail (critic, 2026-09-03).
    check(entryHits.length === 1
          && entryHits[0].title === 'Toner and paper for the office'
          && new Set(entryHits.map((h) => h.href)).size === entryHits.length,
      'SR3 a line puts its own entry on the page, once',
      entryHits.map((h) => h.title).join(' | ') || 'nothing found')
  }

  // SR4 — THE number rule. 1498 is both $1,498.00 and $14.98, because money
  //       is integer cents and both readings are things a person meant.
  {
    const hits = await kindsOf('1498')
    const dollars = hits.includes('Entry:Toner and paper for the office')
    const cents = hits.includes('Entry:Coffee for the meeting')
    const dotted = await kindsOf('14.98')
    check(dollars && cents && dotted.includes('Entry:Coffee for the meeting')
          && !dotted.includes('Entry:Toner and paper for the office'),
      'SR4 a figure is found however the reader remembers it',
      `1498 finds ${dollars ? '$1,498.00' : '—'} and ${cents ? '$14.98' : '—'};`
      + ` 14.98 finds only the smaller one`)
  }

  // SR5 — every kind of thing the books hold is findable, and the drafts too.
  {
    const stationery = await kindsOf('stationery')
    const kinds = new Set((await search(L, 'harbour')).hits.map((h) => h.kind))
    // The CHART, by name and by code. Nothing in this suite searched an
    // account before, so that whole section could have returned the other
    // company's chart, or nothing at all, with every check still green
    // (critic, 2026-09-03).
    const byName = await kindsOf('Stationery Supplies')
    const byCode = await kindsOf('5000')
    check(kinds.has('Party') && kinds.has('Bank line') && kinds.has('Attachment')
          && stationery.some((h) => h.startsWith('Document:'))
          && stationery.some((h) => h.startsWith('Minute book:'))
          && stationery.some((h) => h === 'Entry:Draft about stationery')
          && byName.some((h) => h.startsWith('Account:5000'))
          && byCode.some((h) => h.startsWith('Account:5000')),
      'SR5 parties, accounts, bank lines, paper, documents, the minute book and drafts',
      `harbour -> ${[...kinds].join(', ')}; the chart answers to its name and its code`)
  }

  // SR6 — a day is a query. And SR6b: the share register answers too.
  {
    const onTheDay = await kindsOf(`${yr}-03-20`)
    const byCertificate = await kindsOf('C-77')
    check(onTheDay.some((h) => h.startsWith('Document:'))
          && byCertificate.some((h) => h.startsWith('Shares:')),
      'SR6 a date finds what happened on it, and a certificate finds its movement',
      `${onTheDay.length} on the day; certificate ${byCertificate.length}`)
  }

  // SR7 — ONE reader. The journal page and the search page ask the same
  //       question of the same rows; if they ever disagree, one of them is
  //       showing a reader something the other says does not match.
  {
    const q = readQuery('toner')
    // At the SAME limit. The two pages show different numbers of rows on
    // purpose — a search page shows a handful, a journal a hundred — so a
    // comparison at their defaults would be about page size, not about
    // matching (critic, 2026-09-03).
    const journal = (await journalEntries(L, { status: 'posted', q, limit: 500 }))
      .map((e) => e.id).sort()
    const searched = (await search(L, 'toner', 500)).hits
      .filter((h) => h.kind === 'Entry')
      .map((h) => h.href.replace('/entries/', '')).sort()
    check(journal.length > 0 && journal.join() === searched.join(),
      'SR7 the journal and the search agree on what matches',
      `${journal.length} entries both ways, at one limit`)
  }

  // SR8 — the range narrows the journal and says nothing about the search
  //       page, which has no range: two questions, and the answer to one of
  //       them must not quietly become the answer to the other.
  {
    const q = readQuery('toner')
    const inMarch = await journalEntries(L, { status: 'posted', q, from: `${yr}-03-01`, to: `${yr}-03-31` })
    const inApril = await journalEntries(L, { status: 'posted', q, from: `${yr}-04-01`, to: `${yr}-04-30` })
    // The search page takes no range at all — that is its signature, not
    // something a check could contradict, so it is said here rather than
    // asserted as though it were in doubt (critic, 2026-09-03).
    check(inMarch.length === 1 && inApril.length === 0,
      'SR8 the range narrows the journal',
      `march ${inMarch.length}, april ${inApril.length}`)
  }

  // SR9 — THE ONE. Both companies now hold one of EVERY kind, each carrying
  //       the word this search asks for and each carrying its own marker. A
  //       leak from any of the eight sections therefore arrives with the
  //       other company's marker written on it — including from the two
  //       whose links carry no id to check.
  //
  //       The first version filtered to entry hits before looking, and
  //       asserted `there.hits.length > 0` for the other company — which a
  //       leak makes MORE true, not false (critic, 2026-09-03).
  {
    const here = await search(L, 'stationery')
    const there = await search(OTHER, 'stationery')
    const marked = (hits: typeof here.hits, marker: string) =>
      hits.filter((h) => `${h.title} ${h.detail}`.includes(marker))
    const strayedNorth = marked(here.hits, SOUTH)
    const strayedSouth = marked(there.hits, NORTH)
    const ours = new Set((await db.execute<{ id: string }>(raw`
      SELECT id::text FROM journal_entry WHERE ledger_id = ${L}::uuid`)).map((r) => r.id))
    const strayedHref = here.hits.filter((h) => h.kind === 'Entry')
      .filter((h) => !ours.has(h.href.replace('/entries/', '')))
    const kindsHere = new Set(here.hits.map((h) => h.kind))
    const kindsThere = new Set(there.hits.map((h) => h.kind))
    check(kindsHere.size >= 6 && kindsThere.size >= 6
          && strayedNorth.length === 0 && strayedSouth.length === 0
          && strayedHref.length === 0,
      'SR9 a search never leaves the company it was asked in',
      strayedNorth.length + strayedSouth.length > 0
        ? `${strayedNorth.length + strayedSouth.length} hit(s) carry the other company's mark: `
          + [...strayedNorth, ...strayedSouth].slice(0, 3).map((h) => `${h.kind}:${h.title}`).join(' | ')
        : strayedHref.length > 0
          ? `${strayedHref.length} entry hit(s) belong to another ledger`
        : kindsHere.size < 6 || kindsThere.size < 6
          ? `only ${kindsHere.size} and ${kindsThere.size} kinds answered — too little to leak`
        : `${kindsHere.size} kinds each side, no mark crossed`)
  }

  // SR10 — a wildcard the reader typed is a character, not a wildcard. A
  //        search for "50%" that matched everything would be a search that
  //        answers a question nobody asked.
  {
    const percent = await search(L, '%')
    const underscore = await search(L, '_')
    check(percent.hits.length === 0 && underscore.hits.length === 0,
      'SR10 a percent sign is a percent sign',
      `% -> ${percent.hits.length} hits, _ -> ${underscore.hits.length} hits`)
  }

  // SR11 — the five kinds that were unfindable (whole-project audit,
  //        2026-09-13): a person on payroll, a pay run, an SR&ED project, a
  //        tax registration, a bill reading. Rows go in by hand — the doors
  //        are other suites' business; what is asked here is that the search
  //        reads the tables at all, ledger-scoped.
  {
    const worker = await createParty({ kind: 'person', name: 'Quimby Searchable',
      roles: [{ entityId: one.company.id, role: 'employee', heldFrom: '2026-01-01' }], actor: 'alicio@example.test' })
    await byHand((tx) => tx.execute(raw`
      INSERT INTO payroll_employee (entity_id, party_id, frequency, occupation, created_by)
      VALUES (${one.company.id}::uuid, ${worker.id}::uuid, 'semi_monthly', 'lighthouse keeper', 'alicio@example.test')`))
    await byHand((tx) => tx.execute(raw`
      INSERT INTO pay_run (ledger_id, pay_date, bank_account_id, created_by)
      VALUES (${L}::uuid, '2026-03-31', ${id['1000']}::uuid, 'alicio@example.test')`))
    await byHand((tx) => tx.execute(raw`
      INSERT INTO sred_project (entity_id, code, title, started_on, created_by)
      VALUES (${one.company.id}::uuid, 'QX-1', 'Quixotic solvent recovery', '2026-01-15', 'alicio@example.test')`))
    await byHand((tx) => tx.execute(raw`
      INSERT INTO entity_tax_registration (entity_id, tax, number, registered_on, created_by)
      VALUES (${one.company.id}::uuid, 'GST_HST', '724466638RT0001', '2026-01-01', 'alicio@example.test')`))
    await byHand((tx) => tx.execute(raw`
      INSERT INTO ai_bill_reading (ledger_id, read_by, filename, mime, bytes, sha256)
      VALUES (${L}::uuid, 'alicio@example.test', 'quayside-hydro-bill.pdf', 'application/pdf',
              '\\x00'::bytea, ${'b'.repeat(64)})`))
    const got = [
      ...(await kindsOf('Quimby')), ...(await kindsOf('2026-03-31')), ...(await kindsOf('Quixotic')),
      ...(await kindsOf('724466638')), ...(await kindsOf('quayside-hydro')),
    ]
    const has = (k: string, t: string) => got.some((g) => g.startsWith(`${k}:`) && g.includes(t))
    const elsewhere = [
      ...(await kindsOf('Quimby', OTHER)), ...(await kindsOf('Quixotic', OTHER)), ...(await kindsOf('quayside-hydro', OTHER)),
    ].filter((g) => /Employee|SR&ED|Reading/.test(g))
    check(has('Employee', 'Quimby') && has('Pay run', 'paid 2026-03-31') && has('SR&ED', 'Quixotic')
      && has('Registration', '724466638') && has('Reading', 'quayside-hydro-bill.pdf')
      && elsewhere.length === 0,
      'SR11 people, pay runs, SR&ED, registrations and readings are findable, in their own ledger only',
      `${got.length} hit(s): ${got.filter((g) => /Employee|Pay run|SR&ED|Registration|Reading/.test(g)).join('; ').slice(0, 140)}; `
        + `the other company sees ${elsewhere.length}`)
  }

  // SR11b — a reading from a sentence alone (0077) has no file name; its words
  //         find it and are its title, in its own ledger only.
  {
    await byHand((tx) => tx.execute(raw`
      INSERT INTO ai_bill_reading (ledger_id, read_by, sentence)
      VALUES (${L}::uuid, 'alicio@example.test', 'Moorage for the Harbour Belle, September')`))
    const got = (await kindsOf('Harbour Belle')).filter((g) => g.startsWith('Reading:'))
    const elsewhere = (await kindsOf('Harbour Belle', OTHER)).filter((g) => g.startsWith('Reading:'))
    check(got.length === 1 && got[0].includes('Moorage for the Harbour Belle') && elsewhere.length === 0,
      'SR11b a reading from a sentence alone is found by its words and titled by them, in its own ledger only',
      `${got.length} reading hit(s): ${got.join('; ').slice(0, 90)}; the other company sees ${elsewhere.length}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

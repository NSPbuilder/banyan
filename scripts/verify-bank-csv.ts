/**
 * Bank CSV: reading the file, profiling its columns, mapping them, and the
 * guards that stop a wrong mapping from becoming plausible data.
 *   npm run db:verify-bank
 *
 * No database. Everything under test is a pure function over text, which is why
 * it was written that way: the browser has to run it on a file the user picked,
 * and this has to run it on a fixture, and neither can be the only place it
 * works.
 *
 * The checks come in pairs wherever a pair means anything — one that the rule
 * holds, one that the rule can be broken. A check that only ever sees the good
 * case is an assumption with a PASS next to it.
 */
import {
  applyMapping, findHeaderRow, guessMapping, parseBankAmount, withRole,
  parseCsv, profileColumns, sniffDelimiter, validateMapping,
  type ColumnRole, type Mapping,
} from '../src/lib/bank-csv'
import { reporter } from './suite'
import {
  daysInMonth, inferDateOrder, ordersFitting, parseDateWith, readAs,
} from '../src/lib/dates'
import { execFileSync } from 'node:child_process'
import { csvFile } from '../src/lib/csv'

const r = reporter(52)
const { pass, fail, check } = r

function expectThrow(label: string, code: string, fn: () => unknown) {
  try {
    fn()
    fail(label, `expected ${code}, it returned normally`)
  } catch (e) {
    const err = e as { code?: string; message: string }
    err.code === code ? pass(label, `-> ${err.message}`)
                      : fail(label, `expected ${code}, got ${err.code ?? 'no code'}: ${err.message}`)
  }
}

const roles = (...r: ColumnRole[]): ColumnRole[] => r
const dateColumnOf = (m: Mapping) => m.roles.indexOf('date')
const mapping = (r: ColumnRole[], order: Mapping['order'], flip = false): Mapping =>
  ({ roles: r, order, flip })
const codes = (ps: Array<{ code: string }>) => ps.map((p) => p.code).sort().join(',')
const errorsOf = <T extends { level: string }>(ps: T[]) => ps.filter((p) => p.level === 'error')

// ---------------------------------------------------------------- fixtures --

/** RBC-shaped: no header row at all, month-first dates, one signed column. */
const RBC = [
  'Chequing,1234567,1/15/2024,,PAYMENT - THANK YOU,,-125.50',
  'Chequing,1234567,1/16/2024,,"DEPOSIT, PAYROLL",ACME LTD,3200.00',
  'Chequing,1234567,2/01/2024,,MONTHLY FEE,,-16.95',
].join('\n') + '\n'

/** Scotiabank-shaped: header row, ISO dates, withdrawals and deposits apart. */
const PAIRED = [
  'Date,Description,Withdrawals,Deposits,Balance',
  '2024-01-15,"PAYMENT, THANK YOU",125.50,,1874.50',
  '2024-01-16,PAYROLL,,3200.00,5074.50',
  '2024-01-17,HYDRO,88.20,,4986.30',
].join('\n') + '\n'

/** A preamble above the real header, which plenty of exports carry. */
const PREAMBLE = [
  'Account Number,1234567',
  'Statement Period,2024-01-01 to 2024-01-31',
  '',
  'Date,Description,Amount,Balance',
  '2024-01-15,PAYMENT,-125.50,1874.50',
  '2024-01-16,PAYROLL,3200.00,5074.50',
].join('\n') + '\n'

/** The amount column is not called Amount, and there is a Balance beside it. */
const UNNAMED_AMOUNT = [
  'Date,Details,Total,Balance',
  '2024-01-15,PAYMENT,-125.50,1874.50',
  '2024-01-16,PAYROLL,3200.00,5074.50',
].join('\n') + '\n'

/** Every day is 12 or less, so day-first and month-first both fit the file. */
const AMBIGUOUS = [
  'Date,Description,Amount',
  '01/02/2024,PAYMENT,-125.50',
  '03/04/2024,PAYROLL,3200.00',
].join('\n') + '\n'

/** A bank exports local timestamps, including times that cross a UTC day. */
const TIMESTAMPS = [
  'Time,Description,Amount',
  '2026-09-27T14:30:03-0400,OFFICE SUPPLIES,-25.00',
  '2026-09-27T23:50:00-0400,LATE DEPOSIT,50.00',
  '2026-09-28T00:10:00+1400,EARLY PAYMENT,-10.00',
].join('\n') + '\n'

function main() {
  try {
    body()
  } catch (e) {
    // The whole point of this file is to report on a broken program. Dying
    // because the program is broken is the one thing it must not do — the
    // harness reads the summary line to tell a complete run from a truncated
    // one, and a suite that never prints one is recorded as neither.
    fail('the suite threw before it finished', String((e as Error).message).slice(0, 110))
  }
  console.log(r.summary())
  process.exit(r.failures === 0 ? 0 : 1)
}

function body() {
  // ------------------------------------------------------------- parseCsv --

  {
    const g = parseCsv('a,"b,c",d\n', ',')
    check(g.length === 1 && g[0]?.length === 3 && g[0]?.[1] === 'b,c',
      'B01 a quoted comma stays inside one cell', JSON.stringify(g[0]))

    // The discriminating half: not "a splitter would give 4" — that is a fact
    // about String.split and holds whatever parseCsv does — but that parseCsv
    // and a splitter DISAGREE on this text. Replace parseCsv with a splitter and
    // this fails; the constant version could not.
    const naive = 'a,"b,c",d'.split(',')
    check(naive.length === 4 && g[0]?.length !== naive.length,
      'B02 and a line splitter disagrees with it here',
      `parser=${g[0]?.length}, splitter=${naive.length}`)
  }

  {
    const g = parseCsv('a,"line one\nline two",c\nd,e,f\n', ',')
    check(g.length === 2, 'B03 a newline inside quotes does not end the row', `rows=${g.length}`)
    check(g[0]?.[1] === 'line one\nline two', 'B04 and the newline is kept in the cell',
      JSON.stringify(g[0]?.[1]))
  }

  {
    const g = parseCsv('a,"say ""hi""",c', ',')
    check(g[0]?.[1] === 'say "hi"', 'B05 a doubled quote becomes one quote', g[0]?.[1] ?? '(no cell)')
  }

  {
    const withNewline = parseCsv('a,b\nc,d\n', ',')
    const without = parseCsv('a,b\nc,d', ',')
    check(withNewline.length === 2, 'B06 a trailing newline adds no phantom row', `rows=${withNewline.length}`)
    check(without.length === 2, 'B07 a missing trailing newline loses no row', `rows=${without.length}`)
  }

  {
    const g = parseCsv('﻿Date,Amount\n2024-01-01,5.00\n', ',')
    check(g[0]?.[0] === 'Date', 'B08 a byte-order mark is stripped', JSON.stringify(g[0]?.[0]))
  }

  // ------------------------------------------------------- sniffDelimiter --

  check(sniffDelimiter(PAIRED) === ',', 'B09 a comma file sniffs as comma')
  check(sniffDelimiter(PAIRED.replace(/,/g, '\t')) === '\t', 'B10 a tab file sniffs as tab')
  check(sniffDelimiter(PAIRED.replace(/,/g, ';')) === ';', 'B11 a semicolon file sniffs as semicolon')

  {
    // The discriminating case: semicolons inside the text of a comma file.
    const tricky = [
      'Date,Description,Amount',
      '2024-01-15,"PAID; THEN REFUNDED; NET",−0.00'.replace('−', '-'),
      '2024-01-16,"A; B; C; D",10.00',
    ].join('\n')
    check(sniffDelimiter(tricky) === ',',
      'B12 semicolons inside a comma file do not win', sniffDelimiter(tricky))
  }

  // -------------------------------------------------------- findHeaderRow --

  {
    const g = parseCsv(PAIRED, ',')
    check(findHeaderRow(g) === 0, 'B13 a plain header is row 0', String(findHeaderRow(g)))
  }
  {
    const g = parseCsv(PREAMBLE, ',')
    check(findHeaderRow(g) === 3, 'B14 a header under a preamble is found', String(findHeaderRow(g)))
  }
  {
    const g = parseCsv(RBC, ',')
    check(findHeaderRow(g) === null, 'B15 a headerless file reports no header', String(findHeaderRow(g)))

    // And the first row is treated as data, not as names — the discriminating
    // half: reporting "no header" while still eating row 1 would pass B15.
    // `header === ''` is vacuous when headerRow is null — profileColumns builds
    // it that way. What is not vacuous: the FIRST row's values are among the
    // samples. Take row 1 for a header and both of these change.
    const p = profileColumns(g, null)
    const rowsSeen = p[0]?.filled
    check(p[2]?.samples[0] === '1/15/2024' && rowsSeen === 3,
      'B16 and its first row is kept as data, not eaten as names',
      `first sample=${p[2]?.samples[0]}, filled=${rowsSeen}`)
  }

  // ------------------------------------------------------------ date order --

  check(inferDateOrder(['2024-03-04']).kind === 'certain', 'B17 an ISO date is certain')
  {
    const v = inferDateOrder(['15/01/2024', '02/02/2024'])
    check(v.kind === 'certain' && v.order === 'dmy', 'B18 a 15 in front forces day-first',
      v.kind === 'certain' ? v.because : v.because)
  }
  {
    const v = inferDateOrder(['01/15/2024', '02/02/2024'])
    check(v.kind === 'certain' && v.order === 'mdy', 'B19 a 15 in second place forces month-first',
      v.because)
  }

  {
    const v = inferDateOrder(['01/02/2024', '03/04/2024'])
    check(v.kind === 'ambiguous' && v.orders.length === 2,
      'B20 all-small days stay ambiguous', v.because)

    // The discriminating half of B20: the verdict has to SHOW two different
    // days for the same cell. A message that says "ambiguous" while both
    // readings landed on the same date would be describing nothing.
    if (v.kind === 'ambiguous') {
      const readings = v.orders.map((o) => parseDateWith('01/02/2024', o))
      // A statement about the fixture, not about the code: it establishes that
      // B20's ambiguity is worth reporting at all. Not a discriminating half.
      check(new Set(readings).size === v.orders.length,
        'B21 (fixture) the two readings are different days', readings.join(' vs '))
      // No `|| because.includes('formats')` escape hatch: the message always
      // contains the word "formats", so that disjunct made this check incapable
      // of failing — the exact shape this suite is meant to catch elsewhere.
      check(v.orders.every((o) => v.because.includes(parseDateWith('01/02/2024', o))),
        'B22 and the message shows both readings', v.because)
    } else {
      // Its OWN id, not B21's and not B22's.
      //
      // This branch means the verdict was not ambiguous at all, so neither
      // reading nor message exists to judge — B21 and B22 did not run. Printing
      // them here under their own labels was worse than the shortened labels it
      // replaced: a mutation that only breaks the enclosing condition reddens
      // the label of an assertion nothing evaluated, and the coverage count
      // then records those assertions as having been made to fail.
      //
      // One id per claim. A precondition is a different claim.
      fail('B20a (guard) the verdict is ambiguous, so B21 and B22 can be judged',
        `kind was ${v.kind}`)
    }
  }

  {
    const v = inferDateOrder(['13/01/2024', '01/13/2024'])
    check(v.kind === 'conflict', 'B23 a column mixing both formats is a conflict', v.because)
    check(v.because.includes('13/01/2024') && v.because.includes('01/13/2024'),
      'B24 and the conflict names both offending cells', v.because)
  }

  check(readAs('31/02/2024', 'dmy') === null, 'B25 31 February is refused, not rolled forward')
  check(readAs('29/02/2024', 'dmy') !== null, 'B26 29 February 2024 is a real day')
  check(readAs('29/02/2023', 'dmy') === null, 'B27 29 February 2023 is not')
  check(daysInMonth(2100, 2) === 28, 'B28 2100 is not a leap year', String(daysInMonth(2100, 2)))

  {
    const a = inferDateOrder(['Jan 15, 2024'])
    const b = inferDateOrder(['15-Jan-2024'])
    check(a.kind === 'certain' && a.order === 'mdy', 'B29 "Jan 15, 2024" is month-first', a.because)
    check(b.kind === 'certain' && b.order === 'dmy', 'B30 "15-Jan-2024" is day-first', b.because)
  }

  check(parseDateWith('01/02/24', 'dmy') === '2024-02-01', 'B31 a two-digit year reads as 20xx',
    parseDateWith('01/02/24', 'dmy'))
  expectThrow('B32 the wrong order is refused, not coerced', 'BAD_DATE',
    () => parseDateWith('15/01/2024', 'mdy'))
  check(ordersFitting('not a date').length === 0, 'B33 text is not a date in any order')

  {
    const samples = [
      '2026-09-27T14:30:03-0400', '2026-09-27T14:30:03-04:00',
      '2026-09-27T14:30:03Z', '2026-09-27 14:30:03.123+00:00', '2026-09-27T14:30',
    ]
    check(samples.every(s => parseDateWith(s, 'ymd') === '2026-09-27'
          && ordersFitting(s).join(',') === 'ymd'),
      'B93 bank timestamps read as year-first dates with compact or colon offsets, Z and fractional seconds')
    check(parseDateWith('2026-09-27T23:50:00-0400', 'ymd') === '2026-09-27'
          && parseDateWith('2026-09-28T00:10:00+1400', 'ymd') === '2026-09-28',
      'B94 timestamps keep the bank calendar day at both UTC date boundaries')
    const bad = [
      '2026-02-30T14:30:03-0400', '2023-02-29T14:30:03Z',
      '2026-09-27T24:30:03-0400', '2026-09-27T14:60:03-0400', '2026-09-27T14:30:60-0400',
      '2026-09-27T14:30:03-2400', '2026-09-27T14:30:03-0460',
      '2026-09-27T14:30:03-0400junk', '14:30:03-0400',
    ]
    check(bad.every(s => ordersFitting(s).length === 0),
      'B95 invalid calendar days, clocks, offsets, trailing junk and time-only values remain refused')
    expectThrow('B96 a timestamp cannot be reinterpreted as day-first', 'BAD_DATE',
      () => parseDateWith(samples[0], 'dmy'))

    const grid = parseCsv(TIMESTAMPS, ',')
    const headerRow = findHeaderRow(grid)
    const profiles = profileColumns(grid, headerRow)
    const guessed = guessMapping(profiles)
    check(headerRow === 0 && profiles[0].shape === 'date'
          && guessed.roles.join(',') === 'date,description,amount',
      'B97 a Time column is recognised as the bank date through the full CSV mapping', guessed.roles.join(','))
    const applied = applyMapping(grid, headerRow, { ...guessed, order: 'ymd' })
    check(applied.problems.length === 0 && applied.rows.length === 3
          && applied.rows.map(r => r.date).join(',') === '2026-09-27,2026-09-27,2026-09-28'
          && applied.rows[0].amount === -2500n && applied.rows[1].amount === 5000n,
      'B98 timestamp imports retain local dates and original money directions', applied.rows.map(r => r.date).join(','))
    const invalid = TIMESTAMPS.replace('14:30:03-0400', '14:75:03-0400')
    const refused = applyMapping(parseCsv(invalid, ','), 0, { ...guessed, order: 'ymd' })
    check(refused.problems.some(p => p.code === 'BAD_DATE' && p.row === 2)
          && !refused.rows.some(r => r.description === 'OFFICE SUPPLIES'),
      'B99 a bad timestamp is reported on its own CSV row rather than silently stripped to a date')
  }

  // --------------------------------------------------------------- amount --

  check(parseBankAmount('(1,234.56)') === -123456n, 'B34 accounting brackets are negative',
    String(parseBankAmount('(1,234.56)')))
  check(parseBankAmount('1234.56-') === -123456n, 'B35 a trailing minus is negative',
    String(parseBankAmount('1234.56-')))
  check(parseBankAmount('$1,234.56') === 123456n, 'B36 a dollar sign and commas are ignored',
    String(parseBankAmount('$1,234.56')))
  check(parseBankAmount('  ') === null, 'B37 a blank cell is no amount, not zero',
    String(parseBankAmount('  ')))
  expectThrow('B38 a non-amount is refused', 'BAD_AMOUNT', () => parseBankAmount('n/a'))

  // ----------------------------------------------------------- guessing --

  {
    const g = parseCsv(PAIRED, ',')
    const p = profileColumns(g, 0)
    const m = guessMapping(p)
    check(m.roles.join(',') === 'date,description,out,in,ignore',
      'B39 headers named Withdrawals and Deposits are read as a pair', m.roles.join(','))

    // The pair that matters after this round's change. First prove the column
    // is unambiguous — exactly one reading fits it — then prove the guess still
    // refuses to make the choice on the user's behalf.
    check(p[0].dates.kind === 'certain', 'B40 this column admits exactly one reading',
      p[0].dates.because)
    check(m.order === null, 'B40b and the format is still left for the user to choose',
      String(m.order))
  }

  {
    const g = parseCsv(PREAMBLE, ',')
    const p = profileColumns(g, 3)
    const m = guessMapping(p)
    check(m.roles.join(',') === 'date,description,amount,ignore',
      'B41 a single Amount column is guessed as signed', m.roles.join(','))
  }

  {
    // Discriminating half: a running balance is numeric and fits "amount"
    // perfectly. Here the real amount column is called Total, so no header hint
    // matches it and the guess falls through to shape — where the balance would
    // be a second candidate and stop the guess dead, if it were not excluded.
    const m = guessMapping(profileColumns(parseCsv(UNNAMED_AMOUNT, ','), 0))
    check(m.roles.join(',') === 'date,description,amount,ignore',
      'B42 a Balance column does not stop the amount being found', m.roles.join(','))
  }

  {
    const g = parseCsv(AMBIGUOUS, ',')
    const m = guessMapping(profileColumns(g, 0))
    check(m.order === null, 'B43 an ambiguous date column leaves the format unset too', String(m.order))
  }

  // ------------------------------------------------------------- validate --

  {
    const p = profileColumns(parseCsv(PREAMBLE, ','), 3)
    const good = mapping(roles('date', 'description', 'amount', 'ignore'), 'ymd')
    check(errorsOf(validateMapping(p, good)).length === 0,
      'B44 a sound mapping raises nothing', codes(validateMapping(p, good)))

    const seen: string[] = []
    const broken: Array<[string, Mapping]> = [
      ['NO_DATE', mapping(roles('ignore', 'description', 'amount', 'ignore'), 'ymd')],
      ['TWO_DATES', mapping(roles('date', 'date', 'amount', 'ignore'), 'ymd')],
      ['NO_AMOUNT', mapping(roles('date', 'description', 'ignore', 'ignore'), 'ymd')],
      ['TWO_AMOUNTS', mapping(roles('date', 'amount', 'amount', 'ignore'), 'ymd')],
      ['AMOUNT_AND_PAIR', mapping(roles('date', 'out', 'amount', 'ignore'), 'ymd')],
      ['TWO_OUT', mapping(roles('date', 'out', 'out', 'ignore'), 'ymd')],
      ['TWO_IN', mapping(roles('date', 'in', 'in', 'ignore'), 'ymd')],
      ['NOT_DATES', mapping(roles('description', 'date', 'amount', 'ignore'), 'ymd')],
      ['ORDER_IMPOSSIBLE', mapping(roles('date', 'description', 'amount', 'ignore'), 'mdy')],
    ]
    for (const [want, m] of broken) {
      const found = errorsOf(validateMapping(p, m))
      const hit = found.find((f) => f.code === want)
      check(!!hit, `B45 ${want} is caught`, hit?.message.slice(0, 76) ?? `got ${codes(found)}`)
      if (hit) seen.push(hit.message)
    }

    // The rule this repository keeps relearning: two guards that answer with
    // the same sentence are one guard, and no test over either can tell.
    check(new Set(seen).size === seen.length,
      'B46 and no two rejections say the same thing', `${new Set(seen).size} distinct of ${seen.length}`)

    const noDesc = mapping(roles('date', 'ignore', 'amount', 'ignore'), 'ymd')
    const ps = validateMapping(p, noDesc)
    check(errorsOf(ps).length === 0 && ps.some((x) => x.code === 'NO_DESCRIPTION'),
      'B47 a missing description warns without blocking', codes(ps))
  }

  {
    // The one that matters most: an ambiguous file cannot proceed unanswered.
    const p = profileColumns(parseCsv(AMBIGUOUS, ','), 0)
    const unset = mapping(roles('date', 'description', 'amount'), null)
    const found = errorsOf(validateMapping(p, unset))
    check(found.some((f) => f.code === 'ORDER_UNSET'),
      'B48 an ambiguous date column blocks until it is answered',
      found[0]?.message.slice(0, 84) ?? codes(found))

    // Its pair: once answered, nothing is left standing in the way.
    const answered = mapping(roles('date', 'description', 'amount'), 'dmy')
    check(errorsOf(validateMapping(p, answered)).length === 0,
      'B49 and answering it clears the way', codes(validateMapping(p, answered)))

    // And an answer the column cannot support is refused rather than accepted.
    const p2 = profileColumns(parseCsv(PAIRED, ','), 0)
    const wrong = mapping(roles('date', 'description', 'out', 'in', 'ignore'), 'dmy')
    check(errorsOf(validateMapping(p2, wrong)).some((f) => f.code === 'ORDER_IMPOSSIBLE'),
      'B50 an impossible format is refused', codes(validateMapping(p2, wrong)))
  }

  // ---------------------------------------------------------------- apply --

  {
    const g = parseCsv(PREAMBLE, ',')
    const m = mapping(roles('date', 'description', 'amount', 'ignore'), 'ymd')
    const { rows, problems } = applyMapping(g, 3, m)
    check(rows.length === 2 && problems.length === 0, 'B51 a signed file reads cleanly',
      `${rows.length} rows, ${problems.length} problems`)
    check(rows[0]?.date === '2024-01-15' && rows[0]?.amount === -12550n,
      'B52 and the sign is kept as the file wrote it', String(rows[0]?.amount))

    const flipped = applyMapping(g, 3, mapping(m.roles, 'ymd', true))
    check(flipped.rows[0]?.amount === 12550n, 'B53 and the flip really flips it',
      String(flipped.rows[0]?.amount))
  }

  {
    const g = parseCsv(PAIRED, ',')
    const m = mapping(roles('date', 'description', 'out', 'in', 'ignore'), 'ymd')
    const { rows, problems } = applyMapping(g, 0, m)
    check(rows.length === 3 && problems.length === 0, 'B54 a split file reads cleanly',
      `${rows.length} rows, ${problems.length} problems`)
    check(rows[0]?.amount === -12550n && rows[1]?.amount === 320000n,
      'B55 money out is negative and money in is positive',
      `${rows[0]?.amount} / ${rows[1]?.amount}`)
    check(rows[0]?.description === 'PAYMENT, THANK YOU',
      'B56 and the comma inside the description survived', rows[0]?.description ?? '(no row)')
  }

  {
    const both = [
      'Date,Description,Withdrawals,Deposits',
      '2024-01-15,ODD,10.00,20.00',
    ].join('\n')
    const r = applyMapping(parseCsv(both, ','), 0, mapping(roles('date', 'description', 'out', 'in'), 'ymd'))
    check(r.problems.some((x) => x.code === 'BOTH_SIDES'), 'B57 money out and in on one row is refused',
      r.problems[0]?.message.slice(0, 76))

    const neg = [
      'Date,Description,Withdrawals,Deposits',
      '2024-01-15,ODD,-10.00,',
    ].join('\n')
    const r2 = applyMapping(parseCsv(neg, ','), 0, mapping(roles('date', 'description', 'out', 'in'), 'ymd'))
    check(r2.problems.some((x) => x.code === 'NEGATIVE_IN_PAIR'),
      'B58 a signed number in a paired column is refused', r2.problems[0]?.message.slice(0, 76))
  }

  {
    const footer = [
      'Date,Description,Amount',
      '2024-01-15,PAYMENT,-125.50',
      'Total,-125.50',
    ].join('\n')
    const g = parseCsv(footer, ',')
    const r = applyMapping(g, 0, mapping(roles('date', 'description', 'amount'), 'ymd'))
    check(r.rows.length === 1 && r.problems.some((x) => x.code === 'SHORT_ROW'),
      'B59 a narrow total line is reported, not read', r.problems[0]?.message.slice(0, 76))
  }

  {
    const bad = [
      'Date,Description,Amount',
      '2024-01-15,GOOD,-125.50',
      'not a date,BAD,-1.00',
    ].join('\n')
    const r = applyMapping(parseCsv(bad, ','), 0, mapping(roles('date', 'description', 'amount'), 'ymd'))
    check(r.rows.length === 1 && r.problems.some((x) => x.code === 'BAD_DATE' && x.row === 3),
      'B60 a bad date is reported against its own row', r.problems[0]?.message.slice(0, 76))
  }

  expectThrow('B61 applying with no date format chosen throws', 'ORDER_UNSET',
    () => applyMapping(parseCsv(AMBIGUOUS, ','), 0, mapping(roles('date', 'description', 'amount'), null)))

  {
    // Row numbers are grid rows, and the code says so rather than claiming a
    // file line it cannot know: this cell spans two lines of the file.
    const wrapped = 'Date,Description,Amount\n2024-01-15,"ONE\nTWO",-1.00\n2024-01-16,NEXT,-2.00\n'
    const r = applyMapping(parseCsv(wrapped, ','), 0, mapping(roles('date', 'description', 'amount'), 'ymd'))
    check(r.rows[1]?.row === 3, 'B62 the reported row is the grid row, not the file line',
      `row=${r.rows[1]?.row}, file line would be 4`)
  }

  {
    const many = [
      'Date,Detail,Memo,Amount',
      '2024-01-15,VISA PURCHASE,COFFEE SHOP,-4.75',
    ].join('\n')
    const r = applyMapping(parseCsv(many, ','), 0,
      mapping(roles('date', 'description', 'description', 'amount'), 'ymd'))
    check(r.rows[0]?.description === 'VISA PURCHASE — COFFEE SHOP',
      'B63 two description columns are joined', r.rows[0]?.description ?? '(no row)')
  }

  {
    const gaps = 'Date,Description,Amount\n\n2024-01-15,PAYMENT,-1.00\n\n\n'
    const r = applyMapping(parseCsv(gaps, ','), 0, mapping(roles('date', 'description', 'amount'), 'ymd'))
    check(r.rows.length === 1 && r.problems.length === 0, 'B64 blank rows are skipped in silence',
      `${r.rows.length} rows, ${r.problems.length} problems`)
  }

  // ---------------------------------------------------------- end to end --

  {
    const text = RBC
    const delimiter = sniffDelimiter(text)
    const grid = parseCsv(text, delimiter)
    const headerRow = findHeaderRow(grid)
    const profiles = profileColumns(grid, headerRow)
    const m = guessMapping(profiles)

    check(headerRow === null && m.order === null,
      'B69 a headerless file is read end to end, format still unchosen', `order=${m.order}`)

    // The column is decidable — 1/15 and 2/01 can only be month first — and the
    // software still does not decide it. That is the whole of this round's change.
    const dateVerdict = profiles[dateColumnOf(m)]?.dates
    check(dateVerdict?.kind === 'certain' && dateVerdict.order === 'mdy',
      'B69b and it could have been decided, which is the point',
      dateVerdict?.because ?? 'no verdict')

    check(dateColumnOf(m) === 2, 'B70 and the date column is found by shape, with no header to help',
      `column ${dateColumnOf(m) + 1}`)

    // Two numeric columns and no headers: the account number looks exactly as
    // much like an amount as the amount does, so nothing is guessed and the
    // screen has to ask. Guessing here would be guessing about money.
    check(!m.roles.includes('amount') && !m.roles.includes('out'),
      'B71 two numeric columns with no header leave the amount unguessed', m.roles.join(','))
    check(m.roles[4] === 'description' && m.roles[0] === 'ignore',
      'B72 and the varying column is the description, not the repeated one', m.roles.join(','))

    // The user answers both open questions: which column is the amount, and
    // how the dates are written.
    const withAmount: Mapping = {
      roles: m.roles.map((r, i) => (i === 6 ? 'amount' : r)) as ColumnRole[],
      order: 'mdy',
      flip: false,
    }
    const { rows, problems } = applyMapping(grid, headerRow, withAmount)
    check(rows.length === 3 && problems.length === 0, 'B73 and every row reads',
      `${rows.length} rows, ${problems.length} problems`)
    check(rows[0]?.date === '2024-01-15' && rows[2]?.date === '2024-02-01',
      'B74 and 2/01/2024 is 1 February, not 2 January', `${rows[0]?.date} … ${rows[2]?.date}`)

    const out = csvFile([['date', 'amount', 'description'],
      ...rows.map((r) => [r.date, (Number(r.amount) / 100).toFixed(2), r.description])])
    check(out.includes('2024-01-16,3200.00,"DEPOSIT, PAYROLL"'),
      'B75 and the normalised export re-quotes the comma it kept',
      out.split('\r\n')[2] ?? '')
  }

  {
    // A file that changes date format partway through.
    //
    // The first 200 rows can only be read day-first. Row 201 can only be read
    // month-first. Before this was fixed, profiling stopped at row 200, called
    // the column decided, and the late row came out as a per-row parse failure
    // at best. Now the verdict is about the whole column, so the file is
    // refused as what it is: a column with two formats in it.
    const early = ['Date,Description,Amount']
    for (let i = 0; i < 200; i++) early.push(`${13 + (i % 15)}/01/2024,ROW,-1.00`)
    early.push('01/13/2024,LATE,-2.00')
    const grid = parseCsv(early.join('\n'), ',')
    const late = profileColumns(grid, 0)[0]?.dates
    check(late?.kind === 'conflict', 'B82 a format change after row 200 is seen',
      late?.because ?? 'no verdict')
    check((late?.because ?? '').includes('01/13/2024'),
      'B82b and the offending row is named', late?.because ?? '')

    // The pair: without a late row that contradicts, the same 200 rows decide
    // cleanly. Otherwise B82 would pass on any file at all.
    const clean = parseCsv(early.slice(0, 201).join('\n'), ',')
    const cleanVerdict = profileColumns(clean, 0)[0]?.dates
    check(cleanVerdict?.kind === 'certain', 'B83 and the same file without it reads cleanly',
      cleanVerdict?.because ?? 'no verdict')
  }

  {
    // The limitation, written as a check rather than as a sentence in a doc.
    //
    // If the late rows are individually readable BOTH ways — 12/05, 11/06 —
    // then nothing in the file says which was meant. No scan, no window size and
    // no amount of care can recover it. This asserts that the software does the
    // only honest thing available: reads them under the chosen format without
    // pretending to have noticed.
    //
    // It is here so that the day someone claims this case is handled, a check
    // says otherwise.
    const mixed = ['Date,Description,Amount']
    for (let i = 0; i < 200; i++) mixed.push(`${13 + (i % 15)}/01/2024,ROW,-1.00`)
    for (const d of ['12/05/2024', '11/06/2024', '10/07/2024']) mixed.push(`${d},LATE,-2.00`)
    const grid = parseCsv(mixed.join('\n'), ',')
    const verdict = profileColumns(grid, 0)[0]?.dates
    check(verdict?.kind === 'certain',
      'B84 (known gap) a mixed file whose late rows fit both ways looks decided',
      verdict?.because ?? 'no verdict')
    const r = applyMapping(grid, 0, mapping(roles('date', 'description', 'amount'), 'dmy'))
    check(r.rows.length === 203 && r.problems.length === 0,
      'B84b and it reads without complaint — RISKS #19', `${r.rows.length} rows, ${r.problems.length} problems`)
  }

  {
    // A late row that cannot be read under the chosen format is still reported
    // against its own row, whatever the verdict said.
    const lines = ['Date,Description,Amount']
    for (let i = 0; i < 250; i++) lines.push(`0${(i % 9) + 1}/0${(i % 9) + 1}/2024,ROW,-1.00`)
    lines.push('01/31/2024,LATE,-2.00')
    const grid = parseCsv(lines.join('\n'), ',')
    const r = applyMapping(grid, 0, mapping(roles('date', 'description', 'amount'), 'dmy'))
    check(r.rows.length === 250 && r.problems.some((x) => x.code === 'BAD_DATE' && x.row === 252),
      'B85 an unreadable row is reported against its own row',
      r.problems[0]?.message.slice(0, 76) ?? `${r.rows.length} rows, no problem raised`)
  }

  {
    // Moving the date to another column throws the chosen format away, because
    // the answer was about the old column.
    const twoDates = [
      'Posted Date,Transaction Date,Description,Amount',
      '25/01/2024,01/02/2024,A,-1.00',
      '26/01/2024,03/04/2024,B,-2.00',
    ].join('\n') + '\n'
    const p = profileColumns(parseCsv(twoDates, ','), 0)
    check(p[0]?.dates.kind === 'certain' && p[1]?.dates.kind === 'ambiguous',
      'B86 (fixture) one column is decidable and the other is not',
      `${p[0]?.dates.kind} / ${p[1]?.dates.kind}`)

    const answered = mapping(roles('date', 'ignore', 'description', 'amount'), 'dmy')
    const dropped = withRole(answered, 0, 'ignore')
    check(dropped.order === null, 'B87 moving the date off a column clears the format',
      String(dropped.order))
    const moved = withRole(answered, 1, 'date')
    check(moved.order === null, 'B87b and giving the role to another column clears it too',
      String(moved.order))

    // The pair: a change that does not touch the date keeps the answer, or the
    // rule would just be "clear it on every keystroke".
    const unrelated = withRole(answered, 2, 'ignore')
    check(unrelated.order === 'dmy', 'B88 but an unrelated column change keeps it',
      String(unrelated.order))
  }

  {
    // "$" survives every strip in parseBankAmount and reached parseMoney as an
    // empty string, which reads as zero — a transaction the bank never made,
    // sitting in the middle of a statement with nothing reported.
    expectThrow('B89 a currency sign with no number is refused', 'BAD_AMOUNT',
      () => parseBankAmount('$'))
    expectThrow('B89b and so is a lone minus', 'BAD_AMOUNT', () => parseBankAmount(' - '))
    expectThrow('B89c and so are empty brackets', 'BAD_AMOUNT', () => parseBankAmount('()'))

    const withJunk = 'Date,Description,Amount\n2024-01-15,A,10.00\n2024-01-16,B,$\n2024-01-17,C,50.00\n'
    const r = applyMapping(parseCsv(withJunk, ','), 0,
      mapping(roles('date', 'description', 'amount'), 'ymd'))
    check(r.rows.length === 2 && r.problems.some((x) => x.code === 'BAD_AMOUNT' && x.row === 3),
      'B90 and the row carrying it is reported, not read as 0.00',
      `${r.rows.length} rows; ${r.problems[0]?.message.slice(0, 60) ?? 'no problem'}`)

    // Its pair, and the reason the two cannot be merged: a genuinely blank cell
    // is a different situation with a different answer.
    check(parseBankAmount('   ') === null, 'B90b while a blank cell is still no amount at all',
      String(parseBankAmount('   ')))
  }

  // --------------------------------------------------------------- screen --
  //
  // Everything above tests the library. None of it can tell whether the page
  // asks. That distinction is not academic here: in the sales tax round a rule
  // was correct in the library and absent from the page for six rounds, and
  // every check over the library passed the whole time.

  // A mutated library can make the render script itself throw. That must show up
  // as a failed check, not as a dead suite: a suite that dies partway prints no
  // summary, and `mutations.sh` then records a block that reads like a shorter
  // version of the real one.
  const render = (input: Record<string, unknown>) => JSON.parse(execFileSync(
    'npx', ['tsx', 'scripts/render-bank-screen.tsx', JSON.stringify(input)],
    { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } },
  )) as {
    showsResults: boolean
    blockedNotice: boolean
    order: string | null
    problems: string[]
    hasRows: boolean
    rowCount: number | null
    selected: Record<string, string>
    orderOptions: string[] | null
    previewRows: Array<{ date: string; description: string; amount: string }>
  }

  {
    const blocked = render({ text: AMBIGUOUS })
    check(blocked.blockedNotice && !blocked.showsResults && !blocked.hasRows,
      'B76 an unanswered date format blocks the screen itself',
      `notice=${blocked.blockedNotice} results=${blocked.showsResults}`)

    // The pair. Without it, a screen that shows nothing at all would also pass.
    const answered = render({ text: AMBIGUOUS, order: 'dmy' })
    check(answered.showsResults && answered.rowCount === 2 && !answered.blockedNotice,
      'B77 and answering it puts the rows on the screen',
      `rows=${answered.rowCount} results=${answered.showsResults}`)

    check(JSON.stringify(blocked.orderOptions) === JSON.stringify(['', 'ymd', 'dmy', 'mdy']),
      'B78 all three formats are offered, and none is preselected',
      JSON.stringify(blocked.orderOptions))

    check(blocked.selected['role-0'] === 'date' && blocked.selected['role-2'] === 'amount',
      'B79 the column guess arrives at the screen as the selected option',
      JSON.stringify(blocked.selected))
    check(blocked.selected['date-order'] === '',
      'B79b but the date format arrives unchosen', JSON.stringify(blocked.selected['date-order']))
  }

  {
    // The unambiguous file blocks too. Before this round it did not: one reading
    // fitted, so the software chose and the screen went straight to rows.
    // "One reading fits the first 200 lines" is not "one reading fits the file".
    const unset = render({ text: PAIRED })
    check(unset.blockedNotice && !unset.showsResults && !unset.hasRows,
      'B80 an unambiguous file blocks until the format is chosen',
      `notice=${unset.blockedNotice} results=${unset.showsResults}`)
    check(unset.problems.includes('error:ORDER_UNSET'),
      'B80b and the reason given is the unset format', unset.problems.join(','))

    const chosen = render({ text: PAIRED, order: 'ymd' })
    check(chosen.showsResults && chosen.rowCount === 3,
      'B81 and choosing it reads all three rows', `rows=${chosen.rowCount}`)
  }

  {
    // The same rule as B87, but exercised through the screen's own handler
    // rather than by calling the library. The defect it guards is only visible
    // in a SEQUENCE — answer, then move the role — which no check over a single
    // rendered state could have found.
    const twoDates = [
      'Posted Date,Transaction Date,Description,Amount',
      '25/01/2024,01/02/2024,A,-1.00',
      '26/01/2024,03/04/2024,B,-2.00',
    ].join('\n') + '\n'

    const settled = render({
      text: twoDates, roles: ['date', 'ignore', 'description', 'amount'], order: 'dmy',
    })
    check(settled.showsResults && settled.rowCount === 2,
      'B91 (fixture) with the format answered the screen shows rows',
      `rows=${settled.rowCount}`)

    const afterMove = render({
      text: twoDates, roles: ['date', 'ignore', 'description', 'amount'], order: 'dmy',
      moves: [{ index: 0, role: 'ignore' }, { index: 1, role: 'date' }],
    })
    check(afterMove.blockedNotice && !afterMove.showsResults && afterMove.order === null,
      'B92 and moving the date to another column asks again',
      `notice=${afterMove.blockedNotice} order=${afterMove.order}`)
  }

  {
    const blocked = render({ text: TIMESTAMPS })
    check(blocked.selected['role-0'] === 'date' && blocked.blockedNotice && !blocked.hasRows,
      'B100 the Time column reaches the UI as Date, while the existing format confirmation still applies')
    const chosen = render({ text: TIMESTAMPS, order: 'ymd' })
    check(chosen.showsResults && chosen.rowCount === 3
          && chosen.previewRows.map(r => r.date).join(',') === '2026-09-27,2026-09-27,2026-09-28',
      'B101 the actual bank preview displays all timestamp rows using the bank calendar date',
      chosen.previewRows.map(r => r.date).join(','))
  }

}

main()

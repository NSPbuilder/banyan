import assert from 'node:assert/strict'
import { formatNumber } from '../src/lib/numbers'
import { formatMoney, parseMoney, moneyInput } from '../src/lib/money'
import { formatHours } from '../src/lib/payroll/labels'
import { moveTab } from '../src/lib/tabs'
import { partyDirectory, selectedParty, rowsForParty, partyLedgerHref } from '../src/lib/party-ledger-navigation'
import { blankRow } from '../src/lib/record-rows'
import type { LedgerRow } from '../src/lib/browse'
assert.equal(formatNumber('900719925474099312345.6700'), '900,719,925,474,099,312,345.6700')
assert.equal(formatNumber(-1234567), '-1,234,567')
assert.equal(formatNumber(1234567n), '1,234,567')
assert.equal(formatNumber('1002-1'), '1002-1')
assert.equal(formatNumber('1234.0001'), '1,234.0001')
assert.equal(formatMoney(-123456789n, { sign: 'accounting' }), '(1,234,567.89)')
assert.equal(parseMoney(formatMoney(900719925474099312345n)), 900719925474099312345n)
assert.equal(moneyInput(123456n), '1234.56')
assert.equal(formatHours(123456n), '1,234.56')
assert.equal(blankRow('transparency', 0, '2026-10-04').values.citizenOrPr, '')
assert.equal(blankRow('transparency', 0, '2026-10-04').values.taxResidentCa, '')
const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
assert.deepEqual(moveTab(tabs, 'a', 'c', 'after').map(t => t.id), ['b', 'c', 'a'])
assert.deepEqual(moveTab(tabs, 'c', 'a', 'before').map(t => t.id), ['c', 'a', 'b'])
assert.equal(moveTab(tabs, 'b', 'a', 'after'), tabs)
assert.equal(moveTab(tabs, 'missing', 'a', 'after'), tabs)
const rows = [{ party_id: 'a', party_name: 'A' }, { party_id: null, party_name: null }] as LedgerRow[]
const directory = partyDirectory(rows, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'out')
assert.equal(directory.find(p => p.id === 'b')?.count, 0)
assert.equal(rowsForParty(rows, selectedParty(directory, 'none')).length, 1)
assert.equal(rowsForParty(rows, selectedParty(directory, 'foreign')), rows)
const href = new URL(partyLedgerHref('/expenses', 'from=2026-09-01&to=2026-09-30', 'a'), 'http://fixture')
assert.equal(href.searchParams.get('from'), '2026-09-01')
assert.equal(href.searchParams.get('party'), 'a')
assert.equal(new URL(partyLedgerHref('/expenses', href.search, ''), 'http://fixture').searchParams.has('party'), false)
console.log('PASS: exact numbers, money inputs, hours, tab order, and scoped party selection.')

console.log('=== ALL CHECKS PASSED ===')

import './env'
import assert from 'node:assert/strict'
import { sql as query } from 'drizzle-orm'
import { db, sql } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { createInvoice, invoicePartiesFor, invoicesFor, voidInvoice, type InvoiceRecord } from '../src/lib/invoices'
import { invoiceFilterError, isInvoiceFilterDate, readInvoiceFilters, type InvoiceFilters } from '../src/lib/invoice-filters'

const actor = 'invoice-filters@example.test'
let checks = 0
const check = (value: unknown, label: string) => { assert(value, label); checks++; console.log(`PASS  ${label}`) }
const CHART = `1200,Receivables,asset,,trade_receivables
2000,Payables,liability,,trade_payables
4000,Revenue,revenue,,revenue_from_contracts
5000,Fees,expense,,professional_fees fn_administrative_expenses`

async function main() {
  const [{ name }] = await db.execute<{ name: string }>(query`SELECT current_database() AS name`)
  assert(name.startsWith('figtree_') && name.endsWith('_test') && name === new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1) && name !== new URL(process.env.APP_DATABASE_URL!).pathname.slice(1) && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.TEST_DATABASE_URL!).hostname), 'Use a fresh isolated invoice-filter test database')
  const co = await createCompany({ code: 'FILT', name: 'Invoice Filters Test' }, actor)
  const other = await createCompany({ code: 'FILT2', name: 'Other Invoice Filters Test' }, actor)
  await createFiscalYear(co.ledger.id, '2026-12-31', actor)
  await createFiscalYear(other.ledger.id, '2026-12-31', actor)
  const chart = async (entityId: string) => Object.fromEntries((await importAccounts(entityId, parseAccountsCsv(CHART).map(a => ({ ...a, entityId })), actor)).map(a => [a.code, a.id]))
  const accounts = await chart(co.company.id), otherAccounts = await chart(other.company.id)
  const party = (name: string, role: 'customer' | 'supplier', entityId = co.company.id) => createParty({ kind: 'organisation', name, actor, roles: [{ entityId, role, heldFrom: '2026-01-01' }] })
  const north = await party('North Filter Client', 'customer'), south = await party('South Filter Client', 'customer')
  const vendor = await party('Filter Parts Supplier', 'supplier'), outside = await party('Outside Invoice Customer', 'customer', other.company.id)
  const make = (partyId: string, number: string, issuedOn: string, extras: Partial<Parameters<typeof createInvoice>[0]> = {}) => createInvoice({
    ledgerId: co.ledger.id, direction: 'sales', partyId, controlAccountId: accounts['1200'], number,
    issuedOn, dueOn: '2026-08-01', actor,
    lines: [{ accountId: accounts['4000'], amount: -123456n }], ...extras,
  })
  const first = await make(north.id, 'INV-FILTER-ALPHA', '2026-03-01', {
    theirRef: 'CLIENT-PO-101', note: 'Harbor retainer 50%', lines: [
      { accountId: accounts['4000'], amount: -100000n, description: 'Architecture workshop' },
      { accountId: accounts['4000'], amount: -23456n, description: 'Architecture follow-up' },
    ],
  })
  const last = await make(south.id, 'INV-FILTER-BRAVO', '2026-03-31', { lines: [{ accountId: accounts['4000'], amount: -345600n }] })
  const before = await make(north.id, 'INV-FILTER-BEFORE', '2026-02-28', { lines: [{ accountId: accounts['4000'], amount: -45678n }] })
  const after = await make(north.id, 'INV-FILTER-AFTER', '2026-04-01', { lines: [{ accountId: accounts['4000'], amount: -56789n }] })
  const bill = await make(vendor.id, 'FILE-BILL-1', '2026-03-15', {
    direction: 'purchase', controlAccountId: accounts['2000'], theirRef: 'BILL-420', note: 'Parts_back\\order',
    lines: [{ accountId: accounts['5000'], amount: 50025n, description: 'Office fittings' }],
  })
  const voided = await make(south.id, 'INV-FILTER-VOID', '2026-03-12', { lines: [{ accountId: accounts['4000'], amount: -90000n }] })
  await voidInvoice(voided.id, { reason: 'Fixture void', actor })
  const credit = await make(north.id, 'CN-FILTER-1', '2026-03-20', { kind: 'credit_note', lines: [{ accountId: accounts['4000'], amount: 7000n }] })
  const foreign = await make(outside.id, 'INV-FILTER-ALPHA', '2026-03-01', { ledgerId: other.ledger.id, controlAccountId: otherAccounts['1200'], lines: [{ accountId: otherAccounts['4000'], amount: -123456n }] })
  const original = await invoicesFor(co.ledger.id)
  const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort().join(',')
  const expect = async (filters: Partial<InvoiceFilters>, expected: InvoiceRecord[], label: string) => {
    const rows = await invoicesFor(co.ledger.id, filters)
    check(ids(rows) === ids(expected), label)
    check(new Set(rows.map(r => r.id)).size === rows.length, `${label}: each document once`)
  }
  check(original.length === 7 && !original.some(r => r.id === foreign.id), 'Default includes every local document and excludes the other ledger')
  check((await invoicesFor(co.ledger.id, 'sales')).length === 6 && (await invoicesFor(co.ledger.id, 'purchase')).length === 1, 'Existing direction-only callers still work')
  await expect({ from: '2026-03-01', to: '2026-03-31' }, [first, last, bill, voided, credit], 'Issued range includes both boundaries and ignores due date')
  await expect({ from: '2026-03-01', to: '2026-03-01' }, [first], 'A single issued day works')
  await expect({ from: '2026-03-01' }, [first, last, after, bill, voided, credit], 'Open-ended From works')
  await expect({ to: '2026-03-31' }, [first, last, before, bill, voided, credit], 'Open-ended To works')
  await expect({ partyId: north.id }, [first, before, after, credit], 'Party applies to all that party documents')
  await expect({ partyId: outside.id }, [], 'A party from another ledger exposes no invoices')
  await expect({ direction: 'purchase', from: '2026-03-01', to: '2026-03-31', partyId: vendor.id, q: '420' }, [bill], 'Every filter combines with AND')
  await expect({ direction: 'sales', partyId: vendor.id }, [], 'Contradictory filters produce an empty result')
  await expect({ q: '  inv-filter-alpha  ' }, [first], 'Number search trims and ignores case')
  await expect({ q: 'FILE-BILL-1' }, [bill], 'Search finds internal purchase filing number')
  await expect({ q: 'bill-420' }, [bill], 'Search finds supplier reference')
  await expect({ q: 'CLIENT-PO-101' }, [first], 'Search finds customer reference')
  await expect({ q: 'SOUTH FILTER CLIENT' }, [last, voided], 'Search finds party names')
  await expect({ q: 'retainer' }, [first], 'Search finds document notes')
  await expect({ q: 'ARCHITECTURE' }, [first], 'Search finds multiple matching lines without duplicating invoice')
  await expect({ q: '%' }, [first], 'Percent is a literal search character')
  await expect({ q: '_' }, [bill], 'Underscore is a literal search character')
  await expect({ q: '\\' }, [bill], 'Backslash is a literal search character')
  await expect({ q: '1,234.56' }, [first], 'Search finds formatted amount using shared money semantics')
  await expect({ q: '2026-03-20' }, [credit], 'Search finds issued date')
  await expect({ q: '2026-02-31' }, [], 'Invalid search date remains text without SQL error')
  await expect({ q: "' OR 1=1 --" }, [], 'Search input remains a bound value')
  const choices = await invoicePartiesFor(co.ledger.id)
  check(ids(choices) === [north.id, south.id, vendor.id].sort().join(','), 'Party choices contain only parties with documents in this ledger')
  check(choices.map(p => p.label).join(',') === 'Filter Parts Supplier,North Filter Client,South Filter Client', 'Party choices are alphabetical and independent of active filters')
  check(ids(await invoicePartiesFor(co.ledger.id, 'sales')) === [north.id, south.id].sort().join(','), 'Sales workspace excludes supplier-only document parties')
  check(ids(await invoicePartiesFor(co.ledger.id, 'purchase')) === vendor.id, 'Bill workspace excludes customer-only document parties')
  check(isInvoiceFilterDate('2024-02-29') && !isInvoiceFilterDate('2026-02-29') && !isInvoiceFilterDate('2026-13-01') && !isInvoiceFilterDate('0000-01-01'), 'Calendar validation checks leap days, month bounds and year zero')
  const parsed = readInvoiceFilters({ q: [' ALPHA ', 'BRAVO'], from: '2026-03-01', to: '2026-03-31', direction: 'purchase', party: vendor.id })
  check(!parsed.error && parsed.filters.q === 'ALPHA' && parsed.filters.partyId === vendor.id && parsed.filters.direction === 'purchase', 'URL parsing retains combined filters and uses first repeated value')
  check(!readInvoiceFilters({}).error && !invoiceFilterError({}), 'Empty filters mean all documents')
  for (const filters of [{ from: '2026-02-31' }, { from: '2026-04-01', to: '2026-03-01' }, { partyId: 'not-an-id' }, { direction: 'unknown' as InvoiceFilters['direction'] }]) {
    await assert.rejects(() => invoicesFor(co.ledger.id, filters), e => e instanceof Error && 'code' in e && e.code === 'BAD_FILTER')
    check(Boolean(invoiceFilterError(filters)), 'Invalid URL/filter is refused before database casts')
  }
  const latest = await invoicesFor(co.ledger.id)
  check(JSON.stringify(latest, (_, v) => typeof v === 'bigint' ? String(v) : v) === JSON.stringify(original, (_, v) => typeof v === 'bigint' ? String(v) : v), 'Filters do not change document amounts, statuses or order')
  console.log(`\n${checks} invoice-filter checks passed`)
  console.log('=== ALL CHECKS PASSED ===')
}

main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => sql.end())

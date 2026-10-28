/**
 * Parties: customers and suppliers are one list.
 *   npm run db:verify-parties   (resets the database first)
 *
 * The shape is settled in `docs/design/03-parties.md`. The three claims that
 * matter, and that this suite exists to make earned:
 *
 *   one organisation is one row, however many companies deal with it
 *   a role belongs to a company and to a stretch of time
 *   nothing here keeps a balance — the ledger answers "what do they owe"
 *
 * The acceptance test the design was written against is P07: the same supplier
 * under two companies, address changed once, right in both places.
 */
import './env'
import { errorText, expectCode, expectDbRefusal, reporter } from './suite'
import { byHand } from './by-hand'
import { trailNamesPeople } from './actor-trail'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts } from '../src/lib/accounts'
import { amendEntry, postDraft, postEntry, reverseEntry, saveDraft } from '../src/lib/posting'
import {
  PartyError, createParty, deactivateParty, deleteParty, endRole, grantRole,
  partiesAsAt, partiesFor, partyDetail, partyChoices, shareholderDirectorChoices, transactingPartyRoles, reactivateParty, roleDefinitions,
  setAddress, transactingParties, updateParty,
} from '../src/lib/parties'
import { PARTY_FIELDS as F, bankPartyOptions, linesFromJson } from '../src/lib/forms'
import { createPartyFromForm, grantRoleFromForm, updatePartyFromForm, deactivatePartyFromForm, deletePartyFromForm, endRoleFromForm, reactivatePartyFromForm, setAddressFromForm, correctRoleFromForm, deleteRoleFromForm, deleteAddressFromForm } from '../src/lib/party-forms'
import { saveEmployee } from '../src/lib/payroll/employees'
import { createProjectPartyFromForm } from '../src/lib/project-party'

const CHART: Array<[string, string, 'asset' | 'liability' | 'equity' | 'revenue' | 'expense']> = [
  ['1000', 'Cash — Operating', 'asset'],
  ['1200', 'Accounts Receivable', 'asset'],
  ['2000', 'Accounts Payable', 'liability'],
  ['3000', 'Share Capital', 'equity'],
  ['4000', 'Consulting Revenue', 'revenue'],
  ['5000', 'Subcontractors', 'expense'],
]

const r = reporter(65)
const { fail, check } = r

const expectDbError = expectDbRefusal(r, { passSlice: 78, failSlice: 140 })

const expectError = expectCode(r, { passSlice: 76, failText: (e) => errorText(e).slice(0, 90), sayingSlice: 70 })

async function main() {
  // Two companies, because the whole design is about one party across several.
  const alpha = await createCompany({ code: 'ALPHA', name: 'Alpha Consulting Inc.' }, 'alicio@example.test')
  const beta = await createCompany({ code: 'BETA', name: 'Beta Holdings Ltd.' }, 'alicio@example.test')
  await createFiscalYear(alpha.ledger.id, '2026-12-31', 'alicio@example.test')
  await createFiscalYear(beta.ledger.id, '2026-12-31', 'alicio@example.test')

  const chartFor = async (companyId: string) =>
    importAccounts(companyId, CHART.map(([code, name, accountType]) =>
      ({ entityId: companyId, code, name, accountType })), 'alicio@example.test')
  const alphaAccounts = await chartFor(alpha.company.id)
  const betaAccounts = await chartFor(beta.company.id)
  const aAt = (c: string) => alphaAccounts.find((a) => a.code === c)!
  const bAt = (c: string) => betaAccounts.find((a) => a.code === c)!

  // ------------------------------------------------------------- creating --

  {
    const defs = await roleDefinitions()
    const transacting = defs.filter((d) => d.transacts).map((d) => d.code)
    // Every seeded role transacts since 0044 (owner, 2026-09-02): a director
    // advancing money and a shareholder receiving a dividend ARE money moving.
    // The flag machinery stays — a future role can still be records-only, and
    // P44 still proves the guard on flipping one off.
    check(defs.length === 5 && transacting.length === 5
          && defs.every((d) => d.transacts),
      'P01 roles are data, and every seeded one carries money',
      `${defs.length} roles, ${transacting.join('/')} transact`)

    const acme = await createParty({
      kind: 'organisation', name: 'Acme Ltd.', taxNumber: '80012 3456 RT0001',
      roles: [{ entityId: alpha.company.id, role: 'customer', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    check(acme.name === 'Acme Ltd.' && acme.is_active,
      'P02 a party is created with its role in one transaction', acme.name)

    await expectError('P03 a party with no role anywhere is refused', 'ROLE_REQUIRED', () =>
      createParty({ kind: 'organisation', name: 'Nobody Inc.', roles: [], actor: 'alicio@example.test' }),
      'cannot be invoiced')

    await expectError('P04 and a party with no name is refused', 'NAME_REQUIRED', () =>
      createParty({
        kind: 'organisation', name: '   ',
        roles: [{ entityId: alpha.company.id, role: 'customer', heldFrom: '2026-01-01' }],
        actor: 'alicio@example.test',
      }))

    // The duplicate check `03` asks for. It names the existing one, because
    // "already exists" without saying which is a message that sends you looking.
    //
    // Spaces and case is all this covers. Whether the library's lookup and the
    // index agree about stranger whitespace is a different question, asked by
    // `P06b` — under a mutated normaliser this fixture still passes, so it is
    // not the check that settles that one.
    await expectError('P05 the same name a second time is refused, naming the first',
      'DUPLICATE_NAME', () =>
        createParty({
          kind: 'organisation', name: '  acme   ltd.  ',
          roles: [{ entityId: beta.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
          actor: 'alicio@example.test',
        }),
      'Acme Ltd.')

    // The pair: it is the NAME that collides, not any name. Without this, a
    // guard that refused every second party would pass the check above.
    const other = await createParty({
      kind: 'organisation', name: 'Bell Canada',
      roles: [{ entityId: alpha.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    check(other.id !== acme.id, 'P06 while a different name goes in', other.name)

    // The library's lookup and the index have to normalise identically, or a
    // name lands between them: caught by neither, because the lookup misses and
    // then the index computes a different key for the row it stores. They share
    // `party_name_key` for that reason. This asserts it over the whitespace the
    // two used to disagree about — Postgres `trim()` strips ASCII space only,
    // so a tab was invisible to one side and not the other.
    // U+FEFF is in this list because JavaScript `.trim()` strips it and Postgres
    // `\s` does not match it — the asymmetry that made the lookup and the index
    // disagree. Non-breaking spaces are explicit in the database key too,
    // rather than relying on the host's ctype.
    const awkward = [
      '\tAcme Ltd.\t', 'ACME   LTD.', ' acme ltd. ', 'Acme\nLtd.',
      '\ufeffAcme Ltd.', 'Acme Ltd.\ufeff',
      'Acme\u00a0Ltd.', 'Acme\u202fLtd.',
    ]
    const slipped: string[] = []
    for (const variant of awkward) {
      try {
        await createParty({
          kind: 'organisation', name: variant,
          roles: [{ entityId: beta.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
          actor: 'alicio@example.test',
        })
        slipped.push(`${JSON.stringify(variant)} got in`)
      } catch (e) {
        const err = e as PartyError
        // DUPLICATE_NAME is the library catching it. Anything else — a raw
        // unique-violation, or nothing at all — means the two sides disagree.
        if (err.code !== 'DUPLICATE_NAME') {
          slipped.push(`${JSON.stringify(variant)} -> ${err.code ?? errorText(e).slice(0, 40)}`)
        }
      }
    }
    check(slipped.length === 0,
      'P06b and the same name spelled awkwardly is caught by the library, not the index',
      slipped.join('; ') || `${awkward.length} variants, all refused in words`)

    // The key itself, including both non-breaking spaces, is host-independent.
    const [keys] = await db.execute<{
      plain: string; tab: string; nbsp: string; narrow: string; bom: string
    }>(raw`
      SELECT party_name_key('Acme Ltd.') AS plain,
             party_name_key(E'\tAcme  Ltd.\t') AS tab,
             party_name_key('Acme' || chr(160) || 'Ltd.') AS nbsp,
             party_name_key('Acme' || chr(8239) || 'Ltd.') AS narrow,
             party_name_key(chr(65279) || 'Acme Ltd.') AS bom`)
    check(keys.plain === 'acme ltd.' && keys.tab === 'acme ltd.' && keys.nbsp === 'acme ltd.' && keys.narrow === 'acme ltd.',
      'P06c the key collapses tab and non-breaking space to the same thing',
      `plain ${JSON.stringify(keys.plain)}, tab ${JSON.stringify(keys.tab)}, nbsp ${JSON.stringify(keys.nbsp)}`)

    // And the one it does NOT collapse, said out loud: U+FEFF is not
    // whitespace to Postgres. The library is what covers it, by looking up
    // with the same trimmed value it stores.
    check(keys.bom !== 'acme ltd.',
      'P06d while U+FEFF is not whitespace to the database — the library covers that one',
      JSON.stringify(keys.bom))
  }

  // --------------------------------------------- one party, two companies --

  const bell = (await partiesFor(alpha.company.id)).find((p) => p.name === 'Bell Canada')!

  {
    await grantRole({
      partyId: bell.id, entityId: beta.company.id, role: 'supplier',
      heldFrom: '2026-01-01', actor: 'alicio@example.test',
    })

    const inAlpha = (await partiesFor(alpha.company.id)).find((p) => p.id === bell.id)
    const inBeta = (await partiesFor(beta.company.id)).find((p) => p.id === bell.id)
    check(inAlpha?.id === inBeta?.id && inAlpha !== undefined,
      'P07 one organisation, one row, on both companies\' lists', `${inAlpha?.id.slice(0, 8)}`)

    // THE acceptance test from `03`: change the address once, both are right.
    // Both are right because there is only one place for it to be.
    await setAddress({
      partyId: bell.id, purpose: 'mailing', line1: '1 Carrefour Alexander-Graham-Bell',
      city: 'Verdun', region: 'QC', postalCode: 'H3E 3B3',
    })
    await setAddress({
      partyId: bell.id, purpose: 'mailing', line1: '100 Wynford Drive',
      city: 'Toronto', region: 'ON', postalCode: 'M3C 4H5',
    })

    const detail = await partyDetail(bell.id)
    const mailing = detail?.addresses.filter((a) => a.purpose === 'mailing') ?? []
    check(mailing.length === 1 && mailing[0].city === 'Toronto',
      'P08 changing the address changes it once, for every company',
      `${mailing.length} mailing address, ${mailing[0]?.city}`)
    check((detail?.roles.length ?? 0) === 2
          && new Set(detail?.roles.map((r) => r.entity_id)).size === 2,
      'P09 with the role held separately at each', `${detail?.roles.length} roles`)
  }

  // ------------------------------------------------- the ledger points at --

  {
    const acme = (await partiesFor(alpha.company.id)).find((p) => p.name === 'Acme Ltd.')!

    const invoice = await postEntry({
      ledgerId: alpha.ledger.id, entryDate: '2026-03-01', description: 'Invoice 1',
      actor: 'alicio@example.test',
      lines: [
        { accountId: aAt('1200').id, amount: 120000n, partyId: acme.id },
        { accountId: aAt('4000').id, amount: -120000n },
      ],
    })
    const [named] = await db.execute<{ n: string }>(raw`
      SELECT p.name AS n FROM journal_line jl JOIN party p ON p.id = jl.party_id
       WHERE jl.entry_id = ${invoice.entry.id}::uuid`)
    check(named?.n === 'Acme Ltd.',
      'P10 a journal line names the party it is about', named?.n ?? 'none')

    // A party who is nothing to this company cannot be named on its books. The
    // aging would otherwise show a debt owed by someone with no relationship to
    // the company, and nothing would say where it came from.
    await expectDbError('P11 a party with no role here cannot be named on these books',
      'PARTY_NOT_TRADING', () =>
        postEntry({
          ledgerId: beta.ledger.id, entryDate: '2026-03-01', description: 'Wrong company',
          actor: 'alicio@example.test',
          lines: [
            { accountId: bAt('1200').id, amount: 5000n, partyId: acme.id },
            { accountId: bAt('4000').id, amount: -5000n },
          ],
        }))

    // The pair: give them the role at that company and the same entry goes in.
    // Without it, a guard that refused every party on Beta's books would pass.
    await grantRole({
      partyId: acme.id, entityId: beta.company.id, role: 'customer',
      heldFrom: '2026-01-01', actor: 'alicio@example.test',
    })
    const ok = await postEntry({
      ledgerId: beta.ledger.id, entryDate: '2026-03-01', description: 'Now allowed',
      actor: 'alicio@example.test',
      lines: [
        { accountId: bAt('1200').id, amount: 5000n, partyId: acme.id },
        { accountId: bAt('4000').id, amount: -5000n },
      ],
    })
    check(ok.entry.entryNo !== null,
      'P12 and once they hold it there, the same entry goes in', ok.entry.entryNo ?? '')

    // The journal form grew a per-line party select (2026-09-01). P10 proves
    // the ledger keeps a line's party; this proves the FORM READER hands it
    // over — the one seam between the screen's JSON and that lib call. An
    // empty select posts '' and must arrive as no party at all, not as a
    // party whose id is the empty string.
    const { lines: readBack } = linesFromJson(JSON.stringify([
      { accountId: aAt('1200').id, debit: '250.00', partyId: acme.id },
      { accountId: aAt('4000').id, credit: '250.00', partyId: '' },
    ]))
    check(readBack.length === 2 && readBack[0].partyId === acme.id
          && readBack[1].partyId === undefined,
      'P52 the entry form reader carries each line party, blank meaning nobody',
      `${readBack[0]?.partyId?.slice(0, 8)} / ${String(readBack[1]?.partyId)}`)
  }

  // ------------------------------------------------------ roles have dates --

  {
    const gone = await createParty({
      kind: 'organisation', name: 'Former Supplier Co.',
      roles: [{ entityId: alpha.company.id, role: 'supplier',
                heldFrom: '2026-01-01', heldTo: '2026-03-31' }],
      actor: 'alicio@example.test',
    })

    const before = await postEntry({
      ledgerId: alpha.ledger.id, entryDate: '2026-02-15', description: 'While they supplied us',
      actor: 'alicio@example.test',
      lines: [
        { accountId: aAt('5000').id, amount: 30000n, partyId: gone.id },
        { accountId: aAt('2000').id, amount: -30000n },
      ],
    })
    check(before.entry.entryNo !== null,
      'P13 an entry dated while the role was held goes in', before.entry.entryNo ?? '')

    await expectDbError('P14 while one dated after it ended does not',
      'PARTY_NOT_TRADING', () =>
        postEntry({
          ledgerId: alpha.ledger.id, entryDate: '2026-06-01', description: 'After they stopped',
          actor: 'alicio@example.test',
          lines: [
            { accountId: aAt('5000').id, amount: 30000n, partyId: gone.id },
            { accountId: aAt('2000').id, amount: -30000n },
          ],
        }))

    // A director advancing money for the company is the owner's own case
    // (0044, 2026-09-02): the entry names the director in that capacity. The
    // rule that remains — and P14/P41 keep proving — is that the party must
    // hold SOME role at this company covering the entry date.
    const director = await createParty({
      kind: 'person', name: 'Jean Tremblay',
      roles: [{ entityId: alpha.company.id, role: 'director', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    const advanced = await postEntry({
      ledgerId: alpha.ledger.id, entryDate: '2026-04-01',
      description: 'Director paid the courier', actor: 'alicio@example.test',
      lines: [
        { accountId: aAt('5000').id, amount: 1000n, partyId: director.id },
        { accountId: aAt('2000').id, amount: -1000n },
      ],
    })
    const [named] = await db.execute<{ name: string }>(raw`
      SELECT p.name FROM journal_line jl JOIN party p ON p.id = jl.party_id
       WHERE jl.entry_id = ${advanced.entry.id}::uuid AND jl.party_id IS NOT NULL`)
    check(named?.name === 'Jean Tremblay',
      'P15 a director can be named on a journal line (0044)', named?.name ?? 'nobody named')

    // And the dropdown the entry screens read includes the director, with the
    // capacity spelled out beside the name.
    const offered = await transactingParties(alpha.company.id)
    const jean = offered.find((p) => p.name === 'Jean Tremblay')
    check(!!jean && (jean.roles ?? '').includes('Director'),
      'P15b the entry screens offer the director, labelled', jean ? `${jean.name} — ${jean.roles}` : 'not offered')

    // P15c — and when a party IS refused, the sentence names the rule as it
    // stands since 0044, not 0025's vocabulary: the director holds no role at
    // BETA, and the refusal says what is actually missing (0045).
    let refusalText = ''
    try {
      await postEntry({
        ledgerId: beta.ledger.id, entryDate: '2026-04-01',
        description: 'Wrong company', actor: 'alicio@example.test',
        lines: [
          { accountId: bAt('5000').id, amount: 1000n, partyId: director.id },
          { accountId: bAt('2000').id, amount: -1000n },
        ],
      })
    } catch (e) { refusalText = errorText(e) }
    check(refusalText.includes('PARTY_NOT_TRADING')
          && refusalText.includes('holds no transacting role at this company covering'),
      'P15c the refusal names the rule, not a stale role list', refusalText.slice(0, 90))

    // As-at, not current: this is what P4's director roster needs.
    const inMarch = await partiesAsAt(alpha.company.id, '2026-03-01', 'supplier')
    const inJune = await partiesAsAt(alpha.company.id, '2026-06-01', 'supplier')
    check(inMarch.some((p) => p.id === gone.id) && !inJune.some((p) => p.id === gone.id),
      'P16 who held a role is answered as at a date, not as of now',
      `March ${inMarch.length}, June ${inJune.length}`)

    // A role may be added again after it ended, without asking when it began.
    const again = await grantRole({
      partyId: gone.id, entityId: alpha.company.id, role: 'supplier',
      actor: 'alicio@example.test',
    })
    await expectDbError('P17 the same current role cannot be added twice',
      'party_role_one_current', () =>
        grantRole({ partyId: gone.id, entityId: alpha.company.id, role: 'supplier',
                    heldFrom: '2026-07-01', actor: 'alicio@example.test' }))
    check(again.held_from === null,
      'P18 an ended role can be added again without a start date', String(again.held_from))

    const ended = await endRole(again.id, '2026-09-30')
    check(ended.held_to === '2026-09-30',
      'P19 and a role is ended on a date rather than deleted', ended.held_to ?? '')
    const listed = await partiesAsAt(alpha.company.id, '2026-02-15', 'supplier')
    check(listed.filter(p => p.id === gone.id).length === 1,
      'P59 historical role records do not duplicate a party in the Income or Expense directory', 'one party, one directory item')
  }

  // -------------------------------------------------- deleting and hiding --

  {
    const acme = (await partiesFor(alpha.company.id)).find((p) => p.name === 'Acme Ltd.')!

    await expectDbError('P20 a party the books name cannot be deleted', 'PARTY_IN_USE', () =>
      byHand((tx) => tx.execute(raw`DELETE FROM party WHERE id = ${acme.id}::uuid`)))

    // The pair, and the thing to do instead.
    const off = await deactivateParty(acme.id)
    check(!off.is_active, 'P21 but it can be taken off the lists', `${off.name} inactive`)

    // Deactivating frees the name — the duplicate index covers active rows only,
    // so a genuine second organisation of the same name is possible afterwards.
    const second = await createParty({
      kind: 'organisation', name: 'Acme Ltd.',
      roles: [{ entityId: beta.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    check(second.id !== acme.id,
      'P22 and the name is free again once it is', second.id.slice(0, 8))

    // What it does NOT do: the entry that named the old one still names it.
    const [still] = await db.execute<{ n: string }>(raw`
      SELECT p.name AS n FROM journal_line jl JOIN party p ON p.id = jl.party_id
       WHERE jl.party_id = ${acme.id}::uuid LIMIT 1`)
    check(still?.n === 'Acme Ltd.',
      'P23 while the entries that named it still do', still?.n ?? 'gone')
  }

  // ------------------------------------------------------- what is absent --

  {
    // The design says aging is derived from the ledger and there is no second
    // balance table. That is a claim about what does NOT exist, so it is checked
    // by looking: a table or column that caches a party balance would be found.
    // Every table, not just the ones called party-something. Looking only at
    // `party%` is looking where a cache would never be: an AR cache would be
    // called `ar_aging` or `receivable_balance`, or would be a party column
    // bolted onto `period_balance` — so that shape is searched for by name
    // too. The known caches are listed, so
    // adding one has to be a deliberate edit here.
    // Named one by one, with what each is, so adding a fifth means deciding
    // out loud whether it is a cache of something the ledger already knows.
    const KNOWN = [
      'period_balance.opening_balance',  // the ledger's own cache, rebuildable
      'period_balance.closing_balance',  //   from journal_line at any time
      'journal_entry.total_debit',       // the entry's own totals, not a party's
      'journal_entry.total_credit',
      'account.normal_balance',          // which side an account sits on: a
                                         // property of the account, not a figure
      'journal_line.party_id',           // the ledger itself — what aging reads
      'invoice.party_id',                // who the DOCUMENT is for. Not a
                                         // balance: the invoice holds no figure
                                         // at all, `V20` checks that separately
      // (`invoice_application` has no party column, on purpose: an application
      // reaches its party THROUGH the invoice. If one ever appears, the query
      // below finds it and this list refuses it — no advance entry needed, and
      // P25 forbids listing a column that does not exist.)
      // The corporate-records tables (0035). Each names a party because each IS
      // a relationship to a person — a term served, shares held, control had —
      // and none holds a dollar figure. Shares are counted, not owed:
      // `share_transaction.delta` is a number of shares, its register balances
      // by the transfer-group trigger, and holdings derive from the rows the
      // way aging derives from journal lines.
      'bank_statement.ending_balance', // the bank's own printed figure
                                         // (0043): an external assertion typed
                                         // in, like bank_transaction.amount —
                                         // the ledger cannot derive it, and the
                                         // statement report exists to let the
                                         // books DISAGREE with it. Not a cache:
                                         // deleting it loses a fact, not a copy
      'directorship.party_id',
      'officer_position.party_id',
      'share_transaction.party_id',
      'significant_individual.party_id',
      // Payroll (0051), for the same reason as the four above: a relationship
      // to a person, holding no dollar figure of theirs. What it does hold is
      // how often they are paid and what their TD1 says — facts about the
      // arrangement, which the ledger has no way to derive. The figures live on
      // `pay_stub`, one row per period as computed, and the year to date is
      // SUMMED from those rows rather than stored anywhere (`PR10`, `PR23`) —
      // which is the rule this check exists to protect, arrived at from the
      // other direction.
      'payroll_employee.party_id',
      // CRM links existing shared identities to one company's relationships.
      // These are identifiers, never receivable/payable or aging snapshots.
      'crm_account.party_id',
      'crm_account_contact.party_contact_id',
      'crm_lead.converted_party_id',
      // A cheque names its payee; its amount is the face value of that
      // instrument, not a cached receivable or payable for the party.
      'cheque.party_id',
      // Source relationships and template selection are identifiers, not cached debt.
      'invoice_template_assignment.party_id',
      'project.customer_party_id',
      'project_record.party_id',
      'project_payment.party_id',
      'project_payment_allocation.party_id',
      // Customer identities for approved mail and scheduling rules; neither stores current debt.
      'email_message.party_id',
      'reminder_rule.party_id',
      // Single-invoice capability/quote scope and an immutable external object identifier.
      'portal_invitation.party_id', 'checkout_request.party_id', 'processor_transaction.balance_transaction_id',
      // A concurrency locator contains no debt or cached balance.
      'document_edit_lease.party_id',
    ]
    const suspects = await db.execute<{ name: string }>(raw`
      SELECT c.table_name || '.' || c.column_name AS name
        FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND (c.column_name LIKE '%balance%' OR c.column_name LIKE '%owing%'
              OR c.column_name LIKE '%total%' OR c.column_name LIKE '%aging%'
              OR c.table_name LIKE '%aging%' OR c.table_name LIKE '%receivable%'
              OR c.table_name LIKE '%payable%'
              -- the shape the comment above names: a party column on some
              -- other table. journal_line.party_id is the ledger itself and is
              -- allowlisted; anything else holding one is a cache.
              OR (c.column_name LIKE '%party%' AND c.table_name NOT LIKE 'party%'))
       ORDER BY 1`)
    // P3 stores source identity -> existing party UUID, never an owing balance.
    const identityMappings = ['migration_party_map.source_party', 'migration_party_map.target_party_id']
    const unexpected = suspects.map((s) => s.name).filter((n) => !KNOWN.includes(n) && !identityMappings.includes(n))
    check(unexpected.length === 0,
      'P24 nothing caches what a party owes — the ledger is the only answer',
      unexpected.join(', ') || `${suspects.length} balance columns, all of them the ledger's own`)

    // The pair: the query does find things, so an empty result above is an
    // answer and not a query that matches nothing.
    check(suspects.length >= KNOWN.length,
      'P25 and the search that says so does find the caches that do exist',
      suspects.map((s) => s.name).join(', '))

    // And the record of who someone is, which is a control question.
    const [audited] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM audit_log
       WHERE table_name IN ('party', 'party_role') AND action LIKE '%party%'`)
    check(Number(audited.n) > 0,
      'P26 creating and changing a party is recorded', `${audited.n} audit rows`)

    // One primary contact, or "the primary contact" is a question with two
    // answers.
    const bellId = bell.id
    await db.execute(raw`
      INSERT INTO party_contact (party_id, name, email, is_primary)
      VALUES (${bellId}::uuid, 'Service', 'service@example.ca', true)`)
    await expectDbError('P27 a party has at most one primary contact',
      'party_one_primary_contact', () =>
        db.execute(raw`
          INSERT INTO party_contact (party_id, name, email, is_primary)
          VALUES (${bellId}::uuid, 'Someone else', 'else@example.ca', true)`))

    await expectDbError('P28a and a contact with nothing in it is not a contact',
      'party_contact_check', () =>
        db.execute(raw`INSERT INTO party_contact (party_id) VALUES (${bellId}::uuid)`))
  }

  // ------------------------------------------- the party survives the trip --

  {
    // Two places copy a line without being asked to think about the party, and
    // both would drop it silently. Neither is about parties at all, which is
    // why they are easy to miss: the aging is derived from the ledger, so a
    // reversal that forgets who it was about leaves the invoice standing in
    // their balance and puts the credit nowhere.
    const payer = await createParty({
      kind: 'organisation', name: 'Roundtrip Ltd.',
      roles: [{ entityId: alpha.company.id, role: 'customer', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })

    const invoice = await postEntry({
      ledgerId: alpha.ledger.id, entryDate: '2026-05-01', description: 'To be reversed',
      actor: 'alicio@example.test',
      lines: [
        { accountId: aAt('1200').id, amount: 70000n, partyId: payer.id },
        { accountId: aAt('4000').id, amount: -70000n },
      ],
    })
    const undone = await reverseEntry(invoice.entry.id, '2026-05-02', 'wrong amount', 'alicio@example.test')
    const [onReversal] = await db.execute<{ party_id: string | null; amount: bigint }>(raw`
      SELECT party_id::text, amount FROM journal_line
       WHERE entry_id = ${undone.reversal.id}::uuid AND account_id = ${aAt('1200').id}::uuid`)
    check(onReversal?.party_id === payer.id && onReversal.amount === -70000n,
      'P28 a reversal names the party the entry named',
      `${onReversal?.party_id?.slice(0, 8)} ${onReversal?.amount}`)

    // The consequence, which is what actually matters: their balance in the
    // ledger comes back to nothing. Read from the lines, because that is where
    // every aging question will be read from.
    const [owed] = await db.execute<{ total: string }>(raw`
      SELECT COALESCE(sum(jl.amount), 0)::text AS total
        FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
       WHERE jl.party_id = ${payer.id}::uuid AND je.status IN ('posted', 'reversed')`)
    check(owed.total === '0',
      'P29 so what they owe nets to nothing, read off the ledger', owed.total)

    // The other place: a draft. Saved with a party, posted later, still theirs.
    const draft = await saveDraft({
      ledgerId: alpha.ledger.id, entryDate: '2026-05-10', description: 'Drafted first',
      actor: 'alicio@example.test',
      lines: [
        { accountId: aAt('1200').id, amount: 40000n, partyId: payer.id },
        { accountId: aAt('4000').id, amount: -40000n },
      ],
    })
    const postedDraft = await postDraft(draft.id, 'alicio@example.test')
    const [onPosted] = await db.execute<{ party_id: string | null }>(raw`
      SELECT party_id::text FROM journal_line
       WHERE entry_id = ${postedDraft.id}::uuid AND account_id = ${aAt('1200').id}::uuid`)
    check(onPosted?.party_id === payer.id,
      'P30 and a draft posted later still names them', onPosted?.party_id?.slice(0, 8) ?? 'null')

    // Not a third copier. `amendEntry` takes its replacement lines from the
    // caller, so this is not a guard in `amendEntry` — it is proof that the
    // plumbing from `PostEntryLine` to the column survives that path, which is
    // where the `source_type` defect lived on opening balances.
    const amended = await amendEntry(postedDraft.id, {
      entryDate: '2026-05-10', description: 'Drafted first, corrected', actor: 'alicio@example.test',
      lines: [
        { accountId: aAt('1200').id, amount: 45000n, partyId: payer.id },
        { accountId: aAt('4000').id, amount: -45000n },
      ],
    }, 'alicio@example.test')
    const [onAmended] = await db.execute<{ party_id: string | null; amount: bigint }>(raw`
      SELECT party_id::text, amount FROM journal_line
       WHERE entry_id = ${amended.replacement.id}::uuid AND account_id = ${aAt('1200').id}::uuid`)
    check(onAmended?.party_id === payer.id && onAmended.amount === 45000n,
      'P31 and a correction reaches the party column too',
      `${onAmended?.party_id?.slice(0, 8)} ${onAmended?.amount}`)
  }

  // ------------------------------------------ the rule keeps being true --

  {
    // 0025 put the rule on INSERT. Adversarial review asked what happens
    // afterwards and found three ways an already-written line could end up
    // naming a party who held no role on its date. All three are shapes this
    // system has met before: 0010 froze a draft's ledger for the first, and
    // 0021 refuses reversing an entry that a bank row still depends on.
    const co = await createParty({
      kind: 'organisation', name: 'Afterwards Ltd.',
      roles: [{ entityId: alpha.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    const [role] = (await partyDetail(co.id))!.roles

    const bill = await postEntry({
      ledgerId: alpha.ledger.id, entryDate: '2026-08-01', description: 'While they supplied us',
      actor: 'alicio@example.test',
      lines: [
        { accountId: aAt('5000').id, amount: 22000n, partyId: co.id },
        { accountId: aAt('2000').id, amount: -22000n },
      ],
    })
    check(bill.entry.entryNo !== null, 'P37 an invoice is posted inside the role', bill.entry.entryNo ?? '')

    // 1 — ending the role before it. `endRole` is an ordinary exported function,
    //     not a hand-written UPDATE: this is reachable from the application.
    await expectError('P38 the role cannot be ended before something posted to it',
      'ROLE_STILL_NEEDED', () => endRole(role.id, '2026-06-30'), 'Afterwards Ltd.')

    // The pair: ending it after is ordinary and must stay possible.
    const ok = await endRole(role.id, '2026-09-30')
    check(ok.held_to === '2026-09-30',
      'P39 while ending it after that date is ordinary', ok.held_to ?? '')

    // 2 — deleting the role outright. `journal_line.party_id` points at the
    //     party, not the role, so nothing else objects.
    await expectDbError('P40 nor can it be deleted out from under the books',
      'ROLE_STILL_NEEDED', () =>
        byHand((tx) => tx.execute(raw`DELETE FROM party_role WHERE id = ${role.id}::uuid`)))

    // 3 — moving a draft's date out of the role. 0010 froze `ledger_id` for
    //     this exact shape and named it; the date was never frozen.
    //
    // Its own party, deliberately. Sharing `co` meant that when a mutation
    // switched off the role guard above, P40 really deleted the role and every
    // fixture below lost the party it depended on — the suite then DIED here
    // instead of reporting a red check, which is how a mutation block comes to
    // record a stack trace.
    const dated = await createParty({
      kind: 'organisation', name: 'Dated Inside Ltd.',
      roles: [{ entityId: alpha.company.id, role: 'supplier',
                heldFrom: '2026-01-01', heldTo: '2026-09-30' }],
      actor: 'alicio@example.test',
    })
    const draft = await saveDraft({
      ledgerId: alpha.ledger.id, entryDate: '2026-08-15', description: 'Dated inside for now',
      actor: 'alicio@example.test',
      lines: [
        { accountId: aAt('5000').id, amount: 5000n, partyId: dated.id },
        { accountId: aAt('2000').id, amount: -5000n },
      ],
    })
    await expectDbError('P41 and moving a draft past the role is refused too',
      'PARTY_NOT_TRADING', () =>
        byHand((tx) => tx.execute(raw`
          UPDATE journal_entry SET entry_date = '2026-12-01' WHERE id = ${draft.id}::uuid`)))

    // The pair, and the reason 0026 re-checks rather than freezing the date the
    // way 0010 froze the ledger: a draft's date is the thing most likely to
    // want changing. A trigger that refused every date change would leave P41
    // — and every other check here — green.
    await byHand((tx) => tx.execute(raw`
      UPDATE journal_entry SET entry_date = '2026-09-01' WHERE id = ${draft.id}::uuid`))
    const [moved0] = await db.execute<{ d: string }>(raw`
      SELECT entry_date::text AS d FROM journal_entry WHERE id = ${draft.id}::uuid`)
    check(moved0.d === '2026-09-01',
      'P41b while moving it to another date inside the role is allowed', moved0.d)

    // 4 — editing a draft's line to name someone with no role. The line UPDATE
    //     is permitted while the entry is a draft, and the guard was on INSERT.
    const stranger = await createParty({
      kind: 'organisation', name: 'Stranger Ltd.',
      roles: [{ entityId: beta.company.id, role: 'customer', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    await expectDbError('P42 and so is pointing a draft line at someone with no role here',
      'PARTY_NOT_TRADING', () =>
        db.execute(raw`
          UPDATE journal_line SET party_id = ${stranger.id}::uuid
           WHERE entry_id = ${draft.id}::uuid AND account_id = ${aAt('5000').id}::uuid`))

    // The pair for P42: a draft line CAN still be repointed at someone who does
    // hold a role, so the guard is about the role and not about refusing edits.
    const proper = await createParty({
      kind: 'organisation', name: 'Proper Supplier Ltd.',
      roles: [{ entityId: alpha.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    await db.execute(raw`
      UPDATE journal_line SET party_id = ${proper.id}::uuid
       WHERE entry_id = ${draft.id}::uuid AND account_id = ${aAt('5000').id}::uuid`)
    const [moved] = await db.execute<{ n: string }>(raw`
      SELECT p.name AS n FROM journal_line jl JOIN party p ON p.id = jl.party_id
       WHERE jl.entry_id = ${draft.id}::uuid AND jl.party_id IS NOT NULL`)
    check(moved?.n === 'Proper Supplier Ltd.',
      'P43 while repointing it at someone who does is allowed', moved?.n ?? 'none')

    // 5 — the reference table. `party_may_transact` gates on `transacts`, so
    //     flipping 'supplier' to false orphans every supplier-explained line at
    //     once. It looked like static seed data rather than like part of the
    //     rule, which is why no trigger watched it.
    await expectDbError('P44 a role cannot stop being one that trades while lines rely on it',
      'ROLE_KIND_STILL_NEEDED', async () => {
        // An unexpectedly accepted mutation must not poison later fixtures.
        // Flush deferred guards, then roll back even when no guard objected.
        const rollback = new Error('Rollback accepted reference-role probe')
        try {
          await db.transaction(async tx => {
            await tx.execute(raw`UPDATE party_role_definition SET transacts = false WHERE code = 'supplier'`)
            await tx.execute(raw`SET CONSTRAINTS ALL IMMEDIATE`)
            throw rollback
          })
        } catch (error) {
          if (error !== rollback) throw error
        }
      })

    // The pair: a role nothing relies on can be changed, so the guard is
    // about the lines and not about freezing the table. Since 0044 every
    // seeded role transacts (and P15's director line now RELIES on that), so
    // the demonstration uses a throwaway role no line can be relying on.
    await db.execute(raw`
      INSERT INTO party_role_definition (code, label, transacts, sort_order)
      VALUES ('advisor_test', 'Advisor (test)', true, 99)`)
    await db.execute(raw`
      UPDATE party_role_definition SET transacts = false WHERE code = 'advisor_test'`)
    const [flipped] = await db.execute<{ t: boolean }>(raw`
      SELECT transacts AS t FROM party_role_definition WHERE code = 'advisor_test'`)
    check(flipped.t === false,
      'P45 while one nothing relies on can be', 'the throwaway role flipped freely')
    await db.execute(raw`DELETE FROM party_role_definition WHERE code = 'advisor_test'`)

  }

  // ----------------------------------------------------------- the form --

  {
    // What the page actually runs. The library above is not the shipped path,
    // and the last time those two were checked as if they were the same thing,
    // the screen showed a uuid where a name belonged with everything green.
    const fd = (pairs: Record<string, string>) => {
      const f = new FormData()
      f.set(F.ledgerId, alpha.ledger.id)
      f.set(F.entityId, alpha.company.id)
      for (const [k, v] of Object.entries(pairs)) f.set(k, v)
      return f
    }

    const made = await createPartyFromForm(
      fd({ [F.name]: 'Formside Ltd.', [F.role]: 'supplier', [F.heldFrom]: '2026-01-01' }), 'alicio@example.test')
    check(made.ok === 'Added.'
          && (await partiesFor(alpha.company.id)).some((p) => p.name === 'Formside Ltd.'),
      'P32 the form adds a party with its role', made.ok ?? made.error ?? '')

    // Registration is not a lower boundary on the documents naming this party.
    const undated = await createPartyFromForm(
      fd({ [F.name]: 'No Date Ltd.', [F.role]: 'customer', [F.heldFrom]: '' }), 'alicio@example.test')
    const [undatedRole] = await db.execute<{ held_from: string | null }>(raw`
      SELECT held_from::text FROM party_role WHERE party_id = ${undated.madeId ?? null}::uuid`)
    check(undated.ok === 'Added.' && undatedRole?.held_from === null,
      'P33 the form creates a usable party without any start date', undated.ok ?? undated.error ?? '')

    const complete = await createPartyFromForm(fd({ [F.name]: 'Complete contact Ltd.', [F.role]: 'customer',
      [F.tradingName]: ' Complete trade ', [F.notes]: ' Internal only ', [F.contactName]: ' Pat Client ',
      [F.email]: ' accounts@example.test ', [F.phone]: ' +1 604 555 0123 ext. 9 ',
      [F.line1]: ' 125 Water Street ', [F.line2]: ' Suite 400 ', [F.city]: ' Vancouver ',
      [F.region]: ' BC ', [F.postalCode]: ' V6B 1A1 ', [F.country]: ' CA ' }), 'alicio@example.test')
    const completeDetail = complete.madeId ? await partyDetail(complete.madeId, alpha.company.id) : null
    const [completeTrail] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM audit_log
      WHERE table_name IN ('party_contact','party_address') AND context->>'partyId'=${complete.madeId ?? ''}
        AND actor='alicio@example.test'`)
    check(complete.ok === 'Added.' && completeDetail?.party.trading_name === 'Complete trade'
      && completeDetail.party.notes === 'Internal only' && completeDetail.contacts[0]?.is_primary
      && completeDetail.contacts[0].name === 'Pat Client' && completeDetail.contacts[0].email === 'accounts@example.test'
      && completeDetail.contacts[0].phone === '+1 604 555 0123 ext. 9' && completeDetail.addresses[0]?.purpose === 'mailing'
      && completeDetail.addresses[0].line1 === '125 Water Street' && completeDetail.addresses[0].line2 === 'Suite 400'
      && completeDetail.addresses[0].city === 'Vancouver' && completeDetail.addresses[0].region === 'BC'
      && completeDetail.addresses[0].postal_code === 'V6B 1A1' && completeDetail.addresses[0].country === 'CA' && completeTrail.n === 2,
      'P60 new Party stores complete contact and mailing address, normalized and audited under its creator')

    const phoneOnly = await createPartyFromForm(fd({ [F.name]: 'Phone only person', [F.kind]: 'person',
      [F.phone]: '+44 20 7946 0123', [F.country]: 'CA' }), 'alicio@example.test')
    const phoneDetail = phoneOnly.madeId ? await partyDetail(phoneOnly.madeId) : null
    check(phoneOnly.ok === 'Added.' && phoneDetail?.contacts[0]?.phone === '+44 20 7946 0123'
      && phoneDetail.contacts[0].email === null && phoneDetail.addresses.length === 0,
      'P61 phone-only contact needs neither email nor an address, and default country creates no empty address')

    const blank = await createPartyFromForm(fd({ [F.name]: 'Optional contact left blank', [F.contactName]: ' ',
      [F.email]: ' ', [F.phone]: ' ', [F.line1]: ' ', [F.country]: 'CA' }), 'alicio@example.test')
    const blankDetail = blank.madeId ? await partyDetail(blank.madeId) : null
    check(blank.ok === 'Added.' && blankDetail?.contacts.length === 0 && blankDetail.addresses.length === 0,
      'P62 optional contact and address fields leave no empty child records')

    const [{ n: beforeBadAddress }] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM audit_log`)
    const partial = await createPartyFromForm(fd({ [F.name]: 'Partial address rolls back', [F.city]: 'Vancouver',
      [F.email]: 'valid@example.test', [F.phone]: '604-555-9999' }), 'alicio@example.test')
    const [{ n: afterBadAddress }] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM audit_log`)
    const [partialParty] = await db.execute(raw`SELECT id FROM party WHERE name='Partial address rolls back'`)
    check(partial.error?.includes('first line') === true && !partialParty && beforeBadAddress === afterBadAddress,
      'P63 incomplete address refuses the whole create, including the Party, role, contact and audit rows')

    const badEmail = await createPartyFromForm(fd({ [F.name]: 'Invalid email cannot create', [F.email]: 'not an email',
      [F.line1]: '125 Water Street' }), 'alicio@example.test')
    const [badEmailParty] = await db.execute(raw`SELECT id FROM party WHERE name='Invalid email cannot create'`)
    check(badEmail.error === 'Enter a valid primary email address.' && !badEmailParty,
      'P64 direct form submissions also reject malformed email without creating any Party')

    const projectForm = fd({ [F.name]: 'Project contact survives forwarding', [F.entityId]: beta.company.id,
      [F.role]: 'supplier', [F.contactName]: 'Project accounts', [F.email]: 'project@example.test',
      [F.phone]: '604-555-1111', [F.line1]: '500 Supplier Road', [F.city]: 'Richmond', [F.region]: 'BC',
      [F.postalCode]: 'V6X 1A1', [F.country]: 'CA', [F.tradingName]: 'Project trade', [F.notes]: 'Project internal note' })
    const projectMade = await createProjectPartyFromForm(projectForm, 'alicio@example.test')
    const projectDetail = projectMade.madeId ? await partyDetail(projectMade.madeId) : null
    check(projectMade.ok === 'Added.' && projectDetail?.contacts[0]?.email === 'project@example.test'
      && projectDetail.contacts[0].name === 'Project accounts' && projectDetail.contacts[0].phone === '604-555-1111'
      && projectDetail.addresses[0]?.line1 === '500 Supplier Road' && projectDetail.addresses[0].city === 'Richmond'
      && projectDetail.party.trading_name === 'Project trade' && projectDetail.party.notes === 'Project internal note'
      && projectDetail.roles.length === 1 && projectDetail.roles[0].entity_id === alpha.company.id,
      'P65 project Party creation keeps all contact fields and derives company identity from the server ledger')

    // The duplicate the database catches comes back readable, not as an index
    // name. This is the seam: the library refuses first, but if it ever stops,
    // the page must not start printing constraint names at people.
    const dup = await createPartyFromForm(
      fd({ [F.name]: 'formside  ltd.', [F.role]: 'customer', [F.heldFrom]: '2026-01-01' }), 'alicio@example.test')
    // Both refusal paths say "already", so a check for that word passes whether
    // the library refused or the index did. The PREVIOUS version of this check
    // looked for that word and stayed green under mutation 111, which removes
    // the library check — that is what made it worth rewriting. It now asserts
    // what only the library produces: the name of the record you already have,
    // and what to do with it. Mutation 111 turns it red.
    check(dup.error?.includes('Formside Ltd. is already on the list') === true
          && dup.error?.includes('Add the role to that one') === true,
      'P34 a duplicate names the record that already exists, and the next move',
      dup.error ?? 'no error')

    const target = (await partiesFor(alpha.company.id)).find((p) => p.name === 'Formside Ltd.')!

    // Guarded: the failure mode being checked is the form THROWING instead of
    // returning a message, so an unguarded call would end the run here and take
    // the remaining checks with it — reporting a stack trace where a red check
    // belongs. This suite is not going to join the ones that died.
    let twice: Awaited<ReturnType<typeof grantRoleFromForm>> | null = null
    try {
      twice = await grantRoleFromForm(
        fd({ [F.partyId]: target.id, [F.role]: 'supplier', [F.heldFrom]: '2026-06-01' }), 'alicio@example.test')
    } catch (e) {
      fail('P35 and so does an overlapping role',
        `it threw instead of answering: ${errorText(e).slice(0, 70)}`)
    }
    if (twice) {
      check(twice.error?.includes('already recorded') === true
            && !twice.error?.includes('party_role_one_current'),
        'P35 and so does an overlapping role', twice.error ?? 'no error')
    }

    // The pair for P34: a role the party does not already hold goes in, so the
    // check above is about the overlap and not about the form refusing grants.
    const added = await grantRoleFromForm(
      fd({ [F.partyId]: target.id, [F.role]: 'customer', [F.heldFrom]: '2026-06-01' }), 'alicio@example.test')
    check(added.ok === 'Added.',
      'P36 while a role they do not hold is added', added.ok ?? added.error ?? '')
  }

  // ------------------------------------------------------------ management --
  // P46-P51: editing, deleting and resurrecting a record. The claims worth
  // checking are the refusals: a rename cannot create the duplicate the create
  // path refuses, and a delete cannot orphan a journal line.
  {
    const managed = await createParty({
      kind: 'organisation', name: 'Managed Ltd.',
      roles: [{ entityId: alpha.company.id, role: 'customer', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })

    // P46 — an edit lands, and trims what it stores.
    const renamed = await updateParty({
      partyId: managed.id, name: '  Managed Properly Ltd.  ',
      tradingName: 'MPL', taxNumber: '123456789RT0001', notes: 'renamed in P46',
    })
    check(renamed.name === 'Managed Properly Ltd.' && renamed.trading_name === 'MPL'
          && renamed.tax_number === '123456789RT0001',
      'P46 an edit lands, trimmed', `${renamed.name} / ${renamed.trading_name}`)

    // P47 — a rename cannot take a name that is already on the list. The create
    //       path refuses this; a rename that did not would be the same defect
    //       through the other door.
    try {
      await updateParty({ partyId: managed.id, name: 'acme  LTD.' })
      fail('P47 a rename cannot take a living name', 'it was renamed onto Acme Ltd.')
    } catch (e) {
      check((e as PartyError).code === 'DUPLICATE_NAME'
            && (e as Error).message.includes('Acme Ltd.'),
        'P47 a rename cannot take a living name', (e as Error).message.slice(0, 60))
    }

    // P47b — and renaming a record TO ITSELF is not a duplicate of itself.
    const same = await updateParty({ partyId: managed.id, name: 'Managed Properly Ltd.' })
    check(same.name === 'Managed Properly Ltd.',
      'P47b while renaming a record to itself is fine', same.name)

    // P48 — a party nothing refers to can truly be deleted, satellites and all.
    await setAddress({ partyId: managed.id, purpose: 'mailing', line1: '1 Test St' })
    await deleteParty(managed.id)
    check((await partyDetail(managed.id)) === null,
      'P48 a party the books never met can be deleted', 'record and satellites gone')

    // P49 — one the books DID meet cannot: the journal line explains itself by
    //       this row, and the database is the one refusing. The sentence names
    //       the way out.
    const acme = (await partiesFor(alpha.company.id)).find((p) => p.name === 'Acme Ltd.')!
    try {
      await deleteParty(acme.id)
      fail('P49 a party on a journal line cannot be deleted', 'it was deleted')
    } catch (e) {
      check((e as PartyError).code === 'IN_USE'
            && (e as Error).message.includes('journal lines')
            && (e as Error).message.includes('Deactivate it instead'),
        'P49 a party on a journal line cannot be deleted', (e as Error).message.slice(0, 70))
    }

    // P50 — deactivate frees the name; reactivating while it is taken is
    //       refused, because the duplicate index only watches active rows and
    //       this is the gate that stands in for it.
    const first = await createParty({
      kind: 'organisation', name: 'Phoenix Ltd.',
      roles: [{ entityId: alpha.company.id, role: 'customer', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    await deactivateParty(first.id)
    const second = await createParty({
      kind: 'organisation', name: 'Phoenix Ltd.',
      roles: [{ entityId: alpha.company.id, role: 'customer', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    try {
      await reactivateParty(first.id)
      fail('P50 reactivating under a taken name is refused', 'two active Phoenix Ltd.')
    } catch (e) {
      check((e as PartyError).code === 'NAME_TAKEN',
        'P50 reactivating under a taken name is refused', (e as Error).message.slice(0, 60))
    }

    // P51 — with the name free again, reactivation is the undo it claims to be.
    await deactivateParty(second.id)
    const back = await reactivateParty(first.id)
    check(back.is_active === true,
      'P51 with the name free, reactivation is the undo', `${back.name} is back`)
  }

  // P54 — the screen's rename door says who. `updatePartyFromForm` took no
  //       actor at all, so the trigger's update_party row for a rename or a
  //       new tax number said 'system' — a name the trail check cannot see
  //       through, because 'system' is a real value (critic, 2026-09-06).
  {
    const renamed = await createParty({
      kind: 'organisation', name: 'Renameable Ltd.',
      roles: [{ entityId: alpha.company.id, role: 'customer', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    const form = new FormData()
    form.set(F.ledgerId, alpha.ledger.id)  // the screen's form always says which books
    form.set(F.partyId, renamed.id); form.set(F.name, 'Renamed Ltd.'); form.set(F.taxNumber, '12345 6789 RT0001')
    const saved = await updatePartyFromForm(form, 'pat@x.test')
    const [row] = await db.execute<{ actor: string; after: { name: string } }>(raw`
      SELECT actor, after FROM audit_log
       WHERE table_name = 'party' AND action = 'update_party' AND record_id = ${renamed.id}
       ORDER BY id DESC LIMIT 1`)
    check(saved.ok === 'Saved.' && row?.actor === 'pat@x.test' && row?.after?.name === 'Renamed Ltd.',
      'P54 renaming a party from the screen is trailed under the person who did it',
      row ? `${row.actor} renamed it to ${row.after?.name}` : `no update_party row; ${saved.error ?? ''}`)
  }

  // P55 — THE ID BESIDE THE LEDGER. A party is one record shared by every
  //       company it deals with; the doors read a party id (or a role id) out
  //       of the form and judged only the ledger beside it, so a person with
  //       the Parties seat on Alpha could rename, retire or delete a supplier
  //       only Beta deals with, or end Beta's role with it (audit, 2026-09-13).
  //       Each door now asks `ours()` — for a party, "has THIS company given
  //       it a role"; for a role, "is it this company's role".
  {
    const betaOnly = await createParty({
      kind: 'organisation', name: 'Beta Only Ltd.',
      roles: [{ entityId: beta.company.id, role: 'supplier', heldFrom: '2026-01-01' }], actor: 'alicio@example.test',
    })
    const [betaRole] = await db.execute<{ id: string }>(raw`
      SELECT id::text FROM party_role WHERE party_id = ${betaOnly.id}::uuid AND entity_id = ${beta.company.id}::uuid`)
    const withAlpha = (fields: Record<string, string>) => {
      const fd = new FormData()
      fd.set(F.ledgerId, alpha.ledger.id)                    // Alpha's ledger, always
      for (const [k, v] of Object.entries(fields)) fd.set(k, v)
      return fd
    }
    const REFUSED = "not in this company's books"
    const cases: Array<[string, () => Promise<{ error?: string; ok?: string }>]> = [
      ['rename', () => updatePartyFromForm(withAlpha({ [F.partyId]: betaOnly.id, [F.name]: 'Alpha Took It Ltd.' }), 'alicio@example.test')],
      ['address', () => setAddressFromForm(withAlpha({ [F.partyId]: betaOnly.id, [F.purpose]: 'mailing', [F.line1]: '1 Alpha Way', [F.city]: 'Vancouver', [F.region]: 'BC', [F.postalCode]: 'V6B 1A1', [F.country]: 'CA' }))],
      ['retire', () => deactivatePartyFromForm(withAlpha({ [F.partyId]: betaOnly.id }), 'alicio@example.test')],
      ['restore', () => reactivatePartyFromForm(withAlpha({ [F.partyId]: betaOnly.id }), 'alicio@example.test')],
      ['delete', () => deletePartyFromForm(withAlpha({ [F.partyId]: betaOnly.id }))],
      ['end role', () => endRoleFromForm(withAlpha({ [F.roleId]: betaRole!.id, [F.heldTo]: '2026-06-30' }))],
      ['grant in Beta', () => grantRoleFromForm(withAlpha({ [F.entityId]: beta.company.id, [F.partyId]: betaOnly.id, [F.role]: 'customer', [F.heldFrom]: '2026-01-01' }), 'alicio@example.test')],
      ['create in Beta', () => createPartyFromForm(withAlpha({ [F.entityId]: beta.company.id, [F.name]: 'Planted In Beta Ltd.', [F.kind]: 'organisation', [F.role]: 'supplier', [F.heldFrom]: '2026-01-01' }), 'alicio@example.test')],
    ]
    const wrong: string[] = []
    for (const [label, fn] of cases) {
      const r = await fn()
      if (!r.error || !r.error.includes(REFUSED)) wrong.push(`${label}: ${r.error ?? r.ok ?? 'nothing said'}`)
    }
    const [still] = await db.execute<{ name: string; is_active: boolean; roles: string; held_to: string | null; planted: string }>(raw`
      SELECT p.name, p.is_active,
             (SELECT count(*) FROM party_role pr WHERE pr.party_id = p.id)::text AS roles,
             (SELECT held_to::text FROM party_role pr WHERE pr.id = ${betaRole!.id}::uuid) AS held_to,
             (SELECT count(*) FROM party WHERE name = 'Planted In Beta Ltd.')::text AS planted
        FROM party p WHERE p.id = ${betaOnly.id}::uuid`)
    check(wrong.length === 0 && still?.name === 'Beta Only Ltd.' && still?.is_active === true && still?.roles === '1' && still?.held_to === null && still?.planted === '0',
      "P55 touching a party only another company deals with, under this ledger, is refused before anything happens",
      wrong.length ? wrong.join('; ') : `eight doors refused; still "${still?.name}", active, ${still?.roles} role(s), the role still open, nothing planted in Beta`)
  }

  // P56 — A ROLE GIVEN WITH THE WRONG DATES, OR BY MISTAKE, IS PUT RIGHT; AN
  //       ADDRESS IS REMOVED (0084). The owner: 「所有的紀錄儘量都可以編輯刪除」.
  //       Kestrel supplies Alpha from 2026-02-01 and is named on an entry of
  //       2026-02-15. Moving the start past that entry is refused and names it;
  //       moving it earlier goes; the supplier role cannot be deleted while
  //       the entry rests on it; a customer role given by mistake is deleted;
  //       dates overlapping another term of the same role are refused; an
  //       employee role a payroll record needs is refused; the address goes.
  {
    const A = 'alicio@example.test'
    const kestrel = await createParty({ kind: 'organisation', name: 'Kestrel Supply Ltd.',
      roles: [{ entityId: alpha.company.id, role: 'supplier', heldFrom: '2026-02-01' }], actor: A })
    await postEntry({ ledgerId: alpha.ledger.id, entryDate: '2026-02-15', description: 'Kestrel bill', actor: A,
      lines: [{ accountId: aAt('5000').id, amount: 50000n }, { accountId: aAt('2000').id, amount: -50000n, partyId: kestrel.id }] })
    const roleOf = async (role: string) => (await db.execute<{ id: string; held_from: string; held_to: string | null }>(raw`
      SELECT id::text, held_from::text, held_to::text FROM party_role
       WHERE party_id = ${kestrel.id}::uuid AND entity_id = ${alpha.company.id}::uuid AND role = ${role} ORDER BY held_from`))
    const form = (fields: Record<string, string>) => {
      const fd = new FormData()
      fd.set(F.ledgerId, alpha.ledger.id)
      for (const [k, v] of Object.entries(fields)) fd.set(k, v)
      return fd
    }
    const supplier = (await roleOf('supplier'))[0]
    const pastEntry = await correctRoleFromForm(form({ [F.roleId]: supplier.id, [F.heldFrom]: '2026-03-01', [F.heldTo]: '' }), A)
    const earlier = await correctRoleFromForm(form({ [F.roleId]: supplier.id, [F.heldFrom]: '2025-06-01', [F.heldTo]: '' }), A)
    const afterEarlier = (await roleOf('supplier'))[0]
    const supplierGone = await deleteRoleFromForm(form({ [F.roleId]: supplier.id }), A)
    await grantRole({ partyId: kestrel.id, entityId: alpha.company.id, role: 'customer', heldFrom: '2026-01-01', actor: A })
    const customer = (await roleOf('customer'))[0]
    const customerGone = await deleteRoleFromForm(form({ [F.roleId]: customer.id }), A)
    const customersLeft = (await roleOf('customer')).length
    await endRole(supplier.id, '2026-06-30')
    await grantRole({ partyId: kestrel.id, entityId: alpha.company.id, role: 'supplier', heldFrom: '2026-09-01', actor: A })
    const overlap = await correctRoleFromForm(form({ [F.roleId]: supplier.id, [F.heldFrom]: '2025-06-01', [F.heldTo]: '' }), A)
    const wren = await createParty({ kind: 'person', name: 'Wren Payroll',
      roles: [{ entityId: alpha.company.id, role: 'employee', heldFrom: '2026-01-01' }], actor: A })
    await saveEmployee({ ledgerId: alpha.ledger.id, partyId: wren.id, frequency: 'monthly', actor: A })
    const [wrenRole] = await db.execute<{ id: string }>(raw`SELECT id::text FROM party_role WHERE party_id = ${wren.id}::uuid`)
    const onPayroll = await deleteRoleFromForm(form({ [F.roleId]: wrenRole.id }), A)
    await setAddress({ partyId: kestrel.id, purpose: 'mailing', line1: '9 Wrong Way', city: 'Nowhere' })
    const addressGone = await deleteAddressFromForm(form({ [F.partyId]: kestrel.id, [F.purpose]: 'mailing' }), A)
    const [addressTrail] = await db.execute<{ actor: string; before: { line1?: string } }>(raw`
      SELECT actor, before FROM audit_log WHERE action = 'delete_party_address' AND record_id = ${kestrel.id} ORDER BY id DESC LIMIT 1`)
    const roleTrail = await db.execute<{ action: string; actor: string; before: { held_from?: string } | null; after: { held_from?: string } | null }>(raw`
      SELECT action, actor, before, after FROM audit_log WHERE table_name = 'party_role' AND record_id IN (${supplier.id}, ${customer.id})
         AND action IN ('amend_party_role', 'delete_party_role') ORDER BY id`)
    const [addresses] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM party_address WHERE party_id = ${kestrel.id}::uuid`)
    check(pastEntry.ok !== undefined && earlier.ok !== undefined && afterEarlier.held_from === '2026-02-01'
          && supplierGone.error?.includes('2026-02-15') === true && customerGone.ok !== undefined && customersLeft === 0
          && overlap.error === 'That role is already recorded here. End it before adding it again.'
          && onPayroll.error?.includes('payroll record') === true && addressGone.ok !== undefined && addresses.n === 0
          // The trail names the person who corrected or removed, with the dates as they were (0085).
          && addressTrail?.actor === A && addressTrail.before?.line1 === '9 Wrong Way'
          && roleTrail.some((t) => t.action === 'amend_party_role' && t.actor === A && t.before?.held_from === '2026-02-01' && t.after?.held_from === '2026-02-01')
          && roleTrail.some((t) => t.action === 'delete_party_role' && t.actor === A),
      "P56 role endings remain editable and audited, obsolete start inputs are ignored, and required roles remain protected",
      `start past the entry: ${(pastEntry.error ?? 'SAVED').slice(0, 70)}; earlier: ${afterEarlier.held_from}; delete the supplier: `
        + `${(supplierGone.error ?? 'DELETED').slice(0, 50)}; the mistaken customer role: ${customerGone.ok ?? customerGone.error} (${customersLeft} left); `
        + `overlap: ${overlap.error ?? 'SAVED'}; on the payroll: ${(onPayroll.error ?? 'DELETED').slice(0, 50)}; address: ${addressGone.ok ?? addressGone.error} (${addresses.n} left)`)
  }

  {
    const future = await createParty({ kind: 'person', name: 'Legacy future role', actor: 'alicio@example.test',
      roles: [{ entityId: alpha.company.id, role: 'customer', heldFrom: '2099-01-01' },
        { entityId: alpha.company.id, role: 'director', heldFrom: '2099-01-01' }] })
    const saved = await postEntry({ ledgerId: alpha.ledger.id, entryDate: '2026-01-15', description: 'Before legacy registration', actor: 'alicio@example.test',
      lines: [{ accountId: aAt('1200').id, amount: 1000n, partyId: future.id }, { accountId: aAt('4000').id, amount: -1000n }] })
    const choices = await partyChoices(alpha.company.id, '2026-01-15')
    const funding = await shareholderDirectorChoices(alpha.company.id, '2026-01-15')
    const bank = bankPartyOptions(await transactingPartyRoles(alpha.company.id), '2026-01-15', false)
    check(!!saved.entry.entryNo && choices.customers.some(p => p.id === future.id)
      && funding.some(p => p.id === future.id) && bank.some(p => p.id === future.id),
      'P57 legacy start dates cannot hide or refuse a party on historical entries or form choices', 'journal, invoice choices, funding choices and bank choices agree')
    const guarded = await createParty({ kind: 'organisation', name: 'Legacy future supplier with history', actor: 'alicio@example.test',
      roles: [{ entityId: alpha.company.id, role: 'supplier', heldFrom: '2099-01-01' }] })
    await postEntry({ ledgerId: alpha.ledger.id, entryDate: '2026-01-16', description: 'Protect history before legacy start', actor: 'alicio@example.test',
      lines: [{ accountId: aAt('5000').id, amount: 1000n, partyId: guarded.id }, { accountId: aAt('2000').id, amount: -1000n }] })
    const [role] = await db.execute<{ id: string }>(raw`SELECT id::text FROM party_role WHERE party_id = ${guarded.id}::uuid`)
    await expectError('P58 ending a role still cannot orphan history earlier than a legacy start', 'ROLE_STILL_NEEDED',
      () => endRole(role.id, '2026-01-01', 'alicio@example.test'), '2026-01-16')
  }

  await trailNamesPeople(check, 'P53 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main()

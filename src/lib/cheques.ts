import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting } from './acting'
import { deleteEntryCore, editEntryCore, postEntryCore, reverseEntryCore } from './posting'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type SourceKind = 'expense' | 'payment' | 'payroll' | 'manual'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

export class ChequeError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function validId(id: string) {
  if (!UUID.test(id)) throw new ChequeError('BAD_ID', 'That cheque or transaction does not exist.')
}
function validDate(date: string) {
  const parsed = DATE.test(date) ? new Date(`${date}T00:00:00Z`) : null
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new ChequeError('BAD_DATE', 'Choose a valid cheque date.')
  }
}
function validText(text: string, label: string, max = 200) {
  if (!text.trim() || text.trim().length > max) {
    throw new ChequeError('BAD_TEXT', `${label} must be between 1 and ${max} characters.`)
  }
  return text.trim()
}
function validMemo(memo: string) {
  if (memo.trim().length > 500) throw new ChequeError('BAD_TEXT', 'Memo must be at most 500 characters.')
  return memo.trim()
}
function validAddress(address: string) {
  if (address.trim().length > 300) throw new ChequeError('BAD_TEXT', 'Payee address must be at most 300 characters.')
  return address.trim()
}

export type ChequeSource = {
  source_kind: Exclude<SourceKind, 'manual'>
  entry_id: string
  pay_stub_id: string | null
  bank_account_id: string
  cheque_date: string
  amount: string
  payee: string
  party_id: string | null
  payee_address: string
  memo: string
  source_entry_no: string
  pay_run_id?: string
  employee_id?: string
}

/** Read the outflow itself. The amount and account are never accepted from a form. */
export async function chequeSource(ledgerId: string, opts: { entryId?: string; stubId?: string }, tx: Tx | typeof db = db): Promise<ChequeSource | null> {
  if (opts.stubId) {
    validId(opts.stubId)
    const [row] = await tx.execute<Omit<ChequeSource, 'source_kind'>>(sql`
      SELECT je.id::text AS entry_id, ps.id::text AS pay_stub_id,
             pr.bank_account_id::text, pr.pay_date::text AS cheque_date,
             ps.net_pay::text AS amount, p.name AS payee, p.id::text AS party_id,
             coalesce((SELECT concat_ws(E'\n', a.line1, nullif(a.line2, ''),
                                      concat_ws(' ', a.city, a.region, a.postal_code))
                       FROM party_address a JOIN party_address_purpose pp ON pp.code = a.purpose
                       WHERE a.party_id = p.id ORDER BY pp.sort_order, a.purpose LIMIT 1), '') AS payee_address,
             ('Payroll ' || pr.pay_date::text) AS memo, je.entry_no AS source_entry_no,
             pr.id::text AS pay_run_id, pe.id::text AS employee_id
        FROM pay_stub ps JOIN pay_run pr ON pr.id = ps.pay_run_id
        JOIN journal_entry je ON je.id = pr.entry_id
        JOIN payroll_employee pe ON pe.id = ps.employee_id
        JOIN party p ON p.id = pe.party_id
       WHERE ps.id = ${opts.stubId}::uuid AND pr.ledger_id = ${ledgerId}::uuid
         AND je.status = 'posted' AND ps.net_pay > 0
       FOR UPDATE OF je`)
    return row ? { ...row, source_kind: 'payroll' } : null
  }
  if (!opts.entryId) return null
  validId(opts.entryId)
  const [row] = await tx.execute<{
    entry_id: string; source_type: string; bank_account_id: string; cheque_date: string
    amount: string; payee: string; party_id: string | null; payee_address: string; memo: string; source_entry_no: string
  }>(sql`
    SELECT je.id::text AS entry_id, je.source_type,
           bank.account_id::text AS bank_account_id, je.entry_date::text AS cheque_date,
           (-bank.amount)::text AS amount,
           CASE WHEN je.source_type = 'payment' THEN payee.name
                ELSE coalesce(expense_payee.name, je.description) END AS payee,
           CASE WHEN je.source_type = 'payment' THEN payee.id::text
                ELSE expense_payee.id::text END AS party_id,
           coalesce((SELECT concat_ws(E'\n', a.line1, nullif(a.line2, ''),
                                      concat_ws(' ', a.city, a.region, a.postal_code))
                       FROM party_address a JOIN party_address_purpose pp ON pp.code = a.purpose
                       WHERE a.party_id = CASE WHEN je.source_type = 'payment' THEN payee.id ELSE expense_payee.id END
                       ORDER BY pp.sort_order, a.purpose LIMIT 1), '') AS payee_address,
           je.description AS memo, je.entry_no AS source_entry_no
      FROM journal_entry je
      JOIN LATERAL (
        SELECT jl.account_id, jl.amount FROM journal_line jl
        JOIN account_role ar ON ar.account_id = jl.account_id AND ar.role = 'cash_and_cash_equivalents'
        WHERE jl.entry_id = je.id AND jl.amount < 0 LIMIT 1
      ) bank ON true
      LEFT JOIN LATERAL (
        SELECT p.id, p.name FROM journal_line jl JOIN party p ON p.id = jl.party_id
        WHERE jl.entry_id = je.id LIMIT 1
      ) expense_payee ON true
      LEFT JOIN LATERAL (
        SELECT p.id, p.name FROM invoice_application ia
        JOIN invoice i ON i.id = ia.invoice_id AND i.direction = 'purchase'
        JOIN party p ON p.id = i.party_id
        WHERE ia.entry_id = je.id LIMIT 1
      ) payee ON true
     WHERE je.id = ${opts.entryId}::uuid AND je.ledger_id = ${ledgerId}::uuid
       AND je.status = 'posted' AND je.source_type IN ('quick_expense', 'payment')
       AND (je.source_type = 'quick_expense' OR payee.name IS NOT NULL)
     FOR UPDATE OF je`)
  if (!row) return null
  return {
    source_kind: row.source_type === 'payment' ? 'payment' : 'expense',
    entry_id: row.entry_id, pay_stub_id: null, bank_account_id: row.bank_account_id,
    cheque_date: row.cheque_date, amount: row.amount, payee: row.payee, party_id: row.party_id,
    payee_address: row.payee_address,
    memo: row.memo, source_entry_no: row.source_entry_no,
  }
}

export async function chequeChoices(ledgerId: string) {
  return Promise.all([
    db.execute<{ id: string; code: string; name: string; last_number: string }>(sql`
      SELECT a.id::text, a.code, a.name, coalesce(s.last_number, 0)::text AS last_number
        FROM account a JOIN account_role ar ON ar.account_id = a.id AND ar.role = 'cash_and_cash_equivalents'
        LEFT JOIN cheque_sequence s ON s.bank_account_id = a.id
       WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
         AND a.is_active AND a.is_postable ORDER BY a.code`),
    db.execute<{ id: string; code: string; name: string }>(sql`
      SELECT id::text, code, name FROM account
       WHERE entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
         AND account_type = 'expense' AND is_active AND is_postable ORDER BY code`),
  ])
}

export async function chequeParties(ledgerId: string, selectedPartyId?: string) {
  if (selectedPartyId) validId(selectedPartyId)
  return db.execute<{ id: string; name: string; address: string; roles: string }>(sql`
    SELECT p.id::text, p.name,
           coalesce((SELECT concat_ws(E'\n', a.line1, nullif(a.line2, ''),
                                      concat_ws(' ', a.city, a.region, a.postal_code))
                       FROM party_address a JOIN party_address_purpose pp ON pp.code = a.purpose
                      WHERE a.party_id = p.id ORDER BY pp.sort_order, a.purpose LIMIT 1), '') AS address,
           string_agg(DISTINCT rd.label, ', ' ORDER BY rd.label) AS roles
      FROM party p JOIN party_role pr ON pr.party_id = p.id
      JOIN party_role_definition rd ON rd.code = pr.role AND rd.transacts
      JOIN ledger l ON l.entity_id = pr.entity_id
     WHERE l.id = ${ledgerId}::uuid
       AND (p.is_active OR p.id = ${selectedPartyId ?? null}::uuid)
     GROUP BY p.id, p.name ORDER BY p.name`)
}

async function validateChequeParty(tx: Tx, ledgerId: string, partyId: string | undefined, on: string) {
  if (!partyId) return
  validId(partyId)
  const [row] = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM ledger l JOIN party p ON p.id = ${partyId}::uuid
      WHERE l.id = ${ledgerId}::uuid AND p.is_active
        AND party_may_transact(p.id, l.entity_id, ${on}::date)) AS ok`)
  if (!row?.ok) throw new ChequeError('BAD_PARTY', 'Choose a Party that can transact with this company on the cheque date, or use a one-time payee.')
}

/** One read for the visible Expenses rows; only bank outflows that chequeSource accepts get an action. */
export async function chequeActionsForEntries(ledgerId: string, entryIds: string[]) {
  const ids = [...new Set(entryIds)]
  if (!ids.length) return {} as Record<string, string | null>
  ids.forEach(validId)
  const rows = await db.execute<{ entry_id: string; cheque_id: string | null }>(sql`
    SELECT je.id::text AS entry_id, c.id::text AS cheque_id
      FROM journal_entry je
      LEFT JOIN cheque c ON c.entry_id = je.id AND c.status = 'issued'
     WHERE je.ledger_id = ${ledgerId}::uuid AND je.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       AND je.status = 'posted' AND je.source_type IN ('quick_expense', 'payment')
       AND EXISTS (SELECT 1 FROM journal_line jl JOIN account_role ar
                     ON ar.account_id = jl.account_id AND ar.role = 'cash_and_cash_equivalents'
                   WHERE jl.entry_id = je.id AND jl.amount < 0)
       AND (je.source_type = 'quick_expense' OR EXISTS (
         SELECT 1 FROM invoice_application ia JOIN invoice i ON i.id = ia.invoice_id
          WHERE ia.entry_id = je.id AND i.direction = 'purchase'))`)
  return Object.fromEntries(rows.map((r) => [r.entry_id, r.cheque_id])) as Record<string, string | null>
}

async function numberFor(tx: Tx, ledgerId: string, bankId: string, starting?: bigint) {
  if (starting !== undefined && starting < 1n) throw new ChequeError('BAD_NUMBER', 'The first cheque number must be positive.')
  await tx.execute(sql`
    INSERT INTO cheque_sequence (bank_account_id, ledger_id, last_number)
    VALUES (${bankId}::uuid, ${ledgerId}::uuid, ${starting === undefined ? 0n : starting - 1n})
    ON CONFLICT (bank_account_id) DO NOTHING`)
  const [seq] = await tx.execute<{ ledger_id: string; last_number: bigint }>(sql`
    SELECT ledger_id::text, last_number FROM cheque_sequence
     WHERE bank_account_id = ${bankId}::uuid FOR UPDATE`)
  if (!seq || seq.ledger_id !== ledgerId) throw new ChequeError('WRONG_BANK', 'That bank account belongs to another company.')
  const number = BigInt(seq.last_number) + 1n
  await tx.execute(sql`
    UPDATE cheque_sequence SET last_number = ${number} WHERE bank_account_id = ${bankId}::uuid`)
  return number
}

export async function issueCheque(input: {
  ledgerId: string; entryId?: string; stubId?: string; actor: string; startingNumber?: bigint
}) {
  if (!input.entryId && !input.stubId) throw new ChequeError('NO_SOURCE', 'Choose an expense, invoice payment or pay stub.')
  return db.transaction(async (tx) => {
    await acting(tx, input.actor)
    const source = await chequeSource(input.ledgerId, input, tx)
    if (!source) throw new ChequeError('NO_SOURCE', 'That posted outflow cannot make a cheque.')
    const [already] = await tx.execute<{ id: string }>(sql`
      SELECT id::text FROM cheque
       WHERE ${source.pay_stub_id ? sql`pay_stub_id = ${source.pay_stub_id}::uuid` : sql`entry_id = ${source.entry_id}::uuid`}
       AND status = 'issued' LIMIT 1`)
    if (already) return already.id
    const number = await numberFor(tx, input.ledgerId, source.bank_account_id, input.startingNumber)
    const [made] = await tx.execute<{ id: string }>(sql`
      INSERT INTO cheque (ledger_id, bank_account_id, number, cheque_date, payee, party_id, payee_address,
                          amount, memo, source_kind, entry_id, pay_stub_id,
                          source_entry_no, created_by, updated_by)
      VALUES (${input.ledgerId}::uuid, ${source.bank_account_id}::uuid, ${number},
              ${source.cheque_date}::date, ${source.payee}, ${source.party_id}::uuid, ${source.payee_address}, ${source.amount}::bigint,
              ${source.memo}, ${source.source_kind}, ${source.entry_id}::uuid,
              ${source.pay_stub_id}::uuid, ${source.source_entry_no}, ${input.actor}, ${input.actor})
      RETURNING id::text`)
    return made.id
  })
}

export async function createManualCheque(input: {
  ledgerId: string; bankAccountId: string; expenseAccountId: string; chequeDate: string
  payee: string; partyId?: string; payeeAddress?: string; amount: bigint; memo: string; actor: string; startingNumber?: bigint
}) {
  validId(input.bankAccountId); validId(input.expenseAccountId); validDate(input.chequeDate)
  const payee = validText(input.payee, 'Payee')
  const payeeAddress = validAddress(input.payeeAddress ?? '')
  const memo = validMemo(input.memo)
  if (input.amount <= 0n) throw new ChequeError('BAD_AMOUNT', 'The cheque amount must be positive.')
  return db.transaction(async (tx) => {
    await acting(tx, input.actor)
    await validateChequeParty(tx, input.ledgerId, input.partyId, input.chequeDate)
    const [accounts] = await tx.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM account a JOIN ledger l ON l.entity_id = a.entity_id
         WHERE l.id = ${input.ledgerId}::uuid AND a.id = ${input.expenseAccountId}::uuid
           AND a.account_type = 'expense' AND a.is_active AND a.is_postable
      ) AND EXISTS (
        SELECT 1 FROM account a JOIN ledger l ON l.entity_id = a.entity_id
        JOIN account_role ar ON ar.account_id = a.id AND ar.role = 'cash_and_cash_equivalents'
         WHERE l.id = ${input.ledgerId}::uuid AND a.id = ${input.bankAccountId}::uuid
           AND a.is_active AND a.is_postable
      ) AS ok`)
    if (!accounts.ok) throw new ChequeError('BAD_ACCOUNT', 'Choose an active expense account and bank account of this company.')
    const number = await numberFor(tx, input.ledgerId, input.bankAccountId, input.startingNumber)
    const posted = await postEntryCore(tx, {
      ledgerId: input.ledgerId, entryDate: input.chequeDate,
      description: `Cheque ${number} — ${payee}${memo ? ` — ${memo}` : ''}`,
      sourceType: 'quick_expense', actor: input.actor,
      lines: [
        { accountId: input.expenseAccountId, amount: input.amount, description: memo || payee, partyId: input.partyId },
        { accountId: input.bankAccountId, amount: -input.amount, description: `Cheque ${number}` },
      ],
    })
    const [made] = await tx.execute<{ id: string }>(sql`
      INSERT INTO cheque (ledger_id, bank_account_id, number, cheque_date, payee, party_id, payee_address,
                          amount, memo, source_kind, entry_id, source_entry_no, created_by, updated_by)
      VALUES (${input.ledgerId}::uuid, ${input.bankAccountId}::uuid, ${number},
              ${input.chequeDate}::date, ${payee}, ${input.partyId ?? null}::uuid, ${payeeAddress}, ${input.amount}, ${memo},
              'manual', ${posted.entry.id}::uuid, ${posted.entry.entryNo}, ${input.actor}, ${input.actor})
      RETURNING id::text`)
    return made.id
  })
}

export type ChequeRow = {
  id: string; ledger_id: string; bank_account_id: string; bank_code: string; bank_name: string
  number: string; cheque_date: string; payee: string; party_id: string | null; payee_address: string; amount: string; memo: string
  source_kind: SourceKind; entry_id: string | null; pay_stub_id: string | null
  expense_account_id: string | null; expense_account_label: string | null
  source_entry_no: string; status: string; source_status: string | null
  source_matches: boolean
  void_reason: string | null; pay_run_id: string | null; employee_id: string | null
}
const CHEQUE_SELECT = sql`
  SELECT c.id::text, c.ledger_id::text, c.bank_account_id::text,
         a.code AS bank_code, a.name AS bank_name, c.number::text,
         c.cheque_date::text, c.payee, c.party_id::text, c.payee_address, c.amount::text, c.memo, c.source_kind,
         c.entry_id::text, c.pay_stub_id::text, c.source_entry_no, c.status,
         (SELECT jl.account_id::text FROM journal_line jl JOIN account ea ON ea.id = jl.account_id
           WHERE jl.entry_id = c.entry_id AND ea.account_type = 'expense'
           ORDER BY jl.line_no LIMIT 1) AS expense_account_id,
         (SELECT ea.code || ' — ' || ea.name FROM journal_line jl JOIN account ea ON ea.id = jl.account_id
           WHERE jl.entry_id = c.entry_id AND ea.account_type = 'expense'
           ORDER BY jl.line_no LIMIT 1) AS expense_account_label,
         je.status AS source_status,
         CASE WHEN c.source_kind = 'payroll' THEN
           EXISTS (SELECT 1 FROM pay_stub ps2 JOIN pay_run pr2 ON pr2.id = ps2.pay_run_id
                    WHERE ps2.id = c.pay_stub_id AND pr2.entry_id = c.entry_id
                      AND pr2.bank_account_id = c.bank_account_id AND ps2.net_pay = c.amount)
         ELSE EXISTS (SELECT 1 FROM journal_line jl
                       WHERE jl.entry_id = c.entry_id AND jl.account_id = c.bank_account_id
                         AND jl.amount = -c.amount) END AS source_matches,
         c.void_reason,
         pr.id::text AS pay_run_id, ps.employee_id::text
    FROM cheque c JOIN account a ON a.id = c.bank_account_id
    LEFT JOIN journal_entry je ON je.id = c.entry_id
    LEFT JOIN pay_stub ps ON ps.id = c.pay_stub_id
    LEFT JOIN pay_run pr ON pr.id = ps.pay_run_id`

export async function chequesForLedger(ledgerId: string): Promise<ChequeRow[]> {
  return db.execute<ChequeRow>(sql`${CHEQUE_SELECT} WHERE c.ledger_id = ${ledgerId}::uuid
    ORDER BY c.cheque_date DESC, c.number DESC LIMIT 300`)
}
export async function chequeById(ledgerId: string, chequeId: string): Promise<ChequeRow | null> {
  validId(chequeId)
  const [row] = await db.execute<ChequeRow>(sql`${CHEQUE_SELECT}
    WHERE c.ledger_id = ${ledgerId}::uuid AND c.id = ${chequeId}::uuid`)
  return row ?? null
}

export async function editCheque(input: {
  ledgerId: string; chequeId: string; actor: string; number: bigint; chequeDate: string
  payee: string; partyId?: string | null; payeeAddress?: string; memo: string; amount: bigint
  bankAccountId?: string; expenseAccountId?: string
}) {
  validId(input.chequeId); validDate(input.chequeDate)
  const payee = validText(input.payee, 'Payee')
  const payeeAddress = input.payeeAddress === undefined ? undefined : validAddress(input.payeeAddress)
  const memo = validMemo(input.memo)
  if (input.number < 1n || input.amount <= 0n) throw new ChequeError('BAD_AMOUNT', 'Number and amount must be positive.')
  return db.transaction(async (tx) => {
    await acting(tx, input.actor)
    const [old] = await tx.execute<ChequeRow>(sql`${CHEQUE_SELECT}
      WHERE c.ledger_id = ${input.ledgerId}::uuid AND c.id = ${input.chequeId}::uuid FOR UPDATE OF c`)
    if (!old) throw new ChequeError('NO_CHEQUE', 'That cheque does not exist.')
    if (old.status !== 'issued' || old.source_status !== 'posted' || !old.source_matches) {
      throw new ChequeError('VOID', 'A void or cancelled cheque cannot be edited.')
    }
    if (old.source_kind !== 'manual' && input.amount !== BigInt(old.amount)) {
      throw new ChequeError('AMOUNT_LOCKED', 'This amount comes from the source transaction. Correct that transaction, then issue a new cheque.')
    }
    const bankAccountId = input.bankAccountId || old.bank_account_id
    const expenseAccountId = input.expenseAccountId || old.expense_account_id
    const partyId = input.partyId === undefined ? old.party_id : input.partyId || null
    const bankChanged = bankAccountId !== old.bank_account_id
    const expenseChanged = expenseAccountId !== old.expense_account_id
    if (bankChanged && old.source_kind !== 'manual' && old.source_kind !== 'expense') {
      throw new ChequeError('BANK_LOCKED', 'This bank account belongs to the invoice payment or pay run. Void the cheque and correct the source transaction.')
    }
    if (expenseChanged && old.source_kind !== 'manual') {
      throw new ChequeError('EXPENSE_LOCKED', 'Correct the source expense entry before printing this cheque.')
    }
    if (old.source_kind !== 'manual' && partyId !== old.party_id) {
      throw new ChequeError('PARTY_LOCKED', 'This Party comes from the source transaction. Correct that transaction to change the Party.')
    }
    if (bankChanged || expenseChanged) {
      const [accounts] = await tx.execute<{ bank_ok: boolean; expense_ok: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM account a JOIN ledger l ON l.entity_id = a.entity_id
          JOIN account_role ar ON ar.account_id = a.id AND ar.role = 'cash_and_cash_equivalents'
          WHERE l.id = ${input.ledgerId}::uuid AND a.id = ${bankAccountId}::uuid
            AND a.is_active AND a.is_postable
        ) AS bank_ok,
        EXISTS (
          SELECT 1 FROM account a JOIN ledger l ON l.entity_id = a.entity_id
          WHERE l.id = ${input.ledgerId}::uuid AND a.id = ${expenseAccountId}::uuid
            AND a.account_type = 'expense' AND a.is_active AND a.is_postable
        ) AS expense_ok`)
      if (!accounts.bank_ok || (expenseChanged && !accounts.expense_ok)) {
        throw new ChequeError('BAD_ACCOUNT', 'Choose an active bank and expense account of this company.')
      }
    }
    if (partyId && (partyId !== old.party_id || input.chequeDate !== old.cheque_date)) {
      await validateChequeParty(tx, input.ledgerId, partyId, input.chequeDate)
    }
    // A different bank owns a different stock of numbered paper. Reserve its
    // next number; the number typed for the old bank cannot follow it over.
    const number = bankChanged
      ? await numberFor(tx, input.ledgerId, bankAccountId)
      : input.number
    if (old.source_kind === 'manual' && (
      input.amount !== BigInt(old.amount) || input.chequeDate !== old.cheque_date || payee !== old.payee
      || memo !== old.memo || number.toString() !== old.number || bankChanged || expenseChanged || partyId !== old.party_id
    )) {
      if (!expenseAccountId) throw new ChequeError('NO_EXPENSE', 'The original expense line is missing.')
      await editEntryCore(tx, old.entry_id!, {
        entryDate: input.chequeDate,
        description: `Cheque ${number} — ${payee}${memo ? ` — ${memo}` : ''}`,
        lines: [
          { accountId: expenseAccountId, amount: input.amount, description: memo || payee, partyId: partyId ?? undefined },
          { accountId: bankAccountId, amount: -input.amount, description: `Cheque ${number}` },
        ],
      }, input.actor, 'quick_expense', 'cheque edited')
    }
    if (old.source_kind === 'expense' && bankChanged) {
      const [entry] = await tx.execute<{ entry_date: string; description: string; memo: string | null; document_ref: string | null }>(sql`
        SELECT entry_date::text, description, memo, document_ref FROM journal_entry
         WHERE id = ${old.entry_id}::uuid AND ledger_id = ${input.ledgerId}::uuid`)
      const lines = await tx.execute<{ account_id: string; amount: bigint; description: string | null; dimensions: Record<string, string>; party_id: string | null }>(sql`
        SELECT account_id::text, amount, description, dimensions, party_id::text
          FROM journal_line WHERE entry_id = ${old.entry_id}::uuid ORDER BY line_no`)
      if (!entry) throw new ChequeError('NO_EXPENSE', 'The source expense is missing.')
      const bankLine = lines.findIndex((line) => line.account_id === old.bank_account_id && BigInt(line.amount) === -BigInt(old.amount))
      if (bankLine < 0) throw new ChequeError('NO_BANK_LINE', 'The source bank line no longer matches this cheque.')
      await editEntryCore(tx, old.entry_id!, {
        entryDate: entry.entry_date, description: entry.description,
        memo: entry.memo ?? undefined, documentRef: entry.document_ref ?? undefined,
        lines: lines.map((line, i) => ({
          accountId: i === bankLine ? bankAccountId : line.account_id,
          amount: BigInt(line.amount), description: line.description ?? undefined,
          dimensions: line.dimensions, partyId: line.party_id ?? undefined,
        })),
      }, input.actor, 'quick_expense', 'cheque bank account corrected')
    }
    if (!bankChanged && number.toString() !== old.number) {
      await tx.execute(sql`UPDATE cheque_sequence SET last_number = greatest(last_number, ${number})
        WHERE bank_account_id = ${bankAccountId}::uuid`)
    }
    await tx.execute(sql`
      UPDATE cheque SET bank_account_id = ${bankAccountId}::uuid, number = ${number}, cheque_date = ${input.chequeDate}::date,
        payee = ${payee}, party_id = ${partyId}::uuid, payee_address = ${payeeAddress ?? old.payee_address}, memo = ${memo}, amount = ${input.amount},
        updated_at = now(), updated_by = ${input.actor}
       WHERE id = ${input.chequeId}::uuid`)
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
      VALUES (${input.actor}, 'edit', 'cheque', ${input.chequeId},
              ${JSON.stringify({ bankAccountId: old.bank_account_id, expenseAccountId: old.expense_account_id, number: old.number, date: old.cheque_date, payee: old.payee, partyId: old.party_id, amount: old.amount, memo: old.memo })}::jsonb,
              ${JSON.stringify({ bankAccountId, expenseAccountId, number: String(number), date: input.chequeDate, payee, partyId, amount: String(input.amount), memo })}::jsonb)`)
  })
}

export async function voidCheque(input: {
  ledgerId: string; chequeId: string; reason: string; reversalDate: string; actor: string
}) {
  validId(input.chequeId)
  validDate(input.reversalDate)
  const reason = validText(input.reason, 'Void reason', 500)
  return db.transaction(async (tx) => {
    await acting(tx, input.actor)
    const [old] = await tx.execute<ChequeRow>(sql`${CHEQUE_SELECT}
      WHERE c.ledger_id = ${input.ledgerId}::uuid AND c.id = ${input.chequeId}::uuid FOR UPDATE OF c`)
    if (!old) throw new ChequeError('NO_CHEQUE', 'That cheque does not exist.')
    if (old.status === 'void') return
    // A source corrected after issue no longer represents this piece of
    // paper. Retire its number, but leave the corrected outflow in the books.
    if (old.entry_id && old.source_status === 'posted' && old.source_matches) {
      if (old.source_kind === 'payroll') {
        await reverseEntryCore(tx, old.entry_id, input.reversalDate, `Cheque ${old.number} void: ${reason}`, input.actor)
        // One payroll journal pays every employee. All cheques from this run
        // cease to be payable when the run is reversed.
        await tx.execute(sql`
          UPDATE cheque SET status = 'void', void_reason = ${`Pay run reversed when cheque ${old.number} was voided: ${reason}`},
                 updated_at = now(), updated_by = ${input.actor}
           WHERE entry_id = ${old.entry_id}::uuid AND status = 'issued'`)
      } else {
        const [period] = await tx.execute<{ status: string }>(sql`
          SELECT fp.status FROM journal_entry je JOIN fiscal_period fp ON fp.id = je.period_id
           WHERE je.id = ${old.entry_id}::uuid`)
        if (period?.status === 'open') {
          await deleteEntryCore(tx, old.entry_id, input.actor,
            old.source_kind === 'payment' ? 'payment' : 'quick_expense', `Cheque ${old.number} void: ${reason}`)
        } else {
          // A closed period is history. Reverse into an open period; a payment's
          // application is released so the supplier's invoice is owed again.
          if (old.source_kind === 'payment') {
            await tx.execute(sql`DELETE FROM invoice_application WHERE entry_id = ${old.entry_id}::uuid`)
          }
          await reverseEntryCore(tx, old.entry_id, input.reversalDate,
            `Cheque ${old.number} void: ${reason}`, input.actor)
        }
      }
    }
    await tx.execute(sql`
      UPDATE cheque SET status = 'void', void_reason = ${reason}, updated_at = now(),
        updated_by = ${input.actor} WHERE id = ${input.chequeId}::uuid`)
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (${input.actor}, 'void', 'cheque', ${input.chequeId},
              ${JSON.stringify({ status: 'issued', number: old.number })}::jsonb,
              ${JSON.stringify({ status: 'void' })}::jsonb,
              ${JSON.stringify({ reason })}::jsonb)`)
  })
}

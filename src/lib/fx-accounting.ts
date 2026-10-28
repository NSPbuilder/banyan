import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, lockBankAccount, type Runner, type Tx } from './acting'
import { lockFinanceResource } from './module-extensions'
import { postEntryCore, reverseEntryCore, type PostEntryLine } from './posting'
import { assertCurrencyOpen, assertNoLaterFx, fxDocumentPosition, fxPositions, lockFxLedger } from './fx'
import { fxRateFor } from './fx-rates'
import { FxError, carryingRate, fxDate, releaseCarrying, toFunctional, type FxSnapshot } from './fx-money'

const abs = (n: bigint) => n < 0n ? -n : n
const direction = (n: bigint) => n < 0n ? -1n : 1n
const keyPart = (key: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new FxError('REQUEST_KEY', 'Reload this form before submitting it.')
  return key
}

async function existing(tx: Tx, key: string) {
  const [entry] = await tx.execute<{ id: string; entry_no: string }>(sql`SELECT id::text,entry_no FROM journal_entry WHERE idempotency_key=${key}`)
  return entry ? { entryId: entry.id, entryNo: entry.entry_no, replayed: true } : null
}

async function bank(tx: Tx, ledgerId: string, accountId: string) {
  const [row] = await tx.execute<{ id: string; currency: string }>(sql`SELECT a.id::text,COALESCE(a.foreign_currency,l.currency) AS currency
    FROM account a JOIN ledger l ON l.entity_id=a.entity_id WHERE l.id=${ledgerId}::uuid AND a.id=${accountId}::uuid
      AND a.is_active AND a.is_postable AND EXISTS(SELECT 1 FROM account_role WHERE account_id=a.id AND role='cash_and_cash_equivalents')`)
  if (!row) throw new FxError('BANK_ACCOUNT', 'Choose an active cash/bank account in these books.')
  return row
}

async function fxAccount(tx: Tx, ledgerId: string): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`SELECT a.id::text FROM account a JOIN ledger l ON l.entity_id=a.entity_id
    JOIN account_role r ON r.account_id=a.id AND r.role='foreign_exchange_gain_loss'
    WHERE l.id=${ledgerId}::uuid AND a.is_active AND a.is_postable`)
  if (rows.length !== 1) throw new FxError('FX_ACCOUNT', 'Assign the foreign exchange gain/loss role to exactly one active posting account.')
  return rows[0].id
}

export async function fxDifference(tx: Tx, ledgerId: string, amount: bigint): Promise<PostEntryLine[]> {
  if (amount === 0n) return []
  return [{ accountId: await fxAccount(tx, ledgerId), amount, description: 'Foreign exchange gain / loss' }]
}

function carried(currency: string, amount: bigint, native: bigint, date: string, reference: string): FxSnapshot {
  return { currency, rate: carryingRate(amount, native, currency), observedOn: date, source: 'carrying', reference }
}

export async function cashMovement(tx: Tx, ledgerId: string, accountId: string, currency: string, native: bigint, date: string, quote?: FxSnapshot): Promise<PostEntryLine | null> {
  if (native === 0n) return null
  if (currency === 'CAD') return { accountId, amount: native, description: 'Actual bank movement' }
  let amount: bigint, evidence: FxSnapshot
  if (native > 0n) {
    evidence = quote ?? await fxRateFor(currency, date, tx)
    amount = toFunctional(native, currency, evidence.rate)
  } else {
    const [position] = await tx.execute<{ native: bigint; carrying: bigint }>(sql`SELECT COALESCE(sum(j.original_amount),0)::bigint AS native,
      COALESCE(sum(j.amount),0)::bigint AS carrying FROM journal_line j JOIN journal_entry e ON e.id=j.entry_id
      WHERE j.account_id=${accountId}::uuid AND e.ledger_id=${ledgerId}::uuid AND e.status IN ('posted','reversed') AND e.entry_date<=${date}::date`)
    if (position.native <= 0n || -native > position.native || position.carrying < 0n) throw new FxError('BANK_BALANCE', 'The foreign bank balance is insufficient. Record its opening balance or funding first.')
    amount = -releaseCarrying(position.carrying, -native, position.native)
    evidence = carried(currency, amount, native, date, 'Release of the bank account carrying value')
  }
  return { accountId, amount, originalCurrency: currency, originalAmount: native, fxSnapshot: evidence, description: 'Native bank movement' }
}

async function feeLine(tx: Tx, ledgerId: string, fee: bigint, accountId?: string): Promise<PostEntryLine[]> {
  if (fee === 0n) return []
  if (fee < 0n || !accountId) throw new FxError('FEE_ACCOUNT', 'Enter a non-negative bank fee and choose its expense account.')
  if (!(await tx.execute(sql`SELECT 1 FROM account a JOIN ledger l ON l.entity_id=a.entity_id WHERE l.id=${ledgerId}::uuid
    AND a.id=${accountId}::uuid AND a.is_active AND a.is_postable AND a.account_type='expense'`)).length) throw new FxError('FEE_ACCOUNT', 'Choose an expense account in these books for the fee.')
  return [{ accountId, amount: fee, description: 'Bank fee' }]
}

export type FxPaymentInput = {
  ledgerId: string; invoiceId: string; bankAccountId: string; nativeAmount: bigint; paidOn: string; actor: string; requestKey: string
  /** Actual cash before fees, in the bank account's native minor units. */
  bankAmount?: bigint
  /** Fee in the bank account's currency, charged in addition to/out of the cash. */
  fee?: bigint; feeAccountId?: string
  rate?: FxSnapshot; bankRate?: FxSnapshot; reference?: string
}

export async function recordFxPayment(input: FxPaymentInput, on: Runner = db) {
  fxDate(input.paidOn)
  if (input.nativeAmount <= 0n) throw new FxError('AMOUNT', 'Enter a positive original-currency amount to settle.')
  const key = `fx:payment:${input.ledgerId}:${input.invoiceId}:${keyPart(input.requestKey)}`
  return on.transaction(async tx => {
    await acting(tx, input.actor)
    await lockFxLedger(tx, input.ledgerId)
    const replay = await existing(tx, key); if (replay) return replay
    await lockFinanceResource(tx, 'invoice', input.invoiceId)
    const document = await fxDocumentPosition(tx, input.invoiceId)
    if (document.ledger_id !== input.ledgerId || document.status !== 'posted' || document.issued_on > input.paidOn) throw new FxError('DOCUMENT', 'Choose a posted document in these books dated on or before settlement.')
    await lockBankAccount(tx, input.bankAccountId)
    const cash = await bank(tx, input.ledgerId, input.bankAccountId)
    await assertNoLaterFx(tx, input.ledgerId, input.paidOn, [document.id], cash.currency === 'CAD' ? [] : [cash.id])
    const released = releaseCarrying(abs(document.carrying_balance), input.nativeAmount, abs(document.native_balance))
    const sign = direction(document.native_balance)
    const statedRate = input.rate ? await fxRateFor(document.fx_currency,input.paidOn,tx,input.rate) : undefined
    let gross = input.bankAmount
    if (gross === undefined) {
      if (cash.currency === document.fx_currency) gross = input.nativeAmount
      else if (cash.currency === 'CAD') gross = toFunctional(input.nativeAmount, document.fx_currency,
        (await fxRateFor(document.fx_currency, input.paidOn, tx, input.rate)).rate)
      else throw new FxError('ACTUAL_CASH', 'Enter the actual cash amount in the receiving/paying bank currency.')
    }
    const fee = input.fee ?? 0n
    if (gross < 0n || fee < 0n || (sign > 0n && fee > gross)) throw new FxError('ACTUAL_CASH', 'Cash and fees must be non-negative; a receipt fee cannot exceed its gross cash.')
    if ((cash.currency === document.fx_currency && gross !== input.nativeAmount) || (gross === 0n && released !== 0n)) throw new FxError('SETTLEMENT_DIFFERENCE','For same-currency payment, settle the quantity actually paid and record bank fees separately. Use a credit note for a discount or write-off.')
    const cashNative = sign * gross - fee
    const cashQuote = cash.currency === 'CAD' || (cashNative < 0n && fee === 0n) ? undefined
      : await fxRateFor(cash.currency, input.paidOn, tx, cash.currency === document.fx_currency ? input.rate : input.bankRate)
    const cashLine = await cashMovement(tx, input.ledgerId, cash.id, cash.currency, cashNative, input.paidOn, cashQuote)
    const fees = await feeLine(tx, input.ledgerId, cash.currency === 'CAD' ? fee : fee === 0n ? 0n : toFunctional(fee, cash.currency, cashQuote!.rate), input.feeAccountId)
    const control: PostEntryLine = { accountId: document.control_account_id, partyId: document.party_id,
      amount: -sign * released, originalCurrency: document.fx_currency, originalAmount: -sign * input.nativeAmount,
      fxInvoiceId: document.id, fxSnapshot: { ...carried(document.fx_currency, -sign * released, -sign * input.nativeAmount, input.paidOn,
        `Settlement of ${document.number ?? 'foreign document'} at its current carrying value`),
        settlement:{bankCurrency:cash.currency,grossMinor:gross.toString(),feeMinor:fee.toString(),
          reference:input.reference?.trim()||'Actual bank amount entered by the operator',actualRate:statedRate} } }
    const lines = [control, ...(cashLine ? [cashLine] : []), ...fees]
    lines.push(...await fxDifference(tx, input.ledgerId, -lines.reduce((sum, l) => sum + l.amount, 0n)))
    if (lines.length === 1 && control.amount === 0n) lines.push({ accountId: await fxAccount(tx,input.ledgerId), amount:0n,
      originalCurrency:document.fx_currency,originalAmount:sign*input.nativeAmount,
      fxSnapshot:carried(document.fx_currency,0n,sign*input.nativeAmount,input.paidOn,'Sub-cent native settlement rounding'),
      description:'Original-currency rounding at zero functional value' })
    const posted = await postEntryCore(tx, { ledgerId: input.ledgerId, entryDate: input.paidOn,
      description: `Foreign settlement — ${document.number ?? 'document'}${input.reference ? ` (${input.reference})` : ''}`,
      sourceType: 'payment', actor: input.actor, idempotencyKey: key, lines })
    await tx.execute(sql`INSERT INTO invoice_application(invoice_id,entry_id,amount,original_amount,carrying_amount,applied_by)
      VALUES(${document.id}::uuid,${posted.entry.id}::uuid,${released},${input.nativeAmount},${released},${input.actor})`)
    return { entryId: posted.entry.id, entryNo: posted.entry.entryNo!, replayed: posted.replayed }
  })
}

/** Apply same-currency opposite documents at their own carrying values. */
export async function applyFxCredit(input: { ledgerId: string; invoiceId: string; creditId: string; nativeAmount: bigint; date: string; actor: string; requestKey: string }, on: Runner = db) {
  fxDate(input.date)
  if (input.invoiceId === input.creditId) throw new FxError('CREDIT', 'Choose two different documents.')
  const key = `fx:credit:${input.ledgerId}:${input.invoiceId}:${keyPart(input.requestKey)}`
  return on.transaction(async tx => {
    await acting(tx, input.actor); await lockFxLedger(tx, input.ledgerId)
    const replay = await existing(tx, key); if (replay) return replay
    for (const id of [input.invoiceId, input.creditId].sort()) await lockFinanceResource(tx, 'invoice', id)
    const docs = [await fxDocumentPosition(tx, input.invoiceId), await fxDocumentPosition(tx, input.creditId)]
    const [target, credit] = docs
    if (docs.some(d => d.ledger_id !== input.ledgerId || d.status !== 'posted' || d.issued_on > input.date)
      || target.fx_currency !== credit.fx_currency || target.party_id !== credit.party_id || target.control_account_id !== credit.control_account_id
      || target.document_kind !== 'invoice' || credit.document_kind !== 'credit_note' || direction(target.native_balance) === direction(credit.native_balance)) {
      throw new FxError('CREDIT', 'Choose an invoice and its opposite credit note for the same party, currency and control account.')
    }
    await assertNoLaterFx(tx, input.ledgerId, input.date, docs.map(d => d.id))
    const released = docs.map(d => releaseCarrying(abs(d.carrying_balance), input.nativeAmount, abs(d.native_balance)))
    const lines: PostEntryLine[] = docs.map((d, i) => ({ accountId: d.control_account_id, partyId: d.party_id,
      amount: -direction(d.native_balance) * released[i], originalCurrency: d.fx_currency,
      originalAmount: -direction(d.native_balance) * input.nativeAmount, fxInvoiceId: d.id,
      fxSnapshot: carried(d.fx_currency, released[i], input.nativeAmount, input.date, `Credit settlement of ${d.number ?? 'document'}`) }))
    lines.push(...await fxDifference(tx, input.ledgerId, -lines.reduce((sum, l) => sum + l.amount, 0n)))
    const posted = await postEntryCore(tx, { ledgerId: input.ledgerId, entryDate: input.date, description: 'Foreign credit application', sourceType: 'payment', actor: input.actor, idempotencyKey: key, lines })
    for (const [i, d] of docs.entries()) await tx.execute(sql`INSERT INTO invoice_application(invoice_id,entry_id,amount,original_amount,carrying_amount,applied_by)
      VALUES(${d.id}::uuid,${posted.entry.id}::uuid,${released[i]},${input.nativeAmount},${released[i]},${input.actor})`)
    return { entryId: posted.entry.id, entryNo: posted.entry.entryNo!, replayed: posted.replayed }
  })
}

export async function revalueFx(input: { ledgerId: string; date: string; actor: string; requestKey: string; rates?: Record<string, FxSnapshot> }, on: Runner = db) {
  fxDate(input.date)
  const key = `fx:revalue:${input.ledgerId}:${keyPart(input.requestKey)}`
  return on.transaction(async tx => {
    await acting(tx, input.actor); await lockFxLedger(tx, input.ledgerId)
    const replay = await existing(tx, key); if (replay) return replay
    if ((await tx.execute(sql`SELECT 1 FROM audit_log WHERE ledger_id=${input.ledgerId}::uuid AND action='fx_revalue_noop' AND context->>'fxKey'=${key}`)).length) return { entryId: null, entryNo: null, replayed: true }
    const positions = await fxPositions(input.ledgerId, input.date, tx), lines: PostEntryLine[] = []
    for (const p of positions) {
      await assertNoLaterFx(tx, input.ledgerId, input.date, p.kind === 'invoice' ? [p.id] : [], p.kind === 'bank' ? [p.id] : [])
      if (p.kind === 'bank') await lockBankAccount(tx, p.id)
      else await lockFinanceResource(tx, 'invoice', p.id)
      const quote = await fxRateFor(p.currency, input.date, tx, input.rates?.[p.currency])
      const delta = toFunctional(p.native, p.currency, quote.rate) - p.carrying
      if (delta !== 0n) lines.push({ accountId: p.account_id, partyId: p.party_id ?? undefined, amount: delta,
        originalCurrency: p.currency, originalAmount: 0n, fxSnapshot: quote, fxInvoiceId: p.kind === 'invoice' ? p.id : undefined,
        description: `Closing revaluation — ${p.label}` })
    }
    if (!lines.length) {
      await tx.execute(sql`INSERT INTO audit_log(actor,action,table_name,record_id,context) VALUES(${input.actor},'fx_revalue_noop','ledger',${input.ledgerId},
        ${JSON.stringify({ ledgerId: input.ledgerId, fxKey: key, date: input.date })}::jsonb)`)
      return { entryId: null, entryNo: null, replayed: false }
    }
    lines.push(...await fxDifference(tx, input.ledgerId, -lines.reduce((sum, l) => sum + l.amount, 0n)))
    if (lines.length < 2) throw new FxError('REVALUE', 'A revaluation requires balancing monetary positions.')
    const posted = await postEntryCore(tx, { ledgerId: input.ledgerId, entryDate: input.date, description: 'Closing foreign-currency revaluation',
      sourceType: 'fx_revaluation', actor: input.actor, idempotencyKey: key, lines })
    return { entryId: posted.entry.id, entryNo: posted.entry.entryNo!, replayed: posted.replayed }
  })
}

export async function transferFxCash(input: {
  ledgerId: string; fromAccountId: string; toAccountId: string; fromAmount: bigint; toAmount: bigint
  date: string; actor: string; requestKey: string; reference: string
  destinationRate?: FxSnapshot; sourceRate?: FxSnapshot; fee?: bigint; feeAccountId?: string
}, on: Runner = db) {
  fxDate(input.date)
  if (input.fromAccountId === input.toAccountId || input.fromAmount <= 0n || input.toAmount <= 0n || !input.reference.trim()) throw new FxError('TRANSFER', 'Choose two different accounts, positive actual amounts and a bank conversion reference.')
  const key = `fx:transfer:${input.ledgerId}:${keyPart(input.requestKey)}`
  return on.transaction(async tx => {
    await acting(tx, input.actor); await lockFxLedger(tx, input.ledgerId)
    const replay = await existing(tx, key); if (replay) return replay
    for (const id of [input.fromAccountId, input.toAccountId].sort()) await lockBankAccount(tx, id)
    const from = await bank(tx, input.ledgerId, input.fromAccountId), to = await bank(tx, input.ledgerId, input.toAccountId)
    if (from.currency === 'CAD' && to.currency === 'CAD') throw new FxError('TRANSFER', 'Use an ordinary transfer for two CAD accounts.')
    if (from.currency === to.currency && input.fromAmount !== input.toAmount) throw new FxError('TRANSFER', 'For the same currency, record the transferred quantity and fees separately.')
    if (to.currency !== 'CAD' && to.currency !== from.currency) await assertCurrencyOpen(tx, input.ledgerId, to.currency)
    const foreign = [from, to].filter(a => a.currency !== 'CAD').map(a => a.id)
    await assertNoLaterFx(tx, input.ledgerId, input.date, [], foreign)
    const fee = input.fee ?? 0n
    if (fee < 0n) throw new FxError('FEE', 'The fee cannot be negative.')
    const out = (await cashMovement(tx, input.ledgerId, from.id, from.currency, -input.fromAmount - fee, input.date))!
    let quote: FxSnapshot | undefined
    if (to.currency !== 'CAD') {
      if (from.currency === 'CAD') quote = { currency: to.currency, rate: carryingRate(input.fromAmount, input.toAmount, to.currency),
        source: 'manual', observedOn: input.date, reference: input.reference }
      else if (from.currency === to.currency) {
        const grossCarry = releaseCarrying(-out.amount, input.fromAmount, input.fromAmount + fee)
        quote = carried(to.currency, grossCarry, input.toAmount, input.date, input.reference)
      } else quote = await fxRateFor(to.currency, input.date, tx, input.destinationRate)
    }
    // A same-currency transfer carries cost; an actual CAD conversion carries its paid price.
    const incoming: PostEntryLine | null = from.currency === to.currency
      ? { accountId:to.id, amount:releaseCarrying(-out.amount,input.fromAmount,input.fromAmount+fee),
          originalCurrency:to.currency,originalAmount:input.toAmount,fxSnapshot:quote!,description:'Transfer of bank carrying value' }
      : await cashMovement(tx, input.ledgerId, to.id, to.currency, input.toAmount, input.date, quote)
    const feeBase = from.currency === 'CAD' ? fee : fee === 0n ? 0n
      : toFunctional(fee, from.currency, (await fxRateFor(from.currency, input.date, tx, input.sourceRate)).rate)
    const lines = [out, ...(incoming ? [incoming] : []), ...await feeLine(tx, input.ledgerId, feeBase, input.feeAccountId)]
    lines.push(...await fxDifference(tx, input.ledgerId, -lines.reduce((sum, l) => sum + l.amount, 0n)))
    const posted = await postEntryCore(tx, { ledgerId: input.ledgerId, entryDate: input.date, description: `Foreign cash transfer — ${input.reference}`,
      sourceType: 'fx_transfer', actor: input.actor, idempotencyKey: key, lines })
    return { entryId: posted.entry.id, entryNo: posted.entry.entryNo!, replayed: posted.replayed }
  })
}

export async function reverseFxEntry(input: { ledgerId: string; entryId: string; date: string; reason: string; actor: string }, on: Runner = db) {
  fxDate(input.date)
  if (!input.reason.trim()) throw new FxError('REASON', 'Explain this correction.')
  return on.transaction(async tx => {
    await acting(tx, input.actor); await lockFxLedger(tx, input.ledgerId)
    const [entry] = await tx.execute<{ id: string; source_type: string; entry_date: string; created_at: Date }>(sql`SELECT id::text,source_type,entry_date::text,created_at FROM journal_entry
      WHERE id=${input.entryId}::uuid AND ledger_id=${input.ledgerId}::uuid AND status='posted' AND reverses_id IS NULL FOR UPDATE`)
    if (!entry || !['payment', 'fx_revaluation', 'fx_transfer', 'bank', 'manual', 'opening_balance'].includes(entry.source_type)) throw new FxError('CORRECTION', 'Choose an original foreign payment, transfer or revaluation. Void invoices through their document workflow.')
    const lines = await tx.execute<{ fx_invoice_id: string | null; account_id: string; foreign_currency:string|null }>(sql`SELECT j.fx_invoice_id::text,j.account_id::text,a.foreign_currency FROM journal_line j JOIN account a ON a.id=j.account_id WHERE j.entry_id=${entry.id}::uuid AND j.original_currency IS NOT NULL`)
    if (!lines.length) throw new FxError('CORRECTION', 'This is not a foreign-currency entry.')
    if ((await tx.execute(sql`SELECT 1 FROM bank_match WHERE entry_id=${entry.id}::uuid LIMIT 1`)).length) throw new FxError('MATCHED', 'Unmatch the bank transaction before correcting its entry.')
    if (input.date < entry.entry_date) throw new FxError('DATE', 'A correction cannot precede its original entry.')
    await tx.execute(sql`DELETE FROM invoice_application WHERE entry_id=${entry.id}::uuid`)
    return reverseEntryCore(tx, entry.id, input.date, input.reason, input.actor)
  })
}

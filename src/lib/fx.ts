import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, lockBankAccount, type Runner, type Tx } from './acting'
import { FxError, fxDate, type FxSnapshot } from './fx-money'

export async function fxContext(ledgerId: string, on: Runner = db) {
  const [row] = await on.execute<{ id: string; entity_id: string; currency: string; archived_at: string | null }>(sql`
    SELECT l.id::text,l.entity_id::text,l.currency,e.archived_at::text FROM ledger l JOIN entity e ON e.id=l.entity_id
    WHERE l.id=${ledgerId}::uuid`)
  if (!row) throw new FxError('LEDGER', 'Those books do not exist.')
  if (row.currency !== 'CAD') throw new FxError('FUNCTIONAL_CURRENCY', 'Foreign-currency workflows currently require CAD functional books.')
  return row
}

export async function lockFxLedger(tx: Tx, ledgerId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('fx:'||${ledgerId},0))`)
  const context = await fxContext(ledgerId, tx)
  if (context.archived_at) throw new FxError('ARCHIVED', 'Restore this company before changing its foreign-currency business.')
  return context
}

export async function assertCurrencyOpen(tx: Tx, ledgerId: string, currency: string) {
  const context = await fxContext(ledgerId, tx)
  if (context.archived_at) throw new FxError('ARCHIVED', 'Restore this company before changing its foreign-currency business.')
  if (currency === 'CAD') return context
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('fx_policy:'||${context.entity_id},0))`)
  const [row] = await tx.execute<{ enabled: boolean }>(sql`SELECT enabled FROM fx_company_currency
    WHERE entity_id=${context.entity_id}::uuid AND currency=${currency} FOR SHARE`)
  if (!row?.enabled) throw new FxError('CURRENCY_STOPPED', `${currency} is not enabled for new business. Existing documents can still be settled.`)
  return context
}

export async function setFxCurrency(ledgerId: string, currency: string, enabled: boolean, actor: string, on: Runner = db) {
  if (currency === 'CAD' && !enabled) throw new FxError('FUNCTIONAL_CURRENCY', 'The functional currency is always available.')
  return on.transaction(async tx => {
    await acting(tx, actor)
    const context = await fxContext(ledgerId, tx)
    if (context.archived_at) throw new FxError('ARCHIVED', 'Restore this company before changing its foreign-currency business.')
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('fx_policy:'||${context.entity_id},0))`)
    if (!(await tx.execute(sql`SELECT 1 FROM fx_currency WHERE code=${currency}`)).length) throw new FxError('CURRENCY', 'Choose a currency provided by BOC.')
    const [row] = await tx.execute<{ id: string }>(sql`INSERT INTO fx_company_currency(entity_id,currency,enabled,changed_by)
      VALUES(${context.entity_id}::uuid,${currency},${enabled},${actor})
      ON CONFLICT(entity_id,currency) DO UPDATE SET enabled=excluded.enabled,changed_at=now(),changed_by=excluded.changed_by RETURNING id::text`)
    await tx.execute(sql`INSERT INTO audit_log(actor,action,table_name,record_id,after)
      VALUES(${actor},'fx_currency_policy','fx_company_currency',${row.id},${JSON.stringify({ entity_id: context.entity_id, currency, enabled })}::jsonb)`)
  })
}

export async function bindFxBankAccount(ledgerId: string, accountId: string, currency: string, actor: string, on: Runner = db) {
  return on.transaction(async tx => {
    await acting(tx, actor)
    const context = await lockFxLedger(tx, ledgerId)
    await lockBankAccount(tx, accountId)
    await assertCurrencyOpen(tx, ledgerId, currency)
    const [account] = await tx.execute<{ id: string; foreign_currency: string | null }>(sql`SELECT a.id::text,a.foreign_currency FROM account a
      WHERE a.id=${accountId}::uuid AND a.entity_id=${context.entity_id}::uuid AND a.is_active AND a.is_postable
        AND EXISTS(SELECT 1 FROM account_role WHERE account_id=a.id AND role='cash_and_cash_equivalents') FOR UPDATE`)
    if (!account) throw new FxError('BANK_ACCOUNT', 'Choose an active cash/bank account in these books.')
    if ((account.foreign_currency ?? 'CAD') === currency) return
    await tx.execute(sql`UPDATE account SET foreign_currency=${currency === 'CAD' ? null : currency} WHERE id=${accountId}::uuid`)
    await tx.execute(sql`INSERT INTO audit_log(actor,action,table_name,record_id,before,after,context)
      VALUES(${actor},'fx_bank_currency','account',${accountId},${JSON.stringify({ currency: account.foreign_currency ?? 'CAD' })}::jsonb,
        ${JSON.stringify({ currency })}::jsonb,${JSON.stringify({ ledgerId })}::jsonb)`)
  })
}

export async function fxCurrencies(ledgerId: string) {
  const context = await fxContext(ledgerId)
  return db.execute<{ code: string; name: string; minor_digits: number; historical: boolean; enabled: boolean; configured: boolean; rate: string | null; observed_on: string | null }>(sql`
    SELECT c.code,c.name,c.minor_digits,c.historical,(c.code='CAD' OR COALESCE(p.enabled,false)) AS enabled,
      p.id IS NOT NULL AS configured,q.rate::text,q.observed_on::text FROM fx_currency c
    LEFT JOIN fx_company_currency p ON p.currency=c.code AND p.entity_id=${context.entity_id}::uuid
    LEFT JOIN LATERAL(SELECT rate,observed_on FROM fx_rate WHERE currency=c.code ORDER BY observed_on DESC LIMIT 1) q ON true
    ORDER BY CASE WHEN c.code='CAD' THEN 0 WHEN p.enabled THEN 1 ELSE 2 END,c.code`)
}

export type FxDocumentPosition = {
  id: string; ledger_id: string; party_id: string; control_account_id: string; fx_currency: string
  fx_snapshot: FxSnapshot; direction: 'sales' | 'purchase'; document_kind: 'invoice' | 'credit_note'
  number: string | null; status: string; issued_on: string; entry_id: string
  native_balance: bigint; carrying_balance: bigint; native_total: bigint; historical_total: bigint
}

export async function fxDocumentPosition(tx: Runner, invoiceId: string, date?: string): Promise<FxDocumentPosition> {
  if (date) fxDate(date)
  const [row] = await tx.execute<FxDocumentPosition>(sql`SELECT i.id::text,i.ledger_id::text,i.party_id::text,i.control_account_id::text,
    i.fx_currency,i.fx_snapshot,i.direction,i.document_kind,i.number,i.status,i.issued_on::text,i.entry_id::text,
    pos.native_balance,pos.carrying_balance,
    -(SELECT sum(original_amount) FROM invoice_line WHERE invoice_id=i.id)::bigint AS native_total,
    -(SELECT sum(amount) FROM invoice_line WHERE invoice_id=i.id)::bigint AS historical_total
    FROM invoice i CROSS JOIN LATERAL fx_invoice_at(i.id,${date ?? 'infinity'}::date) pos WHERE i.id=${invoiceId}::uuid`)
  if (!row?.fx_currency) throw new FxError('DOCUMENT', 'Choose a foreign-currency document.')
  return row
}

export async function assertNoLaterFx(tx: Tx, ledgerId: string, date: string, invoiceIds: string[] = [], accountIds: string[] = []) {
  fxDate(date)
  const invoices = invoiceIds.length ? sql`jl.fx_invoice_id IN (${sql.join(invoiceIds.map(id => sql`${id}::uuid`), sql`,`)})` : sql`false`
  const accounts = accountIds.length ? sql`jl.account_id IN (${sql.join(accountIds.map(id => sql`${id}::uuid`), sql`,`)}) AND jl.original_currency IS NOT NULL` : sql`false`
  if ((await tx.execute(sql`SELECT 1 FROM journal_line jl JOIN journal_entry e ON e.id=jl.entry_id
    WHERE e.ledger_id=${ledgerId}::uuid AND e.status IN ('posted','reversed') AND e.entry_date>${date}::date
      AND ((${invoices}) OR (${accounts})) LIMIT 1`)).length) {
    throw new FxError('LATER_ACTIVITY', 'Later foreign-currency activity exists. Correct the later activity first, or use a current date.')
  }
}

export async function fxPositions(ledgerId: string, date: string, on: Runner = db) {
  fxDate(date)
  return on.execute<{ kind: 'invoice' | 'bank'; id: string; label: string; currency: string; native: bigint; carrying: bigint; account_id: string; party_id: string | null }>(sql`
    SELECT 'invoice'::text AS kind,i.id::text,COALESCE(i.number,'Foreign document') AS label,i.fx_currency AS currency,
      p.native_balance AS native,p.carrying_balance AS carrying,i.control_account_id::text AS account_id,i.party_id::text
      FROM invoice i CROSS JOIN LATERAL fx_invoice_at(i.id,${date}::date) p
      WHERE i.ledger_id=${ledgerId}::uuid AND i.fx_currency IS NOT NULL AND i.status IN ('posted','void')
        AND (p.native_balance<>0 OR p.carrying_balance<>0)
    UNION ALL
    SELECT 'bank',a.id::text,a.code||' '||a.name,a.foreign_currency,
      COALESCE(sum(j.original_amount),0)::bigint,COALESCE(sum(j.amount),0)::bigint,a.id::text,NULL::text
      FROM account a JOIN ledger l ON l.entity_id=a.entity_id
      JOIN journal_line j ON j.account_id=a.id JOIN journal_entry e ON e.id=j.entry_id AND e.ledger_id=l.id
      WHERE l.id=${ledgerId}::uuid AND a.foreign_currency IS NOT NULL AND e.status IN ('posted','reversed') AND e.entry_date<=${date}::date
      GROUP BY a.id HAVING sum(j.original_amount)<>0 OR sum(j.amount)<>0 ORDER BY kind,label`)
}

/** All reversal doors share the ordering rule, including invoice voids. */
export async function assertFxCorrection(tx: Tx, entryId: string, date: string) {
  const [entry] = await tx.execute<{ledger_id:string;entry_date:string}>(sql`
    SELECT ledger_id::text,entry_date::text FROM journal_entry WHERE id=${entryId}::uuid`)
  if (!entry) return
  const lines = await tx.execute<{fx_invoice_id:string|null;account_id:string;foreign_currency:string|null}>(sql`
    SELECT j.fx_invoice_id::text,j.account_id::text,a.foreign_currency FROM journal_line j
    JOIN account a ON a.id=j.account_id WHERE j.entry_id=${entryId}::uuid AND j.original_currency IS NOT NULL`)
  if (!lines.length) return
  await lockFxLedger(tx,entry.ledger_id)
  await tx.execute(sql`SELECT id FROM journal_entry WHERE id=${entryId}::uuid FOR UPDATE`)
  fxDate(date)
  if (date<entry.entry_date) throw new FxError('DATE','A correction cannot precede its original entry.')
  const invoices=lines.flatMap(l=>l.fx_invoice_id?[l.fx_invoice_id]:[])
  const accounts=lines.filter(l=>l.foreign_currency).map(l=>l.account_id)
  await assertNoLaterFx(tx,entry.ledger_id,date,invoices,accounts)
  const invoiceScope=invoices.length?sql`j.fx_invoice_id IN (${sql.join(invoices.map(id=>sql`${id}::uuid`),sql`,`)})`:sql`false`
  const bankScope=accounts.length?sql`j.account_id IN (${sql.join(accounts.map(id=>sql`${id}::uuid`),sql`,`)}) AND j.original_currency IS NOT NULL`:sql`false`
  if ((await tx.execute(sql`SELECT 1 FROM journal_line j JOIN journal_entry e ON e.id=j.entry_id
    WHERE e.ledger_id=${entry.ledger_id}::uuid AND e.status='posted' AND e.reverses_id IS NULL AND e.id<>${entryId}::uuid
      AND e.created_at>=(SELECT created_at FROM journal_entry WHERE id=${entryId}::uuid)
      AND ((${invoiceScope}) OR (${bankScope})) LIMIT 1`)).length) {
    throw new FxError('LATER_ACTIVITY','Correct later activity on these foreign positions first.')
  }
  for (const id of [...new Set(accounts)].sort()) await lockBankAccount(tx,id)
}

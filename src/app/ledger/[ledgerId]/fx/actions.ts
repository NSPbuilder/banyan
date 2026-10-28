'use server'

import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { currentActor, requireLedger, requireOwner } from '@/lib/gate'
import { bindFxBankAccount, setFxCurrency } from '@/lib/fx'
import { refreshFxRates } from '@/lib/fx-rates'
import { FxError, fxDate, parseNative, type FxSnapshot } from '@/lib/fx-money'
import { applyFxCredit, recordFxPayment, reverseFxEntry, revalueFx, transferFxCash } from '@/lib/fx-accounting'
import { createInvoice, postInvoice, voidInvoice, InvoiceError, type Direction, type DocumentKind } from '@/lib/invoices'
import { ledgerAmount, resolveTaggedLines, type ParsedLine } from '@/lib/invoice-forms'
import { TAX_CODES, type TaxCode } from '@/lib/tax-rates'
import { g, type FormResult } from '@/lib/forms'

const quote = (form: FormData, currency: string, date: string, prefix = ''): FxSnapshot | undefined => {
  const rate = g(form, prefix + 'rate')
  return rate ? { currency, rate, observedOn: g(form, prefix + 'rateDate') || date, source: 'manual', reference: g(form, prefix + 'rateEvidence') } : undefined
}

async function documentCurrency(ledgerId: string, invoiceId: string) {
  const [row] = await db.execute<{ fx_currency: string }>(sql`SELECT fx_currency FROM invoice WHERE id=${invoiceId}::uuid AND ledger_id=${ledgerId}::uuid AND fx_currency IS NOT NULL`)
  if (!row) throw new FxError('DOCUMENT', 'Choose a foreign document in these books.')
  return row.fx_currency
}

async function bankCurrency(ledgerId: string, accountId: string) {
  const [row] = await db.execute<{ currency: string }>(sql`SELECT COALESCE(a.foreign_currency,l.currency) AS currency FROM account a JOIN ledger l ON l.entity_id=a.entity_id
    WHERE l.id=${ledgerId}::uuid AND a.id=${accountId}::uuid`)
  if (!row) throw new FxError('BANK', 'Choose a bank account in these books.')
  return row.currency
}

export async function fxAction(_previous: FormResult, form: FormData): Promise<FormResult> {
  const ledgerId = g(form, 'ledgerId'), op = g(form, 'op')
  await requireLedger(ledgerId, '/entries')
  if (['currency', 'bind'].includes(op)) await requireOwner()
  if (['document', 'post', 'void', 'payment', 'credit', 'reverse', 'revalue'].includes(op)) await requireLedger(ledgerId, '/invoices')
  if (['bind', 'transfer', 'payment', 'reverse', 'revalue'].includes(op)) await requireLedger(ledgerId, '/bank')
  const actor = await currentActor()
  try {
    let message = 'Foreign-currency change saved.'
    const date = g(form, 'date') || new Date().toLocaleDateString('en-CA')
    if (op === 'currency') {
      await setFxCurrency(ledgerId, g(form, 'currency'), g(form, 'enabled') === 'true', actor)
      message = `${g(form, 'currency')}: ${g(form, 'enabled') === 'true' ? 'enabled for new business' : 'new business stopped; existing balances remain available'}.`
    } else if (op === 'rates') {
      const result = await refreshFxRates(fxDate(date), actor)
      message = `Saved ${result.quotes} BOC reference quotes through ${date}. Transaction rates remain unchanged.`
    } else if (op === 'bind') {
      await bindFxBankAccount(ledgerId, g(form, 'bankAccountId'), g(form, 'currency'), actor)
      message = 'Bank account currency saved.'
    } else if (op === 'document') {
      const kindText = g(form, 'kind'), direction: Direction = kindText.startsWith('purchase') ? 'purchase' : 'sales'
      const kind: DocumentKind = kindText.endsWith('credit') ? 'credit_note' : 'invoice'
      if (!['sales_invoice', 'purchase_invoice', 'sales_credit', 'purchase_credit'].includes(kindText)) throw new FxError('KIND', 'Choose a document type.')
      const currency = g(form, 'currency'), issuedOn = fxDate(g(form, 'issuedOn')), dueOn = fxDate(g(form, 'dueOn'))
      if (currency === 'CAD') throw new FxError('CURRENCY', 'Use the ordinary invoice/bill form for CAD documents.')
      const ids = form.getAll('lineAccount').map(String), amounts = form.getAll('lineAmount').map(String)
      const descriptions = form.getAll('lineDescription').map(String), tags = form.getAll('lineTax').map(String)
      if (!ids.length || ids.length > 200 || ids.length !== amounts.length || ids.length !== descriptions.length || ids.length !== tags.length) throw new FxError('LINES', 'Provide complete document lines.')
      const parsed: ParsedLine[] = ids.map((id, i) => {
        const typed = parseNative(amounts[i], currency), taxCode = tags[i] as TaxCode
        if (!id || typed === 0n || !TAX_CODES.some(t => t.code === taxCode)) throw new FxError('LINE', `Complete line ${i + 1}, including its account, amount and tax tag.`)
        return { index: i, position: i + 1, typed, taxCode, line: { accountId: id, amount: ledgerAmount(direction, kind, typed), description: descriptions[i], taxCode } }
      })
      const resolved = await resolveTaggedLines(ledgerId, direction, kind, parsed, g(form, 'inclusive') === 'yes', issuedOn)
      if (resolved.error) throw new FxError('TAX', resolved.error)
      const inv = await db.transaction(async tx => {
        const saved = await createInvoice({ ledgerId, currency, rate: quote(form, currency, issuedOn), requestKey: g(form, 'requestKey'),
          direction, kind, partyId: g(form, 'partyId'), controlAccountId: g(form, 'controlAccountId'), issuedOn, dueOn,
          number: g(form, 'number') || undefined, theirRef: g(form, 'theirRef') || undefined, note: g(form, 'note') || undefined,
          lines: resolved.lines, actor }, tx)
        if (g(form, 'saveMode') !== 'draft' && saved.status === 'draft') await postInvoice(saved.id, actor, tx)
        return saved
      })
      message = `${currency} document ${inv.number ?? ''} ${g(form, 'saveMode') === 'draft' ? 'saved as a draft' : 'posted'}. It is listed below.`
    } else if (op === 'post') {
      await documentCurrency(ledgerId, g(form, 'invoiceId'))
      await postInvoice(g(form, 'invoiceId'), actor)
      message = 'Foreign document posted with its saved issue rate.'
    } else if (op === 'void') {
      await documentCurrency(ledgerId, g(form, 'invoiceId'))
      await voidInvoice(g(form, 'invoiceId'), { reason: g(form, 'reason'), reversedOn: fxDate(date), actor })
      message = 'Foreign document voided; its original currency and rate remain in history.'
    } else if (op === 'payment') {
      const currency = await documentCurrency(ledgerId, g(form, 'invoiceId')), cashCurrency = await bankCurrency(ledgerId, g(form, 'bankAccountId'))
      const result = await recordFxPayment({ ledgerId, invoiceId: g(form, 'invoiceId'), bankAccountId: g(form, 'bankAccountId'),
        nativeAmount: parseNative(g(form, 'nativeAmount'), currency), bankAmount: g(form, 'bankAmount') ? parseNative(g(form, 'bankAmount'), cashCurrency) : undefined,
        fee: g(form, 'fee') ? parseNative(g(form, 'fee'), cashCurrency) : 0n, feeAccountId: g(form, 'feeAccountId') || undefined,
        rate: quote(form, currency, date), bankRate: quote(form, cashCurrency, date, 'bank_'), reference: g(form, 'reference'),
        paidOn: fxDate(date), actor, requestKey: g(form, 'requestKey') })
      message = `Settlement ${result.entryNo} recorded in original units and CAD carrying value.`
    } else if (op === 'credit') {
      const currency = await documentCurrency(ledgerId, g(form, 'invoiceId'))
      const result = await applyFxCredit({ ledgerId, invoiceId: g(form, 'invoiceId'), creditId: g(form, 'creditId'),
        nativeAmount: parseNative(g(form, 'nativeAmount'), currency), date: fxDate(date), actor, requestKey: g(form, 'requestKey') })
      message = `Credit application ${result.entryNo} recorded.`
    } else if (op === 'transfer') {
      const from = await bankCurrency(ledgerId, g(form, 'fromAccountId')), to = await bankCurrency(ledgerId, g(form, 'toAccountId'))
      const result = await transferFxCash({ ledgerId, fromAccountId: g(form, 'fromAccountId'), toAccountId: g(form, 'toAccountId'),
        fromAmount: parseNative(g(form, 'fromAmount'), from), toAmount: parseNative(g(form, 'toAmount'), to),
        fee: g(form, 'fee') ? parseNative(g(form, 'fee'), from) : 0n, feeAccountId: g(form, 'feeAccountId') || undefined,
        sourceRate: quote(form, from, date, 'source_'), destinationRate: quote(form, to, date, 'destination_'),
        date: fxDate(date), actor, reference: g(form, 'reference'), requestKey: g(form, 'requestKey') })
      message = `Cash transfer ${result.entryNo} recorded at actual amounts.`
    } else if (op === 'revalue') {
      const rates: Record<string, FxSnapshot> = {}
      for (const [name, value] of form.entries()) if (/^[A-Z]{3}_rate$/.test(name) && String(value).trim()) {
        const currency = name.slice(0, 3); rates[currency] = quote(form, currency, date, `${currency}_`)!
      }
      const result = await revalueFx({ ledgerId, date: fxDate(date), actor, requestKey: g(form, 'requestKey'), rates })
      message = result.entryNo ? `Closing revaluation ${result.entryNo} posted. Original quantities are unchanged.` : 'No revaluation adjustment is needed.'
    } else if (op === 'reverse') {
      const result = await reverseFxEntry({ ledgerId, entryId: g(form, 'entryId'), date: fxDate(date), reason: g(form, 'reason'), actor })
      message = `Correction ${result.reversal.entryNo} posted with the original currency evidence.`
    } else throw new FxError('OPERATION', 'Choose a supported foreign-currency operation.')
    revalidatePath(`/ledger/${ledgerId}`, 'layout')
    return { ok: message }
  } catch (error) {
    if (error instanceof FxError || error instanceof InvoiceError || (error instanceof Error && ['PostingError', 'PaymentError'].includes(error.name))) return { error: (error as Error).message }
    let cause: unknown = error
    for (let i = 0; i < 8 && cause && typeof cause === 'object'; i++) {
      const current = cause as { message?: string; cause?: unknown }
      if (current.message && /\b(FX_|INVOICE_|APPLICATION_|PERIOD_|RECONCILED:)/.test(current.message) && !current.message.startsWith('Failed query')) return { error: current.message.replace(/^[A-Z_]+:\s*/, '') }
      cause = current.cause
    }
    console.error('❌ [FX] Operation failed', error instanceof Error ? error.name : 'Unknown error')
    return { error: 'The change could not be saved. Check the currency, account, date and source amounts, then try again.' }
  }
}

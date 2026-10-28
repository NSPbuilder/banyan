import 'server-only'
import { accountInLedger, BankError, importBankRows, belongsToLedger, postFromBankRow } from './bank'
import { BANK_FIELDS, rowsFromField, WireError } from './bank-wire'
import { causesOf } from './db-errors'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { currencyDigits,parseNative,FxError } from './fx-money'
import { MATCH_FIELDS,type FormResult } from './forms'
import { MAX_BANK_SPLITS,type BankSplit } from './bank-splits'
import { attachIfAny } from './attach-forms'
import { AttachmentError } from './attachments'
import { PostingError } from './posting'

/**
 * The boundary where parsed rows cross from the browser into the books.
 *
 * Separated from the `'use server'` action that wraps it for the same reason as
 * `tax-forms.ts`: the wrapper calls `revalidatePath` and drags in enough of
 * React that no plain script can import it. Renaming one field in a component
 * once broke every submission from the browser with the whole suite green.
 *
 * Everything arriving here was typed by something on the other side of a
 * network request. It is not trusted, it is parsed — and when it does not
 * parse, it is refused with a sentence rather than coerced into something that
 * looks like money.
 */

/**
 * Drizzle wraps a driver error as "Failed query: ..." and keeps the message
 * Postgres actually raised on `cause`. Matching against `.message` alone would
 * never see a trigger's name, so every named guard below would fall through to
 * a raw stack trace on screen — the check would look present and do nothing.
 */
const deepMessage = (e: unknown) => causesOf(e)

export type BankFormResult = { error?: string; ok?: string }

export async function importBankFromForm(formData: FormData, actor: string): Promise<BankFormResult> {
  const accountId = String(formData.get(BANK_FIELDS.accountId) ?? '')
  if (!accountId) return { error: 'Choose the account this statement belongs to.' }

  // The dropdown only ever offers this company's accounts, but the value posted
  // back is a string like any other. Without this, a request built by hand could
  // land a statement in another company's books — and the row carries no ledger,
  // so nothing downstream would ever notice the mismatch.
  const ledgerId = String(formData.get(BANK_FIELDS.ledgerId) ?? '')
  if (!ledgerId || !(await accountInLedger(accountId, ledgerId))) {
    return { error: 'That account does not belong to this company.' }
  }

  const [bound]=await db.execute<{currency:string}>(sql`SELECT COALESCE(a.foreign_currency,l.currency) AS currency FROM account a
    JOIN ledger l ON l.entity_id=a.entity_id WHERE a.id=${accountId}::uuid AND l.id=${ledgerId}::uuid`)
  const declared=String(formData.get('bankCurrency')??'')
  if((declared && declared!==bound.currency)||(!declared && currencyDigits(bound.currency)!==2))return {error:'Read this file with the bank account currency selected before saving its native amounts.'}
  try {
    const rows = rowsFromField(String(formData.get(BANK_FIELDS.rows) ?? ''))
    const result = await importBankRows({
      accountId,
      rows,
      sourceFile: String(formData.get(BANK_FIELDS.sourceFile) ?? '') || undefined,
      actor: actor,
    })

    const parts = [`${result.inserted} row${result.inserted === 1 ? '' : 's'} saved`]
    if (result.duplicates > 0) {
      parts.push(`${result.duplicates} already there and skipped`)
    }
    return { ok: parts.join(', ') + '.' }
  } catch (e) {
    if (e instanceof WireError || e instanceof BankError) return { error: e.message }
    const m = deepMessage(e)
    // The database guards raise their own named errors; showing the raw
    // "Failed query" wrapper would tell nobody anything.
    if (m.includes('NOT_POSTABLE')) {
      return { error: 'That is a heading account. Choose the account the statement is for.' }
    }
    if (m.includes('INACTIVE_ACCOUNT')) return { error: 'That account is not active.' }
    if (m.includes('OCCURRENCE_GAP')) {
      return { error: 'Those rows could not be numbered consistently. Read the file again.' }
    }
    // 0055/0056: a NEW row dated inside a finished reconciliation. Rows already
    // on file pass through — an overlapping file is the ordinary case — so this
    // is a row the bank added after that statement was signed off.
    if (m.includes('RECONCILED:')) {
      const when = /reconciliation of (\d{4}-\d{2}-\d{2})/.exec(m)?.[1]
      return { error: `That file has a new row inside the finished reconciliation${when ? ` of ${when}` : ''}. `
        + 'Nothing was saved. Undo that reconciliation first if the row is real.' }
    }
    throw e
  }
}

/** Foreign feed rows retain native input units and accept evidenced actual rates. */
export async function postForeignBankRowFromForm(form:FormData,actor:string):Promise<FormResult|null>{
  const ledgerId=String(form.get(MATCH_FIELDS.ledgerId)??''),rowId=String(form.get(MATCH_FIELDS.rowId)??'')
  const [row]=await db.execute<{currency:string;txn_date:string}>(sql`SELECT a.foreign_currency AS currency,b.txn_date::text
    FROM bank_transaction b JOIN account a ON a.id=b.account_id JOIN ledger l ON l.entity_id=a.entity_id
    WHERE b.id=${rowId}::uuid AND l.id=${ledgerId}::uuid AND a.id=${String(form.get(MATCH_FIELDS.accountId)??'')}::uuid AND a.foreign_currency IS NOT NULL`)
  if(!row)return null
  try{
    const get=(field:string)=>String(form.get(field)??'').trim()
    const account=get(MATCH_FIELDS.contraAccountId),party=get(MATCH_FIELDS.partyId)
    let splits:BankSplit[]|undefined
    if(get(MATCH_FIELDS.splitMode)==='yes'){
      const ids=form.getAll(MATCH_FIELDS.splitAccountId).map(String),amounts=form.getAll(MATCH_FIELDS.splitAmount).map(String)
      if(ids.length<2||ids.length>MAX_BANK_SPLITS||ids.length!==amounts.length)return {error:'Split into 2 to 20 accounts, each with an amount.'}
      splits=[]
      for(let i=0;i<ids.length;i++){
        if(!await belongsToLedger('account',ids[i],ledgerId))return {error:'Choose accounts from this company for every split.'}
        splits.push({accountId:ids[i],amount:parseNative(amounts[i],row.currency)})
      }
    }else if(!account||!await belongsToLedger('account',account,ledgerId))return {error:'Choose the account for the other side of the entry.'}
    if(party&&!await belongsToLedger('party',party,ledgerId))return {error:'Choose a party from this company.'}
    const result=await postFromBankRow({bankTransactionId:rowId,contraAccountId:account,splits,partyId:party||undefined,
      taxCode:get(MATCH_FIELDS.taxCode)||undefined,description:get(MATCH_FIELDS.description),actor,
      rate:get('fxRate')?{currency:row.currency,rate:get('fxRate'),observedOn:get('fxRateDate')||row.txn_date,source:'manual',reference:get('fxRateEvidence')}:undefined})
    const paper=await attachIfAny(form,{ledgerId,entryId:result.entryId,actor})
    return {ok:`Posted ${result.entryNo}.${paper?' '+paper:''}`}
  }catch(error){
    if(error instanceof FxError||error instanceof BankError||error instanceof AttachmentError||error instanceof PostingError)return {error:error.message}
    const message=causesOf(error)
    if(/FX_|RECONCILED:|PERIOD_CLOSED/.test(message))return {error:'The foreign bank row cannot be posted at that date or currency policy. Check later activity, reconciliation and the open period.'}
    throw error
  }
}

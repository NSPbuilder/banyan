import 'server-only'
import {db} from '@/db/client'
import {sql} from 'drizzle-orm'
import {FxError,currencyDigits,parseNative} from './fx-money'
import {moneyInput} from './money'
import { AttachmentError, attachStatementFile, detachStatementFile, validateStatementDocument } from './attachments'
import { MATCH_FIELDS as F, STATEMENT_FILE_FIELDS as S, type FormResult } from './forms'

export async function readStatementUpload(form: FormData) {
  const file = form.get(S.file)
  if (!(file instanceof File) || !file.name) return null
  if (file.size > 25 * 1024 * 1024) throw new AttachmentError('TOO_BIG', 'Statement files must be 25 MB or smaller.')
  const bytes = Buffer.from(await file.arrayBuffer())
  validateStatementDocument(bytes)
  return { filename: file.name, bytes }
}

const scope = (form: FormData, actor: string) => ({
  ledgerId: String(form.get(F.ledgerId) ?? ''), accountId: String(form.get(F.accountId) ?? ''),
  statementId: String(form.get(F.statementId) ?? ''), actor,
})

function refusal(e: unknown, verb: string): FormResult {
  if (e instanceof AttachmentError) return { error: e.message }
  console.error('Statement file operation failed', e)
  return { error: `The statement file could not be ${verb}. Please try again.` }
}

export async function uploadStatementFileFromForm(form: FormData, actor: string): Promise<FormResult> {
  try {
    const file = await readStatementUpload(form)
    if (!file) return { error: 'Choose a statement file.' }
    const saved = await attachStatementFile({ ...scope(form, actor), ...file })
    return { ok: saved.warning ?? 'Statement file uploaded.' }
  } catch (e) { return refusal(e, 'uploaded') }
}

export async function removeStatementFileFromForm(form: FormData, actor: string): Promise<FormResult> {
  try {
    const removed = await detachStatementFile({ ...scope(form, actor),
      attachmentId: String(form.get(S.attachmentId) ?? ''), reason: String(form.get('reason') ?? '') })
    return { ok: removed.warning ?? 'Statement file removed.' }
  } catch (e) { return refusal(e, 'removed') }
}

/** Convert native text to the legacy form reader's fixed two-decimal wire units. */
export async function nativeBankForm(form:FormData,mode:'statement'|'splits'):Promise<FormResult|null>{
  const ledgerId=String(form.get(F.ledgerId)??''),accountId=String(form.get(F.accountId)??'')
  const [bank]=await db.execute<{currency:string}>(sql`SELECT COALESCE(a.foreign_currency,l.currency) AS currency FROM account a
    JOIN ledger l ON l.entity_id=a.entity_id WHERE l.id=${ledgerId}::uuid AND a.id=${accountId}::uuid
    ${mode==='splits'?sql`AND EXISTS(SELECT 1 FROM bank_transaction WHERE id=${String(form.get(F.rowId)??'')}::uuid AND account_id=a.id)`:sql``}`)
  if(!bank)return {error:'Choose a bank account and row from these books.'}
  if(currencyDigits(bank.currency)===2)return null
  try{
    if(mode==='statement')form.set(F.endingBalance,moneyInput(parseNative(String(form.get(F.endingBalance)??''),bank.currency)))
    else if(form.get(F.splitMode)==='yes'){
      const amounts=form.getAll(F.splitAmount).map(v=>moneyInput(parseNative(String(v),bank.currency)))
      form.delete(F.splitAmount);for(const amount of amounts)form.append(F.splitAmount,amount)
    }
    return null
  }catch(error){if(error instanceof FxError)return {error:error.message};throw error}
}

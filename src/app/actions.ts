'use server'
import {nativeBankForm} from '@/lib/bank-statement-forms'

import {accountEditFromForm,attachPartyFromForm,partyEditFromForm} from '@/lib/master-forms'

import { cookies } from 'next/headers'
import { SESSION_COOKIE } from '@/lib/gate'
import { withDocumentWrite } from '@/lib/edit-leases'
import { proofFrom, type EditContext } from '@/lib/edit-proof'
import { type Tx } from '@/lib/acting'
import { formatNumber } from '@/lib/numbers'
import { formatMoney } from '@/lib/money'
import { revalidatePath } from 'next/cache'
import { messageFor } from '@/lib/action-messages'
import { redirect } from 'next/navigation'
import { rebuildLedgerBalances } from '@/lib/balances'
import { createCompanyReady, createFiscalYear, deleteFiscalYear, SetupError } from '@/lib/setup'
import {companySetupPlan,CompanySetupError} from '@/lib/company-onboarding'
import {pendingMigrations} from '@/lib/schema-version'
import {
  AccountError, createAccount, DEFAULT_BALANCE, importAccounts,
  parseAccountsCsv, type AccountType,
} from '@/lib/accounts'
import {
  companyFromFormData, entryHeaderFrom, FormError, rolesFromFormData, TAX_FIELDS,
} from '@/lib/forms'
import { entryLinesFrom, postEntryFromForm } from '@/lib/entry-forms'
import {
  ceaseTaxFromForm, correctRegistrationFromForm, deleteRegistrationFromForm, registerTaxFromForm,
} from '@/lib/tax-forms'
import { importBankFromForm,postForeignBankRowFromForm } from '@/lib/bank-forms'
import { clearServiceFromForm, saveServiceFromForm } from '@/lib/assistant-forms'
import { confirmSkillCommandFromForm, inquireFromForm, keepLookingFromForm } from '@/lib/inquiry-forms'
import { discardReadingFromForm, readBillFromForm } from '@/lib/bill-forms'
import { BILL_FIELDS } from '@/lib/forms'
import { BACKUP_EXT } from '@/lib/backup-name'
import { ASSISTANT_FIELDS } from '@/lib/forms'
import { BANK_FIELDS } from '@/lib/bank-wire'
import {
  acceptMatchesFromForm, deleteRowFromForm, deleteStatementFromForm, finishFromForm, ignoreFromForm, matchFromForm,
  postFromRowForm, saveStatementFromForm, undoFromForm, unignoreFromForm,
  unmatchFromForm,
} from '@/lib/match-forms'
import { INVOICE_FIELDS, MATCH_FIELDS, OPENING_FIELDS, PARTY_FIELDS, invoiceListFor } from '@/lib/forms'
import {
  createInvoiceFromForm, deleteInvoiceFromForm, postInvoiceFromForm,
  updateInvoiceFromForm,
} from '@/lib/invoice-forms'
import {
  applyCreditFromForm, deletePaymentFromForm, payInvoiceFromForm, unapplyFromForm,
} from '@/lib/payment-forms'
import {
  createPartyFromForm,
  type FormResult,
} from '@/lib/party-forms'
import { quickEntryFromForm } from '@/lib/quick-forms'
import { QUICK_FIELDS } from '@/lib/forms'
import { openingFromForm } from '@/lib/opening-forms'
import { entityOfLedger } from '@/lib/access'
import { appearanceFrom } from '@/lib/appearance'
import { saveAppearance } from '@/lib/users'
import {
  BackupError, inspectFigtree, readFigtree, restoreCompany, restorePaper,
} from '@/lib/backup'
import { BACKUP_FIELDS } from '@/lib/forms'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { openingCandidates } from '@/lib/opening'
import { currentActor, requireEntity, requireLedger, requireOwner, requireUser } from '@/lib/gate'
import { closePeriod, reopenPeriod } from '@/lib/periods'

import {
  amendEntry, closeFiscalYear, deleteEntry, discardDraft, editEntry, reopenFiscalYear,
  reverseEntry, saveDraft, } from '@/lib/posting'
import { refuseUnlessOurs } from '@/lib/ours'

export async function rebuildBalances(ledgerId: string) {
  await requireLedger(ledgerId, '')
  const result = await rebuildLedgerBalances(ledgerId, 'ledger page')
  revalidatePath(`/ledger/${ledgerId}`)
  return result
}

/**
 * Reading a company back out of a `.fig` file.
 *
 * It never writes over anything: `restoreCompany` makes a NEW company, and
 * refuses outright if the code is taken. The seat is `/backup`, which is a
 * seat of its own because the file is the whole company — everything anybody
 * with any other seat can see, in one download.
 *
 * The paper is put back AFTER the books, and a store that refuses does not
 * turn a restore that already succeeded into a failure: the same rule the
 * attachment doors follow.
 */
export async function restoreBackupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(BACKUP_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/backup')
  // The superadmin, as the screen and RISKS §1 say: the load runs with every
  // trigger off, and the code had drifted to admitting any owner (security
  // review, 2026-10-20).
  const me = await requireOwner()
  if (me.kind !== 'superadmin') return { error: 'Restoring a company needs the superadmin account.' }
  const file = formData.get(BACKUP_FIELDS.file)
  if (!(file instanceof File) || file.size === 0) {
    return { error: `Choose a ${BACKUP_EXT} file to restore.` }
  }
  try {
    const doc = readFigtree(Buffer.from(await file.arrayBuffer()))
    const seen = await inspectFigtree(doc)
    const made = await restoreCompany(doc, await currentActor(), {
      code: String(formData.get(BACKUP_FIELDS.code) ?? '').trim() || undefined,
      name: String(formData.get(BACKUP_FIELDS.name) ?? '').trim() || undefined,
    })
    let paper = 0
    try {
      paper = await restorePaper(doc, made.name, made.ledgerId, made)
    } catch {
      // The books are in. Say so, and say the paper is not.
      revalidatePath('/companies')
      return {
        ok: `${made.code} ${made.name} restored — ${formatNumber(seen.entries)} entries and `
          + `${seen.auditIncluded ? `${seen.audit} historical audit events` : 'no historical audit events (legacy v1 file)'}. The receipts could `
          + 'not be written to the file store; the ledger and audit history are restored, but the paper is incomplete.',
      }
    }
    revalidatePath('/companies')
    revalidatePath('/')
    return {
      ok: `${made.code} ${made.name} restored — ${formatNumber(seen.entries)} entries, ${formatNumber(seen.accounts)} accounts`
        + `${paper > 0 ? `, ${paper} receipt${paper === 1 ? '' : 's'}` : ''}, `
        + `${seen.auditIncluded ? `${seen.audit} historical audit event${seen.audit === 1 ? '' : 's'}`
          : 'no historical audit history (legacy v1 file)'}.`
        + (seen.missingPaper ? ` ${seen.missingPaper} document file${seen.missingPaper===1?' was':'s were'} not included in this backup; attachment metadata is restored, but document recovery is incomplete.` : ''),
    }
  } catch (e) {
    if (e instanceof BackupError) return { error: e.message }
    return { error: messageFor(e) }
  }
}

/**
 * How this person wants the screen to look (0067).
 *
 * `requireUser` and nothing else: it writes to the row of whoever is asking,
 * so there is no company to check and nobody else's screen to change. The
 * choices are made safe by `appearanceFrom` before they reach the database,
 * which checks their values too.
 *
 * Revalidates the layout, not a page: the shell is what stamps the choice on
 * `<html>`, so every open screen has to be told, not just this one.
 */
export async function saveAppearanceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireUser()
  const look = appearanceFrom(
    formData.get('theme'), formData.get('mode'), undefined, formData.get('liquidTint'),
  )
  try {
    await saveAppearance(me.id, look)
    revalidatePath('/', 'layout')
    return { ok: 'Saved.' }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

export type FormState = {
  error?: string; ok?: string; entryId?: string; version?: string
  /**
   * What a door just created, for a caller that has to go on using it — the
   * picker creates a party or an account from inside a form it must not
   * leave, and then has to select the thing it made (2026-09-07).
   */
  madeId?: string; madeLabel?: string
}

/**
 * Returns the error instead of throwing it. A thrown SetupError renders a 500
 * page, which tells someone who mistyped a year end nothing at all.
 * `redirect()` still throws by design and must not be caught here, so the
 * success path is deliberately outside the try.
 */
export async function createCompanyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireOwner()
  if((await pendingMigrations()).length)return {error:'Database updates are pending. Ask the administrator to apply them before creating a company. Your answers are still here.'}
  let ledgerId: string
  try {
    ledgerId = (await createCompanyFrom(formData)).ledger.id
  } catch (e) {
    if (e instanceof SetupError || e instanceof FormError || e instanceof CompanySetupError) return { error: e.message }
    throw e
  }
  revalidatePath('/companies')
  redirect(`/ledger/${ledgerId}/getting-started`)
}

export async function createFiscalYearAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '')
  try {
    await createFiscalYear(ledgerId, String(formData.get('endDate') ?? ''), await currentActor())
  } catch (e) {
    if (e instanceof SetupError) return { error: e.message }
    throw e
  }
  revalidatePath(`/ledger/${ledgerId}`)
  return {}
}

/** A fiscal year created by mistake, deleted while it holds nothing (0084). */
export async function deleteFiscalYearAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/periods')
  const fiscalYearId = String(formData.get('fiscalYearId') ?? '')
  const nope = await refuseUnlessOurs([['fiscal_year', fiscalYearId]], ledgerId)
  if (nope) return nope
  try {
    const gone = await deleteFiscalYear(ledgerId, fiscalYearId, await currentActor())
    revalidatePath(`/ledger/${ledgerId}/periods`)
    revalidatePath(`/ledger/${ledgerId}`)
    return { ok: `${gone.name} and its periods are deleted.` }
  } catch (e) {
    if (e instanceof SetupError) return { error: e.message }
    throw e
  }
}

async function createCompanyFrom(formData: FormData) {
  // The fiscal year comes with the company: without one, nothing can be posted,
  // so it was never really a separate decision.
  const onboarding=formData.has('setupStart')?companySetupPlan({start:String(formData.get('setupStart')),focus:formData.getAll('setupFocus').map(String),...(formData.has('setupChart')?{chart:String(formData.get('setupChart'))}:{})}):undefined
  return createCompanyReady({...companyFromFormData(formData),onboarding}, await currentActor())
}

export async function importAccountsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const entityId = String(formData.get('entityId') ?? '')
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/accounts')
  await requireEntity(entityId)
  try {
    const rows = parseAccountsCsv(String(formData.get('csv') ?? ''))
    const created = await importAccounts(entityId, rows.map((r) => ({ ...r, entityId })), await currentActor())
    revalidatePath(`/ledger/${ledgerId}/accounts`)
    return { ok: `Imported ${formatNumber(created.length)} account${created.length === 1 ? '' : 's'}.` }
  } catch (e) {
    if (e instanceof AccountError) {
      return { error: e.line ? `Line ${e.line}: ${e.message}` : e.message }
    }
    throw e
  }
}

export async function setAccountRolesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId=String(formData.get('ledgerId')??'');await requireLedger(ledgerId,'/accounts')
  try { const result=await accountEditFromForm('roles',formData,(await cookies()).get(SESSION_COOKIE)?.value??'');revalidatePath(`/ledger/${ledgerId}/accounts`);return result }
  catch(e){return {error:messageFor(e)}}
}

async function editContext(form: FormData, leaseRequired = true): Promise<EditContext> {
  return {sessionToken:(await cookies()).get(SESSION_COOKIE)?.value ?? '',proof:proofFrom(form),leaseRequired}
}
async function entryWrite<T extends object>(form: FormData, required: boolean, command: (tx: Tx, actor: string) => Promise<T>) {
  return withDocumentWrite({ledgerId:String(form.get('ledgerId') ?? ''),type:'entry',id:String(form.get('entryId') ?? '')},await editContext(form,required),command)
}

export async function saveDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/entries')
  const entryId = String(formData.get('entryId') ?? '') || undefined
  try {
    const { lines, dropped } = await entryLinesFrom(ledgerId, String(formData.get('lines') ?? '[]'),
      String(formData.get('entryDate') ?? ''))
    const input = {
      ledgerId,
      ...entryHeaderFrom(formData),
      actor: await currentActor(),
      lines,
    }
    const saved = entryId ? await entryWrite(formData,true,(tx,actor)=>saveDraft({...input,actor},entryId,tx)) : await saveDraft(input)
    revalidatePath(`/ledger/${ledgerId}/entries`)
    return {
      ok: `Draft saved${dropped ? ` — ${dropped} incomplete row${dropped === 1 ? '' : 's'} left out` : ''}.`,
      entryId: saved.id, version:String(saved.version),
    }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

export async function postDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/entries')
  const entryId = String(formData.get('entryId') ?? '') || undefined
  try {
    const result = await postEntryFromForm(formData, { ledgerId, entryId, actor: await currentActor() }, entryId ? await editContext(formData) : undefined)
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}`)
    // The id comes back either way. Without it the next attempt at a rejected
    // post writes a second draft, and every retry after that another one.
    return result
  } catch (e) {
    return { error: messageFor(e), entryId }
  }
}

export async function editEntryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/entries')
  const entryId = String(formData.get('entryId') ?? '')
  const reason = String(formData.get('reason') ?? '').trim()
  try {
    const { lines, dropped } = await entryLinesFrom(ledgerId, String(formData.get('lines') ?? '[]'),
      String(formData.get('entryDate') ?? ''))
    const saved = await entryWrite(formData,true,(tx,actor)=>editEntry(entryId, {
      ...entryHeaderFrom(formData),
      lines,
    }, actor, ledgerId, reason, tx))
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}`)
    const bits = ['Saved. The books moved with it.']
    if (saved.releasedApplications > 0) bits.push(`${saved.releasedApplications} application(s) released — that debt is owed again.`)
    if (saved.releasedMatches > 0) bits.push(`${saved.releasedMatches} bank match(es) released — reconcile again.`)
    if (dropped) bits.push(`${dropped} incomplete row${dropped === 1 ? '' : 's'} left out.`)
    return { ok: bits.join(' '), entryId, version:saved.version }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

export async function deleteEntryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/entries')
  const entryId = String(formData.get('entryId') ?? '')
  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) return { error: 'Say why this posted entry is being deleted.' }
  let said: URLSearchParams
  try {
    const gone = await entryWrite(formData,false,(tx,actor)=>deleteEntry(entryId,actor,ledgerId,reason,tx))
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}`)
    // COUNTS, not a sentence: the journal words it with `deletedEntrySentence`,
    // so a crafted address cannot put text of its own on the page.
    said = new URLSearchParams({
      gone: gone.entryNo ?? '',
      apps: String(gone.releasedApplications),
      matches: String(gone.releasedMatches),
    })
  } catch (e) {
    return { error: messageFor(e) }
  }
  // The entry's own page is what this was pressed on, and it is now a 404
  // (see deletePartyAction). The journal carries the consequences instead.
  redirect(`/ledger/${ledgerId}/entries?${said}`)
}

export async function discardDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/entries')
  try {
    await entryWrite(formData,false,(tx,actor)=>discardDraft(String(formData.get('entryId') ?? ''),actor,ledgerId,tx))
  } catch (e) {
    return { error: messageFor(e) }
  }
  revalidatePath(`/ledger/${ledgerId}/entries`)
  redirect(`/ledger/${ledgerId}/entries`)
}


export async function createAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  // Not only the chart screen any more. Every screen that picks an account
  // can make one from inside the list (owner, 2026-09-07), so the seats those
  // screens sit on open this door too. A widening, deliberately: somebody who
  // may enter a bill may add the expense account it belongs in, because the
  // alternative is that they cannot enter the bill. Changing or retiring an
  // account is still `/accounts` alone.
  await requireLedger(ledgerId, ['/accounts', '/entries', '/invoices', '/bank', '/opening', '/payroll', '/cheques'])
  // The chart screen names the company; a picker on some other screen names
  // only the ledger, and the ledger already decides the company.
  // Deriving it cannot widen anything: `requireLedger` has just settled that
  // this person may be in these books at all.
  const entityId = String(formData.get('entityId') ?? '') || await entityOfLedger(ledgerId) || ''
  await requireEntity(entityId)
  try {
    const type = String(formData.get('accountType') ?? '') as AccountType
    const side = String(formData.get('side') ?? 'normal')
    const created = await createAccount({
      entityId,
      code: String(formData.get('code') ?? ''),
      name: String(formData.get('name') ?? ''),
      accountType: type,
      normalBalance: side === 'contra'
        ? (DEFAULT_BALANCE[type] === 'debit' ? 'credit' : 'debit')
        : undefined,
      isPostable: formData.get('isPostable') !== 'no',
      // Only the chart screen's form offers a parent; a picker creating an
      // account from inside another form posts no such field, and undefined is
      // the right answer for it — top level.
      parentCode: String(formData.get('parentCode') ?? '').trim() || undefined,
      roles: rolesFromFormData(formData),
    }, await currentActor())
    // Every screen that OFFERS an account, not just the chart: one created
    // from inside a picker has to appear in the list behind it (2026-09-07).
    for (const p of ['/accounts', '/entries', '/invoices', '/bills', '/expenses', '/income', '/bank', '/opening', '/payroll', '/cheques']) {
      revalidatePath(`/ledger/${ledgerId}${p}`)
    }
    return {
      ok: `${created.code} ${created.name} added.`,
      // The picker made this from inside a form it must not leave, and now
      // has to choose it. The label is what the list shows: code then name.
      madeId: created.id,
      madeLabel: `${created.code} ${created.name}`,
    }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

export async function updateAccountAction(_prev:FormState,formData:FormData):Promise<FormState>{
  const ledgerId=String(formData.get('ledgerId')??'');await requireLedger(ledgerId,'/accounts')
  try {const result=await accountEditFromForm('update',formData,(await cookies()).get(SESSION_COOKIE)?.value??'');revalidatePath(`/ledger/${ledgerId}/accounts`);return result}
  catch(e){return {error:messageFor(e)}}
}
export async function setAccountActiveAction(_prev:FormState,formData:FormData):Promise<FormState>{
  const ledgerId=String(formData.get('ledgerId')??'');await requireLedger(ledgerId,'/accounts')
  try {const result=await accountEditFromForm('active',formData,(await cookies()).get(SESSION_COOKIE)?.value??'');revalidatePath(`/ledger/${ledgerId}/accounts`);return result}
  catch(e){return {error:messageFor(e)}}
}
export async function deleteAccountAction(_prev:FormState,formData:FormData):Promise<FormState>{
  const ledgerId=String(formData.get('ledgerId')??'');await requireLedger(ledgerId,'/accounts')
  try {await accountEditFromForm('delete',formData,(await cookies()).get(SESSION_COOKIE)?.value??'')}
  catch(e){return {error:messageFor(e)}}
  revalidatePath(`/ledger/${ledgerId}/accounts`);redirect(`/ledger/${ledgerId}/accounts`)
}

export async function amendEntryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/entries')
  const entryId = String(formData.get('entryId') ?? '')
  try {
    const { lines } = await entryLinesFrom(ledgerId, String(formData.get('lines') ?? '[]'),
      String(formData.get('entryDate') ?? ''))
    const result = await entryWrite(formData,true,(tx,actor)=>amendEntry(entryId, {
      // The header the person actually submitted, the document number
      // included: `amendEntry` inherits the original's ref, and an explicit
      // one here overrides it — which is the only way an edited number
      // reaches the replacement.
      ...entryHeaderFrom(formData),
      actor,
      lines,
    }, actor, ledgerId, tx))
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}`)
    return {
      ok: `Corrected. ${result.original.entryNo} was reversed by ${result.reversal.entryNo}, ` +
          `and ${result.replacement.entryNo} replaces it.`,
      entryId: result.replacement.id,
    }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

export async function reverseEntryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/entries')
  try {
    const result = await entryWrite(formData,false,(tx,actor)=>reverseEntry(
      String(formData.get('entryId') ?? ''),
      String(formData.get('reversalDate') ?? ''),
      String(formData.get('reason') ?? '').trim() || 'no reason given',
      actor, ledgerId, tx,
    ))
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}`)
    return { ok: `${result.original.entryNo} reversed by ${result.reversal.entryNo}.` }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

export async function closeYearAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '')
  try {
    const result = await closeFiscalYear(ledgerId, String(formData.get('fiscalYearId') ?? ''), await currentActor())
    revalidatePath(`/ledger/${ledgerId}`)
    revalidatePath(`/ledger/${ledgerId}/statements`)
    revalidatePath(`/ledger/${ledgerId}/entries`)
    return {
      ok: `${result.year} closed by ${result.entry.entryNo}: ${formatNumber(result.accountsClosed)} accounts ` +
          `moved to retained earnings, ` +
          `${result.result < 0n ? 'profit' : 'loss'} of ` +
          `${formatMoney(result.result < 0n ? -result.result : result.result)}.`,
    }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

export async function closePeriodAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/periods')
  try {
    const result = await closePeriod(ledgerId, String(formData.get('periodId') ?? ''), {
      lock: formData.get('lock') === 'yes',
      overrideReason: String(formData.get('overrideReason') ?? '') || undefined,
      actor: await currentActor(),
    })
    revalidatePath(`/ledger/${ledgerId}/periods`)
    revalidatePath(`/ledger/${ledgerId}`)
    return {
      ok: `${result.name} is ${result.status}.`
        + (result.overrode.length > 0 ? ' The override is on the record.' : ''),
    }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

/**
 * Reopening a YEAR: reverses its closing entry, so the result goes back into
 * the revenue and expense accounts and the periods can be closed again. The
 * library had this since 0006; four refusals told the person to do it and
 * nothing on any screen could, until the periods page's year heading (2026-09-13).
 */
export async function reopenYearAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/periods')
  // The year beside the ledger: a Periods seat on one company must not be
  // able to reverse another company's closing entry (critic, 2026-09-13).
  const fiscalYearId = String(formData.get('fiscalYearId') ?? '')
  const nope = await refuseUnlessOurs([['fiscal_year', fiscalYearId]], ledgerId)
  if (nope) return nope
  try {
    const result = await reopenFiscalYear(
      ledgerId, fiscalYearId,
      String(formData.get('reason') ?? ''), await currentActor())
    revalidatePath(`/ledger/${ledgerId}/periods`)
    revalidatePath(`/ledger/${ledgerId}`)
    revalidatePath(`/ledger/${ledgerId}/statements`)
    return { ok: `${result.year} is open again: ${result.reversal.entryNo} reversed its closing entry. The reason is on the record.` }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

export async function reopenPeriodAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/periods')
  try {
    const result = await reopenPeriod(
      ledgerId, String(formData.get('periodId') ?? ''),
      String(formData.get('reason') ?? ''), await currentActor())
    revalidatePath(`/ledger/${ledgerId}/periods`)
    revalidatePath(`/ledger/${ledgerId}`)
    return { ok: `${result.name} is open again. The reason is on the record.` }
  } catch (e) {
    return { error: messageFor(e) }
  }
}

/**
 * Register for a sales tax and create the accounts it needs, together.
 *
 * The work is in `@/lib/tax-forms` so a test can drive it with a real FormData;
 * what is left here is the part only Next.js can do.
 */
export async function registerTaxAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(TAX_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/tax')
  const result = await registerTaxFromForm(formData, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/tax/registration`)
    revalidatePath(`/ledger/${ledgerId}/tax`)
    revalidatePath(`/ledger/${ledgerId}/accounts`)
  }
  return result
}

export async function ceaseTaxAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(TAX_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/tax')
  const result = await ceaseTaxFromForm(formData, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/tax/registration`)
    revalidatePath(`/ledger/${ledgerId}/tax`)
  }
  return result
}

/** A registration put right, or deleted — for one entered wrong (0084). */
export async function correctTaxRegistrationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(TAX_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/tax')
  const result = await correctRegistrationFromForm(formData, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/tax/registration`)
    revalidatePath(`/ledger/${ledgerId}/tax`)
  }
  return result
}

export async function deleteTaxRegistrationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(TAX_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/tax')
  const result = await deleteRegistrationFromForm(formData, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/tax/registration`)
    revalidatePath(`/ledger/${ledgerId}/tax`)
  }
  return result
}

export async function importBankAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(BANK_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/bank')
  const result = await importBankFromForm(formData, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/bank/import`)
    revalidatePath(`/ledger/${ledgerId}`)
  }
  return result
}

/**
 * The reconcile screen's actions. Each revalidates the page it was used from,
 * and the ledger page, whose banner counts what is still unreconciled.
 */
function reconcilePaths(formData: FormData) {
  const ledgerId = String(formData.get(MATCH_FIELDS.ledgerId) ?? '')
  const accountId = String(formData.get(MATCH_FIELDS.accountId) ?? '')
  // Both doors of the module and both landings: a match made on the feed
  // changes the reconcile screen's cleared balance, and the standings on the
  // landings count rows that wait.
  return [
    `/ledger/${ledgerId}/bank/${accountId}`,
    `/ledger/${ledgerId}/bank/${accountId}/reconcile`,
    `/ledger/${ledgerId}/bank`,
    `/ledger/${ledgerId}/bank/reconcile`,
    `/ledger/${ledgerId}`,
  ]
}

async function reconcileAction(
  formData: FormData,
  handler: (fd: FormData) => Promise<FormState>,
): Promise<FormState> {
  await requireLedger(String(formData.get(MATCH_FIELDS.ledgerId) ?? ''), '/bank')
  const result = await handler(formData)
  if (result.ok) for (const p of reconcilePaths(formData)) revalidatePath(p)
  return result
}

export async function matchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => matchFromForm(fd, await currentActor()))
}
export async function unmatchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => unmatchFromForm(fd, await currentActor()))
}
export async function ignoreRowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => ignoreFromForm(fd, await currentActor()))
}
export async function unignoreRowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => unignoreFromForm(fd, await currentActor()))
}
export async function deleteBankRowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => deleteRowFromForm(fd, await currentActor()))
}
export async function postFromRowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => (await postForeignBankRowFromForm(fd,await currentActor())) ?? postFromRowForm(fd, await currentActor()))
}
export async function saveStatementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => (await nativeBankForm(fd,'statement')) ?? saveStatementFromForm(fd, await currentActor()))
}
export async function deleteStatementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => deleteStatementFromForm(fd, await currentActor()))
}
export async function uploadStatementFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { uploadStatementFileFromForm } = await import('@/lib/bank-statement-forms')
  return reconcileAction(formData, async (fd) => uploadStatementFileFromForm(fd, await currentActor()))
}
export async function removeStatementFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { removeStatementFileFromForm } = await import('@/lib/bank-statement-forms')
  return reconcileAction(formData, async (fd) => removeStatementFileFromForm(fd, await currentActor()))
}
export async function acceptMatchesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => acceptMatchesFromForm(fd, await currentActor()))
}
export async function finishReconciliationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => finishFromForm(fd, await currentActor()))
}
export async function undoReconciliationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return reconcileAction(formData, async (fd) => undoFromForm(fd, await currentActor()))
}

/**
 * The two ways onto the list. Both go through `party-forms.ts`, which is where
 * the reading and the error wording live — so what the checks run is what this
 * page runs.
 */
async function partyAction(formData:FormData,operation:import('@/lib/master-forms').PartyOperation):Promise<FormState>{
  const ledgerId=String(formData.get(PARTY_FIELDS.ledgerId)??'');await requireLedger(ledgerId,'/parties')
  try{const result=await partyEditFromForm(operation,formData,(await cookies()).get(SESSION_COOKIE)?.value??'');if(result.ok)refreshParties(ledgerId);return result}
  catch(e){return {error:messageFor(e)}}
}

/**
 * Every screen that OFFERS a party, not just the address book: one created
 * from inside a picker has to appear in the list behind it (2026-09-07).
 * A function rather than a line inside `partyAction`, because the creating
 * door does not go through `partyAction` any more — see below — and two
 * copies of this list would mean a party that appears on some screens.
 */
function refreshParties(ledgerId: string) {
  revalidatePath(`/ledger/${ledgerId}/parties`,'layout')
  revalidatePath(`/ledger/${ledgerId}/income/email`,'layout')
  for (const p of ['/parties', '/entries', '/invoices', '/bills', '/expenses', '/income', '/bank', '/records', '/payroll', '/cheques']) {
    revalidatePath(`/ledger/${ledgerId}${p}`)
  }
}

/**
 * The invoice screen's three actions.
 *
 * `createInvoiceAction` has to hand the reader a way to name an account,
 * because a refusal that says "line 2 (a uuid) has no amount" is a refusal
 * nobody can act on. The opening balance screen shipped exactly that, with
 * every check green, because the check supplied a name map the page did not.
 */
async function invoiceAction(
  formData: FormData, run: () => Promise<FormResult>,
): Promise<FormState> {
  const ledgerId = String(formData.get(INVOICE_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/invoices')
  const result = await run()
  if (result.ok) {
    // The two pages the invoice list became. Naming the list itself would
  // name a route that no longer exists (critic, 2026-09-03).
  revalidatePath(`/ledger/${ledgerId}/expenses`)
  revalidatePath(`/ledger/${ledgerId}/income`)
    revalidatePath(`/ledger/${ledgerId}/invoices`)
    revalidatePath(`/ledger/${ledgerId}/bills`, 'layout')
    revalidatePath(`/ledger/${ledgerId}/projects`, 'layout')
    revalidatePath(`/ledger/${ledgerId}`)
  }
  return result
}

/** "1000 — Cash" for an account id over this ledger's chart: what a refused line is called back by. */
async function accountNamer(ledgerId: string): Promise<(id: string) => string> {
  const accounts = await db.execute<{ id: string; code: string; name: string }>(sql`
    SELECT a.id::text, a.code, a.name
      FROM account a JOIN ledger l ON l.entity_id = a.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  return (id) => {
    const a = accounts.find((x) => x.id === id)
    return a ? `${a.code} — ${a.name}` : id
  }
}

export async function createInvoiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  formData.set(INVOICE_FIELDS.direction, 'sales')
  const ledgerId = String(formData.get(INVOICE_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/invoices')
  const nameOf = await accountNamer(ledgerId)
  return invoiceAction(formData, async () => createInvoiceFromForm(formData, nameOf, await currentActor()))
}

export async function createBillAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  formData.set(INVOICE_FIELDS.direction, 'purchase')
  const ledgerId = String(formData.get(INVOICE_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/invoices')
  const nameOf = await accountNamer(ledgerId)
  return invoiceAction(formData, async () => createInvoiceFromForm(formData, nameOf, await currentActor()))
}

export async function updateInvoiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const ledgerId = String(formData.get(INVOICE_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/invoices')
  const nameOf = await accountNamer(ledgerId)
  return invoiceAction(formData, async () => updateInvoiceFromForm(formData,nameOf,await currentActor(),await editContext(formData)))
}

export async function deleteInvoiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const result = await invoiceAction(formData,
    async () => deleteInvoiceFromForm(formData,await currentActor(),await editContext(formData,false)))
  if (result.error) return result
  // And leave: the document's own page is gone (see deletePartyAction). Back
  // to the list it belonged to — the invoice list became two pages, so which
  // one depends on the direction, which the form carries.
  const ledgerId = String(formData.get(INVOICE_FIELDS.ledgerId) ?? '')
  redirect(`/ledger/${ledgerId}${invoiceListFor(String(formData.get(INVOICE_FIELDS.direction) ?? ''))}`)
}

export async function postInvoiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  return invoiceAction(formData, async () => postInvoiceFromForm(formData,await currentActor(),await editContext(formData,false)))
}

export async function payInvoiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  return invoiceAction(formData, async () => payInvoiceFromForm(formData, await currentActor()))
}

export async function applyCreditAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  return invoiceAction(formData, async () => applyCreditFromForm(formData, await currentActor()))
}

export async function deletePaymentAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  return invoiceAction(formData, async () => deletePaymentFromForm(formData, await currentActor()))
}

export async function unapplyAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  return invoiceAction(formData, async () => unapplyFromForm(formData, await currentActor()))
}

export async function quickEntryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(QUICK_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/entries')
  const result = await quickEntryFromForm(formData, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}`)
  }
  return result
}

/**
 * ADDING somebody to the list — and the one party door that is not only for
 * the address book.
 *
 * Every screen that picks a party can now make one from inside the list
 * (owner, 2026-09-07), so this runs for a person holding any of the seats
 * those screens sit on. That IS a widening, and it is written here rather
 * than left to be discovered: somebody who may enter an invoice may add the
 * customer it is for, because the alternative is that they cannot enter the
 * invoice at all.
 *
 * It is only this door. The rest of `party-forms.ts` — renaming, ending a
 * role, deleting — still goes through `partyAction` and still asks for
 * `/parties`, which is why this does not simply pass a wider seat list down
 * to it: that would have handed every party door to every seat on this list.
 */
export async function createPartyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(PARTY_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, ['/parties', '/entries', '/invoices', '/bank', '/payroll', '/records', '/cheques'])
  // A picker names the ledger; the role a new party holds is held in a
  // COMPANY, and the ledger already decides which company that is.
  if (!formData.get(PARTY_FIELDS.entityId)) {
    const derived = await entityOfLedger(ledgerId)
    if (derived) formData.set(PARTY_FIELDS.entityId, derived)
  }
  const result = await createPartyFromForm(formData, await currentActor())
  if (result.ok) refreshParties(ledgerId)
  return result
}

export async function attachPartyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId=String(formData.get(PARTY_FIELDS.ledgerId)??'')
  await requireLedger(ledgerId,'/parties')
  try{
    const result=await attachPartyFromForm(formData,(await cookies()).get(SESSION_COOKIE)?.value??'')
    if(result.ok)refreshParties(ledgerId)
    return result
  }catch(e){return {error:messageFor(e)}}
}

export async function grantRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return partyAction(formData, 'grantRole')
}

export async function updatePartyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return partyAction(formData, 'update')
}
export async function setPartyEmailAction(_prev:FormState,formData:FormData):Promise<FormState>{return partyAction(formData,'contact')}

export async function setAddressAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return partyAction(formData, 'address')
}

export async function endRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return partyAction(formData, 'endRole')
}

/** A role's dates put right, a role given by mistake deleted, an address removed (0084). */
export async function correctRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return partyAction(formData, 'correctRole')
}
export async function deleteRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return partyAction(formData, 'deleteRole')
}
export async function deleteAddressAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return partyAction(formData, 'deleteAddress')
}

export async function deactivatePartyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return partyAction(formData, 'deactivate')
}

export async function reactivatePartyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return partyAction(formData, 'reactivate')
}

/**
 * Delete forever — and LEAVE, because the page it was pressed on is gone.
 *
 * It used to answer "Deleted." and stand still. The browser was then at
 * `/ledger/<l>/parties/<p>`, which `PartyBody` answers with `notFound()` the
 * moment anything renders it again — so the next reload was a 404, and the
 * desk, which remembers each tab's current url in localStorage, brought that
 * 404 back on every reload after it. The owner had to clear the browser's
 * storage to get out of it (2026-09-15). `redirect` throws by design, so the
 * success path sits outside the refusal handling, as it does for a discarded
 * draft — the same shape, for the same reason.
 */
export async function deletePartyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await partyAction(formData, 'delete')
  if (result.error) return result
  const ledgerId = String(formData.get(PARTY_FIELDS.ledgerId) ?? '')
  redirect(`/ledger/${ledgerId}/parties`)
}

export async function openingBalanceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const ledgerId = String(formData.get(OPENING_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/opening')

  // A name map, so a figure that will not parse is refused against "1000 — Cash"
  // rather than against a uuid. Without it the default is the id itself, and the
  // check that says the account is named passed only because the harness handed
  // in a map the shipped path never did.
  const [entity] = await db.execute<{ id: string }>(sql`
    SELECT e.id::text FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  const accounts = entity ? await openingCandidates(entity.id) : []
  const nameOf = (id: string) => {
    const a = accounts.find((x) => x.id === id)
    return a ? `${a.code} — ${a.name}` : id
  }

  const result = await openingFromForm(formData, nameOf, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/opening`)
    revalidatePath(`/ledger/${ledgerId}`)
    revalidatePath(`/ledger/${ledgerId}/statements`)
  }
  return result
}

// ------------------------------------------------------------ attachments --

/**
 * The attachment doors. The panel is on the invoice screen as well as the
 * journal entry's, so either seat opens them. A bookkeeper granted Invoices
 * and not Journal entries was thrown off the page on Attach (critic,
 * 2026-09-07).
 */
async function attachmentDoor(
  formData: FormData, run: (f: FormData, actor: string) => Promise<FormState>,
): Promise<FormState> {
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, ['/entries', '/invoices'])
  const result = await run(formData, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}/invoices`)
    revalidatePath(`/ledger/${ledgerId}/bills`, 'layout')
    revalidatePath(`/ledger/${ledgerId}`)
  }
  return result
}

export async function uploadAttachmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { uploadAttachmentFromForm } = await import('@/lib/attach-forms')
  return attachmentDoor(formData, uploadAttachmentFromForm)
}

export async function deleteAttachmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { deleteAttachmentFromForm } = await import('@/lib/attach-forms')
  return attachmentDoor(formData, deleteAttachmentFromForm)
}

export async function rebuildAttachmentsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { rebuildAttachmentTree, checkAttachmentIntegrity } = await import('@/lib/attachments')
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '')
  try {
    const { links } = await rebuildAttachmentTree(ledgerId, await currentActor())
    const problems = await checkAttachmentIntegrity(ledgerId)
    revalidatePath(`/ledger/${ledgerId}`)
    return problems.length === 0
      ? { ok: `Folders rebuilt: ${links} link${links === 1 ? '' : 's'}, and every file checks out against its hash.` }
      : { error: `Folders rebuilt (${formatNumber(links)} links), but ${formatNumber(problems.length)} problem${problems.length === 1 ? '' : 's'} remain: ` + problems.map((p) => p.what).slice(0, 3).join('; ') }
  } catch (e) {
    return { error: e instanceof Error ? e.message.split('\n')[0] : String(e) }
  }
}

export async function waiveReceiptAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { waiveReceiptFromForm } = await import('@/lib/attach-forms')
  const ledgerId = String(formData.get('ledgerId') ?? '')
  await requireLedger(ledgerId, ['/entries', '/invoices', ''])
  const result = await waiveReceiptFromForm(formData, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}`)
  }
  return result
}

/**
 * Asking the books, and asking them again. `requireLedger` with the seat, like
 * every other per-company action: a person without the Assistant module on
 * this company is sent away before a word leaves, and the tools then ask the
 * person's seats again, one look-up at a time.
 */
export async function inquireAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(ASSISTANT_FIELDS.ledgerId) ?? '')
  const user = await requireLedger(ledgerId, '/assistant')
  const result = await inquireFromForm(formData, user)
  // A refused or failed question is rows too, so the list changes either way.
  revalidatePath(`/ledger/${ledgerId}/assistant`)
  return result
}

export async function keepLookingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(ASSISTANT_FIELDS.ledgerId) ?? '')
  const user = await requireLedger(ledgerId, '/assistant')
  const result = await keepLookingFromForm(formData, user)
  revalidatePath(`/ledger/${ledgerId}/assistant`)
  return result
}

/** Execute exactly one immutable CRM proposal after an explicit click. */
export async function confirmSkillCommandAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(ASSISTANT_FIELDS.ledgerId) ?? '')
  // The command service below independently requires CRM too; this door must
  // first be the Assistant seat (an access array means ANY, not ALL).
  const user = await requireLedger(ledgerId, '/assistant')
  const result = await confirmSkillCommandFromForm(formData, user)
  revalidatePath(`/ledger/${ledgerId}/assistant`)
  revalidatePath(`/ledger/${ledgerId}/crm`)
  return result
}

/** The person's own service — saved encrypted (0063) or forgotten. Theirs, not the company's. */
async function aiServiceDoor(
  formData: FormData, run: (who: { id: string; email: string }) => Promise<FormState>,
): Promise<FormState> {
  const ledgerId = String(formData.get(ASSISTANT_FIELDS.ledgerId) ?? '')
  // The same personal service powers both modes in the shared + AI space.
  // Anyone who may open either mode may configure their own encrypted key.
  const user = await requireLedger(ledgerId, ['/assistant', '/expenses', '/invoices'])
  const result = await run({ id: user.id, email: user.email })
  if (result.ok) {
    revalidatePath('/settings')
    revalidatePath(`/ledger/${ledgerId}/assistant`)
    revalidatePath(`/ledger/${ledgerId}/readings`)
  }
  return result
}

export async function saveAiServiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return aiServiceDoor(formData, (who) => saveServiceFromForm(formData, who))
}

export async function clearAiServiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return aiServiceDoor(formData, (who) => clearServiceFromForm(who))
}

/**
 * A bill, read (0064): the picture goes to the person's own service with this
 * company's chart, and what comes back is a proposal on the page — nothing is
 * entered. The two doors that enter it are the quick-expense and purchase-bill
 * actions above, reached through forms the proposal filled in.
 */
export async function readBillAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(BILL_FIELDS.ledgerId) ?? '')
  // The reader is on Expenses and Invoices now, so either seat opens this
  // door — the same lesson the attachment doors learned: a panel on a screen
  // whose seat the action does not accept throws the person off the page.
  const user = await requireLedger(ledgerId, ['/expenses', '/invoices', '/assistant'])
  const result = await readBillFromForm(formData, { id: user.id, email: user.email })
  // A reading the model could not make is a row too, with its error.
  revalidatePath(`/ledger/${ledgerId}/expenses`)
  revalidatePath(`/ledger/${ledgerId}/invoices`)
    revalidatePath(`/ledger/${ledgerId}/bills`, 'layout')
  return result
}

/**
 * Putting a company away and bringing it back (0065). Owners only: who may
 * see a company is already an owner's decision, and whether it exists at all
 * is the same question one step further.
 */
/** An owner's door on a company: the same seat, the same two pages to refresh. */
async function companyDoor(
  formData: FormData, run: (f: FormData, actor: string) => Promise<FormState>,
): Promise<FormState> {
  await requireOwner()
  const result = await run(formData, await currentActor())
  if (result.ok) { revalidatePath('/companies'); revalidatePath('/') }
  return result
}

export async function archiveCompanyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { archiveCompanyFromForm } = await import('@/lib/company-forms')
  return companyDoor(formData, archiveCompanyFromForm)
}

export async function unarchiveCompanyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { unarchiveCompanyFromForm } = await import('@/lib/company-forms')
  return companyDoor(formData, unarchiveCompanyFromForm)
}

/** A company's name and province put right (0084). */
export async function renameCompanyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { renameCompanyFromForm } = await import('@/lib/company-forms')
  return companyDoor(formData, renameCompanyFromForm)
}

/** And removing one that was a mistake — refused the moment anything is posted. */
export async function deleteCompanyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { deleteCompanyFromForm } = await import('@/lib/company-forms')
  return companyDoor(formData, deleteCompanyFromForm)
}

export async function discardReadingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(BILL_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, ['/expenses', '/invoices', '/assistant'])
  const result = await discardReadingFromForm(formData)
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/expenses`)
    revalidatePath(`/ledger/${ledgerId}/invoices`)
    revalidatePath(`/ledger/${ledgerId}/bills`, 'layout')
  }
  return result
}

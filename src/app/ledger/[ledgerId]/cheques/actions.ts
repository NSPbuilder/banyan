'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { FormState } from '@/app/actions'
import { currentActor, requireLedger } from '@/lib/gate'
import { parseMoney } from '@/lib/money'
import { chequeById, createManualCheque, editCheque, issueCheque, voidCheque } from '@/lib/cheques'
import { attachReadingTo, readingRefusal } from '@/lib/bill-reading'

const g = (f: FormData, key: string) => String(f.get(key) ?? '').trim()
const integer = (raw: string, label: string) => {
  if (!/^\d+$/.test(raw) || BigInt(raw) < 1n) throw new Error(`${label} must be a positive whole number.`)
  return BigInt(raw)
}
const amount = (raw: string) => {
  const cents = parseMoney(raw)
  if (cents <= 0n) throw new Error('Amount must be positive.')
  return cents
}
const errorState = (e: unknown): FormState => ({
  error: (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 250),
})

export async function createChequeAction(_prev: FormState, f: FormData): Promise<FormState> {
  const ledgerId = g(f, 'ledgerId')
  await requireLedger(ledgerId, '/cheques')
  let id: string
  let readingWarning = false
  try {
    const actor = await currentActor()
    const first = g(f, 'firstNumber')
    const startingNumber = first ? integer(first, 'First cheque number') : undefined
    const readingId = g(f, 'readingId')
    if (readingId) {
      if (g(f, 'source') !== 'manual') throw new Error('An AI reading can only open a new manual cheque.')
      const refusal = await readingRefusal(ledgerId, readingId)
      if (refusal) throw new Error(refusal)
    }
    if (g(f, 'source') === 'manual') {
      id = await createManualCheque({
        ledgerId, actor, startingNumber,
        bankAccountId: g(f, 'bankAccountId'), expenseAccountId: g(f, 'expenseAccountId'),
        chequeDate: g(f, 'chequeDate'), payee: g(f, 'payee'), partyId: g(f, 'partyId') || undefined,
        payeeAddress: g(f, 'payeeAddress'),
        amount: amount(g(f, 'amount')), memo: g(f, 'memo'),
      })
      if (readingId) {
        try {
          const cheque = await chequeById(ledgerId, id)
          if (!cheque?.entry_id) throw new Error('The new cheque has no journal entry to file against.')
          await attachReadingTo({ ledgerId, readingId, entryId: cheque.entry_id, actor })
        } catch {
          // The cheque and expense have already posted. Show their detail, with a filing warning,
          // rather than saying creation failed and inviting a second cheque.
          readingWarning = true
        }
      }
    } else {
      id = await issueCheque({
        ledgerId, actor, startingNumber,
        entryId: g(f, 'entryId') || undefined,
        stubId: g(f, 'stubId') || undefined,
      })
    }
  } catch (e) { return errorState(e) }
  revalidatePath(`/ledger/${ledgerId}/cheques`)
  revalidatePath(`/ledger/${ledgerId}/expenses`)
  if (readingWarning) revalidatePath(`/ledger/${ledgerId}/readings`)
  redirect(`/ledger/${ledgerId}/cheques/${id}${readingWarning ? '?reading=unfiled' : ''}`)
}

export async function editChequeAction(_prev: FormState, f: FormData): Promise<FormState> {
  const ledgerId = g(f, 'ledgerId')
  await requireLedger(ledgerId, '/cheques')
  try {
    await editCheque({
      ledgerId, chequeId: g(f, 'chequeId'), actor: await currentActor(),
      number: integer(g(f, 'number'), 'Cheque number'),
      chequeDate: g(f, 'chequeDate'), payee: g(f, 'payee'),
      partyId: f.has('partyId') ? g(f, 'partyId') || null : undefined,
      bankAccountId: g(f, 'bankAccountId') || undefined,
      expenseAccountId: g(f, 'expenseAccountId') || undefined,
      payeeAddress: g(f, 'payeeAddress'),
      amount: amount(g(f, 'amount')), memo: g(f, 'memo'),
    })
  } catch (e) { return errorState(e) }
  revalidatePath(`/ledger/${ledgerId}/cheques`)
  revalidatePath(`/ledger/${ledgerId}/cheques/${g(f, 'chequeId')}`)
  revalidatePath(`/ledger/${ledgerId}/expenses`)
  return { ok: 'Cheque updated.' }
}

export async function voidChequeAction(_prev: FormState, f: FormData): Promise<FormState> {
  const ledgerId = g(f, 'ledgerId')
  await requireLedger(ledgerId, '/cheques')
  try {
    await voidCheque({
      ledgerId, chequeId: g(f, 'chequeId'), actor: await currentActor(),
      reason: g(f, 'reason'), reversalDate: g(f, 'reversalDate'),
    })
  } catch (e) { return errorState(e) }
  revalidatePath(`/ledger/${ledgerId}/cheques`)
  revalidatePath(`/ledger/${ledgerId}/expenses`)
  revalidatePath(`/ledger/${ledgerId}/payroll`)
  revalidatePath(`/ledger/${ledgerId}/invoices`)
  return { ok: 'Cheque voided. Review the detail for its effect on the books.' }
}

import { moduleManifests, orderedModuleItems } from './module-manifests'
/**
 * WHERE A READ DOCUMENT CAN GO — one list, and the model is told it.
 *
 * The owner uploaded a company registration document, the model read it
 * correctly, and the app filed it as an expense (2026-09-16). The first fix
 * let the model say "this is not a transaction" instead of being coerced into
 * one of four money-movements. This is the second: it may say WHERE the thing
 * belongs, and the app takes it there.
 *
 * 「我希望 ai 理解整个 app 自己选择正确的处理方式，而不是靠硬编码填表单」 —
 * so the prompt is GENERATED FROM THIS LIST (`destinationMenu`), never typed
 * beside it. A destination added here is one the model may choose the same
 * day, with no prompt to remember to edit. That is the discipline `nav.ts`
 * already has for the rail, and N36 holds this list against the real routes
 * the same way N1 and N2 hold that one.
 *
 * Client-safe (no `server-only`): the reading card renders these, and a check
 * reads them with no server runtime.
 */

export type Destination = {
  /**
   * The value the model answers with, and what a stored proposal carries.
   * The first four are the ones that existed before this file and keep their
   * spelling exactly — rows written before 2026-09-16 still read.
   */
  key: string
  /** What the model is told belongs here. One line; it goes into the prompt. */
  takes: string
  /** The path under `/ledger/[id]` this lands on. Checked against the router. */
  path: string
  /** The button on the reading card. */
  label: string
  /**
   * Whether arriving there fills a form in from the reading, or simply puts
   * the person on the right screen with the reading beside them.
   *
   * Landing without a prefill is NOT a failure — it is the honest state of a
   * destination whose form has not been taught to read a proposal yet, and it
   * is still incomparably better than the wrong form filled in. The card says
   * which it is, so nobody waits for fields that are not coming.
   */
  prefills: boolean
}

/**
 * The destinations that move money, then the ones that do not.
 *
 * ORDER IS THE PROMPT'S ORDER, and the money ones come first because most
 * documents are one: a model reading a till receipt should meet "expense"
 * before it meets "a director was appointed".
 */
export const DESTINATIONS: Destination[] = orderedModuleItems<Destination>([
{ order: 0, key: 'expense', takes: 'money already paid out — a till receipt, a card slip, anything marked paid',
    path: '/entries/quick/expense', label: 'Enter as an expense paid now', prefills: true },
{ order: 1, key: 'cheque', takes: 'a cheque this company is about to issue from its bank account, rather than a receipt or an unpaid bill',
    path: '/cheques/new', label: 'Review as a cheque', prefills: true },
{ order: 2, key: 'bill', takes: 'a supplier asking to be paid by a date',
    path: '/bills/new', label: 'Enter as a bill to pay (AP)', prefills: true },
{ order: 3, key: 'income', takes: 'money already received',
    path: '/entries/quick/income', label: 'Enter as income received now', prefills: true },
{ order: 4, key: 'sale', takes: 'an invoice this company sent a customer, to be paid later',
    path: '/invoices/new', label: 'Enter as a sales invoice (AR)', prefills: true },
{ order: 11, key: 'party',
    takes: "a customer or supplier's own details with no amount owed — a new-vendor form, letterhead",
    path: '/parties', label: 'Open customers and suppliers', prefills: false },
{ order: 12, key: 'bank_statement',
    takes: 'a bank or credit-card statement — many dated rows against one account',
    path: '/bank', label: 'Open bank transactions', prefills: false },
  ...moduleManifests.flatMap(manifest => manifest.destinations ?? []),
])

/**
 * The honest last answer: read, but nothing here takes it.
 *
 * Deliberately NOT in `DESTINATIONS` — it is not a place, and offering it as
 * a button would be offering a door onto nothing. It is what `suggests` holds
 * when no destination fits, and the card says so in words.
 */
export const NO_DESTINATION = 'other'

const byKey = new Map(DESTINATIONS.map((d) => [d.key, d]))

/** The destination a stored or answered key names, or null for `other` and for anything unknown. */
export const destinationOf = (key: unknown): Destination | null =>
  (typeof key === 'string' ? byKey.get(key) : undefined) ?? null

/** Every answer the model may give, `other` included. */
export const DESTINATION_KEYS: string[] = [...DESTINATIONS.map((d) => d.key), NO_DESTINATION]

/** Which destinations move money — the ones with a transaction form behind them. */
export const MONEY_KEYS = ['expense', 'cheque', 'bill', 'income', 'sale']

/**
 * The menu as the prompt states it.
 *
 * Generated rather than written out, so the model's choices and the app's
 * doors cannot come apart — which is the whole point of this file.
 */
export function destinationMenu(): string {
  // Named, and on a line of its own carrying no template literal: the mutation
  // battery anchors a block on whole source lines, and a line holding a
  // template cannot be one (mutations.sh, block 829).
  const offered = DESTINATIONS
  const one = (d: Destination) => `"${d.key}" is ${d.takes}.`
  const last = `"${NO_DESTINATION}" is none of these — say so rather than forcing one.`
  return [...offered.map(one), last].join(' ')
}

/**
 * Where a reading opens, carrying itself.
 *
 * Every destination takes `reading`, whether or not it fills anything in yet:
 * a screen that ignores the parameter loses nothing, and one taught to read it
 * later needs no change here.
 */
export function destinationHref(ledgerId: string, readingId: string, d: Destination): string {
  const sales = d.key === 'sale' ? 'direction=sales&' : ''
  return `/ledger/${ledgerId}${d.path}?${sales}reading=${readingId}`
}

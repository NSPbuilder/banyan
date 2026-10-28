/**
 * Turning form input into typed values.
 *
 * This module imports nothing from the database layer on purpose. Actions
 * import `next/navigation` and cannot load outside a Next runtime, which made
 * the parsing that lived in them untestable — that is how a silent
 * `Number(x) || 12` coercion reached production in step 1. Keeping this file
 * free of server imports means both the test scripts AND the client components
 * can use it.
 */
import { parseMoney } from './money'

/** A field's text, trimmed — the read every form module makes first. */
export const g = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

/** The shape every form door answers in: a sentence for the person, one way or the other. */
export type FormResult = { ok?: string; error?: string; version?: string }

export const STATEMENT_FILE_FIELDS = { file: 'statementFile', attachmentId: 'statementAttachmentId' } as const
export const STATEMENT_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.heic,.heif'

/**
 * What to say when a door refuses: a refusal of the door's own class is shown
 * whole — it is a sentence written for the person — and anything else, a
 * driver error or a bug, shows its first line cut at 200 characters.
 */
export const sentenceOf = (e: unknown, whole?: abstract new (...a: never[]) => Error): string => {
  const chain=String(e)+' '+String((e as {cause?:unknown})?.cause)
  if(chain.includes('PROJECT_ACCOUNTING_OWNER'))return 'Edit or cancel this linked transaction from its Project.'
  if(chain.includes('PROJECT_PAYMENT_SOURCE'))return 'Use a Payment to settle a Project invoice or bill.'
  if(chain.includes('PROJECT_ARCHIVED'))return 'Restore the Project before changing its payments.'
  return whole && e instanceof whole ? e.message
    : (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200)
}

/** Run a door and say how it went. */
export async function attemptWith(
  run: () => Promise<unknown>, ok: string, own: abstract new (...a: never[]) => Error,
): Promise<FormResult> {
  try {
    await run()
    return { ok }
  } catch (e) {
    return { error: sentenceOf(e, own) }
  }
}

/** Cents, or the door's own refusal naming what would not read. */
export function moneyFrom(raw: string, what: string, refuse: (message: string) => Error): bigint {
  try {
    return parseMoney(raw)
  } catch {
    throw refuse(`"${raw}" does not read as ${what}.`)
  }
}

export class FormError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FormError'
  }
}

export function requiredInt(formData: FormData, key: string, label: string): number {
  const raw = String(formData.get(key) ?? '').trim()
  const n = Number(raw)
  if (raw === '' || !Number.isInteger(n)) {
    throw new FormError('BAD_YEAR_END', `${label} must be a whole number — got "${raw}".`)
  }
  return n
}

export function companyFromFormData(formData: FormData) {
  return {
    code: String(formData.get('code') ?? ''),
    name: String(formData.get('name') ?? ''),
    legalName: String(formData.get('legalName') ?? '') || undefined,
    province: String(formData.get('province') ?? '') || undefined,
    businessNumber: String(formData.get('businessNumber') ?? '') || undefined,
    fiscalYearEndMonth: requiredInt(formData, 'fiscalYearEndMonth', 'Year-end month'),
    fiscalYearEndDay: requiredInt(formData, 'fiscalYearEndDay', 'Year-end day'),
  }
}

/**
 * The role editor renders one radio group per family, named `role_<family>`,
 * each with a "none" option carrying an empty value. That gives the owner the
 * "at most one per family" rule directly instead of letting them pick two and
 * be refused by the database.
 */
export function rolesFromFormData(formData: FormData): string[] {
  const roles = [...formData.entries()]
    .filter(([k]) => k.startsWith('role_'))
    .map(([, v]) => String(v).trim())
    .filter(Boolean)

  if (new Set(roles).size !== roles.length) {
    throw new FormError('ROLE_FAMILY', 'The same role was submitted twice.')
  }
  return roles
}

export type TaggableRole = {
  code: string; label: string; family: string
  category: string | null; isCore: boolean
}

/**
 * Which role families the editor must render for an account of this type.
 *
 * Pure on purpose. This was once an inline `.filter()` inside RoleEditor that
 * dropped the cash-flow family — and because saving replaces an account's roles
 * wholesale, a family the form does not render is a family the form deletes.
 * Opening the editor on an account tagged `cf_operating` and pressing Save
 * destroyed that role and reported success. Nothing could catch it, because the
 * filter lived where no test could reach it.
 */
export function editableRoles(roles: TaggableRole[], accountType: string) {
  const eligible = roles.filter((r) => r.category === null || r.category === accountType)
  const families = [...new Set(eligible.map((r) => r.family))]
  return { eligible, families }
}

/**
 * Something a form offers to pick. Lived on the invoice list screen until
 * that screen was dissolved into the two browse pages; it was never about
 * invoices, and three forms imported it from there.
 */
export type Choice = { id: string; label: string }

export type ParsedLine = {
  accountId: string; amount: bigint; description?: string; partyId?: string
  /**
   * The tax this line's amount already INCLUDES, if it was tagged. Carried
   * rather than computed here: splitting it needs the chart (which account
   * carries the recoverable role), and this file is pure so a check can call
   * it. `expandTaggedLines` does the splitting, once, for every door.
   */
  taxCode?: string
}

/**
 * The number the other side's paper carries, as a form gives it: a supplier's
 * invoice number, a receipt number, a cheque stub (owner, 2026-09-03 — it is
 * what you quote when they ring up about it).
 *
 * Blank is not a number: the database refuses an empty string (0049), so the
 * trim-to-undefined happens HERE, once, for every door that offers the field.
 * A door that trimmed it its own way would eventually not.
 */
export const documentRefFrom = (f: FormData, field = 'documentRef') =>
  String(f.get(field) ?? '').trim() || undefined

/**
 * The journal entry form's HEADER, read once.
 *
 * Four actions post that form — save a draft, post it, edit a live entry,
 * amend a posted one — and each used to read the same field names again in
 * its own body. Four spellings of one question, and the day a fifth field
 * arrived only three of them learned about it: the amend door accepted an
 * edited "their document #", threw it away, and re-posted the old number
 * with no message (critic, 2026-09-03).
 *
 * A reader here rather than in `app/actions.ts` for the reason every
 * `*-forms` reader is: a check can call this and cannot call a server action.
 */
export function entryHeaderFrom(f: FormData) {
  return {
    entryDate: String(f.get('entryDate') ?? ''),
    description: String(f.get('description') ?? ''),
    memo: String(f.get('memo') ?? '') || undefined,
    documentRef: documentRefFrom(f),
  }
}

/**
 * Turn the entry form's rows into journal lines.
 *
 * The form keeps blank rows so there is always somewhere to type; they are
 * dropped here rather than saved, because journal_line forbids a zero amount.
 * A row with an account but no amount is dropped too — and the caller is told
 * how many rows went, so the screen can say so instead of losing them silently.
 */
export function linesFromJson(json: string): { lines: ParsedLine[]; dropped: number } {
  let rows: Array<{ accountId?: string; debit?: string; credit?: string; description?: string
    partyId?: string; taxCode?: string }>
  try {
    rows = JSON.parse(json || '[]')
  } catch {
    throw new FormError('BAD_LINES', 'The entry rows could not be read.')
  }
  if (!Array.isArray(rows)) throw new FormError('BAD_LINES', 'The entry rows could not be read.')

  const lines: ParsedLine[] = []
  let dropped = 0

  for (const row of rows) {
    const debit = safeMoney(row.debit)
    const credit = safeMoney(row.credit)

    if (!row.accountId && debit === 0n && credit === 0n) continue        // an empty row
    if (!row.accountId || (debit === 0n && credit === 0n)) { dropped++; continue }
    if (debit !== 0n && credit !== 0n) {
      throw new FormError('BAD_LINES', 'A line carries both a debit and a credit. Use one or the other.')
    }

    lines.push({
      accountId: row.accountId,
      amount: debit !== 0n ? debit : -credit,
      description: row.description?.trim() || undefined,
      // Who the line is about — optional; 0025's trigger refuses one who
      // holds no transacting role here on the entry's date, by name.
      partyId: row.partyId || undefined,
      // The tag, if the row carried one. Out of scope is no tag.
      taxCode: row.taxCode && row.taxCode !== 'OUT_OF_SCOPE' ? row.taxCode : undefined,
    })
  }

  return { lines, dropped }
}

function safeMoney(text: string | undefined): bigint {
  const raw = (text ?? '').trim()
  if (!raw) return 0n
  try { return parseMoney(raw) } catch {
    throw new FormError('BAD_LINES', `"${raw}" is not an amount.`)
  }
}

export type SearchableAccount = {
  code: string; name: string; account_type: string
  role_labels?: string[] | null
}

/**
 * Filter a chart of accounts by a typed query.
 *
 * Pure, and kept out of the component, because the last filter written inline
 * in a client component silently deleted data and no test could reach it.
 *
 * Matches on code, name, type and role label, so "cash", "1000", "asset" and
 * "receivable" all find what the person means. Multiple words must all match,
 * which is how someone narrows a long list.
 */
export function matchesAccountSearch(account: SearchableAccount, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true

  const haystack = [
    account.code,
    account.name,
    account.account_type,
    ...(account.role_labels ?? []),
  ].join(' ').toLowerCase()

  return terms.every((t) => haystack.includes(t))
}

/**
 * The field names the sales tax forms post and the actions read.
 *
 * One name, written once, used on both sides. Renaming `name="ceasedOn"` to
 * anything else in the form broke every cease from the browser — the action
 * read `formData.get('ceasedOn')`, got nothing, and refused with BAD_DATE — and
 * all 41 checks stayed green, along with `tsc`. Nothing in the suite renders the
 * page or submits the form, so a source grep of the action and a library call
 * with the same constant were composed into a claim about a path neither one
 * travels.
 *
 * A check for that drift would have to be maintained alongside it. Sharing the
 * names removes the drift instead: there is no longer a second place for the
 * spelling to be wrong.
 */
/**
 * The opening balance screen's fields.
 *
 * One amount per account, named by the account's id rather than by a row index:
 * a form keyed on position puts the figure against whichever account happens to
 * be in that slot when the page is re-rendered, which is how the sales tax round
 * lost six rounds. `amountFor` and `accountOf` are the only two places that
 * know the shape.
 */
export const OPENING_FIELDS = {
  ledgerId: 'ledgerId',
  entryDate: 'entryDate',
  description: 'description',
  balancingAccountId: 'balancingAccountId',
} as const

const AMOUNT_PREFIX = 'amount:'
export const amountFor = (accountId: string) => `${AMOUNT_PREFIX}${accountId}`
export const accountOf = (field: string) =>
  field.startsWith(AMOUNT_PREFIX) ? field.slice(AMOUNT_PREFIX.length) : null

/**
 * The reconcile screen's fields. Here rather than beside the handler because a
 * client component renders them and a check builds a FormData from them, and
 * neither can import a `server-only` module.
 */
/**
 * The customers-and-suppliers screen's fields. Same reason as the others: a
 * client component renders them and a check builds a FormData from them, and
 * neither can import a `server-only` module.
 */
export const PARTY_FIELDS = {
  ledgerId: 'ledgerId',
  entityId: 'entityId',
  partyId: 'partyId',
  name: 'name',
  kind: 'kind',
  role: 'role',
  heldFrom: 'heldFrom',
  taxNumber: 'taxNumber',
  tradingName: 'tradingName',
  notes: 'notes',
  /** Whether this company deals with them at arm's length — the 80% SR&ED rule. */
  armsLength: 'armsLength',
  /** Ending a role: which one, and the last day it was held. */
  roleId: 'roleId',
  heldTo: 'heldTo',
  /** Addresses: one per purpose, setAddress replaces. */
  purpose: 'purpose',
  line1: 'line1',
  line2: 'line2',
  city: 'city',
  region: 'region',
  postalCode: 'postalCode',
  country: 'country',
  /** The shared primary contact, entered together with a new Party. */
  contactName: 'contactName',
  email: 'email',
  phone: 'phone',
} as const

/**
 * The invoice screen's fields.
 *
 * Lines are numbered, and that is safe HERE for a reason worth stating, because
 * the sales tax round spent six rounds on the opposite case.
 *
 * What burned that screen was an index used as a KEY into something rendered
 * somewhere else: field `amount3` meant "the amount for whatever account is
 * third in the list", so re-rendering the list in another order moved the
 * figure to a different account. The opening balance screen fixed it by keying
 * on the account's id.
 *
 * That fix cannot be used here: an invoice may have three lines against the
 * same account, so the account is not a key. What makes the index safe instead
 * is that EVERYTHING A LINE MEANS IS IN THE LINE — its own account select, its
 * own description, its own amount, all carrying the same index. Re-order the
 * rows and the whole row moves together; there is no separate list for the
 * index to point into and get out of step with.
 *
 * The rule, stated so the next screen can apply it: an index is safe when it
 * binds fields WITHIN a row, and dangerous when it binds a row to a list
 * rendered elsewhere.
 */
export const INVOICE_FIELDS = {
  ledgerId: 'ledgerId',
  invoiceId: 'invoiceId',
  direction: 'direction',
  /** The document's kind on the EDIT form — identity, the sign of every line depends on it. */
  kind: 'kind',
  partyId: 'partyId',
  controlAccountId: 'controlAccountId',
  number: 'number',
  theirRef: 'theirRef',
  issuedOn: 'issuedOn',
  dueOn: 'dueOn',
  note: 'note',
  reason: 'reason',
  template: 'template',
  /** 'inclusive' | 'exclusive' — how typed line amounts read for tax tags. */
  amounts: 'amounts',
} as const

/**
 * WHERE A DELETED DOCUMENT'S LIST IS. The invoice list became two pages, so
 * "back to the list" is a question about the document, not a constant.
 */
export const invoiceListFor = (direction: string) =>
  direction === 'sales' ? '/income' : '/expenses'

/**
 * What was released when an entry was deleted, said once.
 *
 * The door redirects to the journal now — the entry's own page is a 404 the
 * moment it is gone (2026-09-15) — and the consequences have to survive that
 * move, because "3 applications released" means a debt is owed again and
 * "2 bank matches released" means a reconciliation must be done over. Passed
 * as COUNTS in the address and worded here, so a crafted link cannot put a
 * sentence of its own on the page, and so the wording lives in one place.
 */
export function deletedEntrySentence(
  entryNo: string, releasedApplications = 0, releasedMatches = 0,
): string {
  const bits = [`${entryNo} deleted.`]
  if (releasedApplications > 0) {
    bits.push(`${releasedApplications} application(s) released — that debt is owed again.`)
  }
  if (releasedMatches > 0) {
    bits.push(`${releasedMatches} bank match(es) released — reconcile again.`)
  }
  bits.push('The number stays retired; the audit log keeps the lines.')
  return bits.join(' ')
}

export const lineAccount = (i: number) => `line.${i}.account`
export const lineDescription = (i: number) => `line.${i}.description`
export const lineAmount = (i: number) => `line.${i}.amount`
export const lineTaxCode = (i: number) => `line.${i}.taxCode`
export const lineGst = (i: number) => `line.${i}.gst`
export const linePst = (i: number) => `line.${i}.pst`

/**
 * Which line numbers actually arrived.
 *
 * The form used to render a fixed six rows and the reader used to loop to a
 * fixed six, and the constant below was described as the place they agreed.
 * That agreement was a promise, not a mechanism: once rows can be added the
 * form renders as many as somebody asked for, and a reader still bounded at six
 * would drop the seventh line without a word — the invoice saves, the total on
 * it is short by exactly that line, and every figure on the saved document
 * agrees with every other.
 *
 * So the reader stops holding an opinion about how many lines there are and
 * reads the ones it was sent. There is no count to disagree with.
 *
 * This is the inverse of the three makers above and lives beside them for that
 * reason: the name shape is written down once. `V81` holds them together by
 * feeding each maker's output back through here.
 */
const LINE_FIELD = /^line\.(\d+)\.(account|description|amount|gst|pst)$/

export const lineIndicesIn = (keys: Iterable<string>): number[] => indicesIn(keys, LINE_FIELD)

/**
 * The body both row readers share. Payroll's rows arrived with a second copy
 * of this loop beside the first, which is the two-lists defect in miniature —
 * one of them would eventually learn something the other did not.
 */
function indicesIn(keys: Iterable<string>, field: RegExp): number[] {
  const seen = new Set<number>()
  for (const k of keys) {
    const m = field.exec(k)
    if (m) seen.add(Number(m[1]))
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * How many rows the form STARTS with — not a limit, and no longer a promise the
 * reader relies on. `lineIndicesIn` decides what gets read.
 */
export const INVOICE_LINE_SLOTS = 6

/**
 * The reading a review form came from (0064). A hidden field on the ordinary
 * quick-entry and purchase-bill forms: when it is there, the bill that was
 * read is filed against the entry those forms just posted. The corporate
 * record's add forms carry it too (2026-09-16), and there it marks which of
 * the reading's tables have been entered, so the same rows cannot go in twice.
 *
 * Declared above `RECORD_FIELDS`, which names it: a `const` read before its
 * line is a ReferenceError when this module loads.
 */
export const READING_FIELD = 'readingId'

/** The corporate-records screen's names. Here — not in record-forms.ts —
 *  because the client screen reads them too, and record-forms is server-only:
 *  the first build with them over there pulled 'server-only' into the client
 *  bundle and failed loudly. forms.ts is the client-safe home for names. */
export const RECORD_FIELDS = {
  ledgerId: 'ledgerId',
  entityId: 'entityId',
  incorporationNumber: 'incorporationNumber',
  businessNumber: 'businessNumber',
  recognitionDate: 'recognitionDate',
  companyType: 'companyType',
  /**
   * Three-state on purpose: '' (nobody has said), 'yes', 'no'. A CCPC gets the
   * enhanced SR&ED rate and a refund; a company nobody has classified is priced
   * as though it were not one, and the working paper says so. A checkbox could
   * only say two of those three things.
   */
  isCcpc: 'isCcpc',
  office: 'office',
  deliveryAddress: 'deliveryAddress',
  deliveryCity: 'deliveryCity',
  deliveryPostal: 'deliveryPostal',
  effectiveFrom: 'effectiveFrom',
  partyId: 'partyId',
  appointedOn: 'appointedOn',
  prescribedDelivery: 'prescribedDelivery',
  directorshipId: 'directorshipId',
  ceasedOn: 'ceasedOn',
  className: 'className',
  series: 'series',
  shareClassId: 'shareClassId',
  onDate: 'onDate',
  quantity: 'quantity',
  details: 'details',
  /** What was given for the shares — the particular s.111(1) asks for. */
  consideration: 'consideration',
  /** Issued by this movement: to the transferee, or to the new holder. */
  certificateNo: 'certificateNo',
  /** Taken in and cancelled by this movement. */
  surrenderedNo: 'surrenderedNo',
  /** Issued back to the transferor for what they still hold. */
  balanceNo: 'balanceNo',
  fromPartyId: 'fromPartyId',
  toPartyId: 'toPartyId',
  howControl: 'howControl',
  becameOn: 'becameOn',
  birthDate: 'birthDate',
  lastKnownAddress: 'lastKnownAddress',
  siId: 'siId',
  recordKind: 'recordKind',
  title: 'title',
  keptAt: 'keptAt',
  note: 'note',
  /** Which of the add forms a batch of rows came from (`record-rows.ts`). */
  table: 'table',
  /** The row an Edit or Delete acts on, in the table `table` names (0083). */
  recordId: 'recordId',
  /** A minute-book record, and a document filed against one (0081). */
  minuteId: 'minuteId',
  paperId: 'paperId',
  file: 'file',
  reason: 'reason',
  /** The reading the rows were filled in from, when they were. */
  readingId: READING_FIELD,
} as const

/**
 * A corporate-record add form's cells: `row.<i>.<column>`.
 *
 * The invoice lines' rule, applied again: everything a row means is in the row
 * — its name, its dates, its count all carry the same index — so the index
 * binds fields WITHIN a row and never a row to a list rendered elsewhere. The
 * reader takes the indices it was sent, like `lineIndicesIn`.
 */
export const rowField = (i: number, column: string) => `row.${i}.${column}`
const ROW_FIELD = /^row\.(\d+)\.[A-Za-z]+$/
export const rowIndicesIn = (keys: Iterable<string>): number[] => indicesIn(keys, ROW_FIELD)

export const PAYMENT_FIELDS = {
  ledgerId: 'ledgerId',
  invoiceId: 'invoiceId',
  bankAccountId: 'bankAccountId',
  amount: 'amount',
  paidOn: 'paidOn',
  reference: 'reference',
  /** The settling entry, when applying an existing one (a credit note's). */
  entryId: 'entryId',
  applicationId: 'applicationId',
} as const

export const QUICK_FIELDS = {
  ledgerId: 'ledgerId',
  kind: 'kind',
  entryDate: 'entryDate',
  description: 'description',
  /** The supplier's own invoice or receipt number; the entry is the document. */
  documentRef: 'documentRef',
  accountId: 'accountId',
  bankAccountId: 'bankAccountId',
  /** Who the money was with. Optional — a parking meter is nobody. */
  partyId: 'partyId',
  /** The shareholder or director credited on a due-to loan account. */
  fundingPartyId: 'fundingPartyId',
  amount: 'amount',
  /** The tag that drives resident tax computation (TaxCode). */
  taxCode: 'taxCode',
  /** 'inclusive' | 'exclusive' — how the typed amount reads. */
  amounts: 'amounts',
  gst: 'gst',
  pst: 'pst',
} as const

/**
 * HERE RATHER THAN IN `parties.ts`, which is `server-only`.
 *
 * Two lists of parties and one order to show them in is a pure function, and
 * the screens that need it — the bank feed's Add row among them — are client
 * components a check renders outside any server runtime. A pure helper living
 * in a server-only module is a module a check cannot import (the ActionForm
 * rule, met here as an import rather than as an action).
 */
/** The same two lists as one, headings and all — what a `<Picker>` wants. */
export function partyOptions(
  choices: { customers: Array<{ id: string; label: string }>; suppliers: Array<{ id: string; label: string }> },
  first: 'customers' | 'suppliers',
) {
  const heading = { customers: 'Customers', suppliers: 'Suppliers' } as const
  const other = first === 'customers' ? 'suppliers' : 'customers'
  // The likely one first: money out is a supplier's, money in a customer's.
  return [
    ...choices[first].map((p) => ({ ...p, group: heading[first] })),
    ...choices[other].map((p) => ({ ...p, group: heading[other] })),
  ]
}

export type TransactingPartyRoleChoice = {
  id: string; label: string; role: string; role_label: string
  held_from: string | null; held_to: string | null
}

/** Bank rows have their own dates and can concern any transacting role. */
export function bankPartyOptions(
  roles: TransactingPartyRoleChoice[], onDate: string, spent: boolean,
) {
  const priority = spent
    ? ['supplier', 'shareholder', 'director', 'employee', 'customer']
    : ['customer', 'shareholder', 'director', 'employee', 'supplier']
  const heading: Record<string, string> = {
    customer: 'Customers', supplier: 'Suppliers', employee: 'Employees',
    director: 'Directors', shareholder: 'Shareholders',
  }
  const byParty = new Map<string, TransactingPartyRoleChoice[]>()
  for (const role of roles) {
    if (role.held_to !== null && role.held_to < onDate) continue
    byParty.set(role.id, [...(byParty.get(role.id) ?? []), role])
  }
  const rank = (role: string) => {
    const at = priority.indexOf(role)
    return at < 0 ? priority.length : at
  }
  return [...byParty.values()].map((partyRoles) => {
    partyRoles.sort((a, b) => rank(a.role) - rank(b.role))
    const first = partyRoles[0]
    return {
      rank: rank(first.role),
      option: {
        id: first.id, label: first.label,
        hint: [...new Set(partyRoles.map((r) => r.role_label))].join(', '),
        group: heading[first.role] ?? first.role_label,
      },
    }
  }).sort((a, b) => a.rank - b.rank || a.option.label.localeCompare(b.option.label))
    .map((p) => p.option)
}


/** Saving one company to a file, and reading one back. */
export const BACKUP_FIELDS = {
  ledgerId: 'ledgerId',
  file: 'file',
  code: 'code',
  name: 'name',
} as const

export const MATCH_FIELDS = {
  ledgerId: 'ledgerId',
  accountId: 'accountId',
  rowId: 'rowId',
  entryId: 'entryId',
  matchId: 'matchId',
  amount: 'amount',
  reason: 'reason',
  contraAccountId: 'contraAccountId',
  splitMode: 'splitMode',
  splitAccountId: 'splitAccountId',
  splitAmount: 'splitAmount',
  description: 'description',
  /** Who it was with, on the other side's line (0025 still has the last word). */
  partyId: 'partyId',
  /** The tax the row's amount already includes; it splits the other side. */
  taxCode: 'taxCode',
  /** The statement's own assertion: its printed date and ending balance. */
  statementDate: 'statementDate',
  endingBalance: 'endingBalance',
  statementId: 'statementId',
  /** Several rows at once — the feed's "accept all matches" (19). */
  rowIds: 'rowIds',
} as const

export const TAX_FIELDS = {
  ledgerId: 'ledgerId',
  entityId: 'entityId',
  tax: 'tax',
  number: 'number',
  registeredOn: 'registeredOn',
  registrationId: 'registrationId',
  ceasedOn: 'ceasedOn',
  /** The per-account inputs are indexed: code0, name0, role0, code1, … */
  code: (i: number) => `code${i}`,
  name: (i: number) => `name${i}`,
  /**
   * What the row IS — `gst_hst_payable`, and so on.
   *
   * Carried in the form so the row does not depend on where it sits. Five
   * separate rounds found a defect of one shape: something reordered or
   * renumbered the rows between the proposal and the handler — the row's own
   * index, the list's array, the array handed to the form, the array handed by
   * the page — and the owner's payable code silently landed on their
   * recoverable account, reported as success. Each fix moved the seam one hop
   * further out.
   *
   * A row that says what it is cannot be put in the wrong place by anything
   * that carries it.
   */
  role: (i: number) => `role${i}`,
} as const

/**
 * The account rows a tax registration form posted, **at the positions they were
 * posted at**.
 *
 * Row `i` configures proposed account `i`, and a row that did not arrive leaves
 * a hole rather than pulling the next one into its place. An earlier version
 * compacted the list, so a form that posted only the second row put that row's
 * code and name onto the FIRST account — the person's recoverable code landed
 * on their payable, and the registration reported success.
 *
 * Reading the indices instead of trusting a count the form sends alongside is
 * the other half: sharing the field names stopped the two sides spelling a
 * field differently, and left them still having to agree about how many rows
 * there were and where the numbering started.
 */
const MAX_ROWS = 16

export type AccountRowInput = { code: string; name: string; role?: string }

export function accountRowsFrom(formData: FormData): Array<AccountRowInput | undefined> {
  const rows: Array<AccountRowInput | undefined> = []

  for (const [key, value] of formData.entries()) {
    const m = /^(code|name|role)(\d+)$/.exec(key)
    if (!m) continue
    const i = Number(m[2])
    // No proposal has ever had more than two accounts. A form claiming
    // thousands is not a form this wrote.
    if (i >= MAX_ROWS) continue
    const row = rows[i] ?? { code: '', name: '' }
    row[m[1] as 'code' | 'name' | 'role'] = String(value)
    rows[i] = row
  }

  return rows
}

/**
 * The payroll screens' names. Here for the reason every other block is: a
 * client component renders them, a check builds a FormData from them, and
 * neither can import a `server-only` module.
 */
export const PAYROLL_FIELDS = {
  ledgerId: 'ledgerId',
  /** The payroll record being edited; absent when adding someone. */
  employeeId: 'employeeId',
  partyId: 'partyId',
  frequency: 'frequency',
  federalClaim: 'federalClaim',
  bcClaim: 'bcClaim',
  occupation: 'occupation',
  additionalTax: 'additionalTax',
  sin: 'sin',
  hiredOn: 'hiredOn',
  isActive: 'isActive',
  /** ITA 248(1) specified employee: the 5 x YMPE SR&ED cap turns on this. */
  isSpecified: 'isSpecified',
  /** Exempt from CPP (over 70, CPT30) or from EI (an owner over 40% of the votes). */
  cppExempt: 'cppExempt',
  eiExempt: 'eiExempt',
  /** The run form. */
  payDate: 'payDate',
  periodStart: 'periodStart',
  periodEnd: 'periodEnd',
  bankAccountId: 'bankAccountId',
  /** What the browser saw when it submitted — so a double-click pays once. */
  idempotencyKey: 'idempotencyKey',
} as const

/**
 * One row of a pay run: whom, and how much. Same shape as the invoice's line
 * names and read the same way — `payIndicesIn` reads the rows that arrived
 * rather than a count either side has an opinion about.
 */
export const payEmployee = (i: number) => `pay.${i}.employee`
export const payGross = (i: number) => `pay.${i}.gross`
export const payPensionable = (i: number) => `pay.${i}.pensionable`
export const payInsurable = (i: number) => `pay.${i}.insurable`
export const payHours = (i: number) => `pay.${i}.hours`
/** How much of that gross was a bonus. A memo — it changes no payroll figure (0072). */
export const payBonus = (i: number) => `pay.${i}.bonus`

const PAY_FIELD = /^pay\.(\d+)\.(employee|gross|pensionable|insurable|hours|bonus)$/

export const payIndicesIn = (keys: Iterable<string>): number[] => indicesIn(keys, PAY_FIELD)

/**
 * The sign-in and people screens' names. Here — not in `user-forms.ts` —
 * because client components render them and that file is `server-only`: the
 * first build with them over there pulled `postgres` into the client bundle
 * and failed loudly, which is exactly why `RECORD_FIELDS` lives here too.
 */
/**
 * The file that goes WITH the thing being created — on the quick forms, the
 * journal entry, and the invoice. Attaching used to be a second visit to a
 * second screen after the entry existed, which is not how a person holding a
 * receipt thinks (owner, 2026-09-07).
 */
export const ATTACH_FIELD = 'attachment'
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

/** Putting a company away, bringing it back, or removing one that was a mistake (0065). */
export const COMPANY_FIELDS = {
  entityId: 'entityId',
  reason: 'reason',
  /** The company's own code, and the code the person typed to confirm a delete. */
  code: 'code',
  confirm: 'confirm',
  /** Renaming (0084): the name, and the province the sales tax rules read. */
  name: 'name',
  province: 'province',
} as const

/** The read-a-bill form: the company and the file. Nothing else — the service is the person's saved one. */
export const BILL_FIELDS = {
  ledgerId: 'ledgerId',
  file: 'file',
  sentence: 'sentence',
  readingId: READING_FIELD,
} as const

export const ASSISTANT_FIELDS = {
  ledgerId: 'ledgerId',
  question: 'question',
  inquiryId: 'inquiryId',
  stepN: 'stepN',
  // The person's own service, sent with each question and kept by their
  // browser; the server writes none of these (docs/design/22-assistant.md).
  baseUrl: 'aiBaseUrl',
  apiKey: 'aiApiKey',
  model: 'aiModel',
  priceInput: 'aiPriceInput',
  priceOutput: 'aiPriceOutput',
  priceCached: 'aiPriceCached',
  priceUnit: 'aiPriceUnit',
} as const

export const USER_FIELDS = {
  email: 'email',
  password: 'password',
  firstName: 'firstName',
  lastName: 'lastName',
  userId: 'userId',
  kind: 'kind',
  isActive: 'isActive',
  next: 'next',
  entityId: 'entityId',
  module: 'module',
  grant: 'grant',
  grantMode: 'grantMode',
  webdavEnabled: 'webdavEnabled',
  reason: 'reason',
} as const

/** What a sign-in or people form hands back to the screen. */
export type UserFormResult = { ok?: string; error?: string; token?: string; next?: string }

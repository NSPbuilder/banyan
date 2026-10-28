/**
 * The words a SR&ED claim is made of, and the shape of every row the screens
 * are handed.
 *
 * Pure — no database, no 'server-only' — because the project screen is a
 * client component and needs the vocabulary: which categories a cost may be
 * put in, and CRA's own list of what supports a claim. `sred.ts` imports
 * these and re-exports them, so a server caller still has one place to look
 * and there is still only one list.
 *
 * The same reason `bank-feed.ts` sits beside `bank.ts`: a widget that has to
 * name the choices cannot import the module that opens a connection.
 */

export type SredMethod = 'proxy' | 'traditional'

/** What a project's `status` may be — 0068's CHECK, in one place a screen can read. */
export const PROJECT_STATUS = ['planned', 'active', 'concluded', 'abandoned'] as const

export type SredCategory =
  'salary' | 'materials' | 'contract' | 'third_party' | 'overhead' | 'capital'

/** The categories a journal line may be put in; salary comes from payroll. */
export const LINE_CATEGORIES: SredCategory[] = [
  'materials', 'contract', 'third_party', 'overhead', 'capital',
]

/** CRA's own list of what supports a claim, and which question each answers. */
export const EVIDENCE_KINDS: Array<{ kind: string; label: string; answers: 'why' | 'how' | 'cost' }> = [
  { kind: 'plan', label: 'Project plan', answers: 'why' },
  { kind: 'hypothesis', label: 'Hypothesis and experiment design', answers: 'why' },
  { kind: 'trial_record', label: 'Trial records, test protocols, raw data', answers: 'how' },
  { kind: 'analysis', label: 'Analysis and conclusions', answers: 'how' },
  { kind: 'notebook', label: 'Lab or engineering notebook, project log', answers: 'how' },
  { kind: 'source_code', label: 'Source code, architecture, version history', answers: 'how' },
  { kind: 'progress_report', label: 'Progress report', answers: 'how' },
  { kind: 'meeting_minutes', label: 'Meeting minutes', answers: 'how' },
  { kind: 'scrap_record', label: 'Scrap and prototype records', answers: 'how' },
  { kind: 'photo', label: 'Photographs or video', answers: 'how' },
  { kind: 'contract', label: 'Contract naming the SR&ED work', answers: 'cost' },
  { kind: 'invoice', label: 'Invoices', answers: 'cost' },
  { kind: 'final_report', label: 'Final report or publication', answers: 'why' },
]

export type SredProject = {
  id: string; entity_id: string; code: string; title: string
  field_of_science: string | null
  started_on: string; ended_on: string | null; status: string
}

export type SredClaim = {
  id: string; project_id: string; fiscal_year_id: string
  method: SredMethod
  uncertainty_text: string | null
  work_done_text: string | null
  advancement_text: string | null
  assistance_answered_on: string | null
  assistance_note: string | null
  filed_on: string | null
  year_name: string; year_start: string; year_end: string
}

export type SredTimeRow = {
  id: string; on_date: string; hours: string; activity: string
  employee_id: string; who: string
  created_at: string
  /** Days between doing the work and writing it down. Evidence about evidence. */
  lag_days: number
}

export type Allocatable = {
  source_kind: 'pay_stub' | 'journal_line'
  source_id: string
  on_date: string
  what: string
  /** The whole amount, in cents. What is claimed is this times the percent. */
  amount: bigint
  /** How much of it is already claimed, anywhere. */
  claimed_percent: number
  /** Salary only: the cap and the flags that go with a specified employee. */
  is_specified?: boolean
  /** Contracts only: the 80% rule needs this. */
  arms_length?: boolean
  party?: string | null
  /**
   * What the ACCOUNT says its costs feed (0071), when somebody has said. A
   * suggestion and nothing more: the screen pre-selects it and offers 100%, and
   * the percent and the basis sentence are still the person's.
   */
  suggested?: SredCategory | null
}

/** How the allocation table is narrowed: by words typed, and by one lens. */
export type CostLens = 'all' | 'tagged' | 'unclaimed' | SredCategory

/**
 * Does this cost survive the search box and the lens?
 *
 * PURE, EXPORTED, AND HERE rather than inside the screen, because a predicate
 * that lives as a closure in a component is a predicate no check can call. The
 * first version was exactly that, and the harness beside it claimed the
 * filtering "is checked by reading the same list the table is built from" —
 * which was false: both renders passed an empty query and the `all` lens, so
 * not one branch below ever ran (independent critic, 2026-09-11).
 *
 * Every word has to appear somewhere in the row — description, date or party —
 * in any order, so "rig march" finds a March rig invoice.
 */
export function matchesCost(a: Allocatable, query: string, lens: CostLens): boolean {
  if (lens === 'tagged' && !a.suggested) return false
  if (lens === 'unclaimed' && a.claimed_percent > 0) return false
  if (lens !== 'all' && lens !== 'tagged' && lens !== 'unclaimed' && a.suggested !== lens) return false
  const hay = `${a.what} ${a.on_date} ${a.party ?? ''}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

/**
 * How much of a bonus actually leaves the proxy base.
 *
 * Capped by what is IN the base: a specified employee counted down to 5 x YMPE
 * may have been paid more bonus than the salary that survived the cap, and
 * subtracting the whole bonus would drive their contribution negative and make
 * line 502 report a reduction larger than the figure it came out of.
 *
 * PURE AND EXPORTED so a check can call its branches directly. That is not the
 * only thing holding it: `S29` builds a company whose specified employee is paid
 * almost entirely in bonus, so the clamp bites on a real working paper and the
 * CALL SITE is held too. The first version of this comment said no fixture could
 * reach it — false, and it left the wiring untested while the arithmetic was
 * covered (independent critic, 2026-09-11).
 */
export const bonusOutOfBase = (counted: bigint, bonus: bigint): bigint =>
  counted > bonus ? bonus : counted

/**
 * Which year the project screen is looking at, whether that year has a claim,
 * and which dates its costs come from. THE ONE FULL STATEMENT of this defect;
 * the comments on `YearStrip` and `S30` point here rather than retell it, for
 * the reason `sred.ts` gives about two sentences saying one thing.
 *
 * PURE AND EXPORTED, because the version that lived inline in the page was wrong
 * in a way nothing could call. It resolved the claim as
 * `claims.find(asked) ?? claims[0]`, so asking for a year with no claim handed
 * back SOMEBODY ELSE'S year — the figures of one year under the heading of
 * another — and left `claim` non-null, which was also the condition the opener
 * rendered on. A project's first claim therefore closed the door behind it and a
 * second year could never be opened at all. `S15` had passed throughout because
 * its fixture opens one year and the second was never walked
 * (found while writing the intake spec, 2026-09-12).
 *
 * An asked year that has no claim is a year with NO claim. Nothing is borrowed.
 *
 * THE ORDER OF `claims` IS THE CALLER'S: this takes the first one when no year
 * is asked for, and `claimsFor` is what makes the first one the newest. `S30`
 * asserts that ordering against the database rather than against this array.
 *
 * `span` is here and not in the page because it is a DECISION — which dates the
 * cost table may reach — and a decision spelled out in a server component is one
 * no check in this battery can run (independent critic, 2026-09-12).
 */
export function viewedYear<
  Y extends { id: string; start_date: string; end_date: string },
  C extends { fiscal_year_id: string },
>(
  years: Y[], claims: C[], asked: string | undefined,
): { year: Y | null; claim: C | null; span: { from: string; to: string } | null } {
  const wanted = (asked ? years.find((y) => y.id === asked) : undefined) ?? null
  const claim = wanted
    ? claims.find((c) => c.fiscal_year_id === wanted.id) ?? null
    : claims[0] ?? null
  // The last arm is the FRESH PROJECT: no claim anywhere, so there is nothing to
  // find a year by, and the newest year is the one to land on. Take it away and
  // a project with no claim resolves to no year, which makes `unclaimed` false
  // in the strip and stops the FIRST claim being openable too — the same defect
  // in a different place (independent critic, 2026-09-12).
  const year = wanted ?? years.find((y) => y.id === claim?.fiscal_year_id) ?? years[0] ?? null
  const span = year ? { from: year.start_date, to: year.end_date } : null
  return { year, claim, span }
}

/**
 * A batch of rows, pasted.
 *
 * The FORMAT IS THE ONE `docs/design/34-sred-intake.md` tells the other agent to
 * produce — fields separated by `|`, one row a line — so what comes back from
 * gathering the material goes in without being retyped. Headings like
 * `### TIME` and blank lines are skipped rather than refused, which means the
 * whole block can be pasted as it arrives.
 *
 * PURE AND EXPORTED, both of them, so a check can call every branch. A parser
 * living as a closure inside the screen is a parser nothing can call, and this
 * module has been cured of that twice (`matchesCost`, `bonusOutOfBase`).
 *
 * NOTHING HERE TOUCHES THE DATABASE. A person's name is left as text: which
 * employee it is, is a question for the door, and an unmatched name comes back
 * from there named rather than counted.
 */
export type TimePaste = { line: number; who: string; onDate: string; hours: string; activity: string }
export type EvidencePaste = { line: number; kind: string; title: string; onDate: string }
export type PasteRefusal = { line: number; text: string; why: string }
export type Parsed<T> = { rows: T[]; refused: PasteRefusal[] }

/**
 * ALL OR NOTHING, on one line, in one place.
 *
 * Both batch doors ask this and neither spells it out, so the rule cannot come
 * to mean two different things — and a block can take it away once rather than
 * twice. A batch with any refusal puts nothing in: a partial insert leaves the
 * person re-pasting a batch whose good half is already there, and nothing in
 * this system can tell a genuine repeat of a day's work from a double paste.
 */
export const nothingOnRefusal = (refused: PasteRefusal[]) => refused.length > 0

/**
 * THE COLUMN NAMES OF A PASTED BATCH, in one place.
 *
 * WHAT IS SHARED IS THE ARITY. The parsers count against these and the paste
 * box prints them, so the number of fields the screen asks for cannot drift from
 * the number the parser reads. The ORDER is not shared — it lives here and again
 * in the positional destructuring below — so reordering this array changes the
 * sentence and not the parse, and nothing catches it. Said exactly, because the
 * first version of this comment said the sentence "cannot describe a shape the
 * parser does not read", which is wider than the truth
 * (independent critic, 2026-09-12).
 */
export const TIME_PASTE_FIELDS = ['employeeName', 'onDate', 'hours', 'activity'] as const
export const EVIDENCE_PASTE_FIELDS = ['kind', 'title', 'onDate'] as const

/**
 * What is wrong with these hours, in words, or '' if nothing is.
 *
 * SHARED BY THE PASTE DOOR AND THE EDIT DOOR. It was the parser's alone, so a
 * batch of forty was told which line held 25 hours while the Save button beside
 * one row sent it straight at `numeric(5,2)` and 0068's CHECK — a constraint
 * error where a sentence belonged, which is the outcome block 610's own
 * narrative calls wrong (independent critic, 2026-09-12).
 */
export function hoursProblem(hours: string): string {
  // The shape on its own line, so a block can change it without the message —
  // an anchor carrying a double quote is one the battery's own pre-flight
  // cannot read (it scans for `$` inside double-quoted words).
  const shaped = /^\d+(\.\d{1,2})?$/.test(hours)
  if (!shaped) return `"${hours}" is not hours to two decimals`
  const n = Number(hours)
  if (n <= 0 || n > 24) return `${hours} hours is not between 0 and 24`
  return ''
}

const PASTE_DATE = /^\d{4}-\d{2}-\d{2}$/
/** Not a row: an empty line, or one of the template's own `### …` headings. */
const isNoise = (t: string) => t === '' || t.startsWith('#')

const fieldsOf = (line: string) => line.split('|').map((f) => f.trim())

/**
 * `employeeName | onDate | hours | activity`
 *
 * Hours are checked against the column they are going into — `numeric(5,2)`,
 * greater than nothing and not more than a day — HERE rather than at the
 * database, so a batch of forty rows says which line is wrong instead of
 * failing whole on a constraint.
 */
export function parseTimePaste(text: string): Parsed<TimePaste> {
  const rows: TimePaste[] = []
  const refused: PasteRefusal[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1
    const t = raw.trim()
    if (isNoise(t)) return
    const f = fieldsOf(t)
    if (f.length !== TIME_PASTE_FIELDS.length) {
      refused.push({ line, text: t,
                     why: `${TIME_PASTE_FIELDS.length} fields expected, ${f.length} given` })
      return
    }
    const [who, onDate, hours, activity] = f as [string, string, string, string]
    const badHours = hoursProblem(hours)
    if (!who) refused.push({ line, text: t, why: 'no name' })
    else if (!PASTE_DATE.test(onDate)) refused.push({ line, text: t, why: `"${onDate}" is not yyyy-mm-dd` })
    else if (badHours) refused.push({ line, text: t, why: badHours })
    else if (!activity) refused.push({ line, text: t, why: 'no activity — the sentence is the evidence' })
    else rows.push({ line, who, onDate, hours, activity })
  })
  return { rows, refused }
}

/** `kind | title | onDate`, and the kind must be one CRA asks for. */
export function parseEvidencePaste(text: string): Parsed<EvidencePaste> {
  const rows: EvidencePaste[] = []
  const refused: PasteRefusal[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1
    const t = raw.trim()
    if (isNoise(t)) return
    const f = fieldsOf(t)
    if (f.length !== EVIDENCE_PASTE_FIELDS.length) {
      refused.push({ line, text: t,
                     why: `${EVIDENCE_PASTE_FIELDS.length} fields expected, ${f.length} given` })
      return
    }
    const [kind, title, onDate] = f as [string, string, string]
    if (!EVIDENCE_KINDS.some((k) => k.kind === kind)) {
      refused.push({ line, text: t, why: `"${kind}" is not one of the kinds CRA asks for` })
    } else if (!title) refused.push({ line, text: t, why: 'no title' })
    else if (!PASTE_DATE.test(onDate)) refused.push({ line, text: t, why: `"${onDate}" is not yyyy-mm-dd` })
    else rows.push({ line, kind, title, onDate })
  })
  return { rows, refused }
}

export type PaperLine = {
  /** The T661 line this feeds, where there is one. */
  t661: string | null
  label: string
  amount: bigint
  /** What it is made of, so every figure can be walked back to an entry. */
  from: Array<{ what: string; on_date: string; whole: bigint; percent: number; taken: bigint }>
  note?: string
}

export type WorkingPaper = {
  claimId: string
  entity: string
  isCcpc: boolean | null
  year: { name: string; start: string; end: string }
  /** 18 months after the year end, federally and in BC. Derived, never typed. */
  deadline: string
  daysLeft: number
  method: SredMethod
  /** Both, always: the choice is the owner's and it should be made in sight of the difference. */
  proxy: { lines: PaperLine[]; qualified: bigint }
  traditional: { lines: PaperLine[]; qualified: bigint }
  /** Listed and excluded, so the money is visible rather than dropped. */
  excluded: PaperLine[]
  credits: {
    federal: { rate: number; refundable: boolean; amount: bigint; basis: string }
    bc: { rate: number; refundable: boolean; amount: bigint; basis: string }
  }
  /** Everything the person filing has to settle before this is a return. */
  toConfirm: string[]
}

export type EvidenceRow = {
  id: string; kind: string; title: string; on_date: string
  attachment_id: string | null; note: string | null
  filename: string | null
}

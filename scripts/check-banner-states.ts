/**
 * The banner must fail closed. Every case here made it report "ok" before —
 * or, for the later ones, said nothing where something had to be said.
 * Run: npx tsx scripts/check-banner-states.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DIR = mkdtempSync(join(tmpdir(), 'erp-banner-check-'))
const STORE = join(DIR, 'store')
process.env.BACKUP_DIR = DIR
process.env.ATTACHMENTS_DIR = STORE
process.env.PROJECT_ATTACHMENTS_DIR = join(DIR, 'projects')
process.env.DATABASE_URL = 'postgresql://u@localhost:5432/erp_dev'

type State = 'ok' | 'partial' | 'failed' | 'stale' | 'never'
type Case = {
  name: string
  record: unknown
  /** The restore check's own record; absent means it never ran. */
  check?: unknown
  /** Whether this machine's attachments store holds a file, only Finder's .DS_Store, or nothing. */
  store?: 'files' | 'dotfile' | 'none'
  expect: State
  /** What the check note must say, or `null` for "nothing at all". */
  note?: RegExp | null
  /** What the quiet check line must say, or `null` for "no line". */
  line?: RegExp | null
  /** What the message must say. */
  message?: RegExp
}

const now = new Date().toISOString()
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
const good = { ok: true, at: now, database: 'erp_dev' }
const checked = { ok: true, backupOk: true, at: now, newest: 'erp_dev-x.dump', problems: [], housekeeping: [] }

const cases: Case[] = [
  { name: 'a good record', record: good, check: checked, expect: 'ok', note: null, line: /Restore-checked today \(erp_dev-x\.dump\)/ },
  { name: 'an unparseable date', record: { ...good, at: 'not a date' }, check: checked, expect: 'failed' },
  { name: 'no date at all', record: { ok: true, database: 'erp_dev' }, check: checked, expect: 'failed' },
  { name: 'a date in the future', record: { ...good, at: '2029-08-21T00:00:00Z' }, check: checked, expect: 'failed' },
  { name: 'a different database', record: { ...good, database: 'erp_test' }, check: checked, expect: 'failed', line: null },
  { name: 'ok as the string "false"', record: { ...good, ok: 'false' }, check: checked, expect: 'failed' },
  { name: 'a recorded failure', record: { ok: false, at: now, error: 'disk full' }, check: checked, expect: 'failed' },
  { name: 'a backup four days old', record: { ...good, at: daysAgo(4) }, check: checked, expect: 'stale' },
  // The attachments. backup.sh degrades rather than fails when the schedule
  // cannot read the store, and records that in the status file; the banner
  // used to ignore the field and show the calm grey line.
  { name: 'attachments not backed up',
    record: { ...good, attachments: 'ATTACHMENTS NOT BACKED UP: tar: Operation not permitted' },
    check: checked, expect: 'partial', note: null },
  { name: 'attachments archived', record: { ...good, attachments: 'attachments archived: 3.1M' },
    check: checked, store: 'files', expect: 'ok', note: null },
  { name: 'stale AND attachments missing', record: { ...good, at: daysAgo(4), attachments: 'ATTACHMENTS NOT BACKED UP: x' },
    check: checked, expect: 'stale' },
  // And the run that never looked: an installed copy older than the archive
  // step writes no field; one pointed nowhere writes "no directory yet". Both
  // read as ok until the banner asked whether THIS machine has a store.
  { name: 'the store has files the record never mentioned', record: good, check: checked, store: 'files',
    expect: 'partial', message: /said nothing about the attachments/ },
  { name: 'the store has files, the run saw no directory',
    record: { ...good, attachments: 'no attachments directory yet' }, check: checked, store: 'files',
    expect: 'partial', message: /saw no attachments store/ },
  { name: 'no store, the record says nothing of them', record: good, check: checked, store: 'none', expect: 'ok' },
  { name: 'the store holds only .DS_Store', record: good, check: checked, store: 'dotfile', expect: 'ok' },
  // The restore check. It cannot be scheduled, so its absence must show.
  { name: 'never restore-checked', record: good, expect: 'ok', note: /No backup has ever been restore-checked/, line: null },
  { name: 'restore-checked 40 days ago', record: good, check: { ...checked, at: daysAgo(40) },
    expect: 'ok', note: /over 35 days/, line: null },
  { name: 'restore-checked 20 days ago', record: good, check: { ...checked, at: daysAgo(20) },
    expect: 'ok', note: null, line: /Restore-checked 20 days ago/ },
  { name: 'the check found the backup wrong', record: good,
    check: { ok: false, backupOk: false, at: now, newest: 'erp_dev-x.dump',
             problems: ['R3 the restored database matches the books, table by table'], housekeeping: [] },
    expect: 'failed', line: null, message: /CANNOT BE TRUSTED: R3 the restored database/ },
  { name: 'the check failed in its own housekeeping', record: good,
    check: { ok: false, backupOk: true, at: now, problems: [], housekeeping: ['R7b the download check tidied up after itself'] },
    expect: 'ok', note: /housekeeping \(R7b/ },
  { name: 'an unreadable check record', record: good, check: { at: 'never', backupOk: 'yes' },
    expect: 'ok', note: /cannot be read/ },
]

async function main() {
  mkdirSync(join(DIR, 'backups'), { recursive: true })
  writeFileSync(join(DIR, 'backups', 'a.dump'), 'x')

  const { backupStatus } = await import('../src/lib/backups')
  let failures = 0
  for (const c of cases) {
    writeFileSync(join(DIR, 'last-backup.json'), JSON.stringify(c.record))
    rmSync(join(DIR, 'last-check.json'), { force: true })
    if (c.check !== undefined) writeFileSync(join(DIR, 'last-check.json'), JSON.stringify(c.check))
    rmSync(STORE, { recursive: true, force: true })
    if (c.store === 'files') { mkdirSync(STORE, { recursive: true }); writeFileSync(join(STORE, 'receipt.pdf'), 'x') }
    if (c.store === 'dotfile') { mkdirSync(STORE, { recursive: true }); writeFileSync(join(STORE, '.DS_Store'), 'x') }
    const got = backupStatus()
    const stateRight = got.state === c.expect
    const noteRight = c.note === undefined ? true : c.note === null ? got.checkNote === undefined : c.note.test(got.checkNote ?? '')
    const lineRight = c.line === undefined ? true : c.line === null ? got.checkLine === undefined : c.line.test(got.checkLine ?? '')
    const messageRight = c.message === undefined ? true : c.message.test(got.message)
    const said = `${got.checkNote ? ` note "${got.checkNote.slice(0, 40)}…"` : ''}${got.checkLine ? ` line "${got.checkLine}"` : ''}`
    if (stateRight && noteRight && lineRight && messageRight) {
      console.log(`PASS  ${c.name.padEnd(46)}  -> ${got.state}${said}`)
    } else {
      failures++
      console.log(`FAIL  ${c.name.padEnd(46)}  -> ${got.state}, expected ${c.expect};${said || ' no note, no line'}`
        + `${noteRight ? '' : `; expected note ${c.note === null ? 'none' : c.note}`}`
        + `${lineRight ? '' : `; expected line ${c.line === null ? 'none' : c.line}`}`
        + `${messageRight ? '' : `; message "${got.message.slice(0, 80)}…" should match ${c.message}`}`)
    }
  }
  rmSync(DIR, { recursive: true, force: true })
  console.log(failures === 0 ? '\n=== THE BANNER FAILS CLOSED ===' : `\n=== ${failures} STATE(S) WRONG ===`)
  process.exit(failures === 0 ? 0 : 1)
}
main()

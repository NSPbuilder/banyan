import 'server-only'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { attachmentsDir, backupDir } from './backup-paths'

/** The last `npm run backup:check`, as it recorded itself. */
export type RestoreCheck = {
  at: string
  ageDays: number
  /** That run found the newest backup restores to the same books. */
  trusted: boolean
  /** Which dump it restored. */
  newest?: string
  /** The checks that failed and bear on the backup, by label. */
  problems: string[]
  /** The checks that failed in the check's own housekeeping, by label. */
  housekeeping: string[]
}

export type BackupStatus = {
  /** `partial`: the books were dumped but the attachments were not archived. */
  state: 'ok' | 'partial' | 'stale' | 'failed' | 'never'
  /** How the person should read it, in one sentence. */
  message: string
  at?: string
  ageHours?: number
  file?: string
  bytes?: number
  postedEntries?: number
  auditRows?: number
  manifest?: string
  retentionClass?: 'rolling' | 'archive'
  secondary?: { state: 'copied' | 'not_configured' | 'unavailable' | 'not_applicable'; target?: string; error?: string }
  error?: string
  count: number
  /** The last restore check, when one has been run and its record can be read. */
  check?: RestoreCheck
  /** What needs saying about the restore check: never run, overdue, or unreadable. */
  checkNote?: string
  /** The quiet line for a recent, clean check: when it ran and what it restored. */
  checkLine?: string
}

/** How `backup.sh` begins the attachments note when the store could not be read. */
export const ATTACHMENTS_NOT_BACKED_UP = 'ATTACHMENTS NOT BACKED UP'
/** A restore check older than this is overdue. */
export const CHECK_EVERY_DAYS = 35

type Record_ = {
  ok: unknown; at: string; database?: string; file?: string; bytes?: number
  posted_entries?: number; audit_rows?: number; error?: string; attachments?: string
  project_attachments?: string
  manifest?: string; retention_class?: 'rolling' | 'archive'; complete?: boolean
  problems?: unknown
  secondary?: { state?: unknown; target?: unknown; error?: unknown }
}

/**
 * When the books were last backed up.
 *
 * A scheduled job that quietly stops is the ordinary way backups die — the
 * failure is that nothing happens, and nothing happening looks exactly like
 * everything being fine. The only defence is that someone can see how long it
 * has been, so this is read on the company page every time it loads.
 */
export function backupStatus(staleAfterHours = 36): BackupStatus {
  // The scheduler cannot write inside the repository — macOS refuses a
  // LaunchAgent access to ~/Documents — so the backups live in Application
  // Support (or the XDG data directory) and this reads them from there.
  const dir = backupDir()

  let count = 0
  try {
    count = readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.dump')).length
  } catch {
    return {
      state: 'never', count: 0,
      message: 'No backup has ever been taken.',
    }
  }

  let record: Record_
  try {
    record = JSON.parse(readFileSync(join(dir, 'last-backup.json'), 'utf8'))
  } catch {
    return withCheck({
      state: count > 0 ? 'stale' : 'never',
      message: count > 0
        ? `${count} backup${count === 1 ? '' : 's'} on disk, but no record of when the last one ran.`
        : 'No backup has ever been taken.',
      count,
    }, dir)
  }

  return withCheck(fromRecord(record, count, staleAfterHours), dir)
}

function fromRecord(record: Record_, count: number, staleAfterHours: number): BackupStatus {
  // Everything below fails CLOSED. A status file that cannot be believed is a
  // reason to say so, not a reason to show a green line: an unparseable date
  // gave NaN, NaN > 36 is false, and both the failed and stale branches were
  // skipped — so a broken file read as "backed up NaN days ago" in the calm
  // grey of everything being fine.
  if (typeof record.ok !== 'boolean') {
    return {
      state: 'failed', count, at: record.at,
      message: 'The backup status file cannot be read. Treat the books as un-backed-up until a backup runs.',
    }
  }

  const ageHours = (Date.now() - Date.parse(record.at)) / 3_600_000
  if (!Number.isFinite(ageHours)) {
    return {
      state: 'failed', count, at: record.at,
      message: `The last backup has no usable date ("${record.at}"). Run one now.`,
    }
  }
  // A future timestamp means a clock changed or the file was edited; either
  // way the age it implies is meaningless and would read as "just now" forever.
  if (ageHours < -0.25) {
    return {
      state: 'failed', count, at: record.at,
      message: 'The last backup is dated in the future, so how long it has been cannot be told. Run one now.',
    }
  }
  // The status file names the database it dumped. If that is not the database
  // the app is using, these books are not the ones being backed up.
  const configured = process.env.DATABASE_URL?.split('/').pop()
  if (configured && record.database && record.database !== configured) {
    return {
      state: 'failed', count, at: record.at, ageHours,
      message: `The last backup was of "${record.database}", but this is "${configured}". `
             + 'These books are not the ones being backed up.',
    }
  }

  if (!record.ok) {
    return {
      state: 'failed', count, at: record.at, ageHours, error: record.error,
      message: `The last backup FAILED ${describe(ageHours)}. The books are only as safe as the one before it.`,
    }
  }
  const detail = {
    count, at: record.at, ageHours, file: record.file,
    bytes: record.bytes, postedEntries: record.posted_entries, auditRows: record.audit_rows,
    manifest: record.manifest, retentionClass: record.retention_class,
    secondary: parseSecondary(record.secondary),
  }
  if (ageHours > staleAfterHours) {
    return {
      state: 'stale', ...detail,
      message: `The last backup was ${describe(ageHours)}. The schedule may have stopped.`,
    }
  }
  // The dump is good; the attachments may not have travelled with it. The
  // schedule cannot read ~/Documents, so backup.sh records the refusal in the
  // status file instead of failing — and a banner that never read that field
  // showed the calm grey line over receipts nobody had copied.
  const posted = record.posted_entries !== undefined ? `, ${record.posted_entries} posted entries` : ''
  const issues = Array.isArray(record.problems)
    ? record.problems.filter((v): v is string => typeof v === 'string') : []
  if (record.complete === false) {
    return {
      state: 'partial', ...detail,
      message: `A database backup was written ${describe(ageHours)}${posted}, but the full set is INCOMPLETE`
        + `${issues.length ? `: ${issues.join('; ')}` : '. Check its manifest.'}`,
    }
  }
  if (record.attachments?.startsWith(ATTACHMENTS_NOT_BACKED_UP)) {
    const why = record.attachments.slice(ATTACHMENTS_NOT_BACKED_UP.length).replace(/^[:\s]+/, '')
    return {
      state: 'partial', ...detail,
      message: `The books were backed up ${describe(ageHours)}${posted}, but the attachments were not`
        + `${why ? `: ${why}` : '.'} Run npm run backup from a terminal that can read the store.`,
    }
  }
  // The other way a store goes uncopied: the run never looked. An installed
  // copy of the script older than the archive step writes no field at all,
  // and one pointed nowhere writes "no attachments directory yet" — while
  // this machine has a store with files in it. The banner knows the store
  // (the same rule attachments.ts reads by), so it can tell.
  if (storeHasFiles() && !record.attachments?.startsWith('attachments archived')) {
    return {
      state: 'partial', ...detail,
      message: `The books were backed up ${describe(ageHours)}${posted}, but that run `
        + `${record.attachments ? `saw no attachments store ("${record.attachments}")` : 'said nothing about the attachments'}`
        + ` while this machine has one (${attachmentsDir()}). The scheduled copy of the script is older than `
        + 'the store, or was never told where it is — run ./ops/install-backup-schedule.sh again, then '
        + 'npm run backup by hand.',
    }
  }
  if(process.env.PROJECT_ATTACHMENTS_DIR&&storeHasFiles(process.env.PROJECT_ATTACHMENTS_DIR)
    &&!record.project_attachments?.startsWith('Project files archived'))return {
      state:'partial',...detail,
      message:'The Project file store has files, but the last scheduled backup did not verify that store. Update the backup configuration and run a complete backup.',
    }
  const secondary = parseSecondary(record.secondary)
  if (secondary?.state === 'not_configured') return {
    state: 'partial', ...detail,
    message: `Complete local backup ${describe(ageHours)}${posted}, but no second controlled location is configured.`,
  }
  if (secondary?.state === 'unavailable') return {
    state: 'partial', ...detail,
    message: `Complete local backup ${describe(ageHours)}${posted}, but the second copy failed`
      + `${secondary.error ? `: ${secondary.error}` : '.'}`,
  }
  return { state: 'ok', ...detail, message: `Complete backup ${describe(ageHours)}${posted}.` }
}

function parseSecondary(value: Record_['secondary']): BackupStatus['secondary'] {
  if (!value || !['copied', 'not_configured', 'unavailable', 'not_applicable'].includes(String(value.state))) {
    return undefined
  }
  return {
    state: value.state as NonNullable<BackupStatus['secondary']>['state'],
    target: typeof value.target === 'string' ? value.target : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
  }
}

/**
 * A backup nobody has restored is a file. `npm run backup:check` cannot be
 * scheduled — it needs the repository, which the scheduler may not read — so
 * its absence has to be visible instead: the check records itself, and this
 * says how long it has been, or that it has never been done.
 */
function withCheck(status: BackupStatus, dir: string): BackupStatus {
  let rec: {
    at?: unknown; ok?: unknown; backupOk?: unknown; newest?: unknown
    problems?: unknown; housekeeping?: unknown
  }
  try {
    rec = JSON.parse(readFileSync(join(dir, 'last-check.json'), 'utf8'))
  } catch {
    return {
      ...status,
      checkNote: 'No backup has ever been restore-checked. Run npm run backup:check — '
        + 'a backup nobody has restored is a file, not a backup.',
    }
  }
  const ageDays = typeof rec.at === 'string' ? (Date.now() - Date.parse(rec.at)) / 86_400_000 : NaN
  if (!Number.isFinite(ageDays) || typeof rec.backupOk !== 'boolean') {
    return { ...status, checkNote: 'The restore check\'s record cannot be read. Run npm run backup:check.' }
  }
  const labels = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const check: RestoreCheck = {
    at: rec.at as string, ageDays, trusted: rec.backupOk,
    newest: typeof rec.newest === 'string' ? rec.newest : undefined,
    problems: labels(rec.problems), housekeeping: labels(rec.housekeeping),
  }
  // A check that found the backup wrong fails CLOSED, whatever the schedule
  // says: the schedule is writing files, and the check said the files do not
  // come back as the books. It names the checks that failed, not the dump —
  // "no dump at all" and "the app would not serve one" are failures too, and
  // neither is a fault of the newest file.
  if (!check.trusted) {
    const said = check.problems.length > 0
      ? `: ${check.problems.join('; ')}`
      : '. Run npm run backup:check to see why'
    return {
      ...status, check, state: 'failed',
      message: `The last restore check, ${days(ageDays)}, found the backup CANNOT BE TRUSTED${said}. `
        + 'Fix that before anything else, then run npm run backup:check again.',
    }
  }
  if (rec.ok === false) {
    const said = check.housekeeping.length > 0 ? ` (${check.housekeeping.join('; ')})` : ''
    return {
      ...status, check,
      checkNote: `The restore check ${days(ageDays)} failed in its own housekeeping${said} — the backup itself `
        + 'came back right. Run npm run backup:check again to clear it.',
    }
  }
  if (ageDays > CHECK_EVERY_DAYS) {
    return {
      ...status, check,
      checkNote: `Last restore-checked ${days(ageDays)} — over ${CHECK_EVERY_DAYS} days. Run npm run backup:check.`,
    }
  }
  // The quiet line: only for a check that passed, and only under a banner
  // that is not red — "restore-checked today" beneath "these books are not
  // the ones being backed up" would read as reassurance about the wrong
  // thing (seen on the test server, whose database differs from the record's).
  if (status.state === 'never' || status.state === 'failed') return { ...status, check }
  return {
    ...status, check,
    checkLine: `Restore-checked ${days(ageDays)}${check.newest ? ` (${check.newest})` : ''}.`,
  }
}

/**
 * Whether this machine's attachments store holds anything a backup should
 * carry. Finder leaves a .DS_Store in any folder it has shown, so an emptied
 * store is not "files"; only entries that are not dotfiles count.
 */
function storeHasFiles(directory=attachmentsDir()): boolean {
  try {
    return readdirSync(directory).some((f) => !f.startsWith('.'))
  } catch {
    return false
  }
}

function describe(hours: number): string {
  if (hours < 1) return 'less than an hour ago'
  if (hours < 2) return 'an hour ago'
  if (hours < 48) return `${Math.round(hours)} hours ago`
  return `${Math.round(hours / 24)} days ago`
}

function days(d: number): string {
  if (d < 1) return 'today'
  if (d < 2) return 'yesterday'
  return `${Math.round(d)} days ago`
}

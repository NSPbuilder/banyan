import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/**
 * Where the PostgreSQL 17 client tools and the backups are.
 *
 * Four files used to spell `/opt/homebrew/opt/postgresql@17/bin` out, and
 * `~/Library/Application Support` was the only default anybody had written
 * down — right on the Mac this was built on, wrong on an Intel Mac, and
 * nonsense on the Linux box the deployment notes describe. One answer here,
 * so a machine that differs is told in one place: `PG_BIN` and `BACKUP_DIR`
 * in the environment win, then the places the usual installers put things,
 * then whatever is on PATH.
 */
export const PG_BIN_CANDIDATES = [
  '/opt/homebrew/opt/postgresql@17/bin', // Homebrew, Apple Silicon
  '/usr/local/opt/postgresql@17/bin', // Homebrew, Intel
  '/usr/lib/postgresql/17/bin', // Debian, Ubuntu
  '/usr/pgsql-17/bin', // RHEL, Fedora (PGDG)
]

type Env = Record<string, string | undefined>

/** The directory holding pg_dump, or '' when the tools are to be found on PATH. */
export function pgBin(env: Env = process.env): string {
  if (env.PG_BIN) return env.PG_BIN
  return PG_BIN_CANDIDATES.find((d) => existsSync(join(d, 'pg_dump'))) ?? ''
}

/** The path to one tool, or its bare name when the tools are on PATH. */
export function pgTool(name: string, env: Env = process.env): string {
  const dir = pgBin(env)
  return dir ? join(dir, name) : name
}

/**
 * Where the scheduled backups live. On a Mac that is Application Support —
 * the scheduler cannot write inside the repository, because macOS refuses a
 * LaunchAgent access to ~/Documents. Elsewhere it is the XDG data directory.
 */
export function backupDir(env: Env = process.env, os: string = platform()): string {
  if (env.BACKUP_DIR) return env.BACKUP_DIR
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support', 'erp-backup')
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'erp-backup')
}

/**
 * Where the attachments store is: `ATTACHMENTS_DIR`, or `attachments/` under
 * the working directory. The same rule `src/lib/attachments.ts` reads by, and
 * the one the banner uses to know whether this machine HAS a store the backup
 * ought to have mentioned.
 */
export function attachmentsDir(env: Env = process.env, cwd: string = process.cwd()): string {
  return env.ATTACHMENTS_DIR || join(cwd, 'attachments')
}

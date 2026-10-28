import { backupStatus } from '@/lib/backups'
import { DownloadForm } from '@/app/DownloadButton'

const TONE = {
  ok:     'text-neutral-500',
  partial: 'rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
  stale:  'rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
  failed: 'rounded border border-red-300 bg-red-50 px-3 py-2 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
  never:  'rounded border border-red-300 bg-red-50 px-3 py-2 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
} as const

/**
 * Shown on every company page. A backup nobody can see is a backup nobody
 * knows has stopped running.
 */
export function BackupBanner() {
  const status = backupStatus()
  const wrong = status.state !== 'ok'

  return (
    <div className={`mt-6 text-sm ${TONE[status.state]}`}>
      <p>
        {wrong && <strong className="mr-1">Backups:</strong>}
        {status.message}
        {status.error && <span className="mt-1 block font-mono text-xs">{status.error}</span>}
      </p>

      {/* The restore check cannot run on a schedule (it needs the repository,
          which the scheduler may not read), so the only way it gets done is
          that this line nags: never done, or done too long ago. When it is
          recent and clean, one quiet clause says so. */}
      {status.checkNote
        ? <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{status.checkNote}</p>
        : status.checkLine && (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{status.checkLine}</p>
        )}

      {/* A div, not a p: a form is flow content and the HTML parser closes a
          <p> in front of it, so the DOM React hydrated into was not the tree it
          rendered — React error #418 on every company page load, seen in the
          console during the real-click test (2026-09-13). */}
      <div className="mt-1 text-xs">
        {/* The daily backup runs unattended, so it can only write to a fixed
            place on this machine — the same disk the database is on. This is
            how a copy gets somewhere else: the browser asks where to put it. */}
        {/* A form, not a link: the route is a POST because taking a backup
            spawns pg_dump, and a GET with a side effect was triggerable by an
            <img> on any page (RISKS §15b). The browser still saves the
            response, because it arrives as an attachment. */}
        <DownloadForm action="/backup/download" label="Save database-only copy"
                      working="Preparing the database copy — your browser will ask where to save it…" />
        <span className="text-neutral-500 dark:text-neutral-400">
          {' '}— this convenient download does not include attachment files. Use the complete backup
          command for a recoverable set of database, audit trail, paper and manifest.
        </span>
      </div>

      {wrong && (
        <p className="mt-1 text-xs">
          Run a complete set now with <code className="font-mono">npm run backup</code>, or install the daily
          schedule with <code className="font-mono">./ops/install-backup-schedule.sh</code>.
          Prove a backup restores with <code className="font-mono">npm run backup:check</code>.
        </p>
      )}
    </div>
  )
}

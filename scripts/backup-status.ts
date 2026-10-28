/**
 * What the backup schedule and the restore check last recorded.
 *   npm run backup:status
 * Reads from wherever the backups live (BACKUP_DIR, or the platform default —
 * the same rule the banner reads by), not from a spelled-out Mac path.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { backupDir } from '../src/lib/backup-paths'

const dir = backupDir()
console.log(`backups: ${dir}`)
for (const [file, absent] of [
  ['last-backup.json', 'no backup has ever run'],
  ['last-check.json', 'never restore-checked'],
] as const) {
  try {
    console.log(`${file}: ${readFileSync(join(dir, file), 'utf8').trim()}`)
  } catch {
    console.log(`${file}: none — ${absent}`)
  }
}

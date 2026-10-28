/**
 * WHAT A BACKUP FILE IS CALLED, in one place.
 *
 * `.figtree` was long; it is `.fig` now (owner, 2026-09-12). The one thing a
 * rename like this must not do is stop a person opening the backups they
 * already have, so the WRITER produces `.fig` and the file picker accepts both.
 *
 * NOTHING INSIDE THE FILE CHANGED. The format field a backup carries is still
 * `figtree` — that is what every file already on disk says of itself, and
 * renaming it would have made all of them unreadable to satisfy a cosmetic
 * change. The extension is what a person sees; the field is what the reader
 * checks, and only one of those was asked about.
 *
 * Pure, beside `backup.ts` for the reason `sred-kinds.ts` sits beside
 * `sred.ts`: the backup screen is a client component and cannot import a
 * `server-only` module.
 */
export const BACKUP_EXT = '.fig'

/** What the file picker offers. The old name stays openable, deliberately. */
export const BACKUP_ACCEPT = '.fig,.figtree'

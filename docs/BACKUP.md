# Backup and recovery

A complete instance includes PostgreSQL, accounting/minute-book/CRM attachment originals, separate Project files, environment settings and encryption secrets. A database dump alone cannot restore missing documents. Keep backups access-controlled, encrypted where appropriate, and off the application host.

## Full backup script

`scripts/backup.sh` reads a protected `config` file from `BACKUP_DIR`; it does not automatically load `.env.local`. The default backup root is `~/Library/Application Support/erp-backup` on macOS or `${XDG_DATA_HOME:-$HOME/.local/share}/erp-backup` on Linux. The legacy path is retained for compatibility.

Choose your own absolute `BACKUP_DIR`, create it with mode 700, and write a mode-600 `config` containing:

```dotenv
DATABASE_URL=postgresql://YOUR_CONNECTION_TO_THE_APPLICATION_DATABASE
ATTACHMENTS_DIR=/absolute/persistent/path/banyan/attachments
PROJECT_ATTACHMENTS_DIR=/absolute/persistent/path/banyan/project-attachments
APP_VERSION=0.0.1
```

Make the configuration readable only by the backup operator. Then run, with an existing writable destination directory:

```sh
BACKUP_DIR=/absolute/private/backup-config npm run backup -- /absolute/backup-destination
```

Set `PG_BIN` when PostgreSQL 17 client tools are outside PATH. Retain the generated `.dump`, `.attachments.tgz`, `.projects.tgz` and `.manifest.json` together. Read the manifest: a run can report missing storage and must not be assumed to contain every file. The macOS scheduler helper in `ops/install-backup-schedule.sh` is optional and must be adapted and verified under the scheduler's actual account.

## Recovery rehearsal

1. Use an isolated host or new empty database and new empty storage directories. Keep the live instance untouched.
2. Stop application writes. Restore the custom-format dump with matching PostgreSQL tools, using `pg_restore --exit-on-error` against the intended empty target. Do not blindly run a clean/drop restore on a live database.
3. Inspect archive paths before extracting attachment tarballs. Restore each original storage tree into its configured location; the archives include their source directory's basename.
4. Restore the protected environment settings and the same encryption keys. Rebuild/run the matching source version, then verify database migration identity, company balances, audit checks, document reads and a new backup.
5. A cloned database includes authentication state. Before exposing a restored clone, invalidate restored sessions/integrations as appropriate using the guarded `auth:invalidate-restored` tool (run it with `--help` first), then establish the intended credentials.

Rehearse this procedure before relying on backups. A readable dump is weaker evidence than a successful isolated restore with attachment checks.

## Single-company archives

The application's Backup page supports portable `.fig` company archives. These are a different format and purpose from a full-instance backup. They do not replace PostgreSQL, file-store, environment and key recovery. Compatibility identifiers such as `.fig` and `FigTree` are intentionally retained; do not rename archive internals by hand.

Developer restore checks can create or drop disposable databases. Read the scripts and [Development](DEVELOPMENT.md) before running `backup:check` or restore tools; they are not passive production health checks.

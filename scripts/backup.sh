#!/usr/bin/env bash
# A complete FigTree backup set: database, audit trail, attachment originals,
# and a manifest that states what was (and was not) captured.
set -uo pipefail
umask 077

PGD=""
if [ -n "${PG_BIN:-}" ]; then
  PGD="$PG_BIN/"
else
  for candidate in /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin \
                   /usr/lib/postgresql/17/bin /usr/pgsql-17/bin; do
    [ -e "$candidate/pg_dump" ] && PGD="$candidate/" && break
  done
fi

if [ -z "${BACKUP_DIR:-}" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    BACKUP_DIR="$HOME/Library/Application Support/erp-backup"
  else
    BACKUP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/erp-backup"
  fi
fi

CONFIG="$BACKUP_DIR/config"
STATUS_FILE="$BACKUP_DIR/last-backup.json"
ROLLING_DIR="$BACKUP_DIR/backups"
RETAIN_DAYS=${BACKUP_RETAIN_DAYS:-30}
QUIET=""
DESTINATION=""
RETENTION="rolling"
OUT=""
ATTACH_OUT=""
PROJECT_OUT=""
MANIFEST=""
META=""

for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --archive) RETENTION="archive" ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *)
      if [ -n "$DESTINATION" ]; then echo "only one destination may be supplied" >&2; exit 2; fi
      DESTINATION="$arg"; RETENTION="archive" ;;
  esac
done

say() { [ -n "$QUIET" ] || echo "$@"; }
python_bin() { command -v /usr/bin/python3 2>/dev/null || command -v python3; }
config_value() { grep "^$1=" "$CONFIG" 2>/dev/null | cut -d= -f2- || true; }

record() {
  local ok="$1" message="$2" extra="${3:-}"
  mkdir -p "$BACKUP_DIR" 2>/dev/null || return 0
  local writer="$BACKUP_DIR/write-status.py"
  [ -f "$writer" ] || writer="$(cd "$(dirname "$0")/.." && pwd)/ops/write-status.py"
  "$(python_bin)" "$writer" "$STATUS_FILE" "$ok" "$message" "$extra"
  chmod 600 "$STATUS_FILE" 2>/dev/null || true
}

fail() {
  local message="$1"
  [ -n "$OUT" ] && [ -f "$OUT" ] && rm -f "$OUT"
  [ -n "$ATTACH_OUT" ] && [ -f "$ATTACH_OUT" ] && rm -f "$ATTACH_OUT"
  [ -n "$PROJECT_OUT" ] && [ -f "$PROJECT_OUT" ] && rm -f "$PROJECT_OUT"
  [ -n "$MANIFEST" ] && [ -f "$MANIFEST" ] && rm -f "$MANIFEST"
  [ -n "$META" ] && [ -f "$META" ] && rm -f "$META"
  record false "$message" || true
  echo "backup failed: $message" >&2
  exit 1
}
trap 'fail "the backup stopped unexpectedly at line $LINENO"' ERR

[ -f "$CONFIG" ] || fail "no config at $CONFIG — run ops/install-backup-schedule.sh once"
command -v "${PGD}pg_dump" >/dev/null 2>&1 || fail "PostgreSQL client tools were not found"

DATABASE_URL=$(grep '^DATABASE_URL=' "$CONFIG" | cut -d= -f2-)
ATTACH_SRC=${ATTACHMENTS_DIR:-$(config_value ATTACHMENTS_DIR)}
PROJECT_SRC=${PROJECT_ATTACHMENTS_DIR:-$(config_value PROJECT_ATTACHMENTS_DIR)}
APP_VERSION=${APP_VERSION:-$(config_value APP_VERSION)}
SECONDARY_DIR=${BACKUP_SECONDARY_DIR:-$(config_value BACKUP_SECONDARY_DIR)}
[ -n "$DATABASE_URL" ] || fail "$CONFIG has no DATABASE_URL"
[ -n "$APP_VERSION" ] || APP_VERSION="unknown"

DB=$("${PGD}psql" -tAd "$DATABASE_URL" -c 'SELECT current_database()' 2>/dev/null) \
  || fail "the database cannot be reached"
if [ -n "$DESTINATION" ]; then
  [ -d "$DESTINATION" ] || fail "$DESTINATION is not a directory"
  [ -w "$DESTINATION" ] || fail "$DESTINATION cannot be written to"
  TARGET_DIR="$DESTINATION"
else
  TARGET_DIR="$ROLLING_DIR"
fi
mkdir -p "$TARGET_DIR" || fail "cannot write to $TARGET_DIR"
chmod 700 "$BACKUP_DIR" "$TARGET_DIR" 2>/dev/null || true

STAMP=$(date +%Y%m%d-%H%M%S)
STEM="${DB}-${RETENTION}-${STAMP}"
OUT="$TARGET_DIR/$STEM.dump"
ATTACH_OUT="$TARGET_DIR/$STEM.attachments.tgz"
PROJECT_OUT="$TARGET_DIR/$STEM.projects.tgz"
MANIFEST="$TARGET_DIR/$STEM.manifest.json"
META=$(mktemp "${TMPDIR:-/tmp}/figtree-backup-meta.XXXXXX")

"${PGD}pg_dump" -Fc -d "$DATABASE_URL" -f "$OUT" 2>"$META.err" \
  || fail "$(cat "$META.err")"
"${PGD}pg_restore" -f /dev/null "$OUT" 2>"$META.err" \
  || fail "the dump was written but cannot be read back: $(cat "$META.err")"
chmod 600 "$OUT"

"${PGD}psql" -tAq -d "$DATABASE_URL" -c "
  SELECT json_build_object(
    'database', current_database(),
    'server_version', current_setting('server_version'),
    'schema', json_build_object(
      'count', (SELECT count(*) FROM _migration),
      'last', (SELECT filename FROM _migration ORDER BY filename DESC LIMIT 1)),
    'counts', json_build_object(
      'posted_entries', (SELECT count(*) FROM journal_entry WHERE status IN ('posted','reversed')),
      'audit_rows', (SELECT count(*) FROM audit_log),
      'attachment_rows', (SELECT count(*) FROM attachment),
      'minute_book_attachment_rows', (SELECT count(*) FROM minute_book_attachment),
      'project_attachment_rows', (SELECT count(*) FROM project_attachment)),
    'project_blobs', COALESCE((SELECT json_agg(json_build_object('entity',entity_id,'project',project_id,'sha256',sha256,'bytes',byte_size)) FROM project_attachment_blob),'[]'::json),
    'attachment_sha256', COALESCE((
      SELECT json_agg(sha ORDER BY sha) FROM (
        SELECT DISTINCT sha256 AS sha FROM attachment
        UNION SELECT DISTINCT sha256 AS sha FROM minute_book_attachment
        UNION SELECT DISTINCT sha256 AS sha FROM crm_attachment
      ) expected), '[]'::json))" > "$META" \
  || fail "the backup metadata (including audit and attachment references) could not be read"

if [ -n "$ATTACH_SRC" ] && [ -d "$ATTACH_SRC" ] && [ -r "$ATTACH_SRC" ]; then
  if tar -czf "$ATTACH_OUT" -C "$(dirname "$ATTACH_SRC")" "$(basename "$ATTACH_SRC")" 2>"$META.err"; then
    chmod 600 "$ATTACH_OUT"
  else
    rm -f "$ATTACH_OUT"; ATTACH_OUT=""
  fi
else
  ATTACH_OUT=""
fi

if [ -n "$PROJECT_SRC" ] && [ -d "$PROJECT_SRC" ] && [ -r "$PROJECT_SRC" ] \
   && "$(python_bin)" - "$PROJECT_SRC" "$ATTACH_SRC" <<'PY'
import os, sys
p, a = map(os.path.realpath, sys.argv[1:])
sys.exit(0 if os.path.isabs(sys.argv[1]) and p != a and not p.startswith(a+os.sep) and not a.startswith(p+os.sep) else 1)
PY
then
  if tar -czf "$PROJECT_OUT" -C "$(dirname "$PROJECT_SRC")" "$(basename "$PROJECT_SRC")" 2>"$META.err"; then
    chmod 600 "$PROJECT_OUT"
  else
    rm -f "$PROJECT_OUT"; PROJECT_OUT=""
  fi
else
  PROJECT_OUT=""
fi

SECONDARY_STATE="not_applicable"
SECONDARY_ERROR=""
SECONDARY_TARGET=""
if [ "$RETENTION" = "rolling" ]; then
  if [ -z "$SECONDARY_DIR" ]; then
    SECONDARY_STATE="not_configured"
  elif [ "$SECONDARY_DIR" = "$TARGET_DIR" ]; then
    SECONDARY_STATE="unavailable"; SECONDARY_ERROR="secondary location is the rolling backup directory"
  elif mkdir -p "$SECONDARY_DIR" 2>/dev/null && [ -w "$SECONDARY_DIR" ]; then
    SECONDARY_TARGET="$SECONDARY_DIR"
    if cp "$OUT" "$SECONDARY_DIR/$(basename "$OUT")" \
       && { [ -z "$ATTACH_OUT" ] || cp "$ATTACH_OUT" "$SECONDARY_DIR/$(basename "$ATTACH_OUT")"; } \
       && { [ -z "$PROJECT_OUT" ] || cp "$PROJECT_OUT" "$SECONDARY_DIR/$(basename "$PROJECT_OUT")"; } \
       && cmp -s "$OUT" "$SECONDARY_DIR/$(basename "$OUT")" \
       && { [ -z "$ATTACH_OUT" ] || cmp -s "$ATTACH_OUT" "$SECONDARY_DIR/$(basename "$ATTACH_OUT")"; } \
       && { [ -z "$PROJECT_OUT" ] || cmp -s "$PROJECT_OUT" "$SECONDARY_DIR/$(basename "$PROJECT_OUT")"; }; then
      SECONDARY_STATE="copied"
    else
      SECONDARY_STATE="unavailable"; SECONDARY_ERROR="copy or verification failed"
    fi
  else
    SECONDARY_STATE="unavailable"; SECONDARY_ERROR="target cannot be created or written"
  fi
fi

HELPER="$BACKUP_DIR/backup-manifest.py"
[ -f "$HELPER" ] || HELPER="$(cd "$(dirname "$0")/.." && pwd)/ops/backup-manifest.py"
# Bash 3.2 treats an empty array as unset under nounset. Keep the required
# arguments in the array and append only the archives that were captured.
MANIFEST_ARGS=(
  --manifest "$MANIFEST" --dump "$OUT" --metadata "$META"
  --retention "$RETENTION" --app-version "$APP_VERSION"
  --secondary-state "$SECONDARY_STATE" --secondary-target "$SECONDARY_TARGET"
  --secondary-error "$SECONDARY_ERROR"
)
[ -z "$ATTACH_OUT" ] || MANIFEST_ARGS+=(--attachments "$ATTACH_OUT")
[ -z "$PROJECT_OUT" ] || MANIFEST_ARGS+=(--projects "$PROJECT_OUT")
SUMMARY=$("$(python_bin)" "$HELPER" "${MANIFEST_ARGS[@]}") \
  || fail "the backup manifest could not be written"

if [ "$SECONDARY_STATE" = "copied" ]; then
  cp "$MANIFEST" "$SECONDARY_DIR/$(basename "$MANIFEST")" \
    && cmp -s "$MANIFEST" "$SECONDARY_DIR/$(basename "$MANIFEST")" \
    || fail "the secondary manifest copy could not be verified"
fi

rm -f "$META" "$META.err"; META=""

if [ "$RETENTION" = "rolling" ]; then
  find "$ROLLING_DIR" -type f \( -name '*-rolling-*.dump' -o -name '*-rolling-*.attachments.tgz' \
    -o -name '*-rolling-*.projects.tgz' \
    -o -name '*-rolling-*.manifest.json' \) -mtime +"$RETAIN_DAYS" -delete 2>/dev/null || true
  record true "" "$SUMMARY"
fi

say "wrote backup set $STEM to $TARGET_DIR"
"$(python_bin)" - "$MANIFEST" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print("complete" if data["complete"] else "INCOMPLETE: " + "; ".join(data["problems"]))
print("secondary: " + data["secondary_copy"]["state"])
PY

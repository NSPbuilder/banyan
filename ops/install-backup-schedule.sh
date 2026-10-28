#!/usr/bin/env bash
#
# Install the daily backup. Run once:
#   ./ops/install-backup-schedule.sh
#
# What it does and why it looks like this
# ---------------------------------------
# macOS refuses a LaunchAgent access to ~/Documents. The first version of this
# put the script and the dumps in the repository, so the agent failed every day
# with "Operation not permitted" and nothing noticed — the installer even
# printed the status file from an earlier MANUAL run and called it success.
#
# So everything the scheduler touches lives in ~/Library/Application Support,
# which macOS does not protect: a copy of the script, the database URL, and the
# dumps. The repository is not read by the agent at all.
#
# This installer is launchd, so it is macOS only. On Linux, schedule
# `scripts/backup.sh --quiet` with cron or a systemd timer, with BACKUP_DIR
# (and PG_BIN if the tools are somewhere unusual) in its environment; the
# script itself runs anywhere.
#
# `npm run backup:check` is NOT scheduled here, and cannot be: it needs the
# repository, which the agent may not read. It records itself when run, and
# the company page says how long it has been — over 35 days, it nags.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL=com.nsplabs.banyan.backup
HOME_DIR="$HOME/Library/Application Support/erp-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME_DIR/backups" "$HOME/Library/LaunchAgents"

# The URL the agent will back up, and where the attachments store is, copied
# once so the agent never reads the repo. The first installed copy was not
# told where the store was, looked beside itself in Application Support,
# found nothing, and recorded that as nothing to copy.
# (`|| true`: under set -e a grep that finds no line would end the installer
# here, silently, before anything was written — which it did once.)
ATTACHMENTS=$( { grep '^ATTACHMENTS_DIR=' .env.local || true; } | cut -d= -f2-)
[ -n "$ATTACHMENTS" ] || ATTACHMENTS="$(pwd)/attachments"
SECONDARY=$( { grep '^BACKUP_SECONDARY_DIR=' .env.local || true; } | cut -d= -f2-)
PROJECT_ATTACHMENTS=$( { grep '^PROJECT_ATTACHMENTS_DIR=' .env.local || true; } | cut -d= -f2-)
VERSION=$(node -p "require('./package.json').version")
{
  grep '^DATABASE_URL=' .env.local
  echo "ATTACHMENTS_DIR=$ATTACHMENTS"
  [ -z "$PROJECT_ATTACHMENTS" ] || echo "PROJECT_ATTACHMENTS_DIR=$PROJECT_ATTACHMENTS"
  echo "APP_VERSION=$VERSION"
  [ -z "$SECONDARY" ] || echo "BACKUP_SECONDARY_DIR=$SECONDARY"
} > "$HOME_DIR/config"
chmod 600 "$HOME_DIR/config"
cp scripts/backup.sh "$HOME_DIR/run.sh"
cp ops/write-status.py "$HOME_DIR/write-status.py"
cp ops/backup-manifest.py "$HOME_DIR/backup-manifest.py"
chmod +x "$HOME_DIR/run.sh"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HOME_DIR/run.sh</string>
    <string>--quiet</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME_DIR/backup.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/backup.log</string>
</dict>
</plist>
PLIST

# Prove the agent can actually run, rather than trusting that it will.
BEFORE=$(cat "$HOME_DIR/last-backup.json" 2>/dev/null || echo none)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Waiting for the agent's first run..."
for _ in $(seq 1 20); do
  AFTER=$(cat "$HOME_DIR/last-backup.json" 2>/dev/null || echo none)
  [ "$AFTER" != "$BEFORE" ] && break
  sleep 1
done

CODE=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/last exit code/ {print $NF}')
AFTER=$(cat "$HOME_DIR/last-backup.json" 2>/dev/null || echo none)

if [ "$AFTER" = "$BEFORE" ] || [ "${CODE:-1}" != "0" ]; then
  echo
  echo "THE SCHEDULE IS NOT WORKING."
  echo "  last exit code: ${CODE:-unknown}"
  echo "  log: $HOME_DIR/backup.log"
  [ -s "$HOME_DIR/backup.log" ] && sed 's/^/  | /' "$HOME_DIR/backup.log"
  echo
  echo "Nothing is backing up on a schedule. Fix this before relying on it."
  exit 1
fi

echo
echo "The schedule works — the agent just took a backup itself:"
sed 's/^/  /' "$HOME_DIR/last-backup.json"; echo
ATTACH=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("attachments", "(the record says nothing about attachments)"))' "$HOME_DIR/last-backup.json")
echo
echo "  Attachments: $ATTACH"
case "$ATTACH" in
  "ATTACHMENTS NOT BACKED UP"*)
    echo
    echo "  The agent cannot read the store where it is — macOS refuses a LaunchAgent access to"
    echo "  ~/Documents — so the daily backup carries the books and NOT the receipts, and the"
    echo "  company page says so. Two ways out: run npm run backup by hand now and then, or move"
    echo "  the store: set ATTACHMENTS_DIR in .env.local to a folder outside ~/Documents, move"
    echo "  attachments/ there, and run this installer again." ;;
esac
echo
echo "  Daily at 19:00, and whenever you log in."
echo "  Dumps:   $HOME_DIR/backups"
if [ -n "$SECONDARY" ]; then
  echo "  Second:  $SECONDARY"
else
  echo "  Second:  NOT CONFIGURED — set BACKUP_SECONDARY_DIR to an access-controlled location"
fi
echo "  Check:   npm run backup:check   (by hand, monthly; the company page says when it was last done)"
echo "  Stop it: launchctl bootout gui/$(id -u)/$LABEL"

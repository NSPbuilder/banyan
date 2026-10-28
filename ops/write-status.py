"""Write the backup status file.

Kept as a file rather than a heredoc inside backup.sh so that a syntax or
version problem shows up as a normal error instead of a shell quoting puzzle.

datetime.timezone.utc, not datetime.UTC: macOS ships Python 3.9.
"""
import datetime
import json
import sys

path, ok, message, extra = sys.argv[1:5]

record = {
    "ok": ok == "true",
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
if record["ok"]:
    record.update(json.loads(extra) if extra else {})
else:
    # One line, bounded: a pg_dump failure is several lines long and the reader
    # only needs the gist.
    record["error"] = " ".join(message.split())[:400]

with open(path, "w") as f:
    json.dump(record, f)

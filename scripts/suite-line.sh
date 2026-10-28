# The one definition of the line that says whose checks a mutation block holds.
#   . scripts/suite-line.sh
#
# Sourced by BOTH scripts/mutations.sh, which writes the line and counts it, and
# scripts/suites.sh, which reads it back. It is a file rather than a constant in
# each because it has already drifted twice in one loop:
#
#   1. The first version printed the raw command and let the reader parse
#      `^\$ npm run `. Two blocks cannot run their suite through `npm run` —
#      they have already mutated the test database and the npm script starts
#      with `db:reset` — so their line did not match, the reader skipped it, and
#      the check ids underneath were attributed to whatever suite the block
#      ABOVE had run. A registrations check was filed under db:check-migrations.
#
#   2. The fix changed the format, and the staleness guard in suites.sh went on
#      matching the old spelling while the parser beside it matched the new one.
#      The guard declared a freshly generated, perfectly readable file stale.
#
# Both are the same defect: two spellings of one question. So there is one
# spelling, in one file, and the writer is built from it too — `suite_line` and
# `SUITE_LINE` cannot disagree, because the pattern is derived from nothing and
# the printer is the only thing that emits.

# What a suite-name line looks like to a reader. Bracketed rather than
# backslashed so the identical string is a valid regex to `grep -E`, to `awk`,
# and to `sed -E`, which disagree about what `\$` means.
SUITE_LINE='^[$] [a-z][a-z:_-]* [|]'

# Write one. $1 is the resolved suite name, $2 is the command as it really ran.
#
# The separator is part of the pattern above, so a suite name with a space in it
# cannot silently produce a line that reads as some other suite.
suite_line() { printf '$ %s | %s\n' "$1" "$2"; }

# Read the suite name out of one. Used by every counter on both sides.
suite_line_name() { awk '{print $2}'; }

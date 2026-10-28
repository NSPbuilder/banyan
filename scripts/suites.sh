#!/usr/bin/env bash
#
# Regenerates docs/evidence/suites.md by actually running the battery.
#   npm run db:suites
#   npm run db:suites -- --self-test    just the classifier, no database
#
# Why this exists: "the battery passes" was a sentence in a review packet with
# nothing behind it. `docs/evidence/mutations.md` records the mutation runs, so
# a reader can check that every guard has been made to fail; nothing recorded
# that the guards pass in the first place. A claim about a run that leaves no
# artifact is a claim, and this repository has a rule about those.
#
# What it is NOT: a substitute for running the suites while working. It is the
# record of one complete run, captured.
#
# HOW A ROW IS JUDGED, and why it took three tries to get right:
#
#   1. The exit status. Every suite in the battery exits non-zero when it fails
#      (`process.exit(failures === 0 ? 0 : 1)`, and psql under ON_ERROR_STOP).
#      This is the load-bearing test. The first version discarded it and read
#      only the printed text, which is how the two bugs below survived.
#   2. The summary line must be present. A suite that dies partway prints none,
#      and green from a complete run must not look like green from a truncated
#      one.
#   3. The summary must be one the suite prints when it is happy.
#
# All three, for every row. The first version special-cased `db:smoke` with a
# presence test only — and `db:smoke` is two psql scripts joined by `&&`, so a
# `discriminate.sql` that died partway still left `smoke.sql`'s own
# "=== ALL CHECKS PASSED ===" as the last matching line, and the row read green.
# It also special-cased `typecheck` on the absence of the string `error TS`, so
# a missing binary or a killed process was recorded as `clean`.
#
# `--self-test` runs `classify` against fixtures covering those exact cases. It
# needs no database, and its result is written into the artifact — the fail path
# of a generator that has only ever been watched succeed is not evidence.
set -uo pipefail
cd "$(dirname "$0")/.."

# Overridable so the generator can be run against a scratch file.
OUT=${OUT:-docs/evidence/suites.md}

# The battery as `docs/PRD.md` describes it.
SUITES=(
  db:verify db:verify-setup db:verify-company-onboarding db:verify-accounts db:verify-drafts
  db:verify-reports db:verify-statements db:verify-periods db:verify-exports
  db:verify-tax db:verify-mcp db:verify-mcp-operations db:verify-modules db:verify-assembly db:verify-gst-adjustments db:verify-registrations db:verify-bank db:verify-bank-import
  db:verify-core-optimizations db:verify-bank-match db:verify-bank-reconcile db:verify-statement-files db:verify-opening db:verify-parties db:verify-invoices
  db:verify-aging db:verify-fx db:verify-fx-upgrade
  db:verify-payments db:verify-receipt-attachments
  db:verify-records
  db:verify-documents
  db:verify-quick
  db:verify-attachments db:verify-webdav
  db:verify-search
  db:verify-payroll
  db:verify-cheques
  db:verify-users
  db:verify-crm
  db:verify-project
  db:verify-esign
  db:verify-tax-inputs
  db:verify-assistant
  db:verify-bills
  db:verify-inquiry
  db:verify-skills
  db:verify-picker
  db:verify-backup
  db:verify-sred
  db:verify-workflow
  db:verify-operations db:verify-operations-finance db:verify-production db:verify-production-labour db:verify-depreciation db:verify-deferred-tax
  db:verify-shell db:verify-number-display
  db:verify-account-history-party db:verify-company-templates db:verify-invoice-filters db:verify-minute-book db:verify-project-finance db:verify-project-invoices
  db:verify-project-opt-in
  db:verify-p1 db:verify-p2 db:verify-p3 db:verify-p5 db:verify-invoice-branding
  db:verify-p6-audit db:verify-p6-passkeys db:verify-p6-masters
)
# Run and recorded, but not counted into the verify-suite subtotal — the artifact
# used to add their PASS lines to the total and then attribute the sum to the 14.
# `db:toothless` reads the recorded mutation evidence rather than running
# anything. It is in the battery because the report that used to live inside the
# generator was lost and nothing noticed for several rounds — a guard that only
# runs as part of the thing it guards can disappear with it.
# `backup:check` (scripts/restore-check.ts) is NOT here, and the reason belongs
# beside the list rather than in a commit message.
#
# It was added for one round. A review had pointed out that its R0-R7 checks
# were in no count, so the R7 rework rested on a source diff with no captured
# run behind it — true, and the fix was wrong. What that admission actually did:
#
#   - R3 and R4 compare the RESTORED DUMP against the LIVE BOOKS, so any entry
#     posted since the newest dump turns them red and the whole battery exits 1.
#     A gate that goes red because the day has moved on is not a gate.
#   - It issues DROP DATABASE / CREATE DATABASE against the live server. That is
#     fine for a command a person runs deliberately, and not fine for one the
#     battery runs on every invocation.
#   - It did not even capture R7, the assertion it was admitted for: R7 only
#     prints when the app is up, so the row was six PASS lines (R1-R6) and R7
#     was SKIPped. The denominator moved with whether localhost:3000 happened
#     to be running.
#
# So the honest statement, rather than a row: NO assertion in
# `scripts/restore-check.ts` — every id in the file, not merely the ones that
# never printed — is in any count in this file, because the whole entry is out,
# not some of its rows. (An earlier version of this sentence enumerated the ids
# and was one id out of date before the round that wrote it ended.) The R7 rework is a source-level change with no captured run
# behind it. `backup:check` is a command to run by hand.
OTHERS=(db:check-migrations backup:states db:smoke db:toothless db:restores)

# classify <exit-status> <summary> -> "green" | reason it is not
classify() {
  local status="$1" summary="$2"
  if [ "$status" -ne 0 ]; then echo "exited $status"; return; fi
  if [ -z "$summary" ]; then echo "NO SUMMARY LINE — the suite did not finish"; return; fi
  case "$summary" in
    *"ALL CHECKS PASSED"*|*"FAILS CLOSED"*|*"ALL PASS"*) echo green ;;
    *) echo "$summary" ;;
  esac
}

if [ "${1:-}" = "--self-test" ]; then
  fails=0
  t() { # t <expected> <status> <summary>
    local got; got=$(classify "$2" "$3")
    if [ "$got" = "$1" ]; then printf 'PASS  %s\n' "$4"
    else printf 'FAIL  %s (expected %q, got %q)\n' "$4" "$1" "$got"; fails=$((fails + 1)); fi
  }
  t green 0 '=== ALL CHECKS PASSED ===' 'a suite that passed'
  t green 0 '=== THE BANNER FAILS CLOSED ===' 'backup:states own wording'
  t green 0 '=== 8 DISCRIMINATION CASES ... ALL PASS ===' 'db:smoke own wording'
  t 'exited 1' 1 '=== 1 CHECK(S) FAILED ===' 'a suite that finished and failed'
  t 'exited 1' 1 '=== ALL CHECKS PASSED ===' 'a green line from a run that then died'
  t 'exited 2' 2 '' 'a suite that produced nothing'
  t 'NO SUMMARY LINE — the suite did not finish' 0 '' 'exit 0 but no summary'
  echo
  [ "$fails" -eq 0 ] && echo '=== THE CLASSIFIER REJECTS WHAT IT SHOULD ===' \
                     || echo "=== $fails CLASSIFIER CASE(S) WRONG ==="
  exit $((fails == 0 ? 0 : 1))
fi

# One definition of the suite-name line, shared with scripts/mutations.sh,
# which writes it. Two local spellings of it have already drifted apart.
. scripts/suite-line.sh

selftest=$(bash "$0" --self-test)
selftest_line=$(echo "$selftest" | grep -E '^=== ' | tail -1)

cat > $OUT <<'HEAD'
# The battery

**Generated by `npm run db:suites`. Do not edit by hand.**

Each row is a suite's own summary line, captured from a run, with the number of
PASS lines that run produced. A row is green only if the suite **exited zero**,
printed a summary, and printed one it prints when it is happy — all three. The
exit status is the load-bearing test; reading the text alone let a `db:smoke`
that died partway read as green, because the script before it in the chain had
already printed a passing summary.

`typecheck` and `build` have no summary line of their own, so their rows say what
was observed rather than quoting them.

`docs/evidence/mutations.md` is the other half of this: it records checks being
made to fail on purpose. How MANY of the assertions below it reaches is counted
at the bottom of this file rather than asserted here — that sentence used to
read "every one of these checks", which was not true and had nothing keeping it
true.
HEAD

printf '\n| entry | result | PASS lines |\n|---|---|---|\n' >> $OUT

failed=0
verify_pass=0
other_pass=0
IDS=$(mktemp)
AMBIG=$(mktemp)
trap 'rm -f "$IDS" "$AMBIG"' EXIT

# THE one way to get a check's label out of a line `pass()`/`fail()` printed.
#
# Both sides of the coverage count below have to agree about where the label
# ends and the detail begins, and this has now been wrong twice.
#
#   1. Two extractions: a greedy sed on the run side took the LAST run of
#      two-or-more spaces, an awk `sub` on the evidence side took the FIRST.
#      Any label with a double space inside it was whole on one side and cut
#      back to its id on the other.
#
#   2. One extraction, still wrong. `pass()` defaults the detail to '', so a
#      line with no detail is `PASS  <label><pad>  ` — nothing but spaces after
#      the separator. The "last run of 2+ spaces" rule then skipped the real
#      separator and split on the label's own internal one, so `V2 …` printed
#      one label when it passed and `V2` when it failed. The two sides read
#      DIFFERENT LINES — a PASS line here, the FAIL line from `mutations.md`
#      there — so one function is not by itself enough; the rule has to give
#      the same answer on both.
#
# So the rule reads from the LEFT and never looks at the detail: the label is
# the longest prefix after `PASS  `/`FAIL  ` that contains no run of two spaces.
# Nothing in the detail can affect it, whatever it holds, and a line with no
# detail falls through to the whole remainder.
#
# That rule is exact only while no label contains a run of two spaces itself.
# Every suite pads to a width of its own choosing and one pads to nothing at
# all, so the pad is no help in telling label from detail — only the separator
# is, which is why nothing here counts columns. `truncated_labels` below reports
# PART of the breach: the case where the double space falls right after the
# leading id, which is what every instance found so far has looked like. A
# double space later in a label (`V95 typing in a row  writes that row`) leaves
# a plausible-looking prefix and is NOT caught. Said here rather than left to
# read as full coverage.
label_of() {
  sed -E -e 's/[[:space:]]+$//' \
         -e 's/^(PASS|FAIL)  ([^ ]([^ ]| [^ ])*)  .*$/\2/' \
         -e 's/^(PASS|FAIL)  (.*)$/\2/'
}

# Labels that came out of `label_of` truncated.
#
# From one line alone it is IMPOSSIBLE to tell whether the first run of two
# spaces is inside the label or is the separator — that is the ambiguity, not a
# gap in the code. So this does not try; it reports the symptom instead.
#
# Every label in this repository is an id followed by words. A label that comes
# back as nothing but an id has been cut at a run of two spaces the label itself
# contained, which is exactly how `M3 …` used to read as `M3` on one side and
# whole on the other.
#
# The version before this tried to state the invariant as a regex and got it
# wrong in the direction that hides everything: its delete pattern let the inner
# group match zero times, so `PASS  X…` always matched and every line was
# deleted. It reported nothing on a tree that had 187 such labels in it, and
# that empty report was then quoted as evidence that there were none. A check
# that cannot fail reports success — the sentence this repository has written
# down more than once, in the check written to enforce it.
#
# Fed both sides below: the run and the recorded FAIL lines. The evidence side
# is not there because the two could cut one label differently — with a single
# `label_of` reading from the left they cannot — but because it is the only
# place a red-only label appears at all.
#
# HOW THIS ONE IS KNOWN TO WORK, and how far that knowledge goes. No mutation
# block can cover it: blocks run a single verify suite, and this code only runs
# inside `db:suites`, which no block invokes. So it was proved by hand — a
# double space put into `A02`'s label, `npm run db:suites`, and the report named
# `db:verify-aging run A02`; then reverted.
#
# That proof exercised the RUN side only. The evidence-side feed was not
# demonstrated failing; it is known to carry lines (it yields several hundred
# labels, none truncated) but not known to report one. Weaker than a block on
# both counts, and said plainly rather than left to look like the rest.
truncated_labels() { grep -E '^[A-Z]{1,3}[0-9]+[a-z]?$' || true; }

record() {
  local name="$1" counts_toward="$2" out status summary verdict passes
  out=$(npm run "$name" 2>&1); status=$?
  mkdir -p "${FIGTREE_SUITE_LOG_DIR:-/tmp/figtree-p1-suite-logs}"
  printf '%s\n' "$out" > "${FIGTREE_SUITE_LOG_DIR:-/tmp/figtree-p1-suite-logs}/$name.log"
  summary=$(echo "$out" | grep -E '^=== ' | tail -1)
  passes=$(echo "$out" | grep -cE '^PASS')
  verdict=$(classify "$status" "$summary")
  if [ "$verdict" = green ]; then
    verdict="$summary"
  else
    failed=$((failed + 1))
    # Keep CI failures diagnosable without changing the classification.
    printf "%s\n" "$out" | tail -80 >&2
  fi
  if [ "$counts_toward" = verify ]; then verify_pass=$((verify_pass + passes))
  else other_pass=$((other_pass + passes)); fi
  # Every assertion this run printed, keyed by suite AND by its whole label.
  #
  # Not read from the source: a check the scripts declare but never reach would
  # count from the source and is invisible here, which is the point.
  #
  # And not keyed by the check id. `B45` is nine assertions in a loop
  # (`B45 NO_DATE is caught`, `B45 TWO_DATES is caught`, …); keyed by id, the
  # one of them a mutation reddens discharges all nine, and eight assertions
  # that have never been watched fail read as covered. That is the same defect
  # as the cross-suite one — a key coarser than the thing it identifies — in its
  # within-suite form, and keying on suite+id closed only half of it.
  #
  # The label is everything up to the run of spaces before the detail, which is
  # where `pass()`/`fail()` pad. The detail is deliberately excluded: it differs
  # between a passing run and the failing one recorded in `mutations.md`.
  echo "$out" | grep -E '^(PASS|FAIL)  ' | label_of \
              | awk -v s="$name" 'NF {print s "\t" $0}' >> $IDS
  echo "$out" | grep -E '^(PASS|FAIL)  ' | label_of | truncated_labels \
              | awk -v s="$name" 'NF {print s "\trun\t" $0}' >> $AMBIG
  printf '| `%s` | %s | %s |\n' "$name" "$verdict" "$passes" >> $OUT
  printf '%-26s %s\n' "$name" "$verdict"
}

for s in "${SUITES[@]}"; do record "$s" verify; done
for s in "${OTHERS[@]}"; do record "$s" other; done

# No summary line of their own: judged on exit status, and the row says so.
plain() {
  local name="$1" out status line
  out=$(npm run "$name" 2>&1); status=$?
  mkdir -p "${FIGTREE_SUITE_LOG_DIR:-/tmp/figtree-p1-suite-logs}"
  printf '%s\n' "$out" > "${FIGTREE_SUITE_LOG_DIR:-/tmp/figtree-p1-suite-logs}/$name.log"
  if [ "$status" -eq 0 ]; then
    line="$2"
  else
    line=$(echo "$out" | grep -iE 'error' | head -1)
    line="exited $status${line:+ — $line}"
    failed=$((failed + 1))
  fi
  printf '| `%s` | %s | — |\n' "$name" "$line" >> $OUT
  printf '%-26s %s\n' "$name" "$line"
}

plain typecheck 'exited 0, no diagnostics'
plain build 'exited 0, compiled'

{
  printf '\n**%s PASS lines across the %s verify suites**, plus %s from `%s`.\n' \
    "$verify_pass" "${#SUITES[@]}" "$other_pass" "${OTHERS[*]}"
  printf '\nThe classifier that judged those rows was itself checked against\n'
  printf 'fixtures first (`npm run db:suites -- --self-test`), including a green\n'
  printf 'summary from a run that then died:\n\n```\n%s\n```\n' "$selftest"
  if [ "$failed" -ne 0 ]; then
    printf '\n**%s entries above are not green. This file records that rather than omitting it.**\n' "$failed"
  fi
} >> $OUT

# ---------------------------------------------------------------------------
# How far the mutations reach.
#
# The header of this file used to claim `mutations.md` records "every one of
# these checks" being made to fail. It does not, and nothing was keeping the
# sentence honest — the two files are generated by different commands, forty
# minutes apart, and neither looked at the other.
#
# The first version of this count was the defect it was written to catch. It
# intersected bare check ids, and CHECK IDS ARE NOT UNIQUE ACROSS SUITES: `A10`
# is a `db:verify-accounts` check and also a `db:verify-aging` one, `P11` is in
# both `periods` and `parties`, `V13` in both `posting` and `invoices`. So five
# aging reds were credited to `db:verify-accounts`, five parties reds to
# `db:verify-periods`, and four suites at true zero read as covered. The bare id
# also collapsed two different checks into one, so the prose total disagreed
# with the table printed directly beneath it and nothing failed.
#
# So both sides are keyed on SUITE + LABEL. `mutations.md` can supply the suite
# because its generator now writes a suite-name line into every block, in the
# shape `scripts/suite-line.sh` defines for both scripts; the assertions under
# that line belong to that run.
#
# This is a REPORT, not a gate. It does not change the exit status: deciding
# that every check must have a mutation block is a decision, not a cleanup.
MUT=docs/evidence/mutations.md
{
  printf '\n## How far the mutations reach\n\n'
  if [ ! -f "$MUT" ]; then
    printf '`%s` is not in the tree, so this run counted nothing.\n' "$MUT"
  elif ! grep -qE "$SUITE_LINE" "$MUT"; then
    # Attribution needs the suite name, and only a `mutations.md` generated
    # after that line was added has it. Saying "0 covered" here would be a
    # measurement; this is the absence of one, and the difference matters.
    printf 'Not counted. `%s` in the tree has no suite-name lines matching the\n' "$MUT"
    printf 'shared pattern in `scripts/suite-line.sh`, so a check cannot be\n'
    printf 'attributed to a suite. Run `npm run db:mutations` and this fills in.\n'
  else
    ran=$(mktemp); red=$(mktemp); rows=$(mktemp)
    sort -u "$IDS" > "$ran"

    # suite<TAB>label for every assertion `mutations.md` records going red,
    # attributed to the suite-name line above it rather than to the id alone,
    # and with the label taken by `label_of` — the SAME extraction the run side
    # used, so the two cannot cut the label in different places.
    pairs=$(mktemp)
    awk -v P="$SUITE_LINE" '
      # A new block clears the suite. Without this an unparsed suite-name line
      # would let a block inherit the suite of the block above, which is how a
      # registrations check was once filed under db:check-migrations.
      /^## / { suite = ""; next }
      $0 ~ P { split($0, f, " "); suite = f[2]; next }
      /^FAIL  / { print (suite == "" ? "UNATTRIBUTED" : suite) "\t" $0 }
    ' "$MUT" > "$pairs"
    pairs_kept="$pairs"
    paste <(cut -f1 "$pairs") <(cut -f2- "$pairs" | label_of) \
      | awk -F'\t' 'NF == 2 && $2 != ""' | sort -u > "$red"

    # One row per battery entry, including `typecheck` and `build`, which print
    # no PASS lines at all. Leaving them out let the table read as a complete
    # accounting of the battery while two of its entries were simply not in it —
    # and the sentence above it said the opposite.
    for name in "${SUITES[@]}" "${OTHERS[@]}" typecheck build; do
      one=$(mktemp)
      awk -F'\t' -v s="$name" '$1==s {print $2}' "$ran" | sort -u > "$one"
      t=$(wc -l < "$one" | tr -d ' ')
      if [ "$t" -eq 0 ]; then
        printf '| `%s` | — | — | — |\n' "$name" >> "$rows"
      else
        c=$(awk -F'\t' -v s="$name" '$1==s {print $2}' "$red" | sort -u \
            | comm -12 "$one" - | wc -l | tr -d ' ')
        printf '| `%s` | %s | %s | %s |\n' "$name" "$t" "$c" "$((t - c))" >> "$rows"
      fi
      rm -f "$one"
    done

    # Every figure below is added up from the rows above it, so the two cannot
    # disagree the way the first version's prose and table did.
    n_ran=$(awk -F'|' '$3 ~ /[0-9]/ {s += $3} END {print s + 0}' "$rows")
    n_cov=$(awk -F'|' '$4 ~ /[0-9]/ {s += $4} END {print s + 0}' "$rows")
    n_none=$(grep -c '| — | — | — |' "$rows" || true)

    # Two assertions that print the same sentence are one assertion, and nothing
    # downstream can tell them apart — this file's own `B46` says so about error
    # messages. It is true of check labels too, and it is what this count is
    # keyed on, so it is checked rather than assumed.
    n_lines=$(wc -l < "$IDS" | tr -d ' ')

    printf 'Of the **%s** assertions the battery printed, **%s** are recorded in\n' \
      "$n_ran" "$n_cov"
    printf '`mutations.md` as having been made to fail. The other **%s** have been\n' \
      "$((n_ran - n_cov))"
    printf 'watched passing and never watched failing.\n\n'
    printf 'Keyed on the suite AND the whole label, not the check id: ids repeat\n'
    printf 'across suites, and one id can be a loop of many assertions — `B45` is\n'
    printf 'nine. Either coarser key lets one red discharge checks nothing touched.\n\n'
    printf 'Counted from this run against the `mutations.md` now in the tree. That file\n'
    printf 'is regenerated by a separate command, so a check added since its last run\n'
    printf 'counts as uncovered here until `npm run db:mutations` is run again.\n\n'
    # Printed unconditionally. It used to sit inside the stale-list branch, so
    # the day that list emptied the limits of the whole count would have gone
    # with it — including the SKIP blindness, which is not about stale ids.
    printf 'What this count can and cannot see: only the **%s** suites `mutations.md`\n' \
      "$(grep -E "$SUITE_LINE" "$MUT" | suite_line_name | sort -u | wc -l | tr -d ' ')"
    printf 'actually runs, of the %s entries below; only labels a block reddens; and\n' \
      "$(( ${#SUITES[@]} + ${#OTHERS[@]} + 2 ))"
    printf 'only lines printed through `pass()`/`fail()` — a `SKIP` is invisible to\n'
    printf 'both sides. A check whose two branches print two names is caught here only\n'
    printf 'when a block reaches the branch that differs.\n\n'
    if [ "$n_none" -gt 0 ]; then
      printf '%s entries below print no `pass()`/`fail()` lines of their own and are\n' "$n_none"
      printf 'shown as `—` rather than left out. That is not the same as printing no\n'
      printf 'assertions: `db:smoke` names D1-D8 in its own summary line, and those are\n'
      printf 'real checks this count cannot see.\n\n'
    fi
    # The same test over the OTHER side's lines. Not because the two could cut
    # one label differently — with a single `label_of` reading from the left
    # they cannot — but because a label that only ever appears in a red line
    # appears on this side and nowhere else.
    cut -f2- "$pairs_kept" | label_of | truncated_labels \
      | awk 'NF {print "mutations.md\tevidence\t" $0}' >> $AMBIG
    n_ambig=$(wc -l < "$AMBIG" | tr -d ' ')
    if [ "$n_ambig" -ne 0 ]; then
      printf '**%s label(s) came back as nothing but an id**, which means they were cut\n' "$n_ambig"
      printf 'at a run of two spaces the label itself contained. The separator is a run\n'
      printf 'of two spaces, so such a label cannot be told from its detail by any rule\n'
      printf 'reading one line — including this one, which is why the symptom is\n'
      printf 'reported rather than the label guessed at:\n\n```\n%s\n```\n\n' \
        "$(head -20 "$AMBIG")"
    fi
    if [ "$n_lines" -ne "$n_ran" ]; then
      printf '**%s assertion lines collapsed to %s distinct suite+label pairs.** Two\n' \
        "$n_lines" "$n_ran"
      printf 'assertions printing the same sentence are indistinguishable here and to\n'
      printf 'anyone reading a run — the same rule `B46` applies to error messages:\n\n```\n%s\n```\n\n' \
        "$(sort "$IDS" | uniq -d | head -20)"
    fi
    printf '| entry | assertions | shown red | never shown red |\n|---|---|---|---|\n'
    cat "$rows"

    orphans=$(grep -c '^UNATTRIBUTED	' "$red" || true)
    if [ "$orphans" -gt 0 ]; then
      printf '\n**%s FAIL lines in `mutations.md` sit under no suite-name line** and could\n' "$orphans"
      printf 'not be attributed at all. They are counted as covering nothing.\n'
    fi

    stale=$(comm -13 "$ran" "$red" | wc -l | tr -d ' ')
    if [ "$stale" -ne 0 ]; then
      printf '\n**%s labels go red in `mutations.md` that no passing run prints.**\n' "$stale"
      printf 'A renamed or deleted check whose evidence outlived it — or a line only\n'
      printf 'reachable when something has already gone wrong (a cleanup step, a\n'
      printf 'suite that threw), which is red-only by construction and covers nothing:\n\n```\n%s\n```\n' \
        "$(comm -13 "$ran" "$red")"
    fi
    rm -f "$ran" "$red" "$rows" "$pairs"
  fi
} >> $OUT

echo
echo "Wrote $OUT — $verify_pass verify PASS lines, $failed not green"
echo "$selftest_line"
exit $((failed == 0 ? 0 : 1))

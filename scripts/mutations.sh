#!/usr/bin/env bash
#
# Regenerates docs/evidence/mutations.md by actually running every mutation.
#   npm run db:mutations
#
# The file this writes used to be maintained by hand, and went stale the moment
# a check was rewritten: it recorded R34 failing with a string the rewritten
# check cannot produce, while claiming to be verbatim output. Evidence that is
# typed rather than captured is a claim.
#
# Being generated is not by itself enough. The first version of this script had
# no `set -e`, so a mutation whose search string no longer matched printed a
# complaint to stderr that nothing read, and the suite then ran against the
# UNMUTATED tree. For the twelve blocks expecting failure that showed up as an
# empty block — a finding, per the header. For the one block expecting success
# it was invisible: green from a real mutation and green from no mutation at all
# look identical. So:
#
#   - `set -e`, and every `edit` is `|| exit 1` besides;
#   - `edit` takes ONE old/new pair and refuses if the old text is not present,
#     rather than evaluating an expression and checking only that the file
#     changed somehow — a chain of replacements could half-apply and pass that;
#   - the block that expects green asserts the mutation is in the file before
#     running, and asserts the expected line is in the output afterwards.
#
# Every mutation is reverted afterwards. The trap restores the tree on any exit;
# on a signal it also stops, rather than restoring and carrying on re-mutating.
#
# DO NOT EDIT ANY SOURCE FILE WHILE THIS IS RUNNING. The snapshot is taken once,
# at the start, and `restore` runs after every block — so an edit made mid-run is
# reverted by the next block, silently, and `tsc` then passes on the reverted
# file. That happened: two edits were made during a run, typechecked clean, and
# were gone. This takes about forty minutes; make the edits first.
set -euo pipefail
cd "$(dirname "$0")/.."

# One definition of the suite-name line, shared with scripts/suites.sh.
. scripts/suite-line.sh

OUT=docs/evidence/mutations.md
LAST_SUITE_LOG=${FIGTREE_MUTATION_CRASH_LOG:-${TMPDIR:-/tmp}/erp-mutations-last-suite.log}
# How many times `run` was called. Counted as it happens so the guard at the
# bottom has a number that does NOT come from reading $OUT back.
RUNS=0
# --from=N: keep the evidence of blocks 1..N-1 from the previous run and start
# at block N. A fix at block 396 used to cost the whole fifty minutes again
# (owner, 2026-09-05: "跑过的全量是不是可以不重复跑了"). Every per-block helper
# below is a no-op while the block counter is under N; the file is cut at the
# N-th heading rather than rewritten, and the run count starts from what is
# kept, so the closing consistency check still holds for the whole file.
FROM=1
# `--only=N` (or `--only=mNNN`) re-runs ONE block and keeps the evidence of
# every other. `--from` could only ever keep a PREFIX, so correcting block 307
# meant re-running the 326 after it — hours of machine time to refresh one
# capture, and the reason a stale block was easier to leave than to fix
# (owner, 2026-09-12: "不要跑全量").
# `--replace=N:COUNT` captures renamed or replaced blocks while preserving the
# old suffix, but only when every heading outside that exact range still agrees
# with the script. A shifted or reordered block makes it refuse before writing.
ONLY=
REPLACE=
TO=
for a in "$@"; do case "$a" in
  --from=*) FROM="${a#--from=}" ;;
  --only=*) ONLY="${a#--only=}" ;;
  --replace=*) REPLACE="${a#--replace=}" ;;
esac; done
BLOCK=0
TITLE=""
SKIP=0
# A raw command inside a block (a reset, a psql) goes through this so it, too,
# stays quiet while the block is being skipped.
blk() { [ "$SKIP" = 1 ] && return 0; "$@"; }
# A block that must come back GREEN says so through this, so the assertion is
# skipped along with the block it belongs to.
green() { [ "$SKIP" = 1 ] && return 0; tail -1 $OUT | grep -q 'ALL CHECKS PASSED' || { echo "$1" >&2; exit 1; }; }
BACKUP=$(mktemp -d)
TESTDB="${TEST_DATABASE_URL:?Export an explicitly confirmed isolated TEST_DATABASE_URL}"
node --input-type=module <<'JS'
const name=new URL(process.env.TEST_DATABASE_URL).pathname.slice(1);
if(!/^[a-z][a-z0-9_]*_test$/.test(name) || process.env.TEST_DATABASE_CONFIRMATION!==name)throw Error('Unconfirmed mutation test database');
JS

# restore — put every file a block can edit back the way it was, then PROVE it.
#
# The list used to be fifty `cp` lines typed out by hand, and a mutation target
# that was not on it was never restored: the mutation stayed in the tree for
# every block after it, and for the commit. `invoice-rows.ts` and
# `InvoiceLines.tsx` were both new and both missing, which is how this was
# found — a hand-kept list beside another list, with nothing holding them
# together, which is the defect this whole file exists to catch elsewhere.
#
# So the list is derived from the blocks themselves, by the same parse that
# checks their anchors, and the restore is checked rather than assumed.
restore_files() {
  local i=0 f
  while IFS= read -r f; do
    i=$((i+1))
    cp "$BACKUP/files/$i" "$f"
  done < "$BACKUP/targets.txt"
}

# A restore that did not restore leaves every later block reading a mutated file
# and recording the result as evidence. Kept apart from the copying so that
# `--self-test` can show it refusing: a guard nobody has watched fail is a
# guard on trust.
verify_tree() {
  if ! shasum -a 256 -c "$BACKUP/manifest" >/dev/null 2>&1; then
    echo "RESTORE DID NOT RESTORE — the tree is not what it was:" >&2
    shasum -a 256 -c "$BACKUP/manifest" 2>&1 | grep -v ': OK$' >&2
    return 1
  fi
}

restore() { [ "$SKIP" = 1 ] && return 0; restore_files; verify_tree || exit 1; }
onsignal() {
  restore
  # Block 13 patches a function INTO the test database. A signal landing there
  # would leave it patched until someone happened to reset.
  npm run db:reset >/dev/null 2>&1 || true
  echo "interrupted — tree and test database restored" >&2
  exit 130
}
# Armed AFTER the backup exists, further down. Arming here would make a
# preflight failure run `restore` against a directory with nothing in it, and
# the error the run actually stopped for would be the second one printed.

SCRIPT="$0" BACKUP="$BACKUP" python3 - <<'PREFLIGHT' || exit 1
import os, re, sys
# The script this is part of, not a path typed here: reading a hardcoded name
# audits whatever is at that name rather than the blocks about to run.
src = open(os.environ['SCRIPT'], encoding='utf-8').read()
problems = []
targets = set()

def split_words(cmd, bash_faithful=False):
    """The words of one `edit ...` invocation, stopping at an unquoted `||`.

    With bash_faithful=True, plain single quotes keep every character verbatim
    — which is what bash actually does. The default keeps the historical
    $'...'-style mapping; the preflight parses BOTH ways and refuses any edit
    where the two disagree, because an anchor leaning on the mapping passes
    the default parse and fails the runtime edit (it aborted a full evidence
    run before this guard existed)."""
    words, cur, i, q, started, ansi = [], '', 0, None, False, False
    while i < len(cmd):
        c = cmd[i]
        if q is None:
            if c == '\\' and i + 1 < len(cmd):
                cur += cmd[i+1]; i += 2; started = True; continue
            if c in '\'"':
                q = c; started = True
                # $'...' is ANSI-C quoting: bash applies the escapes there,
                # and ONLY there among single-quote forms.
                ansi = c == "'" and cur.endswith('$')
                if ansi: cur = cur[:-1]
                i += 1; continue
            if c == '|' and cmd[i:i+2] == '||':
                break
            if c.isspace():
                if started: words.append(cur); cur = ''; started = False
                i += 1; continue
            cur += c; i += 1; started = True; continue
        if c == '\\' and q == '"' and i + 1 < len(cmd) and cmd[i+1] in '"`$\\':
            cur += cmd[i+1]; i += 2; continue
        if (ansi or not bash_faithful) and c == '\\' and q == "'" and i + 1 < len(cmd) and cmd[i+1] in "n\\'":
            cur += {'n': '\n', '\\': '\\'}.get(cmd[i+1], cmd[i+1]); i += 2; continue
        if c == q:
            q = None; i += 1; continue
        cur += c; i += 1
    if started: words.append(cur)
    return words


# Two blocks replace a database function with psql rather than editing a file,
# because the migration they revert is append-only. They are named here so that
# "this block has no edit line" stays a fact about those two and becomes a
# failure for a third — an audit that quietly skips what it cannot read reports
# a clean result for blocks it never looked at.
BY_OTHER_MEANS = {
    '0015 reverted \u2014 one role read as one tax',
    '0016 reverted \u2014 the audit names the database role',
    'The invoice-side limit is quietly a thousand times looser',
    'An entry that never touched the debt settles it anyway',
    'A transfer group stops having to balance',
    'The securities register learns to edit',
    'Two overlapping terms for one director',
    'A holder may go negative and nobody is watching',
    'The two ways to spend a note stop being added together',
    'The wall stops asking who is knocking',
    'The same dollar may be claimed by two projects',
    'The rates stop naming the provision they come from',
    'The over-allocation rule counts the row it is about to replace',
    'A row that changes hands is counted against itself',
}

# A block's body ends where the blocks end. Two sentinels because there are two
# things after them: the prose the script appends, and (since `--only`) the code
# that puts back the captures of the blocks it did not re-run. Without the
# second, that code reads as a bare command inside the last block.
blocks = []
for _b in re.split(r'(?m)^(?=section ")', src)[1:]:
    # Written as two indented splits rather than one alternation on this line:
    # `S3` scans this script for redirections with `^[a-z][^>]*>>` and would
    # read a regex spelling `\$OUT` at column 0 as a file it cannot find.
    _b = _b.split('\ncat ' + '>> $OUT')[0]
    blocks.append(_b.split('\n# ---- after the blocks ----')[0])
if not blocks:
    problems.append('no section blocks found at all — the audit is reading the wrong thing')

for b in blocks:
    title = re.match(r'section "((?:[^"\\]|\\.)*)"', b).group(1)

    # An unescaped backtick in a title or prose is COMMAND SUBSTITUTION: bash
    # runs the word and splices its output in. `postEntry` in one block became
    # "whatever  makes of them" in the evidence — a sentence with a hole in it,
    # and nothing failed. Twice now, so it is a check rather than care.
    pm = re.match(r'section "(?:[^"\\]|\\.)*" \\\n"((?:[^"\\]|\\.)*)"', b)
    for where, txt in (('title', title), ('prose', pm.group(1) if pm else '')):
        for bt in re.finditer(r'(?<!\\)`', txt):
            near = txt[max(0, bt.start() - 24):bt.start() + 24].replace('\n', ' ')
            problems.append(f'unescaped backtick in {where} of {title[:40]!r}: ...{near}...')

    # A file a block writes by any other means. Block 43 appends a line with
    # `printf >>` and is backed up only because that file is also its `edit`
    # target — by luck, not by rule. Anything appended to is a target too.
    for am in re.finditer(r'>>\s*("?)([^\s"|;&]+)\1', b):
        appended = am.group(2)
        if appended.startswith('$'):
            continue                      # $OUT, and the backup's own manifest
        # A `>>` inside an edit string — `ReturnType<typeof f>>` closing two
        # generics — is read here as a redirection, and the "file" it names is
        # whatever followed. Left alone, the run died forty lines later in the
        # backup loop as `cp: ': No such file or directory`, with nothing
        # pointing back at the block that caused it.
        if not os.path.exists(appended):
            problems.append(f'{title[:50]!r} appends to {appended!r}, which does not '
                            'exist — if that came from a `>>` inside an edit string, '
                            'spell the type so it does not end in two angle brackets')
            continue
        targets.add(appended)

    # A BLOCK MAY ONLY USE THE COMMANDS THAT KNOW ABOUT `--from`.
    #
    # `edit`, `run`, `close` and `restore` all check `SKIP` and do nothing when
    # a block is being skipped. A bare command does not — so block 43's
    # `printf … >> src/lib/tax-forms.ts` ran on EVERY resumed run, appending a
    # line to the real file, and a run that skipped every block never reached a
    # `restore` to take it back out. The tree was left broken by the thing that
    # exists to prove the tree is not (2026-09-10).
    #
    # Quote-aware, because a block is mostly PROSE: the sentence explaining the
    # defect spans several lines inside one argument, and a line-by-line scan
    # reads every one of them as a command.
    stmts, cur, q, esc = [], '', None, False
    for ch in b:
        if esc:
            cur += ch; esc = False; continue
        if q:
            # A backslash inside a quoted string escapes what follows — the
            # prose is full of \` and \", and reading one as the closing quote
            # turns the rest of the block inside out.
            if ch == '\\':
                cur += ch; esc = True; continue
            if ch == q: q = None
            cur += ch
            continue
        if ch == '\\':
            cur += ch; esc = True; continue
        if ch in '\'"':
            q = ch; cur += ch; continue
        if ch == '\n':
            stmts.append(cur); cur = ''; continue
        cur += ch
    stmts.append(cur)
    continued, heredoc = False, None
    for raw_line in stmts:
        # A heredoc's BODY is data, not statements — the two psql blocks feed
        # a whole function definition in through one.
        if heredoc is not None:
            if raw_line.strip() == heredoc: heredoc = None
            continue
        hd = re.search(r"<<-?'?([A-Za-z_][A-Za-z0-9_]*)'?", raw_line)
        if hd: heredoc = hd.group(1)
        line = raw_line.strip()
        was_continued, continued = continued, raw_line.rstrip().endswith('\\')
        if was_continued:
            continue                      # the tail of the statement above
        if not line or line.startswith('#'):
            continue
        if re.match(r'^(?:[A-Za-z_][A-Za-z0-9_]*=\S* )*'
                    r'(section|edit|run|close|restore|blk|present|green)\b', line):
            continue
        # A continuation of the statement above, or the tail of a quoted one.
        if line.endswith('\\') or line in ('|| exit 1', '|| exit 1 ') or line.startswith('|| '):
            continue
        if re.match(r'^(close; restore|restore; close)$', line):
            continue
        problems.append(f'{title[:50]!r} runs {line[:40]!r} on its own — only `edit`, `run`, '
                        '`close` and `restore` know about `--from`, so a bare command runs '
                        'even when the block is skipped and nothing takes it back')
        break

    # And the ways of changing a file this cannot follow. None are used today;
    # the point is that the first one to be used stops the run, rather than
    # slipping past a scan that only knows about `edit` and `>>`.
    for pattern, what in ((r'\bsed -i\b', 'sed -i'), (r'(?m)^\s*mv ', 'mv'),
                          (r'(?m)^\s*cp ', 'cp'), (r'\btee\b', 'tee')):
        if re.search(pattern, b):
            problems.append(f'{title[:50]!r} changes a file with {what}, which the backup '
                            'cannot see — name it as a target deliberately')

    # EVERY edit in the block, not just the first. The older version took
    # `re.search`, so a block with two targets checked one anchor and backed up
    # one file — and the other kept its mutation for every block after it.
    edits = list(re.finditer(r'(?m)^edit ', b))
    if not edits:
        if title not in BY_OTHER_MEANS:
            problems.append(f'no `edit` line in {title[:60]!r} — and it is not one of the '
                            'blocks recorded as replacing a function through psql')
        continue
    for m in edits:
        raw = b[m.start():].replace('\\\n', ' ')
        # Parse the edit the way this audit reads it AND the way bash will
        # hand it to `edit`; refuse any disagreement instead of validating an
        # anchor the runtime cannot find.
        if split_words(raw) != split_words(raw, bash_faithful=True):
            problems.append(f'{title[:50]!r}: an edit string uses a backslash escape this '
                            'preflight and bash read differently — spell it without')
        # And the expansion neither parser models: an unescaped $ inside a
        # DOUBLE-quoted edit arg is substituted by bash before edit() ever
        # sees it — under set -u an unbound name aborts the whole run, and a
        # bound one silently rewrites the anchor. Two runs died this way.
        head = raw.split('||')[0]
        for span in re.findall(r'"((?:[^"\\]|\\.)*)"', head):
            if re.search(r'(?<!\\)\$', span):
                problems.append(f'{title[:50]!r}: a double-quoted edit string contains an '
                                'unescaped $ that bash will expand — single-quote it')
                break
        parts = split_words(raw)
        if len(parts) != 4:
            problems.append(f'cannot read an edit in {title[:60]!r}: got {len(parts)} words, not 4')
            continue
        _, path, old, _new = parts
        targets.add(path)
        if not os.path.exists(path):
            problems.append(f'missing file: {path}')
            continue
        n = open(path, encoding='utf-8').read().count(old)
        if n != 1:
            problems.append(f'{n} occurrences of {old[:60]!r} in {path}')

# A heredoc whose delimiter is missing its closing quote. `bash -n` accepts it:
# the opening quote simply runs on to the next apostrophe in the prose below,
# so the delimiter becomes several lines of text, the heredoc never ends where
# it should, and `cat` is handed the rest of that line as filenames. It has
# happened TWICE in this file, both times surviving `bash -n` and the rest of
# this preflight, and both times only after every block had already run — an
# hour of evidence thrown away at the last step.
for line_no, line in enumerate(src.splitlines(), 1):
    m = re.search(r"<<-?\s*(['\"])([A-Za-z_][A-Za-z0-9_]*)\s*$", line)
    if m:
        problems.append(f'line {line_no}: heredoc delimiter {m.group(2)} opens with '
                        f'{m.group(1)} and never closes it — bash reads on to the next '
                        f'quote in the prose and the redirection breaks')

if problems:
    sys.stderr.write('MUTATION SCRIPT IS NOT READY:\n  ' + '\n  '.join(problems) + '\n')
    sys.exit(1)

# Every file any block edits, written out for the backup below to read. Derived
# from the same parse that just checked the anchors, so a block added tomorrow
# is backed up tomorrow without anybody remembering to say so.
with open(os.environ['BACKUP'] + '/targets.txt', 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(sorted(targets)) + '\n')

# Two numberings, written down once. The docs cite blocks by the marker
# comment above each (`# ---- 406`), which has gaps and by now runs four
# ahead of the counter `section()` keeps; `--from`, the failure messages and
# the evidence headings count sections. Neither can be renumbered without
# invalidating the other, so every message below prints both, and
# `--from=m406` means "the block whose marker says 406".
labels = []
marker = None
for line in src.splitlines():
    m = re.match(r'# -+ (\d+[a-z]?)$', line)
    if m:
        marker = m.group(1); continue
    if line.startswith('section "'):
        labels.append(marker or '?')
        marker = None
with open(os.environ['BACKUP'] + '/labels.txt', 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(f'{i + 1} {lab}' for i, lab in enumerate(labels)) + '\n')
PREFLIGHT
# `--from=m<label>`: translate a marker label to the counter it lives at.
if [ -n "$ONLY" ]; then
  if [ "$FROM" != 1 ]; then
    echo "--only and --from ask for different things; give one." >&2; exit 1
  fi
  FROM="$ONLY"
fi
if [ -n "$REPLACE" ]; then
  if [ "$FROM" != 1 ] || [ -n "$ONLY" ] || [[ ! "$REPLACE" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]]; then
    echo "--replace=N:COUNT must be given alone, with positive decimal numbers." >&2; exit 1
  fi
  FROM="${REPLACE%%:*}"
  TO=$((FROM + ${REPLACE#*:} - 1))
fi
case "$FROM" in
  m*) want="${FROM#m}"
      FROM=$(awk -v m="$want" '$2 == m { print $1 }' "$BACKUP/labels.txt")
      [ -n "$FROM" ] || { echo "no block carries the marker $want" >&2; exit 1; }
      echo "marker $want is block #$FROM" ;;
esac
marker_of() { awk -v n="$1" '$1 == n { print $2 }' "$BACKUP/labels.txt"; }

# A `--from` PAST THE LAST BLOCK is refused, rather than skipping everything.
#
# It reads as harmless and is not: every block is skipped, no block runs, and
# so no `restore` ever runs either — while anything in a block that does not
# check `SKIP` has already touched the tree. That is how `src/lib/tax-forms.ts`
# was left with a line appended to it on 2026-09-10. The preflight above now
# refuses a bare command in a block, and this refuses the run that would have
# had nothing to undo it.
TOTAL=$(grep -c '^section "' "$0")
if [ "$FROM" -gt "$TOTAL" ]; then
  echo "--from=$FROM is past the last block ($TOTAL). Nothing would run, and" >&2
  echo "      nothing would be restored either. Use --from=$TOTAL to re-run the" >&2
  echo "      last block, or leave it off for all of them." >&2
  exit 1
fi
if [ -n "$REPLACE" ] && [ "$TO" -gt "$TOTAL" ]; then
  echo "--replace=$REPLACE extends past the last block ($TOTAL)." >&2; exit 1
fi

echo "all mutation targets present and unique"

# The backup, built from that list.
mkdir -p "$BACKUP/files"
: > "$BACKUP/manifest"
i=0
while IFS= read -r f; do
  i=$((i+1))
  cp "$f" "$BACKUP/files/$i"
  shasum -a 256 "$f" >> "$BACKUP/manifest"
done < "$BACKUP/targets.txt"
echo "$(wc -l < "$BACKUP/targets.txt" | tr -d ' ') files snapshotted, restored and verified after every block"

if [ "${1:-}" = "--self-test" ]; then
  # Two claims about the machinery above, in the order they matter.
  fails=0
  say() { if [ "$1" = 0 ]; then printf 'PASS  %s\n' "$2"; else fails=$((fails+1)); printf 'FAIL  %s\n' "$2"; fi; }

  target=$(head -1 "$BACKUP/targets.txt")
  printf '\n// left behind by --self-test\n' >> "$target"
  if verify_tree >/dev/null 2>&1; then say 1 "S1 a file left mutated is refused"
  else say 0 "S1 a file left mutated is refused  ($target)"; fi

  restore_files
  if verify_tree >/dev/null 2>&1; then say 0 "S2 and the same tree, put back, is accepted"
  else say 1 "S2 and the same tree, put back, is accepted"; fi

  # The list it checks is the list of things blocks edit — not a list typed out
  # beside it. If those ever came apart this is the check that would say so.
  # The append grep is anchored at column 0 so that this script's own comments
  # about redirection are not read as redirections. Real ones are commands.
  missing=0
  while IFS= read -r f; do
    case "$f" in '$'*) continue ;; esac
    grep -qxF -- "$f" "$BACKUP/targets.txt" || { missing=$((missing+1)); echo "      not backed up: $f"; }
  done < <({ grep -hoE "^edit [\"']?[^\"' ]+" "$0" | sed -E "s/^edit [\"']?//"
             grep -hoE "^[a-z][^>]*>> *\"?[^\"| ;&]+" "$0" | sed -E "s/^.*>> *\"?//"; } | sort -u)
  say $([ "$missing" = 0 ] && echo 0 || echo 1) \
    "S3 every file a block writes, by edit or by append, is in the backup  ($(wc -l < "$BACKUP/targets.txt" | tr -d ' ') files, $missing missing)"

  echo
  [ "$fails" = 0 ] && { echo "=== ALL CHECKS PASSED ==="; exit 0; }
  echo "=== $fails CHECK(S) FAILED ==="; exit 1
fi

trap restore EXIT
trap onsignal INT TERM


# edit <file> <old> <new> — refuses unless <old> is present, exactly once used.
edit() {
  [ "$SKIP" = 1 ] && return 0
  EDIT_OLD="$2" EDIT_NEW="$3" python3 - "$1" <<'PY'
import os, sys
path = sys.argv[1]
old, new = os.environ['EDIT_OLD'], os.environ['EDIT_NEW']
s = open(path, encoding='utf-8').read()
n = s.count(old)
if n == 0:
    sys.exit(f'MUTATION DID NOT APPLY to {path}: {old[:70]!r} is not in the file')
# Refuse an ambiguous target rather than editing whichever came first. A block
# mutating `index={i}` in AccountRows hit the phrase inside the doc comment
# ABOVE the JSX, changed a sentence, left the code alone — and recorded a green
# block, because "the file changed" was the whole of the check. The comment that
# explains a defect is the likeliest place to find the defect written out.
if n > 1:
    sys.exit(f'MUTATION IS AMBIGUOUS in {path}: {old[:70]!r} appears {n} times')
open(path, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY
}

# present <file> <needle> — the positive assertion for blocks expecting green.
present() {
  [ "$SKIP" = 1 ] && return 0
  grep -qF -- "$2" "$1" || { echo "MUTATION NOT PRESENT in $1: $2" >&2; exit 1; }
}

section() {
  # Blocks are counted as the evidence file counts them — one per section —
  # not by the numbers in the marker comments, which have gaps. The number a
  # failure prints is the one to hand to --from.
  BLOCK=$((BLOCK + 1))
  TITLE="$1"
  if [ "$BLOCK" -lt "$FROM" ]; then SKIP=1; return 0; fi
  if [ -n "$TO" ] && [ "$BLOCK" -gt "$TO" ]; then SKIP=1; return 0; fi
  SKIP=0
  if [ "$BLOCK" -eq "$FROM" ] && [ "$FROM" -gt 1 ]; then echo "block #$BLOCK (marker $(marker_of "$BLOCK")): $TITLE"; fi
  # The MARKER goes under the heading, not into it: the docs cite markers (they
  # are stable under insertion, and neither numbering can be renumbered without
  # invalidating the other), while `toothless` matches its by-design allowlist
  # against the heading TEXT. Printed here, a citation like "marker 575" can be
  # resolved inside the evidence file rather than only by opening this one
  # (independent critic, 2026-09-11).
  printf '\n## %s\n\n`marker %s`\n\n%s\n\n```\n' \
    "$1" "$(marker_of "$BLOCK")" "$2" >> $OUT
}
close()   { [ "$SKIP" = 1 ] && return 0; printf '```\n' >> $OUT; }

# run <command...> — capture the whole run, insist it finished, then record the
# FAIL lines.
#
# Filtering for `^FAIL` and swallowing the exit status could not tell a suite
# that ran to the end from one that died partway: with a crash injected after
# R21, the block for mutation 7 came out byte-identical to the real one while
# R22-R39 never ran. Every suite here ends by printing its own summary line, so
# that is what makes a run a run.
run() {
  [ "$SKIP" = 1 ] && return 0
  local output
  output=$("$@" 2>&1) || true
  # The same test the extraction uses, not a similar-looking one.
  #
  # This was `case "$output" in *"=== "*)`, a substring match, while the line
  # below extracts with `grep '^=== '`, anchored. A crashed suite printed a
  # stack trace whose echoed source line contained `=== 3,` — enough for the
  # substring guard, not enough for the anchored grep, which then found nothing,
  # returned 1, and killed the run under `set -e` with no message at all. The
  # block it left behind had FAIL lines, no summary and no closing fence.
  #
  # Two spellings of one question is the defect this whole file exists to find.
  # It was in the file doing the finding.
  if ! echo "$output" | grep -qE '^=== '; then
    echo "SUITE DID NOT FINISH — no summary line (block #$BLOCK, marker $(marker_of "$BLOCK"): $TITLE). Last of its output:" >&2
    echo "$output" | tail -8 >&2
    echo "(fix it, then: bash scripts/mutations.sh --from=$BLOCK)" >&2
    # The whole of it, for the reader: eight lines told us a migration had
    # failed and not what the suite had done to the database first.
    echo "$output" > "$LAST_SUITE_LOG"
    echo "(full output: $LAST_SUITE_LOG)" >&2
    exit 1
  fi
  # The suite's own name, in the block, in ONE shape.
  #
  # The header has always said "the captured output of the suite named" and the
  # suite was NOT named anywhere — a reader could only infer it, and nothing
  # downstream could read it at all. That is what let `suites.sh` credit
  # `db:verify-accounts` with five reds that were all `db:verify-aging` checks:
  # check ids are not unique across suites, so an id on its own does not say
  # whose it is.
  #
  # The first version of this line printed the command and let the reader parse
  # it. Two blocks do not run their suite through `npm run` — they have already
  # mutated the test database, and the npm script starts with `db:reset`, which
  # would wash the mutation away. Their `$` line therefore did not start with
  # `npm run`, the parser skipped it, and the ids underneath were attributed to
  # WHATEVER SUITE THE BLOCK ABOVE HAD RUN. R19, a registrations check, was
  # filed under `db:check-migrations`. Silent inheritance across a block
  # boundary, from a parser that could not tell "no suite here" from "the same
  # suite as before" — the exact shape this file exists to catch, in the line
  # written to catch it.
  #
  # So the name is RESOLVED here, printed in a fixed position, and a command
  # whose suite cannot be resolved stops the run.
  local suite=""
  if [ "$1" = npm ] && [ "$2" = run ]; then
    suite="$3"
  else
    # Which npm script actually runs this file. Derived from package.json, not
    # from the filename: `scripts/verify-bank-csv.ts` is `db:verify-bank`, so a
    # name built by stripping the path would be wrong and would look right.
    local ts=""
    for a in "$@"; do case "$a" in scripts/*.ts) ts="$a" ;; esac; done
    if [ -n "$ts" ]; then
      suite=$(node -e '
        const s = require("./package.json").scripts, t = process.argv[1]
        const hit = Object.keys(s).filter((k) => s[k].includes(t))
        process.stdout.write(hit.length === 1 ? hit[0] : "")
      ' "$ts")
    fi
  fi
  if [ -z "$suite" ]; then
    echo "CANNOT NAME THE SUITE for: $*" >&2
    echo "      Every block must say whose checks these are, or the coverage" >&2
    echo "      count attributes them to the block above." >&2
    exit 1
  fi
  RUNS=$((RUNS + 1))
  suite_line "$suite" "$*" >> $OUT
  echo "$output" | grep -E '^FAIL' >> $OUT || true
  echo "$output" | grep -E '^=== ' >> $OUT
}

# Every mutation's target must exist, exactly once, before anything runs.
#
# Five separate refactors in this loop left a block hunting text that had moved.
# Each aborted the run — correctly — but only after the blocks before it had
# already taken ten or fifteen minutes. This asks all of them the same question
# in two seconds, so a stale mutation is a fast failure rather than a slow one.
echo "NOTE: the tree is snapshotted now and restored after every block."
echo "      Do not edit any source file until this finishes."

SUFFIX="$BACKUP/suffix.md"
rm -f "$SUFFIX"
if [ -n "$REPLACE" ]; then
  python3 - "$OUT" "$0" "$FROM" "${REPLACE#*:}" "$SUFFIX" <<'SPLIT' || exit 1
import re, sys
path, script, start, count, suffix = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
source = open(script, encoding='utf-8').read()
titles = [re.sub(r'\\(.)', r'\1', m.group(1)) for m in
          re.finditer(r'^section "((?:\\.|[^"\\])*)"', source, flags=re.M)]
evidence = open(path, encoding='utf-8').read()
tail = re.search(r'^## Not covered here$', evidence, flags=re.M)
body = evidence[:tail.start()] if tail else evidence
heads = list(re.finditer(r'^## (.*)$', body, flags=re.M))
actual = [m.group(1).strip() for m in heads]
if (len(actual) != len(titles) or actual[:start - 1] != titles[:start - 1]
        or actual[start - 1 + count:] != titles[start - 1 + count:]):
    sys.exit(f'REPLACE: evidence has {len(actual)} block(s), script has {len(titles)}; '
             'titles outside the requested range differ. Nothing changed.')
cut = heads[start - 1].start()
after = heads[start - 1 + count].start() if start - 1 + count < len(heads) else len(body)
open(suffix, 'w', encoding='utf-8').write(body[after:].strip('\n') + '\n')
open(path, 'w', encoding='utf-8').write(body[:cut].rstrip('\n') + '\n')
SPLIT
  RUNS=$(grep -cE "$SUITE_LINE" $OUT || true)
  echo "replacing $REPLACE: kept $((FROM - 1)) earlier block(s) and preserved the verified suffix"
elif [ -n "$ONLY" ]; then
  TO="$FROM"
  TITLE_N=$(grep -n '^section "' "$0" | sed -n "${FROM}p" | sed -E 's/^[0-9]+:section "//; s/" \\?$//')
  # The evidence is cut in TWO here: what comes before this block, which stays
  # where it is, and what comes after, which is set aside and appended when the
  # block has run. The trailing prose sections are not kept — the script writes
  # those fresh at the end, counts and all.
  python3 - "$OUT" "$FROM" "$SUFFIX" "$TITLE_N" <<'SPLIT' || exit 1
import re, sys
path, n, suffix, title = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
s = open(path, encoding='utf-8').read()
heads = [m.start() for m in re.finditer(r'^## ', s, flags=re.M)]
if len(heads) < n:
    sys.exit(f'ONLY: {path} holds {len(heads)} block(s); there is no block {n} to replace')
# ADDRESSED BY POSITION, SO THE POSITION HAS TO BE PROVED. Insert a section
# anywhere earlier and block N of this script is no longer block N of the
# evidence — the splice would replace a stranger and the diff would look
# reasonable (independent critic, 2026-09-12).
was = s[heads[n - 1]:].split('\n')[0][3:].strip()
if was != title:
    sys.exit(f'ONLY: block {n} of {path} is {was!r}, and block {n} of this script is '
             f'{title!r}. The two numberings have come apart; re-run the range instead.')
tail = re.search(r'^## Not covered here$', s, flags=re.M)
end = tail.start() if tail else len(s)
after = [h for h in heads if h > heads[n - 1] and h < end]
open(suffix, 'w', encoding='utf-8').write(s[after[0]:end] if after else '')
open(path, 'w', encoding='utf-8').write(s[:heads[n - 1]].rstrip('\n') + '\n')
SPLIT
  RUNS=$(grep -cE "$SUITE_LINE" $OUT || true)
  echo "only block $FROM (marker $(marker_of "$FROM")): kept $((FROM - 1)) before it and \
$(grep -cE "$SUITE_LINE" "$SUFFIX" || true) suite run(s) after it"
elif [ "$FROM" -gt 1 ]; then
  python3 - "$OUT" "$FROM" <<'RESUME' || exit 1
import re, sys
path, n = sys.argv[1], int(sys.argv[2])
s = open(path, encoding='utf-8').read()
heads = [m.start() for m in re.finditer(r'^## ', s, flags=re.M)]
if len(heads) < n - 1:
    sys.exit(f'RESUME: {path} holds {len(heads)} block(s); cannot resume from block {n}')
cut = heads[n - 1] if len(heads) >= n else len(s)
open(path, 'w', encoding='utf-8').write(s[:cut].rstrip('\n') + '\n')
RESUME
  RUNS=$(grep -cE "$SUITE_LINE" $OUT || true)
  echo "resuming from block $FROM (marker $(marker_of "$FROM")): kept $((FROM - 1)) block(s) and $RUNS suite run(s) of the previous evidence"
else
cat > $OUT <<'HEAD'
# Mutation runs

**Generated by `npm run db:mutations`. Do not edit by hand.**

Each block is the captured output of the suite named on its `$` line, with one
set of changes applied to the source and nothing else, and reverted afterwards.
Nearly every block is a single edit; three are not, because the defect they
describe cannot be written in one place. What the blocks span is listed at the bottom, counted rather than
described — the sentence that used to sit here named three subjects and had gone
four subjects out of date.

**This file does not cover every check.** It never did, and it used to say it
did. How many of the battery's checks appear here as having been made to fail is
counted in `docs/evidence/suites.md`, under "How far the mutations reach".

A mutation whose search text no longer matches aborts the run rather than
quietly testing an unmutated tree, and a suite that dies partway aborts it too —
every block ends with the summary line the suite prints for itself, so a
truncated run cannot be mistaken for a complete one. A block with a summary line
and no FAIL lines therefore means the mutation applied and turned nothing red,
which is a finding rather than a formatting problem.
HEAD
fi

# ---------------------------------------------------------------- 1
section "The accounts are written in their own transaction" \
"\`registerTax\` calls \`importAccounts\` instead of \`importAccountsCore\` — the
pre-extraction shape, two transactions, which is what the extraction was for."
edit src/lib/registrations.ts \
  "import { importAccountsCore, type NewAccount } from './accounts'" \
  "import { importAccounts, importAccountsCore, type NewAccount } from './accounts'" || exit 1
edit src/lib/registrations.ts \
  'await importAccountsCore(tx, input.entityId, rows, actor)' \
  'await importAccounts(input.entityId, rows, actor)' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 2
section "The same, on a machine under load" \
"An 800ms delay at the top of \`registerTax\` as well. This is how the check
before this one passed while testing nothing: the delay let the guard catch the
conflict before any account was written."
edit src/lib/registrations.ts \
  "import { importAccountsCore, type NewAccount } from './accounts'" \
  "import { importAccounts, importAccountsCore, type NewAccount } from './accounts'" || exit 1
edit src/lib/registrations.ts \
  'await importAccountsCore(tx, input.entityId, rows, actor)' \
  'await importAccounts(input.entityId, rows, actor)' || exit 1
edit src/lib/registrations.ts \
  "  const actor = input.actor ?? 'system'" \
  $'  await new Promise((r) => setTimeout(r, 800)) // simulate a loaded machine\n  const actor = input.actor ?? \'system\'' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 3
section "The delay alone, transaction intact" \
"The pair to the run above. A check that goes red under load whatever the code
does is noise; this one has to stay silent. The mutation is asserted present
before the run and the expected line asserted after it — green from a real
mutation and green from a mutation that failed to apply look identical."
edit src/lib/registrations.ts \
  "  const actor = input.actor ?? 'system'" \
  $'  await new Promise((r) => setTimeout(r, 800)) // simulate a loaded machine\n  const actor = input.actor ?? \'system\'' || exit 1
present src/lib/registrations.ts 'setTimeout(r, 800)'
run npm run db:verify-registrations
green 'the delay alone did not come back green'
close; restore

# ---------------------------------------------------------------- 4
section "Registration decided by the two ends of the range" \
"Only registrations covering \`from\` or \`to\` count, as the first version did.
A company registered for the whole of February disappears."
edit src/lib/tax.ts \
  "const registrations = await registrationsOverlapping(head.entity_id, 'GST_HST', from, to)" \
  $'const registrations = (await registrationsOverlapping(head.entity_id, \'GST_HST\', from, to))\n    .filter((r) => (r.registeredOn <= to && (r.ceasedOn ?? to) >= to) || (r.registeredOn <= from && (r.ceasedOn ?? from) >= from))' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 5
section "The outside-registration check runs only for registered companies" \
"Where it sat originally: inside the \`else\` branch. A company that never
registered is told it never registered, and never shown the tax it charged."
edit src/lib/tax.ts \
  '  const outside = await db.execute<TaxLineEntry>(sql`' \
  "  const outside = coverage === 'none' ? [] : await db.execute<TaxLineEntry>(sql\`" || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 6
section "The return assumes everyone is registered" \
"Coverage hardcoded. An unregistered company gets a page of zeroes reading as
\"no tax this quarter\"."
edit src/lib/tax.ts \
  "  const registrations = await registrationsOverlapping(head.entity_id, 'GST_HST', from, to)
  const coverage = coverageOf(registrations, from, to)" \
  "  const registrations = await registrationsOverlapping(head.entity_id, 'GST_HST', from, to)
  const coverage = 'all' as 'none' | 'part' | 'all'" || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 7
section "PST treated as recoverable" \
"BC, SK and MB get a \"PST Recoverable\" account — an asset that should never
carry a balance, holding a claim against a government that will not pay it."
edit src/lib/registrations.ts \
  "{ tax: 'PST', label: 'PST', recoverable: false," \
  "{ tax: 'PST', label: 'PST', recoverable: true," || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 8
section "Coverage off by one day at the end of the range" \
"Registration dates are inclusive at both ends, so a registration ending on the
last day of the period covers it. \`end >= to\` becomes \`end > to\`."
edit src/lib/registrations.ts \
  "if (end === null || end >= to) return 'all'" \
  "if (end === null || end > to) return 'all'" || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 9
section "Coverage trusts the order it is handed" \
"The defensive sort dropped. The caller that matters orders by
\`registered_on\`, so this would have waited for the second caller."
edit src/lib/registrations.ts \
  'const inOrder = [...touching].sort((a, b) => a.registeredOn < b.registeredOn ? -1 : 1)' \
  'const inOrder = touching' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 10
section "Coverage calls a range it covers none of \"part\"" \
"The filter for registrations that touch the range at all, removed. A list
holding only other years' registrations answers \"registered for some of this
quarter\" about a quarter it covered not one day of."
edit src/lib/registrations.ts \
  $'  const touching = registrations.filter(\n    (r) => r.registeredOn <= to && (r.ceasedOn === null || r.ceasedOn >= from))' \
  '  const touching = registrations' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 11
section "Ending a registration can run into the next one" \
"\`ceaseTax\`'s overlap guard removed, leaving the EXCLUDE constraint to refuse
it as a \`RACE\` the guard should have caught first."
edit src/lib/registrations.ts \
  '  if (next && ceasedOn >= next.registered_on) {' \
  '  if (false && next && ceasedOn >= next.registered_on) {' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 12
section "Correcting an end date does nothing" \
"\`ceaseTax\`'s UPDATE becomes a no-op on a registration that already has an end
date. Re-ceasing is allowed precisely so a mistyped date can be corrected, and
the first version of that check re-ceased to the date the row already held — so
this mutation left all 38 green."
edit src/lib/registrations.ts \
  'SET ceased_on = ${ceasedOn}::date, ceased_by = ${actor}' \
  'SET ceased_on = COALESCE(ceased_on, ${ceasedOn}::date), ceased_by = ${actor}' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 13
section "db:migrate imports the module that swaps in the test database" \
"The original defect: the migrator silently targets the test database and
reports success. Checked by \`npm run db:check-migrations\`."
edit scripts/migrate.ts "import './dotenv'" "import './env'" || exit 1
run npm run db:check-migrations
close; restore

# ---------------------------------------------------------------- 14
section "0015 reverted — one role read as one tax" \
"\`qst_pst_payable\` LIKE 'qst%' is always true, so a BC company's PST looks for
a QST registration that cannot exist. Applied to the test database rather than
to the migration file, which is append-only."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION check_tax_outside_registration(p_ledger_id uuid)
RETURNS TABLE (entry_no text, entry_date date, description text, tax text, amount bigint) AS $$
  SELECT je.entry_no, je.entry_date, je.description,
         CASE WHEN ar.role LIKE 'gst%' THEN 'GST_HST' ELSE 'QST/PST' END,
         SUM(jl.amount)::bigint
    FROM journal_entry je JOIN journal_line jl ON jl.entry_id = je.id
    JOIN account a ON a.id = jl.account_id JOIN account_role ar ON ar.account_id = a.id
    JOIN ledger l ON l.id = je.ledger_id
   WHERE je.ledger_id = p_ledger_id AND je.status IN ('posted','reversed')
     AND ar.role IN ('gst_hst_payable','gst_hst_recoverable','qst_pst_payable','qst_pst_recoverable')
     AND NOT EXISTS (SELECT 1 FROM entity_tax_registration r
        WHERE r.entity_id = l.entity_id
          AND r.tax = CASE WHEN ar.role LIKE 'gst%' THEN 'GST_HST'
                           WHEN ar.role LIKE 'qst%' THEN 'QST' ELSE 'PST' END
          AND je.entry_date >= r.registered_on
          AND (r.ceased_on IS NULL OR je.entry_date <= r.ceased_on))
   GROUP BY je.entry_no, je.entry_date, je.description, ar.role
  HAVING SUM(jl.amount) <> 0 ORDER BY je.entry_date;
$$ LANGUAGE sql STABLE;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-registrations.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 15
section "A form handler hardcodes who did it" \
"One of the two tax handlers stops passing the actor it was given and writes a
literal instead. Everything still works and the audit log is still populated —
with a string that is the same for everybody, which is the state 0053 exists to
end. This block used to assert the OPPOSITE: before 0053 the handlers were
required to pass the named constant WEB_ACTOR, because the audit could record
only which surface a change came through. R40 now requires the person."
edit src/lib/tax-forms.ts \
  "String(formData.get(F.ceasedOn) ?? ''), actor)" \
  "String(formData.get(F.ceasedOn) ?? ''), 'web')" || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 16
section "The audit records something that is not a person" \
"What goes into the audit log's actor column stops being the signed-in
person's email and
becomes a constant. The row still has an actor and still looks populated, and
it has stopped telling two people apart -- which is the whole of what 0053
buys, and what 0016 bought before it at the level of telling the browser from
a script.

This block used to mutate WEB_ACTOR to the Postgres role, back when the audit
could only record which SURFACE a change came through. That constant is retired
and nothing writes it, so the old mutation changed nothing observable and
db:toothless caught the block turning nothing red -- which is what that check
is for."
edit src/lib/users.ts \
  "export const actorOf = (user: Pick<UserRecord, 'email'>): string => user.email" \
  "export const actorOf = (_user: Pick<UserRecord, 'email'>): string => 'alicio'" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 17
section "The form spells its own field name" \
"\`name={F.ceasedOn}\` becomes a literal that no longer matches what the
handler reads. This broke every cease from the browser with all 41 checks and
\`tsc\` green, because nothing rendered the page or submitted the form."
edit "src/app/ledger/[ledgerId]/tax/registration/TaxFormFields.tsx" \
  'name={F.ceasedOn} required' \
  'name="endedOn" required' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 18
section "The handler reads a field the form does not post" \
"The other direction: the form is unchanged and the handler asks for a name
nobody sends. The cease silently becomes a BAD_DATE refusal."
edit src/lib/tax-forms.ts \
  "String(formData.get(F.ceasedOn) ?? '')" \
  "String(formData.get('endedOn') ?? '')" || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 19
section "Today is the UTC day again" \
"\`localToday\` goes back to \`toISOString().slice(0, 10)\`. On this machine
that is tomorrow's date from 17:00 every evening, so a registration ended
effective today reads as already ended — and a check written against
\`new Date()\` would have passed all morning."
edit src/lib/today.ts \
  "return at.toLocaleDateString('en-CA')" \
  'return at.toISOString().slice(0, 10)' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 20
section "The day is formatted for a different country" \
"\`en-CA\` becomes \`en-US\`, so today is \`8/22/2026\`. It is still not the
UTC day, so a check that only asks \"local, not UTC\" is satisfied — while
every date comparison against it silently fails and every default date is
refused."
edit src/lib/today.ts "at.toLocaleDateString('en-CA')" "at.toLocaleDateString('en-US')" || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 21
section "A page asks the UTC day what today is" \
"The new-entry date default goes back to \`new Date().toISOString()\`. This is
where the bug actually shipped — not in the helper, but in a caller that never
used it — and it sat in a feature built weeks earlier until critic found it."
edit "src/app/ledger/[ledgerId]/entries/new/NewEntryBody.tsx" \
  '  const today = localToday()' \
  '  const today = new Date().toISOString().slice(0, 10)' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 22
section "The form spells a field name in braces" \
"\`name={F.ceasedOn}\` becomes \`name={'ceasedOn'}\`. A literal, but not a
double-quoted one — which the first version of this check tested for and this
would have slipped past."
edit "src/app/ledger/[ledgerId]/tax/registration/TaxFormFields.tsx" \
  'name={F.ceasedOn} required' \
  "name={'ceasedOn'} required" || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 23
section "The handler reads only the first row" \
"\`accountRowsFrom\` matches \`code0\`/\`name0\` alone. Every account after
the first silently keeps its proposed code and name however the form was filled
in.

This block was written as \`([01])\` and came back EMPTY once the row checks
were rewritten for index alignment — R46 posts index 1, which \`[01]\` still
matches. Recorded here because an empty block is the finding the header
promises: the mutation had stopped discriminating and only running it said so."
edit src/lib/forms.ts \
  '/^(code|name|role)(\d+)$/' \
  '/^(code|name|role)([0])$/' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 24
section "0016 reverted — the audit names the database role" \
"\`log_tax_registration()\` records a bare \`current_user\` when a registration
ends, instead of \`COALESCE(NEW.ceased_by, current_user)\`. On this machine the
Postgres role and the owner's name are both \`alicio\`, so the check that names
who ended a registration passed with this whole fix reverted until it was made
to compare the two."
# Reset first: this block runs the suite directly rather than through
# `npm run db:verify-registrations`, so nothing else clears what the previous
# block left behind. Without it the fixtures collide on their company codes and
# the suite dies before reaching the checks this block is about.
blk npm run db:reset >/dev/null 2>&1
blk psql -v ON_ERROR_STOP=1 -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
DO $mutation$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('log_tax_registration()'::regprocedure);
  IF strpos(definition, 'COALESCE(NEW.ceased_by, current_user)') = 0 THEN
    RAISE EXCEPTION 'Missing current audit actor anchor';
  END IF;
  EXECUTE replace(definition, 'COALESCE(NEW.ceased_by, current_user)', 'current_user');
END;
$mutation$;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-registrations.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 25
section "The code box posts under the name field" \
"One token in \`AccountRow\`: \`name={F[f.key](index)}\` becomes
\`name={F.name(index)}\`. Both boxes then post as \`name<i>\`, no code arrives,
and \`registerTax\` falls back to its proposed defaults — so the accounts are
created with the owner's names and the system's codes, and it reports success."
edit "src/app/ledger/[ledgerId]/tax/registration/AccountRow.tsx" \
  'name={F[f.key](index)}' \
  'name={F.name(index)}' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 26
section "A box starts with the other field's value" \
"The other direction: the name a box posts under and the value it starts with
come from the same word, so binding one of them to the wrong field has to be
caught too."
edit "src/app/ledger/[ledgerId]/tax/registration/AccountRow.tsx" \
  'defaultValue={row[f.key]}' \
  'defaultValue={row.name}' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 27
section "Account rows are compacted instead of kept in place" \
"\`accountRowsFrom\` drops the holes. A form posting only the second row then
puts that row's code and name on the FIRST account — the recoverable code onto
the payable — and reports success."
edit src/lib/forms.ts \
  '  return rows' \
  '  return rows.filter((r) => r !== undefined)' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 28
section "A parameter defaulted to now is read through UTC" \
"\`filingPeriods\` goes back to \`getUTCFullYear()\`. On the evening of
31 December it lists the quarters of a year that has not started, without the
one being filed. The first version of this check scanned for a single idiom and
would not have seen it."
edit src/lib/tax.ts 'const year = partsOf(today).year' 'const year = today.getUTCFullYear()' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 29
section "The calendar parts come from the UTC clock" \
"\`partsOf\` reverts to \`getUTCFullYear\`/\`getUTCMonth\`/\`getUTCDate\`,
putting \`filingPeriods\` and \`currentYearEnd\` back on the UTC clock. This
helper had no check of its own: R47 looks for the current moment being read
through UTC, and \`partsOf\` takes its instant as an argument, so neither of
its shapes matched. Reverting it left every suite green."
edit src/lib/today.ts \
  'return { year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate() }' \
  'return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }' || exit 1
run npm run db:verify-registrations
run npm run db:verify-tax
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 30
section "The row list numbers its rows from one" \
"\`index={i}\` becomes \`index={i + 1}\` in \`AccountRows\`. Every row is
posted against the NEXT account: the payable code and name land on the
recoverable, the payable is created from the system default, and the success
message names the swapped pair as if it were right. One character.

This block first came back EMPTY: \`edit\` replaced the first occurrence of
\`index={i}\`, which is in the doc comment above the JSX explaining this very
defect. It changed a sentence, left the code untouched, and recorded green.
\`edit\` now refuses a search string that appears more than once."
edit "src/app/ledger/[ledgerId]/tax/registration/AccountRows.tsx" \
  'row={row} index={i} tax={tax}' 'row={row} index={i + 1} tax={tax}' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 31
section "The account rows are left out of the form" \
"\`<AccountRows/>\` is removed from inside \`<form>\`. No \`code<i>\` or
\`name<i>\` reaches the submission, \`accountRowsFrom\` returns nothing, and
\`registerTax\` falls back to its proposal for every field — so both accounts
are created from the system defaults and the owner is told \"Registered.
Created …\".

The critic's version of this moved the line outside the \`</form>\` rather than
deleting it; the submitted fields, and so the outcome, are the same."
edit "src/app/ledger/[ledgerId]/tax/registration/TaxFormFields.tsx" \
  '      <AccountRows proposed={proposed} tax={tax} />
' \
  '' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 32
section "The proposal is reversed on the way into the list" \
"\`proposed={[...proposed].reverse()}\` inside the component R48 renders. R48
asserts each row posts at its own position, so it sees this — the account rows
appear in the wrong order on the page, which is cosmetic in itself but is also
what a genuine mix-up would look like."
edit "src/app/ledger/[ledgerId]/tax/registration/TaxFormFields.tsx" \
  '<AccountRows proposed={proposed} tax={tax} />' \
  '<AccountRows proposed={[...proposed].reverse()} tax={tax} />' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 32b
section "openProposals reverses the rows it pairs — harmless, and that is the point" \
"The same \`.reverse()\`, inside the function that pairs each tax with its
accounts. For five rounds this exact mutation, at five different
hops, silently put the owner's payable code on their recoverable account.

Every row now carries its role and the handler matches on that, so the rows
arrive at the right accounts however they were ordered on the way — the two
boxes simply appear in the other order on screen. This block asserts GREEN, and
asserts it positively: green from a real mutation and green from a mutation that
failed to apply look identical.

The block above is the pair. Reordering inside the rendered markup IS caught,
because R48 and R57-R59 render it and assert each row's position; reordering
before it reaches the markup is not caught and no longer needs to be.

(Titled for \`openProposals\`, which is what it mutates. An earlier version of
this block was named after a page-level hop it never touched — the same
misattribution critic raised twice.)"
edit src/lib/registrations.ts \
  'rows: await proposedAccounts(entityId, t.tax),' \
  'rows: (await proposedAccounts(entityId, t.tax)).reverse(),' || exit 1
present src/lib/registrations.ts '.reverse(),'
run npm run db:verify-registrations
green 'the page hop is no longer harmless'
close; restore

# ---------------------------------------------------------------- 33
section "A hidden input is dropped" \
"The \`entityId\` field is removed. Nothing covered the hidden inputs until the
whole form was rendered — they carry which company is registering, and the
handler reads one the form no longer sends."
edit "src/app/ledger/[ledgerId]/tax/registration/TaxFormFields.tsx" \
  '      <input type="hidden" name={F.entityId} value={entityId} />
' \
  '' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 34
section "The role stops travelling with the row" \
"The hidden \`role<i>\` input is removed, so the handler has nothing to match
on and falls back to position — which is what made the previous five rounds of
reordering defects possible. With the proposal reversed, the owner's payable
code lands on their recoverable account."
edit "src/app/ledger/[ledgerId]/tax/registration/AccountRow.tsx" \
  '      <input type="hidden" name={F.role(index)} value={row.role} />
' \
  '' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 35
section "registrationView stops asking whether a registration is live" \
"Its filter drops \`.active\`, so a company that has ever
ceased a registration can never register again: the form disappears and the page
announces it is registered for every tax that applies."
edit src/lib/registrations.ts \
  '!existing.some((r) => r.tax === t.tax && r.active)' \
  '!existing.some((r) => r.tax === t.tax)' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 36
section "registrationView starts every cease form on today" \
"\`defaultDate\` becomes \`today\` for every registration. One that has not
started yet is handed a date its own guard refuses, and one with a recorded end
date silently rewrites it on save."
edit src/lib/registrations.ts \
  'defaultDate: r.ceasedOn ?? (r.registeredOn > today ? r.registeredOn : today),' \
  'defaultDate: today,' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 38
section "The page substitutes its own date at the call site" \
"\`row={{ ...row, defaultDate: today }}\` where the page hands the decided row
to the cease form.

This is where critic found the defect, and the previous round recorded it as
caught after moving it into \`registrationView\` — which is a different line in
a different file. The page-level form of it went on passing. Both shapes are
covered now: replacing a prop, and rebuilding the object around it."
edit "src/app/ledger/[ledgerId]/tax/registration/RegistrationSections.tsx" \
  '<CeaseInputs ledgerId={ledgerId} row={row} />' \
  '<CeaseInputs ledgerId={ledgerId} row={{ ...row, defaultDate: today }} />' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 39
section "One tax is offered another tax's accounts" \
"\`proposedAccounts(entityId, open[0].tax)\`. In BC, SK, MB or QC the second
form gets the first tax's accounts: code 2100, name \"GST Payable\", role
\`gst_hst_payable\` — while the form still posts \`tax=PST\`.

This was recorded as a GREEN block in the previous round, on the reasoning that
\`registerTax\` refuses the mismatch so nothing wrong is created. Critic was
right that this is not survival: every submission of the provincial form is
refused, so provincial registration becomes impossible and \"Reload the page and
try again\" loops forever. The pairing now has a check of its own."
edit src/lib/registrations.ts \
  'rows: await proposedAccounts(entityId, t.tax),' \
  'rows: await proposedAccounts(entityId, open[0].tax),' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 40
section "Every cease form ends the first registration" \
"\`row={view.rows[0]}\` — one identifier, no object rebuilt, every type
agreeing. Pressing the button under the PST card ends the GST registration.

This is the shape no check over the source can reach, and it passed 56 checks.
The page's body is rendered now, so what each form would submit is read back
instead of inferred."
edit "src/app/ledger/[ledgerId]/tax/registration/RegistrationSections.tsx" \
  '<CeaseInputs ledgerId={ledgerId} row={row} />' \
  '<CeaseInputs ledgerId={ledgerId} row={view.rows[0]} />' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 41
section "Every register form registers the first tax" \
"\`proposal={proposals[0]}\`. The same substitution on the register side: the
section headed \"Register for PST\" posts \`tax=GST_HST\` with the GST
accounts, so provincial registration is unreachable."
edit "src/app/ledger/[ledgerId]/tax/registration/RegistrationSections.tsx" \
  'proposal={proposal} today={today} />' \
  'proposal={proposals[0]} today={today} />' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 42
section "A cease button is labelled from the wrong row" \
"The submit label takes its tax from \`view.rows[0]\` instead of its own row,
so two live registrations both read \"End the GST/HST registration\" and the
owner cannot tell which button ends which."
edit "src/app/ledger/[ledgerId]/tax/registration/RegistrationSections.tsx" \
  'End the ${TAX_LABEL[row.registration.tax]} registration' \
  'End the ${TAX_LABEL[view.rows[0].registration.tax]} registration' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 43
section "A handler body goes missing from the field scan" \
"\`ceaseTaxFromForm\` becomes an unexported function re-exported by const, so
the check's body-slicing finds nothing for it. The per-side minimum it replaced
let this pass: the cease side needs only one read, and the action supplies it."
edit src/lib/tax-forms.ts \
  'export async function ceaseTaxFromForm(formData: FormData, actor: string)' \
  'export const ceaseTaxFromForm = (f: FormData, a: string) => runCeaseTaxFromForm(f, a)
async function runCeaseTaxFromForm(formData: FormData, actor: string)' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 44
section "The two forms are bound to each other's actions" \
"\`registerAction={ceaseTaxAction} ceaseAction={registerTaxAction}\` — one
identifier each. The handlers read disjoint sets of fields, so every button on
the page submits nothing its handler reads and both registering and ceasing
become impossible. Sixty checks passed."
edit "src/app/ledger/[ledgerId]/tax/registration/page.tsx" \
  'registerAction={registerTaxAction} ceaseAction={ceaseTaxAction}' \
  'registerAction={ceaseTaxAction} ceaseAction={registerTaxAction}' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 45
section "The page renders no body at all" \
"The element renamed, so the page renders nothing. Every form disappears and
sixty checks stayed green, because the checks rendered that component directly
and nothing rendered the page.

The first version of this block came back EMPTY: the check tested
\`includes('<RegistrationSections')\` and the mutation renamed the element to
\`<RegistrationSectionsREMOVED\`, which contains it. A check matching more
loosely than the thing it checks — the subject of this whole loop, found once
more in the check written to end it."
edit "src/app/ledger/[ledgerId]/tax/registration/page.tsx" \
  '      <RegistrationSections
' \
  '      <RegistrationSectionsGONE
' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 46
section "A reused account is offered for editing anyway" \
"The branch that shows an existing account as text is disabled, so the form
offers an editable code and name for an account \`registerTax\` will reuse —
and everything typed there is discarded without a word."
edit "src/app/ledger/[ledgerId]/tax/registration/AccountRow.tsx" \
  '  if (row.existing) {' '  if (false) {' || exit 1
run npm run db:verify-registrations
close; restore


# ================================================================== bank file
#
# Nothing below writes to a database. The reader is a set of pure functions over
# text, so its mutations are fast — and its worst failure is the quietest one in
# the system: a file read under the wrong date format produces rows that look
# entirely correct and sit in the wrong month.

# ---------------------------------------------------------------- 47
section "Quoted cells are split like plain text" \
"The branch that keeps a quoted cell together never runs, so the reader becomes
a plain line splitter. A description of \"PAYMENT, THANK
YOU\" then becomes two columns and every column after it shifts by one."
edit src/lib/csv.ts \
  '    if (quoted) {' \
  '    if (false) {' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 48
section "An ambiguous date column is resolved by picking" \
"\`inferDateOrder\` returns the first order that still fits instead of reporting
that several do. This is the defect the whole date layer exists to prevent:
03/04/2024 becomes 4 March, silently, and the row files in the wrong quarter."
edit src/lib/dates.ts \
  '  if (live.length === 1) {' \
  '  if (live.length >= 1) {' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 49
section "The day is bounded at 31 rather than by the month" \
"31 February and 29 February 2023 both become real dates. JavaScript's own Date
would roll them forward to 3 March and 1 March, which is why the check is
written out by hand — and why it has to be shown failing."
edit src/lib/dates.ts \
  '  if (d > daysInMonth(y, m)) return null' \
  '  if (d > 31) return null' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 50
section "Reading rows with no date format chosen" \
"The guard at the top of \`applyMapping\` tests for undefined instead of null, so
a null order slips past it into \`parseDateWith\`, whose last branch is month
first. An unanswered question becomes an American answer."
edit src/lib/bank-csv.ts \
  'if (mapping.order === null) {
    throw new BankCsvError(' \
  'if (mapping.order === undefined) {
    throw new BankCsvError(' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 51
section "A blocked mapping produces rows anyway, defaulting the format" \
"\`screenFor\` stops returning null when something is blocking and instead reads
the file with month first.

What fails here is the library handing rows to a screen that should have had
none. A person would see the same page either way, because \`ImportPreview\`
returns on the first error before rendering a row — an earlier version of this
block claimed the screen fills with a tidy table of rows, and it does not.
Two independent guards; this shows the first one gone."
edit src/lib/bank-csv.ts \
  '    return { problems, applied: null }' \
  "    return { problems, applied: applyMapping(grid, headerRow, { ...mapping, order: mapping.order ?? 'mdy' }) }" || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 52
section "The screen is handed no problems to show" \
"\`ImportScreen\` passes an empty list to the preview. Everything underneath
still works and still refuses to produce rows — but the person looking at the
screen is told nothing about why it is empty."
edit "src/app/ledger/[ledgerId]/bank/import/ImportScreen.tsx" \
  '      <ImportPreview currency={currency} problems={screen.problems} applied={screen.applied} />' \
  '      <ImportPreview currency={currency} problems={[]} applied={screen.applied} />' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 53
section "Two rejections are given the same sentence" \
"The message for two Money in columns is changed to say Money out, so it is now
word for word the message for two Money out columns. Every check that a
particular rejection fires still passes — only the one asking whether they are
distinguishable can see it. This is the defect shape this repository keeps
finding, written out on purpose."
edit src/lib/bank-csv.ts \
  'are both marked Money in. Only one column can be.' \
  'are both marked Money out. Only one column can be.' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 54
section "A signed column beside a Money out column is allowed" \
"The guard against mapping both shapes at once never fires, so a file with an
Amount column and a Withdrawals column counts every withdrawal twice."
edit src/lib/bank-csv.ts \
  '  if (amounts.length > 0 && (outs.length > 0 || ins.length > 0)) {' \
  '  if (amounts.length > 99 && (outs.length > 0 || ins.length > 0)) {' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 55
section "A headerless file loses its first transaction" \
"\`findHeaderRow\` returns 0 rather than null when the first row is already data,
so the first transaction in an RBC export is read as the column names and never
appears again."
edit src/lib/bank-csv.ts \
  '  if (firstData === 0) return null    // the first full row is already data: headerless' \
  '  if (firstData === 0) return 0       // the first full row is already data: headerless' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 56
section "Every file is assumed to be comma separated" \
"The delimiter sniffer never accepts a better candidate, so a tab or semicolon
export parses as one wide column per row."
edit src/lib/bank-csv.ts \
  '    if (score > bestScore) { bestScore = score; best = d }' \
  '    if (score < bestScore) { bestScore = score; best = d }' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 57
section "Accounting brackets are read as positive" \
"(1,234.56) becomes a deposit of 1,234.56 rather than a withdrawal. The sign is
the whole meaning of the row."
edit src/lib/bank-csv.ts \
  '  if (bracketed) { negative = true; text = bracketed[1].trim() }' \
  '  if (bracketed) { negative = false; text = bracketed[1].trim() }' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 58
section "The description is guessed as the first text column" \
"Instead of the column whose values vary, which in a headerless export means
the account type — \"Chequing\" on every row, describing nothing."
edit src/lib/bank-csv.ts \
  '.sort((a, b) => b.distinct - a.distinct)' \
  '.sort((a, b) => a.index - b.index)' || exit 1
run npm run db:verify-bank
close; restore


# ---------------------------------------------------------------- 59
section "The software chooses the date format after all" \
"\`guessMapping\` fills the format in whenever exactly one reading fits the
first 200 rows — which is what it used to do, and what it was changed to stop
doing. The screen then goes straight to a table of rows without ever asking,
and a file whose later rows read the other way is silently American."
edit src/lib/bank-csv.ts \
  '  return { roles, order: null, flip: false }' \
  '  const dc = profiles.find((p) => roles[p.index] === "date"); const v = dc?.dates; return { roles, order: v?.kind === "certain" ? v.order : null, flip: false }' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 60
section "A running balance is offered as the amount" \
"The exclusion that keeps a Balance column out of the amount guess is removed.
In a file whose amount column is not called \"Amount\", the balance is then a
second candidate of the same shape — and the guess either takes it or gives up."
edit src/lib/bank-csv.ts \
  ' && !IS_BALANCE.test(p.header))' \
  ')' || exit 1
run npm run db:verify-bank
close; restore


# ---------------------------------------------------------------- 61
section "The date format is decided from a sample of the column" \
"\`profileColumns\` keeps the cheap probe's verdict instead of scanning the whole
column. A file whose first 200 rows are unambiguously day-first and whose 201st
can only be month-first is then called decided, and the disagreement never
surfaces as a conflict.

This was the shipped behaviour until a critic built the file and ran it."
edit src/lib/bank-csv.ts \
  ': inferDateOrder(filledValues)' \
  ': probe' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 62
section "The chosen date format survives moving the date column" \
"\`withRole\` keeps the order when the date role moves to a different column. The
answer was about the old column; the new one is then read under a format nobody
chose for it, and when it happens to accept that format nothing complains at
all — the rows just come out in the wrong months.

Only visible in a sequence of two actions, which is why the screen check drives
the real handler rather than rendering a single state."
edit src/lib/bank-csv.ts \
  '  const moved = dateColumns(roles) !== dateColumns(mapping.roles)' \
  '  const moved = false' || exit 1
run npm run db:verify-bank
close; restore

# ---------------------------------------------------------------- 63
section "A cell with no digits is read as zero" \
"The guard in \`parseBankAmount\` never fires, so a lone currency sign, a lone
minus or an empty pair of brackets strips down to an empty string, which
\`parseMoney\` reads as zero. The row lands in the middle of the statement as a
0.00 transaction the bank never made, with nothing reported against it."
edit src/lib/bank-csv.ts \
  '  if (!/\d/.test(text)) {' \
  '  if (false) {' || exit 1
run npm run db:verify-bank
close; restore


# ============================================================ bank rows landing
#
# These reset the test database, because five of them break a guard that lives
# in the migration rather than in TypeScript. A trigger disabled in the file is
# a trigger that is not there after the reset — which is the point: the rule is
# in the schema, so that is where it has to be shown missing.

# ---------------------------------------------------------------- 64
section "Rows are numbered by their position in the file" \
"Occurrence becomes the row index, so the same transaction is 1 in one import
and 2 in the next.

Note what the output below actually says: the run ends on \`OCCURRENCE_GAP\`.
The database refuses this import, because three distinct rows numbered 1, 2, 3
leave 2 and 3 with nothing under them in their own groups. An earlier version of
this block claimed the database catches none of it, directly above the line
showing it catching this — the same shape as 0017's original claim that it
catches all of it. I52, I52b, I52c and I52d hold the halves and the boundary
between them."
edit src/lib/bank.ts \
  '  return rows.map((r) => {' \
  '  return rows.map((r, i) => {' || exit 1
edit src/lib/bank.ts \
  '    const n = (seen.get(key(r)) ?? 0) + 1' \
  '    const n = i + 1' || exit 1
run npm run db:verify-bank-import
close; restore

# ---------------------------------------------------------------- 65
section "The import reports what it sent rather than what landed" \
"\`inserted\` counts the rows in the batch instead of the rows the database came
back with, so every import claims to have saved everything and nothing is ever
reported as a duplicate. The rows are still deduplicated correctly — only the
sentence on screen is a lie, which is the harder kind to notice."
edit src/lib/bank.ts \
  '      inserted += landed.length' \
  '      inserted += batch.length' || exit 1
run npm run db:verify-bank-import
close; restore

# ---------------------------------------------------------------- 66
section "Occurrence numbers may have gaps" \
"The deferred check never fires, so a row numbered 2 can exist with no 1 before
it — and a hole is what lets a LATER correct import land a duplicate, because
the number it computes is 1 and 1 is free.

The unique constraint is untouched and stays untouched: further down this same
run it refuses the very next insert, which is what ends the suite early here.
The two guards are independent, and an earlier version of this block claimed
disabling one made the other decorative. Its own output said otherwise.

Mutated in 0018, not 0017. Both files contain this function and the search text
is unique in each, so the pre-flight audit is satisfied either way — but 0018
runs later and its \`CREATE OR REPLACE\` puts the correct version back. Pointed
at 0017 this block turned nothing red, which is how it was noticed."
edit db/migrations/0018_gapless_reason.sql \
  '  IF NEW.occurrence > 1 AND NOT EXISTS (' \
  '  IF false AND NOT EXISTS (' || exit 1
run npm run db:verify-bank-import
close; restore

# ---------------------------------------------------------------- 67
section "What the bank said can be edited" \
"The immutability trigger is given a WHEN that never holds. The amount, the date
and the description on a landed row become editable — and editing an amount also
moves the row out from under the deduplication, so the file it came from imports
cleanly all over again."
edit db/migrations/0017_bank_transaction.sql \
  '  FOR EACH ROW EXECUTE FUNCTION check_bank_row_immutable();' \
  '  FOR EACH ROW WHEN (1 = 0) EXECUTE FUNCTION check_bank_row_immutable();' || exit 1
run npm run db:verify-bank-import
close; restore

# ---------------------------------------------------------------- 68
section "A matched row can be deleted" \
"The delete guard never runs. Deleting a row that has been reconciled throws
away the only record that it was, and the next import of the same statement
brings it back looking new."
edit db/migrations/0017_bank_transaction.sql \
  '  FOR EACH ROW EXECUTE FUNCTION check_bank_row_delete();' \
  '  FOR EACH ROW WHEN (1 = 0) EXECUTE FUNCTION check_bank_row_delete();' || exit 1
run npm run db:verify-bank-import
close; restore

# ---------------------------------------------------------------- 69
section "A statement can land in a heading account" \
"The account check never runs, so rows can be attached to a rollup account that
nothing can be posted to, or to one that has been deactivated."
edit db/migrations/0017_bank_transaction.sql \
  '  FOR EACH ROW EXECUTE FUNCTION check_bank_account();' \
  '  FOR EACH ROW WHEN (1 = 0) EXECUTE FUNCTION check_bank_account();' || exit 1
run npm run db:verify-bank-import
close; restore

# ---------------------------------------------------------------- 70
section "Dollars are accepted where cents are expected" \
"The wire format stops checking that an amount is whole cents. \"12.50\" then
reaches \`BigInt()\`, which throws somewhere with no context — and had it not
thrown, a hundredth of every amount would have landed in the books."
edit src/lib/bank-wire.ts \
  '!CENTS.test(r.a)' \
  'false' || exit 1
run npm run db:verify-bank-import
close; restore

# ---------------------------------------------------------------- 71
section "A database guard reaches the screen as a stack trace" \
"\`deepMessage\` stops walking the error's \`cause\` — it reads the top message
instead of \`causesOf\`. Drizzle wraps every driver error as \"Failed query\", so
none of the named guards below it ever match again and the raw wrapper is what
a person sees. Every guard is still there and still firing; only the sentence
explaining it is gone."
edit src/lib/bank-forms.ts \
  'const deepMessage = (e: unknown) => causesOf(e)' \
  'const deepMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))' || exit 1
run npm run db:verify-bank-import
close; restore


# ---------------------------------------------------------------- 72
section "A statement can be landed in another company's account" \
"The check that the chosen account belongs to the company whose ledger the form
was submitted from never runs. The dropdown only ever offers this company's
accounts — but the value posted back is a string like any other, and the row
carries no ledger, so nothing downstream would ever notice."
edit src/lib/bank-forms.ts \
  '  if (!ledgerId || !(await accountInLedger(accountId, ledgerId))) {' \
  '  if (false) {' || exit 1
run npm run db:verify-bank-import
close; restore


# ---------------------------------------------------------------- 73
section "The gapless check goes back on UPDATE" \
"0019 scoped it to INSERT. Put back on UPDATE it fires on every status change of
a row sitting above a hole — and a hole is what deleting the lower of two
identical rows leaves, which the delete guard permits on purpose.

The row is then permanently unreconcilable: it can never be marked matched or
ignored, and what the person is told is a sentence about re-reading the import
file. The UPDATE arm can never do anything useful: \`occurrence\` and every other
column this check reads are immutable, so the UPDATE cannot itself change the
answer — it can only re-punish a row for a hole that a permitted DELETE made."
edit db/migrations/0019_gapless_insert_only.sql \
  '  AFTER INSERT ON bank_transaction' \
  '  AFTER INSERT OR UPDATE ON bank_transaction' || exit 1
run npm run db:verify-bank-import
close; restore


# ============================================================== reconciling
#
# A match is a claim on two things at once — part of a bank row and part of what
# an entry did on that account — and most of what can go wrong is one of those
# two claims going unchecked.

# ---------------------------------------------------------------- 74
section "A match does not have to mean anything" \
"The sanity trigger never runs, so a bank row can be settled by a draft, by a
reversed entry, by an entry with no line on that account at all, or by one that
moved the account the other way. Every one of those reads as reconciled."
edit db/migrations/0020_bank_match.sql \
  '  FOR EACH ROW EXECUTE FUNCTION check_bank_match();' \
  '  FOR EACH ROW WHEN (1 = 0) EXECUTE FUNCTION check_bank_match();' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 75
section "A row can be claimed for more than it is" \
"The bound on a row's own matches is removed. A \$42 fee can be settled by a
\$90 entry and the row still reports itself accounted for."
edit db/migrations/0158_core_fx.sql \
  '  IF abs(matched) > abs(b.amount) THEN' \
  '  IF false THEN' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 76
section "One entry can settle every row that looks like it" \
"The bound on the OTHER side is removed — how much of an entry has already been
claimed. One \$500 payment then settles five different \$500 deposits, and all
five look reconciled. This is the half that is easy to leave out, because the
row-side bound catches nothing about it."
edit db/migrations/0158_core_fx.sql \
  '    IF abs(entry_total) > abs(on_account) THEN' \
  '    IF false THEN' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 77
section "A reconciled row can be set aside" \
"Ignoring stops checking whether the row has matches. The row then disappears
from the reconciliation — the state view answers \"ignored\" first — while its
matches go on claiming parts of entries that nothing can see any more."
edit db/migrations/0020_bank_match.sql \
  '  IF NEW.ignored_at IS NOT NULL AND OLD.ignored_at IS NULL' \
  '  IF false AND OLD.ignored_at IS NULL' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 78
section "A reconciled row can be deleted" \
"The delete guard stops looking for matches. Deleting the row leaves the entry
claimed by something that no longer exists, and the next import of the same
statement brings the row back looking new."
edit db/migrations/0020_bank_match.sql \
  '  IF EXISTS (SELECT 1 FROM bank_match m WHERE m.bank_transaction_id = OLD.id) THEN' \
  '  IF false THEN' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 79
section "Partly matched and not matched swap places" \
"The state view's first test is inverted. Rows nothing accounts for report
themselves settled and settled rows report themselves open — the state is
derived rather than stored precisely so there is one place this can be got
wrong, and this is that place."
edit db/migrations/0020_bank_match.sql \
  '         WHEN coalesce(m.matched, 0) = 0     THEN' \
  '         WHEN coalesce(m.matched, 0) <> 0    THEN' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 80
section "The reconciliation drops its timing difference" \
"\`straddling\` becomes zero. A cheque written on the 30th and cleared on the 2nd
is matched, and belongs to a different side of the line on each side — with that
term gone the three explanations no longer add up to the difference, which is
the only thing that made them explanations rather than commentary."
edit src/lib/bank.ts \
  '    straddling: matchedRows - matchedEntries,' \
  '    straddling: 0n,' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 81
section "Suggestions stop caring which way the money went" \
"\`candidateEntries\` drops the sign test, so a row that took \$750 out is offered
the entry that put \$750 in. Both are the same size and one keystroke apart."
edit src/lib/bank.ts \
  '     WHERE sign(r.on_account) = sign(b.amount)' \
  '     WHERE true' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 82
section "A match is sized by the row alone" \
"The default amount stops asking how much of the entry is left and takes the
whole remaining row. Splitting a deposit across two invoices then over-claims
the first one, and the failure arrives at COMMIT from the database rather than
as a sentence."
edit src/lib/bank.ts \
  'const smallerOf = (a: bigint, b: bigint) => (a < 0n ? (a > b ? a : b) : (a < b ? a : b))' \
  'const smallerOf = (a: bigint, b: bigint) => a' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 83
section "A database guard reaches the reconcile screen as a stack trace" \
"\`readable\` stops translating. Every named guard behind the reconcile forms —
wrong direction, entry already claimed, closed period — arrives as Drizzle's
\"Failed query\" wrapper instead of a sentence saying what to do about it."
edit src/lib/match-forms.ts \
  'function readable(e: unknown): string | null {' \
  'function readable(e: unknown): string | null { return null' || exit 1
run npm run db:verify-bank-match
close; restore


# ---------------------------------------------------------------- 84
section "A reversed entry can go on settling a bank row" \
"0021's check never runs. Reversing an entry then leaves its match in place: the
row reads accounted for, by an entry that has been unwound.

This is the failure the two amount bounds exist to prevent, reached from the
other side — and nothing in 0020 could see it, because the entry's status was
only ever checked when the match was created."
edit db/migrations/0021_reversed_holds_no_match.sql \
  '  FOR EACH ROW EXECUTE FUNCTION check_reversed_holds_no_match();' \
  '  FOR EACH ROW WHEN (1 = 0) EXECUTE FUNCTION check_reversed_holds_no_match();' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 85
section "Amending a reconciled entry becomes impossible" \
"\`amendEntry\` stops carrying the matches across.

Note what 0021 turns this into. Before it, the match stayed on the reversed
original, the replacement was claimed by nothing, and the row could not be
matched to it because it already read as full — silently wrong, and the
correction unreachable. With 0021 the amendment is simply refused: the original
would end up reversed while still settling a bank row, and that is now an
invariant. Refused is the right answer; it is not the same answer as carrying
the match, which is why the carry is still needed."
edit src/lib/posting.ts \
  '      UPDATE bank_match SET entry_id = ${posted.entry.id}::uuid WHERE entry_id = ${entryId}::uuid`)' \
  '      SELECT 1`)' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 86
section "The reconcile screen's balance stops agreeing with the ledger's" \
"\`books\` counts only posted entries, dropping a reversed entry's lines while
keeping the reversal's mirror — wrong by twice the reversed amount. Every other
balance in the system counts both. The screen then prints a figure that
disagrees with the same account's own history page."
edit src/lib/bank.ts \
  '                   AND ${IN_THE_BOOKS}  -- the balance' \
  "                   AND e.status = 'posted'  -- the balance" || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 87
section "The independent check of the books stops being independent" \
"The per-entry figure counts different entries from the total it is compared
against, so the two stop agreeing.

It exists because the reconciliation identity cannot fail — substitute the
definitions and the matched totals cancel, so it holds for every input including
wrong ones. This is the half that can."
edit src/lib/bank.ts \
  '           AND ${IN_THE_BOOKS}  -- the same, per entry' \
  "           AND e.status = 'posted'  -- the same, per entry" || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 88
section "Posting a remainder replays the last entry instead" \
"The idempotency key goes back to the row rather than the row and the amount, so
a row can only ever carry one generated entry. Post part of it, undo a different
match, and the next post replays the first entry, creates nothing, swallows the
conflicting match — and says the row is settled."
edit src/lib/bank.ts \
  '  const replayKey = `bank:${row.id}:${left}:${shape}`' \
  '  const replayKey = `bank:${row.id}:${shape}`' || exit 1
run npm run db:verify-bank-match
close; restore


# ================================================================ opening
#
# Where the books start. The rule that matters most is the third: a difference
# carried over from another system is ordinary, and a system that absorbs it
# without saying so leaves books that balance and nobody knowing by how much.

# ---------------------------------------------------------------- 89
section "A ledger can have two opening balances" \
"The unique index is gone. Two starting positions in one set of books, and no
answer to which one anything is measured from."
edit db/migrations/0022_opening_balance.sql \
  'CREATE UNIQUE INDEX one_opening_balance_per_ledger' \
  'CREATE INDEX one_opening_balance_per_ledger' || exit 1
run npm run db:verify-opening
close; restore

# ---------------------------------------------------------------- 90
section "The opening balance can be dated after the entries it opens" \
"The check that nothing may predate it never fires. Entries go in first, the
starting position is entered after them, and every statement over the gap is
movement measured against a position that did not exist yet."
edit db/migrations/0022_opening_balance.sql \
  '  IF earlier_no IS NOT NULL THEN' \
  '  IF false THEN' || exit 1
run npm run db:verify-opening
close; restore

# ---------------------------------------------------------------- 91
section "A conversion difference is absorbed without a word" \
"The refusal is removed, so figures that do not balance are simply posted —
whatever \`postEntry\` makes of them. The whole point of the screen is that the
difference is a number somebody is told; this is what its absence looks like."
edit src/lib/opening.ts \
  '  if (difference !== 0n && !input.balancingAccountId) {' \
  '  if (false) {' || exit 1
run npm run db:verify-opening
close; restore

# ---------------------------------------------------------------- 92
section "The difference goes in the wrong way round" \
"The balancing line takes the sign of the difference rather than its opposite,
so it doubles the gap instead of closing it. Caught by the ledger rather than by
this module, which is the arrangement working."
edit src/lib/opening.ts \
  '    : [{ accountId: input.balancingAccountId!, amount: -difference }]' \
  '    : [{ accountId: input.balancingAccountId!, amount: difference }]' || exit 1
run npm run db:verify-opening
close; restore

# ---------------------------------------------------------------- 93
section "Opening figures are read by position instead of by account" \
"\`linesFrom\` numbers the fields it finds rather than reading which account each
one names. Re-render the page in a different order and every balance lands
against the wrong account — the same defect the sales tax round spent six rounds
on, in the one place where getting it wrong is least recoverable."
edit src/lib/opening-forms.ts \
  '    const accountId = accountOf(field)' \
  '    const accountId = accountOf(field) === null ? null : lines.length.toString()' || exit 1
run npm run db:verify-opening
close; restore


# ---------------------------------------------------------------- 94
section "Correcting an entry forgets where it came from" \
"The replacement no longer inherits the original's \`source_type\`, so amending
anything makes it 'manual'.

For an opening balance that frees the one-per-ledger slot: the books can be
entered a second time, and the surviving copy stops anchoring the rule that
nothing may be dated before it. It is not specific to opening balances — a
bank-generated entry loses the row it came from the same way."
edit src/lib/posting.ts \
  '      sourceType: original.sourceType as SourceType,' \
  '      sourceType: undefined,' || exit 1
run npm run db:verify-opening
close; restore

# ---------------------------------------------------------------- 95
section "The conversion difference is folded into a figure that was given" \
"The balancing account may be one the user typed a balance against, so the
difference disappears into it. The entry balances, the books balance, and the
figure recorded is not the figure entered — and it looks exactly like the honest
version afterwards."
edit src/lib/opening.ts \
  '  if (difference !== 0n && input.balancingAccountId' \
  '  if (false && input.balancingAccountId' || exit 1
run npm run db:verify-opening
close; restore

# ---------------------------------------------------------------- 96
section "The opening balance is offered as the entry that settles a deposit" \
"\`candidateEntries\` stops excluding it. An opening cash balance of 12,500 is
then offered against any deposit up to 12,500 — and the row reads reconciled
afterwards, against a starting position rather than against anything that moved."
edit src/lib/bank.ts \
  '                            AND NOT ${IS_OPENING}  -- not a candidate' \
  '                            AND true' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 97
section "And the database stops refusing it too" \
"\`check_bank_match\` reads the entry's status into the variable it was going to
compare against 'opening_balance', so the test can never hold. The suggestion
list is one half of that guard; this is the half a hand-written insert would
otherwise walk straight past."
edit db/migrations/0158_core_fx.sql \
  '  SELECT status, source_type INTO entry_status, entry_source' \
  '  SELECT status, status INTO entry_status, entry_source' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 98
section "Revenue and tax carried over are filed a second time" \
"The GST return stops excluding the opening balance. A conversion done mid-year
carries the tax already remitted and the revenue already reported as balances —
counted here they go on a return that says they happened this quarter."
edit src/lib/tax.ts \
  '       AND NOT ${IS_OPENING}  -- the tax lines' \
  '       AND true' || exit 1
run npm run db:verify-tax
close; restore


# ---------------------------------------------------------------- 99
section "The corrected entry keeps its kind but forgets which row" \
"\`source_type\` still says 'bank'; \`source_id\` no longer says which statement
row. Nothing about the entry looks wrong afterwards — it is still a bank entry,
still matched, still balanced — but the line back to the row it was generated
from is gone, and there is no way to tell from the entry that it ever existed.

Block 94 cannot catch this: an opening balance has no \`source_id\` to lose."
edit src/lib/posting.ts \
  '      sourceId: original.sourceId ?? undefined,' \
  '      sourceId: undefined,' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 100
section "The opening balance is left off the return without a word" \
"It is still excluded — the figures on the return do not change. What changes is
that nobody is told. Absent without a word looks exactly like not existing, and
the one person who needs to know is the one converting mid-year, who has to
confirm that the carried-over revenue and tax were reported wherever the books
were kept before."
edit src/lib/tax.ts \
  '  if (openingHere.length > 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-tax
close; restore


# ---------------------------------------------------------------- 101
section "The opening position is computed and then not shown" \
"\`reconciliation()\` still returns it and the arithmetic still closes — the
figure is right, it just stops having a line of its own on the screen and goes
back to sitting inside 'Book movement no row claims'.

Which is the state this started in: a reconciliation permanently out by the
opening cash balance, with nothing on the page saying why. M63 cannot catch it,
because M63 checks the arithmetic and the arithmetic is fine."
edit src/lib/recon-display.ts \
  "    ['Where the account started', -recon.openingPosition," \
  "    ['Book movement no row claims', -recon.openingPosition," || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 102
section "The year end leaves carried-over revenue in the P&L" \
"The closing entry stops sweeping anything that came in as an opening balance.
The two exclusions that ARE right — the GST return and the bank candidates —
make this one look right too, and it is not: revenue carried in at a mid-year
conversion has to close to retained earnings like any other revenue, or it sits
in a P&L account across a year boundary forever."
edit src/lib/posting.ts \
  "         AND fp.fiscal_year_id = \${fiscalYearId}::uuid" \
  "         AND fp.fiscal_year_id = \${fiscalYearId}::uuid
         AND je.source_type <> 'opening_balance'" || exit 1
run npm run db:verify-opening
close; restore


# ---------------------------------------------------------------- 103
section "The two halves of one explanation are not netted off" \
"The reconcile screen prints FOUR rows for THREE explanations, because it splits
'book movement no row claims' into the opening position and the rest. The split
lives in recon-display.ts and nowhere else — the screen's Summary and the PDF
report both eat from it. Stop netting the halves and the opening position is
counted twice: the column no longer adds up to the difference printed above it.

Nothing else catches this. \`M32\` and \`M63\` check the library's three-term
identity, which is a tautology; \`M65\` checks that the row's label is present.
All three stay green."
edit src/lib/recon-display.ts \
  "    ['Book movement no row claims', -(recon.booksUnclaimed - recon.openingPosition)," \
  "    ['Book movement no row claims', -recon.booksUnclaimed," || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 104
section "A period P&L reports the year so far instead of the period" \
"Detail lines read the closing balance rather than the period's own movement.
The conversion month looks unchanged — the carried-in revenue is the whole
balance at that point either way — and every month after it is overstated by
everything before it.

That is why \`O34\` alone would not be a check: it holds under this mutation.
\`O35\` is the half that can fail, and it is the reason the pair exists."
edit src/lib/statements.ts \
  "            d.value_basis === 'period_movement' ? f.period_movement : f.closing_balance)" \
  "            f.closing_balance)" || exit 1
run npm run db:verify-opening
close; restore

# ---------------------------------------------------------------- 105
section "The refusal no longer says how much the figures are out by" \
"\`OUT_OF_BALANCE\` is still raised and the entry is still refused, so nothing is
posted wrong. What goes is the only part that helps: the number. 'The figures do
not balance' sends someone back to a spreadsheet to find a difference the
software had already computed."
edit src/lib/opening.ts \
  '      `The figures are out by ${formatMoney(difference)}. Either correct them, or choose the `' \
  '      `The figures are out. Either correct them, or choose the `' || exit 1
run npm run db:verify-opening
close; restore


# ---------------------------------------------------------------- 106
section "Any party at all can be named on any company's books" \
"\`check_line_party\` returns without looking — mutated in 0045, which
re-issues the function after 0026 and therefore OWNS the body a fresh
database ends up with (a mutation left in 0026 is silently healed by 0045,
which is exactly what toothless caught on 2026-09-02). \`party_id\` becomes a free-text
tag: a receivable booked against a director who has never been a customer, or
against a supplier of a different company entirely. The entry balances, the
trial balance is unmoved, and the aging shows a debt owed by someone with no
relationship to the company."
edit db/migrations/0045_the_refusal_names_the_rule_it_enforces.sql \
  '  IF NEW.party_id IS NULL THEN RETURN NEW; END IF;' \
  '  RETURN NEW;' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 107
section "A relationship that ended still explains today's invoice" \
"The date half of the same check goes. Who someone IS is still tested, so the
obvious cases still pass — a director is still refused, another company's
customer is still refused. What stops being true is WHEN: a supplier who
stopped in March can be invoiced in June, and nothing on the entry says the
relationship had ended."
edit db/migrations/0152_party_without_start_dates.sql \
  '       AND (pr.held_to IS NULL OR pr.held_to >= p_on));' \
  '       AND true);' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 108
section "A director can be invoiced" \
"The \`transacts\` flag stops being consulted, so every role carries money.
Directors and shareholders are in this table because P4 needs them on the
corporate records — letting them onto a journal line turns the aging from a list
of debts into a list of people."
edit db/migrations/0152_party_without_start_dates.sql \
  '     WHERE pr.party_id = p_party AND pr.entity_id = p_entity AND d.transacts' \
  '     WHERE pr.party_id = p_party AND pr.entity_id = p_entity AND true' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 109
section "The reversal forgets who it was about" \
"\`reverseEntryCore\` copies every field of the line except the party. The
reversal is posted, the trial balance is right, and every statement in the
system agrees — because none of them read \`party_id\`.

What is wrong is the one thing that does: the invoice stays in that customer's
balance and the credit lands against nobody. Aging is derived from the ledger,
so there is no second table to disagree and give it away."
edit src/lib/posting.ts \
  '      partyId: l.partyId ?? undefined,' \
  '      partyId: undefined,' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 110
section "Drafting an invoice loses the customer" \
"\`saveDraft\` drops the party when it writes the lines. Post it straight away
and it is right; save it, come back, post it, and it is a receivable owed by
nobody. The two paths into the ledger have to carry the same fields, and this is
the one nobody looks at."
edit src/lib/posting.ts \
  '        dimensions: l.dimensions ?? {},
        partyId: l.partyId,
      })))' \
  '        dimensions: l.dimensions ?? {},
      })))' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 111
section "The duplicate stops being explained" \
"The check is removed from \`createParty\`. The duplicate does NOT get in — the
unique index on the normalised name still refuses it, and the captured output
below shows that: a raw query failure rather than the sentence.

That is the whole finding. What is lost is not the guard, it is the ONLY part
that helps: 'Acme Ltd. is already on the list, add the role to that one' tells
you what to do, and 'duplicate key value violates unique constraint' sends you
looking for a record you were not told exists."
edit src/lib/parties.ts \
  '       WHERE is_active AND party_name_key(name) = party_name_key(${name})`)
    if (existing) {' \
  '       WHERE is_active AND party_name_key(name) = party_name_key(${name})`)
    if (false) {' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 112
section "The deletion is refused by the wrong thing" \
"The trigger stops counting the lines. The party is still not deleted — the
foreign key from \`journal_line.party_id\` catches it — so nothing is lost from
the books, and the captured output shows the foreign key firing instead.

What goes is the sentence that says how many lines name it and what to do
instead. A foreign-key violation is a true statement about a constraint; 'Acme
Ltd. is named on 2 journal lines; deactivate it instead' is a true statement
about the books, and only one of them tells you the next move."
edit db/migrations/0025_party.sql \
  '  SELECT count(*) INTO n FROM journal_line WHERE party_id = OLD.id;' \
  '  n := 0;' || exit 1
run npm run db:verify-parties
close; restore


# ---------------------------------------------------------------- 113
section "The page falls over instead of saying what happened" \
"The add-role form reads only the top-level error message. The driver wraps what Postgres
said, so the constraint name is two levels down and the check for it finds
nothing — the error is re-thrown and the screen breaks.

Nothing is written wrong; the database refused the overlap correctly. What the
person gets is a crash instead of 'that role is already recorded here over those
dates.'"
edit src/lib/party-forms.ts \
  '    const text = causesOf(e)' \
  "    const text = e instanceof Error && e.message.includes('INSERT INTO party_role') ? e.message : causesOf(e)" || exit 1
run npm run db:verify-parties
close; restore


# ---------------------------------------------------------------- 114
section "A relationship can be ended before the invoices it explains" \
"The guard on \`party_role\` stops looking for lines the role was covering.
\`endRole\` — an ordinary exported function, not hand-written SQL — can then be
pointed at March and every invoice posted to that supplier in April is outside
its own explanation.

Nothing about the ledger changes. The entries are still there, still balanced,
still on the trial balance. What is gone is the reason any of them may name that
party, and the rule 0025 states as a property of the data becomes a property of
the moment the line was written."
edit db/migrations/0152_party_without_start_dates.sql \
  '  IF orphan_date IS NOT NULL THEN' \
  "  IF orphan_date IS NOT NULL AND TG_OP <> 'UPDATE' THEN" || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 115
section "Moving a draft's date takes it outside the relationship" \
"The re-check on \`entry_date\` returns without looking — mutated in 0045,
the file that owns the final body (see block 106). A draft written inside
a supplier's dates can be dragged to a date outside them and posted.

0010 froze a draft's \`ledger_id\` for exactly this shape and wrote down why —
a check that was true when the line was written, and stops being true when the
header moves. The party rule is a rule about a date, and the date was the one
thing left unfrozen."
edit db/migrations/0045_the_refusal_names_the_rule_it_enforces.sql \
  '  IF NEW.entry_date IS NOT DISTINCT FROM OLD.entry_date THEN RETURN NULL; END IF;' \
  '  RETURN NULL;' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 116
section "A draft line can be repointed at anyone" \
"\`trg_line_party\` goes back to INSERT only. Posted lines are immutable, so
this looks harmless — until you remember a draft's lines are editable, which is
the one path that can rewrite the column, and was the one the original guard did
not watch."
edit db/migrations/0026_party_rule_holds_afterwards.sql \
  '  AFTER INSERT OR UPDATE ON journal_line' \
  '  AFTER INSERT ON journal_line' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 117
section "Two normalisers, disagreeing about a tab" \
"The database key goes back to trimming before collapsing. Postgres \`trim()\`
strips ASCII space only, so a tab-padded name retains leading and trailing spaces.

\`P06c\` checks the actual installed key and goes red. \`P05\` does not move:
ASCII-space duplicates still collide, which is why that check alone cannot
establish the tab-normalisation contract."
edit db/migrations/0143_party_name_unicode_spaces.sql \
  "  SELECT trim(regexp_replace(lower(translate(p_name, chr(160) || chr(8239), '  ')), '\\s+', ' ', 'g'));" \
  "  SELECT lower(regexp_replace(trim(translate(p_name, chr(160) || chr(8239), '  ')), '\\s+', ' ', 'g'));" || exit 1
run npm run db:verify-parties
close; restore


# ---------------------------------------------------------------- 118
section "The duplicate lookup asks about a different name than it stores" \
"\`createParty\` looks up with the raw input while storing the trimmed one. For
almost every name those are the same string. For one prefixed with a byte-order
mark they are not: JavaScript \`.trim()\` strips U+FEFF and Postgres \`\\\\s\` does
not match it, so the lookup misses and the insert then collides with the index.

The duplicate is still refused — by the index, as a raw constraint violation
instead of the sentence naming the record you already have. Two normalisers,
one of them invisible."
edit src/lib/parties.ts \
  '       WHERE is_active AND party_name_key(name) = party_name_key(${name})`)' \
  '       WHERE is_active AND party_name_key(name) = party_name_key(${input.name})`)' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 119
section "A role stops being one that trades, and the lines it explained do not notice" \
"\`party_role_definition.transacts\` is what the rule reads. Setting 'supplier'
to false orphans every supplier-explained line in every company at once — and
the reference table looked like seed data, so nothing watched it.

The other four guards are all about a party or an entry. This one is about the
vocabulary they are written in, which is why it was the last found."
edit db/migrations/0152_party_without_start_dates.sql \
  '  IF NEW.transacts OR NOT OLD.transacts THEN RETURN NULL; END IF;' \
  '  RETURN NULL;' || exit 1
run npm run db:verify-parties
close; restore


# ---------------------------------------------------------------- 120
section "An applied migration is edited" \
"A line is added to a migration the books already ran. \`db:migrate\` refuses
this — 'has changed since it was applied' — but until \`M2b\` existed, the suite
named after migrations did not: \`M1\` counts files against rows and \`M2\`
counts rows against files, and neither reads a byte.

Not hypothetical. It happened during this round, and this suite reported ALL
CHECKS PASSED in the same minute that \`db:migrate\` refused. Counting is not
reading."
edit db/migrations/0025_party.sql \
  '-- 0025 — customers and suppliers are one list, and the ledger points at it' \
  '-- 0025 — customers and suppliers are one list, and the ledger points at it
-- (a byte that was not there when this was applied)' || exit 1
run npm run db:check-migrations
close; restore


# ---------------------------------------------------------------- 121
section "The party is named on every line of the invoice" \
"The control line is the debt. Naming the party on the revenue lines too doubles
every per-party figure read off the ledger — and since aging is DERIVED, there
is no stored balance to disagree with it. The trial balance is unchanged, the
invoice looks right, and the customer appears to owe twice what they do."
edit src/lib/invoices.ts \
  '      ...lines.map((l) => ({
        accountId: l.account_id,
        amount: BigInt(l.amount),
        ...(inv.fx_currency && inv.fx_snapshot ? {originalCurrency:inv.fx_currency,
          originalAmount:BigInt(l.original_amount ?? 0n),fxSnapshot:inv.fx_snapshot}:{}),
        description: l.description ?? undefined,
        dimensions: l.dimensions,
      })),' \
  '      ...lines.map((l) => ({
        accountId: l.account_id,
        amount: BigInt(l.amount),
        ...(inv.fx_currency && inv.fx_snapshot ? {originalCurrency:inv.fx_currency,
          originalAmount:BigInt(l.original_amount ?? 0n),fxSnapshot:inv.fx_snapshot}:{}),
        description: l.description ?? undefined,
        dimensions: l.dimensions,
        partyId: inv.party_id,
      })),' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 122
section "A sales invoice may land in any account at all" \
"The control-account rule stops asking for the role. A sales invoice whose total
lands in an expense account balances perfectly: the entry is sound, the trial
balance is sound, and the receivable is somewhere nobody will look for it.

Asking the ROLE and not the account type is what makes this bite: 'Other
Receivable' is an asset and receivable-shaped, and is still the wrong account."
edit db/migrations/0028_invoice.sql \
  "  IF NOT ok THEN" \
  "  IF false THEN" || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 123
section "The lines may go whichever way they like" \
"A sales invoice whose lines net to a credit is a credit note; a purchase bill
whose lines net to a debit is a supplier credit. Neither is built. With the
direction check gone both post as ordinary invoices, putting money on the wrong
side of the control account — and reading afterwards exactly like the document
they are not.

The rule is not 'the total must be positive'. A purchase bill's control movement
is negative and correct."
edit src/lib/invoices.ts \
  '  if (!movesTheRightWay(input.direction, movement, kind)) {' \
  '  if (false) {' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 124
section "A posted invoice can be edited after the fact" \
"The freeze goes. The document and the entry it produced stop having to say the
same thing: change the due date, the party, or the control account, and the
ledger still holds what was posted while the invoice says something else.

Nothing in the ledger notices, because the ledger was right when it was written."
edit db/migrations/0041_the_wall_keeps_all_its_bricks.sql \
  '  IF OLD.status <> '"'"'draft'"'"' THEN
    IF NOT v_open_edit THEN
      IF NEW.party_id IS DISTINCT FROM OLD.party_id' \
  '  IF false THEN
    IF NOT v_open_edit THEN
      IF NEW.party_id IS DISTINCT FROM OLD.party_id' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 125
section "An invoice can claim an entry it did not produce" \
"\`entry_id\` becomes a hint. An invoice pointing at another invoice's entry
reads as posted, and the aging — which reads the LEDGER — puts that debt against
whoever the OTHER invoice named. Both documents look right on their own.

Two earlier defences stand in front of this one, which is why the check that
covers it has to claim status and entry in the same statement."
edit db/migrations/0120_p1_deferred_invoice_and_source_versions.sql \
  '  IF e_source IS DISTINCT FROM want OR e_source_id IS DISTINCT FROM NEW.id THEN' \
  '  IF false THEN' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 126
section "The control account can stop being one under a posted invoice" \
"The guard on \`account_role\` stops looking for invoices. \`setAccountRoles\`
deletes every role and re-inserts the ones given, and it is reached from the
accounts screen — so this is not a hand-written DELETE. Strip
\`trade_receivables\` off an account a posted invoice names and the rule that
invoice was checked against is simply false, with nothing looking again.

The ledger does not move. The receivable is still there. What is gone is the
thing that said it was a receivable."
edit db/migrations/0029_an_invoice_keeps_saying_it.sql \
  '  IF n > 0 THEN
    SELECT code, name INTO a_code, a_name FROM account WHERE id = OLD.account_id;' \
  '  IF false THEN
    SELECT code, name INTO a_code, a_name FROM account WHERE id = OLD.account_id;' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 127
section "Voiding and posting again walks round the freeze" \
"The status-transition rule goes. A posted invoice can then go back to draft —
which unfreezes its lines — or take a hop through void and come back, changing
the party, the due date and the control account on the way. The entry does not
move, so the ledger holds one document and the invoice describes another.

This is what 'posted is frozen' meant before: frozen only while the status
happened to stay 'posted'."
edit db/migrations/0041_the_wall_keeps_all_its_bricks.sql \
  '  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = '"'"'draft'"'"'  AND NEW.status = '"'"'posted'"'"')' \
  '  IF false
     AND NOT ((OLD.status = '"'"'draft'"'"'  AND NEW.status = '"'"'posted'"'"')' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 128
section "The entry is reversed out from under the invoice" \
"\`ENTRY_HOLDS_AN_INVOICE\` goes. Reversing — or amending, which is a reversal
wearing a hat — leaves the invoice pointing at an entry that is no longer
standing. \`amendEntry\` carries source_type and source_id to the replacement on
purpose, so the live figure is somewhere else entirely while the invoice screen
goes on showing the original total computed from \`invoice_line\`.

0021 refuses this same shape for bank matches. The invoice analogue was missing."
edit db/migrations/0029_an_invoice_keeps_saying_it.sql \
  '  IF NEW.source_type NOT IN ('"'"'ar_invoice'"'"', '"'"'ap_bill'"'"') THEN RETURN NULL; END IF;' \
  '  RETURN NULL;' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 129
section "Voiding leaves the entry standing" \
"\`voidInvoice\` releases the invoice's claim and stops there. The invoice reads
void, and the entry it produced is still posted in the ledger — named by
nothing, and still owed by the customer.

Aging is derived from the ledger, so this is not a stale number somewhere that
could be spotted against another: it IS the number. The two halves have to
happen together or the remedy every guard names makes things worse."
edit src/lib/invoices.ts \
  '    const reversal = await reverseEntryCore(
      tx, inv.entry_id!, input.reversedOn ?? inv.issued_on, reason, actor)' \
  '    const reversal = { reversal: { id: null } }' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 130
section "The sign is read off the typist instead of the direction" \
"\`ledgerAmount\` stops flipping for a sale. Somebody types 1,200 on a sales
invoice and the ledger DEBITS revenue by 1,200 — so the receivable is credited,
and the invoice bills the customer minus twelve hundred dollars.

It posts. It balances. The trial balance is sound. The only thing wrong is which
side everything is on, and the screen shows the figure the person typed either
way."
edit src/lib/invoice-forms.ts \
  "  const debitsControl = (direction === 'sales') === (kind === 'invoice')
  return debitsControl ? -addedToInvoice : addedToInvoice" \
  "  const debitsControl = (direction === 'sales') === (kind === 'invoice')
  return addedToInvoice" || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 131
section "A half-finished line is dropped instead of refused" \
"A slot with an account and no amount is skipped quietly. The invoice posts for
less than the screen showed — and every total agrees with it, because they are
all computed from the lines that made it through.

Nothing is inconsistent afterwards. The document is just wrong, by exactly the
line nobody was told about."
edit src/lib/invoice-forms.ts \
  '    if (!rawAmount) {
      return { lines: [], error: `Line ${n} (${nameOf(account)}) has no amount.` }
    }' \
  '    if (!rawAmount) {
      continue
    }' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 132
section "A line's amount is read from a different slot than its account" \
"\`linesFrom\` takes the account from slot i and the amount from slot i+1. On a
form filled top to bottom this is invisible for the last line only; fill the
slots in any other order and the figures land against the wrong accounts.

This is the sales tax screen's defect, reproduced deliberately. The reason the
numbering is safe here is that a slot's fields all carry the same number, and
this is what it looks like when they do not."
edit src/lib/invoice-forms.ts \
  '    const rawAmount = g(f, lineAmount(i))' \
  '    const rawAmount = g(f, lineAmount(i + 1)) || g(f, lineAmount(i))' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 133
section "The Delete button carries the ledger's id instead of the invoice's" \
"One hidden field, one identifier swapped for another that is in scope right
beside it. The screen is otherwise perfect: right lines, right total, right
customer, right heading — and a Delete button that deletes some other thing
or nothing. Both values are uuids, so nothing looks wrong anywhere. This is
the seam the sales tax round spent six rounds on, and the only thing that
sees it is rendering the screen and reading what its fields would post."
edit "src/app/ledger/[ledgerId]/invoices/[invoiceId]/InvoiceDetail.tsx" \
  '            <ActionForm action={actions.delete} submit="Delete it" working="…"
                        buttonClassName="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50">
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
              <input type="hidden" name={F.invoiceId} value={invoiceId} />' \
  '            <ActionForm action={actions.delete} submit="Delete it" working="…"
                        buttonClassName="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50">
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
              <input type="hidden" name={F.invoiceId} value={ledgerId} />' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 134
section "A sales invoice can be addressed to a supplier" \
"The invoice-level party rule goes. The LEDGER's rule survives — a supplier
holds a transacting role, so every journal line is fine — and the receivable
lands under a company you buy from.

The screen makes this the easy mistake: customers and suppliers are rendered
into one select as two groups, so the wrong one is one click away. Nothing
downstream objects, because a line does not know whether it is a sale."
edit db/migrations/0152_party_without_start_dates.sql \
  '  IF EXISTS (' \
  '  IF true OR EXISTS (' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 135
section "The detail screen shows the ledger's sign instead of the typed one" \
"\`asEntered\` becomes the identity. A sales line stored as −1,500 then reads
back as −1,500 on the screen the person just typed 1,500 into.

Nothing is wrong in the ledger. The document is unchanged. The screen simply
disagrees with itself between entering a figure and reading it — and the TOTAL,
which is rendered without the conversion, goes on agreeing with the person, so
a check that watched the total would see nothing."
edit "src/app/ledger/[ledgerId]/invoices/[invoiceId]/InvoiceDetail.tsx" \
  "  const asEntered = (amount: bigint) => (debitsControl ? -amount : amount)" \
  "  const asEntered = (amount: bigint) => amount" || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 136
section "One line slot loses its number" \
"The amount input on every rendered slot is named for slot 0. Fill line 3 and
the figure arrives as line 1's — the sales tax defect, reproduced in the one
place the narrowed rule says is safe.

The reader is untouched and correct. What breaks is the screen's half of the
agreement, which no amount of reading \`linesFrom\` can see."
edit "src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx" \
  '            <span data-cell="amount"><AmountInput disabled={disabled} name={lineAmount(i)} value={row.amount}' \
  '            <span data-cell="amount"><AmountInput disabled={disabled} name={lineAmount(0)} value={row.amount}' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 137
section "The form stops offering a field the reader still reads" \
"The note input goes. \`createInvoiceFromForm\` still reads \`F.note\`, so every
invoice made through the screen silently has no note — and nothing is
inconsistent afterwards, because the reader reads an empty string and stores a
null.

This is the drift a hand-written list of expected fields cannot see: the list
would have to be updated to notice, and whoever removed the input would have
been the one to update it."
edit $'src/app/ledger/[ledgerId]/invoices/new/NewInvoiceForm.tsx' $'            <textarea name={F.note} defaultValue={header?.note ?? \'\'} rows={3}\n                      placeholder={salesInvoice ? \'Deposit: ...\\nProgress payment: ...\\nFinal payment: ...\' : undefined}\n                      className={`mt-1 w-full ${FIELD}`} />' $'' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 138
section "A sale's tax is claimed back instead of remitted" \
"The side check goes. Tax collected on a sale can then be booked to the
recoverable account — which is claiming back tax you charged somebody else.

The entry balances. The invoice total is right. The customer is billed the right
amount. The GST return is wrong in BOTH boxes at once: line 105 short by the
tax, line 108 over by it, so the net is wrong by twice the figure and neither
box looks odd on its own."
edit db/migrations/0033_a_tax_line_points_the_way_the_document_does.sql \
  '  IF bad_code IS NOT NULL THEN
    RAISE EXCEPTION '"'"'TAX_WRONG_SIDE' \
  '  IF false THEN
    RAISE EXCEPTION '"'"'TAX_WRONG_SIDE' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 139
section "The fourth combination is the one that gets copied wrong" \
"\`movesTheRightWay\` goes back to reading the direction alone, ignoring whether
this is an invoice or a credit note. Sales invoices and sales credit notes then
have to move the receivable the same way — so every credit note is refused, and
if the flip were the other way round every one would post backwards.

Two axes written as one is the shape this whole feature exists to avoid, and it
is invisible on three of the four cells."
edit src/lib/invoices.ts \
  '  const debitsControl = (direction === '"'"'sales'"'"') === (kind === '"'"'invoice'"'"')
  return debitsControl ? movement > 0n : movement < 0n' \
  '  return direction === '"'"'sales'"'"' ? movement > 0n : movement < 0n' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 140
section "The list's total and the document's disagree" \
"\`invoicesFor\` computes the document total in SQL because it cannot import
\`totalOf\`. The rule is therefore written twice, and this is what happens when
the two drift: the SQL copy forgets the document kind.

Every credit note then shows a negative total on the list and a positive one on
its own page. Neither figure is wrong on its own terms; they are answers to the
same question from two places that stopped agreeing."
edit src/lib/invoices.ts \
  '           (CASE WHEN (i.direction = '"'"'sales'"'"') = (i.document_kind = '"'"'invoice'"'"')
                 THEN -1 ELSE 1 END' \
  '           (CASE WHEN i.direction = '"'"'sales'"'"' THEN -1 ELSE 1 END' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 141
section "A posted credit note can become an invoice" \
"\`document_kind\` is left off the frozen column list. 0032 added the column and
the freeze names its columns one by one — so the new one is unfrozen until
somebody remembers, which is what this is.

Flip a posted credit note to an invoice and the document says it bills the
customer while the entry it produced credits them."
edit db/migrations/0041_the_wall_keeps_all_its_bricks.sql \
  '         OR NEW.document_kind IS DISTINCT FROM OLD.document_kind' \
  '         OR false' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 142
section "The tax line points the wrong way and nothing minds" \
"The sign half of the tax guard goes — the half 0031 never had. The ACCOUNT is
still checked, so a sale still cannot name a recoverable account. What gets
through is the right account pointing backwards: a sales invoice that DEBITS the
tax it collected.

Every other rule is satisfied. The control movement is still the way a sales
invoice must move, so it posts, and the return shows tax remitted rather than
collected — in the very box the original guard's comment was about."
edit db/migrations/0033_a_tax_line_points_the_way_the_document_does.sql \
  '  IF bad_code IS NOT NULL
     AND ((lines_are_credits AND NEW.amount > 0) OR (NOT lines_are_credits AND NEW.amount < 0))' \
  '  IF false
     AND ((lines_are_credits AND NEW.amount > 0) OR (NOT lines_are_credits AND NEW.amount < 0))' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 143
section "Who issued a posted invoice can be rewritten" \
"\`created_by\` comes off the frozen list. The document cannot otherwise be
edited, and this is the one change that leaves no trace: the audit row records
the status change, not a later edit of the name attached to it.

The freeze names its columns one by one on purpose — a whole-row comparison
would freeze \`posted_at\`, which the posting itself writes — and the cost of a
list is that things fall off it."
edit db/migrations/0041_the_wall_keeps_all_its_bricks.sql \
  '         OR NEW.created_by IS DISTINCT FROM OLD.created_by' \
  '         OR false' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 144
section "The aging joins away the money nobody owes" \
"\`unattributed\` is reported as zero rather than as the difference between the
control account and the rows. Aging JOINs to \`party\`, so a receivable with no
party on it is in NO row — and the account balance goes on including it.

Two numbers that are supposed to be the same, differing in silence. The report
adds up perfectly; it is just about less money than the ledger holds."
edit src/lib/aging.ts \
  '    unattributed: BigInt(control?.total ?? '"'"'0'"'"') - BigInt(control?.with_party ?? '"'"'0'"'"'),' \
  '    unattributed: 0n,' || exit 1
run npm run db:verify-aging
close; restore

# ---------------------------------------------------------------- 145
section "An aging bucket is off by a day at its boundary" \
"The 0-30 bucket becomes 0-29, so everything 30 days old moves into 31-60.

The total is unchanged — every line is still in exactly one bucket — and the
report still agrees with the control account. What moves is which column a
figure appears under, which is the only thing anybody reads an aging report
for."
edit src/lib/aging.ts \
  "  { label: '0–30', from: 0, to: 30 }," \
  "  { label: '0–30', from: 0, to: 29 }," || exit 1
run npm run db:verify-aging
close; restore


# ---------------------------------------------------------------- 146
section "The reader goes back to counting to six" \
"\`lineIndicesIn\` returns only the first six rows it finds. The form opens with
six and lets a person add more, so this is the exact shape the dynamic reader
replaced: the seventh line is never read, the invoice saves without it, and
every figure on the saved document agrees with every other.

Nothing on the screen says so. The line is simply not there afterwards."
edit src/lib/forms.ts \
  '  return [...seen].sort((a, b) => a - b)' \
  '  return [...seen].sort((a, b) => a - b).slice(0, 6)' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 147
section "A line's field name is read as its row number" \
"The refusal counts by the number IN the field name instead of by where the row
sits among the rows that came back.

They are the same number until a row is removed from the middle. After that the
form renumbers on its next render and a submission already in flight does not,
so \`Line 8\` names nothing on a five-row form — and the person is being told to
fix a line that is not on the screen."
edit src/lib/invoice-forms.ts \
  '    const n = position + 1' \
  '    const n = i + 1' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 148
section "The remove button takes out whichever row is standing there" \
"\`removeRow\` filters by position instead of by key.

Until a row moves the two agree. After one move the button under the third row
removes a different row — a different account, a different figure — and the form
still shows well-formed lines. This is the sales tax screen's defect in its
other form: a number read after the render that produced it, against a list that
has moved."
edit src/lib/invoice-rows.ts \
  '  const rows = state.rows.filter((r) => r.key !== key)' \
  '  const rows = state.rows.filter((_, i) => i !== key)' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 149
section "Removing the last line leaves nowhere to type" \
"The blank row that replaces the last removed one goes away.

The form is then a header, a note about signs, and no lines. Everything on the
page still works; there is simply no way to put a line back without reloading,
and the person who emptied it was clearing it, not leaving."
edit $'src/lib/invoice-rows.ts' $'  return { ...state, rows: [blank(state.nextKey)], nextKey: state.nextKey + 1 }' $'  return { ...state, rows }' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 150
section "A move carries the figure and leaves the account behind" \
"\`moveRow\` swaps the amounts of two rows rather than the rows.

The screen looks right — two rows, both complete, in the new order. One figure
is now against the other line's account. The invoice totals the same, posts, and
is wrong about what it was for, which is the part an aging report and a tax
return both read."
edit src/lib/invoice-rows.ts \
  '  ;[rows[from], rows[to]] = [rows[to], rows[from]]' \
  '  ;[rows[from].amount, rows[to].amount] = [rows[to].amount, rows[from].amount]' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 151
section "A key is handed out twice" \
"\`nextKey\` becomes the number of rows, so a key freed by a removal is given to
the next row added.

Every button carries a key. A button rendered before the removal and pressed
after it acts on the new row that took the old one's number — and React, keyed
on the same value, keeps the removed row's element and its contents."
edit $'src/lib/invoice-rows.ts' $'  return { ...state, rows: [...state.rows, blank(state.nextKey)], nextKey: state.nextKey + 1 }' $'  return { ...state, rows: [...state.rows, blank(state.rows.length)], nextKey: state.rows.length + 1 }' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 152
section "A row that is not yet an amount is counted as nothing" \
"\`typedTotal\` stops counting the rows it cannot read and folds them into the
total as zero.

The figure under the form is then confident and short. Worse, it is a figure for
an invoice that will not save: the reader refuses a line whose amount reads as
zero by name, so the screen is promising a total for a document the next click
will refuse."
edit src/lib/invoice-rows.ts \
  '      if (parsed === 0n) unreadable++' \
  '      if (parsed === 0n) { /* nothing */ }' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 153
section "A row's button reports acting on a row it does not act on" \
"The Remove button's \`data-acts-on\` becomes the position while its handler goes
on using the key.

Only the MARKER moves. The button still removes the right row — so this is not
the wiring defect, it is the audit trail lying about the wiring, which is worth a
block of its own: \`V88\` reads that marker, and a marker nothing checks is a
label the component writes about itself. The block that breaks the handler
instead is further down."
edit 'src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx' \
  '              <IconButton icon="delete" data-acts-on={row.key} data-does="remove"' \
  '              <IconButton icon="delete" data-acts-on={i} data-does="remove"' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 154
section "The number a person is shown is the row's key" \
"The Remove label says \`Remove line 4\` where 4 is the row's key rather than its
place on the screen.

They start out the same, which is why this survives being looked at. They come
apart the first time a row is removed, and then the labels count 1, 2, 4, 5 down
a form that shows four rows — while the refusals coming back from the reader
count 1, 2, 3, 4."
edit 'src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx' \
  '                      disabled={disabled} label={`Remove line ${i + 1}`}' \
  '                      disabled={disabled} label={`Remove line ${row.key + 1}`}' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 155
section "The line-name pattern matches a field that is not a line" \
"\`LINE_FIELD\` accepts any word after the number, not just the three a row has.

Nothing on the form is named that way today, so nothing breaks today. It breaks
the moment a row gains a fourth field — a tax code, a quantity — under a name
this now reads as a row of its own: the reader refuses the invoice for a line
the person cannot see, naming a row number that is not on the screen."
edit $'src/lib/forms.ts' $'const LINE_FIELD = /^line\\.(\\d+)\\.(account|description|amount|gst|pst)$/' $'const LINE_FIELD = /^line\\.(\\d+)\\.(\\w+)$/' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 156
section "A saved invoice leaves its lines on the form" \
"The screen stops being told that the save worked, so the line rows stay.

The header fields are cleared by React and the eight lines are not, and the form
now offers to save them again against whoever is chosen next. Nothing on the
page looks broken; it looks like a form that has been helpfully pre-filled."
edit $'src/app/ledger/[ledgerId]/invoices/new/NewInvoiceForm.tsx' $'                  onSucceeded={edit ? undefined : start ? (s) => setDone(s.ok ?? \'Saved to the books.\') : () => {\n                    setLineRows(initialRows()); setInclusive(false); setPartyId(\'\'); setTemplate(\'auto\')\n                  }}>' $'                  >' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 157
section "The Remove button acts on the place, not on the row" \
"The handler is given the position while the marker goes on reporting the key.

This is the defect a review found unguarded, and it was unguarded for a precise
reason: \`data-acts-on\` and the \`onClick\` beside it were two separate
expressions, so a check comparing the marker with the row compared \`row.key\`
with \`row.key\`. Both sides spelled the same, which this repository has already
written down as not being a check.

\`V92\` presses the button. \`InvoiceLines\` keeps no state of its own, so the
component can be called and its handlers are the closures a browser would run."
edit 'src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx' \
  '                      onClick={() => setState(removeRow(state, row.key))} />' \
  '                      onClick={() => setState(removeRow(state, i))} />' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 158
section "Typing in a row writes the row above it" \
"The amount field's \`onChange\` carries the position instead of the key.

Until a row moves the two agree. After one move the figure lands on the line
above or below the one being typed in — and the screen shows exactly what was
typed, in the wrong row, against the wrong account.

The whole form still adds up. It adds up to the right total for the wrong
invoice."
edit 'src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx' \
  "                   onChange={(e) => setState(editRow(state, row.key, 'amount', e.target.value))} />" \
  "                   onChange={(e) => setState(editRow(state, i, 'amount', e.target.value))} />" || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 159
section "Dragging treats a stable row key as its current position" \
"The arbitrary-position move stops resolving the row's key to its current index.
Once keys differ from positions, the wrong row moves or nothing happens.
\`V93\` and \`V93b\` use edited keys to distinguish those cases."
edit 'src/lib/invoice-rows.ts' \
  '  const rows = moveLineTo(state.rows, state.rows.findIndex((r) => r.key === key), to)' \
  '  const rows = moveLineTo(state.rows, key, to)' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 160
section "A payable ages into the next bucket along" \
"The 61-90 bucket becomes 61-89, and a bill exactly ninety days old falls out of
the report — 'Over 90' begins at 91, so day ninety is now in no bucket at all.
The money is simply gone from every column while the control account goes on
holding it.

The narrower version of this — a figure landing one column along — is block 145
on the other boundary. This one is here for the payables side, where nothing
used to assert a column at all: \`A12\` checked the total and the sign while its
label said 'age'."
edit src/lib/aging.ts \
  "  { label: '61–90', from: 61, to: 90 }," \
  "  { label: '61–90', from: 61, to: 89 }," || exit 1
run npm run db:verify-aging
close; restore

# ---------------------------------------------------------------- 161
section "The marker on the button reports the place it is standing in" \
"\`data-acts-on\` becomes the position while the handler goes on using the key.

This is the block that was missing, and its absence is what a review caught.
\`V92b\` claimed to assert that a button removes the row its \`data-acts-on\`
names — and read \`data-line-row\` off the row div instead, which the buttons do
not carry and this mutation does not touch. So the check was green under exactly
the change it was written to catch, and the paragraph in \`09-invoices.md\`
defending the marker was defending an attribute nothing read.

\`V88\` goes red beside it: the three buttons in one row now disagree with each
other, two saying the key and one the position."
edit 'src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx' \
  '<IconButton icon="delete" data-acts-on={row.key} data-does="remove"' \
  '<IconButton icon="delete" data-acts-on={i} data-does="remove"' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 162
section "Dragging lands one position beyond the chosen target" \
"The drop target is a final position after removing the moving row.
Adding one shifts the row beyond that position in either direction.
\`V93\` and \`V93b\` assert the complete order and the moved amount."
edit 'src/lib/invoice-rows.ts' \
  '  const rows = moveLineTo(state.rows, state.rows.findIndex((r) => r.key === key), to)' \
  '  const rows = moveLineTo(state.rows, state.rows.findIndex((r) => r.key === key), to + 1)' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 163
section "Choosing an account sets it on the row above" \
"The account select's \`onChange\` carries the position instead of the key.

This is the worst of the six to lose, and it was the one nothing watched. A
figure in the wrong row is visible — the line reads oddly. An AMOUNT that is
right against an ACCOUNT that is wrong posts a balanced entry to the wrong place
in the chart, and every total on the invoice agrees with itself."
edit 'src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx' \
  "                    onChange={(id) => setState(editRow(state, row.key, 'account', id))} />" \
  "                    onChange={(id) => setState(editRow(state, i, 'account', id))} />" || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 164
section "The description lands on the line above" \
"The last of the six. Nothing about the ledger is wrong afterwards — the money
is all in the right places — and the invoice still goes out with each line
describing its neighbour."
edit 'src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx' \
  "                   onChange={(e) => setState(editRow(state, row.key, 'description', e.target.value))} />" \
  "                   onChange={(e) => setState(editRow(state, i, 'description', e.target.value))} />" || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 165
section "A spent credit note reports itself available" \
"The balance derivation loses the second join — applications made BY the
document's entry — so a note that has settled an invoice goes on showing its
full value as left to apply. This is the defect \`PM09\` caught on the suite's
FIRST RUN: the first version of \`OPEN_ITEMS\` had only the applications-ON
join, and the note read as unspent while the invoice it settled read as paid.
The same money, available twice."
edit src/lib/payments.ts \
  '         CASE WHEN i.fx_currency IS NOT NULL THEN abs(fx_position.carrying_balance)
           ELSE abs(mov.amount)-COALESCE(app_on.total,0)-COALESCE(app_by.total,0) END AS balance,' \
  '         CASE WHEN i.fx_currency IS NOT NULL THEN abs(fx_position.carrying_balance)
           ELSE abs(mov.amount)-COALESCE(app_on.total,0) END AS balance,' || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 166
section "The payment names the party on both of its lines" \
"\`recordPayment\` puts the party on the bank line as well as the control line.

Both lines still balance, the invoice still reads as paid, and every figure on
the payment screen is right. What breaks is one level down: anything reading
the ledger BY PARTY now counts the money twice — the aging's control-balance
equality is exactly the check that would catch it there, and \`PM02\` is the
one that catches it here, at the door."
edit src/lib/payments.ts \
  '        { accountId: bankAccountId, amount: -settle, description },' \
  '        { accountId: bankAccountId, amount: -settle, partyId: inv.party_id, description },' || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 167
section "The invoice-side limit is quietly a thousand times looser" \
"\`check_application_valid\` compares against a thousand debts instead of one.
Applied to the test database rather than the migration file, which is
append-only — 0015's precedent.

The library's own OVERPAYS check still refuses the ordinary path, which is why
\`PM05\` stays green: this block is exactly the case \`PM05b\` exists for, the
limit at the DATABASE with the library dodged."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION check_application_valid() RETURNS trigger AS $$
DECLARE
  inv        record;
  ent_status text;
  ent_ledger uuid;
  inv_mov    bigint;
  settle_cap bigint;
  inv_applied bigint;
  ent_applied bigint;
BEGIN
  SELECT i.id, i.status, i.ledger_id, i.party_id, i.control_account_id,
         i.entry_id, i.number
    INTO inv
    FROM invoice i WHERE i.id = NEW.invoice_id;
  IF inv.status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_INVOICE_NOT_POSTED: % is %, and only a posted invoice is a debt',
      COALESCE(inv.number, 'that invoice'), inv.status;
  END IF;
  SELECT je.status, je.ledger_id INTO ent_status, ent_ledger
    FROM journal_entry je WHERE je.id = NEW.entry_id;
  IF ent_status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_ENTRY_NOT_POSTED: that entry is %, not posted', ent_status;
  END IF;
  IF ent_ledger IS DISTINCT FROM inv.ledger_id THEN
    RAISE EXCEPTION 'APPLICATION_LEDGER: that entry is in another set of books';
  END IF;
  SELECT COALESCE(SUM(jl.amount), 0) INTO inv_mov
    FROM journal_line jl
   WHERE jl.entry_id = inv.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id;
  IF inv_mov = 0 THEN
    RAISE EXCEPTION 'APPLICATION_NO_DEBT: the entry behind % holds nothing on its control account',
      COALESCE(inv.number, 'that invoice');
  END IF;
  SELECT COALESCE(SUM(jl.amount), 0) INTO settle_cap
    FROM journal_line jl
   WHERE jl.entry_id = NEW.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id
     AND sign(jl.amount) = -sign(inv_mov);
  IF settle_cap = 0 THEN
    RAISE EXCEPTION 'APPLICATION_WRONG_WAY: that entry does not move %''s control account toward settling it',
      COALESCE(inv.number, 'that invoice');
  END IF;
  SELECT COALESCE(SUM(a.amount), 0) INTO inv_applied
    FROM invoice_application a WHERE a.invoice_id = NEW.invoice_id;
  IF inv_applied > abs(inv_mov) * 1000 THEN
    RAISE EXCEPTION 'APPLICATION_OVER_INVOICE: % settled of a % debt on %',
      inv_applied, abs(inv_mov), COALESCE(inv.number, 'that invoice');
  END IF;
  SELECT COALESCE(SUM(a.amount), 0) INTO ent_applied
    FROM invoice_application a
    JOIN invoice i2 ON i2.id = a.invoice_id
   WHERE a.entry_id = NEW.entry_id
     AND i2.control_account_id = inv.control_account_id
     AND i2.party_id = inv.party_id;
  IF ent_applied > abs(settle_cap) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_ENTRY: that entry holds % toward this party and % is already applied',
      abs(settle_cap), ent_applied;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-payments.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 168
section "An entry that never touched the debt settles it anyway" \
"The wrong-way branch is removed from the trigger: \`settle_cap = 0\` now sails
through with a fictitious capacity, so any posted entry in the ledger can be
applied to any invoice. Same applied-state shape as the block above.

\`PM07\` reddens — its refusal now arrives as the wrong error or not at all —
and the entry-side limit goes with it, since a capacity invented from nothing
is a limit measured against nothing."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION check_application_valid() RETURNS trigger AS $$
DECLARE
  inv        record;
  ent_status text;
  ent_ledger uuid;
  inv_mov    bigint;
  settle_cap bigint;
  inv_applied bigint;
BEGIN
  SELECT i.id, i.status, i.ledger_id, i.party_id, i.control_account_id,
         i.entry_id, i.number
    INTO inv
    FROM invoice i WHERE i.id = NEW.invoice_id;
  IF inv.status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_INVOICE_NOT_POSTED: % is %, and only a posted invoice is a debt',
      COALESCE(inv.number, 'that invoice'), inv.status;
  END IF;
  SELECT je.status, je.ledger_id INTO ent_status, ent_ledger
    FROM journal_entry je WHERE je.id = NEW.entry_id;
  IF ent_status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_ENTRY_NOT_POSTED: that entry is %, not posted', ent_status;
  END IF;
  IF ent_ledger IS DISTINCT FROM inv.ledger_id THEN
    RAISE EXCEPTION 'APPLICATION_LEDGER: that entry is in another set of books';
  END IF;
  SELECT COALESCE(SUM(jl.amount), 0) INTO inv_mov
    FROM journal_line jl
   WHERE jl.entry_id = inv.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id;
  IF inv_mov = 0 THEN
    RAISE EXCEPTION 'APPLICATION_NO_DEBT: the entry behind % holds nothing on its control account',
      COALESCE(inv.number, 'that invoice');
  END IF;
  settle_cap := abs(inv_mov);
  SELECT COALESCE(SUM(a.amount), 0) INTO inv_applied
    FROM invoice_application a WHERE a.invoice_id = NEW.invoice_id;
  IF inv_applied > abs(inv_mov) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_INVOICE: % settled of a % debt on %',
      inv_applied, abs(inv_mov), COALESCE(inv.number, 'that invoice');
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-payments.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 169
section "The credit note's form settles with the wrong entry" \
"The hidden field carries the invoice's own id where the settling entry
belongs. This is the bug the panel's first draft actually had — a comment
saying the entry does the settling, and no field carrying it — kept here as a
mutation so the check that caught it stays watched.

Markup-level: the form still renders, the select still lists the open
invoices, and the POST would arrive with a uuid in the entry slot. It is even
a VALID uuid — of a document, not an entry — so nothing about the request
looks wrong until the database asks what that entry moved."
edit 'src/app/ledger/[ledgerId]/invoices/[invoiceId]/PaymentsPanel.tsx' \
  "          <input type=\"hidden\" name={F.entryId} value={entryId ?? ''} />" \
  '          <input type="hidden" name={F.entryId} value={invoiceId} />' || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 170
section "Amending a payment strands its application" \
"The carry in \`posting.ts\` stops matching anything, so the application stays
on the original while the amendment reverses it — and the deferred trigger
\`trg_reversed_holds_no_application\` refuses the whole amendment at commit.
\`PM13\` dies rather than reddening cleanly, the way the bank-match carry
blocks die: the suite's catch-all prints the refusal and the summary counts
it. A death with a summary line is a controlled failure; a death without one
is what \`run\`'s finished-check exists to refuse."
edit src/lib/posting.ts \
  '      UPDATE invoice_application SET entry_id = ${posted.entry.id}::uuid WHERE entry_id = ${entryId}::uuid`)' \
  '      UPDATE invoice_application SET entry_id = ${posted.entry.id}::uuid WHERE false AND entry_id = ${entryId}::uuid`)' || exit 1
run npm run db:verify-payments
close; restore


# ---------------------------------------------------------------- 171
section "The register shows the cessation a day late" \
"The renderer's as-of comparison goes strict: a director who ceased ON the
as-of day still reads as serving. One character, one day, and a register
printed for a signing date says the signer had authority they had lost that
morning. \`CR13c\` sits exactly on the boundary; the two checks either side of
it (\`CR13\`, \`CR13b\`) cannot see this, which is why it exists."
edit src/lib/registers.ts \
  '          return t.ceased_on && t.ceased_on <= asOf ? t.ceased_on : '"'"'—'"'"'' \
  '          return t.ceased_on && t.ceased_on < asOf ? t.ceased_on : '"'"'—'"'"'' || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 172
section "The public is shown the transparency register" \
"The audience filter answers yes to everyone: \`visibleFields\` stops asking and
allows every field for every audience.

This is the single most consequential defect this module can have — birth
dates, home addresses and citizenships rendered to an audience the register
must never be shown to — and nothing about the page would look broken: the
table renders beautifully, with more columns than it should have."
edit src/lib/registers.ts \
  "  if (audience === 'director') return { allowed: () => true, withheld: [] }" \
  "  return { allowed: () => true, withheld: [] } // eslint-disable-line no-unreachable" || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 173
section "A transfer group stops having to balance" \
"\`check_transfer_group\` accepts any net. Applied to the test database, 0015's
precedent. Shares can now be minted by a one-sided transfer_in — the register
equivalent of an unbalanced journal entry — and every holder's statement still
reads cleanly on its own."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION check_transfer_group() RETURNS trigger AS $$
BEGIN
  RETURN NULL;
END $$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-records.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 174
section "The securities register learns to edit" \
"\`forbid_share_transaction_change\` waves everything through. The Act wants the
dates and details of every issue and transfer; an UPDATE that rewrites a
quantity erases a detail while the totals keep balancing. \`CR09\` and
\`CR09b\` both watch this door."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION forbid_share_transaction_change() RETURNS trigger AS $$
BEGIN
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-records.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 175
section "Two overlapping terms for one director" \
"The EXCLUDE constraint is dropped from the test database — a constraint has no
function to neuter, so the mutation is the DROP itself. One person now holds
two live terms at once, and a register as at any day in the overlap lists them
twice with two different addresses."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
ALTER TABLE directorship DROP CONSTRAINT directorship_no_overlap;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-records.ts
close
blk npm run db:reset >/dev/null 2>&1


# ---------------------------------------------------------------- 176
section "A holder may go negative and nobody is watching" \
"\`check_holding_never_negative\` waves everything through. A review found that
\`CR08\`'s only recorded red until now was a FIXTURE CASCADE: block 173's
one-sided +10 lifted the holding so the 26-share transfer no longer overdrew,
and the 'went through' was the setup's doing, not this guard failing. This
block disables the guard ITSELF, so \`CR08\` and \`CR08b\`'s reds are their own."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION check_holding_never_negative() RETURNS trigger AS $$
BEGIN
  RETURN NULL;
END $$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-records.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 177
section "The two ways to spend a note stop being added together" \
"0036's meeting point is removed: the trigger goes back to 0034's two separate
caps, target consumption and source consumption never summed. This is the
defect a review CONSTRUCTED live — a credit note paid down as a target and
spent as a source, balance −15,000, every row right on its own. \`PM21\`
reproduces that exact play and goes red; \`PM21b\` beside it watches the
balance land negative."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION check_application_valid() RETURNS trigger AS $$
DECLARE
  inv        record;
  ent_status text;
  ent_ledger uuid;
  inv_mov    bigint;
  settle_net bigint;
  ent_applied bigint;
  inv_applied bigint;
BEGIN
  SELECT i.id, i.status, i.ledger_id, i.party_id, i.control_account_id,
         i.entry_id, i.number
    INTO inv
    FROM invoice i WHERE i.id = NEW.invoice_id;
  IF inv.status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_INVOICE_NOT_POSTED: % is %', COALESCE(inv.number, 'that invoice'), inv.status;
  END IF;
  SELECT je.status, je.ledger_id INTO ent_status, ent_ledger
    FROM journal_entry je WHERE je.id = NEW.entry_id;
  IF ent_status <> 'posted' THEN
    RAISE EXCEPTION 'APPLICATION_ENTRY_NOT_POSTED: that entry is %', ent_status;
  END IF;
  IF ent_ledger IS DISTINCT FROM inv.ledger_id THEN
    RAISE EXCEPTION 'APPLICATION_LEDGER: another set of books';
  END IF;
  SELECT COALESCE(SUM(jl.amount), 0) INTO inv_mov
    FROM journal_line jl
   WHERE jl.entry_id = inv.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id;
  IF inv_mov = 0 THEN
    RAISE EXCEPTION 'APPLICATION_NO_DEBT: nothing on the control account';
  END IF;
  SELECT COALESCE(SUM(jl.amount), 0) INTO settle_net
    FROM journal_line jl
   WHERE jl.entry_id = NEW.entry_id
     AND jl.account_id = inv.control_account_id
     AND jl.party_id = inv.party_id;
  IF settle_net = 0 OR sign(settle_net) <> -sign(inv_mov) THEN
    RAISE EXCEPTION 'APPLICATION_WRONG_WAY: that entry does not move %''s control account toward settling it',
      COALESCE(inv.number, 'that invoice');
  END IF;
  SELECT COALESCE(SUM(a.amount), 0) INTO ent_applied
    FROM invoice_application a
    JOIN invoice i2 ON i2.id = a.invoice_id
   WHERE a.entry_id = NEW.entry_id
     AND i2.control_account_id = inv.control_account_id
     AND i2.party_id = inv.party_id;
  IF ent_applied > abs(settle_net) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_ENTRY: % held, % applied', abs(settle_net), ent_applied;
  END IF;
  SELECT COALESCE(SUM(a.amount), 0) INTO inv_applied
    FROM invoice_application a WHERE a.invoice_id = NEW.invoice_id;
  IF inv_applied > abs(inv_mov) THEN
    RAISE EXCEPTION 'APPLICATION_OVER_INVOICE: % of %', inv_applied, abs(inv_mov);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-payments.ts
close
blk npm run db:reset >/dev/null 2>&1


# ---------------------------------------------------------------- 178
section "Applications subtract from one side only" \
"The consumed CTE counts the document side twice and the settling side never.
Every application now reduces the invoice without reducing the payment, and
the equality \`A04\` pins — buckets add up to the control account, exactly —
breaks the moment one application is in scope. \`A19\` reddens beside it with
the invoice over-reduced below zero."
edit src/lib/aging.ts \
  '        SELECT settling_entry_id AS entry_id, party_id,
               control_account_id AS account_id, amount FROM in_scope_applications' \
  '        SELECT document_entry_id AS entry_id, party_id,
               control_account_id AS account_id, amount FROM in_scope_applications' || exit 1
run npm run db:verify-aging
close; restore

# ---------------------------------------------------------------- 179
section "Applications stop counting at all" \
"The open amount ignores consumed entirely — the derivation reverts to pure
per-entry bucketing, which was last month's behaviour. \`A04\` STAYS GREEN,
because the equality is structural either way; what reddens is \`A19\` (the
paid invoice back at over-ninety) and \`A20\` (the remainder gone from its
bucket). That split is this block's point: it proves the open-item checks are
not riding the equality check."
edit src/lib/aging.ts \
  "             (cm.movement - sign(cm.movement)::bigint * COALESCE(c.amount, 0))::bigint AS open_amount" \
  "             (cm.movement)::bigint AS open_amount" || exit 1
run npm run db:verify-aging
close; restore

# ---------------------------------------------------------------- 180
section "A payment from the future settles the past" \
"The settling-side as-at filter is dropped: an application counts even when
the payment entry is dated after the report. Asked as at June 20, the report
shows an invoice already reduced by a June 25 payment — and the equality
breaks too, because only one of the two linked entries is in the ledger read.
\`A21\` and \`A21b\` both redden."
edit src/lib/aging.ts \
  '         AND se.entry_date <= ${asOf}::date' \
  '         AND true' || exit 1
run npm run db:verify-aging
close; restore


# ---------------------------------------------------------------- 181
section "The one wiring hands its dispatcher back to the action prop" \
"Inside \`useActionForm\` — the single wiring every screen now goes through —
the action prop takes the dispatcher again. In a browser that is the
React-resets-on-refusal defect for EVERY form at once: the reset is scheduled
before the action runs, so an eight-field bill with one typo comes back empty.

Said precisely: \`V96\` is a SOURCE check and reddens on the wiring alone —
this block does not run a browser, and its own onSubmit handler would still
be attached. The tripwire is the point: the wiring lives in one file so that
one grep can refuse it, and this block is that grep being watched to fire."
edit src/components/ActionForm.tsx \
  '      action: typeof bind === '"'"'string'"'"' ? bind : undefined,' \
  '      action: typeof bind === '"'"'string'"'"' ? bind : (dispatch as never),' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 182
section "A payable's settlement is subtracted from the receivables report" \
"The consumed CTE goes back to keying on (entry, party) with no role scoping
and no account keying — the first open-item derivation, reverted whole. This
is the defect a review CONSTRUCTED: one entry netting a receivable against a
payable for the same party, applied to both documents legitimately, and the
receivables report showed the party owing the ledger's figure plus the whole
contra — money manufactured in a bucket while both applications looked right.

The fix has two defenses (role join, account keying) and EACH covers the
contra case alone, which is why this block reverts both together: dropping one
at a time stays green, and a block that stays green would have recorded the
defenses as untested. \`A22\`/\`A22b\` pin the constructed case; \`A11\`,
\`A13\` and \`A15\` break beside them because the equality goes with it."
edit src/lib/aging.ts \
  '    in_scope_applications AS (
      SELECT i.entry_id AS document_entry_id, ia.entry_id AS settling_entry_id,
             i.party_id, i.control_account_id, ia.amount
        FROM invoice_application ia
        JOIN invoice i ON i.id = ia.invoice_id
        JOIN account_role iar ON iar.account_id = i.control_account_id
                             AND iar.role = ${role}
        JOIN journal_entry de ON de.id = i.entry_id
        JOIN journal_entry se ON se.id = ia.entry_id
       WHERE i.fx_currency IS NULL AND de.entry_date <= ${asOf}::date
         AND se.entry_date <= ${asOf}::date
    ),
    consumed AS (
      SELECT entry_id, party_id, account_id, SUM(amount) AS amount FROM (
        SELECT document_entry_id AS entry_id, party_id,
               control_account_id AS account_id, amount FROM in_scope_applications
        UNION ALL
        SELECT settling_entry_id AS entry_id, party_id,
               control_account_id AS account_id, amount FROM in_scope_applications
      ) both_sides GROUP BY entry_id, party_id, account_id
    ),
    open_items AS (
      SELECT cm.party_id, cm.entry_id, COALESCE(migration_source.original_date,cm.entry_date) AS entry_date,
             (cm.movement - sign(cm.movement)::bigint * COALESCE(c.amount, 0))::bigint AS open_amount
        FROM control_movements cm
        LEFT JOIN consumed c ON c.entry_id = cm.entry_id
                            AND c.party_id = cm.party_id
                            AND c.account_id = cm.account_id
        -- Conversion GL remains on the snapshot date. Aging retains the original
        -- immutable source document/payment date; ordinary entries keep their date.
        LEFT JOIN (SELECT entry_id,min(original_issued_on) AS original_date
                     FROM migration_reference WHERE ledger_id=${ledgerId}::uuid
                     AND original_issued_on IS NOT NULL GROUP BY entry_id) migration_source
          ON migration_source.entry_id=cm.entry_id
    )' \
  '    in_scope_applications AS (
      SELECT i.entry_id AS document_entry_id, ia.entry_id AS settling_entry_id,
             i.party_id, ia.amount
        FROM invoice_application ia
        JOIN invoice i ON i.id = ia.invoice_id
        JOIN journal_entry de ON de.id = i.entry_id
        JOIN journal_entry se ON se.id = ia.entry_id
       WHERE i.fx_currency IS NULL AND de.entry_date <= ${asOf}::date
         AND se.entry_date <= ${asOf}::date
    ),
    consumed AS (
      SELECT entry_id, party_id, SUM(amount) AS amount FROM (
        SELECT document_entry_id AS entry_id, party_id, amount FROM in_scope_applications
        UNION ALL
        SELECT settling_entry_id AS entry_id, party_id, amount FROM in_scope_applications
      ) both_sides GROUP BY entry_id, party_id
    ),
    open_items AS (
      SELECT cm.party_id, cm.entry_id, COALESCE(migration_source.original_date,cm.entry_date) AS entry_date,
             (cm.movement - sign(cm.movement)::bigint * COALESCE(c.amount, 0))::bigint AS open_amount
        FROM control_movements cm
        LEFT JOIN consumed c ON c.entry_id = cm.entry_id AND c.party_id = cm.party_id
        -- Conversion GL remains on the snapshot date. Aging retains the original
        -- immutable source document/payment date; ordinary entries keep their date.
        LEFT JOIN (SELECT entry_id,min(original_issued_on) AS original_date
                     FROM migration_reference WHERE ledger_id=${ledgerId}::uuid
                     AND original_issued_on IS NOT NULL GROUP BY entry_id) migration_source
          ON migration_source.entry_id=cm.entry_id
    )' || exit 1
run npm run db:verify-aging
close; restore


# ---------------------------------------------------------------- 183
section "The invoice shows the ledger's sign to the customer" \
"One minus sign: the document prints line amounts as the LEDGER stores them
instead of as the person entered them. A consulting invoice arrives showing
-2,500.00 for the work done — the revenue credit, handed to a customer. The
detail screen made this inversion for the same reason and \`DC02\` reads the
document the customer would."
edit src/lib/customer-docs.ts \
  "      amount: asEnteredAmount(inv.direction as 'sales' | 'purchase', inv.document_kind as DocumentKind, BigInt(l.amount))," \
  '      amount: BigInt(l.amount),' || exit 1
run npm run db:verify-documents
close; restore

# ---------------------------------------------------------------- 184
section "The letterhead reads the registration as of today" \
"The GST number is looked up as at the RENDER date instead of the ISSUE date.
Nothing changes while the registration stands; the lie arrives later — a
February invoice reprinted in April carries a number the company did not have
in February, and a reprint after deregistering drops a number the original
lawfully bore. \`DC03b\` holds the issue-date reading."
edit src/lib/customer-docs.ts \
  '    companyBlock(inv.entity_id, inv.issued_on),' \
  "    companyBlock(inv.entity_id, new Date().toISOString().slice(0, 10))," || exit 1
run npm run db:verify-documents
close; restore

# ---------------------------------------------------------------- 185
section "The statement recomputes its own aging line" \
"The statement stops handing back \`aging()\`'s row and sums its items into
buckets with its own arithmetic — by DUE date, a perfectly reasonable choice
that the aging report does not make. Two documents, two answers, both
internally consistent: the report says 110,000 at 31-60 days, the letter in
the customer's hands says something else. \`DC07\` compares the two rows
figure by figure, which is the whole reason the statement CALLS the report."
edit src/lib/customer-docs.ts \
  '    agingLine: agingRow
      ? { labels: BUCKETS.map((b) => b.label), amounts: agingRow.buckets }
      : items.length > 0
        ? { labels: BUCKETS.map((b) => b.label), amounts: BUCKETS.map(() => 0n) }
        : null,' \
  '    agingLine: {
      labels: BUCKETS.map((b) => b.label),
      amounts: BUCKETS.map((b) => items.reduce((sum, i) => {
        const age = Math.round((Date.parse(asOf) - Date.parse(i.dueOn)) / 86400000)
        return age >= b.from && (b.to === null || age <= b.to) ? sum + i.balance : sum
      }, 0n)),
    },' || exit 1
run npm run db:verify-documents
close; restore

# ---------------------------------------------------------------- 186
section "The statement forgets the credit notes" \
"The items filter keeps only documents whose kind is invoice. An unspent
credit note vanishes from the letter, and the customer is asked for the gross
of their invoices while the books expect the net. The total no longer equals
the aging line either — \`DC06\` pins the list, \`DC07\` the agreement."
edit src/lib/customer-docs.ts \
  '  const items = openEntries
    .map((e) => {' \
  "  const items = openEntries
    .filter((e) => e.document_kind !== 'credit_note')
    .map((e) => {" || exit 1
run npm run db:verify-documents
close; restore


# ---------------------------------------------------------------- 187
section "The customer paper signs its lines by direction alone" \
"\`asEnteredAmount\` forgets the kind — the exact defect a review caught on the
first printed credit note: every line at −400.00 under a printed total of
+400.00, the lines summing to the negation of the document's own total, on
paper handed to a customer. \`totalOf\` keys on (direction, kind); the helper
exists so the presentation keys on the same pair, and \`DC05\` now reads a
note's LINE amounts, which no check did when the defect shipped."
edit src/lib/invoices.ts \
  'export function asEnteredAmount(
  direction: Direction, kind: DocumentKind, stored: bigint,
): bigint {
  const debitsControl = (direction === '"'"'sales'"'"') === (kind === '"'"'invoice'"'"')
  return debitsControl ? -stored : stored
}' \
  'export function asEnteredAmount(
  direction: Direction, kind: DocumentKind, stored: bigint,
): bigint {
  const debitsControl = direction === '"'"'sales'"'"'
  return debitsControl ? -stored : stored
}' || exit 1
run npm run db:verify-documents
close; restore



# ---------------------------------------------------------------- 188
section "A span P&L quietly reads only its first month" \
"The movement sum keeps only the period whose start IS the span's start —
\`>=\` becomes \`=\`. Every single-month render is untouched, so every check
written before ranges existed stays green; only a range of two or more months
shrinks, and it shrinks to a figure that looks perfectly plausible."
edit src/lib/statements.ts \
  'fp.start_date>=s.start_date' \
  'fp.start_date=s.start_date' || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 189
section "The untagged report goes back to watching only the end balance" \
"The movement arm of the check is removed — the shape it had before ranges.
An untagged account whose money washes in and out inside the range ends at
zero and vanishes from the report, while the range it moved through is missing
that money from a statement whose totals still agree."
edit src/lib/statements.ts \
  '       AND ((pb.period_id = ${periodId}::uuid AND pb.closing_balance <> 0)
         OR (fp.start_date >= span.start_date AND fp.end_date <= span.end_date
             AND pb.period_debit - pb.period_credit <> 0))' \
  '       AND pb.period_id = ${periodId}::uuid AND pb.closing_balance <> 0' || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 190
section "A closed year's P&L reads zero and nobody is told why" \
"The sentence goes; the figures were already zero. 'Last year' on a closed
year reports that the company earned nothing, every total agrees, and the only
thing that was ever wrong is the missing explanation — which is why the
explanation is guarded like a figure."
edit src/lib/statements.ts \
  '    if (closeInside) {' \
  '    if (closeInside && false) {' || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 191
section "The span trial balance adds up its closing balances" \
"The FILTER pinning \`balance\` to the END period goes, so a two-month span
sums two month-end positions into one impossible one. Movements still sum to
themselves and the screen's own total row still foots — the CSV export cannot
disagree either, because it reads the same function, which is exactly why a
check outside that function has to exist."
edit src/lib/balances.ts \
  '           COALESCE(SUM(pb.closing_balance) FILTER (WHERE pb.period_id = span.to_id), 0)::text AS balance' \
  '           COALESCE(SUM(pb.closing_balance), 0)::text AS balance' || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 192
section "GST paid becomes GST owed" \
"One word in the role map: an expense's GST now lands on the PAYABLE account.
Every entry still balances, the bank still moves the right total, and the next
GST/HST return both under-claims and over-remits — the same dollars, wrong on
both lines at once."
edit src/lib/quick.ts \
  "  expense: ROLE.gstRecoverable," \
  "  expense: ROLE.gstPayable," || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 193
section "Income posts the way an expense does" \
"The sign stops depending on the kind. A deposit CREDITS the bank and DEBITS
revenue — money recorded as leaving while it arrived. The entry balances
perfectly; only the direction of every line is wrong."
edit src/lib/quick.ts \
  "  const sign = input.kind === 'expense' ? 1n : -1n" \
  "  const sign = input.kind === 'expense' ? 1n : 1n" || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 194
section "An expense form takes expense accounts again" \
"The type gate comes back. It was here until 2026-09-07 and read like a
rule; it was a habit. A laptop bought on the company card, a loan
repayment, the financed half of a purchase — all refused by a sentence that
sounds like bookkeeping. What is still refused, and must be, is an account
that is not this company's or not postable. \`Q4f\` puts an asset on an
expense form."
edit src/lib/quick.ts \
  '    if (!pl || !pl.ok) {' \
  '    if (!pl || !pl.ok || pl.account_type !== PL_TYPE[input.kind]) {' || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 195
section "A rename stops being told about the name it takes" \
"updateParty's duplicate check goes — block 111's finding through the other
door. The rename does NOT get in; the index on the normalised name still
refuses. What is lost is the sentence naming the record you collided with,
replaced by a raw constraint violation."
edit src/lib/parties.ts \
  '         AND id <> ${input.partyId}::uuid`)
    if (existing) {' \
  '         AND id <> ${input.partyId}::uuid`)
    if (false) {' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 196
section "The delete refusal arrives as a failed query" \
"The translation goes. The party is still not deleted — 0025's trigger holds —
but the reader gets 'Failed query: DELETE FROM party' instead of how many
journal lines name them and what to do about it. A refusal that does not say
the next move teaches the reader to stop trusting refusals."
edit src/lib/parties.ts \
  "    if (text.includes('PARTY_IN_USE')) {" \
  "    if (false) {" || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 197
section "Two reports lose their seat and stay reachable only by URL" \
"Reports stops covering /aging, /statements and /breakdown. The screens still
render at their addresses, every deep link and bookmark works, and no click
path in the application reaches them — the router and the rail disagreeing
about what the application is, with nothing else holding them together."
edit $'src/lib/nav.ts' $'{ order: 15, label: \'Reports\', path: \'/reports\', group: \'books\', covers: [\'/aging\', \'/statements\', \'/breakdown\'], flyout: [' $'{ order: 15, label: \'Reports\', path: \'/reports\', group: \'books\', flyout: [' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 198
section "Picking a month throws the reader back to the top" \
"The scroll pin goes — the exact complaint that opened this batch, restored
one option at a time. The picker still navigates, the figures still update,
and every pick loses the reader's place on the page."
edit src/components/RangePicker.tsx \
  '    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })' \
  '    router.replace(qs ? `${pathname}?${qs}` : pathname)' || exit 1
run npm run db:verify-shell
close; restore


# ---------------------------------------------------------------- 199
section "The span trial balance quietly reads one month's movement" \
"The WHERE that gathers the covered months is pinned back to the end period —
the exact shape the function had to grow out of. Closing balances stay right,
debits still equal credits (any subset of whole months balances), and a
two-month range reports one month's activity under a two-month heading. Critic
round 1 found no check held the magnitude; \`T28\` now pins it to a figure."
edit src/lib/balances.ts \
  '       AND fp.start_date >= span.start_date
       AND fp.end_date <= span.end_date' \
  '       AND pb.period_id = span.to_id' || exit 1
run npm run db:verify-statements
close; restore


# ---------------------------------------------------------------- 200
section "An invoice's entry stops naming its door" \
"One word in the prefix map: entries from sales invoices go back to calling
themselves JE. Nothing else changes — the entry posts, the books balance, and
the journal stops saying which rows the invoice module wrote, which was the
entire point of the label."
edit src/lib/posting.ts \
  "  ar_invoice: 'INV'," \
  "  ar_invoice: 'JE'," || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 201
section "PST on an expense stops being part of the cost" \
"The fold goes. The bank still pays amount + GST + PST, the expense line drops
back to the pre-tax amount, and the entry no longer balances — postEntry
refuses it. What the block proves is that the refusal is CAUGHT as a red
check rather than killing the suite: a crashed suite records nothing, and a
guard nobody has watched fail is a guard on trust."
edit src/lib/quick.ts \
  "        amount: sign * (input.kind === 'expense' ? item.amount + (item.pst ?? 0n) : item.amount)," \
  "        amount: sign * item.amount," || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 202
section "PST collected drifts into the GST box" \
"The income-side PST role becomes the GST role. Every entry still balances;
the province's money sits in the CRA's account, the next GST/HST return
over-reports what was collected, and the PST return under-reports — the same
dollars wrong on two government forms at once."
edit src/lib/quick.ts \
  "const PST_INCOME_ROLE = ROLE.pstPayable" \
  "const PST_INCOME_ROLE = ROLE.gstPayable" || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 205
section "Removing lines from the cache books them on the other side" \
"The mirror stops mirroring: undoing a debit is recorded as adding a credit.
Every closing balance still agrees — net movement is unchanged — and both
movement columns quietly inflate on every edit. This is the exact defect E2
caught on the door's first run; the block keeps it caught."
edit src/lib/posting.ts \
  '    if (l.amount > 0n) t.d += l.amount; else t.c += -l.amount
    t.net += l.amount
    perAccount.set(l.accountId, t)
  }
  for (const [accountId, t] of perAccount) {
    await tx.execute(sql`
      UPDATE period_balance
         SET period_debit    = period_debit  - ${t.d},' \
  '    if (l.amount > 0n) t.c += l.amount; else t.d += -l.amount
    t.net += l.amount
    perAccount.set(l.accountId, t)
  }
  for (const [accountId, t] of perAccount) {
    await tx.execute(sql`
      UPDATE period_balance
         SET period_debit    = period_debit  - ${t.d},' || exit 1
run npm run db:verify
close; restore

# ---------------------------------------------------------------- 206
section "Every door opens from the journal side" \
"The wrong-door gate goes. An invoice's entry can now be deleted directly,
leaving the invoice pointing at nothing and still telling its story; the
document and the ledger stop having to agree."
edit src/lib/posting.ts \
  '  if (e.source_type !== ownDoor
      && !OPEN_EDIT_SOURCES.includes(e.source_type as SourceType)) {' \
  '  if (false) {' || exit 1
run npm run db:verify
close; restore

# ---------------------------------------------------------------- 207
section "The wall stops asking who is knocking" \
"0038's flag check is patched out of the database: every UPDATE is treated as
having come through the application. Raw SQL edits a live entry with no
rebalance and no audit — the exact hole the flag exists to close. Applied to
the test database; the migration file is append-only."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION forbid_posted_entry_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-posting.ts
close
blk npm run db:reset >/dev/null 2>&1
restore

# ---------------------------------------------------------------- 208
section "A deletion stops telling anyone what died" \
"The audit write goes. The entry vanishes, the cache rebalances, the number
gap remains — and the gap now points at nothing: no actor, no date, no lines.
The owner accepted gaps BECAUSE the audit row holds the whole story; without
it a gap is just a hole."
edit src/lib/posting.ts \
  '      VALUES (${actor}, '"'"'delete'"'"', '"'"'journal_entry'"'"', ${entryId},' \
  '      VALUES (${actor}, '"'"'delete_quietly'"'"', '"'"'journal_entry'"'"', ${entryId},' || exit 1
run npm run db:verify
close; restore


# ---------------------------------------------------------------- 209
section "The invoice door forgets its own name" \
"editInvoice stops telling the entry layer which door it is, so the wrong-door
gate turns the regeneration away and every edit of a posted invoice is
refused. The failure is loud — but a quieter cousin (regenerating with the
wrong source) would relabel the entry, which is why the door name is passed
rather than assumed."
edit src/lib/invoices.ts \
  '      }, actor, inv.direction === '"'"'sales'"'"' ? '"'"'ar_invoice'"'"' : '"'"'ap_bill'"'"')' \
  '      }, actor)' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 210
section "Saving an invoice quietly stops entering it" \
"The posting half of the save goes. The form still says it saved, the list
still shows the document — as a draft, in no balance and on no statement,
and nobody pressed anything that says draft. Open books made the save BE the
entry; this is the save going back on that word silently."
edit src/lib/invoice-forms.ts \
  '    const posted = await postInvoice(inv.id, actor)' \
  '    const posted = { entryId: inv.id }' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 211
section "The live cache goes back to netting a wash to nothing" \
"applyBalanceDeltas nets per account again. An entry that debits AND credits
the same account — the contra-settlement wash is a real, legal shape — lands
in the cache as no movement at all, while the journal, the rebuild, and the
integrity check all count both sides. Every closing balance agrees; the
movement columns are quietly wrong until the first side-comparing probe."
edit src/lib/posting.ts \
  '    if (l.amount > 0n) t.d += l.amount; else t.c += -l.amount
    t.net += l.amount
    perAccount.set(l.accountId, t)
  }

  for (const [accountId, t] of perAccount) {
    // Every posted account carries a row in EVERY period, so a dormant month
    // never drops the account off the balance sheet.' \
  '    t.net += l.amount
    if (t.net > 0n) { t.d = t.net; t.c = 0n } else { t.d = 0n; t.c = -t.net }
    perAccount.set(l.accountId, t)
  }

  for (const [accountId, t] of perAccount) {
    // Every posted account carries a row in EVERY period, so a dormant month
    // never drops the account off the balance sheet.' || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 213
section "An inclusive total stops reproducing itself" \
"The rounding remainder stays in the backed-out base instead of being folded,
so base + GST + PST can miss the typed total by a cent. Nobody types 100.01
to watch a penny vanish; they type a till receipt and the books disagree with
the paper in their hand."
edit src/lib/tax-rates.ts \
  '  return { base: amount - gst - pst, gst, pst, total: amount }' \
  '  return { base: base0, gst, pst, total: amount }' || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 214
section "A purchase claims its PST back after all" \
"The fold goes: the PST stays out of the cost line, and since purchases
generate no PST line either, the money simply vanishes from the document —
the bill totals less than the supplier charged, by exactly the PST."
edit $'src/lib/invoice-forms.ts' $'      ? t.base + t.pst   // the fold' $'      ? t.base' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 215
section "A generated tax line forgets who generated it" \
"The GST line the tags produce loses its provenance mark. The next edit loads
it as a line somebody typed, recomputes tax on top of it, and every save
grows the document by one more tax line — compounding quietly, one edit at a
time."
edit src/lib/invoice-forms.ts \
  "               description: 'GST', taxCode: 'OUT_OF_SCOPE', generatedFor: 'GST' })" \
  "               description: 'GST', taxCode: 'OUT_OF_SCOPE' })" || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 216
section "The edit door forgets what kind of document it is reading" \
"ledgerAmount keys on direction alone again — the exact defect the critic's
BLOCK was for. A sales credit note opened in the edit form and saved
UNCHANGED flips every line's sign, and the refusal blames the person: 'what
you have is an invoice; issue one of those instead.' Every credit-note edit
is refused; every check that only edits invoices stays green."
edit src/lib/invoice-forms.ts \
  'export function ledgerAmount(direction: Direction, kind: DocumentKind, addedToInvoice: bigint): bigint {
  const debitsControl = (direction === '"'"'sales'"'"') === (kind === '"'"'invoice'"'"')
  return debitsControl ? -addedToInvoice : addedToInvoice
}' \
  'export function ledgerAmount(direction: Direction, kind: DocumentKind, addedToInvoice: bigint): bigint {
  const debitsControl = direction === '"'"'sales'"'"'
  return debitsControl ? -addedToInvoice : addedToInvoice
}' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 217
section "The cascade stops releasing the applications" \
"releaseReferences keeps its hands off invoice_application. The delete then
hits the foreign key and dies as a raw failure — nothing is lost, but the
owner's one-action rule is gone and the refusal is a stack trace instead of
a sentence. Caught as a red check, not a dead suite."
edit src/lib/posting.ts \
  '  const apps = await tx.execute<{ id: string }>(sql`
    DELETE FROM invoice_application WHERE entry_id = ${entryId}::uuid RETURNING id::text`)' \
  '  const apps: Array<{ id: string }> = []' || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 218
section "An edit stops saying what changed" \
"The audit row's action label drifts, and E1b's read finds no 'edit' row: the
books moved, the cache moved, and the trail has a hole exactly where the
owner's open-books trade-off depends on it not having one."
edit src/lib/posting.ts \
  '      VALUES (${actor}, '"'"'edit'"'"', '"'"'journal_entry'"'"', ${entryId},' \
  '      VALUES (${actor}, '"'"'edit_quietly'"'"', '"'"'journal_entry'"'"', ${entryId},' || exit 1
run npm run db:verify
close; restore

# ---------------------------------------------------------------- 219
section "A cross-month edit leaves the later months where they were" \
"removeBalanceDeltas stops shifting the openings after the old month. Moving
an entry from May to June then double-counts it from June onward — May gave
nothing up downstream — and only a check that actually crosses the boundary
can see it."
edit src/lib/posting.ts \
  '      UPDATE period_balance pb
         SET opening_balance = pb.opening_balance - ${t.net},
             closing_balance = pb.closing_balance - ${t.net},' \
  '      UPDATE period_balance pb
         SET opening_balance = pb.opening_balance,
             closing_balance = pb.closing_balance - ${t.net},' || exit 1
run npm run db:verify
close; restore

# ---------------------------------------------------------------- 220
section "The cascade stops releasing the bank matches" \
"The other half of 217: bank_match stays, the foreign key fires, and deleting
a reconciled entry becomes a raw failure instead of the one action the owner
asked for."
edit src/lib/posting.ts \
  '  const matches = await tx.execute<{ id: string }>(sql`
    DELETE FROM bank_match WHERE entry_id = ${entryId}::uuid RETURNING id::text`)' \
  '  const matches: Array<{ id: string }> = []' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 221
section "The statement period counts its own beginning twice" \
"The report's row sum takes txn_date >= the prior statement's date instead of
strictly after it. A row dated exactly ON a statement date is inside that
statement's period and the next one's too, and the import gap moves by that row
while every row-level match stays perfectly green. M73's fixture has a row on
the boundary for exactly this."
edit src/lib/bank.ts \
  '       AND (${prior?.statement_date ?? null}::date IS NULL OR txn_date > ${prior?.statement_date ?? null}::date)`)' \
  '       AND (${prior?.statement_date ?? null}::date IS NULL OR txn_date >= ${prior?.statement_date ?? null}::date)`)' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 222
section "A statement continues from itself instead of the one before" \
"The prior-statement lookup takes <= instead of <, so every report begins at its
own printed ending. The first statement still reads perfectly — it has no prior
either way — and every later one starts from the wrong figure with an empty
period behind it."
edit src/lib/bank.ts \
  '  const prior = statements.find((st) => st.statement_date < statementDate)' \
  '  const prior = statements.find((st) => st.statement_date <= statementDate)' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 223
section "The import gap changes sign" \
"Implied minus printed instead of printed minus implied. A zero gap is zero
either way, so the complete-import case — M72, and every statement typed to
agree — stays green; only a statement that actually disagrees can tell the two
apart, and then the report sends the reader hunting in the wrong direction."
edit src/lib/bank.ts \
  '    importGap: current.ending_balance - impliedEnding,' \
  '    importGap: impliedEnding - current.ending_balance,' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 224
section "The duplicate statement arrives as a stack trace" \
"The unique-violation translation looks for a constraint that does not exist,
so typing the same date twice surfaces the driver's own error instead of the
sentence that says delete-and-re-enter. The insert is still refused — the
database holds — but the person is handed a Failed query."
edit src/lib/bank.ts \
  "    if (msg.includes('bank_statement_account_id_statement_date_key')) {" \
  "    if (msg.includes('bank_statement_some_other_key')) {" || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 225
section "The report calls every import complete" \
"The verdict keys on >= 0 instead of === 0. A statement whose printed balance
exceeds what the rows imply — a deposit never imported, the commonest miss —
gets the quiet green sentence, and the one line this feature exists to shout is
shown only for gaps in the other direction."
edit "src/app/ledger/[ledgerId]/bank/[accountId]/StatementReportView.tsx" \
  '      {report.importGap !== 0n && (' \
  '      {report.importGap < 0n && (' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 226
section "The report drops the book-side summary" \
"The shared Summary stops being rendered on the statement report. The import
check above it stays right, so the page still looks like a report — but the
four-part explanation of the book difference, the half that says what is still
outstanding, is simply gone, and nothing else on the page says it."
edit "src/app/ledger/[ledgerId]/bank/[accountId]/StatementReportView.tsx" \
  '      <Summary recon={report.recon} />' \
  '      {null}' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 227
section "Every journal line quietly loses its party on the way in" \
"The form reader stops handing the per-line party over. The select is on the
screen, the ledger column exists and P10 watches it hold what it is given —
but everything typed through the journal form arrives with no party at all,
and aging by party silently stops seeing manual entries. The reader is the
one seam between the screen's JSON and the lib, and it is the seam this
mutation cuts."
edit src/lib/forms.ts \
  '      partyId: row.partyId || undefined,' \
  '      partyId: undefined,' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 228
section "The general ledger opens every account on the wrong side" \
"Opening = closing minus net movement, and the mutation swaps the net. Any
account whose debits equal its credits — the quiet ones — still opens right,
and every other account opens wrong by exactly twice its movement. X16 holds
opening + the shown rows to the closing balance, across two different readers
(period_balance for the summary, journal_line for the rows), so the swap has
nowhere to hide."
edit src/lib/reports.ts \
  '    const opening = closing - (debit - credit)' \
  '    const opening = closing - (credit - debit)' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 229
section "Every PDF prints its first column and nothing else" \
"The one table writer draws only cell zero. Labels survive, so the file still
looks like a report at a glance — and every figure on every generated PDF is
gone. The checks read the files back independently (pdf-text decodes the TJ
arrays) and expect the money."
edit src/lib/pdf.ts \
  '    row.cells.forEach((cell, i) => {' \
  '    row.cells.slice(0, 1).forEach((cell, i) => {' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 230
section "The second profit and loss quietly comes back" \
"The owner kept ONE P&L (2026-09-02, by nature). Drop the filter and the
by-function template is offered again everywhere statements are listed — the
reopened decision the repo's discipline names. X24 counts the income
statements on offer and names the survivor."
edit src/lib/statements.ts \
  "       AND code <> 'IFRS_PL_FUNCTION_EN'" \
  "       AND code <> 'NO_SUCH_TEMPLATE'" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 231
section "The trial balance PDF forgets its own total" \
"The totals row is dropped. Every account line is still right, so a reader
adding the column by hand finds nothing wrong — the file just stops carrying
the figure that lets them NOT add the column by hand. X17 expects the total
the accounts imply."
edit src/lib/pdf-reports.ts \
  "        { cells: ['', 'Total', money(totals.debit), money(totals.credit), money(totals.closing)]," \
  "        { cells: ['', '', '', '', '']," || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 232
section "The reconciliation PDF drops the four-part summary" \
"The import check stays; the book-side split goes. The paper still opens with
the gap, so it reads complete — but what explains the difference between
statement and books is exactly the half that vanished, and M77 expects its
rows on the page."
edit src/lib/pdf-reports.ts \
  '    blocks.push(twoCol(reconciliationParts(report.recon).map(([label, amount, why]) => (' \
  '    blocks.push(twoCol([].map(([label, amount, why]) => (' || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 233
section "The invoice PDF bills the total as the balance due" \
"A part-paid invoice's PDF says the customer owes the full amount again. The
total line is right, the payments are listed — and the one figure a customer
acts on contradicts both. DC10 holds the PDF to the renderer's balance, and
the fixture is part-paid so total and balance differ."
edit src/lib/invoice-pdf.ts \
  '  const paper = invoicePaper(invoice)' \
  '  const paper = invoicePaper({ ...invoice, balance: invoice.total })' || exit 1
run npm run db:verify-documents
close; restore

# ---------------------------------------------------------------- 234
section "The general ledger PDF starts every account at nothing" \
"The opening-balance row is dropped. The rows and the closing line survive, so
an account that started the span at zero prints identically — and every
account that carried a balance in loses the line that says so. X19 expects
the opening on paper."
edit src/lib/pdf-reports.ts \
  "        { cells: ['', '', 'Opening balance', '', '', '', money(a.opening)], bold: true }," \
  "        { cells: ['', '', '', '', '', '', ''] }," || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 235
section "The register PDF prints its headings over an empty table" \
"Title, statutory notes, column headers — everything that makes the file look
like a register survives; the rows do not. A director asking for the paper
copy gets a well-formed page that names nobody. CR21 reads the file back and
expects every cell the renderer decided."
edit src/modules/records/reports.ts \
  '      rows: r.rows.map((cells) => ({ cells: [...cells] })),' \
  '      rows: [],' || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 236
section "The public register omits quietly instead of out loud" \
"The withheld-fields note is dropped from the PDF. The public copy already
hides the private columns — rightly — and now nothing on the paper says
anything WAS hidden, so an incomplete register reads as a complete one. CR21b
expects the omission named."
edit src/modules/records/reports.ts \
  "      \`Withheld from this audience: \${r.withheld.join(', ')}.\` })" \
  "      \`\` })" || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 237
section "A total line's breakdown forgets which way the statement reads" \
"The parent's sign flip is dropped from every formula term, so the breakdown
of TOTAL LIABILITIES AND EQUITY presents its terms with the ledger's raw
signs while the statement shows the flipped figure. Each sibling amount looks
plausible alone; only the column refusing to add to the number that was
clicked gives it away, and X25 adds that column for every line."
edit src/lib/breakdown.ts \
  '        cells: [t(sibling.label), m(flip * term.sign * sibling.raw)],' \
  '        cells: [t(sibling.label), m(term.sign * sibling.raw)],' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 238
section "An aging cell collects its own bucket and every older one" \
"The bucket filter slackens from equality to at-least. The 0-30 cell's
breakdown quietly absorbs the 61-90 entry, its total grows past the matrix
cell it claims to explain, and every row it lists is genuinely open — nothing
about the rows looks wrong. X27 compares every cell against the matrix the
screen printed."
edit src/lib/breakdown.ts \
  '    (bucketIndex === null || bucketOf(ageOf(e.entry_date, asOf)) === bucketIndex))' \
  '    (bucketIndex === null || bucketOf(ageOf(e.entry_date, asOf)) >= bucketIndex))' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 239
section "The account breakdown loses its first entry row" \
"One slice(1) and the earliest posted line in the range is gone. Opening and
closing still print, the running balances of the remaining rows are still
each true, and the table reads cleanly - it just no longer walks from opening
to closing. X26 redoes that walk from the cells; X29 redoes it from the CSV."
edit src/lib/breakdown.ts \
  "    ...(one?.rows ?? []).map((r) => ({" \
  "    ...(one?.rows ?? []).slice(1).map((r) => ({" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 240
section "The tax breakdown prints raw amounts instead of contributions" \
"The exact defect the contribution column was invented for (tax.ts, the
corrected-invoice story), reintroduced at the new exit: each entry shows its
ledger magnitude, a reversal looks like an addition, and the column no longer
adds to the line on the return. X28 adds it."
edit src/lib/breakdown.ts \
  '                t(e.accountCode, true), m(e.contribution)],' \
  '                t(e.accountCode, true), m(BigInt(e.amount))],' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 241
section "The breakdown CSV keeps only its bold rows" \
"The data rows vanish from the file; the title, the headings and the closing
line survive, so the file opens looking finished. A reader who trusts the
bottom line is fine - one who re-adds the rows, which is the point of
exporting them, gets a different number. X29 is that reader."
edit src/lib/exports.ts \
  "  for (const r of b.rows) {
    rows.push(r.cells.map((c) => ('money' in c ? csvMoney(c.money) : c.text)))
  }" \
  "  for (const r of b.rows.filter((x) => x.bold)) {
    rows.push(r.cells.map((c) => ('money' in c ? csvMoney(c.money) : c.text)))
  }" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 242
section "The breakdown PDF is a title over an empty table" \
"Every row is dropped at the PDF exit only; the overlay and the CSV still
show them, so clicking around the screen finds nothing wrong. X30 reads the
file back and expects the rows and the figure."
edit src/lib/pdf-reports.ts \
  "    rows: b.rows.map((r) => ({
      cells: r.cells.map((c) => ('money' in c ? money(c.money) : c.text)),
      bold: r.bold, rule: r.rule,
    }))," \
  "    rows: []," || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 243
section "An untouched account has no breakdown at all" \
"The fallback lookup for an account the span's balances never met is removed.
Clicking the zero gets 'nothing to break down' - a dead end exactly where a
person is asking why a figure is zero. X26b clicks it."
edit src/lib/breakdown.ts \
  '  const [acct] = one
    ? [one.account]
    : await db.execute<{ id: string; code: string; name: string }>(sql`
        SELECT a.id::text, a.code, a.name
          FROM account a JOIN ledger l ON l.entity_id = a.entity_id
         WHERE a.id = ${accountId}::uuid AND l.id = ${ledgerId}::uuid`)' \
  '  const [acct] = one
    ? [one.account]
    : ([] as Array<{ id: string; code: string; name: string }>)' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 244
section "Owed-by-nobody lists everybody instead" \
"The party-less filter flips, so the unattributed breakdown lists exactly the
entries that ARE attributed. Every row shown is a real receivable and the
page looks perfectly healthy; only the total refusing to match the figure
that was clicked says otherwise. X27b pins that figure."
edit src/lib/breakdown.ts \
  '         AND jl.party_id IS NULL' \
  '         AND jl.party_id IS NOT NULL' || exit 1
run npm run db:verify-exports
close; restore


# ---------------------------------------------------------------- 245
section "The year-so-far breakdown forgets the expenses" \
"The one query in breakdown.ts that cannot reuse its report's reader — the
renderer keeps a single SUM, this groups it — drops 'expense' from its
predicate. Every row it still lists is a true revenue figure; the column just
no longer re-adds to the profit line the person clicked, which is exactly the
drift a second spelling invites and why X25 adds the column for every line."
edit src/lib/breakdown.ts \
  "       AND a.account_type IN ('revenue','expense')" \
  "       AND a.account_type IN ('revenue')" || exit 1
run npm run db:verify-exports
close; restore


# ---------------------------------------------------------------- 246
section "A balance with no from explains only its own month" \
"The missing-from fallback resolves to \`to\` instead of the books' first
period. The drill behind every closing figure quietly becomes 'opening
20,000, closing 20,000' for any quiet month — the exact useless page the
owner reported — while every row it does show is true. X31 demands the zero
opening and the whole history."
edit src/lib/breakdown.ts \
  '  const fromDate = from ?? await firstBookDay(ledgerId) ?? undefined' \
  '  const fromDate = from ?? to' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 247
section "A statement position row drills into a window again" \
"The account link under a balance-sheet line carries the statement's own
range regardless of basis — the shape this feature replaced. Over a Feb–Mar
statement the receivables drill opens at February's opening and January's
800.00 is silently inside it. X31b feeds the link's own address back into
the derivation and demands the zero opening."
edit src/lib/breakdown.ts \
  "            ...(l.valueBasis === 'period_movement' ? { from } : {})," \
  "            from," || exit 1
run npm run db:verify-exports
close; restore


# ---------------------------------------------------------------- 248
section "The trial balance quietly loses its All time button" \
"One prop dropped and the report is back to four calendar presets; every
range still works, every figure still drills, and the whole-history view the
owner asked for is simply gone. N6 reads the wiring at both ends."
edit 'src/app/ledger/[ledgerId]/reports/trial-balance/page.tsx' \
  '        <RangePicker from={from} to={to} today={today} allFrom={allFrom ?? undefined} />' \
  '        <RangePicker from={from} to={to} today={today} />' || exit 1
run npm run db:verify-shell
close; restore


# ---------------------------------------------------------------- 250
section "The quick form reads only the first row" \
"One slice and every receipt is its first item again — the exact complaint
this feature answered. The single-row path still works, the posted entry
balances, and the second row's money simply never arrives. Q9 posts two rows
and counts what landed."
edit src/lib/quick-forms.ts \
  '    const indices = lineIndicesIn([...f.keys()])' \
  '    const indices = lineIndicesIn([...f.keys()]).slice(0, 1)' || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 251
section "The party dropdown quietly shuts directors out again" \
"The old vocabulary sneaks back as a filter on the dropdown query alone: the
database would accept the director, but no screen ever offers one. P15b asks
the same list the entry screens ask."
edit src/lib/parties.ts \
  "      FROM party p JOIN party_role pr ON pr.party_id = p.id
      JOIN party_role_definition rd ON rd.code = pr.role AND rd.transacts" \
  "      FROM party p JOIN party_role pr ON pr.party_id = p.id
      JOIN party_role_definition rd ON rd.code = pr.role AND rd.transacts
        AND rd.code IN ('customer', 'supplier', 'employee')" || exit 1
run npm run db:verify-parties
close; restore


# ---------------------------------------------------------------- 252
section "The GST line carries only the last item's tax" \
"The reduce forgets its accumulator, a one-character slip. With one taxed
item nothing changes — every original check stays green — and a receipt
whose items BOTH carry GST posts an entry that no longer balances and is
refused. Q8 taxes two items and pins the one summed line."
edit src/lib/quick.ts \
  '  const gst = items.reduce((s, i) => s + (i.gst ?? 0n), 0n)' \
  '  const gst = items.reduce((s, i) => (i.gst ?? 0n), 0n)' || exit 1
run npm run db:verify-quick
close; restore


# ---------------------------------------------------------------- 253
section "The receipt is filed under one account and nobody notices" \
"treePaths keeps only the first touched account. The expense folder has the
receipt, the bank folder silently does not, and every upload still succeeds —
the exact half-filed state the per-entry binding exists to prevent. AT1 looks
in EVERY touched account's folder; AT7's sweep counts what a rebuild lays
down."
edit src/lib/attachments.ts \
  '  return accounts.map((a) =>' \
  '  return accounts.slice(0, 1).map((a) =>' || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 254
section "The integrity sweep stops reading the bytes" \
"The hash comparison is skipped. Every file 'checks out' forever, including
the one a sync tool half-wrote and the one somebody edited — the sweep is
the only reader that ever re-hashes, so with it blind, corruption is
permanent and silent. AT3 tampers with a blob and expects to be caught."
edit src/lib/attachments.ts \
  '    if (sha !== a.sha256) {' \
  '    if (false) {' || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 255
section "The reminder chases nothing" \
"The no-attachment condition falls out of missingReceipts, so the reminder
either lists every expense forever or none once each has any history — either
way it stops meaning 'this one lacks its paper'. AT4 files the paper and
expects the entry to leave the list."
edit src/lib/attachments.ts \
  '       AND NOT EXISTS (SELECT 1 FROM attachment at WHERE at.entry_id = je.id)' \
  '       AND true' || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 256
section "Unfiling one entry shreds the paper itself" \
"Detach deletes the blob too. The OTHER entry sharing the receipt now points
at nothing; the books still list the attachment and the store cannot produce
it. AT6 unfiles one of two bindings and expects the blob and the other
binding to survive."
edit src/lib/attachments.ts \
  '  const accounts = await entryAccounts(row.entry_id,on)' \
  '  await fs.rm(blobPath(entry.entity, row.sha256), { force: true })
  const accounts = await entryAccounts(row.entry_id,on)' || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 257
section "The store files by name as well as content" \
"The filename leaks into the blob's identity, so the same receipt under two
names is stored twice — the duplication the whole design exists to end, and
nothing about any single upload looks wrong. AT2 counts the physical files."
edit src/lib/attachments.ts \
  '  const file = await findBlob(entry.entity, sha, input.filename)' \
  "  const file = (await findBlob(entry.entity, sha, input.filename)) + path.extname(input.filename).toLowerCase()" || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 258
section "A closed month starts refusing paper" \
"A well-meaning gate: the period is closed, so the upload is refused. But an
attachment changes no figure, and receipts are late by nature — the gate
just guarantees the paper never gets filed. The owner chose a reminder over
a gate (2026-09-02), and AT5 files into a closed month on purpose."
edit src/lib/attachments.ts \
  "  const sha = createHash('sha256').update(input.bytes).digest('hex')
  const file = await findBlob(entry.entity, sha, input.filename)" \
  "  if (entry.period_status === 'closed') {
    throw new AttachmentError('PERIOD_CLOSED', 'The month is closed.')
  }
  const sha = createHash('sha256').update(input.bytes).digest('hex')
  const file = await findBlob(entry.entity, sha, input.filename)" || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 259
section "The starter chart ships a roleless revenue account" \
"One template row loses its role. The import still succeeds — untagged is
legal for a person building their own chart — and every dollar of sales in a
NEW company reaches no statement line: the books balance, the P&L is short
by all of revenue, and nothing anywhere looks wrong. A26b refuses a roleless
template row."
edit src/lib/starter-chart.ts \
  '8000,Sales of goods and services,revenue,,revenue_from_contracts' \
  '8000,Sales of goods and services,revenue,,' || exit 1
run npm run db:verify-accounts
close; restore

# ---------------------------------------------------------------- 260
section "Tax registration slides back to the pre-GIFI codes" \
"The proposal vocabulary regresses to 2100/1300. Every new company that
registers gets accounts beside the template's 2680/1066 instead of reusing
them — two spellings of one tax position, born on day one. R26b pins the
fresh-chart proposals; A26c pins the reuse."
edit src/lib/registrations.ts \
  "    code: free(tax === 'GST_HST' ? '2680' : '2681')," \
  "    code: free(tax === 'GST_HST' ? '2100' : '2681')," || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 261
section "Retained earnings drifts off its GIFI item" \
"3600 becomes the old 3100. Everything still works — roles drive the
statements, not codes — and at tax time the one-to-one mapping the template
exists for has a hole where retained earnings should be. A26 keeps a short
list of anchor codes for exactly this quiet class."
edit src/lib/starter-chart.ts \
  '3600,Retained earnings,equity,,retained_earnings' \
  '3100,Retained earnings,equity,,retained_earnings' || exit 1
run npm run db:verify-accounts
close; restore


# ---------------------------------------------------------------- 262
section "The waiver stops meaning anything" \
"The reminder forgets to honour receipt_waiver. Every salary run and bank
fee the owner skipped is back on the banner forever, and the skip button
still 'works' — it writes its row, audited and all, into a table nothing
reads. AT11 waives an entry and expects the chase to end."
edit src/lib/attachments.ts \
  '       AND NOT EXISTS (SELECT 1 FROM receipt_waiver rw WHERE rw.entry_id = je.id)' \
  '       AND true' || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 263
section "Corporate records loses a register from its flyout" \
"One flyout entry gone. Every register still renders at its address, the
records page still links them, and the hover menu the owner asked for is
quietly a third smaller. N7 pins the vocabulary."
edit src/modules/records/manifest.ts \
  "    { label: 'Transparency Register', path: '/records/register/transparency' }," \
  "" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 264
section "The Add menu loses its expense door" \
"The most-used door falls out of the Add flyout; /expenses still answers,
the rail seat still shows, and the one-hover path the owner asked for is
gone. N7 counts the doors by name."
edit src/lib/nav.ts "{ order: 3, label: 'Expense', path: '/entries/quick/expense' }," '' || exit 1
run npm run db:verify-shell
close; restore


# ---------------------------------------------------------------- 265
section "The browse rows carry the whole entry instead of its expense side" \
"The account-type filter falls off the aggregate, so every row's amount is
the entry's balanced total: zero. The grouping still looks right, every
entry still shows, and the page sums to nothing while the trial balance
holds the real movement. X32 adds the two readers against each other."
edit src/lib/browse.ts \
  '           COALESCE(SUM(jl.amount) FILTER (WHERE a.account_type = ${accountType}::account_type), 0)::text AS amount,' \
  '           COALESCE(SUM(jl.amount), 0)::text AS amount,' || exit 1
run npm run db:verify-exports
close; restore


# ---------------------------------------------------------------- 266
section "The securities register forgets when a holder ceased" \
"The CASE that derives 'date ceased' from a zero balance flattens to NULL.
Every former holder still shows — with a dash where BC's template demands a
date — and every current figure is untouched. CR22 and CR23 walk both roads
to zero (transfer and cancellation) and read the date back."
edit src/lib/records.ts \
  '           CASE WHEN SUM(t.delta) = 0 THEN MAX(t.on_date)::text END AS ceased_on' \
  '           NULL::text AS ceased_on' || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 267
section "The transparency register quietly drops former SIs again" \
"A filter slips back in and ceased significant individuals vanish from the
register — the exact shape this node replaced, where the BCA wants them kept
for six years with their dates. CR24 expects the ceased row, dated."
edit src/lib/registers.ts \
  '  const sis = (await allSignificantIndividuals(entityId))' \
  '  const sis = (await allSignificantIndividuals(entityId)).filter((s) => !s.ceased_on)' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 268
section "The new date columns go public again" \
"0048's visibility rows flip to public — the CSR's dates show beside a
withheld name and holding, and the transparency register hands a lone
Ceased column to anyone who asks. Mutated in 0048 because it OWNS those
rows (the 0045 lesson: a mutation aimed at a file an later migration
re-issues is silently healed). CR25 renders both registers as the public
and refuses the columns."
edit db/migrations/0048_new_columns_learn_the_old_discretion.sql \
  "  ('transparency',       'ceased_on',  'private'),
  ('central_securities', 'became_on',  'private'),
  ('central_securities', 'ceased_on',  'private');" \
  "  ('transparency',       'ceased_on',  'public'),
  ('central_securities', 'became_on',  'public'),
  ('central_securities', 'ceased_on',  'public');" || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 269
section "The one date field stops being a date field" \
"DateInput renders type=\"text\" again. Every date box in the application
still accepts a typed yyyy-mm-dd, still submits, still validates server-side
— and not one of them opens a calendar, which is the whole complaint this
node answers. Nothing about the DATA changes, so only a check that reads the
rendered field can see it: N8."
edit src/components/DateInput.tsx \
  '      type="date"' \
  '      type="text"' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 270
section "One screen goes back to typing its dates" \
"The register's 'As at' box becomes a plain input — one screen out of
seventeen, which is exactly how this defect spreads: not all at once, but
one field at a time as new screens are written. N8 asks every date-shaped
field NAME which tag carries it, so a single regression is a red line."
edit 'src/app/ledger/[ledgerId]/records/register/[kind]/page.tsx' \
  '            <DateInput name="asOf" defaultValue={asOf}' \
  '            <input name="asOf" defaultValue={asOf}' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 271
section "The browse table's columns stop agreeing with its rows" \
"The amount column loses its header. Every figure is still right and every
row still complete — the header just declares one column fewer than the rows
carry, which is the ragged-columns defect from the other end. V111 compares
the rendered header against every rendered row rather than trusting either."
edit $'src/components/PartyGroups.tsx' $'              <th title={moneyTitle} aria-sort={sort?.key === \'amount\' ? sort.direction : undefined} className="w-32 pb-1 pl-3 text-right text-xs font-medium uppercase tracking-wide text-neutral-500">\n                {sortableAmounts ? sortControl(\'amount\', moneyLabel) : moneyLabel}\n              </th>' $'              {null}' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 272
section "The expenses browse shows OUR number as theirs" \
"The coalesce flips, so a bill browses under the number we filed it as
instead of the supplier's own. The column is full, the heading still says
\"Their invoice #\", and every figure ties — the one thing wrong is the
identity of the number, which is the only thing the column is for. V112
pins a bill carrying both numbers and names which one must show."
edit src/lib/browse.ts \
  "                    THEN COALESCE(NULLIF(btrim(i.their_ref), ''), NULLIF(btrim(i.number), ''))" \
  "                    THEN COALESCE(NULLIF(btrim(i.number), ''), NULLIF(btrim(i.their_ref), ''))" || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 273
section "An entry that is its own document loses its number" \
"The browse reads the invoice's number only, so every quick expense and
every journal entry — the receipts, which are most of them — shows a dash
where its number was recorded. Bills keep theirs, so the column still looks
populated on any page with a bill on it. X33 posts an entry that IS its own
document and reads the number back."
edit src/lib/browse.ts \
  '           COALESCE(doc.ref, je.document_ref) AS doc_ref' \
  '           doc.ref AS doc_ref' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 274
section "The other side's number gets a second home" \
"0049's CHECK goes away, and an entry raised by an invoice may keep its own
copy of a number the invoice already holds. Two homes, and the browse's
COALESCE silently prefers one — so the day they disagree, the page shows the
stale one and nothing anywhere says which is right. Mutated in 0049 because
that migration OWNS the constraint (the 0045 lesson). X33 asks for the
refusal by the constraint's own name."
edit db/migrations/0049_the_other_sides_number_lives_where_the_document_does.sql \
  "ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_document_ref_has_one_home
  CHECK (document_ref IS NULL OR source_type NOT IN ('ar_invoice', 'ap_bill'));" \
  '-- constraint removed by mutation' || exit 1
run npm run db:verify-exports
close; restore


# ---------------------------------------------------------------- 275
section "The calendar stops opening when the field is clicked" \
"\`showPicker()\` goes away. The field is still a native date box — it still
validates, still submits yyyy-mm-dd, still shows Chrome's own 12-pixel icon
at its right edge — and clicking the field, which is what a person actually
does, does nothing. N8 CALLS the component and calls the element's onClick
with a stand-in field, so it can see this; its first version grepped the
source for the string, which the file's own doc comment satisfied (critic,
2026-09-03, who applied this very mutation and watched the check pass)."
edit src/components/DateInput.tsx \
  '        try { e.currentTarget.showPicker() } catch { /* no gesture, or no picker */ }' \
  '        // the picker is no longer opened' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 276
section "The entry form's header forgets the document number" \
"\`entryHeaderFrom\` stops reading it, so all four doors that post the journal
form — save, post, edit, amend — go back to dropping it. The amend door is
the one that shows: the Correct panel offers an editable box, accepts the
correction, and re-posts the ORIGINAL number in silence, because amendEntry
inherits what the person just changed. X34 corrects a receipt's number and
reads the replacement back."
edit src/lib/forms.ts \
  '    documentRef: documentRefFrom(f),' \
  '    documentRef: undefined,' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 277
section "The document number rule forgets who raised the paper" \
"\`documentNumber\` prefers OUR number on both directions. Every column stays
full and every sales invoice is unaffected, so the invoice list looks
perfect; only a bill changes, and only against the OTHER reader — the
expenses browse still shows the supplier's number, because that rule lives
in SQL. One bill, two numbers, two pages. V113 holds the two languages of
the rule against each other over every document in the fixture."
edit src/lib/doc-number.ts \
  "  return doc.direction === 'purchase' ? theirs ?? ours : ours ?? theirs" \
  '  return ours ?? theirs' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 278
section "The register keeps its particulars to itself again" \
"The second table stops being built. The holdings summary is unchanged and
correct, every date column still prints, and the half of s.111(1) that asks
for the DATE AND PARTICULARS of each issue and transfer is back in the
table and on no page — which is exactly the state the owner found it in.
CR27 reads the section and ties its balances to the summary; CR31 asks the
PDF for the same thing."
edit src/lib/registers.ts \
  "    const detail: RegisterTable | undefined = allowed('particulars')" \
  "    const detail: RegisterTable | undefined = (false as boolean)" || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 279
section "The running balance runs across every holder" \
"The window loses its holder from the PARTITION, so each line shows the
class's running total instead of that holder's. Every row is present, every
date and certificate is right, and the Balance column quietly answers a
different question — the one thing a reader uses it for is \"what did this
shareholder hold at the time\". CR27 ties the last balance per holder to
the holding in the summary above."
edit src/lib/records.ts \
  '           SUM(t.delta) OVER (PARTITION BY t.share_class_id, t.party_id' \
  '           SUM(t.delta) OVER (PARTITION BY t.share_class_id' || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 280
section "The holder's address goes public" \
"0050's visibility row flips, and a public inspection copy of the central
securities register carries every shareholder's home address beside a
withheld name. Mutated in 0050 because that migration OWNS the row (the
0045 lesson). CR28 renders the register for the public and refuses it."
edit db/migrations/0050_the_register_prints_its_particulars.sql \
  "  ('central_securities', 'address',      'private')," \
  "  ('central_securities', 'address',      'public')," || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 281
section "The register goes back to saying nothing about later movements" \
"movementsAfter always answers zero. Every register renders exactly as it
does today, minus one sentence — and a movement dated after the day you
asked about is invisible with nothing to say it exists. This is the owner's
buy-back that appeared to do nothing (2026-09-03): the write was right, the
read was right, and the silence was the defect. CR29 records a later
movement and demands the sentence."
edit src/lib/records.ts \
  '  return { count: Number(row?.n ?? 0), earliest: row?.earliest ?? null }' \
  '  return { count: 0, earliest: null }' || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 282
section "The confirmation stops mentioning that the date is ahead" \
"The future arm of the message goes away, so recording a movement for next
month answers with a cheerful sentence and no hint that today's register
will not show it. The other half of the same silence, at the other end of
the same click. CR30 posts a form dated 2099 and reads the message back."
edit src/lib/record-forms.ts \
  '  return onDate > today' \
  '  return false && onDate > today' || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 283
section "A transfer forgets who it was with" \
"The paired-row lookup matches the row itself, so every transfer reads
\"Transfer from\" its own holder. The section still prints, the balances
still add up, and the particular the Act actually asks for — from whom —
is a tautology. CR27 pins both directions by name."
edit src/lib/records.ts \
  '             WHERE o.transfer_group = t.transfer_group AND o.id <> t.id' \
  '             WHERE o.transfer_group = t.transfer_group AND o.id = t.id' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 284
section "The balance certificate goes to the wrong hands" \
"On a transfer, the certificate the transferor SURRENDERS and the balance
certificate they get BACK swap places. Both numbers are on the page, on the
right row, in the wrong columns — a minute book that says the certificate
just cancelled is the one the holder still has. CR32 records a partial
transfer with all three certificate numbers and reads each one back off the
row whose holder it belongs to."
edit src/lib/records.ts \
  '                ${blank(input.consideration)}, ${blank(input.balanceNo)},
                ${blank(input.surrenderedNo)}, ${input.actor}),' \
  '                ${blank(input.consideration)}, ${blank(input.surrenderedNo)},
                ${blank(input.balanceNo)}, ${input.actor}),' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 285
section "A tab reloads itself every time you click something in it" \
"The frame's src is fed from the tab's CURRENT url instead of the one it
opened with. React then sets src again on every navigation, so each click
inside a tab reloads that tab from scratch — losing the scroll position, the
half-typed expense, and the whole point of having tabs. Everything still
works; it just forgets. N11 reads the wiring, because a check here has no
browser to click in."
edit src/components/Desk.tsx \
  '          <iframe key={t.id} src={t.openedAt}' \
  '          <iframe key={t.id} src={t.href}' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 286
section "A hidden tab is thrown away instead of hidden" \
"Only the active tab is rendered. The strip still shows every tab and every
one still opens — from the beginning, each time, because the frame was
unmounted while it was out of sight. This is the same loss as 285 by the
other road, and it is what makes 'keep two companies open' untrue. N11
counts the frames in the markup, not the tabs in the strip."
edit src/components/Desk.tsx \
  '        {[...tabs].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).map((t) => (
          <iframe key={t.id}' \
  '        {tabs.filter((t) => t.id === active).map((t) => (
          <iframe key={t.id}' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 287
section "Every tab is called Overview" \
"The tab label stops asking the nav definition which seat a url belongs to
and always finds the first one. Tabs still open, still switch, still hold
their pages — and the strip stops being readable, which is the only thing a
strip is for. N9 asks every seat in LEDGER_NAV to name its own tab."
edit src/lib/tabs.ts \
  '  const item = seat === null ? undefined : LEDGER_NAV.find((i) => i.path === seat)' \
  "  const item = LEDGER_NAV.find((i) => i.path === '')" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 288
section "The tabs stop following the pages inside them" \
"The location watch goes away. Next navigates inside a frame without
reloading the document, so nothing else tells the desk where a tab went:
every tab keeps the label it opened with, forever, and + opens a new tab in
whatever company the ACTIVE tab was in when it opened rather than where it
is now. The first version of this desk shipped exactly this and the browser
pass caught it. N11 reads the wiring."
edit src/components/Desk.tsx \
  '    const timer = setInterval(read, 500)' \
  '    const timer = 0' || exit 1
run npm run db:verify-shell
close; restore


# ---------------------------------------------------------------- 289
section "A payment counts as money spent as well as money moved" \
"Payment rows carry the entry's own amount into the profit-and-loss column.
Every figure on the page is a real figure and the party subtotal doubles: a
1,000 bill and the 1,000 that paid it become 2,000 of something. This is the
whole reason the merged page has two columns instead of one, and it is
invisible to anything that checks a single row. V114 sums the merged page
against the reader the trial balance is tied to."
edit src/lib/browse.ts \
  '      pl_amount: null,
      unpaid: null,
    })
  }

  for (const d of unposted) {' \
  "      pl_amount: '100000',
      unpaid: null,
    })
  }

  for (const d of unposted) {" || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 290
section "The unpaid column shows the whole debt again" \
"The page reads the document's ORIGINAL amount instead of what is left of
it, so a bill paid in full still reads as fully owed. Every number is a
number that exists, the column is full, and the one thing it is for — what
is actually still owed — is wrong for every settled document. V115 holds the
page against payments.ts's own answer, document by document."
edit src/lib/browse.ts \
  '    SELECT bal.invoice_id, i.entry_id::text, i.document_kind, bal.balance::text' \
  '    SELECT bal.invoice_id, i.entry_id::text, i.document_kind, bal.debt::text AS balance' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 291
section "Drafts go back to being invisible" \
"The documents that never reached the books stop being fetched. A draft bill
is then in the database, on nobody's page, and findable only by remembering
it exists — the state the invoice list used to cover and nothing covers once
it is gone. V115 requires unposted paper to be on the page."
edit src/lib/browse.ts \
  "       AND i.status <> 'posted'" \
  "       AND i.status = 'never'" || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 292
section "Every row opens its entry, documents included" \
"A document row links to the journal entry it raised instead of to the
document. Every link works, every destination is a real page, and the
invoice pages become unreachable by clicking — with the seat already gone,
that is the whole document family orphaned. N12 asks the screen that claims
the rows whether it still opens one; V60 reads each rendered row's own
href. The first version of this block ran ONE command with the second suite as stray arguments to the first, so V60 never ran; N12 stopped covering the screen when invoices got their seat back, and toothless found the block turning nothing red (2026-09-05)."
edit $'src/app/ledger/[ledgerId]/PartyLedgerScreen.tsx' $'              ? invoiceHref(ledgerId, direction === \'in\' ? \'sales\' : \'purchase\', r.href.id)' $'              ? `/ledger/${ledgerId}/entries/${r.href.id}`' || exit 1
run npm run db:verify-shell
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 293
section "The certificate prints the figures without the words" \
"The share count in words comes off the certificate. It still says 120, it
still matches the register, and it has lost the only thing that makes
altering the figure pointless — which is why every certificate ever printed
carries both. CR34 asks the paper for the number twice, once each way."
edit src/lib/certificate.ts \
  '    + ` is the registered holder of ${inWords(facts.shares)} (${facts.shares})`' \
  '    + ` is the registered holder of ${facts.shares}`' || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 294
section "The number in words loses its and" \
"\`one thousand and five\` becomes \`one thousand five\`. Every certificate
still carries words beside its figures and the words are still nearly right,
which is the shape of this defect: nobody reads them closely until a lawyer
does. CR36 spells the awkward numbers — the teens, the tens, a hundred and
something, a thousand and something — and compares."
edit src/lib/certificate.ts \
  "      const joiner = rest === 0n ? '' : rest < 100n ? ' and ' : ' '" \
  "      const joiner = rest === 0n ? '' : ' '" || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 295
section "A holder with nothing gets a certificate anyway" \
"The guard on a zero holding goes, so the day after their shares are bought
back a former holder can still be handed paper saying they hold some. The
register says zero, the certificate says otherwise, and the certificate is
the copy that leaves the building. CR35 asks for one as at the day after a
cancellation and requires a refusal."
edit src/lib/certificate.ts \
  '  if (!holding || BigInt(holding.holding) <= 0n) return null' \
  '  if (!holding) return null' || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 296
section "One certificate speaks for two that are still out" \
"The paper names the NEWEST certificate number whenever there is one, rather
than only when exactly one is outstanding. After a transfer OUT that is
right — the old one was surrendered — and after an ACQUISITION it is a claim
the register does not support: the holder still has the earlier certificate
in their hands, and this paper says it covers everything. Every field looks
filled in, and the register is the thing that disagrees. CR34b holds a
holder with two outstanding certificates beside one with a balance
certificate."
edit src/lib/certificate.ts \
  '  const certificateNo = evidencedBy.length === 1 ? evidencedBy[0] : null' \
  '  const certificateNo = evidencedBy[evidencedBy.length - 1] ?? null' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 297
section "The unpaid column waits for the date range again" \
"Open documents are reached only through the entries the range returned, so
a bill raised before the window has no row and its debt is missing from the
column and from both subtotals — while the heading, the page copy and the
code all call it what is owed TODAY. Pick this month and the supplier who
has been owed since March reads as owing nothing. V115 asks over a two-day
window and requires the same open documents, and the same total, as all
time."
edit src/lib/browse.ts \
  '    if (BigInt(b.balance) === 0n || already.has(`e${b.entry_id}`)) continue' \
  '    if (true || BigInt(b.balance) === 0n) continue' || exit 1
run npm run db:verify-invoices
close; restore


# ---------------------------------------------------------------- 298
section "A number is only found the way it was typed" \
"readQuery stops reading a bare figure as cents as well as dollars. Typing
1498 still finds the 1,498.00 bill, so the box looks like it works — and the
14.98 receipt, which is what somebody who remembers 1498 might equally have
meant, is gone. Money lives here as integer cents; this is the whole reason
the query has two readings. SR4 types the figure both ways."
edit src/lib/query.ts \
  '    if (/^\d+$/.test(bare)) {' \
  '    if (false && /^\d+$/.test(bare)) {' || exit 1
run npm run db:verify-search
close; restore

# ---------------------------------------------------------------- 299
section "A percent sign becomes a wildcard again" \
"The escaping goes, so what the reader typed is handed to ILIKE as a
pattern. Searching for 50% returns the entire ledger and searching for _
returns every row with at least one character — a search that answers a
question nobody asked, and answers it confidently. SR10 searches for the two
characters themselves."
edit src/lib/query.ts \
  'export const like = (q: Query) => `%${escaped(q.text)}%`' \
  'export const like = (q: Query) => `%${q.text}%`' || exit 1
run npm run db:verify-search
close; restore

# ---------------------------------------------------------------- 300
section "The search leaves the company it was asked in" \
"The party read loses the join condition that binds a role to THIS entity,
so a search in one company returns the other company's people. This is the
worst thing this feature could do — companies never mixing is a frozen
decision, and a search is the one screen whose job is to reach everywhere.
Every other section still behaves, so nothing looks wrong. SR9 gives two
companies a supplier with the same name and demands each find only its own."
edit src/lib/search.ts \
  '      JOIN party_role pr ON pr.party_id = p.id
       AND pr.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)' \
  '      JOIN party_role pr ON pr.party_id = p.id' || exit 1
run npm run db:verify-search
close; restore

# ---------------------------------------------------------------- 301
section "A line's own words stop finding their entry" \
"The EXISTS over journal_line looks up the wrong entry's lines, so nothing
written on a line ever matches. The entry header still answers, so most
searches look fine; what is lost is the thing typed on a LINE — the
account-level note that is often the only place a detail was ever written.
SR3 searches for a word that exists only on a line."
edit src/lib/reports.ts \
  '                      WHERE l.entry_id = je.id' \
  '                      WHERE l.entry_id = je.reverses_id' || exit 1
run npm run db:verify-search
close; restore

# ---------------------------------------------------------------- 302
section "The journal's date range stops narrowing anything" \
"The from filter falls out of the one journal reader. The picker still
moves, the URL still changes, and the list never changes with it — and
because the posted list is capped at a hundred, the reader who narrowed to
April to find something is looking at March. SR8 asks for a month that holds
the entry and a month that does not."
edit src/lib/reports.ts \
  '       AND ${opts.from ? sql`je.entry_date >= ${opts.from}::date` : sql`true`}' \
  '       AND true' || exit 1
run npm run db:verify-search
close; restore


# ---------------------------------------------------------------- 303
section "The chart section forgets which company it is in" \
"matchingAccounts loses its entity binding, so searching a code or an
account name returns every company's chart. Two companies with the same
codes look identical in a list, which is what makes this one so quiet: the
reader sees the right numbers and clicks through to another company's
account. Nothing exercised this section at all until the fixture gave each
chart a mark of its own. SR9 asks both companies for a shared word and
refuses any hit carrying the other's mark."
edit src/lib/search.ts \
  '     WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND (a.code ILIKE' \
  '     WHERE (a.code ILIKE' || exit 1
run npm run db:verify-search
close; restore

# ---------------------------------------------------------------- 304
section "A long reference is taken for an amount" \
"The bound that keeps a candidate inside what a money column can hold goes
away. A bank reference or a long document number — exactly what this box
exists to find — is then bound into abs(amount) IN (...) and Postgres refuses
the whole query, so the page 500s instead of finding the text. SR1 reads a
twenty-digit reference and searches for it."
edit src/lib/query.ts \
  '      if (asCents !== 0n && asCents <= INT8_MAX && !cents.includes(asCents)) cents.push(asCents)' \
  '      if (asCents !== 0n && !cents.includes(asCents)) cents.push(asCents)' || exit 1
run npm run db:verify-search
close; restore

# ---------------------------------------------------------------- 305
section "The search box jumps the reader to the top" \
"Refining a search pushes a new history entry instead of replacing, and
scrolls. Every search still works; what breaks is reading — the page jumps
to the top on every refinement, and Back walks through every word you tried
instead of leaving the page. This is the complaint that created the range
picker's rule, arriving through a different box. N5 reads both."
edit src/components/SearchBox.tsx \
  '    if (elsewhere) router.push(href)
    else router.replace(href, { scroll: false })' \
  '    router.push(href)' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 306
section "The two income taxes are rounded together" \
"Federal and BC per-period tax are added first and rounded once, instead of
being rounded separately and then added. It is a cent, sometimes, and the
two PDOC captures cannot see it at all -- both give the same answer either
way, which is exactly why nothing caught this until a case was hunted for.
PR25 pins one: \$1,093.00 semi-monthly in January is 37.91 federal plus 0.38
BC, and rounding the sum gives 38.28 instead of 38.29."
edit src/lib/payroll/engine.ts \
  '  const federalTax = roundFrac(div(asFrac(t1), asFrac(p)))
  const provincialTax = roundFrac(div(asFrac(t2), asFrac(p)))
  const incomeTax = clampAtLeastZero(federalTax + provincialTax + (input.additionalTax ?? 0n))' \
  '  const together = roundFrac(div(asFrac(t1 + t2), asFrac(p)))
  const federalTax = roundFrac(div(asFrac(t1), asFrac(p)))
  const provincialTax = together - federalTax
  const incomeTax = clampAtLeastZero(together + (input.additionalTax ?? 0n))' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 307
section "Every pay date gets January's tables" \
"editionFor stops looking at the date and always answers 2026-01. CRA
revised the tables mid-year -- BC's lowest rate went from 5.06% to 6.14% --
so every pay in the second half of 2026 is then under-deducted, on every
stub, invisibly. PR4 asks for 30 June and 1 July and requires the answer to
move; PR2's July capture requires it to move by the right amount."
edit src/lib/payroll/rates.ts \
  "  const found = [...list].reverse()" \
  "  const found = list" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 308
section "The CPP period exemption is forgotten" \
"Contributory earnings become the whole pensionable amount instead of what
is left after the period's share of the \$3,500 basic exemption. Every
employee over-contributes, every period, and the figure still looks like a
plausible CPP deduction. PR1 and PR2 are cent-exact against CRA's own
calculator, so there is nowhere for this to hide."
edit src/lib/payroll/engine.ts \
  '  const contributory = clampAtLeastZero(pensionable - periodExemption)' \
  '  const contributory = clampAtLeastZero(pensionable)' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 309
section "Nothing stops at its annual maximum" \
"capped returns what it was given and ignores the room left. CPP, CPP2 and
EI then run on past their yearly maximums -- the employee is over-deducted
for the rest of the year and the T4 will not reconcile with what was
remitted. PR5 and PR7 pin the last period before each maximum, where the
contribution must be the remainder rather than the full rate; PR23 pins the
period after."
edit src/lib/payroll/exact.ts \
  '  const room = clampAtLeastZero(remaining)
  return amount <= room ? amount : room' \
  '  return amount' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 310
section "The CPP enhancement is not deducted before tax" \
"F5A -- the enhanced portion of CPP, which T4127 subtracts from income
before annualising -- stops being subtracted. Income tax is then a few
dollars high every period, on both the federal and the provincial side, and
CPP and EI are untouched, so the stub looks entirely ordinary. PR1 and PR2
catch it on the tax lines alone."
edit src/lib/payroll/engine.ts \
  '  const perPeriodNet = income - (input.rppRrsp ?? 0n) - (input.unionDues ?? 0n) - f5a' \
  '  const perPeriodNet = income - (input.rppRrsp ?? 0n) - (input.unionDues ?? 0n)' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 311
section "A reversed pay run still eats the year's room" \
"The year to date stops caring whether the run behind a stub is still
standing in the books. Reverse a payroll that was run wrongly and re-run it,
and the year now counts BOTH -- CPP and EI room is consumed twice and the
employee is under-deducted for the rest of the year. This is the whole
argument for deriving the total instead of storing it, and PR10 is the check
that says it: run, reverse, and the room must come back."
edit src/lib/payroll/employees.ts \
  "      JOIN journal_entry je ON je.id = pr.entry_id AND je.status = 'posted'" \
  "      JOIN journal_entry je ON je.id = pr.entry_id" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 312
section "The employer's CPP lands on the liability instead of the expense" \
"The employer's own contribution is credited away rather than debited to
wages. The entry still balances -- postEntry has nothing to object to -- and
the payroll liability is understated by exactly the employer's share while
the wage expense is short by the same amount. The company's payroll looks
cheaper than it is. PR8 reads the entry account by account against the
run's own totals."
edit src/lib/payroll/runs.ts \
  '    ...(totals.employerCpp + totals.employerCpp2 > 0n ? [{
      accountId: wages.id,' \
  '    ...(totals.employerCpp + totals.employerCpp2 > 0n ? [{
      accountId: liability.id,' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 313
section "The wage lines name nobody" \
"Each employee's gross line stops carrying their party. Every figure in the
books is still right; what is gone is who the money was for -- the party
ledger, the aging and every by-party report see one anonymous wages total.
PR8 requires the gross lines to name the people the run paid."
edit src/lib/payroll/runs.ts \
  '      partyId: s.partyId,' \
  '      partyId: undefined,' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 314
section "A pay run reaches into another company" \
"employeesForRun loses its entity binding, so any company can pay any
company's employee -- and postEntry would then refuse the line only because
the party holds no role here, halfway through, or accept it if they happen
to. Companies never mixing is a frozen decision. PR16 asks the second
company to pay the first company's employee and requires a refusal."
edit src/lib/payroll/runs.ts \
  '       AND pe.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)' \
  '       AND TRUE' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 315
section "The same person can be on one run twice" \
"Two lines for one employee in one pay period stop being refused. CRA's
arithmetic is per PERIOD: the basic exemption and the claim amounts are
applied once, so two lines apply them twice and under-deduct on both. The
stubs and the entry both look fine. PR15 submits the same employee twice."
edit src/lib/payroll/runs.ts \
  '    if (seen.has(id)) {' \
  '    if (seen.has(id) && false) {' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 316
section "A run reads the gross where it should read pensionable" \
"previewPayRun stops passing pensionable and insurable through and hands the
engine the gross three times. The engine still honours them perfectly --
PR18 stays green -- and every pay with a benefit that is taxable but not
insurable is over-deducted. This is the seam a check on the engine alone
cannot see, which is why PR24 exists and asks the RUN."
edit src/lib/payroll/runs.ts \
  '    const pensionable = e.cpp_exempt ? 0n : (line.pensionable ?? line.gross)
    const insurable = e.ei_exempt ? 0n : (line.insurable ?? line.gross)' \
  '    const pensionable = line.gross
    const insurable = line.gross' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 317
section "A social insurance number is only counted, not checked" \
"The check digit test goes away and any nine digits are accepted. A typo
then reaches the T4, where CRA rejects the slip or -- worse -- files it
against somebody else. PR17 offers a number that is nine digits and fails
the check."
edit src/lib/payroll/employees.ts \
  '  if (sum % 10 !== 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 318
section "A pay stub may say anything about itself" \
"The two CHECKs that make a stub foot are gone. The engine still computes
correctly, so nothing changes today -- what is gone is the floor under it:
the one figure an employee ALWAYS checks could be stored wrong by anything
that ever writes this table, including a hand-typed repair. Twelve blocks
mutate the TypeScript and none had ever made a constraint fail (critic).
PR13 offers three bad rows and requires each to be refused by the one
constraint that is about it."
edit db/migrations/0051_payroll.sql \
  '  CONSTRAINT pay_stub_tax_adds_up
    CHECK (income_tax = federal_tax + provincial_tax + additional_tax),
  CONSTRAINT pay_stub_net_adds_up
    CHECK (net_pay = gross - cpp - cpp2 - ei - income_tax),' \
  '' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 319
section "Somebody can be paid less than nothing" \
"The floor under net pay goes away. Extra tax on a TD1 has no ceiling, so one
typo computes a negative net -- and the entry it makes BALANCES, with the
bank DEBITED on payday, so postEntry has nothing to object to. The
application refuses it by name first; this is the backstop under that.
PR13's third row is exactly this row."
edit db/migrations/0051_payroll.sql \
  '  net_pay        bigint NOT NULL CHECK (net_pay >= 0),' \
  '  net_pay        bigint NOT NULL,' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 320
section "Deleting a posted pay run takes its stubs with it" \
"The guard on the run goes, leaving only the guard on the stubs -- which
cannot see this: the stubs cascade from the run, and during a cascade the
parent row is already gone when the child's BEFORE DELETE fires, so the
lookup finds no entry_id, reads as an unposted run, and lets every stub go.
The year to date silently gets back room it had used, and the journal entry
is left with nothing behind it. PR26 deletes a posted run and requires both
the refusal and the stubs."
edit db/migrations/0051_payroll.sql \
  'CREATE TRIGGER trg_pay_run_frozen
  BEFORE DELETE ON pay_run
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_run_delete();' \
  '' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 321
section "The employer's own contributions stop being the employer's" \
"The employer multiplier becomes 1.0, so the employer's EI is charged at the
employee's rate rather than 1.4 times it. Every stub still foots, the entry
still balances, and the company under-remits on every payday -- CRA finds it
at the year end. PR7 pins the multiplier on the same period it pins the
maximum premium."
edit src/lib/payroll/rates.ts \
  "    employerMultiplier: '1.4'," \
  "    employerMultiplier: '1.0'," || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 322
section "A whole year is read as the year after it" \
"The year to date takes its calendar year from the EXCLUSIVE bound instead of
the last day it includes. Every pay run is unaffected -- its bound is the pay
date itself -- so no figure in the arithmetic moves. What breaks is the one
caller that asks for a whole year by passing 1 January next: it filters for
the following year and sums nothing, and an employee's page shows 0.00 above
a table of that employee's own stubs. Found in a browser pass, by looking at
the screen; no check had asked the question that way until PR31. Since 0074 the
year is the caller's own argument; this reads the year after it."
edit src/lib/payroll/employees.ts \
  "       AND date_part('year', pr.pay_date) = \${year}
       AND pr.pay_date < \${before}::date" \
  "       AND date_part('year', pr.pay_date) = \${year} + 1
       AND pr.pay_date < \${before}::date" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 323
section "Box 26 is capped at the first CPP ceiling instead of the second" \
"The mistake this node shipped and the critic caught: box 26 capped at the
YMPE rather than the YAMPE. Since 2024 box 26 has to support box 16A beside
it, and the second CPP contribution is charged on the band ABOVE the YMPE --
so a slip capped at 74,600 reports pensionable earnings that cannot explain
the CPP2 figure next to them, for everybody paid over that. Nothing looks
wrong: it is a real ceiling, just the other one. PR33 pays somebody past both
and requires 85,000."
edit src/lib/payroll/t4.ts \
  '  const yampe = dollars(cppEi.cpp.yampe)' \
  '  const yampe = dollars(cppEi.cpp.ympe)' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 324
section "A box the module cannot fill shows zero instead of saying so" \
"Box 20 stops being absent and becomes 0.00. Nothing looks wrong: zero is what
somebody with no pension contributions would have. But this module does not
withhold RPP at all, so the zero is not a measurement -- it is a guess that
happens to be right today and will be silently wrong the day withholding is
built. PR32 requires the box to be absent AND to say why -- and requires the same of
box 17, which CRA says to leave blank outside Quebec and which this node first
shipped as a hard zero (critic)."
edit src/lib/payroll/t4.ts \
  "          box: '20', label: 'RPP contributions', amount: null," \
  "          box: '20', label: 'RPP contributions', amount: 0n," || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 325
section "One pay-period count is used for every ROE block" \
"Block 15A's span is used for Block 15B as well. The blocks look consistent --
the same tidy number everywhere -- and Service Canada asks for 25 semi-monthly
periods of HOURS and 13 of EARNINGS. Reporting 25 periods of earnings roughly
doubles Block 15B, which is the figure a benefit rate is calculated from.
PR34 pins all four counts against the employer guide."
edit src/lib/payroll/roe.ts \
  '  semi_monthly: { hours15A: 25, earnings15B: 13, paper15C: 13, web15C: 25 },' \
  '  semi_monthly: { hours15A: 25, earnings15B: 25, paper15C: 13, web15C: 25 },' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 326
section "An ROE reports zero hours instead of no hours" \
"Block 15A falls back to a total when nothing was recorded. Zero hours and no
record of hours are different claims: the first says the person did not work,
which would deny the claim outright. PR35 asks for an employee nobody entered
hours for and requires the summary to refuse to state a figure."
edit src/lib/payroll/roe.ts \
  '    insurableHours: span && anyHours ? overHours.reduce((t, p) => t + p.hours, 0n) : null,' \
  '    insurableHours: overHours.reduce((t, p) => t + p.hours, 0n),' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 327
section "The paycheque's net pay is off by a cent" \
"The net printed in the summary stops being the net the stub stored. A cent is
the whole point: the paycheque is the document an employee reconciles against
what arrived in their account, and the check has to be able to see a
difference that small. It is a cent rather than a second derivation because
there is no second derivation available -- gross less the withholdings is what
pay_stub_net_adds_up already guarantees net_pay to be. PR36 reads the figures
back out of the PDF with a decoder that knows nothing about the builder."
edit src/lib/payroll/paycheque.ts \
  "  at(money(n(row.net_pay)), MID + 120, 726, { size: 14, bold: true })" \
  "  at(money(n(row.net_pay) - 1n), MID + 120, 726, { size: 14, bold: true })" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 328
section "An ROE states a Block 15B for a frequency the form has no type for" \
"CRA pays on 22 and 10 pay periods a year; Service Canada's form has no
pay-period type for either, so there is no number of periods to look back
over and no honest figure to give. The guard goes and Block 15B becomes a
number anyway -- somebody types it into a form that will compute a benefit
rate from it. The module's own docstring says it refuses to guess rather than
guess; this is the code guessing. PR34 asks for both frequencies and requires
every span figure to be refused."
edit src/lib/payroll/roe.ts \
  '    insurableEarnings: span ? overEarnings.reduce((t, p) => t + p.insurable, 0n) : null,' \
  '    insurableEarnings: overEarnings.reduce((t, p) => t + p.insurable, 0n),' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 329
section "A rehired employee's ROE reports the old leaving date" \
"Block 11 goes back to max(held_to) across every employee role. max() skips
nulls, so somebody who left, came back, and is still working reports the date
they left the FIRST time as the last day for which they were paid -- and
Block 12 with it. Every other figure on the sheet is right. PR34's fixture
does not cover it; the guard is the CASE that returns null while any role is
still open."
edit src/lib/payroll/roe.ts \
  '           (SELECT CASE WHEN bool_or(pr.held_to IS NULL) THEN NULL
                        ELSE max(pr.held_to)::text END' \
  '           (SELECT CASE WHEN false THEN NULL
                        ELSE max(pr.held_to)::text END' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 330
section "The paycheque prints a year's extra tax as nothing" \
"The extra-tax line's year-to-date goes back to a hard zero. It is inside the
Income Tax figure printed above it -- income_tax is federal + provincial +
additional by CHECK -- so the line disagrees with the one it is explaining, on
the one piece of paper an employee keeps, and the number that is wrong is the
one they would have to ask about. PR38 reads the second payday of a year,
where the period figure and the year figure differ."
edit src/lib/payroll/paycheque.ts \
  '  const ytdAdditional = ytd.incomeTax - ytd.federalTax - ytd.provincialTax' \
  '  const ytdAdditional = 0n' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 331
section "A T4 worksheet answers for another company" \
"t4Year loses the entity binding on the employee list, so one company's
worksheet lists every employee of every company -- with the wrong employer
name and business number at the top of it. Companies never mixing is a frozen
decision, and a T4 is exactly the screen somebody reaches for while looking at
the wrong company. PR39 asks the second company for the first company's people."
edit src/lib/payroll/t4.ts \
  '     WHERE pe.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
     ORDER BY p.name' \
  '     ORDER BY p.name' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 332
section "Hours typed with nobody to pay are thrown away" \
"A row is read only when it has a name or an amount, so hours entered on their
own are dropped without a word. It is the shape the invoice reader was fixed
for: the form takes what somebody typed and the reader silently keeps less of
it. PR41 submits a row of hours alone and requires the refusal to name the row."
edit src/lib/payroll/forms.ts \
  '      const typed = [gross, g(f, payHours(i)), g(f, payPensionable(i)), g(f, payInsurable(i)),
                     g(f, payBonus(i))].some(Boolean)' \
  '      const typed = Boolean(gross)' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 333
section "A password is stored as itself" \
"hashPassword hands back the password. Signing in still works -- it verifies
against what was stored -- so nothing on any screen changes. What changes is
that the table IS the list of everybody's passwords, and this system's own
backup route hands that table to whoever asks for it. US3 requires two hashes
of one password to differ and neither to contain it."
edit src/lib/users.ts \
  '  const key = await scrypt(password, salt, KEYLEN,
                           { ...COST, maxmem: maxmemFor(COST.N, COST.r) })' \
  '  const key = Buffer.from(password)' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 334
section "The session table stores the cookie" \
"The token is written to the table as it is, instead of its SHA-256. Every
session keeps working, so nothing looks wrong. What is now true is that
anybody holding a copy of the database holds a live session for every
signed-in person -- a backup becomes a set of credentials. US4 requires the
stored value to be the hash and the raw token to appear in no row."
edit src/lib/users.ts \
  "export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex')" \
  "export const tokenHash = (token: string) => token" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 335
section "A revoked session keeps working" \
"userForToken stops caring whether the session was revoked. Signing out
appears to work -- the cookie is cleared, the page returns to the sign-in
form -- and the token that was in it is still valid for a month. Somebody who
signs out on a borrowed machine has not signed out. US7 offers a revoked
token and requires nobody back."
edit src/lib/users.ts \
  '       AND s.revoked_at IS NULL
       AND s.expires_at > now()' \
  '       AND s.expires_at > now()' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 336
section "The sign-in form says which half was wrong" \
"An unknown address returns before any password is checked. Every sign-in
still behaves correctly for somebody who knows their password; what the form
now answers, to anybody who asks, is whether a given person has an account
here -- and it answers it faster for the ones who do. US5 requires the three
ways of failing to be one refusal."
edit src/lib/users.ts \
  '  if (!found || !ok || !found.is_active) throw wrong' \
  '  if (!found) throw new UserError("NO_SUCH_USER", "No account for that address.")
  if (!ok || !found.is_active) throw wrong' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 337
section "The superadmin can be removed" \
"The deferred trigger that keeps somebody in charge stops looking. Everything
works until the day the only superadmin is deactivated or demoted, and then
nobody can add a user, take a backup, or restore either -- the system is
locked out of itself with no path back except SQL. US11 tries three ways of
leaving nobody in charge, by row and by kind. The body is 0057's (0053's was
about owners); the trigger itself stays, because 0058 drops and re-creates it
by name and a tree where it was never made cannot migrate at all -- which is
what this block did for a day, and the battery read it as a suite that died."
edit db/migrations/0057_three_kinds_of_person_and_a_person_can_be_deleted.sql \
  "  IF NOT EXISTS (SELECT 1 FROM app_user WHERE kind = 'superadmin' AND is_active) THEN" \
  "  IF false THEN" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 338
section "A page forgets the gate" \
"One page stops calling requireUser. It is the payroll run list, so what it
hands an anonymous visitor is every payday this company has had. Nothing about
the page looks different and every other page is still gated -- which is the
whole reason the check reads the tree instead of trusting the pattern. N14
requires every page and route to reach gate.ts."
edit src/app/ledger/[ledgerId]/payroll/page.tsx \
  '  await requireUser()' \
  '' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 339
section "The backup route answers GET again" \
"pg_dump behind a GET. This is the shape RISKS 15b calls out: one request is
every company, every entry, every SIN and every birth date, and because GET is
supposed to be a read, an image tag on any page the owner visits triggers a
dump. N15 requires POST, and requires the owner gate."
edit src/app/backup/download/route.ts \
  'export async function POST() {' \
  'export async function GET() {' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 340
section "The audit trail goes back to recording a surface" \
"One form handler writes the old placeholder instead of the person. The audit
log still fills up and every column is still populated; the rows it writes say
web, which cannot tell two people apart, and that is the entire thing 0053
exists to fix. RISKS 15 says this cannot be repaired afterwards -- the history
written in between can never be attributed. N16 reads the code rather than the
prose, because its first version reported the file that DOCUMENTS the change."
edit src/lib/bank-forms.ts \
  '      actor: actor,' \
  '      actor: WEB_ACTOR,' || exit 1
run npm run db:verify-shell
close; restore


# ---------------------------------------------------------------- 341
section "A server action loses its gate" \
"discardDraftAction stops calling requireUser. It runs a bare DELETE on
journal_entry, and a server action POSTs to the page's own URL and runs BEFORE
that page renders -- so the requireUser in the page body does not cover it.
Six actions were reachable this way when the gate first shipped, because N14
read only page.tsx and route.ts and believed that was the list (critic). Next's
own documentation says to treat server actions as public API endpoints."
edit src/app/actions.ts \
  "  await requireLedger(ledgerId, '/entries')
  try {
    await entryWrite(formData,false,(tx,actor)=>discardDraft(String(formData.get('entryId') ?? ''),actor,ledgerId,tx))" \
  "  try {
    await entryWrite(formData,false,(tx,actor)=>discardDraft(String(formData.get('entryId') ?? ''),actor,ledgerId,tx))" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 342
section "A layout queries the database with no gate" \
"The ledger shell stops calling requireUser. It reads the entity name and
calls notFound, so to an anonymous caller it answers 404 for a ledger that
does not exist and 307 for one that does -- an existence oracle for ledger
ids, from a file that is not a page and not a route. N14 walks layouts for
exactly this."
edit src/app/ledger/[ledgerId]/layout.tsx \
  '  const me = await requireUser()' \
  '  const me = { is_owner: true } as never' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 343
section "Sign-in will send you anywhere" \
"The destination after sign-in is handed back unchecked. A value beginning with
a slash and a backslash then resolves to another host entirely, because a
browser treats a backslash as a slash -- so a link to this system's own login
page can land somebody on somebody else's, with the address bar showing the
right domain until the redirect. US16 resolves each candidate the way the
browser will, rather than pattern-matching it."
edit src/lib/user-forms.ts \
  "    return url.origin === HERE ? url.pathname + url.search : '/'" \
  "    return wanted" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 344
section "The timing defence stops costing anything" \
"An address that is not even an address returns without verifying against
anything. The refusal is identical; the TIME is not -- half a millisecond
against ninety -- so the form answers whether a given address could be an
account here, to anybody who measures. This is the shape the first version
shipped: the dummy it verified against had illegal scrypt parameters, so it
threw and the catch returned false, and the defence never ran. US5 compares
the refusals AND the work."
edit src/lib/users.ts \
  "    await verifyPassword(input.password, DUMMY_HASH)
    throw wrong" \
  "    throw wrong" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 345
section "A company somebody was not given still opens" \
"The entity half of refuseFor goes away, leaving only the module half. Every
screen still looks right -- the company list shows one company, the rail shows
the granted seats -- and typing another company's ledger id into the address
bar opens its books. This is the half that actually protects anything: a
permission saying \"not Payroll\" while every company's ledger answers has
moved the lock without locking anything (0054's own header)."
edit src/lib/access.ts \
  '    // oracle for ledger ids, which is the fault the ledger layout had.
    if (entityId && !access.entities.has(entityId)) {' \
  '    // oracle for ledger ids, which is the fault the ledger layout had.
    if (false && entityId && !access.entities.has(entityId)) {' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 346
section "A module somebody was not given still opens" \
"The module half goes. The rail draws the two seats the bookkeeper has and the
other twelve URLs all answer -- including the payroll pages, which carry other
people's pay. A hidden menu whose address still answers is not a permission,
which is the sentence the granting screen prints to whoever uses it."
edit src/lib/access.ts \
  '    if (seats !== null && !seats.some((s) => held.has(s))) {' \
  '    if (false && seats !== null && !seats.some((s) => held.has(s))) {' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 347
section "A page covered by a seat stops being covered by it" \
"moduleOf answers only for the seat path itself, instead of asking the same
function the rail highlights with. /aging, /statements and /trial-balance all
sit under the Reports seat; with an exact match they belong to no seat, so
nothing refuses them and a person without Reports reads every report. The
one-spelling rule is the whole point: /aging lighting up Reports in the rail
and /aging being covered by the Reports grant have to be the same fact."
edit src/lib/nav.ts \
  '    if (item.covers?.includes(head)) return item.path' \
  '    if (false && item.covers?.includes(head)) return item.path' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 348
section "The grantable modules become a list of their own" \
"MODULE_PATHS stops being derived from LEDGER_NAV and is typed out. It is
correct on the day it is typed, which is what makes it the shape this
repository keeps finding: the next module added shows up in the rail, and never
on the screen that grants it, so nobody can ever be given it and nobody is told
why. The same defect as two readers, two lists, two renderers -- here with a
year between cause and symptom."
edit src/lib/nav.ts \
  'export const MODULE_PATHS = LEDGER_NAV.map((i) => i.path)' \
  "export const MODULE_PATHS = [
  '', '/search', '/expenses', '/income', '/bank/import', '/entries', '/parties',
  '/accounts', '/reports', '/tax', '/payroll', '/records', '/periods',
]" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 349
section "An owner stops being exempt" \
"accessFor reads the tables for everybody. Nobody grants the owner anything --
there is no screen for it and no reason to -- so the person who administers the
system is refused at every company in it, including the one they need in order
to reach the granting screen and let themselves back in. A system whose
administrator can lock themselves out is a support call with no support."
edit $'src/lib/access.ts' $'    entities: user.is_owner ? null : new Set(rows.map((r) => r.entity_id)),\n    modules: user.is_owner ? null : new Set(rows.map((r) => r.module)),' $'    entities: new Set(rows.map((r) => r.entity_id)),\n    modules: new Set(rows.map((r) => r.module)),' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 350
section "The gate stops asking the access question for pages" \
"requireUser goes back to answering only \"who are you\". Every check in
verify-users still passes, because they call refuseFor directly and refuseFor
is untouched and correct -- a library nobody calls. On screen nothing is wrong
at all: the rail hides what it should hide, and every URL under it answers for
anybody signed in. N17 exists because US18-US22 cannot see this."
edit src/lib/gate.ts \
  '  const refusal = await refuseFor(user, path)
  // A PAGE, not a thrown error' \
  '  const refusal = null as Awaited<ReturnType<typeof refuseFor> >
  // A PAGE, not a thrown error' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 351
section "The downloads stop asking, and only the downloads" \
"guardRoute keeps the sign-in check and drops the access one; requireUser is
left alone, so every PAGE still refuses correctly and the whole application
looks right. What answers is the other fifteen doors -- the payroll PDF, the
transparency register with its dates of birth, the CSV export, every receipt
ever filed -- for any signed-in person, at any company, including the ones they
were refused on screen a moment earlier. The first version of N17 asked whether
refuseFor appeared anywhere in gate.ts, which this passes: I verify the doors I
thought of, and the route half is the one a page-shaped mental model forgets.
N14 had to learn the same thing twice, about server actions and about layouts."
edit src/lib/gate.ts \
  '  const refusal = await refuseFor(user, path)
  if (refusal) {
    return new Response(refusal.message, {' \
  '  const refusal = null as Awaited<ReturnType<typeof refuseFor> >
  if (refusal) {
    return new Response(refusal.message, {' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 352
section "The rail draws every seat again" \
"The ledger shell hands NavRail the whole nav instead of the seats this person
has. The gate still refuses, so nothing leaks -- what breaks is the honesty of
the screen: fourteen doors are offered and twelve of them turn you away with a
refusal page. Not a security hole, and pinned anyway, because the rail is the
only place a person finds out what they may do."
edit src/app/ledger/[ledgerId]/layout.tsx \
  '  const seats = seatsForEntity(await accessFor(me), head.entity_id, LEDGER_NAV.map((i) => i.path))' \
  '  const seats = LEDGER_NAV.map((i) => i.path)' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 353
section "Anybody signed in may grant themselves anything" \
"setGrantsAction is behind requireUser rather than requireOwner. N14 stays
green -- the action does reach the gate, which is all N14 asks -- and the
screen is still owner-only, so nothing is visibly wrong. A server action is a
public endpoint that runs before the page it POSTs to renders (Next's own
words), so the bookkeeper who is refused at every company can post one form and
hold every company and every module. The escalation is silent and it is
permanent, because the audit row it writes names them as the grantor and looks
exactly like an owner's."
edit src/app/user-actions.ts \
  "import { SESSION_COOKIE, requireOwner } from '@/lib/gate'" \
  "import { SESSION_COOKIE, requireOwner, requireUser } from '@/lib/gate'" || exit 1
edit src/app/user-actions.ts \
  '  const result = await setGrantsFromForm(formData, await requireOwner())' \
  '  const result = await setGrantsFromForm(formData, await requireUser())' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 354
section "An action writes to whichever company the form names" \
"requireLedger stops asking about the company. Every screen is still correct
and every page still refuses correctly -- what changes is that the id in the
FORM is no longer checked against the id in the URL's permission. Standing on a
company they hold, one POST with another company's ledger id in it writes into
books they were refused at on screen a moment earlier. Thirty-one actions read
their ledger out of the form this way. The gate could never have caught it:
refuseFor judges the page a form POSTs to, and a server action POSTs to the
page it is on."
edit src/lib/access.ts \
  '  const entityId = await entityOfLedger(ledgerId, on)
  if (access.entities) {
    if (entityId && !access.entities.has(entityId)) {' \
  '  const entityId = await entityOfLedger(ledgerId, on)
  if (access.entities) {
    if (false && entityId && !access.entities.has(entityId)) {' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 355
section "An action runs in a module its caller was never given" \
"The seat half of the action check goes. The company half still holds, so
nothing crosses a company line -- inside their own books, a person with the
Journal entries seat and nothing else can post the payroll form and create a
pay run, or post the records form and change the directors. The rail does not
offer those doors and the pages refuse; the endpoints behind them do not, and
a server action is a public endpoint that runs before the page it addresses
renders."
edit $'src/lib/access.ts' $'  if (!seats.some((m) => held.has(m))) {' $'  if (false && !seats.some((m) => held.has(m))) {' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 356
section "A seatless ledger path goes back to being allowed" \
"refuseFor treats \"no seat\" as \"no objection\" again, which is what it did
until a critic read it. Three paths belong to no seat: /export, /attachments
and /invoices. So one seat -- any seat, /opening will do -- buys the whole
journal as a CSV, every filed receipt by id, and every invoice document. The
company half still refuses, so this was never a cross-company leak; it was
every module's data to every colleague. The code's own comment said those paths
were \"detail routes reached from a row\" and DETAIL_ROUTES held one entry."
edit src/lib/access.ts \
  '    if (seats !== null && !seats.some((s) => held.has(s))) {' \
  '    if (seats !== null && seats.length > 0 && !seats.some((s) => held.has(s))) {' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 357
section "One route hands out four seats' worth of data" \
"The export's seat stops depending on what is being exported. /export answers
?what=journal, trial-balance, statement, account and gst-hst through one URL,
which is four different seats of content; with a single declared seat, whoever
holds that one holds all of them. The proxy passes the query string for exactly
this reason, and this is the version that ignores it."
edit src/lib/nav.ts \
  '    const asked = new URLSearchParams(search).get(declared.byQuery.param)' \
  '    const asked = null as string | null' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 358
section "The desk names every company in the system" \
"The landing page stops filtering. Nothing can be OPENED that could not be
opened before -- the gate refuses each ledger -- and the desk still hands a
bookkeeper the name and primary ledger id of every company the owner keeps
books for, on the first screen after signing in. /companies, two clicks away,
was filtered from the start under a comment about not inviting somebody to a
locked door; the desk was written before there was anything to filter by and
nobody went back (critic). Both read one predicate now."
edit src/app/page.tsx \
  '     WHERE ${mayOpenEntity(me, sql`e.id`)}' \
  '     WHERE TRUE' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 359
section "The gate admits a request it cannot judge" \
"The path header goes back to being optional. Every request that carries it is
judged exactly as before, so the application behaves identically -- and a
request that arrives without one is admitted, with no company check, no module
check and no line in any log. From inside, \"nobody told me where this is
going\" and \"this is allowed\" become the same answer. A boundary that cannot
answer must not answer yes."
edit src/lib/gate.ts \
  '  if (path === null) redirect('"'"'/no-access?why=NO_PATH'"'"')' \
  '  if (path === null) return user' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 360
section "The rail offers three kinds of door it will not open" \
"The seat list stays filtered and the other three link sources stop being: the
search box, the Add flyout and each item's own flyout. Nothing leaks -- every
one of those URLs is refused. What breaks is the only thing the rail is for: a
person without Payroll is offered \"Pay run\", and the Reports flyout offers the
GST/HST return, which lives in the Sales-tax seat. The first version of this
node filtered one source of four and the check watched that one (critic)."
edit src/components/NavRail.tsx \
  '  const addItems = ADD_MENU.filter((item) => mayOpen(item.path))' \
  '  const addItems = ADD_MENU' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 361
section "An action's declared seat drifts from where its form lives" \
"saveEmployeeAction keeps claiming the Payroll seat after its form has moved
to the parties screen -- which is what a written-down seat does the first time
somebody moves a component, and there is no way for the server to notice: it
cannot know which component called it. Here the drift is simulated the other
way round, by declaring a seat the form is not under. Everything still works
for everybody who holds both seats, and quietly widens for everybody who holds
only one. N18 re-derives every declaration from the tree."
edit src/app/ledger/[ledgerId]/payroll/actions.ts \
  "  await requireLedger(ledgerId, '/payroll')
  const result = await saveEmployeeFromForm" \
  "  await requireLedger(ledgerId, '/parties')
  const result = await saveEmployeeFromForm" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 362
section "A ledger route stops being accounted for" \
"The export declaration is removed from DETAIL_ROUTES, putting /export back
in the state a critic found it in: an entrypoint under a ledger that belongs to
no seat and that nobody has decided about. The refusal now defaults to shut, so
no data escapes -- what the check is for is the OTHER direction, the day
somebody adds a route and the permission map does not notice. N18 walks the
tree for this the way N1 and N14 do."
edit src/lib/nav.ts \
  "    segment: 'export'," \
  "    segment: 'export-not-declared'," || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 363
section "Only an owner may open the people screen, in words" \
"requireOwner goes back to throwing. The refusal is correct either way -- a
bookkeeper cannot manage people -- and what they meet is a bare 500, because
Next strips a thrown message in production. The sentence explaining what
happened and what to do about it is written in gate.ts and never reaches
anybody. requireUser was changed to redirect for exactly this reason on the day
requireOwner was written, and only one of the two was revisited; it took
opening the page as a bookkeeper to see it."
edit src/lib/gate.ts \
  "  if (!user.is_owner) redirect('/no-access?why=NEEDS_OWNER')" \
  "  if (!user.is_owner) throw new GateError('NEEDS_OWNER', 'no.')" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 364
section "The refusal page loses the sentence for one refusal" \
"NEEDS_OWNER stops having its own line, so a bookkeeper who opens the people
screen is told \"You have not been given that\" -- true, and no use to anybody.
requireOwner was changed from a throw to a redirect precisely so a person would
be told what happened and what to do about it; a code that falls through to the
generic sentence is that change made halfway. It shipped that way for an hour:
the redirect was written and the page was not told about the new code."
edit src/app/no-access/page.tsx \
  "    NEEDS_OWNER: {
      said: 'That is for an owner account — managing people and taking backups.'," \
  "    NEEDS_OWNER_NOT: {
      said: 'That is for an owner account — managing people and taking backups.'," || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 365
section "A finished reconciliation lets a match be undone" \
"The freeze stops watching bank_match. Finishing still records who and when,
the screen still says Finished, the statement still cannot be deleted -- and
the match on a row inside it can be undone, which changes the cleared balance
under a difference somebody has signed as zero. Amending a matched entry moves
its match (07 3b), so that goes through too: an amendment inside a finished
period that nothing refuses. RC17 and RC26 push on that door. The body is 0056's: 0055 wrote it first and 0056 re-issued it, and a mutation of the first is shadowed by the second -- toothless caught exactly that on 2026-09-05."
edit db/migrations/0056_the_freeze_lets_a_duplicate_through_and_watches_both_ends_of_a_move.sql \
  "  IF TG_OP <> 'INSERT' THEN
    SELECT * INTO b FROM bank_transaction WHERE id = OLD.bank_transaction_id;" \
  "  IF false THEN
    SELECT * INTO b FROM bank_transaction WHERE id = OLD.bank_transaction_id;" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 366
section "A row inside the freeze can be set aside or put back" \
"The UPDATE branch of the row freeze goes. Set a matched-and-reconciled
period's row aside and its ignore decision changes while the match on it
cannot (0020 forbids ignoring a matched row) -- so it is the put-back that
actually opens: a set-aside row in a finished period comes back into play and
starts counting against a difference that was zero. The body is 0056's: 0055 wrote it first and 0056 re-issued it, and a mutation of the first is shadowed by the second -- toothless caught exactly that on 2026-09-05."
edit db/migrations/0056_the_freeze_lets_a_duplicate_through_and_watches_both_ends_of_a_move.sql \
  "  IF (NEW.ignored_at IS NULL) IS DISTINCT FROM (OLD.ignored_at IS NULL) THEN
    PERFORM refuse_if_frozen(OLD.account_id, OLD.txn_date, 'the row of ' || OLD.txn_date);
  END IF;" \
  "" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 367
section "A late row slips into a finished period" \
"The INSERT branch of the row freeze goes. Next month's file overlaps March
by a row the bank added after the statement was printed; it lands, the
March rows no longer reproduce the printed ending, and the March
reconciliation reads Finished above an import gap it did not have when it
was finished. An import is one transaction, so the refusal is supposed to
take the whole file with it -- RC21 and RC22 want both halves. The body is 0056's: 0055 wrote it first and 0056 re-issued it, and a mutation of the first is shadowed by the second -- toothless caught exactly that on 2026-09-05."
edit db/migrations/0056_the_freeze_lets_a_duplicate_through_and_watches_both_ends_of_a_move.sql \
  "      PERFORM refuse_if_frozen(NEW.account_id, NEW.txn_date, 'a row dated ' || NEW.txn_date);" \
  "      NULL;" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 368
section "A statement is slipped in behind the freeze" \
"Statements stop being frozen. A February statement is entered after March
is finished; March's beginning balance is now February's ending instead of
zero, its difference is no longer zero, and it still says Finished. This is
the beginning-balance discrepancy QuickBooks warns about, made impossible
rather than warned about."
edit db/migrations/0055_a_finished_reconciliation_freezes_what_it_covered.sql \
  '  IF TG_OP = '"'"'INSERT'"'"' THEN
    PERFORM refuse_if_frozen(NEW.account_id, NEW.statement_date, '"'"'a statement dated '"'"' || NEW.statement_date);
    RETURN NEW;
  END IF;
  PERFORM refuse_if_frozen(OLD.account_id, OLD.statement_date, '"'"'the statement of '"'"' || OLD.statement_date);
  RETURN OLD;' \
  '  IF TG_OP = '"'"'INSERT'"'"' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 369
section "Finish stops needing the difference to be zero" \
"The guard finishes a statement whatever the difference. The screen still
prints the difference in amber and still says it must be zero -- and the
button beside it works. A reconciliation that does not reconcile, signed and
frozen. The whole reason the decision is stored is that the arithmetic was
checked at the moment it was made."
edit db/migrations/0055_a_finished_reconciliation_freezes_what_it_covered.sql \
  '    IF diff <> 0 THEN' \
  '    IF false THEN' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 370
section "Reconciliations can be finished out of order" \
"April is finished while March is still open. March's rows are now frozen
by April's freeze -- the newest finished date covers them -- so March can
never be balanced by matching anything, and can never be finished. The only
way out is to undo April. RC14 refuses the first step."
edit db/migrations/0055_a_finished_reconciliation_freezes_what_it_covered.sql \
  '    IF EXISTS (SELECT 1 FROM bank_statement
                WHERE account_id = NEW.account_id AND statement_date < NEW.statement_date
                  AND reconciled_at IS NULL) THEN' \
  '    IF false THEN' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 371
section "Any finished reconciliation can be undone" \
"March is undone while April, which rests on it, stays finished. April's
beginning balance is still March's printed ending -- that did not change --
but March's rows are now free to be unmatched, and April's freeze does not
cover them: it covers everything up to April's date, and it does, but the
newest finished date is now April, so March's rows ARE still frozen. Which
means the undo achieved nothing except a statement that says open while its
rows say frozen. Two answers, and QuickBooks' rule of undoing the last one
first is the one that keeps them at one."
edit db/migrations/0055_a_finished_reconciliation_freezes_what_it_covered.sql \
  '    IF OLD.statement_date <> frozen THEN' \
  '    IF false THEN' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 372
section "The difference forgets where the last statement ended" \
"bank_statement_difference counts every match up to the statement date, not
only the ones since the prior statement. April's cleared balance now includes
March's matches on top of March's ending balance -- the same money twice --
and a balanced April shows a difference the size of March. RC13 is the first
to see it: it asks April, which has a prior."
edit db/migrations/0055_a_finished_reconciliation_freezes_what_it_covered.sql \
  '     AND (prior_date IS NULL OR b.txn_date > prior_date);

  RETURN s.ending_balance - cleared;' \
  '     AND TRUE;

  RETURN s.ending_balance - cleared;' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 373
section "A row set aside stops counting against the difference" \
"A set-aside row's amount is treated as cleared. One lone bank error, set
aside with a reason and never accounted for in the books, and the statement
balances to zero and can be finished -- with the books short by that amount
for ever. Two set-aside rows that cancel still balance either way; the
difference is only visible on a lone one, which is what RC10 has."
edit db/migrations/0055_a_finished_reconciliation_freezes_what_it_covered.sql \
  '  RETURN s.ending_balance - cleared;
END $$ LANGUAGE plpgsql STABLE;' \
  '  RETURN s.ending_balance - cleared - (SELECT coalesce(sum(b.amount), 0) FROM bank_transaction b
    WHERE b.account_id = s.account_id AND b.ignored_at IS NOT NULL
      AND b.txn_date <= s.statement_date AND (prior_date IS NULL OR b.txn_date > prior_date));
END $$ LANGUAGE plpgsql STABLE;' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 374
section "Two exact candidates, and one of them is suggested anyway" \
"The feed suggests a match when there is AT LEAST one entry with the right
room, instead of exactly one. Two invoices for the same amount on the same
day -- ordinary -- and the row proposes the first of them with a one-click
button, wearing the same confidence as a row with only one. Half of those
clicks are wrong and nothing on the screen says the odds. 07 section 5: a
suggestion is a suggestion, and two is a choice."
edit src/lib/bank-feed.ts \
  '  if (exact.length === 1) return { kind: '"'"'match'"'"', entry: exact[0] }' \
  '  if (exact.length >= 1) return { kind: '"'"'match'"'"', entry: exact[0] }' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 375
section "The remembered account stops ignoring the numbers" \
"SAME_PAYEE compares descriptions as the bank wrote them. SHAW CABLE 4471 and
SHAW CABLE 9920 are two different payees now, and the second is suggested
nothing -- so the one thing the feature is for, the next month's bill from the
same company, never gets its suggestion. Every bank folds a reference number
or a date into the description."
edit src/lib/bank.ts \
  'regexp_replace(regexp_replace(lower(${col}), '"'"'[0-9]+'"'"', '"'"''"'"', '"'"'g'"'"'),' \
  'regexp_replace((lower(${col})),' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 376
section "Batch accept trusts the screen it was posted from" \
"acceptMatches matches each ticked row to its first candidate instead of
re-judging whether an exact suggestion still stands. The screen is a minute
old; the entry it suggested was claimed by another row in between; the tick
is still there. Now the row is matched to whatever is nearest -- not the
suggestion the person ticked, and not exact. A batch is the one place a
wrong match goes unnoticed, because nobody looked at each row."
edit src/lib/bank.ts \
  '    const s = suggestionFor(row, await candidateEntries(rowId, 8), null)' \
  '    const first = (await candidateEntries(rowId, 8))[0]
    const s: Suggestion = first ? { kind: '"'"'match'"'"', entry: first } : { kind: '"'"'none'"'"' }' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 377
section "The excluded tab empties into categorized" \
"Rows set aside are listed among the categorized ones. Nothing is lost -- the
row is still there, still set aside -- but the tab that exists to be looked
at when a reconciliation will not balance shows nothing, and the categorized
list shows rows the books have no entry for, under a heading that says they
do."
edit src/lib/bank.ts \
  "    if (row.state === 'ignored') out.excluded.push(view)" \
  "    if (row.state === 'ignored') out.categorized.push(view)" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 378
section "The panel offers Finish on a statement that is finished" \
"The panel stops reading whether the statement is finished. Finish is offered
again above a Finished badge that is no longer printed; pressing it is refused
by the database, in words, so nothing breaks -- what breaks is that Undo is
never offered, and the one way to change anything in a finished period has no
button. RC35 renders the panel for a finished statement and looks for it."
edit 'src/app/ledger/[ledgerId]/bank/[accountId]/reconcile/ReconcilePanel.tsx' \
  '        {view.finished ? (' \
  '        {false ? (' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 379
section "The Bank seat goes back to being the upload" \
"nav.ts points the Bank seat at /bank/import again. Everything still renders
and the gate still works -- /bank/... lights the seat by segment either way.
What goes wrong is quiet: 0055 moved every stored grant from /bank/import to
/bank, and a seat that is spelled /bank/import again matches none of them, so
every bookkeeper who had Bank has it no longer, and the screen that grants it
offers a path no row holds. RC32 pins the spelling."
edit $'src/lib/nav.ts' $'{ order: 11, label: \'Bank\', path: \'/bank\', group: \'daily\', flyout: [' $'{ order: 11, label: \'Bank\', path: \'/bank/import\', group: \'daily\', flyout: [' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 380
section "The batch-accept ticks belong to no form" \
"The accept form loses its id. Every checkbox in the feed still says
form=accept-matches, and under HTML's form-owner rules a form attribute that
names no <form> associates with nothing -- so the ticks are dropped on the
way out and the headline button of door one answers \"tick the rows first\"
however many are ticked. It shipped exactly like this, with the id on a span
beside the form (critic); the harness only read inputs INSIDE forms and saw
a form with three hidden fields and nothing wrong."
edit src/components/ActionForm.tsx \
  '      <form {...formProps} id={id} className={className}>' \
  '      <form {...formProps} className={className}>' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 381
section "A form's id is trusted to be this company's" \
"ours() stops asking whether the id belongs to the ledger the form names.
requireLedger still judged the ledger id, so the seat is real -- and the
statement id beside it can be any company's. A person with the Bank seat on
company A finishes company B's reconciliation and freezes B's books, with an
audit row naming them as if they were B's bookkeeper. Nine handlers are
behind this one function; RC37-RC45 post the wrong company's id at each."
edit src/lib/match-forms.ts \
  '  if (!(await belongsToLedger(kind, id, ledgerId))) {' \
  '  if (false) {' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 382
section "The freeze refuses next month's file for rows it already has" \
"0056's exemption goes: a row identical to one on file is refused like a new
one. Next month's statement overlaps this month's by a few days -- the case
06 section 6 numbers rows for -- and the whole file is refused the moment the
prior month is finished, for rows ON CONFLICT would have discarded anyway.
Every account that has ever been reconciled can never be imported into again
without undoing the reconciliation first."
edit db/migrations/0056_the_freeze_lets_a_duplicate_through_and_watches_both_ends_of_a_move.sql \
  '    IF NOT EXISTS (SELECT 1 FROM bank_transaction t' \
  '    IF true OR NOT EXISTS (SELECT 1 FROM bank_transaction t' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 383
section "A match can be lifted off a finished period" \
"The OLD side of the move check is skipped on UPDATE, which is 0055 exactly:
only the row the match is moving TO is judged (a DELETE is still refused, as
it was). Move a match from a March row onto a June row and March's cleared
balance drops by that amount under a reconciliation signed as zero. No
application path moves a match between rows today, so this is the latent
half of the freeze -- and the header of 0055 promised it. RC47 is the only
check that pushes on it."
edit db/migrations/0056_the_freeze_lets_a_duplicate_through_and_watches_both_ends_of_a_move.sql \
  "  IF TG_OP <> 'INSERT' THEN
    SELECT * INTO b FROM bank_transaction WHERE id = OLD.bank_transaction_id;" \
  "  IF TG_OP = 'DELETE' THEN
    SELECT * INTO b FROM bank_transaction WHERE id = OLD.bank_transaction_id;" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 384
section "The freeze's refusal loses its sentence" \
"reconciledSentence returns nothing, so the three places it reaches a person
-- a bank form, an import, deleting an entry -- fall through to the raw
Postgres text or the wrapper around it. The refusal still happens; what is
lost is the one thing the person needs from it, which reconciliation to go and
undo. RC12, RC46b and RC48 each read the sentence."
edit src/lib/match-forms.ts \
  "  if (!text.includes('RECONCILED:')) return null" \
  "  if (true) return null" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 385
section "The printed Summary stops footing" \
"reportSummary leaves the Difference line out when the difference is not
zero. Beginning, payments cleared and deposits cleared are still printed and
still right; the ending balance is still the printed one -- and the four no
longer add up, on a report whose whole shape (the owner's QuickBooks
reference) is that they do. A reader adds the column, gets a different
number, and has no line telling them the reconciliation is not finished. RC49
adds the column."
edit src/lib/recon-display.ts \
  '  if (view.difference !== 0n) {
    lines.push({ label: '"'"'Difference — not yet reconciled'"'"', amount: view.difference, rule: '"'"'single'"'"' })
  }' \
  '' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 386
section "The PD7A groups by the period paid for, not the day paid" \
"remittanceMonths groups stubs by period_end instead of pay_date. For a
semi-monthly payroll the two agree eleven months a year; the pay period
ending 31 December paid on 2 January lands in the wrong year's December, and
the remittance CRA expects by 15 February is shown as due 15 January. The
rule is the day you paid (T4001), and PR43 pays on the 15th and the 31st of
one month so the months only agree if the grouping is by pay date."
edit src/lib/payroll/runs.ts \
  "      SELECT to_char(pr.pay_date, 'YYYY-MM') AS month, pr.id AS run_id, pr.pay_date, pr.period_end, ps.*" \
  "      SELECT to_char(pr.period_end, 'YYYY-MM') AS month, pr.id AS run_id, pr.period_end AS pay_date, pr.period_end, ps.*" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 387
section "The PD7A counts everybody paid in the month" \
"The headcount becomes everybody who was paid at any point in the month
instead of the last pay period's. Two on the 15th and one on the 31st reads
as three -- the form asks for the number in the last pay period, and the
figure feeds CRA's own estimate of what the next remittance should be."
edit src/lib/payroll/runs.ts \
  "           (SELECT count(DISTINCT q.employee_id) FROM paid q
             JOIN last_period lp ON lp.month = q.month AND lp.run_id = q.run_id
            WHERE q.month = p.month)::text AS employees," \
  "           count(DISTINCT p.employee_id)::text AS employees," || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 388
section "December's remittance is due in the wrong year" \
"remittanceDueOn stops carrying the year over: December's figures are due
2026-01-15 -- a year before they were withheld -- and every other month is
right. The one month a year the arithmetic differs is the one that is easy to
never test."
edit src/lib/payroll/runs.ts \
  "  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }" \
  "  const next = m === 12 ? { y, m: 1 } : { y, m: m + 1 }" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 389
section "The PST commission forgets its cap" \
"pstCommission returns 6.6% of anything over the flat band, with no ceiling.
A company that collects thirty thousand dollars of PST in a quarter is shown
a commission of nearly two thousand where the province allows one hundred and
ninety-eight, and box D is understated by the difference. The tiers are on
the province's page and G18 walks every edge of them."
edit src/lib/tax-rates.ts \
  '  return pct > scale.max ? scale.max : pct' \
  '  return pct' || exit 1
run npm run db:verify-tax
close; restore

# ---------------------------------------------------------------- 390
section "The PST return reads the GST account" \
"pstReturn asks for the gst_hst_payable role instead of qst_pst_payable. Box B
becomes the GST collected -- a number that is real, on the books, and belongs
on the other return. Two taxes, two accounts, two returns; G17 posts one sale
with both and reads each return's entries by account."
edit src/lib/tax.ts \
  "    linesFor(ledgerId, from, to, 'qst_pst_payable')," \
  "    linesFor(ledgerId, from, to, 'gst_hst_payable')," || exit 1
run npm run db:verify-tax
close; restore

# ---------------------------------------------------------------- 391
section "The audit trail opens to anybody signed in" \
"The audit page stands behind requireUser instead of requireOwner. Every
company's history -- who created which account, which director was recorded,
what a reconciliation looked like before it was undone -- to a bookkeeper
who holds one company's Bank seat. N14 is satisfied, the page reaches a gate;
N17 asks which one."
edit src/app/audit/page.tsx \
  '  const me = await requireOwner()' \
  '  const me = await requireUser()' || exit 1
edit src/app/audit/page.tsx \
  "import { requireOwner } from '@/lib/gate'" \
  "import { requireOwner, requireUser } from '@/lib/gate'" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 392
section "The year comparison stops going back a year" \
"compareDates shifts the span back by nothing. The comparative column shows
this year's figures beside this year's figures, every change reads 0.00, and
the heading says last year. The statements check renders the earlier span
directly and holds the column to it."
edit src/lib/compare.ts \
  '      SELECT (${span.fromPeriod.start_date}::date - interval '"'"'1 year'"'"')::date::text AS "from",' \
  '      SELECT (${span.fromPeriod.start_date}::date - interval '"'"'0 year'"'"')::date::text AS "from",' || exit 1
edit src/lib/compare.ts \
  '             (${span.toPeriod.end_date}::date - interval '"'"'1 year'"'"')::date::text AS "to"`)' \
  '             (${span.toPeriod.end_date}::date - interval '"'"'0 year'"'"')::date::text AS "to"`)' || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 393
section "The change column runs the other way" \
"change = compare − current. Revenue that grew shows a negative change and
costs that fell show a positive one, with the two figures beside it both
right. The one column a reader adds nothing to check."
edit src/lib/compare.ts \
  "      change: l.lineType === 'header' || l.lineType === 'spacer' ? null : l.shown - compare.lines[i].shown," \
  "      change: l.lineType === 'header' || l.lineType === 'spacer' ? null : compare.lines[i].shown - l.shown," || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 394
section "The workbook writes money as text" \
"reportXlsx stops turning a money cell into a number. Every figure is still
on the sheet, right-aligned, in the right row -- as the string \"1,234.56\".
A column of text adds up to nothing, a SUM over it is zero, and the
spreadsheet the owner asked for so the figures could be worked with is a
picture of the PDF. X40 reads a cell back and asks what type it is."
edit src/lib/excel.ts \
  '        if (num !== null && align === '"'"'right'"'"') {
          cell.value = num
          cell.numFmt = MONEY_FORMAT
        }' \
  '        if (false) {
          cell.value = num
          cell.numFmt = MONEY_FORMAT
        }' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 395
section "The workbook's totals lose their rule and their weight" \
"A rule row is written like any other row: no line above the total, no bold.
The trial balance's total is one more row of figures under the accounts, and
on a two-page print of the general ledger the closing balance of one account
and the first line of the next are the same weight. X40 reads the total row's
font and border back."
edit src/lib/excel.ts \
  '        if (bold) cell.font = { bold: true }
        if (row.rule) cell.border = { top: { style: '"'"'thin'"'"' } }' \
  '        void bold' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 396
section "The row-grid workbook loses its header" \
"rowsXlsx never recognises the header row, so the journal's and the account
history's column names are ordinary cells: not bold, no rule, nothing frozen
-- and, because the header is also what stops the money parser, a header
that happens to look like money would be turned into a number. X42 reads the
header row of the journal back."
edit src/lib/excel.ts \
  '    const isHeader = idx === headerAt' \
  '    const isHeader = false' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 397
section "An owner outranks an owner" \
"mayManage lets an owner manage anybody who is not a superadmin, so an owner
deletes another owner, re-kinds them, and resets their password. The owner's
rule was one sentence -- user由owner删除，owner由superadmin删除 -- and this is
the version where the second half is not true. The screen draws its buttons
from the same function, so it offers them too."
edit src/lib/user-kinds.ts \
  "  if (actor.kind === 'owner') return target.kind === 'user'" \
  "  if (actor.kind === 'owner') return target.kind !== 'superadmin'" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 398
section "The doors stop asking the ladder" \
"assertMayManage still refuses your own row and still looks the target up,
but no longer compares ranks. requireOwner stands at every action, so a user
cannot reach them -- an owner can, and the form body's userId is whatever the
browser sent: an owner signs off, re-kinds, deletes, or resets the password
of the superadmin. The keep-one trigger refuses only the LAST active one."
edit src/lib/users.ts \
  '  if (!mayManage(actor, target)) {' \
  '  if (false && !mayManage(actor, target)) {' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 399
section "Every person's grants render all the time again" \
"The row's Access form stops waiting to be opened -- every user's companies
and modules are on the page for every person, always, which is the wall of
forms the owner asked to have folded away. Nothing is less safe; it is the
screen the owner said was unusable."
edit src/app/users/UserAdmin.tsx \
  '      {open && (' \
  '      {(open || true) && (' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 400
section "Anybody's password is yours to change" \
"The one exception at the password door -- your own -- widens to everybody.
An owner types a new password for the superadmin and signs in as them; the
rung above the owner is decorative from that moment."
edit src/lib/user-forms.ts \
  '    if (userId !== actor.id) await assertMayManage(actor, userId)' \
  '    if (false) await assertMayManage(actor, userId)' || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 401
section "A deletion leaves no trail" \
"deleteUser drops the row and writes nothing to audit_log. app_user has no
audit trigger, so afterwards the database holds no line saying who deleted
whom or when -- only the created_by text on rows the deleted person wrote,
which is history ABOUT them, not the act. The one irreversible thing the
people screen can do becomes the one thing the trail does not show."
edit src/lib/users.ts \
  "      await audited(tx, actorOf(input.actor), 'delete_user', target, null)" \
  "      // (no trail)" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 402
section "Every PDF becomes a download" \
"pdfResponse sends the PDF as an attachment too. Eleven routes leave through
it -- the seven reports, invoices, customer statements, certificates and the
registers -- and every Download PDF link targets a new tab, so each click now
opens a blank tab and drops a file. This is the version the Excel node shipped
for a day, and the comment above the function still said inline."
edit src/lib/pdf-reports.ts \
  "  const disposition = xlsx ? 'attachment' : 'inline'" \
  "  const disposition = 'attachment'" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 403
section "The tax return's paper loses the entries behind its figures" \
"taxReturnPdf goes back to the four boxes and a review sentence. The CSV this
paper replaced carried every line's entries with a total under each; the
button that used to reach the CSV now reaches this, so nobody can check a
figure line by line at a desk any more. The workbook is a thinner file than
the one the owner asked to have replaced."
edit src/lib/pdf-reports.ts \
  '  for (const l of lines.filter((x) => x !== ret.lines.net && x.entries.length > 0)) {' \
  '  for (const l of lines.filter(() => false)) {' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 404
section "A count is written as money" \
"rowsXlsx puts the accounting format on every number, so the PD7A worksheet
shows Runs 2.00 and Employees 3.00, and a month with none shows a dash where
a zero should be. The figures are right; the paper says they are dollars."
edit src/lib/excel.ts \
  "      } else if (typeof v === 'number') {" \
  "      } else if (typeof v === 'number' && (cell.numFmt = MONEY_FORMAT, true)) {" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 405
section "A second superadmin can be made" \
"mayAssign hands out the superadmin kind again, so the superadmin promotes
anybody to their own rung from the Type select and the Add form. The owner
ruled there is exactly one; the table's unique index still refuses the row,
so this is the screen offering, and the library allowing, what the database
then refuses with an index name instead of a sentence."
edit src/lib/user-kinds.ts \
  "  if (kind === 'superadmin') return false" \
  "  if (kind === 'superadmin') return actor.kind === 'superadmin'" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 406
section "The trigger half stops asking who is acting" \
"0060's trigger at the door of audit_log no longer swaps the role's name for
\`app.actor\`. Every row a trigger writes — a draft discarded, an account
renamed, a year closed — names the Postgres role again, whoever was signed in,
which is RISKS §10 reopened in one line. \`D21\` asks the drafts suite's whole
trail whether any row names the role."
edit db/migrations/0155_audit_scope_sources.sql \
  "  IF NEW.actor = current_user::text THEN" \
  "  IF false THEN" || exit 1
run npm run db:verify-drafts
close; restore

# ---------------------------------------------------------------- 407
section "A discarded draft is discarded by the database role" \
"\`discardDraft\` deletes outside \`actingAs\`, so the discard trigger fires in a
transaction that never said who is acting and its row names the role. The
door still takes an actor; it just does nothing with it — the shape the old
\`unignoreBankRow\` comment warned about."
edit src/lib/posting.ts \
  "  await actingAs(actor, (tx) => tx.delete(journalEntry).where(eq(journalEntry.id, draftId)), on)" \
  "  await db.delete(journalEntry).where(eq(journalEntry.id, draftId))" || exit 1
run npm run db:verify-drafts
close; restore

# ---------------------------------------------------------------- 408
section "An account is renamed by the database role" \
"\`updateAccount\` runs its UPDATE in a plain transaction. The account trigger's
\`update_account\` row names the role; \`A27\` finds it."
edit src/lib/accounts.ts \
  "  const [row] = await actingAs(actor, (tx) => tx.update(account).set({" \
  "  const [row] = await db.transaction((tx) => tx.update(account).set({" || exit 1
edit src/lib/accounts.ts \
  '  }).where(eq(account.id, accountId)).returning(), on)' \
  '  }).where(eq(account.id, accountId)).returning())' || exit 1
run npm run db:verify-accounts
close; restore

# ---------------------------------------------------------------- 409
section "A year is closed by the database role" \
"\`closeFiscalYear\` posts the closing entry and marks the year closed without
saying who. The application's own \`close_year\` row still names the person; the
trigger's \`close_year\` row — the one 0003 wrote so the change is captured
however it was made — names the role. Two rows for one act, two names."
edit src/lib/posting.ts \
  "    await acting(tx, actor)
    const [year] = await tx.execute<{" \
  "    const [year] = await tx.execute<{" || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 410
section "A party is taken off the lists by nobody" \
"\`deactivateParty\` drops the actor it was handed and says '' instead. The
setting is empty, \`nullif\` makes it NULL, the trigger keeps the role's name.
An accepted-and-dropped parameter is the exact defect the old comment on
\`unignoreBankRow\` refused to have."
edit src/lib/parties.ts \
  "export async function deactivateParty(partyId: string, actor = 'system', on: Runner = db): Promise<PartyRecord> {" \
  "export async function deactivateParty(partyId: string, actor = 'system', on: Runner = db): Promise<PartyRecord> {
  actor = ''" || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 411
section "Money is un-applied by nobody" \
"\`unapply\` forgets the actor. 0034's \`unapply_from_invoice\` row names the
role; \`PM43\` finds it."
edit src/lib/payments.ts \
  "export async function unapply(applicationId: string, actor = 'system', on:Runner=db) {" \
  "export async function unapply(applicationId: string, actor = 'system', on:Runner=db) {
  actor = ''" || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 412
section "A bank row is put back in play by nobody" \
"\`unignoreBankRow\` takes an actor again since 0060 — and here drops it. The
un-ignore row names the role, which is what this door did on purpose for a
year, and what \`M78\` now refuses."
edit src/lib/bank.ts \
  "export async function unignoreBankRow(id: string, actor = 'system') {" \
  "export async function unignoreBankRow(id: string, actor = 'system') {
  actor = ''" || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 413
section "A password change leaves no trail" \
"\`setPassword\` changes the hash and ends the sessions and writes no row. The
one door that must never record what it changed now records nothing at all —
not who, not when, not how many sessions it ended. \`US34\` counts the row."
edit src/lib/users.ts \
  "    await auditRow(tx, {" \
  "    if (false) await auditRow(tx, {" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 414
section "A change of grants leaves no trail" \
"\`setGrants\` replaces what somebody may see and writes no row. A grant
widened and narrowed again leaves no trace — RISKS §15b's open item, reopened.
\`US35\` reads the before and after."
edit src/lib/access.ts \
  "      await auditRow(tx, {" \
  "      if (false) await auditRow(tx, {" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 415
section "The shell door ignores the password it was given" \
"\`reset-password.ts\` generates a random password whether or not --password was
passed, prints the one it made, and the one the person typed does not sign in.
\`US36\` signs in with what it passed."
edit scripts/reset-password.ts \
  "  const password = given ?? randomBytes(18).toString('base64url')" \
  "  const password = randomBytes(18).toString('base64url')" || exit 1
run npm run db:verify-users
close; restore

# ---------------------------------------------------------------- 416
section "An import no longer waits for the account" \
"\`importBankRows\` says who is acting and then writes without taking the
account's lock. A Finish in flight on the same account computes its difference
without these rows and commits a finished statement over them (RISKS §21b).
\`RC51\` holds the lock from a second connection and watches the import land
anyway."
edit src/lib/bank.ts \
  "    await acting(tx, actor)
    await lockBankAccount(tx, input.accountId)" \
  "    await acting(tx, actor)" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 417
section "Finish no longer waits for the account" \
"\`finishReconciliation\` skips the lock and goes straight to the UPDATE whose
guard computes the difference. Everything that took the lock still serialises
with each other and none of it with Finish — the one door the lock exists for.
\`RC52\` holds the lock and watches Finish finish under it."
edit src/lib/bank.ts \
  "    // committed before this — and nothing that is waiting on this lock.
    await lockBankAccount(tx, await accountOfStatement(tx, statementId))" \
  "    // committed before this — and nothing that is waiting on this lock." || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 418
section "Releasing a match no longer waits for the account" \
"\`releaseReferences\` deletes an entry's bank matches without taking the
account's lock. A Finish in flight on that account computes its difference
with the match still counted, the freeze trigger judges the delete against a
Finish it cannot see, and both commit — the race RISKS §21b describes, through
the one door the first version of the lock left out. \`RC54\` holds the lock and
watches the delete land under it."
edit src/lib/posting.ts \
  "  await lockMatchedAccounts(tx, entryId)
  if (carryMatches) return { releasedApplications: apps.length, releasedMatches: 0 }" \
  "  if (carryMatches) return { releasedApplications: apps.length, releasedMatches: 0 }" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 419
section "Renaming a party from the screen is done by nobody" \
"\`updatePartyFromForm\` takes the actor the action hands it and passes
'system' on, which is what the door did before it took an actor at all. The
trigger's row names 'system' — a real value, so the whole-trail check cannot
see it; \`P54\` reads the row for the party it renamed."
edit src/lib/party-forms.ts \
  "export async function updatePartyFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {" \
  "export async function updatePartyFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  actor = 'system'" || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 420
section "The year-end closing entry is counted as a flow" \
"\`accountMovements\` stops setting closing entries aside: the entry that moves
the year's result into retained earnings reads as the year's transactions. On
a closed year the cash flow statement's profit line reads zero and the
statement of changes in equity grows an \"Other movements\" row that undoes the
profit — the shape 02-roles-and-statements.md §六 said a linear model would
produce. \`T38\` reads both statements after the close."
edit src/lib/movements.ts \
  "AND l.source NOT IN ('opening_balance', 'period_close')" \
  "AND l.source NOT IN ('opening_balance')" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 421
section "A reversal is classed by its own source, not by what it reverses" \
"The reversal of a closing entry is an 'adjustment', so when a year is reopened
the close is set aside and its reversal is counted: the profit line doubles.
\`T38b\` reopens the year and expects nothing to move."
edit src/lib/movements.ts \
  "             COALESCE(root.root_source, je.source_type) AS source" \
  "             je.source_type AS source" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 422
section "The cash effect keeps the ledger's sign" \
"A bigger receivable reads as cash received and a bigger payable as cash paid.
Every activity total is wrong by twice its size, and the proof line no longer
meets the cash accounts. \`T33\` and \`T34\`."
edit src/lib/cash-flow.ts \
  "  const effect = (m: AccountMovement) => -m.movement" \
  "  const effect = (m: AccountMovement) => m.movement" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 423
section "Opening balances are flows" \
"Beginning cash forgets the opening-balance entries dated inside the span.
A company opened with 4,000 in the bank shows beginning cash of nothing, and
the proof line says the statement does not reconcile. \`T39\`."
edit src/lib/cash-flow.ts \
  "  const beginning = total(cash, (m) => m.opening + m.openingEntries)" \
  "  const beginning = total(cash, (m) => m.opening)" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 424
section "Depreciation is an investing activity" \
"The default for accumulated depreciation moves from non-cash adjustments to
investing. The statement still foots — every activity is summed into the same
net change — and the operating figure is wrong by the year's depreciation,
which is the kind of error a footing statement hides. \`T34\` reads the
operating total."
edit src/lib/cash-flow.ts \
  "  accumulated_depreciation_ppe: 'non_cash', accumulated_depreciation_rou: 'non_cash'," \
  "  accumulated_depreciation_ppe: 'investing', accumulated_depreciation_rou: 'non_cash'," || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 425
section "A cash-flow tag no longer places the account" \
"\`sectionOf\` ignores the explicit cf_* roles, so an account with no
classification default stays under \"Not classified\" however it is tagged.
\`T36\` tags one and expects it to move."
edit src/lib/cash-flow.ts \
  "  if (tagged.length > 0) return { section: tagged[0], by: 'tag' }" \
  "  if (false) return { section: tagged[0], by: 'tag' }" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 426
section "The year's result is not retained earnings" \
"\`columnOf\` stops folding revenue and expense accounts into the retained
earnings column. The profit lands in \"Other equity\", and closing the year now
moves money between columns — which the proof row catches, and which \`T37\`
reads directly."
edit src/lib/equity-changes.ts \
  "  if (isPl(m)) return EQUITY_COLUMNS[2]" \
  "  if (false) return EQUITY_COLUMNS[2]" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 427
section "The statement door forgets the two derived statements" \
"\`statementPdf\` no longer branches on the derived codes; a request for
CASH_FLOW looks for a template of that name and finds none. The page still
draws the statement; the PDF and the workbook are gone. \`X46\`."
edit src/lib/pdf-reports.ts \
  "  if (isDerived(templateCode)) return derivedStatementPdf(ledgerId, templateCode, span, format)" \
  "  if (false) return derivedStatementPdf(ledgerId, templateCode, span, format)" || exit 1
run npm run db:verify-exports
close; restore

# --------------------------------------------------------------- 427b
section "A reversal chain is walked one hop" \
"The recursive walk stops at the roots' direct reversals, so the reversal of
a reopen — reachable from the entry page — wears its own 'adjustment' and
lands in the span's movement: the profit line reads zero and the equity
statement grows an \"Other movements\" row, while both proofs still foot.
\`T38c\` reverses the reopen and expects nothing to move."
edit src/lib/movements.ts \
  "       WHERE root.depth < 32" \
  "       WHERE root.depth < 1" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 428
section "The books contributed are everybody's" \
"\`earlierQuestionsFor\` reads every company's old questions instead of this
one's. The other company's questions, answers and the books text they sent
show on this company's Assistant page — the one leak this module must never
have. \`IQ16\` asks one in the other company. (Until 2026-09-14 this block
removed \`booksContext\`'s filter; that function went with the tick box.)"
edit src/lib/assistant.ts \
  '     WHERE x.ledger_id = ${ledgerId}::uuid' \
  '     WHERE x.ledger_id IS NOT NULL' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 429
section "An answered question leaves no row" \
"\`ask\` returns the reply without writing the exchange. The person sees the
answer; the trail of what was asked, and of what the books contributed, is
gone. \`AI6\` and \`AI10\` read the rows back."
edit src/lib/assistant.ts \
  "  const [row] = await db.execute<Exchange>(sql\`" \
  "  if (reply && !error) return { id: '', ledger_id: input.ledgerId, asked_at: '', asked_by: input.actor, model: reply.model, question, books_sent: books, answer: reply.text, stop_reason: reply.stopReason, input_tokens: reply.usage.input, output_tokens: reply.usage.output, cache_read_tokens: 0, cache_write_tokens: 0, error } as Exchange
  const [row] = await db.execute<Exchange>(sql\`" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 430
section "A refusal reads as an answer of nothing" \
"\`ask\` stops treating a refusal stop reason as a failure: the row keeps an
empty answer and no error, and the page shows a question with a blank under
it — indistinguishable from a model with nothing to say. \`AI4\`."
edit src/lib/assistant.ts \
  "  if (reply && reply.stopReason === 'refusal') {" \
  "  if (false) {" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 431
section "The trail can be edited" \
"0061's trigger lets an UPDATE through. An answer can be rewritten after the
fact, which makes the record of what the assistant said a record of what
somebody later wished it had said. \`AI7\`."
edit db/migrations/0061_a_place_to_ask.sql \
  "  BEFORE UPDATE OR DELETE ON ai_exchange" \
  "  BEFORE DELETE ON ai_exchange" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 432
section "No service is not a refusal at the door" \
"\`ask\` no longer refuses a question that came with no service. The sender is
reached with nothing to send to, and the line that builds the row then reads
a field of that nothing and crashes: the asking leaves neither the sentence
that says what to fill in nor a row. \`AI1\` hands in a sentinel sender and
expects it never to be reached; the red is the sender being reached once."
edit src/lib/assistant.ts \
  "  if (!input.service) throw new AssistantError('NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE)
  const service = input.service" \
  "  const service = input.service as Service" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 433
section "Output tokens are priced as input" \
"\`costOf\` multiplies the answer's tokens by the input price. Every figure on
the page is understated by whatever the two prices differ by, and nothing
else changes, because money is derived and this arithmetic is the only place
it comes from — which is why \`AI6\` checks the arithmetic, not a stored number."
edit src/lib/assistant.ts \
  "  return (x.input_tokens * input + x.output_tokens * output" \
  "  return (x.input_tokens * input + x.output_tokens * input" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 434
section "The sender signs the request the Anthropic way" \
"\`sendToRelay\` puts the key in an \`x-api-key\` header instead of
\`Authorization: Bearer\`. Anthropic's own endpoint would accept it; every
OpenAI-compatible relay answers 401. \`AI13\` reads the header the suite's
service received."
edit src/lib/assistant.ts \
  "      authorization: 'Bearer ' + service.apiKey," \
  "      'x-api-key': service.apiKey," || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 435
section "A content filter reads as a broken service" \
"\`content_filter\` maps to end_turn. The service's empty content is then
'no text' — a failed asking with the wrong story: the model declined, and the
row says the service broke, with no explanation of what was declined.
\`AI13b\` expects a refusal with its reason."
edit src/lib/assistant.ts \
  "  content_filter: 'refusal'," \
  "  content_filter: 'end_turn'," || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 436
section "The key goes into the trail through an error" \
"\`withoutKey\` returns its text untouched. A service that echoes the bearer
token in an error body — some do, on a malformed one — now puts the key into
\`ai_exchange.error\`, and from there into every backup, which is exactly the
one place the owner ruled it must never be. \`AI14\` asks such a service and
reads the row."
edit src/lib/assistant.ts \
  "  return text.split(apiKey).join('[key]')" \
  "  return text" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 437
section "The key is kept in the clear" \
"\`encryptKey\` returns the key as bytes. The column is still called
\`key_enc\` and still holds something that looks binary in psql, so nothing
reads as wrong — and every backup now carries every person's key in plain
text, which is the one thing the owner asked this table to prevent.
\`AI16\` looks for the key IN THE BYTES (\`position(convert_to(...) in
key_enc)\`): the first version compared the row rendered as text, where a
bytea prints as hex, and reported a clean row while the key sat in it."
edit src/lib/ai-service.ts \
  "  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])" \
  "  const body = Buffer.from(plain, 'utf8'); cipher.update(plain, 'utf8'); cipher.final()" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 438
section "A key read under the wrong secret comes back as noise" \
"\`decryptKey\` returns the raw blob instead of null when the cipher refuses
it. After the secret changes, every saved key 'reads' as a string of noise:
the page shows a service that is ready, and the first question goes out with
a key made of ciphertext. \`AI15\` and \`AI18\` expect nothing, not noise."
edit src/lib/ai-service.ts \
  "    return null // the secret is not the one it was written under, or the blob was altered" \
  "    return blob.subarray(IV_BYTES + TAG_BYTES).toString('utf8')" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 439
section "Changing the model forgets the key" \
"A blank key box no longer keeps the saved key: \`saveService\` refuses, so
changing the model or a price means typing the key again — and a person who
does not have it to hand loses the service they had. \`AI17\` saves with a
blank key on purpose."
edit src/lib/ai-service.ts \
  "  if (!apiKey && existing.kind === 'ready') apiKey = existing.saved.service.apiKey" \
  "  if (false) apiKey = ''" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 440
section "Forgetting a service leaves no trail" \
"\`clearService\` deletes the row and writes no audit line. Somebody else's
service disappearing is then indistinguishable from one that was never
saved, on a table whose whole purpose is a credential. \`AI18\` reads the
trail after forgetting."
edit src/lib/ai-service.ts \
  "    if (gone.length === 0) return
    await auditRow(tx, {" \
  "    if (gone.length === 0) return
    if (false) await auditRow(tx, {" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 441
section "The panel is handed the key it must not have" \
"\`panelStateFrom\` — the one function that decides what the screen may know —
carries the key as well as the hint. Nothing on the screen prints it, so the
markup looks the same; but a client component's props are serialised into the
page the browser downloads, so the key ships to every device that opens the
assistant. \`AI19\` reads what that function returns, not markup it built
itself: the first version of this block changed a mapping no check could see."
edit src/lib/ai-service.ts \
  "  return {
    kind: 'ready',
    host: hostOf(state.saved.service.baseUrl)," \
  "  return {
    kind: 'ready',
    apiKey: state.saved.service.apiKey,
    host: hostOf(state.saved.service.baseUrl)," || exit 1
edit src/lib/ai-service.ts \
  "  | { kind: 'ready'; host: string; baseUrl: string; model: string; hint: string
      prices: { input: number; output: number; cached: number; unit: string } | null }" \
  "  | { kind: 'ready'; apiKey?: string; host: string; baseUrl: string; model: string; hint: string
      prices: { input: number; output: number; cached: number; unit: string } | null }" || exit 1
run npm run db:verify-assistant
close; restore

# ---------------------------------------------------------------- 442
section "A PDF is read anyway" \
"\`readBill\` accepts anything at all — a spreadsheet, an archive, a video.
The refusal that keeps a file this system cannot read from ever reaching a
service, and from becoming a reading with an unhelpful error, is gone.
\`BR1\` sends a Word document to a sender that throws if it is reached."
edit src/lib/bill-reading.ts \
  "const READABLE = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)\$/" \
  "const READABLE = /./" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 443
section "The picture stays home" \
"\`sendToRelay\` sends the instruction and the chart but not the picture — the
image part is skipped, the content is plain text. A model asked to read a
bill it was not given answers about a bill it imagined. \`BR2\` reads the
request the loopback service received: two parts, the second a data URL of
the bytes that were uploaded."
edit src/lib/assistant.ts \
  "          content: req.file ? [{ type: 'text', text: req.question }, filePart(req.file)] : req.question," \
  "          content: req.question," || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 444
section "A code the chart lacks is kept" \
"\`parseProposal\` keeps whatever account code the model named. A plausible
code from some other chart then opens the review form on an account this
company does not have — which the form cannot show, and the person cannot
see. \`BR3\` feeds a proposal naming 9999 and reads back no account."
edit src/lib/bill-reading.ts \
  "      accountCode: codes.has(code) ? code : null," \
  "      accountCode: code || null," || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 445
section "A used reading is attached again" \
"\`attachReadingTo\` no longer asks whether the reading has been used. The same
photo, posted from two tabs, becomes two entries with the same receipt filed
against each. \`BR8\` attaches a used reading a second time and expects the
sentence, and one file."
edit src/lib/bill-reading.ts \
  "  if (row.used_entry_id !== null) {
    throw new BillReadingError('ALREADY_ENTERED', ENTERED_TWICE)
  }
  // A reading from a sentence alone has no paper to file: the entry is marked, and that is all." \
  '  // A reading from a sentence alone has no paper to file: the entry is marked, and that is all.' || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 446
section "A reading from another company can be attached here" \
"\`attachReadingTo\` looks the reading up by id alone. A reading id is a
UUID in a URL; with this line, one company's bill can be filed against
another company's entry and closed. \`BR8\` tries exactly that from the
other company and expects to be told the reading is not in these books."
edit src/lib/bill-reading.ts \
  "    SELECT filename, mime, bytes, used_entry_id::text FROM ai_bill_reading
     WHERE id = \${input.readingId}::uuid AND ledger_id = \${input.ledgerId}::uuid\`)" \
  "    SELECT filename, mime, bytes, used_entry_id::text FROM ai_bill_reading
     WHERE id = \${input.readingId}::uuid\`)" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 447
section "An unknown account becomes the first one" \
"\`accountIdOf\` fills a line the model could not place with the first account
in the chart instead of leaving it blank. The form then opens complete, and
the review the owner asked for — the door refusing until a person picks —
never happens, because there is nothing to pick. \`BR5\` and \`BR6\` expect
the blank."
edit src/lib/prefill.ts \
  "  const offered = remembered && [...ids.values()].includes(remembered)
  return offered ? remembered! : ''" \
  "  return (ids.values().next().value as string | undefined) ?? ''" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 448
section "Any supplier will do" \
"\`invoiceInitialFrom\` opens the bill on the first party in the list when the
document names one the books do not have. The party box is filled, the
amber notice does not appear, and the bill lands on the wrong supplier's
account. \`BR6\` names a stranger and expects the box blank and the stranger
named."
edit src/lib/prefill.ts \
  "  const match = wanted ? parties.find((p) => plainName(p.label) === wanted) : undefined" \
  "  const match = wanted ? parties[0] : undefined" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 449
section "Every company's readings" \
"\`readingsFor\` drops the company. The assistant page of one company lists
the bills read for another, with links that open its review forms on them.
\`BR3\` reads the other company's list and expects it empty."
edit src/lib/bill-reading.ts \
  "      FROM ai_bill_reading WHERE ledger_id = \${ledgerId}::uuid
       AND NOT EXISTS(SELECT 1 FROM inbox_item WHERE reading_id=ai_bill_reading.id)
     ORDER BY read_at DESC LIMIT \${limit}\`)).map(rowOf)" \
  "      FROM ai_bill_reading
     WHERE NOT EXISTS(SELECT 1 FROM inbox_item WHERE reading_id=ai_bill_reading.id)
     ORDER BY read_at DESC LIMIT \${limit}\`)).map(rowOf)" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 450
section "The expense door forgets the reading" \
"The link that opens the quick-expense form drops \`?reading=\`. The form
opens blank, nothing says why, and the bill that was read is never filed
against what the person then types. \`BR12\` reads the rendered link."
edit "src/components/ReadBill.tsx" \
  "entries/quick/expense?reading=" \
  "entries/quick/expense" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 451
section "A filing that failed reads as a posting that failed" \
"\`quickEntryFromForm\` lets the attachment's refusal fall through to the
form's error. The entry is in the books; the screen says it is not; the
person presses Post again and the bill is entered twice. \`BR14\` makes the
store refuse and expects the sentence to begin with what happened."
edit src/lib/quick-forms.ts \
  '      } catch (e) {
        // The entry IS posted. Returning an error here would say it was not,' \
  '      } catch (e) {
        throw e
        // The entry IS posted. Returning an error here would say it was not,' || exit 1
run npm run db:verify-bills
close; restore

# ---------------- 452
section "Deleting the entry a bill was filed against is refused by the reading" \
"The reading trigger (0064, replaced whole by 0077 and again by 0080) refuses the transition back to unused — which is what the
foreign key's ON DELETE SET NULL performs when the entry is deleted while its
month is open. An entry with a bill filed against it can then never be
deleted, and the trigger's own message says to delete it. \`BR15\` deletes
the entry \`BR7\` posted and expects the reading back on the page."
edit db/migrations/0080_a_minute_book_is_many_rows.sql \
  "  IF OLD.used_entry_id IS NOT NULL AND NEW.used_entry_id IS NOT NULL
     AND NEW.used_entry_id IS DISTINCT FROM OLD.used_entry_id THEN" \
  "  IF OLD.used_entry_id IS NOT NULL
     AND NEW.used_entry_id IS DISTINCT FROM OLD.used_entry_id THEN" || exit 1
run npm run db:verify-bills
close; restore

# ---------------- 453
section "The reading is looked at after the posting" \
"\`quickEntryFromForm\` stops asking \`readingRefusal\` before it posts. A
form already open with the reading's id — a second tab, a page resubmitted —
posts a second entry, and the refusal arrives from the filing step, after
the entry is in the books. \`BR16\` posts twice from one reading and
expects one entry."
edit src/lib/quick-forms.ts \
  "    if (readingId) {
      const why = await readingRefusal(g(f, F.ledgerId), readingId)
      if (why) throw new QuickEntryError('READING_REFUSED', why)
    }" \
  "" || exit 1
run npm run db:verify-bills
close; restore

# ---------------- 454
section "At the bill door a filing that failed reads as a save that failed" \
"\`createInvoiceFromForm\` lets the attachment's refusal fall through. The
bill is saved and posted; the screen says the save failed; the person saves
it again. \`BR14b\` makes the store refuse at this door too and expects the
sentence to begin with what happened."
edit src/lib/invoice-forms.ts \
  '      // A reading entered meanwhile, or gone, says what that means for the books — not "attach it by hand".' \
  '      throw e' || exit 1
run npm run db:verify-bills
close; restore

# ---------------- 455
section "Every card offers the doors" \
"\`readingCards\` — the one function that decides what the page hands the
browser for a reading — forgets which entry a reading became. Every card,
entered or not, offers both doors; the reader refuses the second entry, but
only after the person has filled the form in again. \`BR12\` builds its
cards from real rows through this function and reads the used one back."
edit src/lib/bill-reading.ts \
  "    proposal: r.proposal, error: r.error, usedEntryId: r.used_entry_id," \
  "    proposal: r.proposal, error: r.error, usedEntryId: null," || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 456
section "The Add forgets who it was with" \
"The party the person chose is dropped on the way to the line. The entry
posts, the money is right, and the expense belongs to nobody — which is the
one thing that made an Added expense different from every other kind
(owner, 2026-09-07). \`RC55\` reads the line back and asks whose it is."
edit src/lib/bank.ts \
  "      description: input.description?.trim() || contra.name, partyId: input.partyId || undefined }, ...split.taxLines)" \
  "      description: input.description?.trim() || contra.name }, ...split.taxLines)" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 457
section "A tag on a bank row adds tax on top of what the bank moved" \
"\`splitTaggedLine\` computes exclusive. The bank moved 112.00 and the entry
now says 112.00 of expense plus 5.60 of tax against a 112.00 bank line, so it
does not balance — or, where it does, the expense is overstated by the tax
that was already inside it. \`RC55\` adds the lines up."
edit src/lib/tagged-line.ts \
  "  const t = computeTax(amount < 0n ? -amount : amount, code as TaxCode, true, on)" \
  "  const t = computeTax(amount < 0n ? -amount : amount, code as TaxCode, false, on)" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 458
section "Tax paid and tax collected land on the same account" \
"The side is no longer read off the line's sign: everything goes to the
recoverable account. GST collected on a sale is then claimed back instead of
remitted — the return is wrong in both boxes at once and the entry balances
perfectly. \`RC55\` posts one of each and reads both accounts; \`D22\` does the
same on a journal line."
edit src/lib/tagged-line.ts \
  "    const role = bought ? GST_ROLE.bought : GST_ROLE.sold" \
  "    const role = GST_ROLE.bought" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 459
section "A bank entry goes back to being uneditable" \
"\`bank\` leaves the open-edit sources, so the entry made from a row can only
be corrected by reversal again — three entries for every typo, which is what
the owner asked to be rid of. \`M27b\` deletes one at the entry door and
\`RC56\` edits one."
edit src/lib/posting.ts \
  "export const OPEN_EDIT_SOURCES: SourceType[] = ['manual', 'quick_expense', 'quick_income', 'adjustment', 'bank']" \
  "export const OPEN_EDIT_SOURCES: SourceType[] = ['manual', 'quick_expense', 'quick_income', 'adjustment']" || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 460
section "Editing a bank entry unreconciles its row" \
"The carry goes: an edit releases the match like any other source. Fixing the
expense account on an Added row then puts the row back in the feed as
unaccounted, and a reconciliation that was finished last month disagrees with
itself. \`RC56\` edits one and counts what was released."
edit src/lib/posting.ts \
  "    const carry = e.source_type === 'bank'" \
  "    const carry = false" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 461
section "The carried match is never re-judged" \
"\`recheckMatches\` stops touching the rows, so the guards that live on
\`bank_match\` never fire for an edit that changed the lines underneath them.
An Added entry can then be edited off the bank account entirely while the row
goes on reading as settled by it. \`RC56\` makes exactly that edit and expects
the whole thing refused."
edit src/lib/posting.ts \
  "    if (carry) await recheckMatches(tx, entryId)" \
  "    if (false) await recheckMatches(tx, entryId)" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 462
section "Adding a row again replays the first entry" \
"The replay key knows only how much was left, not what is being posted
against it. Deleting a wrong Add and adding the row again with the right
account then returns the deleted entry's number and reports success, and
nothing was posted. \`RC58\` adds the same row twice against two accounts."
edit src/lib/bank.ts \
  "  const shape = [categories, input.taxCode ?? '', input.partyId ?? '', wordingKey].join(':')" \
  "  const shape = ''" || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 463
section "A correction's reversal is offered as a candidate" \
"\`candidateEntries\` takes the reversal half of a correction pair back. It
moves the account the opposite way from the entry it cancels, so every
corrected payment reads as a deposit waiting to be claimed, and a real
deposit is offered a match that is not money — the owner's feed did exactly
this. \`M49b\` reverses an entry and reads the next row's candidates."
edit src/lib/bank.ts \
  "                            AND e.reverses_id IS NULL" \
  "                            AND true" || exit 1
run npm run db:verify-bank-match
close; restore

# ---------------------------------------------------------------- 464
section "The quick screens demand a description again" \
"The refusal comes back, so an expense with nothing to add beyond its account
and its amount cannot be posted at all. \`Q10\` posts three: one described,
one that borrows its line's wording, one with neither."
edit src/lib/quick-forms.ts \
  "    const description = typed || firstWording || (kind === 'expense' ? 'Expense' : 'Income')" \
  "    const description = typed" || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 465
section "The quick form is free to squeeze" \
"The minimum width goes. In a narrow window, or in the overlay, ten fields
share whatever is left and the amount box ends up four characters wide — the
state the owner reported. \`Q11\` renders the screen and reads the class off
the form."
edit $'src/app/ledger/[ledgerId]/entries/quick/[kind]/QuickForm.tsx' $'          <div ref={orderRef} className="table-scroll" data-table-scroll tabIndex={0} role="region" aria-label="Entry line items"><div className="min-w-[60rem] space-y-2">' $'          <div ref={orderRef} className="table-scroll" data-table-scroll tabIndex={0} role="region" aria-label="Entry line items"><div className="space-y-2">' || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 466
section "A tagged journal line posts with the tax inside it" \
"\`expandTaggedLines\` passes every line through untouched. The tag on the
screen then means nothing: the whole amount lands on the account it was typed
against, the GST return never sees it, and the entry balances — which is why
nobody notices. \`D22\` reads the lines the door would post."
edit src/lib/tagged-line.ts \
  "    if (!line.taxCode) {" \
  "    if (true) {" || exit 1
run npm run db:verify-drafts
close; restore

# ---------------------------------------------------------------- 467
section "PST paid is claimed back" \
"The non-recoverable half of the rule goes: PST on something bought is put on
a tax account instead of folded into what the thing cost. In BC that is
claiming back a tax nobody may claim, and the expense is understated by it.
\`D22\` tags a purchase GST+PST and reads the expense line."
edit src/lib/tagged-line.ts \
  "  const kept = bought ? t.base + t.pst : t.base" \
  "  const kept = t.base" || exit 1
run npm run db:verify-drafts
close; restore

# ---------------------------------------------------------------- 468
section "Closing a period asks to be asked twice" \
"The panel starts collapsed again on top of the URL that already chose this
period, so the person presses \"Close…\", gets a button that says \"Close
January 2026\", and must press that before the readiness, the override box
and the lock tick appear — the state the owner reported. \`P30\` renders the
panel and expects the form without pressing anything."
edit "src/app/ledger/[ledgerId]/periods/PeriodActions.tsx" \
  "  if (state.ok) return <span className=\"text-xs text-emerald-700 dark:text-emerald-400\">{state.ok}</span>

  const blocking = readiness.filter((r) => r.severity === 'blocking')" \
  "  if (state.ok) return <span className=\"text-xs text-emerald-700 dark:text-emerald-400\">{state.ok}</span>
  if (periodName) return <button className=\"text-xs\">Close {periodName}</button>

  const blocking = readiness.filter((r) => r.severity === 'blocking')" || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 469
section "The tab goes back to the scaffold's name" \
"\`APP_NAME\` returns to what create-next-app wrote. Every tab of every
company then says the same three words, and the one thing a tab is for —
telling one open company from another — is gone. \`P31\` reads the constant,
the template under it and the shell that names the company."
edit src/lib/app-name.ts \
  "export const APP_NAME = 'Banyan'" \
  "export const APP_NAME = 'Create Next App'" || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 470
section "An archived company still takes postings" \
"The trigger 0065 put on \`journal_entry\` goes. A company put away because
it was dissolved goes on accepting entries — through the door, and through
any SQL anybody writes later. The screens hide it, which is exactly what
makes it worse: the entries land where nobody is looking. \`CO2\` posts into
one, through the door and by hand."
edit db/migrations/0065_a_company_can_be_put_away.sql \
  "  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'ENTITY_ARCHIVED: % was archived on %; bring it back before posting into it'," \
  "  IF false THEN
    RAISE EXCEPTION 'ENTITY_ARCHIVED: % was archived on %; bring it back before posting into it'," || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 471
section "A company with books can be removed" \
"\`deleteCompany\` stops counting what is in the books. The refusal that
stands between a typed code and a real company's entries, invoices, payslips
and bank statements is gone; what happens next is whatever the foreign keys
happen to allow, which is not a guard. \`CO4\` tries it on a company that
has one entry and expects to be told to archive it instead."
edit src/lib/companies.ts \
  "  if (company.entries !== '0') {" \
  "  if (false) {" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 472
section "Removing a company leaves its ledger behind" \
"One table drops out of the delete's list. The company row goes and its
ledger stays, pointing at nothing — every query that joins entity to ledger
silently loses it, and the row cannot be reached to be cleaned up. \`CO5\`
counts what is left; \`CO7\` reads the list against the database's own
foreign keys."
edit src/lib/companies.ts \
  "{ order: 16, table: 'ledger' }," \
  "// ledger omitted" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 473
section "Archiving asks for no reason" \
"The reason becomes optional. In three years the only thing that can explain
a company nobody remembers is the sentence somebody typed, and there is
none. \`CO1\` archives with blanks and expects the refusal."
edit src/lib/companies.ts \
  "  if (!why) {" \
  "  if (false) {" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 474
section "The archived company is hidden instead of listed" \
"\`companiesWithState\` drops the archived ones. Its books are still there and
still readable by URL, but nothing on any screen says the company exists, so
the door back is unreachable and a person concludes their books are gone.
\`CO8\` archives one and reads the list."
edit src/lib/companies.ts \
  "  return db.execute<CompanyRecord>(sql\`\${await companyHead()} ORDER BY e.archived_at IS NOT NULL, e.code\`)" \
  "  return db.execute<CompanyRecord>(sql\`\${await companyHead()} WHERE e.archived_at IS NULL ORDER BY e.code\`)" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 475
section "The typed code is not compared" \
"The delete form stops checking what was typed against the company's code, so
the confirmation is a box a person tabs through. The library still refuses a
company with books, but the empty one it was never meant to remove goes on
the first stray click. \`CO6\` types the code in lower case."
edit src/lib/company-forms.ts \
  "    if (!expected || typed !== expected) {" \
  "    if (!expected) {" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 476
section "The archive gate goes back to covering two doors" \
"0066's triggers go, leaving 0065's two. An archived company then accepts an
invoice, a pay run, a bill the assistant read, an imported bank file and a
statement — every one of them a document that exists BEFORE it posts, so the
refusal at Post (where there is one) arrives after the paper is already
there. \`CO2\` tries all five."
edit db/migrations/0066_the_archive_gate_covers_every_door.sql \
  "CREATE TRIGGER trg_invoice_entity_archived
  BEFORE INSERT ON invoice" \
  "CREATE TRIGGER trg_invoice_entity_archived
  BEFORE DELETE ON invoice" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 477
section "Archiving a company deletes everybody's access to it" \
"\`allCompanies\` filters on \`is_active\` again, which since 0065 means 'not
archived'. The grants screen sends back every tick, so the archived company
— absent from the ticks — has its grants deleted the next time ANYBODY's
access is saved, and bringing the company back does not bring them back.
\`CO9\` archives a granted company, saves an unrelated person's access, and
reads the grants."
edit src/lib/access.ts \
  "    SELECT id::text, code, name, (archived_at IS NOT NULL) AS archived
      FROM entity ORDER BY archived_at IS NOT NULL, code\`)" \
  "    SELECT id::text, code, name, (archived_at IS NOT NULL) AS archived
      FROM entity WHERE is_active ORDER BY code\`)" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 478
section "A filed receipt keeps whatever the phone called it" \
"The derivation goes: the list hands back the name the row stores instead of
working it out from the entry. Receipts are called IMG_4471.HEIC and
scan0003.pdf again — names that say nothing about which entry they belong
to — and, because the name is no longer worked out at all, an edited entry's
paper keeps whatever it was called before. \`AT12\` files three and reads
their names; \`AT13\` edits an entry and re-reads its paper."
edit src/lib/attachments.ts \
  "  return rows.map((r, i) => ({ ...r, filename: filedAs(r, r.uploaded, i + 1) }))" \
  "  return rows.map((r) => ({ ...r, filename: r.uploaded }))" || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 479
section "Two receipts on one entry get the same name" \
"The counter goes. Every receipt on one entry is then called the same thing
in the app and in the download — the folder link keeps them apart by their
sha, so nothing is lost on disk, but a person reading a list of three
identically named files cannot tell which is which. \`AT12\` files a second
and a third on one entry."
edit src/lib/attachments.ts \
  "  return position <= 1 ? \`\${base}\${ext}\` : \`\${base} (\${position})\${ext}\`" \
  "  return \`\${base}\${ext}\`" || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 480
section "A store that refuses unposts the entry" \
"\`attachIfAny\` lets the store's refusal out as a throw. The entry is in the
books and the screen says the posting failed, so the person posts it again —
the duplicate this door was shaped to avoid. \`Q12\` blocks the store and
expects the sentence to begin with what happened."
edit src/lib/attach-forms.ts \
  "  } catch (e) {
    return \` The file could not be filed against it (\${sentence(e)}); attach it from the entry by hand.\`
  }" \
  "  } catch (e) {
    throw e
  }" || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 481
section "The quick form's receipt is dropped on the floor" \
"The quick door stops filing what the form carried. The person chose a file,
the entry posted, and nothing anywhere says the file went nowhere. \`Q12\`
posts one and counts what is on the entry."
edit src/lib/quick-forms.ts \
  "    const paper = await attachIfAny(f, {
      ledgerId: g(f, F.ledgerId), entryId: posted.entry.id, actor,
    })" \
  "    const paper = ''" || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 482
section "The invoice's own bill is dropped" \
"Same at the invoice door: the supplier's bill goes with the form and is
never filed. \`V117\` saves a purchase bill with its scan and reads the
entry's attachments."
edit src/lib/invoice-forms.ts \
  "    const paper = await attachIfAny(f, {
      ledgerId: g(f, F.ledgerId), entryId: posted.entryId, actor,
    })" \
  "    const paper = ''" || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 483
section "The journal entry's paper is dropped" \
"And at the journal entry door. \`D23\` posts an entry with a file and reads
the entry back."
edit src/lib/entry-forms.ts \
  "  const paper = await attachIfAny(f, { ledgerId: input.ledgerId, entryId: result.entryId, actor: input.actor })" \
  "  const paper = ''" || exit 1
run npm run db:verify-drafts
close; restore

# ---------------------------------------------------------------- 484
section "The quick form is told its width twice again" \
"ONE field of a line row goes back to carrying \`w-full\` beside its own
width — the amount box, which is enough to show the defect. Two width
utilities of equal specificity, and the stylesheet's order decides:
\`w-full\` is emitted after \`w-28\`, so that box takes the whole row and
what shares the row with it is squeezed. The owner's screenshot is this,
four times over. \`Q11\` reads the row's field tags and reddens on any class
list carrying two width tokens."
edit "src/app/ledger/[ledgerId]/entries/quick/[kind]/QuickForm.tsx" \
  '                     className={`${field} w-full text-right tabular-nums`} />' \
  '                     className={`${input} w-28 text-right tabular-nums`} />' || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 485
section "The invoice edit door drops the file it offered" \
"\`updateInvoiceFromForm\` stops filing what the edit form carried. The form
still shows the box — it is the same component as the create form — so a
person picks a file, is told the change saved, and the file is gone without
a word. That is the defect this node exists to remove, at the one door that
had it. \`V119\` edits an invoice with a file and reads the entry."
edit $'src/lib/invoice-forms.ts' $'    const paper = r.entryId\n      ? await attachIfAny(f, { ledgerId: g(f, F.ledgerId), entryId: r.entryId, actor })\n      : upload instanceof File && upload.size > 0 ? \' The file was not attached. Post this draft first, then attach it.\' : \'\'' $'    const paper = \'\'' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 486
section "The line editor's headings drift off their columns" \
"The last grid track goes back to \`auto\`. The headings and the rows are two
grid containers: over the empty heading cell \`auto\` is 0, over each row it
is the width of the up/down/remove cluster, and the flexible description
column absorbs the difference — so every heading from \"Line description\"
rightward sits to the left of what it names. \`V118\` renders both and
compares the templates."
edit $'src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx' $'  const TEMPLATE = \'grid grid-cols-[2rem_13rem_minmax(6rem,1fr)_6.5rem_8rem_14.5rem_4.5rem] items-center gap-2\'' $'  const TEMPLATE = \'grid grid-cols-[2rem_13rem_minmax(6rem,1fr)_6.5rem_8rem_auto_4.5rem] items-center gap-2\'' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 487
section "A PDF goes as a picture" \
"A PDF is put in an \`image_url\` part instead of the \`file\` part the format
defines for a document. A service reading the OpenAI shape looks for an
image there and finds a PDF's bytes, so the bill is never read — and the
failure arrives as whatever that service happens to say. \`BR1b\` reads the
request the loopback service received."
edit src/lib/assistant.ts \
  "  return file.mime === 'application/pdf'" \
  "  return false" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 488
section "A PDF is refused again" \
"PDFs leave the readable list, so most bills — which arrive as PDFs — are
turned away with a sentence telling the person to photograph their own
screen. That is the state the owner called unusable. \`BR1b\` sends one."
edit src/lib/bill-reading.ts \
  "const READABLE = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)\$/" \
  "const READABLE = /^image\/(png|jpe?g|webp|gif)\$/" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 489
section "The reader's door refuses the screen it sits on" \
"\`readBillAction\` goes back to the assistant seat alone, while the reader
now sits on Expenses and on Invoices. Somebody granted those two and not the
Assistant sees the upload box and is thrown to /no-access the moment they
use it — the attachment doors' defect, at a new door. \`BR17\` reads the
seats each door accepts."
edit src/app/actions.ts \
  "  const user = await requireLedger(ledgerId, ['/expenses', '/invoices', '/assistant'])" \
  "  const user = await requireLedger(ledgerId, '/assistant')" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 490
section "The file picker refuses what the reader reads" \
"The upload control's \`accept\` list drops PDFs while every sentence around
it — its own caption, the doc, the changelog — goes on saying a bill may be
one. The file dialog simply does not offer them, so the capability is
unreachable from either screen and nothing looks broken. That is the state
this node shipped in until the review caught it. \`BR17\` reads the control."
edit "src/components/ReadBill.tsx" \
  'accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/png,image/jpeg,image/webp,image/gif"' \
  'accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"' || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 491
section "The moved route belongs to no seat again" \
"The \`readings\` entry leaves \`DETAIL_ROUTES\`. \`seatsForPath\` then returns
nothing for it and \`refuseFor\` reads that as a refusal, so nobody but an
owner can open the bill beside the form that was filled in from it — and
before 2026-09-03 the same shape meant the opposite, handing a seatless
route's data to anybody holding any seat at all. \`BR17\` reads the
declaration; \`N18\` and \`US20\` read the whole tree."
edit src/lib/nav.ts \
  "    segment: 'readings'," \
  "    segment: 'readings-undeclared'," || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 492
section "The books are not asked where this supplier went last time" \
"The remembered account is dropped on the way into the form, so a line the
model could not place opens blank even though this company posted the same
supplier's last bill to a particular account. The account is the one box a
person cannot fill from the bill alone, and it was the one box that never
filled. \`BR18\` posts last month's bill, then reads what the form opens on."
edit src/lib/prefill.ts \
  "  const offered = remembered && [...ids.values()].includes(remembered)" \
  "  const offered = false" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 493
section "Any supplier's last account will do" \
"\`rememberedAccount\` stops comparing the name, so the most recent posted
expense in the whole company is offered for every bill — a phone bill opens
on whatever last month's legal fees went to, in a box that looks filled in
and reviewed. \`BR18\` asks it about a supplier the books have never seen."
edit src/lib/bill-reading.ts \
  '         AND ${SAME_PAYEE(sql`p.name`)} = ${SAME_PAYEE(sql`${name}::text`)}' \
  '         AND true' || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 494
section "The model's own suggestion is thrown away" \
"A code the chart does not have is dropped without trace again, so a model
that answered 6200 for a chart with no 6200 leaves a blank box and no sign
it had an opinion — the person cannot tell a silent model from a mismatched
one, and does not learn which account they are missing. \`BR18\` reads a
proposal naming a code this ledger has not."
edit src/lib/bill-reading.ts \
  "      suggestedCode: code || null," \
  "      suggestedCode: null," || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 495
section "The payee comparison deletes the letter S" \
"The description branch goes back to its own copy of the normalisation, with
a backslash-s written inside a tagged template — which cooks away, so
Postgres deletes runs of the letter S instead of collapsing whitespace.
\"Staples\" and \"Taple\" become the same payee and two suppliers can hand
each other their accounts. \`BR18\` asks about \"Taple\" after posting to
\"Staples\"."
edit src/lib/bill-reading.ts \
  '         AND ${SAME_PAYEE(sql`e.description`)} = ${SAME_PAYEE(sql`${name}::text`)}' \
  '         AND btrim(regexp_replace(regexp_replace(lower(e.description), '"'"'[0-9]+'"'"', '"'"''"'"', '"'"'g'"'"'), '"'"'s+'"'"', '"'"' '"'"', '"'"'g'"'"')) = btrim(regexp_replace(regexp_replace(lower(${name}::text), '"'"'[0-9]+'"'"', '"'"''"'"', '"'"'g'"'"'), '"'"'s+'"'"', '"'"' '"'"', '"'"'g'"'"'))' || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 496
section "A corrected account is remembered as the right one" \
"The reversal half of a correction pair is taken back into the memory. It
carries the same account and the same party as the entry it cancels, so
after somebody corrects a bill the newest entry naming that supplier is the
account they corrected AWAY, and the next bill opens on it. \`BR18\` posts a
wrong account, reverses it, and asks."
edit src/lib/bill-reading.ts \
  '         AND e.reverses_id IS NULL
         AND ${SAME_PAYEE(sql`p.name`)}' \
  '         AND ${SAME_PAYEE(sql`p.name`)}' || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 497
section "A remembered account the form does not offer is used anyway" \
"\`accountIdOf\` stops asking whether this form offers the remembered
account. A box handed a value matching no option holds neither the memory
nor the blank, and looks like something a person chose. It was a REVENUE
account that showed this, on the grounds that a quick-expense form offered
only expense ones — that stopped being true on 2026-09-07, when the form
began offering the whole chart so a laptop could be entered on it. It is
ANOTHER COMPANY'S account now, which no form offers and no door would
take. \`BR18\` hands it one."
edit src/lib/prefill.ts \
  "  const offered = remembered && [...ids.values()].includes(remembered)" \
  "  const offered = remembered" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 498
section "A box filled from the books looks like one a person chose" \
"The row stops saying where its account came from, so an account taken from
last month's bill is indistinguishable from one the person picked — and the
sentence above the lines, the only thing asking them to check it, never
appears. \`BR18\` reads the flag the form renders from."
edit src/lib/prefill.ts \
  "        tax: (l.taxCode || 'OUT_OF_SCOPE') as TaxCode,
        fromMemory: accountId !== '' && !(l.accountCode && ids.get(l.accountCode))," \
  "        tax: (l.taxCode || 'OUT_OF_SCOPE') as TaxCode,
        fromMemory: false," || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 499
section "The overlay is handed nothing" \
"The intercepting route stops reading \`searchParams\`, so \`?reading=<id>\`
reaches the deep link and never the overlay — and the overlay is what a
person gets when they press the card's button. The form opens blank, with
no sign anything was meant to be in it. The one-renderer rule keeps the two
screens from drifting in what they DRAW; this is them drifting in what they
are GIVEN. \`N20\` compares what each hands the body — not whether the word appears in
the file, because a route that keeps the parameter and ignores it reads the
same either way, which is exactly the shape this had."
edit $'src/app/ledger/[ledgerId]/@modal/(.)entries/quick/[kind]/page.tsx' $'      <QuickBody ledgerId={ledgerId} kind={kind} readingId={reading} copyId={copy} />' $'      <QuickBody ledgerId={ledgerId} kind={kind} copyId={copy} />' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 500
section "Any one word typed is enough to keep an option" \
"The matching rule goes from every word to any word, so typing \"office
rent\" leaves \"5200 Office and Supplies\" in the list — the second word
does the narrowing and this stops doing it. Half-remembering a name is
exactly when a person types two words. \`PK3\` types a word the option does
not have."
edit src/lib/picker-matching.ts \
  '  return words.every((w) => hay.includes(w))' \
  '  return words.some((w) => hay.includes(w))' || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 501
section "Only the name is searched, not what it is" \
"The hint beside an option stops being searched, so \"supplier\" no longer
narrows the list to suppliers and \"expense\" no longer finds expense
accounts. The hint is the only thing on the row that says what the option
IS. \`PK2\` types a role."
edit src/lib/picker-matching.ts \
  "  const hay = plain(option.label + ' ' + (option.hint ?? ''))" \
  '  const hay = plain(option.label)' || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 502
section "Typing in lower case finds nothing" \
"Folding stops folding case, so a chart written in Title Case answers to
nothing anybody types. This is the defect that looks like an empty list
rather than like a bug. \`PK4\` types in the wrong case."
edit src/lib/picker-matching.ts \
  "const plain = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()" \
  "const plain = (s: string) => s.replace(/\s+/g, ' ').trim()" || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 503
section "A picker with no name posts anyway" \
"The hidden field stops being conditional, so the journal entry — which
serialises all its lines into one JSON field — grows a nameless input
beside them. A field nothing reads today is a field something starts
reading by accident. \`PK6\` renders the nameless shape."
edit src/components/Picker.tsx \
  '      {name && <input type="hidden" name={name} value={id} form={form} />}' \
  '      <input type="hidden" name={name} value={id} form={form} />' || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 504
section "The choices are only in the page once it is open" \
"The list stops being rendered-and-hidden and becomes rendered-when-open.
Nothing on the screen changes. What changes is that a static render can no
longer see what the form offers — and a great deal of this project's
evidence is exactly that reading, so replacing selects with this would have
blinded those checks rather than failed them. \`PK7\` reads the closed list."
edit $'src/components/Picker.tsx' $'      <div ref={menu} id={listId} role="listbox" popover="manual" hidden={!open || disabled}' $'      <div ref={menu} id={listId} role="listbox" popover="manual" hidden={open}' || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 505
section "The box opens showing a UUID" \
"What is chosen is put in the box as its id instead of its name, so a form
opened on an existing invoice shows the person a UUID where the account
was. \`PK8\` opens on a chosen option."
edit src/components/Picker.tsx \
  "  const typed = currentDraft
    ? (currentDraft.query === '' && chosen ? chosen.label : currentDraft.text)
    : (chosen?.label ?? '')" \
  "  const typed = currentDraft
    ? (currentDraft.query === '' && chosen ? chosen.label : currentDraft.text)
    : candidateId" || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 506
section "A required picker can be left empty" \
"The requirement comes off the box a person types in. The forms here call
\`reportValidity()\` before they dispatch, so the browser stops scrolling to
the empty field and saying so — the refusal arrives from the server
instead, after the press, naming a field. \`PK9\` reads where required sits."
edit src/components/Picker.tsx \
  '        required={required}' \
  '        required={false}' || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 507
section "The creating row appears only once it is already open" \
"The condition on the creating button is flipped, so the row that makes the
thing you were looking for is offered only while it is being filled in —
which is to say never. The list simply has nothing in it and no way out.
\`PK10\` looks for the button."
edit src/components/Picker.tsx \
  '          {create && !creating && (' \
  '          {create && creating && (' || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 508
section "Making an account needs the chart seat again" \
"The creating door goes back to asking for \`/accounts\` alone. Every picker
outside the chart screen then offers a button that refuses — somebody who
may enter a bill is told they may not add the account it belongs in, from
inside the form that will not accept the bill without one. \`N18\` re-derives
each door's seat from the pages its form is actually on."
edit src/app/actions.ts \
  "  await requireLedger(ledgerId, ['/accounts', '/entries', '/invoices', '/bank', '/opening', '/payroll', '/cheques'])" \
  "  await requireLedger(ledgerId, '/accounts')" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 509
section "Adding a party needs the address book seat again" \
"The same, one door along. The widening is deliberate and narrow — only
the CREATING door, never renaming or ending a role — and a check that
re-derives it from the tree is what keeps the narrowness honest. \`N18\`
names the screens the form is on."
edit src/app/actions.ts \
  "  await requireLedger(ledgerId, ['/parties', '/entries', '/invoices', '/bank', '/payroll', '/records', '/cheques'])" \
  "  await requireLedger(ledgerId, '/parties')" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 510
section "An invoice line's account is chosen and the row never hears" \
"The line editor stops listening to its own picker. The hidden field still
posts the right account, so the invoice saves correctly — and the running
total on the screen, which counts the rows it holds, goes on saying the
line is empty. Right answer, wrong screen. What this block proves is the
first half of that: \`V95bg\` is the guard saying the field has no
\`onChange\` at all, so the choice reaches nobody. The stale total is the
consequence, and nothing in this tree can press a button to watch it
happen."
edit "src/app/ledger/[ledgerId]/invoices/InvoiceLines.tsx" \
  "                    onChange={(id) => setState(editRow(state, row.key, 'account', id))} />" \
  '                    />' || exit 1
run npm run db:verify-invoices
close; restore



# ---------------------------------------------------------------- 511
section "A chosen picker offers only what is already chosen" \
"Filtering goes back to reading the BOX instead of what was typed. Choosing
puts the option's label in the box, so opening a picker that already holds
an account shows that account and nothing else — the person has to clear
the words before they can see the list they came to look at. It also drops
every other option out of the markup, which is where this project's
select-shaped evidence reads what a form offers. \`PK7\` renders one with
something chosen."
edit src/components/Picker.tsx \
  '  const shown = useMemo(() => options.filter((o) => matches(o, query)), [options, query])' \
  '  const shown = useMemo(() => options.filter((o) => matches(o, typed)), [options, typed])' || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 512
section "Only cash can pay for anything again" \
"The money side goes back to demanding the cash role, so a credit card and
a shareholder loan stop being places money can come out of — which is where
most of a small company's money actually goes out from. Every such receipt
has to be entered as a journal entry instead. \`Q4h\` pays for fuel with a
shareholder loan."
edit src/lib/quick.ts \
  "            AND (a.account_type = 'liability'
                 OR EXISTS (SELECT 1 FROM account_role ar" \
  "            AND (false
                 OR EXISTS (SELECT 1 FROM account_role ar" || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 513
section "The offer and the door stop agreeing about the money side" \
"The list the form is built from narrows back to cash while the door goes
on accepting liabilities. Nothing refuses anything; the credit card simply
is not in the box, and the only way to find out it would have been accepted
is to read the source. Two spellings of one question, which is this
repository's oldest defect shape. \`Q4j\` tries every account in a chart
against both."
edit src/lib/quick.ts \
  "         AND (a.account_type = 'liability'
              OR EXISTS (SELECT 1 FROM account_role ar" \
  "         AND (false
              OR EXISTS (SELECT 1 FROM account_role ar" || exit 1
run npm run db:verify-quick
close; restore


# ---------------------------------------------------------------- 515
section "A line that gives money back is refused again" \
"Zero and negative are refused together, so a rebate on the same receipt,
a returned deposit, or a trade-in cannot be entered where the rest of the
receipt is. The refusal reads as an arithmetic rule and is a habit. \`Q4g\`
enters 300 out and 50 back."
edit src/lib/quick.ts \
  '    if (item.amount === 0n) {' \
  '    if (item.amount <= 0n) {' || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 516
section "The receipt stops saying who it was with" \
"The party is dropped from the item lines. The entry is right, the money is
right, and the Expenses screen — which groups by the line's own party — no
longer knows the receipt belongs to that supplier, so it appears under
nobody. The box on the form goes on accepting a name. \`Q4i\` reads the
posted lines."
edit src/lib/quick.ts \
  '        partyId: party,' \
  '        partyId: undefined,' || exit 1
run npm run db:verify-quick
close; restore

# ---------------------------------------------------------------- 517
section "The party is put on every line, the bank one included" \
"The other half of the same seam. The bank line carries the supplier too,
so the Expenses screen counts the receipt twice under that supplier — once
for what was bought and once for the money leaving. Both figures are real
and the total is wrong. \`Q4i\` names which lines may carry it."
edit $'src/lib/quick.ts' $'        partyId: fundingParty },' $'        partyId: party },' || exit 1
run npm run db:verify-quick
close; restore


# ---------------------------------------------------------------- 518
section "A table quietly drops out of the backup" \
"\`journal_line\` stops being carried. The file still packs, still restores,
and the restored company still opens — with a chart, periods, invoices and
entries, and not one line of money in any of them. A backup that leaves a
table out is worse than no backup, because it looks complete. \`BK1\` holds
every table in the database to a decision."
edit src/lib/backup.ts \
  "{ order: 33, table: 'journal_line', by: 'entry' }," \
  "" || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 519
section "A restore keeps the ids it was given" \
"Every row goes back in under the id it had. Restoring a company beside the
one it came from then collides on the primary key — but restoring into an
EMPTY database succeeds, so this passes every test somebody runs once and
fails the first time it matters. \`BK2b\` restores beside the original."
edit src/lib/backup.ts \
  "        if (typeof row.id === 'string') map.set(row.id, randomUUID())" \
  "        if (typeof row.id === 'string') map.set(row.id, row.id)" || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 520
section "The restore loads with the guards still on" \
"The line that turns the triggers off goes, and the load fights every guard
the live books have: a closed period refusing its own entries, a posted
invoice refusing raw SQL, a payroll record arriving before the role it
needs, a share transfer refused half-written. Five restores died that way
before this was the answer (owner, 2026-09-07). The guards protect live
books from a hand at a prompt; a restore is neither. \`BK2b\` restores a
company with all four of those things in it."
edit src/lib/backup.ts \
  "      await tx.execute(sql\`SET LOCAL session_replication_role = 'replica'\`)" \
  "      await Promise.resolve()" || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 521
section "Nothing checks what the file pointed at" \
"The refusal goes, so a file that does not hold everything it names is
restored anyway — and because the foreign keys are off during the load,
nothing else notices. An id the file does not carry is not remapped, and
unchanged it names the row it was COPIED FROM: the restored company reads
another company's rows and looks perfectly well. That is worse than a
restore that fails. \`BK11\` offers a file with a bank row taken out of it."
edit src/lib/backup.ts \
  '    if (unresolved.length > 0) {' \
  '    if (false) {' || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 522
section "A restore copies the shared party instead of finding it" \
"The match by name goes. The address book is one list for every company
and the database refuses two active parties with one name, so this fails
outright on a party that is already here — and on a name that has
changed since, it silently splits the supplier in two. Restoring into
the database a backup came from finds the party by ID and never looks
further, so this is invisible there: \`BK7b\` takes the road every
restore onto a fresh machine takes."
edit src/lib/backup.ts \
  '      const [byName] = await tx.execute<{ id: string }>(sql`' \
  '      const [byName] = [] as Array<{ id: string }>; await Promise.resolve(sql`' || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 523
section "A backup file is trusted whatever is in it" \
"The checksum is not read back. A file edited by hand — a name, a figure, a
whole entry — restores as though it were the one that was saved, and the
only sign is that the books do not add up to what they used to. \`BK9\` edits
one and offers it."
edit src/lib/backup.ts \
  "  if (typeof doc.checksum !== 'string' || doc.checksum !== hash(bodyOf(doc))) {" \
  '  if (false) {' || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 524
section "A backup from a newer FigTree is restored anyway" \
"The version gate goes. A file holding columns this database has no place
for is restored with those columns dropped on the floor — a company that
looks whole and has quietly lost whatever the newer version knew. \`BK9\`
offers a file claiming five migrations more than this database has run."
edit src/lib/backup.ts \
  '  if (doc.schema.count > here.count) {' \
  '  if (false) {' || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 525
section "The check that reads the file asks nothing" \
"The reference check keeps its refusal and stops finding anything to refuse:
every foreign key is skipped, so it reports a clean file whatever is in one.
A guard that cannot fail is the shape this repository hunts — and this one
is the whole reason it is safe to load with the foreign keys off. \`BK11\`
offers a file that is missing a row something else names."
edit src/lib/backup.ts \
  '    if (!carried.has(k.parent)) continue' \
  '    if (true) continue' || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 526
section "The key that catches a double click is copied too" \
"\`journal_entry.idempotency_key\` travels with the entry. It is unique across
the WHOLE table, so restoring beside the company it came from is refused by
\`journal_entry_idempotency_key_key\` — which is what the owner met on their
second real restore. And a restore into an empty database, where nothing
collides, produces a copy claiming to be the same submission as the
original. \`BK4c\` looks for it in the restored company."
edit src/lib/backup.ts \
  "journal_entry: ['idempotency_key']," \
  "journal_entry: []," || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 527
section "The restored company keeps the code it came from" \
"The code and name chosen for the restored company stop being applied, so it
arrives under the original's — and the original is right there, so
\`entity_code_key\` refuses the whole thing. On a machine where the original
is NOT there it succeeds, and two companies that are copies of each other
then share a code the moment one is moved. \`BK2b\` restores beside the
company the file came from."
edit src/lib/backup.ts \
  "    await insert(tx, 'entity', { ...doc.entity, id: entityId, code, name }," \
  "    await insert(tx, 'entity', { ...doc.entity, id: entityId }," || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 528
section "A unique value nobody thought about stops being a decision" \
"One entry leaves \`UNIQUE_HANDLED\`, which is what the guard is made of. The
same defect reached the owner twice — ids, then an idempotency key — and
both times what was missing was not the fix but the question. \`BK1b\` asks
it of every unique index in the database: either one of its columns is a
value the restore rewrites, or somebody has written down what happens
instead."
edit src/modules/payroll/manifest.ts \
  "pay_run_idempotency_key:
    'nulled on the way in — see NOT_CARRIED_OVER'," \
  "" || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 529
section "The blob a receipt names is left out of the file" \
"\`attachment_blob\` rows stop travelling. The bytes may still be in
\`files\`, but the ROW every attachment points at is not — and with the
foreign keys off during the load, the attachment goes in naming nothing.
Restored onto a fresh machine the receipt is a dead link with no error
anywhere. \`BK11\` is the refusal; the file is checked before it is loaded."
edit src/lib/backup.ts \
  "    blobs," \
  "    blobs: []," || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 530
section "One payroll fixture can go while another still proves the backup" \
"The example company's payroll goes, while the independent financial-operations
fixture still creates and restores real pay runs and stubs. This is deliberately
GREEN: \`BK0\` checks the union of the business, P3, P5 and financial-operations
fixtures. Removing one redundant provider must not be mistaken for losing
payroll coverage altogether. All existing restore and financial checks remain."
edit scripts/example-company.ts \
  "  await runPayroll({" \
  "  if (0) await runPayroll({" || exit 1
run npm run db:verify-backup
green "The independent payroll fixture must keep the backup control green"
close; restore

# ---------------------------------------------------------------- 531
section "A screen keeps its own idea of what a button is" \
"One screen goes back to writing the button out by hand. Nothing looks
broken — it is a rounded box with white text, the same as the others were
until they all became one string — and the next change to how a button
looks reaches every screen but that one. Fourteen files were doing this,
eleven of them identically, which is what made the other three drift rather
than decisions. \`N21\` reads the tree for a second spelling."
edit src/components/PartyCreateForm.tsx \
  "import { BUTTON, FIELD, GHOST, LABEL } from '@/lib/ui'" \
  "import { FIELD, GHOST, LABEL } from '@/lib/ui'
const BUTTON = 'rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white'" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 532
section "Required names stop being bold" \
"The one rule that bolds the name of every required field goes. Nothing
errors and nothing is missing — the forms simply stop saying which boxes
have to be filled in, and the only way to find out is to press the button
and be refused. It is one rule keyed on the control itself, which is why it
cannot go stale against a field that stops being required. \`N21\` reads the
stylesheet for it."
edit src/app/globals.css \
  "  font-weight: var(--weight-heading);" \
  "  font-weight: 400;" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 533
section "A theme is offered, saved, and has no colours" \
"The fig palette's block of CSS goes. Everything else about it stays: it is
on the settings screen with its swatch, the door saves it, the database
accepts it, and the page does not change — a setting that does nothing and
says nothing. \`N22\` asks of every palette named in \`appearance.ts\` whether
it has colours, a value the database takes, and the same tokens as the
others."
edit src/app/globals.css \
  ':root[data-theme="figtree"] {' \
  ':root[data-theme="figtree-unreachable"] {' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 534
section "Dark goes back to asking the machine" \
"The \`dark:\` variant stops being redefined, so the six hundred \`dark:\`
classes this tree is written in follow the operating system again. Choosing
Dark then darkens the page background and nothing on it — every border,
panel and heading stays in the light palette, on a dark page. \`N22\` reads
the variant."
edit src/app/globals.css \
  '@custom-variant dark {' \
  '@custom-variant dark-unused {' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 535
section "The shell stops saying which theme this is" \
"\`<html>\` loses the attribute the palette is keyed on. Every screen falls
back to the default colours whatever the person chose, and the settings
screen goes on reporting their choice back to them correctly — the one
thing on the page that still agrees with the database. \`N22\` reads the
shell."
edit src/app/layout.tsx \
  '      data-theme={look.theme}' \
  '' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 536
section "The form that renames an account is written and never opened" \
"The account page stops rendering the editor. \`AccountForm\` still takes an
\`existing\` account, still switches to \`updateAccountAction\`, still freezes
the type once anything is posted — and nothing opens it, so a name is final
from the moment it is made. That is how it shipped, and the owner found it
by trying to rename one. \`A29\` asks whether a screen opens the door, not
whether the door exists."
edit "src/app/ledger/[ledgerId]/accounts/[accountId]/page.tsx" \
  "        <EditAccount" \
  "        <NoEditAccount" || exit 1
run npm run db:verify-accounts
close; restore

# ---------------------------------------------------------------- 537
section "An account that stood at a figure counts as empty" \
"\`isEmptyRow\` stops looking at the closing balance. An account that moved
in an earlier year and has sat still since — most of the balance sheet, in
a quiet month — is then hidden from the trial balance by a box labelled
\"only accounts with a figure\", while holding a figure. \`R40\` asks it about
a row that stood without moving."
edit src/lib/reporting-view.ts \
  '  return zero(r.debit) && zero(r.credit) && zero(r.balance)' \
  '  return zero(r.debit) && zero(r.credit)' || exit 1
run npm run db:verify-reports
close; restore

# ---------------------------------------------------------------- 538
section "The download does not know what the screen was showing" \
"The PDF stops reading the switch. The report on the screen hides its empty
rows and the one that comes out of it does not — two answers to one
question, and the person would be right to trust neither. \`R40c\` requires
the screen and both downloads to read the same name."
edit "src/app/ledger/[ledgerId]/reports/trial-balance/pdf/route.ts" \
  "    { hideZeros: q.get(HIDE_ZEROS) === '1' }))" \
  "    { hideZeros: false }))" || exit 1
run npm run db:verify-reports
close; restore

# ---------------------------------------------------------------- 539
section "A folded entry does not say how much it is hiding" \
"The count comes off the button, so a folded pay run says only \"more\". A
fold that does not say what it hides is a line you have to open to find out
whether you wanted it — which is the scrolling the fold was for. \`D40\`
reads the button."
edit "src/app/ledger/[ledgerId]/entries/EntryLines.tsx" \
  '  const moreLabel = String(hidden) + plural' \
  "  const moreLabel = 'more…'" || exit 1
run npm run db:verify-drafts
close; restore

# ---------------------------------------------------------------- 540
section "A box on a bank row belongs to a form that is not there" \
"The form in a pending row's last cell is given a different id from the one
every box in that row points at. Nothing looks wrong — the tax, the party
and the category are all there, in their columns, as on any other row — and
pressing Post sends none of them. A table cannot hold a form spanning its
cells, so the boxes name one by id, and this is what that arrangement costs
when it is got wrong. It cost one build. \`RC36b\` reads every id pointed at
against the ids that exist."
edit "src/app/ledger/[ledgerId]/bank/[accountId]/FeedScreen.tsx" \
  '              <form {...formProps} id={postId} className="inline-flex items-center">' \
  '              <form {...formProps} className="inline-flex items-center">' || exit 1
run npm run db:verify-bank-reconcile
close; restore

# ---------------------------------------------------------------- 541
section "The card counts drafts as money" \
"An account card's books figure stops asking whether an entry is posted, so
a draft somebody is halfway through typing moves the balance on the card —
and the card sits beside a statement figure, inviting the two to be
compared. This system has no bank to ask; the honest pair is the POSTED
books beside the last statement. \`I58\` compares the card with what the
ledger holds."
edit src/lib/bank.ts \
  "                      WHERE jl.account_id = a.id AND je.status IN ('posted','reversed')), 0)" \
  "                      WHERE jl.account_id = a.id), 0)" || exit 1
run npm run db:verify-bank-import
close; restore

# ---------------------------------------------------------------- 542
section "The banking landing comes back in front of the feed" \
"\`/bank\` goes back to being a page: a list of the accounts with rows, and a
link into one of them. Bank transactions grew a card per account across its
own top, so this is that list again, one click earlier and worse — and the
seat now opens a page whose only content is a poorer copy of the next
page's header. \`N24\` asks what \`/bank\` does."
edit "src/app/ledger/[ledgerId]/bank/page.tsx" \
  '  if (land) redirect(`/ledger/${ledgerId}/bank/${land.id}`)' \
  '  if (false) redirect(`/ledger/${ledgerId}/bank/${land?.id}`)' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 543
section "The specified-employee cap is applied to each pay" \
"The salary allocations are gathered per STUB rather than per person, so the
five-times-YMPE cap is tested against a fortnight — and every fortnight
passes a cap the year fails by a mile. An owner paid 480,000 is claimed in
full. \`S5\` adds the year up and compares it with the cap."
edit src/lib/sred.ts \
  "    const key = a.what" \
  "    const key = a.what + a.source_id" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 544
section "A related-party contract counts at 80% as well" \
"The 80% rule is applied to every contract, including one with a party this
company does not deal with at arm's length. That rule is for arm's-length
contracts; a related one is a different calculation this system does not
attempt, which is why it is counted in full and named instead. \`S6\` adds
the line up both ways."
edit src/lib/sred.ts \
  "      ? taken" \
  "      ? (taken * BigInt(Math.round(contractPercent * 100))) / 100n" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 545
section "Capital is dropped rather than listed" \
"Capital expenditures stop appearing on the paper at all. They have not been
eligible federally since 2014, so leaving them out changes no total — and
that is the point: the money spent is invisible, and the day the rule is
restored there is nothing to add back. \`S7\` asks for the figure under what
is excluded."
edit src/lib/sred.ts \
  "  const capitalRows = pick('capital').map(lineOf)" \
  "  const capitalRows: PaperLine['from'] = []" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 546
section "The proxy base takes a specified employee in full" \
"A specified employee goes into the prescribed proxy base at 100% rather than
75%. The salary line is still capped, so nothing on the paper looks wrong;
the proxy amount is simply larger than the provision allows, on the method
most claims use. \`S9\` computes the base from the rate table."
edit src/lib/sred.ts \
  "      ? (forBase * BigInt(Math.round(ppaSpecifiedPercent * 100))) / 100n" \
  "      ? forBase" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 547
section "A CCPC never gets the enhanced rate" \
"The company's CCPC status stops being read, and every claim is priced at the
basic 15% and marked non-refundable. For the owner's companies that is the
difference between money back and a credit against tax they may not owe —
and the paper would state it with the same confidence either way. \`S10\`
asks a CCPC what its credit is."
edit src/lib/sred.ts \
  "  const ccpc = head.is_ccpc === true" \
  "  const ccpc = false" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 548
section "The reporting deadline becomes a number in the code" \
"Eighteen months becomes twelve, typed here rather than read from the rate
table with its provision beside it. Missing that date loses the claim
outright — there is no relief provision — so a deadline six months early is
not the safe direction to be wrong in either: it is a date nobody can check
against anything. \`S11\` derives it from the year end."
edit src/lib/sred.ts \
  "  const deadlineMonths = rateOf(rates, 'federal', 'reporting_deadline_months')" \
  "  const deadlineMonths = 12" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 549
section "A time record with nothing written in it" \
"\`logSredTime\` accepts an empty activity. The hours still add up and the
salary share still computes, so every number downstream is unchanged — and
the one thing CRA actually reads, the sentence saying what was done, is
blank. \`S2\` writes three spaces into it."
edit src/lib/sred.ts \
  "  if (!input.activity.trim()) {" \
  "  if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 550
section "Salary is reachable twice — as a stub and as a line" \
"Two fences, both down: the payroll entry is offered as an allocatable
journal line, and the door stops refusing salary claimed that way. The same
wages can then be claimed once through the stub, where the
specified-employee cap applies, and again through the entry, where nothing
applies. \`S4\` watches both halves."
edit src/lib/sred.ts \
  "       AND je.source_type IS DISTINCT FROM 'payroll'" \
  "       AND je.source_type IS DISTINCT FROM 'nothing-at-all'" || exit 1
edit src/lib/sred.ts \
  "  if (input.sourceKind === 'journal_line' && input.category === 'salary') {" \
  "  if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 551
section "A filed year is edited underneath the return" \
"\`saveClaim\` stops asking whether the year has been filed. The method, the
narrative and the assistance answer can all be changed after the T661 has
gone, and the books then disagree with the return in a way nothing records.
\`S13\` files a year and tries to change its method."
edit src/lib/sred.ts \
  "    if (already.filed_on) {" \
  "    if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 552
section "The cap bites and the paper says nothing" \
"The specified-employee cap is still applied — the number is right — but the
paper stops saying it happened. Somebody reading it sees a salary figure
that is neither what was paid nor obviously anything else. The page still says
somebody is a specified employee and that specified employees are capped at
5 x YMPE — what it no longer says is WHICH figure was cut, or by how much.
\`S12\` reads the list of what is still unsettled."
edit src/lib/sred.ts \
  "    if (at.specified && at.taken > cap) {" \
  "    if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 553
section "The evidence gaps stop being named" \
"The standing still counts what is held; it stops saying what is missing. A
project with invoices and no trial records reads as three tidy fractions,
and the one thing that cannot be fixed after the year ends — a record made
at the time — is the thing nobody is told about. \`S14\` asks for the gaps
by name."
edit src/lib/sred.ts \
  "    else at.missing.push(k.label)" \
  "    else void k" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 554
section "A project shows another project's claims" \
"\`claimsFor\` stops filtering by project. Two projects in one company share a
fiscal year, so the year selector on one project lists the other's claim,
and opening it edits a narrative belonging to work it does not describe.
\`S15\` counts the claims a project has."
edit src/lib/sred.ts \
  '     WHERE c.project_id = ${projectId}::uuid' \
  '     WHERE c.project_id IS NOT NULL AND ${projectId}::uuid IS NOT NULL' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 555
section "Both methods print the same number" \
"The traditional method's overhead line is filled with the proxy amount, so
the two columns agree and the choice between them looks like no choice at
all. The whole reason both are computed is that the decision is irrevocable
for the year and should be made in sight of the difference. \`S8\` subtracts
one from the other."
edit src/lib/sred.ts \
  "      amount: sum(overheadRows) + employerShare, from: overheadRows," \
  "      amount: ppa, from: overheadRows," || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 556
section "The same dollar may be claimed by two projects" \
"\`check_sred_allocation_total\` waves everything through. Applied to the test
database, 0015's precedent, because the migration it comes from is
append-only. Two projects may now each claim 60% of one fortnight, which is
the first arithmetic an auditor does and the one rule a spreadsheet cannot
hold."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION check_sred_allocation_total() RETURNS trigger AS $$
BEGIN
  RETURN NEW;
END $$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-sred.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 557
section "The rates stop naming the provision they come from" \
"Every seeded rate loses its authority — the state a rate table drifts into
one edit at a time, and the reason this one carries the citation in a NOT
NULL column beside the number. A rate with no provision is a rate somebody
remembered, and this is a document somebody files. The rows are emptied in
the test database rather than in the migration, which is append-only."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
UPDATE sred_rate SET authority = '';
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-sred.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 558
section "The BC figure stops saying no limit was applied to it" \
"The federal credit splits at the expenditure limit; the BC one is taken on the
whole qualified amount, and the province's own credit is refundable for a CCPC
only up to a limit — the seeded rate says so. The number stays as it is here,
because that rule is not one this system works out. What goes is the SENTENCE
beside it admitting so, which turns the figure into an assertion of a rule
nobody applied. \`S10\` reads the basis line."
edit src/lib/sred.ts \
  "          + 'No expenditure limit is applied to this figure either — the provincial credit is '" \
  "          + 'Refundable for a CCPC. '" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 559
section "The CCPC answer is taken and never stored" \
"\`saveProfile\` reads the answer off the form and writes it nowhere. The
screen accepts it, says Saved, and the working paper goes on pricing the
company as though nobody had ever said — 15% and not refundable instead of
35% and refundable. This is the exact state the module shipped in before the
door existed. \`S16\` sets it through the door and asks the paper."
edit src/lib/records.ts \
  "    if (input.isCcpc !== undefined) {" \
  "    if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 560
section "Nobody has said collapses into no" \
"The three-state answer becomes two: an unanswered CCPC question is stored as
a definite No. The number does not move — an unclassified company was already
priced as though it were not one — but the to-confirm line saying nobody has said
disappears, and a guess becomes an assertion. \`S16\` asks the unanswered
case what the paper says about it."
edit src/lib/record-forms.ts \
  "    isCcpc: { yes: true, no: false }[g(f, RECORD_FIELDS.isCcpc)] ?? null," \
  "    isCcpc: { yes: true, no: false }[g(f, RECORD_FIELDS.isCcpc)] ?? false," || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 561
section "Arm's length is accepted and never written" \
"\`updateParty\` always leaves the stored answer alone, so unticking the box
does nothing. Every contract goes on counting at 80%, including one with a
party this company does not deal with at arm's length — the rule that does
not apply to them, applied to them silently. \`S17\` moves the switch both
ways and reads the contract line."
edit src/lib/parties.ts \
  "    const armsLength = input.armsLength === undefined" \
  "    const armsLength = true === true" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 562
section "Specified employee cannot be turned on for somebody already on the payroll" \
"The INSERT still carries it; the UPDATE stops. So the flag can only ever be
set when a person is first added — and the owner-employee whose cap this
exists for is normally already on the payroll when anybody works out that
they are a specified employee. The 5 x YMPE cap then never bites, and
nothing says it did not. \`S18\` edits an existing record."
edit src/lib/payroll/employees.ts \
  '          is_specified = ${input.isSpecified ?? false}' \
  '          is_specified = is_specified' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 563
section "A year can be filed twice" \
"\`fileClaim\` stops asking whether the year was already filed, so a second
press overwrites the filing date with today's. The date that gets overwritten
is the one the eighteen months were counted to and the one the audit trail
would be read against. \`S19\` presses it twice."
edit src/lib/sred.ts \
  "    if (claim.filed_on) {" \
  "    if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 564
section "Un-filing stops asking why" \
"A filed year can be turned back into a draft with nothing recorded but the
fact. Filing says a return went to CRA on a date; taking it back says it did
not, and the difference between a correction and a quiet edit is the sentence
that is no longer required. \`reopenPeriod\` has asked for that sentence since
0024. \`S19\` un-files with a blank reason."
edit src/lib/sred.ts \
  "  if (!input.reason.trim()) {" \
  "  if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 565
section "The CCPC question is on the screen but posts nothing" \
"The field loses its name. It still renders, a person still picks an answer,
and the form submits without it — so the door is handed nothing and the
company stays unclassified no matter what anybody selects. A door with no
form posting to it is not a door, which is the whole defect this node closed;
\`S20\` reads the tree for a field and a reader behind every switch the paper
depends on."
edit "src/app/ledger/[ledgerId]/records/profile/ProfileForm.tsx" \
  "            <select name={F.isCcpc} defaultValue={isCcpc === null ? '' : isCcpc ? 'yes' : 'no'}" \
  "            <select defaultValue={isCcpc === null ? '' : isCcpc ? 'yes' : 'no'}" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 566
section "A filed year's money can still be moved" \
"\`allocate\` stops asking whether the year has been filed, so a percentage can
be changed after the return has gone. Every figure on that return was
produced by these rows; moving one makes the working paper quietly stop
agreeing with the T661 that was sent, and nothing anywhere records that they
ever differed. \`S21\` files a year and tries to move a share."
edit src/lib/sred.ts \
  "    await refuseIfFiled(tx, input.claimId)" \
  "    if (false) await refuseIfFiled(tx, input.claimId)" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 567
section "A filed year's money can still be dropped" \
"The same fence, the other side of it: an allocation can be deleted out of a
filed year. Worse than moving one, because the figure simply gets smaller and
there is no second version to compare against. \`S21\` watches both doors,
and it also watches that the time log and the evidence stay OPEN — a freeze
that took the project record with it would punish the one habit this module
exists to encourage."
edit src/lib/sred.ts \
  "    if (row) await refuseIfFiled(tx, row.claim_id)" \
  "    if (false) await refuseIfFiled(tx, row.claim_id)" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 568
section "The CCPC answer never leaves the form reader" \
"\`saveProfileFromForm\` stops passing the answer on. The screen offers the
field, the person picks Yes, the door is handed nothing, and the company
stays unclassified — a door with a form in front of it that posts to
something else. \`S20\` names the reader and the door for each switch and
asks whether that file carries the field; an earlier version only asked
whether the name appeared somewhere under src, which a comment would have
satisfied."
edit src/lib/record-forms.ts \
  "    isCcpc: { yes: true, no: false }[g(f, RECORD_FIELDS.isCcpc)] ?? null," \
  "    companyType: g(f, RECORD_FIELDS.companyType) || undefined," || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 569
section "The over-allocation rule counts the row it is about to replace" \
"0068's body is put back on the test database: it excludes \`id <> NEW.id\`
instead of the claim. \`allocate\` writes with ON CONFLICT DO UPDATE, and
Postgres fires the BEFORE INSERT trigger on a proposed row with a FRESH id
before it discovers the conflict — so that exclusion excludes nothing on the
path the screen's Change button actually takes, and lowering a share on a
source already fully claimed is refused with a sentence saying it would go
over 100%. \`S22\` lowers one."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION check_sred_allocation_total() RETURNS trigger AS $$
DECLARE total numeric;
BEGIN
  SELECT COALESCE(SUM(percent), 0) INTO total
    FROM sred_allocation
   WHERE source_kind = NEW.source_kind AND source_id = NEW.source_id
     AND id <> NEW.id;
  IF total + NEW.percent > 100 THEN
    RAISE EXCEPTION 'SRED_OVER_ALLOCATED: % is already %%% claimed; % more would be over 100%%',
      NEW.source_kind, total, NEW.percent
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-sred.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 570
section "A row that changes hands is counted against itself" \
"0069's body goes back on the test database: it excludes the claim and not the
id. Every write this application makes keeps \`claim_id\`, so that version is
right for all of them — and wrong for the one path nothing here takes yet. An
UPDATE that MOVES a row to another claim leaves the pre-image carrying the old
one, so the exclusion misses it, its own percent is summed in, and the row is
refused for over-claiming a source by exactly the amount it was already
claiming. \`S23\` moves one."
blk npm run db:reset >/dev/null 2>&1
blk psql -q -d "$TESTDB" >/dev/null 2>&1 <<'SQL'
CREATE OR REPLACE FUNCTION check_sred_allocation_total() RETURNS trigger AS $$
DECLARE taken numeric;
BEGIN
  SELECT COALESCE(SUM(percent), 0) INTO taken
    FROM sred_allocation
   WHERE source_kind = NEW.source_kind AND source_id = NEW.source_id
     AND claim_id <> NEW.claim_id;
  IF taken + NEW.percent > 100 THEN
    RAISE EXCEPTION 'SRED_OVER_ALLOCATED: % is already %%% claimed by other years or projects; % more would be over 100%%',
      NEW.source_kind, taken, NEW.percent
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
SQL
NODE_OPTIONS=--conditions=react-server run npx tsx scripts/verify-sred.ts
close
blk npm run db:reset >/dev/null 2>&1

# ---------------------------------------------------------------- 571
section "Tagged accounts stop sorting first" \
"The accounts a person has told the system hold SR&ED costs go back to date
order, mixed in with every other expense of the year. Nothing is wrong with
any number; the rows they came to allocate are simply somewhere in the
middle of several hundred, which on a real set of books is the same as not
having tagged them. \`S24\` reads the first row."
edit src/lib/sred.ts \
  "     ORDER BY (c.category IS NULL), je.entry_date, a.code\`)" \
  "     ORDER BY je.entry_date, a.code\`)" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 572
section "A tagged row stops offering the whole cost" \
"The percent box opens empty on a line whose account is tagged SR&ED. The tag
says this account holds nothing else, so 100 is the answer nearly every time
— and an empty box on four hundred rows is four hundred keystrokes and four
hundred chances to type 10 for 100. The basis sentence is still required
either way. \`S24\` reads the box."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  "                       defaultValue={at?.percent ?? (a.suggested ? '100' : '')} required" \
  "                       defaultValue={at?.percent ?? ''} required" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 573
section "A tagged row forgets which line it feeds" \
"The category select ignores what the account said and opens on the first
choice. Every tagged row then reads 'materials', and a contract or a
third-party payment goes to T661 line 320 unless the person notices — which
is exactly the noticing the tag existed to spare them. \`S24\` reads the
selected option in that row."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  "                          defaultValue={at?.category ?? a.suggested ?? categories[0]}" \
  "                          defaultValue={at?.category ?? categories[0]}" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 574
section "The cost table renders the whole year again" \
"Pagination goes away and every posted cost of the year is rendered at once.
On the fixture that is nothing; on a real set of books it is the wall the
owner would have met the first time they opened this screen on their own
ledger. The search box and the filter are still there, which is what makes
it look fine. \`S25\` renders 120 rows and counts them."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  "  const visible = shown.slice(at * PER_PAGE, at * PER_PAGE + PER_PAGE)" \
  "  const visible = shown" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 575
section "An account's SR&ED tag is taken and never stored" \
"The SR&ED screen's tag door reads the select and drops it (it was the account
form's until 0156), so the chart can never say what any account holds — and
every tagged-row behaviour below it is unreachable no matter how well it works.
The same shape as the four switches in the node before this one. \`S20\`
catches it: it reads the tree for a field on a screen AND the module that
carries it to the door, which is the half \`S24\` cannot see — S24 tags through
the library, not through the form."
edit "src/app/ledger/[ledgerId]/sred/actions.ts" \
  "    category: String(f.get(SRED_FIELDS.accountCategory) ?? '') || null, actor," \
  "    category: null, actor," || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 576
section "The lens stops narrowing" \
"\`matchesCost\` ignores which lens is chosen and keeps every row. The box, the
dropdown and the count all still work; picking 'SR&ED accounts only' simply
shows the whole year, which on a real ledger reads as the filter being broken
rather than as the list being right. Until today no check called this
function at all. \`S26\` calls each branch of it."
edit src/lib/sred-kinds.ts \
  "  if (lens === 'tagged' && !a.suggested) return false" \
  "  if (false && !a.suggested) return false" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 577
section "One matching word is enough" \
"The search keeps a row when ANY typed word appears instead of all of them, so
narrowing by a second word widens the list. Typing more to find less is the
one thing a search box promises. \`S26\` asks for a row that matches one word
and not the other."
edit src/lib/sred-kinds.ts \
  "  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))" \
  "  return query.toLowerCase().split(/\s+/).filter(Boolean).some((w) => hay.includes(w))" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 578
section "The salary line stops saying it is gross only" \
"Line 300 goes back to a note about the cap and nothing else. The number is
unchanged and correct; what goes is the sentence naming the employer's half of
CPP and EI and saying where it went — line 360 under the traditional method,
and nowhere at all under proxy. Without it a reader cannot tell whether that
money was claimed, left out, or forgotten, and the three look identical on the
page. \`S27\` reads the note and checks the amount in it against the stubs."
edit src/lib/sred.ts \
  "  const saidGross = grossOnlyNote(employerShare)" \
  "  const saidGross = ''" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 579
section "The proxy base stops saying what came out of it" \
"Line 502's note drops the sentence saying what came out of its base and what
could not. The base still nets off the bonus, so the number is unchanged; what
goes is the figure that left, and the two things this cannot take out — a
bonus nobody entered in the pay run's column, and taxable benefits, which
nothing here records apart from gross pay. A base that says nothing about its
own gaps reads as though it had none. \`S27\` reads it, on a claim with a
bonus and on one without."
edit src/lib/sred.ts \
  "  const saidBase = proxyBaseNote(bonusLeftTheBase)" \
  "  const saidBase = ''" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 580
section "A fiscal year can be planned short" \
"\`planFiscalYear\` builds its twelve periods from eleven months instead of
twelve, so a year comes out short and nobody chose it. The
specified-employee cap is prorated for a short tax year and this module does
not prorate it, so a claim in such a year is capped too generously — the
paper says so when it can see the year is short, and a planner quietly
producing one is the case nobody would look at. \`S28\` plans five year ends
and measures each."
edit src/lib/setup.ts \
  "    const start = addDays(addMonths(end, -12), 1)" \
  "    const start = addDays(addMonths(end, -11), 1)" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 581
section "A short fiscal year stops being mentioned" \
"The paper goes quiet about a year that is not twelve months long. A restore
writes \`fiscal_year\` rows verbatim from a file with triggers off, and 0007's
guard lets an OPEN year with no posted entries be redefined — so a short row
is a state this system reaches. The cap above it is then applied in full,
prorated by nothing, and the only thing that said so is gone. \`S28\` puts a
201-day year in front of it."
edit src/lib/sred.ts \
  "  if (dayCount < 365) {" \
  "  if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 582
section "A company born inside its own year stops being mentioned" \
"The other half, and the one no ledger date can show: a company incorporated
mid-year has a FIRST TAX YEAR shorter than the twelve months this ledger
keeps for it. The fiscal year looks full, the cap is applied in full, and the
figure is too generous with nothing on the page to hint at it. This is the
case that made deleting the disclosure the wrong call. \`S28\` reads the
recognition date."
edit src/lib/sred.ts \
  "  } else if (span.incorporated" \
  "  } else if (false && span.incorporated" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 583
section "Recognised after the year ends still counts as inside it" \
"The upper half of the bound goes, so any recognition date after the year
STARTS reads as an incorporation inside it. \`createFiscalYear\` will plan a
year flush before the earliest one, and a claim on a year that closed before
the company existed is then told that year contains its incorporation —
false about that year at both ends, and the sort of sentence a person would
believe because nothing else on the page contradicts it. \`S28\` puts a
recognition date after the year end in front of it."
edit src/lib/sred.ts \
  "             && span.incorporated > head.year_start && span.incorporated <= head.year_end) {" \
  "             && span.incorporated > head.year_start) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 584
section "The cap warning goes back to printing raw cents" \
"The sentence under 'Settle these before this becomes a return' prints
37300000 where every amount beside it reads 373,000.00. Nothing is wrong with
the arithmetic and nothing on the page contradicts it — a person simply reads
a number two decimal places out and has no reason to doubt it. This is the
same defect the employer CPP/EI note shipped with for one round, and the
check that now holds it exists because fixing that one left this one
unguarded. \`S5\` reads the warning."
edit src/lib/sred.ts \
  "      toConfirm.push(\`\${who} is capped: \${formatMoney(at.taken)} claimed, counted at \`" \
  "      toConfirm.push(\`\${who} is capped: \${at.taken} claimed, counted at \`" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 585
section "The employer's CPP and EI stop reaching line 360" \
"Traditional overhead goes back to the recorded overhead alone. The owner
settled this on 2026-09-11: the employer's half of CPP and EI on the claimed
pay is directly attributable overhead and belongs on line 360 under that
method. Dropped, a traditional claim is understated by real money spent on
the work — and the note beside line 300 goes on saying it was claimed there.
\`S8\` adds the line up from the stubs."
edit src/lib/sred.ts \
  "      amount: sum(overheadRows) + employerShare, from: overheadRows," \
  "      amount: sum(overheadRows), from: overheadRows," || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 586
section "The bonus goes back into the proxy base" \
"The prescribed proxy amount is computed on the whole of the capped salary
again, bonuses included. In law the salary base is the narrower figure, so
the PPA comes out too large on the method most claims use — and the paper
says the bonus was taken out while it was not. \`S9\` computes the base from
the rule."
edit src/lib/sred.ts \
  "    const forBase = counted - bonusTaken" \
  "    const forBase = counted" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 587
section "The bonus box on a payday posts nothing" \
"The pay run reads every other figure off the form and drops this one, so
\`pay_stub.bonus\` is always zero however carefully a person fills the column
in. Every payroll number is unaffected — that is the point of the memo — and
the SR&ED proxy base silently goes back to including bonuses it was told
about. The same shape as the four switches nobody could set — and \`S9\` cannot
see it, because the SR&ED fixture calls \`runPayroll\` directly rather than
through this reader. \`S20\` is the one that catches it: it reads the tree for
a field on a screen and the module that carries it to the door."
edit src/lib/payroll/forms.ts \
  "        bonus: optionalMoney(g(f, payBonus(i)), 'a bonus')," \
  "        hours: optionalHours(g(f, payHours(i)))," || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 588
section "A bonus may be bigger than the pay it is part of" \
"\`previewPayRun\` stops asking whether the bonus fits inside the gross. Every
other figure on that row is asked — pensionable, insurable, the gross itself
— and this one was shipped without it, so a typed 4,000 against a 3,000
payday reached the INSERT and came back as 0072's raw CHECK violation
instead of a sentence naming the person. \`PR48\` types one."
edit src/lib/payroll/runs.ts \
  "    if (bonus > line.gross) {" \
  "    if (false) {" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 589
section "A negative bonus is accepted at the door" \
"The other half of the same fence. Pay cannot be less than nothing and neither
can a part of it; without the guard a minus sign travels to the database and
the refusal a person reads is a constraint name. The column's own CHECK is
the backstop for anything that skips this door — it is not the thing a person
should ever meet. \`PR48\` types a negative one."
edit src/lib/payroll/runs.ts \
  "    if (bonus < 0n) {" \
  "    if (false) {" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 590
section "Only a capped specified employee is warned" \
"The claim-side sentence goes back to firing only when the 5 x YMPE cap bit.
The gap it describes — the law keeps profit-based pay out of the claim itself
and this paper keeps it only out of the proxy base — belongs to every
specified employee, and somebody paid under the cap then gets no sentence at
all while their line 300 carries exactly the same thing. \`S5\` reads the
sentence for the one who is under it."
edit src/lib/sred.ts \
  "    if (at.specified) {" \
  "    if (at.specified && at.taken > cap) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 591
section "The base reports the bonus entered, not the bonus taken out" \
"\`bonusTaken\` becomes the whole bonus again, so line 502 reports a reduction
larger than the base it came out of whenever a capped person was paid more
bonus than the salary that survived the cap. The number the paper prints then
describes something that did not happen, in the direction that makes the base
look narrower than it is. \`S9\` calls the clamp branches directly; \`S29\`
watches it on a real paper, where a founder paid 390,000 in bonus has only
373,000 of counted salary for it to come out of."
edit src/lib/sred-kinds.ts \
  "  counted > bonus ? bonus : counted" \
  "  bonus" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 592
section "The working paper stops calling the clamp" \
"The helper is still correct and still tested; the line that USES it hands the
whole bonus through instead. On a specified employee whose bonus is larger
than the salary the cap left, the base then goes negative — a reduction
bigger than the thing it came out of — and line 502 reports it. Extracting
the arithmetic into a helper covered the arithmetic and left this wire bare
until \`S29\` existed. \`S29\` reads the paper."
edit src/lib/sred.ts \
  "    const bonusTaken = bonusOutOfBase(counted, bonus)" \
  "    const bonusTaken = bonus" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 593
section "The year button opens the newest year, whatever year you are on" \
"Half of the defect this node removed, put back: the opener submits
\`years[0]\` instead of the year in front of you. Look at 2027, press the
button, and 2028 is what opens — and since a project may only have one claim
per year, the year you actually wanted may now be the one you cannot reach.
\`S30\` renders the strip on a year that is not the newest."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  "          <input type=\"hidden\" name={F.fiscalYearId} value={yearId} />" \
  "          <input type=\"hidden\" name={F.fiscalYearId} value={years[0].id} />" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 594
section "The button to open a year disappears after the first one" \
"The other half, and the worse one: whether the opener renders goes back to
asking whether the project has ANY claim rather than whether THIS year does.
A project's first claim then closes the door behind it and no second year can
ever be opened — which is exactly how this shipped, and \`S15\` passed the
whole time because its fixture opens one year. \`S30\` opens a second."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  "  const unclaimed = yearId !== null && !claims.some((c) => c.fiscal_year_id === yearId)" \
  "  const unclaimed = claims.length === 0" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 595
section "Asking for a year with nothing in it hands back another year's claim" \
"\`viewedYear\` borrows again. The screen then shows one year's narrative,
method and figures under another year's heading, and the year you asked for
reports itself as claimed. Nothing about the page looks wrong. \`S30\` asks
for a year that has no claim."
edit src/lib/sred-kinds.ts \
  "    ? claims.find((c) => c.fiscal_year_id === wanted.id) ?? null" \
  "    ? claims.find((c) => c.fiscal_year_id === wanted.id) ?? claims[0] ?? null" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 596
section "The year strip marks the newest year rather than the one you are on" \
"Only the highlight, and only on a screen where the newest year is not the one
being looked at — so the person reads the figures of 2027 while the strip says
2028. The mutation is invisible on any fixture whose viewed year IS the newest,
which is the condition \`S30\` puts on the strip's own year array: the year it
looks at has no claim AND is not the first one."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  "                  yearId === y.id" \
  "                  years[0].id === y.id" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 597
section "The page stops reading the year out of the address" \
"\`?year=\` is parsed and then not passed, so every year button leads back to
the same year. \`S30\` reads the page for the call."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/page.tsx" \
  "  const { year, claim, span } = viewedYear(years, claims, asked)" \
  "  const { year, claim, span } = viewedYear(years, claims, undefined)" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 598
section "The page hands the strip the newest year instead of the resolved one" \
"The resolver is right and its answer is thrown away one line later. Same
outcome as 593, reached from the other side. \`S30\` reads the page for the
prop."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/page.tsx" \
  "        yearId={year?.id ?? null}" \
  "        yearId={years[0]?.id ?? null}" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 599
section "The costs a year can reach are the newest year's, whatever year you are on" \
"The allocation table's window stops following the year being looked at and
takes the newest year's dates instead, so a person working on 2027 is offered
2028's costs to claim — and would claim them, because the table is the only
place those dates appear. This line was in the page until the critic pointed
out that a DECISION spelled out in a server component is one no check here can
run; it is in \`viewedYear\` now, and \`S30\` calls it."
edit src/lib/sred-kinds.ts \
  "  const span = year ? { from: year.start_date, to: year.end_date } : null" \
  "  const span = years[0] ? { from: years[0].start_date, to: years[0].end_date } : null" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 600
section "A project with no claim anywhere lands on no year at all" \
"The last arm of \`viewedYear\` goes. With a claim somewhere, nothing changes —
the year is found by the claim. With NO claim, there is nothing to find it by,
so the answer becomes null, the strip is handed \`yearId={null}\`, and the
opener does not render: the FIRST claim can no longer be opened either. The
same defect this node removed, one arm along, and no fixture reached it until
\`S30\` passed an empty claim list."
edit src/lib/sred-kinds.ts \
  "  const year = wanted ?? years.find((y) => y.id === claim?.fiscal_year_id) ?? years[0] ?? null" \
  "  const year = wanted ?? years.find((y) => y.id === claim?.fiscal_year_id) ?? null" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 601
section "The years a project's claims come back in are reversed" \
"\`claimsFor\` orders by year end ascending. Nothing refuses; the screen opens
on the OLDEST year instead of the newest, because \`viewedYear\` lands on
\`claims[0]\` and it is this ORDER BY that makes the first one the newest.
A person opening a project sees a closed year and can file against it by
pressing what looks like the default. No literal array can catch this — the
order has to be asked of the database, which is why \`S30\` reads the claims
back rather than assuming a list."
edit src/lib/sred.ts \
  "     ORDER BY y.end_date DESC\`)" \
  "     ORDER BY y.end_date ASC\`)" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 602
section "Opening a year silently reuses the year the project already has" \
"The door takes the fiscal year it was given and, if the project already has a
claim, substitutes that claim's year for it. Nothing refuses: the insert
conflicts on the year it swapped in, \`DO UPDATE\` hands back the first
claim's id, and the screen goes on as though a second year had been opened.
Every other \`openClaim\` in the suite is a project's FIRST claim, so the
subquery is empty there and they are untouched — which is precisely why this
one is worth having: the comment beside \`S30\` used to say no such mutation
existed, and a reviewer wrote this one out."
edit src/lib/sred.ts \
  '      VALUES (${input.projectId}::uuid, ${input.fiscalYearId}::uuid, ${input.actor})' \
  '      VALUES (${input.projectId}::uuid, COALESCE((SELECT fiscal_year_id FROM sred_claim WHERE project_id = ${input.projectId}::uuid LIMIT 1), ${input.fiscalYearId}::uuid), ${input.actor})' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 603
section "The year in the address stops being the year you land on" \
"\`viewedYear\` drops the arm that says the year asked for IS the year, and
falls back to the year of whichever claim it found — so a year with nothing in
it resolves to the newest year instead of itself. The claim half of the answer
is still right, which is the point: the two halves are computed separately and
one can be wrong while the other is not."
edit src/lib/sred-kinds.ts \
  "  const year = wanted ?? years.find((y) => y.id === claim?.fiscal_year_id) ?? years[0] ?? null" \
  "  const year = years.find((y) => y.id === claim?.fiscal_year_id) ?? years[0] ?? null" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 604
section "The costs the screen offers reach past the window it was given" \
"The page stops using the window \`viewedYear\` handed it and takes the newest
year's dates straight off the year list. Same outcome as 599 — a person on
2027 is offered 2028's costs to claim — reached from the page rather than the
resolver. This hand-off was held by nothing until \`S30\` read it: moving the
DECISION out of the page left the HAND-OFF behind."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/page.tsx" \
  "        salary={span ? await allocatableSalary(ledgerId, span.from, span.to) : []}" \
  "        salary={years[0] ? await allocatableSalary(ledgerId, years[0].start_date, years[0].end_date) : []}" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 605
section "The costs a claim can reach come from the newest year too" \
"The other half of 604, and the half that carries the money: materials,
contracts, third-party work and equipment. The page keeps using the window it
was given for salary and reaches past it for everything else, so a person on
2027 is offered 2028's invoices. One repair took the salary line and called it
\"the window's one consumer\"; there are two."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/page.tsx" \
  "        lines={span ? await allocatableLines(ledgerId, span.from, span.to) : []}" \
  "        lines={years[0] ? await allocatableLines(ledgerId, years[0].start_date, years[0].end_date) : []}" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 606
section "The dot moves to the years that already have a claim" \
"The strip's only way of saying which years are still empty is inverted, so
every year that has a claim is marked as if it had none and every empty year
looks done. Nothing else on the screen says it: the working paper is per year
and you have to be on the year to see it. \`S30\` reads the two buttons."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  "            {y.name}{has ? '' : ' ·'}" \
  "            {y.name}{has ? ' ·' : ''}" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 607
section "The screen is handed another year's claim" \
"The page resolves the year correctly and then hands the body
\`claims[0]\` — the newest claim — instead of the one belonging to the year
being looked at. This is block 595 reached from the page, and it is worse
there: the Record tab shows another year's 242/244/246 and method, and every
form on the screen carries that claim's id, so an allocation made on 2027 is
written against 2026 and pressing file files 2026. The strip goes on offering
to open 2027 at the same time, because it reads the claim LIST, not this prop."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/page.tsx" \
  "        claim={claim}" \
  "        claim={claims[0] ?? null}" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 608
section "The working paper is computed for a year nobody asked about" \
"Same substitution, one line earlier and money-side only: the figures, the
credit and the eighteen-month countdown all come from the newest claim while
the heading says the year you are on. Nothing refuses, because both are real
claims of the same project."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/page.tsx" \
  "  const paper = claim ? await workingPaper(claim.id) : null" \
  "  const paper = claims[0] ? await workingPaper(claims[0].id) : null" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 609
section "The allocations already made are read from another year" \
"The cost table's \"already claimed\" column and its pre-filled percentages
come from the newest claim's allocations. So a cost claimed at 60% in 2026
shows as claimed on the 2027 screen, and a person correcting it edits a row
that is not there — while the money they meant to claim looks untouched."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/page.tsx" \
  '      FROM sred_allocation WHERE claim_id = ${claim.id}::uuid`) : []' \
  '      FROM sred_allocation WHERE claim_id = ${claims[0].id}::uuid`) : []' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 610
section "A pasted day can be longer than a day" \
"The upper bound goes off the hours a batch may carry, so \`25\` is accepted
and the database's own CHECK refuses the INSERT — which in an all-or-nothing
batch means forty good rows fail on a constraint error instead of one line
being named. \`S31\` pastes 25 hours."
edit src/lib/sred-kinds.ts \
  '  if (n <= 0 || n > 24) return `${hours} hours is not between 0 and 24`' \
  '  if (n <= 0) return `${hours} hours is not between 0 and 24`' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 611
section "Pasted hours may carry more decimals than the column keeps" \
"\`numeric(5,2)\` rounds 4.005 to 4.01 without saying so, and the person who
pasted it never learns which number the claim is actually made of. \`S31\`
pastes three decimals."
edit src/lib/sred-kinds.ts \
  '  const shaped = /^\d+(\.\d{1,2})?$/.test(hours)' \
  '  const shaped = /^\d+(\.\d*)?$/.test(hours)' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 612
section "A short line in a batch is read as if a field were blank" \
"The field count stops being checked, so \`Sam | 2026-03-04 | 8\` reaches the
destructuring with no activity and comes back refused for the wrong reason —
\"no activity\" on a line whose real fault is a missing pipe. The refusal is
what a person navigates by. \`S31\` pastes a three-field line."
edit src/lib/sred-kinds.ts \
  "    if (f.length !== TIME_PASTE_FIELDS.length) {" \
  "    if (f.length > TIME_PASTE_FIELDS.length) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 613
section "The template's own headings are refused as bad rows" \
"\`### TIME\` stops being skipped, so pasting the block exactly as the intake
list asks the other agent to produce it fails on its first line — and since a
batch is all or nothing, nothing goes in. \`S31\` pastes the heading."
edit src/lib/sred-kinds.ts \
  "const isNoise = (t: string) => t === '' || t.startsWith('#')" \
  "const isNoise = (t: string) => t === ''" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 614
section "A pasted evidence kind is taken on trust" \
"The controlled vocabulary stops being checked in the parser, so \`lab_book\`
gets past it and the door refuses the whole batch with UNKNOWN_KIND naming no
line. Thirteen kinds is CRA's list, not a suggestion. \`S31\` pastes one that
is not on it."
edit src/lib/sred-kinds.ts \
  "    if (!EVIDENCE_KINDS.some((k) => k.kind === kind)) {" \
  "    if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 615
section "A batch puts in whatever part of it was good" \
"All or nothing becomes some: the readable rows go in and the bad ones are
reported, so the person fixes two lines and pastes the batch again — and the
good half arrives twice. Nothing in this system can tell a genuine repeat of a
day's work from a double paste. \`S32\` pastes a batch with one bad name."
edit src/lib/sred-kinds.ts \
  "export const nothingOnRefusal = (refused: PasteRefusal[]) => refused.length > 0" \
  "export const nothingOnRefusal = (refused: PasteRefusal[]) => refused.length > 99" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 616
section "Pasting the same batch twice records the work twice" \
"The already-on-file test goes. Two identical hours on the same day for the
same person is a plausible thing to have happened once and an implausible
thing to have happened by hand, and the second copy inflates the salary the
claim is built on. \`S32\` pastes the same row twice."
edit src/lib/sred.ts \
  '    } else if (onFile.has(`${employeeId}|${r.onDate}|${r.activity}`)) {' \
  '    } else if (false) {' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 617
section "A pasted name has to match the payroll's name lowercased" \
"Only the LOOKUP stops folding case; the map is still keyed on the payroll name
lowercased. So \`Sam Engineer\` — the spelling the intake list asks the other
agent for, and the one a payroll actually holds — is nobody, and an all-lowercase
spelling is the only one that resolves. The list that comes back is prose, not a
key. \`S32\` pastes names as they are written."
edit src/lib/sred.ts \
  "    const employeeId = byName.get(r.who.toLowerCase())" \
  "    const employeeId = byName.get(r.who)" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 618
section "An hour can be carried INTO a filed year by editing its date" \
"The door checks the year the row is in and not the year it is going to, so a
row in a draft year is redated into a filed one and the return that has gone
quietly acquires an hour it never rested on. The check that catches this has
to move a row the OTHER way — a row already inside a filed year is refused by
the first test whatever the second one does. \`S33\` redates a draft row into
the filed year."
edit src/lib/sred.ts \
  "    await refuseIfInFiledYear(tx, row.project_id, input.onDate) // where the hour is going" \
  "    await Promise.resolve() // where the hour is going" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 619
section "The fence looks at the years that were not filed" \
"The test is inverted: a row inside a FILED year is edited and deleted freely,
and a row in a draft year is refused instead. Both halves are wrong and only
one of them is visible to the person — the refusal. \`S33\` walks both sides
of the line."
edit src/lib/sred.ts \
  '     WHERE c.filed_on IS NOT NULL AND c.project_id = ${projectId}::uuid' \
  '     WHERE c.filed_on IS NULL AND c.project_id = ${projectId}::uuid' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 620
section "A project a return has gone on can be deleted" \
"The guard goes, and with it the claims, hours and evidence of a year already
filed — 0068 cascades all three off the project. There is no undo and the
backup is the only way back. \`S35\` files a year on a project of its own and
presses delete."
edit src/lib/sred.ts \
  "    if (filed) {" \
  "    if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 621
section "A project can be given a status the database will not hold" \
"The status list stops being checked in the door, so \`shelved\` reaches the
UPDATE and 0068's CHECK refuses it — a constraint error where a sentence
belonged. Four statuses is the whole list, and \`abandoned\` is on it because
work that did not resolve its uncertainty is still SR&ED. \`S35\` sends one
that is not."
edit src/lib/sred.ts \
  "  if (!(PROJECT_STATUS as readonly string[]).includes(input.status)) {" \
  "  if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 622
section "Every row's buttons act on the first row" \
"The id written once per row and used by both its forms becomes the first
row's, so pressing Save on the fourth hour edits the first and pressing Delete
on the fourth deletes the first. Nothing on the screen says so — the row still
shows its own figures in its own inputs. \`S34\` renders two rows and reads
each row's own forms."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  "              <input type=\"hidden\" name={F.timeId} value={t.id} />" \
  "              <input type=\"hidden\" name={F.timeId} value={time[0].id} />" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 623
section "The paste box stops saying what shape it wants" \
"The format line loses half its fields, so the box asks for two columns and
refuses every four-column row it is given. The sentence is built from the
field names precisely so it cannot drift from them; this is what drifting
looks like. \`S34\` reads the sentence back."
edit $'src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx' $'      <p className="mt-2 font-mono text-xs text-neutral-500">{fields.join(\' | \')}</p>' $'      <p className="mt-2 font-mono text-xs text-neutral-500">{fields.slice(0, 2).join(\' | \')}</p>' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 624
section "The project's status is posted under another field's name" \
"The select still shows four statuses and sends them as something the action
does not read, so the status silently stays whatever it was — which for every
project is \`active\`, including the ones that were abandoned. \`S34\` reads
the field names off the form."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  '              <select name={F.status} defaultValue={project.status} className={`mt-1 ${FIELD}`}>' \
  '              <select name={F.kind} defaultValue={project.status} className={`mt-1 ${FIELD}`}>' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 625
section "A filed return's project can be renamed underneath it" \
"The project's own fence goes. T661 carries the project's title, identifier
and field of science, so once a year of it has gone those are what a return
said — and this lets them be changed with nothing recorded and nothing
refused. The status and the end date stay open on purpose and are not touched
here. \`S35\` renames a project whose year is filed."
edit src/lib/sred.ts \
  "      if (moved.length > 0) {" \
  "      if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 626
section "The Save button beside one row can put 25 hours in a day" \
"The edit door stops applying the hours rule the paste door applies, so the
figure goes straight at \`numeric(5,2)\` and 0068's CHECK — a raw constraint
error where a sentence belonged, and the one outcome block 610's own narrative
calls wrong. One rule, one place, both doors. \`S33\` edits a row to 25."
edit src/lib/sred.ts \
  '  if (badHours) throw new SredError('"'"'BAD_HOURS'"'"', `${badHours}.`)' \
  '  if (false) throw new SredError('"'"'BAD_HOURS'"'"', `${badHours}.`)' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 627
section "The same line twice in one paste goes in twice" \
"The batch is deduped against the table and not against itself, so two
identical rows in one block both insert — which is the exact case the rule
exists for, since nothing here can tell a genuine repeat of a day's work from
a double paste. \`S32\` pastes one line twice in one go."
edit src/lib/sred.ts \
  '      onFile.add(`${employeeId}|${r.onDate}|${r.activity}`)' \
  '      void 0' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 628
section "A piece of paper can be redated into a filed year" \
"The evidence door checks where the paper is and not where it is going, so a
draft year's photograph is moved into a filed return one date at a time. The
hours door has had both checks since it was written; this is its twin, and
until \`S33\` redated a paper nothing reached it."
edit src/lib/sred.ts \
  "    await refuseIfInFiledYear(tx, row.project_id, input.onDate) // where the paper is going" \
  "    await Promise.resolve() // where the paper is going" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 629
section "Hours written down after the return went are not mentioned" \
"Adding time to a filed year stays allowed — the project record goes on being
kept — and the paper stops saying it happened. The figures do not move, which
is the trap: what moves is the DENOMINATOR of an allocation basis that says
\"118 of 190 hours\", and that sentence was frozen when the year was filed.
\`S33\` files a year, adds an hour to it, and reads the paper."
edit src/lib/sred.ts \
  "    if (late && late.n > 0) {" \
  "    if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 630
section "Filing records the date on the return and not the moment" \
"\`filed_at\` stops being set, so nothing can tell a record written before the
filing from one written after it — \`filed_on\` is a business date and a year
filed today with a date next June makes every record look early. That is what
0073 exists for, and the only thing that reads it is the disclosure above.
\`S33\` reads the paper after adding an hour."
edit src/lib/sred.ts \
  "             filed_at = now()" \
  "             filed_at = NULL" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 631
section "The paste box is handed its own copy of the field names" \
"The screen stops passing the array the PARSER counts against and passes a
literal that happens to match today. The sentence on the box and the shape the
parser reads are then two things, and the next rename leaves the instructions
describing the old one — which is what the comment above the box used to claim
could not happen. \`S34\` reads the screen for the hand-off."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/time/new/AddTimeForm.tsx" \
  "                fields={TIME_PASTE_FIELDS}" \
  "                fields={['employeeName', 'onDate', 'hours', 'activity']}" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 632
section "A table that does not add up is computed with anyway" \
"\`vetted\` stops refusing, so an edition whose CPP maximum disagrees with its
own rate and ceiling still runs a payroll. The figures it produces look
entirely ordinary — that is the whole difficulty with tax tables, and the
reason the arithmetic is checked before anything is computed rather than
after somebody notices. \`PR52\` hands it a bent edition."
edit src/lib/payroll/rates.ts \
  "  if (wrong.length > 0) {" \
  "  if (wrong.length > 99) {" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 633
section "The bracket constants are no longer re-derived" \
"The tolerance on the K identity goes to a million dollars, so any constant
at all passes. K is what makes a bracket table work — a mistyped one is a
few hundred dollars a year on every stub in that bracket and nothing else
would catch it, because CRA is the only other source. \`PR50\` mistypes one."
edit src/lib/payroll/rates-check.ts \
  "    if (!within(acc, said, 100n)) {" \
  "    if (!within(acc, said, 100000000n)) {" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 634
section "The CPP and EI maximums are taken on trust" \
"Same slackening, on the four figures that are products of two others: the
CPP maximum, its base half, the CPP2 maximum and the EI premium ceiling.
These are the numbers a year's update is most likely to half-apply — the
ceiling moves and the maximum does not. \`PR50\` moves one."
edit src/lib/payroll/rates-check.ts \
  "    if (!within(made, asFrac(dollars(said)), 1n)) {" \
  "    if (!within(made, asFrac(dollars(said)), 100000000n)) {" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 635
section "A pay date takes the newest edition on file, whatever year it is for" \
"The clause that keeps an edition inside the pay date's own year goes, and the
search falls through to the last edition that starts before the date — so a
2027 pay date is computed with July 2026's tables. They are a real table,
correctly formed, so \`vetted\` passes them; every figure is wrong and every
stub looks normal, which is the one failure this module was built not to
have. \`PR49\` asks for a date one year past the last one covered."
edit src/lib/payroll/rates.ts \
  "    .find((e) => payDate >= e.startsOn && Number(e.startsOn.slice(0, 4)) === year)" \
  "    .find((e) => payDate >= e.startsOn)" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 636
section "The BC credit stops being questioned when it does not add up" \
"The one identity CRA is not obliged to keep — the tax reduction's credit
being its phase-out span times its rate — stops being reported. It is a
question rather than a refusal on purpose, because the July 2026 edition
breaks it legitimately as a mid-year true-up; take the question away and the
next edition that breaks it by accident goes in silently. \`PR51\` bends the
credit and requires exactly one question and no refusal."
edit src/lib/payroll/rates-check.ts \
  "  if (!within(implied, asFrac(dollars(r.maxCredit)), 100n)) {" \
  "  if (!within(implied, asFrac(dollars(r.maxCredit)), 100000000n)) {" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 637
section "A document is taxed at today's rate, not its own day's" \
"The figures in force are chosen by the LAST entry rather than by the date
asked for, so every document is priced at whatever is newest on file. It
changes nothing until a rate moves — and the day one does, every invoice
entered late for an earlier period is out by the difference, on a document
that already went to somebody. \`G31\` puts a second, different set of
figures in front of the same call and asks for a date in each."
edit src/lib/tax-rates.ts \
  "  const found = [...list].reverse().find((e) => on >= e.from)" \
  "  const found = list[list.length - 1]" || exit 1
run npm run db:verify-tax
close; restore

# ---------------------------------------------------------------- 638
section "A date before any figures on file is given the earliest anyway" \
"The refusal goes and the oldest entry is handed back instead. It reads as
harmless — the oldest is probably right for an old date — and it is the same
shape as computing 2027 payroll with 2026's tables: a real set of figures for
a period nobody entered them for. \`G30\` asks for a date in 2001."
edit src/lib/tax-rates.ts \
  "  if (!found) {" \
  "  if (false) {" || exit 1
run npm run db:verify-tax
close; restore

# ---------------------------------------------------------------- 639
section "The PST commission is worked out on the wrong end of the period" \
"Box C is taken from the scale in force at the START of the period rather
than its end. Today the two are the same and nothing moves; the day BC
changes the scale mid-period, a return is worked out on the scale it was not
under, and box C is money owed. \`G30\` reads the caller — and says plainly
that reading it is all a single scale on file allows."
edit src/lib/tax.ts \
  "  const commission = opts.late ? 0n : pstCommission(collected, to)" \
  "  const commission = opts.late ? 0n : pstCommission(collected, from)" || exit 1
run npm run db:verify-tax
close; restore

# ---------------------------------------------------------------- 640
section "An invoice is taxed at the oldest rate on file" \
"\`resolveTaggedLines\` stops passing the issue date and pins the epoch, so
every invoice is priced on the first entry whatever its own date. Same class
as 637, one caller along, and the one a person actually meets: entering last
month's paperwork is the ordinary case. \`G30\` reads the caller; the
arithmetic itself is \`G31\`."
edit $'src/lib/invoice-forms.ts' $'    try { t = computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, p.overrides) }' $'    try { t = computeEnteredTax(p.typed, p.taxCode, inclusive, \'2013-04-01\', p.overrides) }' || exit 1
run npm run db:verify-tax
close; restore

# ---------------------------------------------------------------- 641
section "A rate can be filed under a jurisdiction nobody prices" \
"The door stops checking, so \`Mars\` reaches 0068's CHECK and comes back as
a constraint error rather than a sentence. Worse, a typo like \`Federal\`
would be refused by the database with no hint that the list is two words
long. \`S36\` sends one that is not on the list."
edit src/lib/sred.ts \
  "  if (!(JURISDICTIONS as readonly string[]).includes(input.jurisdiction)) {" \
  "  if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 642
section "A rate can go in with no authority" \
"0068's own words: a rate with no authority is a rate somebody remembered.
The column is NOT NULL so an empty string satisfies it, and the working
paper then prints a percentage citing nothing. \`S36\` sends a blank one."
edit src/lib/sred.ts \
  "  if (!input.authority.trim()) {" \
  "  if (false) {" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 643
section "Every rate row's Save edits the first rate" \
"The id written once per row and used by both its forms stops being written
at all, so each form posts with no \`rateId\` — which the door reads as
\"add a new one\". Pressing Save on the 35% line would leave that line
untouched and add a twelfth rate beside it. \`S36\` renders two rows and
counts each row's own id."
edit "src/app/ledger/[ledgerId]/sred/Rates.tsx" \
  '      {r && <input type="hidden" name={F.rateId} value={r.id} />}' \
  '      {false && <input type="hidden" name={F.rateId} value={r?.id} />}' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 644
section "A rate a filed return was worked out with can be rewritten or deleted" \
"The fence goes. Editing one moves a filed year's figures underneath a return
that has already gone; DELETING one is worse than that — the working paper
reads the rates live, so \`rateOf\` throws and the year stops opening at all.
The rest of this module refuses both and says so in prose above these very
doors; the first version of them refused neither. \`S36\` files a year and
then reaches for a rate that year's paper is built from."
edit src/lib/sred.ts \
  "       AND y.end_date >= r.effective_from" \
  "       AND y.end_date >= r.effective_from AND false" || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 645
section "The rename takes away the backups already on disk" \
"The picker stops offering the old name, so every \`.figtree\` file made
before the rename is greyed out in the dialog — invisible, on the one screen
whose whole job is to get a company back. The button still says the right
thing and the code still reads both, which is exactly how this went wrong
once before: the bill reader said it took PDFs in its code, its help text,
its doc and its changelog while its own \`accept\` filtered them out.
\`BK19\` reads the rendered control."
edit src/lib/backup-name.ts \
  "export const BACKUP_ACCEPT = '.fig,.figtree'" \
  "export const BACKUP_ACCEPT = '.fig'" || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 646
section "A backup is written under the old name again" \
"The file a person downloads goes back to \`.figtree\` while every sentence
around it says \`.fig\`. Nothing breaks — the reader takes both — which is
what makes it worth a block: the only symptom is a name, and a name is what
somebody looks for a year later. \`BK19\` reads the button."
edit src/lib/backup-name.ts \
  "export const BACKUP_EXT = '.fig'" \
  "export const BACKUP_EXT = '.figtree'" || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 647
section "The desk shows a different mark from the browser tab" \
"The tab uses the fig but the desk brand falls back to scaffold art.
\`P39\` requires both to use the same shipped icon."
edit src/components/Desk.tsx \
  'src="/banyan-icon.png"' \
  'src="/next.svg"' || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 648
section "The sidebar repeats the desk brand above the company" \
"A second brand row returns above the company selector, using vertical space
and repeating the tab bar. \`P39\` checks that the rail has no brand block."
edit src/components/NavRail.tsx \
  '      <div className="nav-company px-3 pt-3 pb-3">' \
  '      <div className="nav-brand px-3 pt-3 pb-3">' || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 649
section "A quarter is one month" \
"\`groupPeriods\` cuts the span into groups of one whatever was asked, so
\"by quarter\" is by month with the wrong word over it. \`T41\` counts four."
edit src/lib/columns.ts \
  "  const size = by === 'quarter' ? 3 : 1" \
  "  const size = by === 'quarter' ? 1 : 1" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 650
section "A group of three months is named after its first" \
"The heading over a quarter column says 2026-01, which is a month, and the
reader takes a quarter's figure for a month's. \`T43\` reads the short last
group's heading for the dash between its ends."
edit src/lib/columns.ts \
  "  return first.id === last.id ? first.name : range" \
  "  return first.id === last.id ? first.name : first.name" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 651
section "A balance sheet's last column is called Total" \
"The word invites the reader to add the columns, and on a balance sheet the
columns are balances at twelve dates — adding them is nonsense with a label
telling you to do it. \`T42\` asks the balance sheet for Closing."
edit src/lib/columns.ts \
  "  const totalLabel = position ? 'Closing' : 'Total'" \
  "  const totalLabel = 'Total'" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 652
section "Every statement claims its columns add up" \
"\`totalIsSum\` is true for the balance sheet too, so the screen and the
export stop saying the columns are not to be added. \`T42\` holds it false
on the position statement."
edit src/lib/columns.ts \
  "  const totalIsSum = !position" \
  "  const totalIsSum = true" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 653
section "One month is cut into one column and a total of the same figure" \
"The refusal on a single fiscal month is lifted, and the page shows the
month and then the month again under Total. \`T41\` asks a one-month span
for columns and expects none, with the sentence that says why."
edit src/lib/columns.ts \
  "  if (span.periods.length < 2) {" \
  "  if (span.periods.length < 1) {" || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 654
section "The export runs the comparison under a breakdown" \
"The comparison is rendered whatever was asked, and since the export lays
out whichever of the two came back first, a file asked for by month leaves
with the comparison's columns — three figures, none of them a month. \`X47\`
counts twelve month headings; \`X49\` asks for both and counts four figures."
edit src/lib/pdf-reports.ts \
  "    by ? Promise.resolve(null) : renderComparative(ledgerId, templateCode, resolved, compare)," \
  "    renderComparative(ledgerId, templateCode, resolved, compare)," || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 655
section "Thirteen columns on an upright sheet" \
"The sheet turns only past thirteen money columns, which a year by month
does not reach, so twelve months and a total are set across 504 points.
\`X47\` reads the page box of the wide file."
edit src/lib/pdf-reports.ts \
  "  const landscape = heads.length > 5" \
  "  const landscape = heads.length > 13" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 656
section "The note about balances goes on the wrong statement" \
"The sentence that the columns are balances and are not to be added is
printed under the profit and loss, whose columns do add, and left off the
balance sheet, whose columns do not. \`X48\` reads the balance sheet for it."
edit src/lib/pdf-reports.ts \
  "  if (columned && columned.columns.length > 0 && !columned.totalIsSum) {" \
  "  if (columned && columned.columns.length > 0 && columned.totalIsSum) {" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 657
section "A turned sheet is laid out against the upright one's edges" \
"The page box turns and the layout does not: rows are placed against a
bottom 720 points down on a sheet 612 points tall, and the last hundred
points of every page are drawn below the paper. Nothing reports it — the
writer does not know where the paper ends. \`X48\` reads where the lowest
line of the table was drawn."
edit src/lib/pdf.ts \
  "  const PAGE = head.landscape ? LANDSCAPE : PORTRAIT" \
  "  const PAGE = PORTRAIT" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 658
section "The sheet is told to turn and does not" \
"\`landscape\` reaches the builder and the document is still opened upright,
so the wide layout is drawn on the narrow page and the right-hand columns
fall off it. \`X47\` reads the page box."
edit src/lib/pdf.ts \
  "    size: 'LETTER', layout: head.landscape ? 'landscape' : 'portrait'," \
  "    size: 'LETTER', layout: 'portrait'," || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 659
section "The workbook prints upright whatever its width" \
"The sheet's page setup ignores \`landscape\`, and a year by month prints
thirteen columns squeezed onto a portrait page. \`X49\` reads the setup of
both workbooks."
edit src/lib/excel.ts \
  "    pageSetup: { orientation: head.landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }," \
  "    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }," || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 660
section "A figure wider than its column is broken across two lines" \
"Money cells go back to being drawn with a width, and PDFKit — which wraps
anything given a width, by character once a word is too long — turns
-1,234,567.89 in a thirty-eight point column into two figures, neither of
them the amount. \`X50\` counts the wide figures drawn whole."
edit src/lib/pdf.ts \
  "      if (block.columns[i]?.align === 'right') placeRight(text, i, y)" \
  "      if (false) placeRight(text, i, y)" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 661
section "A heading that wrapped is given one line's height" \
"The header row is twelve points tall however many lines its headings
took, so the first row of figures is drawn through the second line of
\"2026-01 – 2026-03\". \`X50\` measures the gap between that line and the
row."
edit src/lib/pdf.ts \
  "    doc.y = y + Math.max(12, Math.max(...cells.map((c) => c.height)) + 4)" \
  "    doc.y = y + 12" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 662
section "A fourteen-column table is set at the ordinary size" \
"The step down never happens, and a seven-figure amount at 8.5pt is fifty-two
points wide in a column of thirty-five (the gutters stay at ten) — drawn
whole, and lying across the figure to its left. \`X50\` reads the size the
wide figures were set in."
edit src/lib/pdf.ts \
  "  const dense = block.columns.length > 9" \
  "  const dense = block.columns.length > 99" || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 663
section "The tab's icon is sent to the login page" \
"The gate's matcher stops excluding \`icon.png\`, and every request for the
mark is redirected to sign in — the tab sits blank, on the login page too,
which is the first thing anybody sees. This is the defect the owner reported
as 「网页没有正常运行」. \`P39\` compiles the matcher and runs it on that path."
edit src/proxy.ts \
  "  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|figtree-icon.png|banyan-icon.png).*)']," \
  "  matcher: ['/((?!_next/static|_next/image|favicon.ico|figtree-icon.png).*)']," || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 664
section "Another company's account reads as ours" \
"\`belongsToLedger('account', …)\` — which \`ours('account', …)\` answers from — joins
the ledger and never compares it, so any account whose company has any ledger
passes. The Accounts seat on company A renames and retags B's chart again.
\`A30\` posts B's account under A's ledger at both doors."
edit src/lib/bank.ts \
  '       WHERE a.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`' \
  '       WHERE a.id = ${id}::uuid`' || exit 1
run npm run db:verify-accounts
close; restore

# ---------------------------------------------------------------- 665
section "The delete door stops asking whose entry it is" \
"\`deleteEntry\` takes the ledger and ignores it. \`D41\` deletes B's posted entry under A's ledger and finds it gone."
edit src/lib/posting.ts \
  'export async function deleteEntry(entryId: string, actor = '"'"'system'"'"', ledgerId?: string, reason?: string, on: Runner = db) {
  await mustBeOurs('"'"'entry'"'"', entryId, ledgerId, (m) => new PostingError('"'"'NOT_OURS'"'"', m))' \
  'export async function deleteEntry(entryId: string, actor = '"'"'system'"'"', ledgerId?: string, reason?: string, on: Runner = db) {
  void ledgerId' || exit 1
run npm run db:verify-drafts
close; restore

# ---------------------------------------------------------------- 666
section "The invoice delete door stops asking whose invoice it is" \
"\`deleteInvoiceFromForm\` no longer judges the invoice id against the ledger the form came from. \`V120\` deletes B's draft invoice under A's ledger."
edit src/lib/invoice-forms.ts \
  'export async function deleteInvoiceFromForm(f: FormData, actor: string, context?: EditContext): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['"'"'invoice'"'"', g(f, F.invoiceId)]], g(f, F.ledgerId))' \
  'export async function deleteInvoiceFromForm(f: FormData, actor: string, context?: EditContext): Promise<FormResult> {
  const nope = null as { error: string } | null' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 667
section "Unapply stops asking whose application it is" \
"\`unapplyFromForm\` releases any application id it is handed. \`PM44\` unapplies B's payment under A's ledger."
edit src/lib/payment-forms.ts \
  '  const nope = await refuseUnlessOurs([['"'"'application'"'"', g(f, F.applicationId)]], g(f, F.ledgerId))' \
  '  const nope = null as { error: string } | null' || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 668
section "Renaming a party stops asking whose party it is" \
"\`updatePartyFromForm\` renames any party id it is handed — a supplier only Beta deals with, from Alpha's screen. \`P55\` posts exactly that."
edit src/lib/party-forms.ts \
  'export async function updatePartyFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['"'"'party'"'"', g(f, F.partyId)]], g(f, F.ledgerId))' \
  'export async function updatePartyFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  const nope = null as { error: string } | null' || exit 1
run npm run db:verify-parties
close; restore

# ---------------------------------------------------------------- 669
section "Ceasing a director stops asking whose directorship it is" \
"\`ceaseDirectorFromForm\` ends any directorship id it is handed. \`CR37\` ends B's director's term under A's ledger."
edit src/lib/record-forms.ts \
  '  const nope = await refuseUnlessOurs([['"'"'directorship'"'"', g(f, RECORD_FIELDS.directorshipId)]], g(f, RECORD_FIELDS.ledgerId))' \
  '  const nope = null as { error: string } | null' || exit 1
run npm run db:verify-records
close; restore

# ---------------------------------------------------------------- 670
section "Ceasing a tax registration stops asking whose it is" \
"\`ceaseTaxFromForm\` ends any registration id it is handed. \`R63\` ends B's GST registration under A's ledger."
edit src/lib/tax-forms.ts \
  '  const nope = await refuseUnlessOurs([['"'"'registration'"'"', String(formData.get(F.registrationId) ?? '"'"''"'"')]], String(formData.get(F.ledgerId) ?? '"'"''"'"'))' \
  '  const nope = null as { error: string } | null' || exit 1
run npm run db:verify-registrations
close; restore

# ---------------------------------------------------------------- 671
section "Another company's SR&ED project reads as ours" \
"\`ours('sred_project', …)\` joins the ledger and never compares it. \`S37\` asks the predicate about B's project under A's ledger."
edit src/modules/sred/ownership.ts \
  '    sred_project: sql`SELECT 1 AS ok FROM sred_project p ${L} = p.entity_id WHERE p.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,' \
  '    sred_project: sql`SELECT 1 AS ok FROM sred_project p ${L} = p.entity_id WHERE p.id = ${id}::uuid`,' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 672
section "A stored file is shown as whatever type its uploader said" \
"\`fileResponse\` echoes the stored type again, so a receipt.pdf sent as text/html is served as HTML on this origin. \`AT14\` replays exactly that file."
edit src/lib/pdf-reports.ts \
  '      '"'"'Content-Type'"'"': SHOWABLE.test(file.mime) ? file.mime : '"'"'application/octet-stream'"'"',' \
  '      '"'"'Content-Type'"'"': file.mime,' || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 673
section "The browser is left to guess a stored file's type" \
"The nosniff header goes, and a browser that disagrees with application/octet-stream may render the bytes as it sees fit. \`AT14\` reads the header."
edit src/lib/pdf-reports.ts \
  '      '"'"'X-Content-Type-Options'"'"': '"'"'nosniff'"'"',' \
  '      '"'"'X-Content-Type-Options'"'"': '"'"''"'"',' || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 674
section "The SR&ED doors stop asking" \
"\`sredAction\` no longer asks \`refuseUnlessOurs\` about the ids on the form; sixteen doors are open to another company's project, claim, time, evidence and allocation ids at once. \`S37\` reads the door for the question."
edit "src/app/ledger/[ledgerId]/sred/actions.ts" \
  '  const nope = await refuseUnlessOurs(SRED_OWNED.map(([kind, field]) => [kind, String(formData.get(field) ?? '"'"''"'"')]), ledgerId)' \
  '  const nope = null as { error: string } | null' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 675
section "The allocation's source is not asked about" \
"\`sredAction\` still asks about the seven id fields but stops judging the
allocation's source — a pay stub or a journal line of any company can be
claimed. \`S37\` reads the door for that one question and asks the predicate
about a pay stub both ways."
edit "src/app/ledger/[ledgerId]/sred/actions.ts" \
  '  const noSource = sourceId ? await refuseUnlessOurs([[sourceKind, sourceId]], ledgerId) : null' \
  '  const noSource = null as { error: string } | null' || exit 1
run npm run db:verify-sred
close; restore

# ---------------------------------------------------------------- 676
section "A New Year's Day pay run inherits the whole old year" \
"The year to date takes its year from the day before its bound again. A T4
still gets its year; a pay run dated 1 January gets the year before, every
ceiling already met, and withholds no CPP and no EI. \`PR54\` asks the same
bound the two ways."
edit src/lib/payroll/employees.ts \
  "       AND date_part('year', pr.pay_date) = \${year}
       AND pr.pay_date < \${before}::date" \
  "       AND date_part('year', pr.pay_date) = date_part('year', \${before}::date - 1)
       AND pr.pay_date < \${before}::date" || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 677
section "A next year's table inherits this year's confirmation" \
"The checker honours any \`confirmed\` at all rather than one naming the
edition in hand, so a 2027 table built by spreading the 2026 one is never
asked about its own numbers. \`PR55\` spreads the July table into 2027-07 and
expects the query back."
edit src/lib/payroll/rates-check.ts \
  '  if (r.confirmed?.edition === id) return' \
  '  if (r.confirmed) return' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 678
section "An edition may be named for a year it does not start in" \
"The id's year is no longer held to the start date's year: a 2027 id on
the 2026 table sits on the payroll page claiming a year it does not cover.
\`PR55\` names an edition wrongly and expects the refusal."
edit src/lib/payroll/rates-check.ts \
  '  if (e.id.slice(0, 4) !== e.startsOn.slice(0, 4)) {' \
  '  if (false) {' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 679
section "An owner marked not insurable is charged EI anyway" \
"The run stops zeroing insurable earnings for an EI-exempt person, so the
engine withholds EI from an owner the law says is not in insurable
employment, and remits the employer's share on top. \`PR56\` reads the
owner's stub."
edit src/lib/payroll/runs.ts \
  '    const insurable = e.ei_exempt ? 0n : (line.insurable ?? line.gross)' \
  '    const insurable = line.insurable ?? line.gross' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 680
section "Box 28 is blank for the exempt" \
"The T4 stops marking box 28, so an exempt person's slip shows nought in
box 18 or 16 with nothing to say why — the shape CRA queries. \`PR56\`
reads box 28 for both exempt people."
edit src/lib/payroll/t4.ts \
  "          text: [cppAllYear ? 'CPP' : '', eiAllYear ? 'EI' : ''].filter(Boolean).join(', ') || undefined," \
  "          text: undefined," || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 681
section "Every period is said to have had hours" \
"The ROE summary counts every period in the span as one whose hours were
entered, so Block 15A over twenty-seven periods with hours on three reads as
twenty-seven periods of hours and the page says nothing. \`PR57\` builds a
two-period ROE with hours on one."
edit src/lib/payroll/roe.ts \
  '      hoursRecorded: overHours.filter((p) => p.hours > 0n).length,' \
  '      hoursRecorded: overHours.length,' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 682
section "A confirmed figure is queried anyway" \
"The checker stops honouring \`confirmed\` altogether and asks about the July
reduction again, so the payroll page carries a warning about a number that
was read against T4127 and found right. \`PR55\` expects no query on the
confirmed edition."
edit src/lib/payroll/rates-check.ts \
  '  if (r.confirmed?.edition === id) return' \
  '  if (false) return' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 683
section "Box 28 is marked from today's flag" \
"The T4 marks box 28 from the exemption as it stands on the payroll record,
not from the year's stubs, so a person flagged in October after nine pays
had EI withheld gets a slip that says exempt beside a box 18 that says
otherwise — the shape CRA queries. \`PR56\` pays Lee Latecomer first and
flags him second."
edit src/lib/payroll/t4.ts \
  "          text: [cppAllYear ? 'CPP' : '', eiAllYear ? 'EI' : ''].filter(Boolean).join(', ') || undefined," \
  "          text: [s.cpp_exempt ? 'CPP' : '', s.ei_exempt ? 'EI' : ''].filter(Boolean).join(', ') || undefined," || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 684
section "A typed insurable figure for an exempt person is quietly replaced" \
"The run stops refusing an insurable figure typed for a person the record
says is not insurable, and silently carries nought instead — the person
typing it is never told their figure went nowhere. \`PR56\` types one for
the owner and expects the EXEMPT refusal."
edit src/lib/payroll/runs.ts \
  '    if (e.ei_exempt && line.insurable !== undefined && line.insurable !== 0n) {' \
  '    if (e.ei_exempt && line.insurable !== undefined && line.insurable !== 0n && false) {' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 685
section "A person never paid this year is told contributions were withheld" \
"The slip for a flagged person with no pay in the year takes the same reason
as one flagged after a withheld pay, so it says contributions were withheld
when nothing was. \`PR56\` flags Nia Nopay and never pays her."
edit src/lib/payroll/t4.ts \
  '      : t.periods === 0' \
  '      : t.periods < 0' || exit 1
run npm run db:verify-payroll
close; restore

# ---------------------------------------------------------------- 686
section "The restore check's fingerprint skips payroll, SR&ED, attachments and registers" \
"The fingerprint leaves out every table whose name says payroll, SR&ED,
attachment, share or minute book — the old eleven-figure shape, in effect —
so a backup that brings none of them back compares equal. \`BK20\` asks that
every catalogue table is a figure and names those five by name."
edit src/lib/backup-fingerprint.ts \
  '  const counts = tables.map((t) =>' \
  '  const counts = tables.filter((t) => !/^(pay_|sred_|attachment|share_|minute_)/.test(t)).map((t) =>' || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 687
section "A backup without its attachments shows the calm grey line" \
"The banner stops reading the attachments note backup.sh writes when the
schedule cannot reach the store, so receipts nobody copied sit under
'Backed up 3 hours ago'. \`backup:states\` hands it a record saying
ATTACHMENTS NOT BACKED UP and expects partial."
edit src/lib/backups.ts \
  '  if (record.attachments?.startsWith(ATTACHMENTS_NOT_BACKED_UP)) {' \
  '  if (record.attachments?.startsWith(ATTACHMENTS_NOT_BACKED_UP) && false) {' || exit 1
run npm run backup:states
close; restore

# ---------------------------------------------------------------- 688
section "A restore check that condemned the backup is shown as fine" \
"The banner no longer fails closed on a restore check that found the newest
dump does not come back as the books, so the schedule's green record stands
over a backup the check said cannot be trusted. \`backup:states\` writes such
a check record and expects failed."
edit src/lib/backups.ts \
  '  if (!check.trusted) {' \
  '  if (!check.trusted && false) {' || exit 1
run npm run backup:states
close; restore

# ---------------------------------------------------------------- 689
section "A restore check is never overdue" \
"The banner's threshold for nagging about the restore check is a thousand
times too far away, so a check last run forty days ago says nothing, and the
habit the RISKS file admits is the only defence has nothing reminding anyone.
\`backup:states\` expects the note at forty days."
edit src/lib/backups.ts \
  '  if (ageDays > CHECK_EVERY_DAYS) {' \
  '  if (ageDays > CHECK_EVERY_DAYS * 1000) {' || exit 1
run npm run backup:states
close; restore

# ---------------------------------------------------------------- 690
section "Never having restore-checked is not mentioned" \
"With no record of any restore check the banner says nothing, which is the
state every fresh installation is in and the one the note exists for.
\`backup:states\` removes the check record and expects the note."
edit src/lib/backups.ts \
  "      checkNote: 'No backup has ever been restore-checked. Run npm run backup:check — '" \
  "      checkNote: undefined && 'No backup has ever been restore-checked. Run npm run backup:check — '" || exit 1
run npm run backup:states
close; restore

# ---------------------------------------------------------------- 691
section "PG_BIN is ignored" \
"The resolver skips the directory it was told and goes straight to guessing,
so a machine whose tools are somewhere unusual cannot say so and every
backup, restore check and reset fails with 'not found' — or worse, finds an
older PostgreSQL first. \`BK21\` tells it a path and expects that path back."
edit src/lib/backup-paths.ts \
  '  if (env.PG_BIN) return env.PG_BIN' \
  '  if (env.PG_BIN && false) return env.PG_BIN' || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 692
section "A store full of receipts the backup never mentioned reads as ok" \
"The banner stops asking whether this machine has an attachments store when
the record says nothing about one, so an installed copy of the script older
than the archive step — or one never told where the store is — keeps the
calm grey line over receipts it never copied. \`backup:states\` puts a file
in the store and hands it a record with no attachments field."
edit src/lib/backups.ts \
  "  if (storeHasFiles() && !record.attachments?.startsWith('attachments archived')) {" \
  "  if (storeHasFiles() && !record.attachments?.startsWith('attachments archived') && false) {" || exit 1
run npm run backup:states
close; restore

# ---------------------------------------------------------------- 693
section "The condemnation names nothing" \
"The banner's red line for a restore check that failed no longer says which
check failed, so the person is told the backup cannot be trusted and not
why. \`backup:states\` hands it a check record naming R3 and expects the
label in the message."
edit src/lib/backups.ts \
  '    const said = check.problems.length > 0' \
  '    const said = check.problems.length > 99' || exit 1
run npm run backup:states
close; restore

# ---------------------------------------------------------------- 694
section "The quiet line shows under a condemnation" \
"The calm 'Restore-checked today' line is printed for a check that found
the backup cannot be trusted, directly under the red line saying so.
\`backup:states\` expects no quiet line on a failed check."
edit src/lib/backups.ts \
  "      ...status, check, state: 'failed'," \
  "      ...status, check, state: 'failed', checkLine: 'Restore-checked.'," || exit 1
run npm run backup:states
close; restore

# ---------------------------------------------------------------- 695
section "A store the schedule was told of and cannot see is recorded as no store" \
"backup.sh makes an unavailable configured attachment store a raw shell
failure instead of writing the explicit incomplete-backup status.
\`BK22\` tells it, by the config file, of a store that is not there."
edit scripts/backup.sh \
  'else
  ATTACH_OUT=""
fi' \
  'else
  false
fi' || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 696
section "Finder's .DS_Store counts as a receipt" \
"The banner counts every directory entry in the store as a file to be backed
up, so a store emptied of receipts but shown once in Finder keeps the amber
line for ever. \`backup:states\` fills the store with nothing but .DS_Store."
edit $'src/lib/backups.ts' $'    return readdirSync(directory).some((f) => !f.startsWith(\'.\'))' $'    return readdirSync(directory).length > 0' || exit 1
run npm run backup:states
close; restore

# ---------------------------------------------------------------- 697
section "A break-even year is never offered for closing" \
"The company page lists years to close by a nonzero TOTAL again, so a year
whose revenue and expenses net to zero — accounts to close, a year-end to
mark — is closable by the library and never from the page. \`P40\` asks for
the even fixture's year before it is closed."
edit src/lib/posting.ts \
  '       AND pl.any_account' \
  '       AND pl.total <> 0' || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 698
section "The periods overview counts a reversed pair twice" \
"The period's total sums every posted and reversed entry, so an entry and
the reversal that undid it are two amounts about no money, and the period
reads twice as busy as it was. \`P41\` reverses one entry and reads the row."
edit src/lib/periods.ts \
  "             WHERE je.period_id = fp.id AND je.status = 'posted' AND je.reverses_id IS NULL) AS total," \
  "             WHERE je.period_id = fp.id AND je.status IN ('posted','reversed')) AS total," || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 699
section "The reopen-year panel waits for a status no year has" \
"The periods page mounts the reopen-year control only for a 'locked' year,
and years are open or closed, so a closed year again has no screen to reopen
it from — four refusals point at nothing, as before. \`P42\` reads the page
for the closed-year condition."
edit "src/app/ledger/[ledgerId]/periods/page.tsx" \
  "        const reopening = fy.year_status === 'closed' && openedYearId === fy.year_id" \
  "        const reopening = fy.year_status === 'locked' && openedYearId === fy.year_id" || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 700
section "The cash flow statement stops asking whether the cache drifted" \
"renderCashFlow no longer asks check_balance_integrity, so a drifted cache
warns on the balance sheet and stays quiet on the cash flow statement that
shows the same wrong figures. \`T44\` puts one row out by a cent and reads
all three statements."
edit src/lib/cash-flow.ts \
  '  const drift = await driftProblem(ledgerId)' \
  '  const drift = null as string | null' || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 701
section "The equity statement stops asking whether the cache drifted" \
"The same for renderEquityChanges. \`T44\` reads it too."
edit src/lib/equity-changes.ts \
  '  const drift = await driftProblem(ledgerId)' \
  '  const drift = null as string | null' || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 702
section "The balance sheet stops asking whether the cache drifted" \
"And the templated statements — the question moved into drift.ts and this
is the balance sheet's call dropped. \`T44\` expects the warning on it."
edit src/lib/statements.ts \
  '  const drift = opts.drift !== undefined ? opts.drift : await driftProblem(ledgerId)' \
  '  const drift = opts.drift !== undefined ? opts.drift : null' || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 703
section "A purchase that landed on the balance sheet vanishes from money out" \
"The party ledger stops reading documents whose entry has no line of this
direction's P&L type, so a laptop bought and paid on the spot is on no page
but the journal. \`V121\` buys one and looks for it."
edit src/lib/browse.ts \
  '    capitalDocuments(ledgerId, direction, from, to),' \
  "    capitalDocuments(ledgerId, direction, '9999-12-31', '9999-12-31')," || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 704
section "An account only the cash flow reaches is still said to reach nothing" \
"0075's new reason is never chosen, so an account tagged only cf_operating is
reported as carrying roles that no statement uses — the sentence RISKS §8
went stale on. \`A18\` tags one and reads the reason."
edit db/migrations/0075_reaches_only_the_cash_flow.sql \
  '           WHEN EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = a.id' \
  '           WHEN false AND EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = a.id' || exit 1
run npm run db:verify-accounts
close; restore

# ---------------------------------------------------------------- 705
section "Any company's year can be reopened from any ledger" \
"reopenFiscalYear stops asking whether the year is this ledger's, so a
Periods seat on one company can reverse another company's closing entry —
the class node 1 closed for every other id, reopened at the door node 4
added. \`P43\` reopens the even fixture's year from the other ledger."
edit src/lib/posting.ts \
  "  await mustBeOurs('fiscal_year', fiscalYearId, ledgerId, (m) => new PostingError('NOT_OURS', m))" \
  "  await mustBeOurs('fiscal_year', fiscalYearId, undefined, (m) => new PostingError('NOT_OURS', m))" || exit 1
run npm run db:verify-periods
close; restore

# ---------------------------------------------------------------- 706
section "A redirect index points at a page that is not there" \
"The /payroll/runs index sends a typed URL to a misspelt path, so the
person lands on the 404 the index exists to prevent. \`N25\` follows every
redirect index to a page."
edit "src/app/ledger/[ledgerId]/payroll/runs/page.tsx" \
  '  redirect(`/ledger/${ledgerId}/payroll`)' \
  '  redirect(`/ledger/${ledgerId}/payrol`)' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 707
section "A credit note discards its actual tax overrides" \
"A credit note silently recalculates its GST/PST instead of preserving the
entered actual amounts. \`V122\` checks the stored tax amounts and direction,
independent of explanatory copy that the owner removed."
edit $'src/lib/invoice-forms.ts' $'    try { t = computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, p.overrides) }' $'    try { t = computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, kind === \'credit_note\' ? undefined : p.overrides) }' || exit 1
run npm run db:verify-invoices
close; restore

# ---------------------------------------------------------------- 708
section "A receipt already spent in full is still offered" \
"The read of unapplied receipts keeps an entry whose applications equal
what it moved, so an invoice is offered money that has nothing left — and
the trigger refuses it only after the person chose it. \`PM46\` records a
receipt, applies all of it, and expects it gone from the list."
edit src/lib/payments.ts \
  '                                             WHERE a.entry_id = je.id), 0) > 0' \
  '                                             WHERE a.entry_id = je.id), 0) >= 0' || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 709
section "The invoice page keeps its credits to itself" \
"DetailBody computes the party's credit notes and unapplied receipts and
hands the panel an empty list, so the door exists in the library and the
panel and opens from nowhere. \`PM47\` reads the hand-off."
edit "src/app/ledger/[ledgerId]/invoices/[invoiceId]/DetailBody.tsx" \
  '          credits={paymentsData.credits}' \
  '          credits={[]}' || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 710
section "Last year's quarters are this year's again" \
"The filing periods offered name last year's quarters with this year's
dates, so a January filing of Q4 is offered a quarter that has not happened.
\`G11\` asks for Q4 of last year by its own dates."
edit src/lib/tax.ts \
  '      name: `${name} ${last}`, from: from.replace(`${year}`, `${last}`), to: to.replace(`${year}`, `${last}`),' \
  '      name: `${name} ${year}`, from, to,' || exit 1
run npm run db:verify-tax
close; restore

# ---------------------------------------------------------------- 711
section "A shared receipt is charged for the other customer's use of it" \
"The unapplied figure subtracts every application the entry has made, not
those toward this party, so a cheque split across two customers is offered
to the first short by whatever the second has drawn. \`PM46\` splits one
600/400 and spends the 400."
edit src/lib/payments.ts \
  '                                               JOIN invoice i ON i.id = a.invoice_id AND i.party_id = ${partyId}::uuid
                                              WHERE a.entry_id = je.id), 0))::text AS unapplied' \
  '                                              WHERE a.entry_id = je.id), 0))::text AS unapplied' || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 712
section "A handed-in drift answer is ignored" \
"renderStatement asks check_balance_integrity even when the caller already
did, so the columned view is back to a scan per column — the cost the option
exists to remove — and a handed answer is not the one printed. \`T45\` hands
a sentinel and a null and expects both honoured."
edit src/lib/statements.ts \
  '  const drift = opts.drift !== undefined ? opts.drift : await driftProblem(ledgerId)' \
  '  const drift = await driftProblem(ledgerId)' || exit 1
run npm run db:verify-statements
close; restore

# ---------------------------------------------------------------- 713
section "The general ledger's running balance runs across accounts" \
"The one-read window loses its partition, so the running balance carries
from one account into the next and every account after the first reconciles
to nothing. \`X16\` ties opening + rows to the closing per account."
edit src/lib/reports.ts \
  '             SUM(jl.amount) OVER (PARTITION BY jl.account_id
                                  ORDER BY je.entry_date, je.entry_no, jl.line_no' \
  '             SUM(jl.amount) OVER (
                                  ORDER BY je.entry_date, je.entry_no, jl.line_no' || exit 1
run npm run db:verify-exports
close; restore

# ---------------------------------------------------------------- 714
section "The attachment sweep forgets which accounts an entry touched" \
"The one-read context hands every attachment an empty account list, so the
rebuild links nothing into the account folders and the sweep checks no
folder paths. The attachments suite counts the links and the folders."
edit src/lib/attachments.ts \
  '    accounts: (r.accounts ?? []) as Array<{ code: string; name: string }>,' \
  '    accounts: [] as Array<{ code: string; name: string }>,' || exit 1
run npm run db:verify-attachments
close; restore

# ---------------------------------------------------------------- 715
section "The customer statement reads every party again" \
"The SQL party filter goes, so the statement is built from every open entry
in the ledger — the shape the JS filter used to hide, and the audit's
finding. \`DC12\` renders a second customer's statement and expects only
their items."
edit src/lib/aging.ts \
  '  const onlyParty = partyId === undefined ? sql`` : sql`AND oi.party_id = ${partyId}::uuid`' \
  '  const onlyParty = sql``' || exit 1
run npm run db:verify-documents
close; restore

# ---------------------------------------------------------------- 716
section "The tax-role memo hands every role the first-asked account" \
"The memo loses its key, so a sale tagged GST+PST posts the PST to the GST
account — the exact wrong-account shape a per-line query never had. \`D42\`
posts one and reads both payable accounts."
edit src/lib/tagged-line.ts \
  '    const hit = seen.get(role)' \
  '    const hit = [...seen.values()][0]' || exit 1
run npm run db:verify-drafts
close; restore

# ---------------------------------------------------------------- 717
section "A person on payroll is unfindable again" \
"The search drops its employee read, so a name that is in the payroll module
answers nothing — the shape all five kinds were in before this node. \`SR11\`
searches for Quimby and expects the Employee hit."
edit src/modules/payroll/server.ts \
  '  searches: [{ order: 80, run: matchingEmployees }, { order: 90, run: matchingPayRuns }],' \
  '  searches: [{ order: 90, run: matchingPayRuns }],' || exit 1
run npm run db:verify-search
close; restore

# ---------------------------------------------------------------- 718
section "A screen spells its own red box again" \
"One refusal site goes back to a hand-rolled red class, so the box drifts
from the shared spelling the moment anyone edits it. \`N26\` sweeps every
file under src for a bg-red-50 outside the named tone sets."
edit "src/app/ledger/[ledgerId]/accounts/RoleEditor.tsx" \
  '<p role="alert" className={`mb-2 ${REFUSAL_QUIET}`}>' \
  '<p role="alert" className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-800">' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 719
section "A screen spells its own input again" \
"One field goes back to the second style, so the forms stop looking like one
application one control at a time. \`N27\` sweeps for the literal."
edit src/app/audit/page.tsx \
  '  const field = FIELD' \
  "  const field = 'rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700'" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 720
section "Tables stop scrolling at phone width" \
"The one rule that makes every table scroll sideways on a narrow screen
goes, so forty screens clip their columns again. \`N28\` reads the rule."
edit src/app/globals.css \
  '  main table {' \
  '  main .table-that-never-was {' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 721
section "The journal cannot see that another page exists" \
"The posted read loses its one lookahead row, but Next still depends on more
than 100 rows. Every visible page looks complete while later entries become
unreachable. N29 ties the bounded read to the displayed page and Next gate."
edit "src/app/ledger/[ledgerId]/entries/page.tsx" \
  "    journalEntries(ledgerId, { status: 'posted', limit: 101, offset: (page - 1) * 100, q: query, from, to })," \
  "    journalEntries(ledgerId, { status: 'posted', limit: 100, offset: (page - 1) * 100, q: query, from, to })," || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 722
section "The options lose their names" \
"Every option's id goes, so aria-activedescendant points at nothing and a
screen reader hears silence as the highlight moves. \`PK16\` reads the
rendered options for their ids."
edit src/components/Picker.tsx \
  '                          id={`${listId}-opt-${i}`}' \
  '' || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 723
section "The input stops naming the active option" \
"aria-activedescendant goes, so the options are named and nothing points at
the one the arrows are on. \`PK16\` reads the component for the wiring."
edit src/components/Picker.tsx \
  '        aria-activedescendant={open && shown[active] ? `${listId}-opt-${active}` : undefined}' \
  '' || exit 1
run npm run db:verify-picker
close; restore

# ---------------------------------------------------------------- 724
section "The overlay keeps the focus it took" \
"The overlay stops handing focus back to its opener, so closing a sub-page
strands the keyboard at the top of the document. \`N30\` reads the cleanup."
edit $'src/components/OverlayPanel.tsx' $'      if (opener?.isConnected && opener !== document.body && !opener.closest(\'[inert]\')) opener.focus()' $'      if (opener?.isConnected && opener !== document.body && !opener.closest(\'[inert]\')) void opener' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 725
section "The third input spelling comes back" \
"UserAdmin's input goes back to the px-3 spelling the first sweep missed and
the critic found in sixteen files, so N27's widened net must catch what its
first net could not."
edit src/app/users/UserAdmin.tsx \
  '  `mt-1 w-full ${FIELD}`' \
  "  'mt-1 w-full rounded border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700'" || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 726
section "The breakdown's download row prints again" \
"The print:hidden comes off the row the audit named and the first pass
dismissed, so a printed breakdown carries 'Download Excel · Download PDF'
as body text. \`N31\` reads every offering page."
edit "src/app/ledger/[ledgerId]/breakdown/BreakdownBody.tsx" \
  '      <div className="mt-3 flex justify-end gap-4 text-sm print:hidden">' \
  '      <div className="mt-3 flex justify-end gap-4 text-sm">' || exit 1
run npm run db:verify-shell
close; restore

# ---------------------------------------------------------------- 727
section "An unspent credit note counts as debt again" \
"\`owedAmount\` stops turning a credit note's remaining value negative, so a
customer with a 1,000.00 invoice and a 150.00 credit note reads as owing
1,150.00. \`PM48\` sums both sides of one party."
edit src/lib/payments.ts \
  "  i.document_kind === 'credit_note' ? -i.balance : i.balance" \
  "  i.balance" || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 728
section "The party page adds sizes again" \
"The page's \"They owe us\" total goes back to adding each document's balance
as it stands, so the credit note under it counts as more debt while the rows
above still print it negative. \`PM48b\` reads both sums."
edit "src/app/ledger/[ledgerId]/parties/[partyId]/PartyBody.tsx" \
  "  const owedToUs = open.filter((i) => i.direction === 'sales')
    .reduce((t, i) => t + owedAmount(i), 0n)" \
  "  const owedToUs = open.filter((i) => i.direction === 'sales')
    .reduce((t, i) => t + i.balance, 0n)" || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 729
section "The assistant's rows let the delete through" \
"The gate stops counting questions and bill readings, so a company whose only
rows are the assistant's reaches the delete — which then fails on 0061's
trigger with its own message, or removes a reading with no exchange. \`CO10\`
tries both."
edit src/lib/companies.ts \
  "  if (company.ai_records !== '0') {" \
  "  if (company.ai_records === 'never') {" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 730
section "A supplier's name in another script reads as nothing" \
"The name match goes back to keeping a-z and 0-9, so every Chinese supplier
name normalises to an empty string and the bill form never finds the
supplier. \`BR19\` matches one."
edit src/lib/prefill.ts \
  "    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')" \
  "    .replace(/[^a-z0-9]+/g, ' ')" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 731
section "The by-party pages count a credit note as unpaid debt again" \
"\`partyLedger\` puts \`openItemsQuery\`'s size straight into the Unpaid column,
so the income page's subtotal for a customer with a 1,000.00 invoice and a
150.00 credit note reads 1,150.00. \`PM48c\` adds one party's column."
edit src/lib/browse.ts \
  "  String(owedAmount({ document_kind: b.document_kind, balance: BigInt(b.balance) }))" \
  "  b.balance" || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 732
section "Credit held reads as a negative debt" \
"\`owedSummary\` keeps \"They owe us\" whatever the sign, so a customer holding
only a 150.00 credit note is shown as owing -150.00. \`PM48d\` asks for each
sign on each side."
edit src/lib/payments.ts \
  "    return total < 0n ? { label: 'They have credit with us', amount: -total } : { label: 'They owe us', amount: total }" \
  "    return { label: 'They owe us', amount: total }" || exit 1
run npm run db:verify-payments
close; restore

# ---------------------------------------------------------------- 733
section "The companies list offers Remove to a company the assistant knows" \
"The row stops asking about the assistant's rows, so a company whose only
records are questions to the assistant is offered Remove… — which the library
then refuses. \`CO11\` renders the row for each pair of counts."
edit src/app/companies/CompanyState.tsx \
  "  const removable = books === '0' && aiRecords === '0'" \
  "  const removable = books === '0'" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 734
section "A full-width or decomposed supplier name stops matching" \
"The name match stops folding with NFKC, so \"Ｓｏｎｙ Ｃａｎａｄａ\" is not \"Sony Canada\"
and an accent typed as a combining mark is not the same letter. \`BR19\`
tries both."
edit src/lib/prefill.ts \
  "  const words = s.replace(/\p{S}+/gu, ' ').normalize('NFKC').toLowerCase()" \
  "  const words = s.replace(/\p{S}+/gu, ' ').toLowerCase()" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 735
section "A Chinese company suffix makes a different name" \
"The match stops dropping 有限公司 and its kin, so the bill's 北方贸易有限公司
never finds the party 北方贸易 — while \"Staples Canada ULC\" still finds
\"Staples Canada\". \`BR19\` matches the Chinese one."
edit src/lib/prefill.ts \
  "  if (last >= 0) words[last] = words[last].replace(CHINESE_SUFFIX, '')" \
  "  if (last >= 0) words[last] = words[last]" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 736
section "A legal word in the middle of a name disappears" \
"The name match drops Inc, Company and the rest wherever they stand rather
than only at the end, so a bill from \"The Company Store\" opens on the party
\"The Store\". \`BR19\` asks for no match."
edit src/lib/prefill.ts \
  "  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop()" \
  "  words.splice(0, words.length, ...words.filter((w) => !LEGAL_SUFFIXES.has(w)))" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 737
section "A trademark sign becomes part of the name" \
"The match folds before dropping symbols, so ™ turns into the letters TM
stuck to the word and \"Fido™\" no longer finds the party \"Fido\". \`BR19\`
matches it."
edit src/lib/prefill.ts \
  "  const words = s.replace(/\p{S}+/gu, ' ').normalize('NFKC').toLowerCase()" \
  "  const words = s.normalize('NFKC').toLowerCase()" || exit 1
run npm run db:verify-bills
close; restore

# ---------------------------------------------------------------- 738
section "The companies list hands the row a count of its own" \
"The page stops passing the library's assistant count to the row, so a
company whose only records are questions to the assistant is offered
Remove… again while the row itself still decides correctly. \`CO11b\` reads
what the page hands it."
edit src/app/companies/page.tsx \
  "                                aiRecords={counts.get(c.entity_id)?.ai_records ?? '1'}" \
  "                                aiRecords=\"0\"" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 739
section "A round gets eighty look-ups" \
"\`LOOKUPS_PER_ROUND\` goes from 8 to 80, so a model that only ever calls keeps
sending requests long past the round. \`IQ3\` counts nine."
edit src/lib/inquiry.ts \
  'export const LOOKUPS_PER_ROUND = 8' \
  'export const LOOKUPS_PER_ROUND = 80' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 740
section "A question may look up without end" \
"The character cap is lifted out of reach, so results pile up in every request
and no step is ever \`too_much\`. \`IQ3\` asks for the cap on the heavy question."
edit src/lib/inquiry.ts \
  'export const QUESTION_CHARS = 60_000' \
  'export const QUESTION_CHARS = 60_000_000' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 741
section "The clock never stops a round" \
"The five-minute limit is never read, so a slow call is sent back and the
round goes on. \`IQ3\` moves the clock past it."
edit src/lib/inquiry.ts \
  '        const late = clock() - started > ROUND_MS' \
  '        const late = false' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 742
section "A reply with both a call and an answer counts as an answer" \
"The parser stops refusing an object that holds both, so a model hedging
between looking and answering has its guess taken as the answer. \`IQ2\` parses one."
edit src/lib/inquiry.ts \
  "  if (hasAnswer && !hasCall && typeof o.answer === 'string') return { kind: 'answer', text: o.answer }" \
  "  if (hasAnswer && typeof o.answer === 'string') return { kind: 'answer', text: o.answer }" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 743
section "Every address in this ledger is clickable" \
"A link in an answer becomes clickable when it merely starts with a ledger
path, so an address the model made up, or another company's, can be opened.
\`IQ10\` offers three that no result carried."
edit src/lib/inquiry.ts \
  '    if (links.has(href)) {' \
  "    if (href.startsWith('/ledger/')) {" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 744
section "A dollar amount without cents escapes the check" \
"Only numbers with two decimals are figures, so \"\$5,000\" in an answer is
never marked though no result carried it. \`IQ8\` writes one."
edit src/lib/inquiry.ts \
  "    if (frac === undefined && !dollar && !int.includes(',')) continue" \
  '    if (frac === undefined) continue' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 745
section "Keep looking is offered past the cap" \
"The capped step stops mattering, so a question that already looked up too
much is offered another round. \`IQ18\` asks about a capped one."
edit src/lib/inquiry.ts \
  '  if (steps.some((s) => s.capped)) return false' \
  '  if (steps.length < 0) return false' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 746
section "Anyone may keep someone else's question going" \
"The asker check stops refusing, so a person with a narrower seat continues the
owner's question on the owner's system text. \`IQ6\` presses as the clerk."
edit src/lib/inquiry.ts \
  '  if (head.asked_by !== input.user.email) {' \
  "  if (head.asked_by === 'nobody') {" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 747
section "Every question shows to every viewer" \
"The history stops filtering by asker, so a person with only the Assistant seat
reads the owner's look-ups — pay stubs, registers, bank rows. \`IQ6\` lists as the clerk."
edit src/lib/inquiry.ts \
  '  const everyone = access.entities === null && access.modules === null' \
  '  const everyone = true' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 748
section "A look-up that never ran reads as if it did" \
"The transcript stops saying a call after the limit or past the clock was not
run, so the next round's model believes it has a result it never saw.
\`IQ18\` rebuilds one."
edit src/lib/inquiry.ts \
  "    if (s.outcome === 'call_after_limit' || s.outcome === 'too_slow') parts.push(NOT_RUN)" \
  "    if (s.outcome === 'call_after_limit' && s.n < 0) parts.push(NOT_RUN)" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 749
section "The key is written into a step" \
"The model's words go into the row as they came back, so a service that echoes
the key leaves it in the table. \`IQ11\` searches every row."
edit src/lib/inquiry.ts \
  '    VALUES (${inquiryId}::uuid, ${s.n}, ${s.outcome}, ${withoutKey(s.model_text, key)},' \
  '    VALUES (${inquiryId}::uuid, ${s.n}, ${s.outcome}, ${s.model_text},' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 750
section "A tool runs without asking the seat" \
"\`runTool\` stops refusing a seat the person does not hold, so a clerk's forced
call reads the aging. \`IQ6\` forces one."
edit src/lib/inquiry-tools.ts \
  '    if (refusal) return `Refused: ${refusal.message}`' \
  '    if (refusal && ctx.ledgerId.length < 0) return `Refused: ${refusal.message}`' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 751
section "calculate launders a made-up amount" \
"\`calculate\` stops asking whether an amount was looked up, so two invented
numbers add into a figure the check then trusts. \`IQ9\` invents one."
edit src/lib/inquiry-tools.ts \
  "        if (!known.has(c)) throw new ArgError(\`Amount \${i + 1} is not a figure from this question's results. Look it up first.\`)" \
  "        if (!known.has(c) && c < 0n) throw new ArgError(\`Amount \${i + 1} is not a figure from this question's results. Look it up first.\`)" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 752
section "Another company's employee id is read without asking" \
"\`pay_stubs\` stops asking whether the employee is this company's; the reader
still binds the ledger, so the answer is an empty table rather than the
refusal. \`IQ5\` hands it the other company's id."
edit src/modules/payroll/inquiry-tools.ts \
  "      await mustBeOurs('employee', employee, ctx.ledgerId)" \
  '      void employee' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 753
section "What we owe reads negative" \
"\`owed\` stops turning the payable side around, so a supplier we owe 400.00
reads -400.00. \`IQ4\` reads the payable total."
edit src/lib/inquiry-tools.ts \
  "      const flip = side === 'payable' ? -1n : 1n" \
  '      const flip = 1n' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 754
section "A reversed pay run counts as pay" \
"\`pay_runs\` stops leaving out a run whose entry was reversed, so the wrong run
and its correction both count. \`IQ4\` looks for the reversed gross."
edit src/modules/payroll/inquiry-tools.ts \
  "        .filter((r) => r.status === 'posted' && (!from || r.pay_date >= from) && (!to || r.pay_date <= to))" \
  '        .filter((r) => (!from || r.pay_date >= from) && (!to || r.pay_date <= to))' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 755
section "An unspent credit note is sent as owed" \
"\`open_documents\` writes the unsigned size again, so the model reads a
150.00 credit note as 150.00 more owed. \`IQ4\` looks for -150.00."
edit $'src/lib/inquiry-tools.ts' $'money(owedAmount(i))' $'money(i.balance)' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 756
section "The employee list sends the SIN" \
"\`employees\` names the SIN where it named the occupation, which is the one
column the owner kept back. \`IQ7\` looks for it in every result."
edit src/modules/payroll/inquiry-tools.ts \
  "          e.occupation ?? '', e.hired_on ?? '', e.is_active ? 'yes' : 'no', e.cpp_exempt ? 'yes' : 'no', e.ei_exempt ? 'yes' : 'no'," \
  "          e.sin ?? '', e.hired_on ?? '', e.is_active ? 'yes' : 'no', e.cpp_exempt ? 'yes' : 'no', e.ei_exempt ? 'yes' : 'no'," || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 757
section "Totals by party read each line's own party" \
"An entry's lines stop belonging to the party named on its first party line,
so a bill's expense — whose only named line is the payable — falls into No
party and a supplier's spend is split. \`IQ17\` adds one supplier's bill and counter expense."
edit src/lib/inquiry-tools.ts \
  '               WHERE l2.entry_id = je.id ORDER BY l2.line_no LIMIT 1) fp ON true' \
  '               WHERE l2.entry_id = je.id AND l2.id = jl.id ORDER BY l2.line_no LIMIT 1) fp ON true' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 758
section "The aging link names a parameter the page does not read" \
"The catalogue writes \`as_of\` where the aging page reads \`asOf\`, so the link
opens today's aging whatever date was asked for. \`IQ15\` reads the page."
edit src/lib/report-catalogue.ts \
  '      page: `/aging?${qs({ asOf })}`,' \
  '      page: `/aging?${qs({ as_of: asOf })}`,' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 759
section "A backup leaves a question's steps behind" \
"The step table drops out of the company data, so a restored company has its
questions and none of what they looked up. \`BK1\` names every table."
edit src/lib/backup.ts \
  "{ order: 64, table: 'ai_inquiry_step', by: 'inquiry' }," \
  '  // ai_inquiry_step left out' || exit 1
run npm run db:verify-backup
close; restore

# ---------------------------------------------------------------- 760
section "A company that only asked the books slips past the gate" \
"The delete gate stops counting questions to the books, so a company whose only
rows are \`ai_inquiry\` reaches the delete and fails on the append-only
trigger with its own message. \`CO10\` tries one."
edit src/lib/companies.ts \
  "          + (SELECT count(*) FROM ai_inquiry q JOIN ledger l ON l.id = q.ledger_id
              WHERE l.entity_id = e.id))::text AS ai_records" \
  "          + (SELECT count(*) FROM ai_inquiry q JOIN ledger l ON l.id = q.ledger_id
              WHERE l.entity_id = e.id AND false))::text AS ai_records" || exit 1
run npm run db:verify-setup
close; restore

# ---------------------------------------------------------------- 761
section "A seat is chosen from untrimmed arguments" \
"\`runTool\` hands the seat and the tool the arguments as typed, so a direction written \" out \" chooses no seat at all and a person refused nothing reads nothing either. \`IQ6\` asks the spender for its own side with spaces around it."
edit src/lib/inquiry-tools.ts \
  '  const clean = tidy(args)' \
  '  const clean = args' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 762
section "A direction that is neither asks for either seat" \
"\`party_activity\` offers both pages' seats for a direction it does not know, so a person holding only Expenses passes the seat with \"IN\" and is told the argument is wrong instead of being refused. \`IQ6\` forces it."
edit src/lib/inquiry-tools.ts \
  "    seats: (args) => (args.direction === 'in' ? ['/income'] : args.direction === 'out' ? ['/expenses'] : [])," \
  "    seats: (args) => (args.direction === 'in' ? ['/income'] : args.direction === 'out' ? ['/expenses'] : ['/expenses', '/income'])," || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 763
section "An unknown report needs no seat" \
"\`report_link\` answers an unknown report with no seat at all, so the refusal and its company check are skipped. \`IQ6\` forces \"PD7A\" as the clerk."
edit src/lib/inquiry-tools.ts \
  '      return isReportKey(r) ? (seatsForPath(ledgerId, `/ledger/${ledgerId}${REPORTS[r].seatPath}`) ?? []) : []' \
  '      return isReportKey(r) ? (seatsForPath(ledgerId, `/ledger/${ledgerId}${REPORTS[r].seatPath}`) ?? []) : null' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 764
section "A refusal repeats the code it was given" \
"The account refusal quotes the code back, so an account called 777.77 puts 777.77 into the question's looked-up amounts. \`IQ9\` asks for one."
edit src/lib/inquiry-tool-runtime.ts \
  "  if (!a) throw new ArgError('No account in this company has that code.')" \
  '  if (!a) throw new ArgError(`No account in this company has the code ${code}.`)' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 765
section "Another ledger's address in a result becomes clickable" \
"\`sentLinks\` keeps any ledger address a result spelled out, so a bank line naming another company's page makes that link clickable. \`IQ10\` carries one in free text."
edit src/lib/inquiry.ts \
  '      if (link.startsWith(mine) && !/\/\.\.?(\/|\?|$)/.test(link)) links.add(link)' \
  '      if (!/\/\.\.?(\/|\?|$)/.test(link)) links.add(link)' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 766
section "A figure in a link label goes unchecked" \
"A clickable link's label is printed as it came, so \"[\$9,999.99](…)\" is never marked though nothing carried it. \`IQ8\` writes one."
edit src/lib/inquiry.ts \
  '      const unmatched = figuresIn(label).some((f) => !known.has(f.cents))' \
  '      const unmatched = false' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 767
section "An amount glued to letters escapes the check" \
"The figure pattern refuses a number after a letter again, so \"CAD2,718.28\" is never marked. \`IQ8\` writes one."
edit src/lib/inquiry.ts \
  'const FIGURE = /(?<![\d.,])(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d%]|[.,]\d)/g' \
  'const FIGURE = /(?<![\w.,])(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d%]|[.,]\d)/g' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 768
section "A journal cut by characters hides that the reader stopped too" \
"The row note stops saying there are more beyond the rows counted, so a journal cut by the character limit reads as if 101 rows were all there were. \`IQ4\` reads the note."
edit src/lib/inquiry-tool-runtime.ts \
  "  if (left > 0) out.push(\`\${left} more row\${left === 1 ? '' : 's'} not shown\${opts.more ? ', and more beyond those' : ''} — narrow the range, or use totals for sums.\`)" \
  "  if (left > 0) out.push(\`\${left} more row\${left === 1 ? '' : 's'} not shown — narrow the range, or use totals for sums.\`)" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 769
section "Search stops saying a kind was cut" \
"\`search\` stops naming the kinds that reached 25 matches, so a model reports 25 suppliers as all there are. \`IQ4\` searches for 105."
edit src/lib/inquiry-tools.ts \
  '      const cut = [...perKind].filter(([, n]) => n >= SEARCH_PER_KIND).map(([k]) => k)' \
  '      const cut: string[] = []' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 770
section "Totals say nothing about a closing entry" \
"\`totals\` stops naming a year-end closing entry in its range, so monthly revenue over a closed year reads as zero without a word. \`IQ17\` posts one."
edit src/lib/inquiry-tools.ts \
  '      const closingNote = !closing ? [] : [' \
  '      const closingNote = true ? [] : [' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 771
section "Keep looking goes to a different service than the record says" \
"\`askedWith\` stops comparing the person's saved service with the question's, so a round after a change of model is recorded as sent to the old one, and the page offers the button for it. \`IQ18\` changes the model."
edit src/lib/inquiry.ts \
  '  return hostOf(service.baseUrl) === q.service && service.model === q.model' \
  '  return true' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 772
section "A question is asked without the Assistant seat" \
"\`inquire\` stops asking the Assistant seat itself, so a library caller that skipped the action's gate sends the books for a person who may not ask. \`IQ6\` asks as the outsider."
edit src/lib/inquiry.ts \
  "  if (refused) throw new AssistantError('NO_SEAT', refused.message)" \
  '  void refused' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 773
section "A capped question gets another look-up" \
"The answer-only turn stops following a capped step, so a question that already looked up too much is sent back to look up more. \`IQ3\` rebuilds the request after the cap."
edit src/lib/inquiry.ts \
  '  return lookupsThisRound(steps) >= LOOKUPS_PER_ROUND || (steps.at(-1)?.capped ?? false)' \
  '  return lookupsThisRound(steps) >= LOOKUPS_PER_ROUND' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 774
section "owed takes another company's party without asking" \
"\`owed\` stops asking whether the party is this company's; the result is an empty table instead of the refusal. \`IQ5\` hands it the other company's customer."
edit src/lib/inquiry-tools.ts \
  "      const side = oneOf(args, 'side', SIDES)
      const party = text(args, 'party', false)
      if (party) await mustBeOurs('party', party, ctx.ledgerId)" \
  "      const side = oneOf(args, 'side', SIDES)
      const party = text(args, 'party', false)
      void party" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 775
section "open_documents takes another company's party without asking" \
"\`open_documents\` stops asking whether the party is this company's. \`IQ5\` hands it the other company's customer."
edit src/lib/inquiry-tools.ts \
  "      const direction = oneOf(args, 'direction', INVOICE_DIRECTIONS, false)
      const party = text(args, 'party', false)
      if (party) await mustBeOurs('party', party, ctx.ledgerId)" \
  "      const direction = oneOf(args, 'direction', INVOICE_DIRECTIONS, false)
      const party = text(args, 'party', false)
      void party" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 776
section "party_activity takes another company's party without asking" \
"\`party_activity\` stops asking whether the party is this company's. \`IQ5\` hands it the other company's customer."
edit src/lib/inquiry-tools.ts \
  "      await mustBeOurs('party', party, ctx.ledgerId)" \
  '      void party' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 777
section "report_link builds a link for another company's party" \
"\`report_link\` stops asking whether the party is this company's, and an address carrying the other company's id comes back clickable. \`IQ5\` asks for their statement."
edit src/lib/inquiry-tools.ts \
  "      if (party) await mustBeOurs('party', party, ctx.ledgerId)
      const built = reportLink(ctx.ledgerId, text(args, 'report'), {" \
  "      void party
      const built = reportLink(ctx.ledgerId, text(args, 'report'), {" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 778
section "A single-page seat is not offered party_activity" \
"\`party_activity\` loses the seats that put it on a list, so a person holding only Expenses is never told the tool exists though a call would run. \`IQ6\` reads the spender's list."
edit src/lib/inquiry-tools.ts \
  "    offeredTo: ['/expenses', '/income']," \
  '    offeredTo: [],' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 779
section "An amount with letters after it escapes the check" \
"The figure pattern refuses a letter after an amount's cents again, so \"6,543.21USD\" is never marked. \`IQ8\` writes one."
edit src/lib/inquiry.ts \
  'const FIGURE = /(?<![\d.,])(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d%]|[.,]\d)/g' \
  'const FIGURE = /(?<![\d.,])(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\w%]|[.,]\d)/g' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 780
section "A looked-up amount after letters is not counted" \
"\`lookedUp\` refuses a number after a letter again, so a result's \"CAD4,444.44\" does not count and an answer citing it is marked. \`IQ8\` cites one."
edit src/lib/inquiry.ts \
  'const LOOKED_UP = /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/g' \
  'const LOOKED_UP = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/g' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 781
section "An address that climbs out of this ledger is clickable" \
"\`sentLinks\` stops refusing a \`..\` segment, so \"/ledger/<this>/../<other>/parties/x\" in a bank line passes as this ledger's. \`IQ10\` carries one."
edit src/lib/inquiry.ts \
  '      if (link.startsWith(mine) && !/\/\.\.?(\/|\?|$)/.test(link)) links.add(link)' \
  '      if (link.startsWith(mine)) links.add(link)' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 782
section "A result's link keeps the sentence's full stop" \
"\`sentLinks\` stops taking punctuation off the end, so the link a result wrote at the end of a sentence never equals the one the answer copies. \`IQ10\` ends one with a full stop."
edit src/lib/inquiry.ts \
  "      const link = m[0].replace(/[.,;:!?)\\]'\"]+\$/, '')" \
  '      const link = m[0]' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 783
section "The history shows a person who lost the Assistant seat" \
"\`inquiriesFor\` stops asking the seat, so somebody whose Assistant seat was taken away still reads what their questions looked up. \`IQ6\` removes the outsider's seat."
edit src/lib/inquiry.ts \
  "  if (await refuseForLedger(viewer, ledgerId, '/assistant')) return []" \
  "  if (viewer.email === 'nobody') return []" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 784
section "Keep looking runs for a person who lost the Assistant seat" \
"\`keepLooking\` stops asking the seat, so a question asked with it can be continued without it. \`IQ6\` presses as the outsider."
edit src/lib/inquiry.ts \
  "  if (seat) throw new AssistantError('NO_SEAT', seat.message)" \
  '  void seat' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 785
section "A refused question is offered another round" \
"\`offersKeepLooking\` offers a round after a refusal, which is not a question stopped for want of look-ups. \`IQ18\` asks about refusal, error and cut-off."
edit src/lib/inquiry.ts \
  "  if (last.outcome === 'call_after_limit' || last.outcome === 'too_slow') return true" \
  "  if (last.outcome === 'call_after_limit' || last.outcome === 'too_slow' || last.outcome === 'refusal') return true" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 786
section "A range rounded to periods says it was not" \
"\`span\` stops saying the dates were rounded to whole periods, so a model reports mid-month figures for a range it did not get. \`IQ17\` asks from the 10th."
edit src/lib/inquiry-tool-runtime.ts \
  '  const said = s.snapped' \
  '  const said = s.snapped && s.periods.length < 0' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 787
section "The key is written into a step's arguments" \
"A call's arguments go into the row as the model sent them, so a model that searches for the key leaves it in the table. \`IQ11\` does."
edit src/lib/inquiry.ts \
  '            ${s.args === null ? null : withoutKey(JSON.stringify(s.args), key)}::jsonb,' \
  '            ${s.args === null ? null : JSON.stringify(s.args)}::jsonb,' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 788
section "An unknown tool's name is repeated back" \
"The unknown-tool sentence names what the model called, so a tool called 888.88 puts 888.88 into the looked-up amounts. \`IQ9\` calls one."
edit src/lib/inquiry-tools.ts \
  "    return \`There is no tool by that name in \${ctx.skill ? skillById(ctx.skill).label : 'this assistant'}. The tools are: \${names.join(', ')}.\`" \
  "    return \`There is no tool called \${name} in \${ctx.skill ? skillById(ctx.skill).label : 'this assistant'}. The tools are: \${names.join(', ')}.\`" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 789
section "An unknown report's name is repeated back" \
"The catalogue names the report it could not find, so a report called 999.99 puts 999.99 into the looked-up amounts. \`IQ9\` asks for one."
edit src/lib/report-catalogue.ts \
  "  if (!isReportKey(report)) return { error: \`There is no report by that name. Use one of: \${REPORT_KEYS.join(', ')}.\` }" \
  "  if (!isReportKey(report)) return { error: \`There is no report called \${report}. Use one of: \${REPORT_KEYS.join(', ')}.\` }" || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 790
section "Two amounts joined by a comma are one" \
"The answer stops splitting at a comma straight after cents, so \"1,084.56,7,777.77\" hides the second amount from the check. \`IQ8\` writes the pair."
edit src/lib/inquiry.ts \
  "  const scan = text.replace(/(?<=\\.\\d{2}),(?=\\d)/g, ' ')" \
  '  const scan = text' || exit 1
run npm run db:verify-inquiry
close; restore

# ---------------------------------------------------------------- 791
section "A bill reading is an earlier question" \
"\`earlierQuestionsFor\` stops leaving out the exchanges a bill reading points
at. Every reading's instruction, file name and chart of accounts shows under
Earlier questions as if a person had asked it. \`IQ16\` files a reading whose
question is worded another way, so only the link can leave it out."
edit src/lib/assistant.ts \
  '       AND NOT EXISTS (SELECT 1 FROM ai_bill_reading r WHERE r.exchange_id = x.id)' \
  '       AND true' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 792
section "A discarded reading comes back as a question" \
"The first-sentence test is dropped. Discarding a reading deletes its row, so
no link is left and only the question's first sentence says it was a reading;
without the test it shows under Earlier questions. \`IQ16\` keeps an exchange
no reading points at that begins with that sentence."
edit src/lib/assistant.ts \
  '       AND ${notAReading}' \
  '       AND true' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 793
section "A narrower seat reads everybody's earlier questions" \
"\`earlierQuestionsFor\` treats every viewer as holding every seat. A clerk
reads the owner's old questions and the books text each one sent, which the
clerk's own seats may not open. \`IQ16\` asks as the clerk."
edit src/lib/assistant.ts \
  '  const everyone = access.entities === null && access.modules === null' \
  '  const everyone = true' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 794
section "The reading spells out the sentence the page looks for" \
"\`readBill\`'s instruction writes its first sentence out again instead of
taking it from \`READING_QUESTION_STARTS\`. Nothing is wrong today; the day one
copy is reworded, discarded readings come back as questions. \`IQ16\` reads the
source for the shared sentence."
edit src/lib/bill-reading.ts \
  '  READING_QUESTION_STARTS[READING_QUESTION_STARTS.length - 1],' \
  "  'Read the attached bill, invoice or receipt and answer with ONE JSON object and nothing else.'," || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 795
section "A lost key is called a missing service" \
"The form tells a person whose saved key can no longer be read to save a
service, as if none were saved. They type the key again and never learn that
the application's secret changed, which leaves every other person's key
unreadable too. \`AI18\` changes the secret and asks through the form. (The
first mutant here dropped the form's no-service guard; \`inquire\` refuses a
missing service with the same sentence, so it changed nothing.)"
edit src/lib/inquiry-forms.ts \
  "    error: state.kind === 'none'" \
  "    error: state.kind !== 'ready'" || exit 1
run npm run db:verify-assistant
close; restore


# ---------------------------------------------------------------- 796
section "The question forgets the price it was asked at" \
"\`inquireFromForm\` hands \`inquire\` no prices. The question is answered and
its cost can never be worked out, because the price is kept per question from
the saved service at the time. \`IQ13\` reads the price back."
edit src/lib/inquiry-forms.ts \
  '      ledgerId: g(f, F.ledgerId), question: g(f, F.question), user, service: saved.service, prices: saved.prices,' \
  '      ledgerId: g(f, F.ledgerId), question: g(f, F.question), user, service: saved.service, prices: null,' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 797
section "A failed question says it was answered" \
"The form's sentence calls any question with a step answered. A declined or
failed question tells the person Answered, and they look for an answer that
is not there. \`IQ14\` fails one and declines one."
edit src/lib/inquiry-forms.ts \
  "  if (answerOf(q.steps)) return { ok: 'Answered.' }" \
  "  if (q.steps.length > 0) return { ok: 'Answered.' }" || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 798
section "Keep looking presses nothing" \
"\`keepLookingFromForm\` reads the company field where the question should be.
Every press names something that is not a question, and the button never
works. \`IQ14b\` presses from the form."
edit src/lib/inquiry-forms.ts \
  '      ledgerId: g(f, F.ledgerId), inquiryId: g(f, F.inquiryId), user, service: saved.service,' \
  '      ledgerId: g(f, F.ledgerId), inquiryId: g(f, F.ledgerId), user, service: saved.service,' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 799
section "A question that looked up too much is told to keep looking" \
"The form's limit sentence stops asking whether another round is offered. A
question past the character limit tells the person to press Keep looking, and
the page has no button for it. \`IQ14c\` runs one past the limit through the
form."
edit src/lib/inquiry-forms.ts \
  "    case 'too_slow': return offersKeepLooking(q.steps)" \
  "    case 'too_slow': return true" || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 800
section "The question form carries a key field" \
"The question form grows a field for the key. Nothing sends it today, but the
form is where the key must never travel. \`IQ13\` renders the real forms and
reads their field names."
edit $'src/app/ledger/[ledgerId]/assistant/InquireForm.tsx' $'      <textarea name={F.question} aria-label="Question" required maxLength={max} rows={4} defaultValue={start}' $'      <input name={F.apiKey} hidden readOnly />\n      <textarea name={F.question} aria-label="Question" required maxLength={max} rows={4} defaultValue={start}' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 801
section "Earlier questions for a person without the seat" \
"\`earlierQuestionsFor\` stops asking for the Assistant seat. A person whose
seat was taken away still reads their old questions and the books text each
one sent, from any caller but the page's door. \`IQ16b\` asks as the outsider."
edit src/lib/assistant.ts \
  "  if (await refuseForLedger(viewer, ledgerId, '/assistant')) return []" \
  "  if (false) return []" || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 802
section "A failure after the limit hides behind the narrower line" \
"\`stopLine\` says a capped question looked up too much before it looks at how
the question ended. A question that reached the character limit and then
failed on the relay shows only ask a narrower one, and the failure on record
is nowhere on the page. \`IQ14d\` fails the turn after the limit."
edit src/lib/inquiry.ts \
  "  if (!last) return 'It has not finished — it is still looking, or it stopped part way.'" \
  "  if (!last) return 'It has not finished — it is still looking, or it stopped part way.'
  if (steps.some((s) => s.capped)) return 'This question looked up too much to go on. Ask a narrower one.'" || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 803
section "Keep looking is offered to someone who did not ask" \
"\`keepLookingOffer\` stops asking who asked. Every viewer who can see a
question gets its button, and every press but the asker's is refused.
\`IQ14d\` asks for the clerk."
edit src/lib/inquiry.ts \
  '  if (q.asked_by !== viewerEmail || saved === null || !offersKeepLooking(q.steps)) return null' \
  '  if (saved === null || !offersKeepLooking(q.steps)) return null' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 804
section "The page offers a button the library will refuse" \
"\`keepLookingOffer\` stops comparing the saved service with the question's.
After a change of model the button stays, and every press is refused as a
changed service, with no word on the page why. \`IQ14d\` asks on another model."
edit src/lib/inquiry.ts \
  "  return askedWith(q, saved) ? 'button' : 'elsewhere'" \
  "  return 'button'" || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 805
section "Half a file is kept" \
"0077 no longer ties the four file columns together. A reading can keep a name with no bytes, which the file route answers with nothing and the card links to anyway. \`BR22\` writes half a file."
edit db/migrations/0077_a_sentence_is_enough.sql \
  '    CHECK ((filename IS NULL) = (mime IS NULL) AND (mime IS NULL) = (bytes IS NULL) AND (bytes IS NULL) = (sha256 IS NULL)),' \
  '    CHECK (true),' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 806
section "A reading of nothing is kept" \
"0077 no longer asks for a file or a sentence. A row with neither is a card with nothing to review and two doors to enter it by. \`BR22\` writes one."
edit db/migrations/0077_a_sentence_is_enough.sql \
  '  ADD CONSTRAINT ai_bill_reading_something CHECK (bytes IS NOT NULL OR sentence IS NOT NULL);' \
  '  ADD CONSTRAINT ai_bill_reading_something CHECK (true);' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 807
section "A blank sentence is a sentence" \
"0077 lets a sentence of spaces, or of newlines, stand in for what was read. \`BR22\` writes both."
edit db/migrations/0077_a_sentence_is_enough.sql \
  "  ADD CONSTRAINT ai_bill_reading_sentence_said CHECK (sentence IS NULL OR sentence ~ '[^[:space:]]')," \
  '  ADD CONSTRAINT ai_bill_reading_sentence_said CHECK (true),' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 808
section "The sentence behind an entered reading changes" \
"The trigger guards an entered reading's file but not its sentence. What a person wrote can be rewritten after it became an entry, and the record of what was read no longer matches what was posted. \`BR22\` rewrites it. (0080 re-issues the trigger, so the block edits 0080's copy: editing 0077's would edit a function nothing runs.)"
edit db/migrations/0080_a_minute_book_is_many_rows.sql \
  '  IF OLD.used_entry_id IS NOT NULL AND NEW.sentence IS DISTINCT FROM OLD.sentence THEN' \
  '  IF false THEN' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 809
section "The sentence is read and forgotten" \
"\`readBill\` stores no sentence. The reading from a sentence alone keeps nothing of what was written; the card and the form beside it cannot show it. \`BR20\` reads the row."
edit src/lib/bill-reading.ts \
  '            ${file?.bytes ?? null}, ${sha}, ${sentence}, ${proposal ? JSON.stringify(proposal) : null}::jsonb, ${error})' \
  '            ${file?.bytes ?? null}, ${sha}, ${null}, ${proposal ? JSON.stringify(proposal) : null}::jsonb, ${error})' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 810
section "Yesterday with no today" \
"The chart context stops carrying today's date. A sentence that says yesterday or last month is read against nothing, and the proposal's date is a guess. \`BR20\` looks for the date in what left."
edit src/lib/bill-reading.ts \
  '    `Today: ${localToday()}.`,' \
  '' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 811
section "Nothing is read anyway" \
"\`readBill\` stops refusing when neither a sentence nor a document arrived. The empty question goes to the service and is paid for before the table refuses the row. \`BR20\` asks with nothing, against a sender that must not be reached."
edit src/lib/bill-reading.ts \
  "  if (!file && !sentence) {
    throw new BillReadingError('EMPTY', 'Write what happened, or choose the document — nothing arrived to read.')
  }" \
  '' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 812
section "A sentence too long goes out" \
"\`readBill\` stops capping the sentence. It is sent and paid for, or refused by the question cap after the reading said nothing. \`BR20\` sends one character too many."
edit src/lib/bill-reading.ts \
  '  if (sentence && sentence.length > SENTENCE_MAX) {' \
  '  if (false) {' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 813
section "Half a document is read as none" \
"\`readBill\` stops asking for the name, the type and the contents together. A document that lost two of them is quietly dropped and the sentence is read alone. \`BR20\` hands in a name with no file."
edit src/lib/bill-reading.ts \
  '  if (parts !== 0 && parts !== 3) {' \
  '  if (false) {' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 814
section "An empty file box is a file" \
"The form takes the unnamed, empty file a browser sends for a file box left alone as a document. Every sentence typed without a file is refused as an empty file. \`BR20\` posts the form that way."
edit src/lib/bill-forms.ts \
  '    const chosen = file instanceof File && file.size > 0 ? file : null' \
  '    const chosen = file instanceof File ? file : null' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 815
section "A stored proposal loses its party" \
"\`proposalOf\` stops reading the old word. Every reading stored before 2026-09-15 opens its forms with no supplier named. \`BR23\` stores one in the old words."
edit src/lib/bill-reading.ts \
  "    party: typeof p.party === 'string' ? p.party : typeof supplier === 'string' ? supplier : ''," \
  "    party: typeof p.party === 'string' ? p.party : ''," || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 816
section "A destination nobody has is kept" \
"\`suggestsOf\` passes any word through instead of checking it against the catalogue. A proposal naming a destination this app does not have reaches a card with no door for it. \`BR23\` reads one; \`B32\` reads an unknown answer."
edit src/lib/bill-reading.ts \
  "  DESTINATION_KEYS.includes(v as string) ? (v as string) : NO_DESTINATION" \
  "  v as string" || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 817
section "A model's old words lose the party" \
"\`parseProposal\` reads only party. A model that still answers supplier leaves the other side blank. \`BR23\` answers in the old words."
edit src/lib/bill-reading.ts \
  '    party: text(raw.party) || text(raw.supplier),' \
  '    party: text(raw.party),' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 818
section "A sentence is filed as a document" \
"\`attachReadingTo\` files whatever it has, and a reading from a sentence alone has no bytes. The filing fails after the entry posted, and the door says the bill could not be filed. \`BR26\` enters one at both doors."
edit src/lib/bill-reading.ts \
  '  const filed = row.bytes !== null && row.filename !== null && row.mime !== null' \
  '  const filed = true' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 819
section "The expense door says a sentence was filed" \
"\`quickEntryFromForm\` says the bill is filed against the entry whether or not there was one. The person opens the entry to find nothing attached. \`BR26\` enters a sentence alone."
edit src/lib/quick-forms.ts \
  "        filed = onPaper ? ' The document is filed against it.' : ' The reading is marked entered.'" \
  "        filed = ' The document is filed against it.'" || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 820
section "The bill door says a sentence was filed" \
"\`createInvoiceFromForm\` says the bill is filed against its entry whether or not there was one. \`BR26\` enters a sentence alone at this door too."
edit src/lib/invoice-forms.ts \
  '      return filed ? `${paper} The document is filed against its entry.` : `${paper} The reading is marked entered.`' \
  '      return `${paper} The document is filed against its entry.`' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 821
section "The file route reads a reading with no file" \
"\`readingFile\` stops leaving out a reading with no bytes, and turning nothing into a file throws. \`BR20\` asks for the file of a sentence."
edit src/lib/bill-reading.ts \
  '     WHERE id = ${id}::uuid AND ledger_id = ${ledgerId}::uuid AND bytes IS NOT NULL`)' \
  '     WHERE id = ${id}::uuid AND ledger_id = ${ledgerId}::uuid`)' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 822
section "A sentence cannot be searched for" \
"The search looks at file names only. A reading from a sentence alone has none, and nothing typed into the search box finds it. \`SR11b\` searches for its words."
edit src/lib/search.ts \
  '         OR ${inSentence})' \
  '         OR false)' || exit 1
run npm run db:verify-search
close; restore


# ---------------------------------------------------------------- 823
section "A sale remembers a purchase" \
"\`rememberedAccount\` takes an expense or a revenue account, whichever is newest. A party on both sides has its last purchase remembered onto money coming in. \`BR18c\` asks both ways."
edit src/lib/bill-reading.ts \
  '     WHERE a.account_type = ${type}' \
  "     WHERE a.account_type IN ('expense', 'revenue')" || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 824
section "The old first sentence is replaced, not kept" \
"\`READING_QUESTION_STARTS\` loses the sentence every reading before 2026-09-15 began with. Those readings, discarded, come back under Earlier questions with their chart of accounts. \`IQ16\` writes one out."
edit src/lib/reading-question.ts \
  "  'Read the attached bill, invoice or receipt and answer with ONE JSON object and nothing else.'," \
  '' || exit 1
run npm run db:verify-inquiry
close; restore


# ---------------------------------------------------------------- 825
section "A long file name goes out whole" \
"The file's name is sent unshortened — four hundred characters of somebody's naming, verbatim, to a relay. It used to be caught by the question cap too, when the prompt and the person's sentence shared one 4,000-character limit; splitting those on 2026-09-16 put that ceiling out of reach and left this block biting nothing, which \`db:toothless\` said out loud. \`BR2b\` reads what actually leaves."
edit src/lib/bill-reading.ts \
  '  const name = file && file.filename.length > NAME_SHOWN ? `${file.filename.slice(0, NAME_SHOWN)}…` : file?.filename' \
  '  const name = file?.filename' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 826
section "The card forgets the sentence" \
"\`readingCards\` hands the browser no sentence. A reading from a sentence alone shows as a card with no file and nothing written. \`BR20\` builds a card from one."
edit src/lib/bill-reading.ts \
  "    id: r.id, when: r.read_at.replace('T', ' ').slice(0, 16), by: r.read_by, filename: r.filename, sentence: r.sentence," \
  "    id: r.id, when: r.read_at.replace('T', ' ').slice(0, 16), by: r.read_by, filename: r.filename, sentence: null," || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 827
section "A sentence beside a document stays behind" \
"\`readBill\` sends the sentence only when there is no document. What the person wrote about the bill in their hand never reaches the model, though it is kept. \`BR21\` sends both."
edit src/lib/bill-reading.ts \
  'question: [INSTRUCTION, withFile, withSentence]' \
  'question: [INSTRUCTION, withFile, file ? null : withSentence]' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 828
section "An empty file is told to write something" \
"The form answers a chosen file of no bytes with the sentence for a form with
nothing in it, asking the person to write what happened on a page that has
nowhere to write. \`BR11\` sends an empty file by name."
edit src/lib/bill-forms.ts \
  "      const empty = file instanceof File && file.name !== ''" \
  '      const empty = false' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 829
section "The model is offered half the app" \
"\`destinationMenu\` lists only the money destinations. A registration document, a director's consent and a bank statement all meet a menu that cannot hold them, and the model has to force one of four again — which is the defect this catalogue was built to end. \`BR24\` counts the destinations in the question."
edit src/lib/destinations.ts \
  "  const offered = DESTINATIONS" \
  "  const offered = DESTINATIONS.slice(0, 4)" || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 830
section "A sales invoice loses its number" \
"\`invoiceInitialFrom\` leaves our number blank on a sales invoice. The document's number goes nowhere and a repeated number is never refused. \`BR25\` reads the header."
edit src/lib/prefill.ts \
  "      number: direction === 'sales' ? proposal.documentRef : ''," \
  "      number: ''," || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 831
section "A sales invoice's number is filed as theirs" \
"\`invoiceInitialFrom\` puts the document's number in their reference whatever the direction, so a sales invoice carries our own number as the customer's. \`BR25\` reads the header."
edit src/lib/prefill.ts \
  "      theirRef: direction === 'purchase' ? proposal.documentRef : ''," \
  '      theirRef: proposal.documentRef,' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 832
section "The income form remembers an expense account" \
"The quick form asks the books for an expense account whatever its kind. Income from a party on both sides opens on its last purchase's account, marked as remembered. \`BR24\` reads what the page asks for."
edit "src/app/ledger/[ledgerId]/entries/quick/[kind]/QuickBody.tsx" \
  "reading.proposal.party, expense ? 'expense' : 'revenue', plAccounts.map((a) => a.id))" \
  "reading.proposal.party, 'expense', plAccounts.map((a) => a.id))" || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 833
section "The sales invoice remembers an expense account" \
"The invoice form asks the books for an expense account whatever its direction. \`BR25\` reads what the page asks for."
edit "src/app/ledger/[ledgerId]/invoices/new/NewInvoiceBody.tsx" \
  'reading.proposal.party, side.rememberedType, data.accounts.map((a) => a.id))' \
  "reading.proposal.party, 'expense', data.accounts.map((a) => a.id))" || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 834
section "Money in is offered as money out" \
"The card treats every reading as money going out. A sentence about income offers an expense and a bill, and income only in the quiet line. \`BR27\` renders a card of each."
edit src/components/ReadBill.tsx \
  "  const moneyIn = p?.suggests === 'income' || p?.suggests === 'sale'" \
  '  const moneyIn = false' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 835
section "The model's choice is not the main button" \
"The card always leads with the first of the pair, so a bill or a sales invoice the model recognised opens behind the other button. \`BR27\` and \`BR12\` read the order."
edit src/components/ReadBill.tsx \
  '  const pair = p?.suggests === second.key ? [second, first] : [first, second]' \
  '  const pair = [first, second]' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 836
section "A sales invoice opens as a purchase bill" \
"The sales link drops its direction, so the invoice form opens a reading of a sale as a purchase bill on the suppliers list. \`BR27\` reads the link."
edit src/components/ReadBill.tsx \
  'invoices/new?direction=sales&reading=' \
  'invoices/new?reading=' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 837
section "The page has nowhere to write" \
"The sentence box posts under another field's name, so nothing written reaches the reader and every sentence-only submission is refused. \`BR27\` looks for the field."
edit src/components/ReadBill.tsx \
  '<textarea name={F.sentence}' \
  '<textarea name={F.ledgerId}' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 838
section "A file is required again" \
"The file box is required, so a sentence cannot be sent without choosing a file. \`BR27\` reads the input."
edit src/components/ReadBill.tsx \
  '<input type="file" name={F.file} accept=' \
  '<input type="file" name={F.file} required accept=' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 839
section "Income without a name is called a bill" \
"\`quickInitialFrom\` falls back to Bill for any kind, so income the model could not name opens described as a bill. \`BR24\` opens one."
edit src/lib/prefill.ts \
  "    description: proposal.party || (kind === 'expense' ? 'Bill' : 'Income')," \
  "    description: proposal.party || 'Bill'," || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 840
section "Every reading opens as a purchase bill" \
"\`invoiceInitialFrom\` forgets the direction it was given, so the invoice form opens a sale on the purchase side. \`BR25\` reads the direction."
edit src/lib/prefill.ts \
  '    direction,
    header: {' \
  "    direction: 'purchase',
    header: {" || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 841
section "A line break counts twice" \
"\`readBill\` measures the sentence with the browser's two-character line breaks, so a sentence the box accepted at its limit is refused as too long. \`BR20\` reads one with three."
edit src/lib/bill-reading.ts \
  'oneLineBreak(input.sentence)' \
  'input.sentence' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 842
section "The invoice form names no remembered line" \
"\`rememberedLines\` finds none, so a sales invoice opens with an account taken from the books looking like one a person chose. \`BR25\` opens one."
edit src/lib/prefill.ts \
  '  return rows.flatMap((r, i) => (r.fromMemory ? [i + 1] : []))' \
  '  return []' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 843
section "A sales invoice opens on the suppliers list" \
"The invoice body offers the purchase side's parties whatever the direction, so a sale from a reading finds no customer and says so falsely. \`BR25\` reads what the body offers (source)."
edit "src/app/ledger/[ledgerId]/invoices/new/NewInvoiceBody.tsx" \
  "data.parties[side.key], data.controlAccounts[side.key][0]?.id ?? ''" \
  "data.parties.purchase, data.controlAccounts[side.key][0]?.id ?? ''" || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 844
section "The income form names no party" \
"\`quickInitialFrom\` leaves the Party box empty though the reading names a customer the books have, so income is posted to nobody unless the person notices. \`BR24\` opens one."
edit src/lib/prefill.ts \
  "    partyId: named?.id ?? ''," \
  "    partyId: ''," || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 845
section "A sale read as income carries our number as theirs" \
"\`quickInitialFrom\` puts a sale's number in the income form's their-reference box, where our own invoice number does not belong. \`BR24\` opens one."
edit src/lib/prefill.ts \
  "    documentRef: kind === 'income' && proposal.suggests === 'sale' ? '' : proposal.documentRef," \
  '    documentRef: proposal.documentRef,' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 846
section "A reading entered twice is not said to be twice" \
"\`attachReadingTo\` says only that the bill was entered. A second form that raced the first has posted the same thing again and the person is not told to check. \`BR8\` attaches a used reading."
edit src/lib/bill-reading.ts \
  "const ENTERED_TWICE = 'That reading has already been entered as another entry, so the same thing may now be in the books twice — check the two entries and delete one.'" \
  "const ENTERED_TWICE = 'That bill has already been entered.'" || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 847
section "The invoice form hides its remembered lines" \
"The invoice body never shows the note naming the lines filled from the books. \`BR25\` reads the body (source)."
edit "src/app/ledger/[ledgerId]/invoices/new/NewInvoiceBody.tsx" \
  '{start && rememberedLines(start.rows).length > 0 && (' \
  '{start && false && (' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 848
section "Every reading opens on the purchase side" \
"\`invoiceSideFor\` ignores the direction, so a sale opens as a purchase bill on the suppliers list with the payable account. \`BR25\` asks it each way."
edit src/lib/prefill.ts \
  "  return direction === 'sales'" \
  '  return false' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 849
section "The income form looks for a supplier" \
"The quick body hands the income form the suppliers list to match the reading's party in. \`BR24\` reads the body (source)."
edit "src/app/ledger/[ledgerId]/entries/quick/[kind]/QuickBody.tsx" \
  'expense ? parties.suppliers : parties.customers' \
  'parties.suppliers' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 850
section "A reading's rows go into the same table twice" \
"The rows door stops asking whether this table was already entered from this reading before it marks it. 0080's trigger still refuses rewriting the mark — so nothing is doubled — but the door never words that refusal, and the person reads a bare database failure instead of being told the rows are already in the register. \`CR41\` presses Add twice and reads what the second press says."
edit src/lib/record-entry.ts \
  '           AND records_entered -> ${table}::text IS NULL' \
  '           AND true' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 851
section "Rows of one day go in in the order they were typed" \
"\`sameDayRank\` stops putting an issue before the transfer of what it issued. A minute book's first page is all one date, and a transfer typed above its issue is then refused as an overdrawn holding that never was. \`CR39\` types them in that order."
edit src/lib/record-entry.ts \
  "  if (table === 'shares') return v.kind === 'issue' ? 0 : v.kind === 'transfer' ? 1 : 2" \
  "  if (table === 'shares') return 0" || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 852
section "A movement the database refuses no longer names its row" \
"The batch stops asking for the share checks at the end of each statement, so 0035's deferred checks run at the commit, after the row loop has finished — and a form of twenty rows is told something was overdrawn, not which row. \`CR40\` overdraws in row 2 and reads the row number."
edit src/lib/record-entry.ts \
  '    await tx.execute(JUDGED_PER_ROW)' \
  '    void JUDGED_PER_ROW' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 853
section "Only the first row's problems are said" \
"\`rowProblems\` reads row 1 and stops. A form of twenty rows with three missing dates is fixed one refusal at a time, which is the paste box's lesson unlearned. \`CR40\` sends two bad rows and reads both."
edit src/lib/record-entry.ts \
  '  for (const { line, values: v } of rows) {' \
  '  for (const { line, values: v } of rows.slice(0, 1)) {' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 854
section "Somebody nobody has heard of gives up shares" \
"The rows door stops refusing a stranger in From and adds them to the list instead, as it does for somebody receiving shares. The holding check still refuses the movement — but by an amount, not by who, so the person is told a number went negative instead of that the name is wrong. \`CR40\` names a stranger."
edit src/lib/record-entry.ts \
  '  if (opts.giving) {' \
  '  if (false) {' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 855
section "The rows door takes the company from the form" \
"\`enterRowsFromForm\` reads an entity id off the form before the ledger's own, so a form carrying another company's id enters rows in that company's registers. \`CR37\` sends their id beside our ledger and counts both registers."
edit src/lib/record-forms.ts \
  '  const entityId = await entityOfLedger(ledgerId)' \
  '  const entityId = g(f, RECORD_FIELDS.entityId) || await entityOfLedger(ledgerId)' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 856
section "A model's foreign columns ride along" \
"\`rowsFrom\` keeps whatever else the model put in a row beside the columns the form takes. The proposal stored on the reading then carries keys no form reads and no door checks. \`CR41\` answers with a column that does not exist."
edit src/lib/record-rows.ts \
  '        if (t) row[c.key] = t.slice(0, 300)' \
  '        if (t) row[c.key] = t.slice(0, 300); Object.assign(row, item)' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 857
section "A date the model could not read is put in the box anyway" \
"\`formRowsFrom\` stops blanking a date that is not one, so the date box is handed March 3rd. The note under the row still says what was read, but the box now holds text a date field cannot show, and the form posts it. \`CR41\` reads the form rows; \`CR43\` renders the form and finds the unread date in the box's value."
edit src/lib/record-rows.ts \
  "        values[c.key] = ok ? v : ''" \
  '        values[c.key] = v' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 858
section "The records screen opens a date box on every row again" \
"Cease starts open, so every director and significant individual carries a date box and a button at rest — the blank-on-the-page the owner asked to be rid of. \`CR43\` renders the screen and counts named fields."
edit "src/app/ledger/[ledgerId]/records/RecordsScreen.tsx" \
  '  const [open, setOpen] = useState(false)' \
  '  const [open, setOpen] = useState(true)' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 859
section "The add form forgets the reading it was filled from" \
"The rows form stops posting the reading's id, so rows read from a minute book enter as if typed by hand and nothing stops them being entered twice. \`CR43\` renders the form and reads its hidden fields."
edit "src/app/ledger/[ledgerId]/records/add/[table]/RowsForm.tsx" \
  '      {reading && <input type="hidden" name={F.readingId} value={reading} />}' \
  "      {false && <input type=\"hidden\" name={F.readingId} value={reading ?? ''} />}" || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 860
section "A reading offers only the table the model named" \
"The card keeps just the table \`suggests\` points at. A minute book read as a minute book then offers the minute book, and the directors and shares it read have no door. \`BR32\` renders a reading with rows for two tables."
edit src/components/ReadBill.tsx \
  '  const tables = p ? rowCounts(p.rows) : []' \
  '  const tables = p ? rowCounts(p.rows).filter(([t]) => t === p.suggests) : []' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 861
section "A reading whose rows are in the record offers Discard" \
"The card offers Discard whatever the reading has become. 0080 refuses the delete, so pressing it only produces a refusal. \`BR32\` renders a reading already entered into one table."
edit src/components/ReadBill.tsx \
  '            {!kept && (' \
  '            {true && (' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 862
section "Every hour row opens with its boxes showing" \
"The Time table renders every row in its edit form, which is the page of blanks the owner called 凌乱. \`S38\` renders the table at rest and counts named fields."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  '          if (editing !== t.id) {' \
  '          if (false) {' || exit 1
run npm run db:verify-sred
close; restore


# ---------------------------------------------------------------- 863
section "The rate table opens on its first row's boxes" \
"The rates start with a row open. \`S38\` renders them at rest."
edit "src/app/ledger/[ledgerId]/sred/Rates.tsx" \
  '  const [editing, setEditing] = useState<string | null>(initialEditing)' \
  '  const [editing, setEditing] = useState<string | null>(rates[0]?.id ?? null)' || exit 1
run npm run db:verify-sred
close; restore


# ---------------------------------------------------------------- 864
section "Somebody from another company's list is used without a word" \
"The rows door stops saying when a name it matched belongs to a party only another company has. The row still goes in against that party — the owner's call — but silently, which is the one thing the owner said it must not be (2026-09-16: 可以用，但必须写出来). \`CR37\` and \`CR38\` read the sentence."
edit src/lib/record-entry.ts \
  '    if (found.here === 0 && !opts.elsewhere.some((e) => e.name === found.name)) {' \
  '    if (false && found.here === 0 && !opts.elsewhere.some((e) => e.name === found.name)) {' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 865
section "The card counts what was read as what was entered" \
"The reading card prints the model's row count beside Entered, not the count the door stored. A person who took a row out before pressing Enter is told every row went in. \`BR32\` marks 1 entered of 2 read."
edit src/components/ReadBill.tsx \
  '                        Entered: {r.recordsEntered[table]} {r.recordsEntered[table] === 1 ? words.one : words.many} — view' \
  '                        Entered: {count} {count === 1 ? words.one : words.many} — view' || exit 1
run npm run db:verify-bills
close; restore


# ---------------------------------------------------------------- 866
section "The add form stops marking a name from another company" \
"The rows form no longer tells a person, before they press Enter, that a name will be matched to another company's party. The mark is drawn by \`RecordCell\`, which a row's Edit draws too (0083). \`CR43\` renders one of each."
edit "src/app/ledger/[ledgerId]/records/RecordCell.tsx" \
  '  const isElsewhere = named && known.has(key) && !local.has(key)' \
  '  const isElsewhere = false' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 867
section "The year's three answers open as boxes" \
"The claim's three questions, the method and the assistance answer start in their edit form, so the Record tab is three textareas and a checkbox before anybody asked to change anything. \`S38\` renders the claim at rest."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  '  const [editing, setEditing] = useState(false)' \
  '  const [editing, setEditing] = useState(true)' || exit 1
run npm run db:verify-sred
close; restore


# ---------------------------------------------------------------- 868
section "Mark filed opens with its date box showing" \
"The filing card's buttons start revealed, so the working paper carries a date box (or a reason box, once filed) at rest. \`S38\` renders the card drafted and filed."
edit "src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx" \
  '  const [open, setOpen] = useState(false)' \
  '  const [open, setOpen] = useState(true)' || exit 1
run npm run db:verify-sred
close; restore


# ---------------------------------------------------------------- 869
section "A minute-book document is filed against another company's record" \
"\`attachMinuteBookFromForm\` stops asking whose record the id names, so a form under this ledger files paper into another company's minute book. \`AT16\` sends their record's id."
edit src/lib/record-forms.ts \
  "  const nope = await refuseUnlessOurs([['minute_book_entry', minuteId]], ledgerId)" \
  '  const nope = null as { error: string } | null' || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 870
section "The folder rebuild forgets the minute book" \
"\`rebuildAttachmentTree\` wipes every folder but the blobs and relinks only the entries' receipts, so a rebuild — the remedy the screen offers — deletes the Minute book folder and never puts it back. \`AT15\` removes a link and rebuilds."
edit src/lib/attachments.ts \
  '  for (const paper of await modulePapers(company.entity_id)) {' \
  '  for (const paper of (await modulePapers(company.entity_id)).slice(0, 0)) {' || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 871
section "The integrity sweep does not look for the minute book's links" \
"The sweep checks every minute-book document's blob and hash but never asks whether its link is in the folder, so a Minute book folder emptied by hand reads as clean. \`AT15\` removes a link and asks."
edit src/lib/attachments.ts \
  '    if (!(await fs.access(link).then(() => true).catch(() => false))) {' \
  '    if (false) {' || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 872
section "A minute book read from a PDF enters its records without the PDF" \
"The rows door stops filing the reading's document against the records it made. The records are right, and the paper they came from is attached to nothing. \`AT17\` reads a PDF into two records."
edit src/lib/record-forms.ts \
  '  return { ok: enteredSentence(entered) + await fileReadingOnMinuteBook(ledgerId, readingId, entered.minuteIds, actor) }' \
  '  return { ok: enteredSentence(entered) }' || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 873
section "A company backup carries the receipts' blobs and not the minute book's" \
"\`exportCompany\` collects blob hashes from the entries' attachments only. A minute-book document with bytes of its own leaves without its blob row or its file, and the restored record names a document the store does not have. \`BK8\` restores one."
edit src/modules/records/manifest.ts \
  "    blobReferences: [{ order: 1, table: 'minute_book_attachment' }]," \
  '    blobReferences: [],' || exit 1
run npm run db:verify-backup
close; restore


# ---------------------------------------------------------------- 874
section "The minute book's Documents column never shows what is filed" \
"The records screen stops reading the paper filed against each minute-book record, so a filed document has no link at rest and its floating form has nothing to Unfile. \`CR43\` renders a record with one document."
edit "src/app/ledger/[ledgerId]/records/RecordsScreen.tsx" \
  '              const paper = minutePaper[m.id] ?? []' \
  '              const paper = [] as Array<{ id: string; filename: string }>' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 875
section "The CRA numbers on the payroll screen stop at federal tax" \
"\`EditionFigures\` renders the first three groups of figures and not British Columbia's, so the BC brackets, constants and tax reduction payroll computes with are nowhere on the screen. \`PR58\` renders an edition and reads every figure cell back."
edit "src/app/ledger/[ledgerId]/payroll/EditionFigures.tsx" \
  '      {EDITION_FIGURES.map((group) => (' \
  '      {EDITION_FIGURES.slice(0, 3).map((group) => (' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 876
section "An edition added in the app is saved and never read back" \
"\`loadEditions\` hands \`rates.ts\` an empty list instead of the rows, so an edition added on the payroll screen is in the database and payroll still refuses its year. \`PR59\` adds 2027 and asks for a March 2027 pay date."
edit src/lib/payroll/editions.ts \
  '  setAddedEditions((await rows()).filter(notBuiltIn).map(fromRow))' \
  '  setAddedEditions([])' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 877
section "An edition PDOC does not confirm is saved anyway" \
"\`addEdition\` computes the PDOC example and ignores the lines that disagree, so tables that add up but are not this year's go in. \`PR60\` sends the federal tax a cent out."
edit src/lib/payroll/editions.ts \
  '  if (off.length > 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 878
section "An edition whose tables do not add up is refused in the engine's words" \
"\`addEdition\` stops asking \`problemsWith\` itself. Nothing wrong is saved even so — computing the PDOC example vets the candidate and throws — but the person at the form is told the tables will not be computed from, and pointed at a design doc, instead of being told nothing was saved. The first version of this block read only whether a refusal came, and stayed green for exactly that reason. \`PR60\` changes a K constant and reads the sentence."
edit src/lib/payroll/editions.ts \
  '  if (wrong.length > 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 879
section "A second edition in a year the app added reads as different CPP and EI" \
"The list rule compares a year's CPP and EI by key order again. Postgres jsonb hands the keys back in its own order, so a July edition typed on top of a January edition added in the app is refused for numbers that are the same. \`PR60\` adds July 2027 with no fault."
edit src/lib/payroll/rates-check.ts \
  '    if (before && sameYear(before, e) && byValue(before.cppEi) !== byValue(e.cppEi)) {' \
  '    if (before && sameYear(before, e) && JSON.stringify(before.cppEi) !== JSON.stringify(e.cppEi)) {' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 880
section "The add form takes a word where a figure goes" \
"\`editionFromFigures\` stops asking whether each figure is a number, so a rate typed as words reaches the checker, and the form answers with the arithmetic's own crash — Cannot convert one point six to a BigInt — instead of naming the figure. Nothing is saved; nothing says which box. \`PR60\` types the EI rate in words."
edit src/lib/payroll/edition-fields.ts \
  '      if (!SHAPE[f.kind].test(value)) problems.push(' \
  '      if (false) problems.push(' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 881
section "A pay-run preview on a fresh server does not know the added editions" \
"\`previewPayRun\` stops reading the editions added in the app, so after a restart the first preview — or run — for a year only a row covers is refused until something else happens to load them. \`PR61\` empties the process's list and previews January 2027."
edit src/lib/payroll/runs.ts \
  '  await loadEditions()' \
  '  await Promise.resolve()' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 882
section "A T4 year on a fresh server does not know the added editions" \
"\`t4Year\` stops reading the editions added in the app, so after a restart the slips for a year only a row covers are refused for want of its CPP and EI ceilings. \`PR61\` empties the process's list and asks for 2027."
edit src/lib/payroll/t4.ts \
  '  await loadEditions()' \
  '  await Promise.resolve()' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 883
section "The SR&ED working paper on a fresh server does not know the added editions" \
"\`workingPaper\` stops reading the editions added in the app, so after a restart a claim for a year only a row covers is refused for want of a YMPE. \`S39\` adds the next year's edition, empties the process's list and opens that claim's paper."
edit src/lib/sred.ts \
  '  await loadEditions()' \
  '  await Promise.resolve()' || exit 1
run npm run db:verify-sred
close; restore


# ---------------------------------------------------------------- 884
section "An edition a pay stub was computed with can be removed" \
"\`removeEdition\` stops asking whether any stub names the edition, so the figures a posted payday was worked out from can be deleted from under it. \`PR62\` files a stub under 2027-01 and removes 2027-01."
edit src/lib/payroll/editions.ts \
  '  if (used && used.n > 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 885
section "Removing a built-in edition is answered as if it did not exist" \
"\`removeEdition\` stops recognising the editions built into the code, so Remove on one is answered as if it were an added edition — by the stubs that used it, or, for one no stub has used yet, by the DELETE finding no row — and never by why it stays. \`PR62\` removes 2026-07."
edit src/lib/payroll/editions.ts \
  '  if (EDITIONS.some((e) => e.id === id)) {' \
  '  if (false) {' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 886
section "The payroll screen lists an added edition as built in" \
"\`editionRecords\` drops who added an edition and the PDOC case it was proved against, so the screen shows it as built into the app, with no Remove and no record of what vouched for it. \`PR59\` reads the list after adding 2027-01."
edit src/lib/payroll/editions.ts \
  '    ...added.map((r) => ({ edition: fromRow(r), added: { at: r.created_at, by: r.created_by, pdoc: r.pdoc } })),' \
  '    ...added.map((r) => ({ edition: fromRow(r), added: null })),' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 887
section "A corrected minute-book record leaves no trace of what it said" \
"The correction trigger on \`minute_book_entry\` watches removals only, so a title put right writes nothing to the audit log and what the minute book used to say is gone. The first version of this block moved the trigger to inserts, which broke every insert and turned the suite red by crashing it before \`CR44\` ran (independent critic, 2026-09-16). \`CR44\` corrects a title, then reads the trail."
edit db/migrations/0083_a_record_entered_wrong_can_be_put_right.sql \
  '  AFTER UPDATE OR DELETE ON minute_book_entry' \
  '  AFTER DELETE ON minute_book_entry' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 888
section "Moving an office address earlier collides with the one before it" \
"The edit moves the row's start before shortening the previous address, so for one statement the office has two addresses on the same days and the database refuses a correction that is right. \`CR45\` moves the second address a year earlier."
edit src/lib/record-edit.ts \
  '  if (previousEnds && from < row.effective_from) await tx.execute(previousEnds)' \
  '  if (false) await tx.execute(previousEnds)' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 889
section "Deleting an office address leaves the office with none" \
"The delete stops giving the removed address's days back to the one before it, so deleting the current registered office leaves the company with no current registered office at all. \`CR45\` deletes the second address and reads the chain."
edit src/lib/record-edit.ts \
  '          UPDATE corporate_office SET effective_to = ${row.effective_to}::date' \
  '          UPDATE corporate_office SET effective_to = effective_to' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 890
section "An address moved before the one it followed is refused in the database's words" \
"The edit stops saying that the address before began first, and leaves it to a CHECK constraint, so a person who typed the wrong year reads a constraint name instead of the date to beat. \`CR45\` moves the second address before the first began."
edit src/lib/record-edit.ts \
  '  if (prev && from <= prev.effective_from) {' \
  '  if (false) {' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 891
section "A term moved to another person keeps the first person's address" \
"When a director's row is corrected to a different person and the address box is left blank, the row keeps the frozen address of the person it named before, so the register prints one person at another's address. \`CR46\` moves a term to a new name with no address."
edit src/lib/record-edit.ts \
  '  let address = blank(v.address) ?? (partyId === row.party_id ? row.prescribed_delivery : null)' \
  '  let address = blank(v.address) ?? row.prescribed_delivery' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 892
section "Correcting a significant individual erases their birth date" \
"The screen never sends the birth date, so its box arrives blank; the edit writes the blank, and every correction of how somebody controls the company wipes a field the transparency register must keep. \`CR47\` corrects a row with the private boxes left blank."
edit src/lib/record-edit.ts \
  '           birth_date = COALESCE(${blank(v.birthDate)}::date, birth_date),' \
  '           birth_date = ${blank(v.birthDate)}::date,' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 893
section "A correction's trail carries what the register calls private" \
"The correction trigger stops taking the private fields out of the row as it was, so every change to a significant individual copies their birth date and address into an audit log nothing filters. The body is 0085's: it re-issued the function, and a mutation of 0083's copy is shadowed. \`CR47\` reads every trail row for the fields."
edit db/migrations/0085_the_trail_strips_only_its_own_register.sql \
  '    was := was - f.field;' \
  '    was := was;' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 894
section "The securities register cannot be put right even by its own Edit" \
"The append-only trigger stops reading the flag its doors set, so the owner's answer — editable and deletable, keeping what it said — is refused at the database for every movement. \`CR48\` corrects an issue and a transfer."
edit db/migrations/0083_a_record_entered_wrong_can_be_put_right.sql \
  "  IF COALESCE(current_setting('erp.register_edit', true), '') = 'on' THEN" \
  '  IF false THEN' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 895
section "A corrected share count may leave a holder negative" \
"The never-negative trigger judges inserts only, as it did before 0083, so an issue corrected down to fewer shares than its holder later transferred goes in, and the register shows a holder at minus ten. \`CR48\` corrects the issue to 30 under a transfer of 40."
edit db/migrations/0083_a_record_entered_wrong_can_be_put_right.sql \
  'CREATE CONSTRAINT TRIGGER trg_holding_never_negative
  AFTER INSERT OR UPDATE OR DELETE ON share_transaction' \
  'CREATE CONSTRAINT TRIGGER trg_holding_never_negative
  AFTER INSERT ON share_transaction' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 896
section "An issue can be deleted from under the transfer that rests on it" \
"The never-negative check reads only the row as it is, and a deleted row has none, so removing an issue checks nobody and the holder who later transferred those shares is left negative. \`CR48\` deletes the issue before the transfer."
edit db/migrations/0083_a_record_entered_wrong_can_be_put_right.sql \
  "      (CASE WHEN TG_OP <> 'INSERT' THEN OLD.share_class_id END, CASE WHEN TG_OP <> 'INSERT' THEN OLD.party_id END)" \
  '      (NULL::uuid, NULL::uuid)' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 897
section "Deleting a transfer takes only one side of it" \
"The delete removes the row it was given and not its pair, so a transfer's receiving side goes and its giving side stays, and the group no longer nets to zero. \`CR48\` deletes the transfer by the row the screen names."
edit src/lib/record-edit.ts \
  '                  OR t.transfer_group = (SELECT transfer_group FROM share_transaction WHERE id = ${id}::uuid))' \
  '                  OR false)' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 898
section "A transfer can be saved as if it were an issue" \
"The edit stops asking whether the boxes' kind is the row's, so a transfer's row is rewritten by the issue path and the refusal, when the database gives one, says nothing about why. \`CR48\` sends an issue's boxes for a transfer."
edit src/lib/record-edit.ts \
  '  if (v.kind !== kind) {' \
  '  if (false) {' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 899
section "Deleting a class in use is refused in the database's words" \
"The class delete stops counting the class's movements, so a person asking to delete a class the register uses reads a foreign-key message instead of how many movements are in it and what to do. \`CR49\` deletes a class with one movement."
edit src/lib/record-edit.ts \
  '    if (c.movements > 0) {' \
  '    if (false) {' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 900
section "An Edit naming another company's row is not asked whose it is" \
"The row forms stop asking whether the id is this company's before the door runs, and a crafted form is answered as though the row simply did not exist rather than refused as another company's. \`CR50\` names Records Ltd.'s director under Fixes Ltd."
edit src/lib/record-forms.ts \
  '  const nope = await refuseUnlessOurs([[OWNED[table], id]], ledgerId)' \
  '  const nope = null as { error: string } | null' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 901
section "No register row offers Edit" \
"The records screen decides it was not handed the edit doors, so every row is read-only again and the minute book cannot be corrected or deleted — the complaint that started 0083. \`CR51\` counts the Edit buttons at rest."
edit "src/app/ledger/[ledgerId]/records/RecordsScreen.tsx" \
  '  const canEdit = Boolean(actions.correct && actions.remove && choices)' \
  '  const canEdit = false' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 902
section "A significant individual's blank private boxes do not say they keep" \
"The row editor stops saying that a blank birth date or address keeps what is on file, so a person looking at empty boxes believes the register holds nothing there, or that saving will erase it. \`CR51\` opens a significant individual."
edit "src/app/ledger/[ledgerId]/records/RowEditor.tsx" \
  '    return blankMeansKeep.includes(c.key)' \
  '    return false' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 903
section "A minute-book record corrected leaves its documents under the old name" \
"The edit stops refiling the record's links, so the Finder tree keeps the document under the typo'd title and the new title has nothing — and the integrity sweep reports the new link missing. \`AT18\` corrects a title and looks for both links."
edit src/lib/record-edit.ts \
  '    await refileMinuteBookLinks(ledgerId, links)' \
  '    void links' || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 904
section "A minute-book record deleted leaves its documents in the folder" \
"The delete stops removing the record's links, so the Minute book folder keeps a document filed under a record that no longer exists. \`AT18\` deletes the record and looks for the link."
edit src/lib/record-edit.ts \
  '    await unlinkMinuteBookLinks(links)' \
  '    void links' || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 905
section "A company holding share movements cannot be removed" \
"Removing a company stops opening the securities register, so the append-only trigger refuses the delete of its movements and a company that was a mistake cannot be removed once anybody was issued a share. \`CO12\` removes one."
edit src/modules/records/company.ts \
  'export async function beforeCompanyDelete(tx: Tx) { await tx.execute(OPEN_THE_REGISTER) }' \
  'export async function beforeCompanyDelete(tx: Tx) { void tx; void OPEN_THE_REGISTER }' || exit 1
run npm run db:verify-setup
close; restore


# ---------------------------------------------------------------- 906
section "A registration corrected into another's dates is refused in words nobody can act on" \
"\`correctRegistration\` stops looking for the registration its new dates would run into, so the database refuses at its EXCLUDE constraint and the person is told another registration changed at the same moment — not which one, or its dates. \`R64\` moves a start into the earlier registration."
edit src/lib/registrations.ts \
  "       AND daterange(registered_on, COALESCE(ceased_on, 'infinity'::date), '[]')" \
  "       AND false AND daterange(registered_on, COALESCE(ceased_on, 'infinity'::date), '[]')" || exit 1
run npm run db:verify-registrations
close; restore


# ---------------------------------------------------------------- 907
section "A registration's corrected number leaves no trace of the old one" \
"The registration audit trigger stops writing a row when the number or the start date changes, so a number corrected — the one printed on every invoice — is replaced with nothing to say what it was. \`R64\` corrects WRONG1 and reads the trail."
edit db/migrations/0084_the_rest_can_be_put_right_too.sql \
  '  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.registered_on IS DISTINCT FROM OLD.registered_on THEN' \
  '  IF false THEN' || exit 1
run npm run db:verify-registrations
close; restore


# ---------------------------------------------------------------- 908
section "A deleted registration leaves no trace" \
"The registration audit trigger fires on inserts and updates only, as before 0084, so a registration deleted is gone with no row saying it existed, what its number was, or who removed it. \`R64\` deletes one and reads the trail."
edit db/migrations/0084_the_rest_can_be_put_right_too.sql \
  '  AFTER INSERT OR UPDATE OR DELETE ON entity_tax_registration' \
  '  AFTER INSERT OR UPDATE ON entity_tax_registration' || exit 1
run npm run db:verify-registrations
close; restore


# ---------------------------------------------------------------- 909
section "An account in use is refused a delete in the database's words" \
"\`deleteAccount\` stops counting what holds the account, so a posted-to account is refused by 0008's trigger and a parent by a foreign key — neither saying what holds it, and only one saying to deactivate. \`A47\` deletes the cash account and a parent."
edit src/lib/accounts.ts \
  '  if (uses.length > 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-accounts
close; restore


# ---------------------------------------------------------------- 910
section "Reactivating an account leaves it inactive" \
"\`setAccountActive\` writes inactive whichever way it was asked, so an account retired by mistake cannot be brought back, and the button says it was. \`A47\` deactivates and reactivates cash."
edit src/lib/accounts.ts \
  '    .set({ isActive: active, updatedAt: new Date() })' \
  '    .set({ isActive: false, updatedAt: new Date() })' || exit 1
run npm run db:verify-accounts
close; restore


# ---------------------------------------------------------------- 911
section "A payroll record somebody was paid from can be deleted" \
"\`deleteEmployee\` stops counting the person's stubs, so deleting Dana runs into the stubs' foreign key and fails as a database error instead of saying the stubs are the year's record and to untick Active. \`PR63\` deletes Dana."
edit src/lib/payroll/employees.ts \
  '  if (held.stubs > 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 912
section "Another company's ledger can name a payroll record for deletion" \
"The employee delete form stops asking whose record the id is, so a form under another company's ledger reaches the door, which refuses it only as not this company's record rather than as not in these books. \`PR63\` sends the delete from the other company."
edit src/lib/payroll/forms.ts \
  "  const nope = await refuseUnlessOurs([['employee', employeeId]], ledgerId)" \
  '  const nope = null as { error: string } | null' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 913
section "A filed SR&ED year's claim can be deleted" \
"\`deleteSredClaim\` stops asking whether the year was filed, so the narratives and allocations of a return that has gone to CRA are deleted with no reason asked and nothing left to show what was claimed. \`S40\` deletes a filed claim."
edit src/lib/sred.ts \
  '    if (claim.filed_on !== null) {' \
  '    if (false) {' || exit 1
run npm run db:verify-sred
close; restore


# ---------------------------------------------------------------- 914
section "Deleting a matched bank row says only half of what to do" \
"\`deleteBankRow\` stops saying the row settles an entry, and the database's refusal reaches the person as a bare instruction to undo a match with no word of why the row cannot go. \`M79\` deletes a matched row."
edit src/lib/bank.ts \
  "    if (row?.matched) throw new BankError('ROW_MATCHED', 'That row settles an entry. Undo the match first.')" \
  '    void row' || exit 1
run npm run db:verify-bank-match
close; restore


# ---------------------------------------------------------------- 915
section "An employee role a payroll record needs can be deleted" \
"\`deleteRole\` stops asking whether the person is on the payroll, so their only employee role goes while the payroll record stays — a record the database says must belong to an employee, left with none. \`P56\` deletes Wren's role."
edit src/lib/parties.ts \
  "  if (held.role === 'employee' && held.on_payroll) {" \
  '  if (false) {' || exit 1
run npm run db:verify-parties
close; restore


# ---------------------------------------------------------------- 916
section "A fiscal year in the middle can be deleted" \
"\`deleteFiscalYear\` stops asking whether the year sits at either end, so deleting the middle of three leaves twelve months nothing can ever be posted to — the gap \`createFiscalYear\` refuses to make. \`CO13\` deletes the middle year."
edit src/lib/setup.ts \
  '  if (!y.is_edge) {' \
  '  if (false) {' || exit 1
run npm run db:verify-setup
close; restore


# ---------------------------------------------------------------- 917
section "A fiscal year holding an entry is refused only by a foreign key" \
"\`deleteFiscalYear\` stops counting the entries dated in the year, so a year with posted books reaches the DELETE and is stopped by the entries' foreign key, in the database's words, with no count and no reason. \`CO13\` deletes the last year, which holds one entry."
edit src/lib/setup.ts \
  '  if (y.entries > 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-setup
close; restore


# ---------------------------------------------------------------- 918
section "An owner can rename the superadmin" \
"\`setUserIdentity\` stops asking the ladder, so an owner changes the name and the sign-in email of the one account that administers everything. \`US37\` has an owner rename the superadmin."
edit src/lib/users.ts \
  '  const target = input.userId === input.actor.id ? input.actor : await assertMayManage(input.actor, input.userId)' \
  '  const target = (await userById(input.userId))!' || exit 1
run npm run db:verify-users
close; restore


# ---------------------------------------------------------------- 919
section "A company renamed leaves its papers under the old name" \
"\`renameCompany\` changes the name and does not move the folder, and the store finds a company's blobs by its name — so every receipt and minute-book document of the renamed company stops opening. \`AT19\` renames Minute Paper Ltd. and opens a document."
edit src/lib/companies.ts \
  '    await fs.rename(oldDir, newDir)' \
  '    void newDir' || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 920
section "Two companies can be given one name, and share a folder of papers" \
"\`renameCompany\` stops asking whether another company is already called that, so two companies' blobs and Finder trees land in one folder. \`AT19\` renames Minute Paper Ltd. to Paper Trail Ltd."
edit src/lib/companies.ts \
  '  if (clash) {' \
  '  if (false) {' || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 921
section "A company whose folder another company shares can be renamed" \
"\`renameCompany\` stops asking whether another company already keeps its papers in the folder being moved, so renaming a restored copy that kept its original's name moves the original's blobs, tree and minute book with it, and the original's receipts stop opening. \`AT19\` gives two companies one folder and renames one."
edit src/lib/companies.ts \
  '  if (sharing) {' \
  '  if (false) {' || exit 1
run npm run db:verify-attachments
close; restore


# ---------------------------------------------------------------- 922
section "A new company can be given the name of one already here" \
"\`createCompany\` stops asking whose folder of papers the name lands in, so two companies share one folder from their first receipt. \`CO14\` creates a second Twin Name Ltd."
edit src/lib/setup.ts \
  '  if (sharing) {' \
  '  if (false) {' || exit 1
run npm run db:verify-setup
close; restore


# ---------------------------------------------------------------- 923
section "A restored copy keeps its original's name, and its folder" \
"\`restoreCompany\` stops asking whose folder the name lands in, so a backup restored beside the company it came from writes into that company's folder, and rebuilding either wipes the other's tree. \`BK9\` restores with the name left as it was."
edit src/lib/backup.ts \
  '  if (sharing) {' \
  '  if (false) {' || exit 1
run npm run db:verify-backup
close; restore


# ---------------------------------------------------------------- 924
section "A director's end date is stripped from the trail" \
"The directors register is mapped to the transparency register's private fields, so \`ceased_on\` — public for directors — is taken out of every change row, and a cease or a corrected end date writes a row that says nothing changed. \`CR46\` reads the end date on both sides."
edit db/migrations/0085_the_trail_strips_only_its_own_register.sql \
  "    WHEN 'directorship'           THEN 'directors'" \
  "    WHEN 'directorship'           THEN 'transparency'" || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 925
section "A share class renamed leaves no name in the trail" \
"Share classes are mapped to the securities register, whose \`name\` is private, so a class rename writes a change row with no name before or after. \`CR49\` reads the old and new names in the trail."
edit db/migrations/0085_the_trail_strips_only_its_own_register.sql \
  "    WHEN 'share_transaction'      THEN 'central_securities'" \
  "    WHEN 'share_transaction'      THEN 'central_securities'
    WHEN 'share_class'            THEN 'central_securities'" || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 926
section "Removing a January edition from under a July leaves payroll unusable" \
"\`removeEdition\` stops asking whether the editions left are still a list, so removing an added January under an added July leaves a year that starts in July, and every pay run, T4 and SR&ED paper of every company refuses the whole list with no way to add the January back. \`PR62\` tries it."
edit src/lib/payroll/editions.ts \
  '  if (broken.length > 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 927
section "A party role deleted leaves no trace" \
"The role audit trigger watches inserts and changes only, as before 0085, so a role given by mistake and deleted leaves no row saying it existed or who removed it. \`P56\` deletes a role and reads the trail."
edit db/migrations/0085_the_trail_strips_only_its_own_register.sql \
  '  AFTER INSERT OR UPDATE OR DELETE ON party_role' \
  '  AFTER INSERT OR UPDATE ON party_role' || exit 1
run npm run db:verify-parties
close; restore


# ---------------------------------------------------------------- 928
section "A registration with tax posted under it can be deleted" \
"\`deleteRegistration\` stops asking what rests on the registration's days, so deleting it makes posted GST read as charged outside any registration and changes the number every document dated then prints. \`R64\` posts a sale under a registration and deletes it."
edit src/lib/registrations.ts \
  '    if (resting.lines + resting.invoices > 0) {' \
  '    if (false) {' || exit 1
run npm run db:verify-registrations
close; restore


# ---------------------------------------------------------------- 929
section "A registration's dates moved past posted tax say nothing about it" \
"\`correctRegistration\` stops working out what its new dates leave outside any registration, so moving a start past a posted sale is saved in silence: the return will list that tax as outside the registration, and nobody was told. (Refusing was the first answer; tax after a real change of dates is what the return exists to report, so every date door now saves and says — independent critic, 2026-09-16.) \`R64\` moves the start past the sale."
edit src/lib/registrations.ts \
  '  const outsideNewDates = await outsideOf(row, input.registrationId, { from: input.registeredOn, to: ceasedOn })' \
  "  const outsideNewDates = ''" || exit 1
run npm run db:verify-registrations
close; restore


# ---------------------------------------------------------------- 930
section "A register row corrected is written to the trail under the database role" \
"The record edit doors stop saying who is acting, so every change and removal row the 0083 triggers write names the database role instead of the person. \`CR52\` reads every audit row the records suite wrote."
edit src/lib/record-edit.ts \
  '      await acting(tx, actor)' \
  '      void actor' || exit 1
run npm run db:verify-records
close; restore


# ---------------------------------------------------------------- 931
section "A registration ended before posted tax says nothing about it" \
"\`ceaseTax\` stops working out what the end leaves outside, so ending a registration — or correcting its end, or clearing it through Edit and ending it again — before a posted sale is saved in silence, and the End door says less than the Edit door. \`R64\` ends it before the sale three ways."
edit src/lib/registrations.ts \
  '  const outsideAfterEnd = await outsideOf(row, registrationId, { from: row.registered_on, to: ceasedOn })' \
  "  const outsideAfterEnd = ''" || exit 1
run npm run db:verify-registrations
close; restore


# ---------------------------------------------------------------- 932
section "A registration holding only a zero-rated invoice can be deleted" \
"\`restingOn\` stops counting posted invoices, so a registration whose only use is an invoice with no tax line — which still prints its number — is deleted and every reprint of that invoice loses the number. \`R64\` posts a zero-rated invoice and deletes the registration."
edit src/lib/registrations.ts \
  '      (SELECT count(*)::int FROM invoice i' \
  '      (SELECT 0 * count(*)::int FROM invoice i' || exit 1
run npm run db:verify-registrations
close; restore


# ---------------------------------------------------------------- 933
section "An added copy of a built-in edition puts two of one edition on the list" \
"\`loadEditions\` stops leaving out rows a release has since built in, so the list carries two editions of one id and every pay run, T4 and SR&ED paper of every company is refused. \`PR64\` files a copy of 2026-07 and computes an August pay date."
edit src/lib/payroll/editions.ts \
  'const notBuiltIn = (r: Row) => !EDITIONS.some((e) => e.id === r.id)' \
  "const notBuiltIn = (r: Row) => r.id !== ''" || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 934
section "An added copy of a built-in edition cannot be removed" \
"\`removeEdition\` answers every built-in id as built in without looking for a copy in the database, so a row added before a release shipped the same edition stays for good. \`PR64\` removes the copy."
edit src/lib/payroll/editions.ts \
  '    await db.execute(removeCopy(id))' \
  '    void removeCopy' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 935
section "A supplier's bill holds a registration it never printed" \
"\`restingOn\` counts purchase bills with sales invoices, so a registration whose only use is a supplier's bill — which carries the supplier's number, not ours — cannot be deleted, and the owner's Acme registration with three posted bills would be held by them. \`R64\` posts a bill and deletes the registration."
edit src/lib/registrations.ts \
  'const billsHoldRegistrations = false' \
  'const billsHoldRegistrations = true' || exit 1
run npm run db:verify-registrations
close; restore


# ---------------------------------------------------------------- 936
section "An added copy is removed while stubs rest on its different figures" \
"\`removeEdition\` stops asking whether pay was run under a copy whose figures differ from the release's, so removing it destroys the only record of what those stubs were worked out from. \`PR64\` removes a differing copy with fifteen stubs naming its id."
edit src/lib/payroll/editions.ts \
  '    if (stubs.n > 0 && !same) {' \
  '    if (false) {' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 937
section "The added copy's Remove names no edition" \
"\`EditionCopy\` posts an empty edition id, so the payroll screen shows the copy and a Remove that removes nothing. \`PR64\` renders the note and reads the form."
edit "src/app/ledger/[ledgerId]/payroll/EditionCopy.tsx" \
  '        <input type="hidden" name={EDITION_HEAD.editionId} value={editionId} />' \
  '        <input type="hidden" name={EDITION_HEAD.editionId} value="" />' || exit 1
run npm run db:verify-payroll
close; restore


# ---------------------------------------------------------------- 938
section "The gate is shown the path before the router decodes it" \
"The proxy forwards \`nextUrl.pathname\` as it arrived. \`/ledger/%36…/backup/file\` names no ledger to the gate, while the router hands the page the decoded id — the whole company, payroll included, to anybody signed in who knows its id (security review, 2026-10-20). \`US38\` asks the proxy what it forwards."
edit src/proxy.ts \
  '  headers.set(PATH_HEADER, routed + request.nextUrl.search)' \
  '  headers.set(PATH_HEADER, pathname + request.nextUrl.search)' || exit 1
run npm run db:verify-users
close; restore


# ---------------------------------------------------------------- 939
section "A ledger path the gate cannot read is admitted as no ledger at all" \
"\`refuseFor\` answers a \`/ledger/\` path with no readable id the way it answers \`/companies\`: not a ledger question, so yes. That was the second half of the escaped-id leak, and it is what stands if the proxy ever forwards a path the router reads differently. \`US38\` hands the gate the raw escaped path."
edit src/lib/access.ts \
  "    if (!pathname.startsWith('/ledger/')) return null" \
  '    return null' || exit 1
run npm run db:verify-users
close; restore


# ---------------------------------------------------------------- 940
section "A backup names its own columns" \
"The restore stops checking a row's keys against the columns that exist. The keys become the column list of an INSERT run with every trigger off, and the checksum is a SHA-256 anybody can recompute, so the file decides what SQL that is (security review, 2026-10-20). \`BK11c\` hands it a key with a statement in it."
edit src/lib/backup.ts \
  '  if (unknown.length > 0) {' \
  '  if (false) {' || exit 1
run npm run db:verify-backup
close; restore


# ---------------------------------------------------------------- 941
section "A restore loads books that do not balance" \
"The restore stops asking the loaded ledger what its triggers would have refused. An entry out of balance, or a balance cache that disagrees with the lines under it, goes in exactly as the file says, and every report reads the cache. \`BK11d\` nudges one line and one cached balance by a dollar."
edit src/lib/backup.ts \
  '      if (problems.length > 0) {' \
  '      if (false) {' || exit 1
run npm run db:verify-backup
close; restore


# ---------------------------------------------------------------- 942
section "Any owner restores with the triggers off" \
"The restore action goes back to asking only for an owner. The screen, RISKS §1 and the check's own name say the superadmin, and the load it starts runs with every trigger off. \`N48\` reads the action and the page."
edit src/app/actions.ts \
  "  if (me.kind !== 'superadmin') return { error:" \
  '  if (false) return { error:' || exit 1
run npm run db:verify-shell
close; restore


# ---------------------------------------------------------------- 943
section "A ledger file starts importing payroll" \
"One import, from the period code into the payroll module. Nothing breaks and every suite stays green — which is how the base bundle came to know thirteen add-ons. \`MV2\` reads every import in the tree against the record of the crossings that already exist (docs/design/48-module-boundaries.md)."
edit src/lib/periods.ts \
  "import { db } from '@/db/client'" \
  "import { db } from '@/db/client'
import './payroll/runs'" || exit 1
run npm run db:verify-modules
close; restore


# ---------------------------------------------------------------- 944
section "The record of crossings forgets one" \
"The cheque-to-pay-stub foreign key drops out of the baseline while the constraint stays. If the record could shrink without the schema changing, it would stop being a record of the schema. \`MV3\` finds the constraint the record no longer lists."
edit scripts/module-baseline.json \
  '    "cheque -> pay_stub",' \
  '' || exit 1
run npm run db:verify-modules
close; restore


# ---------------------------------------------------------------- 945
section "A table belongs to no module" \
"The rule that gives \`mcp_credential\` to MCP stops matching it. A table nobody owns is one no manifest will install, back up or remove. \`MV1\` asks every table in the migrated schema for its owner."
edit scripts/module-map.ts \
  'mcp_.+' \
  'mcp_never' || exit 1
run npm run db:verify-modules
close; restore


# ---------------------------------------------------------------- 946
section "The register forgets SR&ED's projects" \
"\`sred_project\` drops out of \`audit_scope_source\`. Nothing refuses: an SR&ED project's trail rows just stop finding their company and sit as unresolved, outside every company's audit screen and backup. \`S41\` compares the register with the mapping 0086 wrote and writes a row with no company."
edit db/migrations/0155_audit_scope_sources.sql \
  "  ('sred_project',           'entity_id', false)," \
  '' || exit 1
run npm run db:verify-sred
close; restore


# ---------------------------------------------------------------- 947
section "The trail stops asking the register for a company" \
"The trigger keeps its own lines and no longer reads \`audit_scope_source\` for an entity column, so every add-on table's row is unresolved while the register is intact. \`S41\` writes an SR&ED project row with no company."
edit db/migrations/0155_audit_scope_sources.sql \
  "                   WHERE table_name = NEW.table_name AND scope_column = 'entity_id') THEN" \
  "                   WHERE table_name = NEW.table_name AND scope_column = 'none') THEN" || exit 1
run npm run db:verify-sred
close; restore


# ---------------------------------------------------------------- 948
section "The chart of accounts learns SR&ED again" \
"The account door goes back to reading an SR&ED tag. It reads into nothing — the column it would write is frozen — so every form still saves and every suite about accounts stays green, and the framework knows an add-on once more. \`S42\` reads every base file for the tag's name."
edit src/lib/master-forms.ts \
  "parentCode:f.has('parentCode')?get(f,'parentCode'):undefined},actor,ledgerId,tx)" \
  "parentCode:f.has('parentCode')?get(f,'parentCode'):undefined,...({sredCategory:get(f,'sredCategory')}as object)},actor,ledgerId,tx)" || exit 1
run npm run db:verify-sred
close; restore


# ---------------------------------------------------------------- 949
section "An account's T661 line changes off the trail" \
"\`setSredAccountCategory\` stops writing its audit row. The tag still saves and every allocation still reads it; the company's trail simply never says who moved rent into overhead, or when. \`S42\` looks for the row."
edit src/lib/sred.ts \
  "    await auditRow(tx, {
      actor: input.actor, action: 'set_sred_category'," \
  "    void ({
      actor: input.actor, action: 'set_sred_category'," || exit 1
run npm run db:verify-sred
close; restore


# ---- after the blocks ----
#
# The blocks that came after the one `--only` re-ran, put back exactly as they
# were captured, and their suite runs added to the count the guard below reads.
# This sits after the LAST block on purpose: it once sat after block 636, so a
# re-run of any later block appended the kept suffix first and its own capture
# after — block 654 landed behind 662 (2026-09-12).
if [ -s "$SUFFIX" ]; then
  # Joined with exactly one blank line, the spacing every other block has —
  # `printf` before `cat` left two, since the capture already ends with one.
  python3 - "$OUT" "$SUFFIX" <<'JOIN' || exit 1
import sys
out, suffix = sys.argv[1], sys.argv[2]
body = open(out, encoding='utf-8').read().rstrip('\n')
kept = open(suffix, encoding='utf-8').read().strip('\n')
open(out, 'w', encoding='utf-8').write(body + '\n\n' + kept + '\n')
JOIN
  RUNS=$((RUNS + $(grep -cE "$SUITE_LINE" "$SUFFIX" || true)))
fi

cat >> $OUT <<'TAIL'

## Not covered here

- The migration check's own ordering. Its defect was a state one, not a source
  one: it ran the migrator and then asked whether anything was pending. Put the
  test database one migration behind and `db:check-migrations` reports
  `FAIL M1 ... missing 0016_ceased_by.sql` and leaves it behind; the version it
  replaced reported `16 of 16` on the same database.
TAIL

# What the blocks actually span, counted from the blocks. The sentence this
# replaces was typed once and named three subjects; the file grew to cover
# invoices, credit notes, aging, opening balances and periods without it moving.
{
  printf '\n## What the blocks span\n\n'
  printf 'Counted from the `$` lines above, not described.\n\n'
  printf '| suite | times run |\n|---|---|\n'
  grep -E "$SUITE_LINE" $OUT | suite_line_name | sort | uniq -c \
    | sort -rn | awk '{printf "| `%s` | %s |\n", $2, $1}'
  # Suite RUNS, not blocks: a few blocks run more than one suite, so these do
  # not add up to the block count and are not labelled as if they did.
  printf '\n**%s suite runs across all blocks.** `npm run db:toothless` counts the\n' \
    "$(grep -cE "$SUITE_LINE" $OUT)"
  printf 'blocks themselves and says how many turned nothing red.\n'
} >> $OUT

# Every line this run wrote must read back through the SHARED pattern — the one
# `suites.sh` parses with, not a local spelling of it. Counting with a private
# regex could only ever catch this file disagreeing with itself; the drift that
# actually happened was this file disagreeing with the OTHER one, and a check
# that cannot see the failure it names is the thing this repository hunts.
#
# Compared against `$RUNS`, counted as the runs happened. The version before
# this compared two greps of $OUT — `^\$ ` against the shared pattern — and
# since `suite_line` is the only thing that writes either, both were readings of
# one set. Four runs failing to emit a line would have dropped both counts
# together and the guard would have stayed silent, which is precisely the case
# its own message described. A check whose two sides come from one source is
# not a check, and it was sitting inside the guard written to say so.
wrote=$(grep -cE "$SUITE_LINE" $OUT || true)
if [ "$wrote" -ne "$RUNS" ]; then
  echo "SUITE-NAME LINES DO NOT READ BACK: \`run\` was called $RUNS times and" >&2
  echo "      $wrote lines in $OUT match the shared pattern in" >&2
  echo "      scripts/suite-line.sh. Every block ran; the summary is wrong," >&2
  echo "      and scripts/suites.sh will not be able to attribute these ids." >&2
  exit 1
fi

echo
echo "Wrote $OUT"

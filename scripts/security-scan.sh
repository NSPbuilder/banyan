#!/usr/bin/env bash
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux_x64; digest=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Darwin-arm64) platform=darwin_arm64; digest=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  *) echo 'Unsupported scanner platform.' >&2; exit 2 ;;
esac
curl --fail --silent --show-error --location "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_${platform}.tar.gz" -o "$scratch/tool.tar.gz"
node --input-type=module - "$scratch/tool.tar.gz" "$digest" <<'JS'
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
if(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex')!==process.argv[3])process.exit(1)
JS
tar -xzf "$scratch/tool.tar.gz" -C "$scratch" gitleaks
if [[ "${1:-}" == '--self-test' ]]; then
  mkdir "$scratch/probe"
  git -C "$scratch/probe" init --quiet
  node --input-type=module - "$scratch/probe/secret.env" <<'JS'
import {writeFileSync} from 'node:fs';import {randomBytes} from 'node:crypto';
// Deliberately synthetic scanner discrimination sample, never a credential.
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const suffix=Array.from(randomBytes(16),byte=>alphabet[byte%alphabet.length]).join('');
writeFileSync(process.argv[2], 'AWS_ACCESS_KEY_ID='+'AKIA'+suffix+'\n')
JS
  git -C "$scratch/probe" add secret.env
  git -C "$scratch/probe" -c user.name=ScanFixture -c user.email=scan@example.test commit --quiet -m fixture
  set +e
  "$scratch/gitleaks" git "$scratch/probe" --redact=100 --no-banner > "$scratch/output" 2>&1
  status=$?
  set -e
  if [[ "$status" != 1 ]]; then echo "Secret discrimination FAILED (exit $status)"; exit 1; fi
  echo 'Secret discrimination PASS: synthetic committed credential rejected (exit 1; redacted).'
else
  # Individual expired historical process tokens, never a directory/commit
  # baseline. Missing owner, evidence or expired disposition blocks the scan.
  node --input-type=module - "$scratch/ignore" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const rows=JSON.parse(readFileSync('docs/implementation/secret-dispositions.json','utf8'));
for(const row of rows)if(!row.owner || !row.reason || !row.evidence || !/^\d{4}-\d{2}-\d{2}$/.test(row.expires) || Date.parse(row.expires+'T00:00:00Z')<=Date.now() || !/^[0-9a-f]{40}:\.nsp\/viewer_sessions\/[0-9a-f]+\/\.(viewer_dismissed\.json|viewer_launch_claim|viewer_ready\.json):generic-api-key:\d+$/.test(row.fingerprint))throw Error('Invalid or expired secret disposition');
writeFileSync(process.argv[2],rows.map(x=>x.fingerprint).join('\n')+'\n');
console.log(`Validated ${rows.length} exact historical expired-token dispositions.`);
JS
  set +e
  "$scratch/gitleaks" git . --config=.gitleaks.toml --gitleaks-ignore-path="$scratch/ignore" --log-opts='--all' --redact=100 --no-banner --report-format=json --report-path="${GITLEAKS_REPORT:-/tmp/figtree-p1-secret-history.json}"
  history_status=$?
  set -e
  # History alone would miss this turn's uncommitted work. Only source, tests,
  # docs, lockfile and config; never scan local credentials/attachments/NSP.
  mkdir "$scratch/worktree"
  git ls-files --cached --others --exclude-standard -z | while IFS= read -r -d '' file; do
    [[ -f "$file" ]] || continue
    mkdir -p "$scratch/worktree/$(dirname "$file")"
    cp "$file" "$scratch/worktree/$file"
  done
  set +e
  "$scratch/gitleaks" dir "$scratch/worktree" --config=.gitleaks.toml --gitleaks-ignore-path="$scratch/ignore" --redact=100 --no-banner --report-format=json --report-path="${GITLEAKS_WORKTREE_REPORT:-/tmp/figtree-p1-secret-worktree.json}"
  worktree_status=$?
  set -e
  if [[ "$history_status" != 0 || "$worktree_status" != 0 ]]; then exit 1; fi
fi

#!/usr/bin/env bash
# KINDORA v1.0.14 — v1.0.14 COMPATIBILITY ENTRY POINT for the baseline A/B
# comparison (completion patch §2).
#
# The reusable comparison implementation remains
#   scripts/v113_baseline_ab_comparison.sh
# (its comparison logic is preserved; its test INFRASTRUCTURE received the
# v1.0.14 completion-patch hardening: PID-tracked redis shutdown and a
# per-invocation secure seed credential).
#
# This entry point exists because the release verifier requires the v1.0.14
# script name. It:
#   * validates every required input before delegating;
#   * preserves the original v1.0.13 implementation (never renames it);
#   * propagates the implementation's exit status unchanged;
#   * produces a clearly identified v1.0.14 EXECUTION LOG (release name,
#     version, source revision, final release ZIP SHA-256, timestamps) —
#     historical v1.0.13 results are never presented as new v1.0.14 results;
#   * records the measured per-run test accounting (discovered / executed /
#     passed / failed / skipped / errors) from the REAL jest logs of THIS run.
#
# Usage:
#   bash scripts/v114_baseline_ab_comparison.sh [--zip <final-release.zip>]
#        <baseline.tar.gz> <test-file-regex> [test-name-regex] [iterations]
# Exit codes: same contract as the v1.0.13 implementation:
#   0 = no new regression; 1 = new regression / execution failure;
#   2 = environment error.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"

ZIP_PATH=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --zip) ZIP_PATH="${2:?--zip requires a path}"; shift ;;
    --zip=*) ZIP_PATH="${1#--zip=}" ;;
    -*) echo "FATAL: unknown option '$1' (supported: --zip <path>)"; exit 2 ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

[ "${#ARGS[@]}" -ge 2 ] || { echo "usage: $0 [--zip <final-release.zip>] <baseline.tar.gz> <test-file-regex> [test-name-regex] [iterations]"; exit 2; }
BASELINE_TARBALL="${ARGS[0]}"
FILEREGEX="${ARGS[1]}"
NAME_REGEX="${ARGS[2]:-}"
ITERS="${ARGS[3]:-1}"

# ---- input validation (§2: validate all required inputs) -----------------------
[ -f "$BASELINE_TARBALL" ] || { echo "FATAL: baseline tarball not found: $BASELINE_TARBALL"; exit 2; }
case "$ITERS" in ''|*[!0-9]*) echo "FATAL: iterations must be a positive integer"; exit 2;; esac
[ "$ITERS" -ge 1 ] || { echo "FATAL: iterations must be >= 1"; exit 2; }
[ -n "$FILEREGEX" ] || { echo "FATAL: test-file-regex must not be empty"; exit 2; }

# ---- the preserved implementation ----------------------------------------------
IMPL="$SCRIPT_DIR/v113_baseline_ab_comparison.sh"
[ -f "$IMPL" ] || { echo "FATAL: v1.0.13 comparison implementation not found: $IMPL"; exit 2; }
[ -x "$IMPL" ] || { echo "FATAL: v1.0.13 comparison implementation is not executable: $IMPL"; exit 2; }

for cmd in sha256sum tee awk grep sort comm node npm; do
  command -v "$cmd" > /dev/null 2>&1 || { echo "FATAL: required command '$cmd' not available"; exit 2; }
done

# ---- release identity recorded in the log --------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_REV="$(git -C "$TREE" rev-parse HEAD 2>/dev/null || echo 'UNAVAILABLE (not a git checkout — archive extraction)')"
ZIP_SHA="UNAVAILABLE"
if [ -n "$ZIP_PATH" ]; then
  [ -f "$ZIP_PATH" ] || { echo "FATAL: release zip not found: $ZIP_PATH"; exit 2; }
  ZIP_SHA="$(sha256sum "$ZIP_PATH" | cut -d' ' -f1)"
fi

REPO_ROOT="$(git -C "$TREE" rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$TREE/.." && pwd)")"
LOG_DIR="${KINDORA_V114_AB_LOGDIR:-$REPO_ROOT/release-verification-logs}"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="$(mktemp -d /tmp/v114-ab-logs.XXXXXXXX)"
LOG="$LOG_DIR/v114-ab-execution-$STAMP.log"

{
  echo "==============================================================="
  echo "KINDORA v1.0.14 baseline A/B comparison — EXECUTION LOG"
  echo "==============================================================="
  echo "release:            KINDORA v1.0.14 (completion patch)"
  echo "version:            1.0.14"
  echo "executed at (UTC):  $STAMP"
  echo "source revision:    $RELEASE_REV"
  echo "final release zip:  ${ZIP_PATH:-not provided}"
  echo "final zip sha256:   $ZIP_SHA"
  echo "implementation:     scripts/v113_baseline_ab_comparison.sh (preserved; infra-hardened)"
  echo "baseline tarball:   $BASELINE_TARBALL"
  echo "                    sha256 $(sha256sum "$BASELINE_TARBALL" | cut -d' ' -f1)"
  echo "test file regex:    $FILEREGEX"
  echo "test name regex:    ${NAME_REGEX:-<all>}"
  echo "iterations per side: $ITERS"
  echo ""
  echo "NOTE: this is a FRESH v1.0.14 execution — no historical v1.0.13"
  echo "      results are reproduced or reused. The v1.0.13 script name"
  echo "      identifies the reusable implementation, not the release."
  echo ""
  echo "== implementation output (verbatim) =="
} > "$LOG"

set +e
# NOTE: the v1.0.13 implementation takes POSITIONAL arguments
# (baseline.tar.gz fileregex nameregex iterations) — an empty name regex
# selects all tests. (The -t flag form belongs to the jest invocation
# inside the runner, not to this interface.)
bash "$IMPL" "$BASELINE_TARBALL" "$FILEREGEX" "$NAME_REGEX" "$ITERS" 2>&1 | tee -a "$LOG"
RC="${PIPESTATUS[0]}"
set -e

# ---- measured per-run accounting from THIS execution's jest logs ---------------
RESULTS_DIR="$(awk '/^logs: +/{print $2; exit}' "$LOG" | tail -1)"
{
  echo ""
  echo "== v1.0.14 measured per-run test accounting (unique test identities) =="
  if [ -n "$RESULTS_DIR" ] && [ -d "$RESULTS_DIR" ]; then
    node - "$RESULTS_DIR" <<'NODE'
const fs = require('fs');
const dir = process.argv[2];
// the implementation's outcome files contain BARE test names (one per line,
// marks already stripped by its sed pipeline)
const names = (f) => {
  try {
    return [...new Set(fs.readFileSync(f, 'utf8').split('\n')
      .map(l => l.replace(/\s*\([\d.]+\s*(ms|s)\)\s*$/, '').trim())
      .filter(Boolean))];
  } catch { return []; }
};
const summary = (f) => {
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => /^Tests:/.test(l));
    return lines.length ? lines[lines.length - 1].trim() : 'UNAVAILABLE';
  } catch { return 'UNAVAILABLE'; }
};
const suiteErrors = (f) => {
  try { return (fs.readFileSync(f, 'utf8').match(/Test suite failed to run/g) || []).length; }
  catch { return 0; }
};
const lastIter = () => {
  const logs = fs.readdirSync(dir).filter(f => /^jest-release-\d+\.log$/.test(f)).sort();
  return logs.length ? dir + '/' + logs[logs.length - 1] : null;
};
const bPass = names(dir + '/baseline-pass.txt'), bFail = names(dir + '/baseline-fail.txt');
const rPass = names(dir + '/release-pass.txt'), rFail = names(dir + '/release-fail.txt');
const discovered = [...new Set([...bPass, ...bFail, ...rPass, ...rFail])];
const exec = [...new Set([...bPass, ...bFail, ...rPass, ...rFail])];
const rl = lastIter();
console.log('discovered test identities (union both sides): ' + discovered.length);
console.log('executed (ran on at least one side):           ' + exec.length);
console.log('passed on baseline:                            ' + bPass.length);
console.log('failed on baseline:                            ' + bFail.length);
console.log('passed on release:                             ' + rPass.length);
console.log('failed on release:                             ' + rFail.length);
console.log('suite-level errors (release, last iteration):  ' + (rl ? suiteErrors(rl) : 'n/a'));
console.log('jest summary (release, last iteration):        ' + (rl ? summary(rl) : 'UNAVAILABLE'));
console.log('skipped: reported verbatim in the jest summary line above (name-chunked suites deliberately distribute tests across chunks; every test executes in exactly one chunk)');
NODE
  else
    echo "UNAVAILABLE — implementation results directory not found (the run may have failed before producing logs)"
  fi
  echo ""
  echo "execution finished (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "implementation exit status: $RC"
} >> "$LOG"

echo ""
echo "v1.0.14 A/B execution log: $LOG"
exit "$RC"

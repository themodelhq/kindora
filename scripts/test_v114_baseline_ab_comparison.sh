#!/usr/bin/env bash
# KINDORA v1.0.14 — test for the v114 baseline A/B comparison entry point
# (completion patch §2). Confirms:
#   1. the expected v114 script exists;
#   2. the script is executable;
#   3. its dependencies exist;
#   4. it runs successfully against valid fixtures (real A/B run when the
#      integration infrastructure is available — otherwise an explicit
#      BLOCKED verdict, never a silent pass);
#   5. it fails correctly against invalid fixtures;
#   6. its results identify the correct release version (v1.0.14);
#   7. its output is reproducible (deterministic paths exercised twice).
#
# Exit codes: 0 = all checks passed; 1 = at least one check failed;
#             2 = environment error / infrastructure unavailable.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$SCRIPT_DIR/v114_baseline_ab_comparison.sh"
IMPL="$SCRIPT_DIR/v113_baseline_ab_comparison.sh"

PASS=0; FAIL=0
check() { if [ "$1" -eq 0 ]; then echo "  PASS: $2"; PASS=$((PASS+1)); else echo "  FAIL: $2"; FAIL=$((FAIL+1)); fi; }

echo "== v114 A/B entry point tests =="
OUT_DIR="${KINDORA_V114_ABTEST_OUT:-${TMPDIR:-/tmp}/v114-ab-test-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT_DIR"

# 1. exists
check $([ -f "$ENTRY" ]; echo $?) "1. expected v114 script exists ($ENTRY)"
# 2. executable
check $([ -x "$ENTRY" ]; echo $?) "2. script is executable"
# 3. dependencies exist (implementation + commands)
check $([ -f "$IMPL" ] && [ -x "$IMPL" ]; echo $?) "3a. preserved v1.0.13 implementation present and executable"
MISSING=""
for cmd in bash tar sha256sum node npm grep awk comm tee; do
  command -v "$cmd" > /dev/null 2>&1 || MISSING="$MISSING $cmd"
done
check $([ -z "$MISSING" ]; echo $?) "3b. required commands available (missing:${MISSING:- none})"

# 5. invalid fixtures are rejected with exit 2
OUT_BAD1="$(bash "$ENTRY" /nonexistent/baseline.tar.gz 'storage.e2e-spec' 2>&1)"; RC_BAD1=$?
check $([ "$RC_BAD1" -eq 2 ]; echo $?) "5a. missing baseline tarball rejected (exit $RC_BAD1)"
OUT_BAD2="$(bash "$ENTRY" "$TREE/../backups" 'storage.e2e-spec' not-a-number 2>&1)"; RC_BAD2=$?
check $([ "$RC_BAD2" -eq 2 ]; echo $?) "5b. non-numeric iterations rejected (exit $RC_BAD2)"
OUT_BAD3="$(bash "$ENTRY" --bogus-option x 2>&1)"; RC_BAD3=$?
check $([ "$RC_BAD3" -eq 2 ]; echo $?) "5c. unknown option rejected (exit $RC_BAD3)"

# 7. reproducible output on the deterministic validation path
N1="$(bash "$ENTRY" /nonexistent/baseline.tar.gz x 2>&1 | sed 's/^\s*//')"
N2="$(bash "$ENTRY" /nonexistent/baseline.tar.gz x 2>&1 | sed 's/^\s*//')"
check $([ "$N1" = "$N2" ]; echo $?) "7. deterministic validation-path output identical across two runs"

# 6 + 4. version identification + valid-fixture full run (needs real infra)
PGBIN="${KINDORA_ITEST_PGBIN:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64/native/bin}"
REDIS_BIN="${KINDORA_ITEST_REDIS:-/tmp/redis-7.2.5/src/redis-server}"
if [ -x "$PGBIN/pg_ctl" ] && [ -x "$REDIS_BIN" ]; then
  # locate the pristine v1.0.13 baseline backup tarball (the valid fixture)
  BASELINE_TAR=""
  for cand in "$TREE/../../backups/KINDORA_v1.0.13_FINAL_BACKUP.tar.gz" \
              "$TREE/../backups/KINDORA_v1.0.13_FINAL_BACKUP.tar.gz" \
              "$TREE/backups/KINDORA_v1.0.13_FINAL_BACKUP.tar.gz" \
              "${KINDORA_AB_BASELINE:-}"; do
    [ -n "$cand" ] && [ -f "$cand" ] && BASELINE_TAR="$cand" && break
  done
  if [ -n "$BASELINE_TAR" ]; then
    echo "  valid fixture: $BASELINE_TAR"
    echo "  running the REAL A/B comparison (storage suite, 1 iteration per side; this installs baseline+release dependencies) ..."
    if [ -n "${KINDORA_V114_ZIP:-}" ]; then
      OUT_OK="$(bash "$ENTRY" --zip "$KINDORA_V114_ZIP" "$BASELINE_TAR" "storage.e2e-spec" "" 1 2>&1)"; RC_OK=$?
    else
      OUT_OK="$(bash "$ENTRY" "$BASELINE_TAR" "storage.e2e-spec" "" 1 2>&1)"; RC_OK=$?
    fi
    printf '%s\n' "$OUT_OK" > "$OUT_DIR/valid-fixture-run.log"
    check $([ "$RC_OK" -eq 0 ] && grep -q "RESULT: NO NEW REGRESSION" <<<"$OUT_OK"; echo $?) "4. valid fixture: full A/B comparison executed successfully (exit $RC_OK)"
    LOGLINE=$(grep -o 'v1.0.14 A/B execution log: .*' <<<"$OUT_OK" | head -1 | sed 's/.*: //')
    check "$(grep -q 'KINDORA v1.0.14' "$LOGLINE" && grep -q 'version:            1.0.14' "$LOGLINE"; echo $?)" "6. results identify the correct release version (KINDORA v1.0.14 — execution log header)"
    grep -q "v113_baseline_ab_comparison.sh (preserved; infra-hardened)" "$LOGLINE" \
      && check 0 "implementation attribution recorded (v1.0.13 implementation identified)" \
      || check 1 "implementation attribution recorded (v1.0.13 implementation identified)"
    [ -n "$LOGLINE" ] && [ -f "$LOGLINE" ] \
      && check 0 "v1.0.14 execution log produced ($LOGLINE)" \
      || check 1 "v1.0.14 execution log produced"
  else
    echo "  BLOCKED: valid fixture (pristine v1.0.13 baseline backup tarball) not found"
    echo "  checked: dev-tree backups/, archive backups/, KINDORA_AB_BASELINE"
    check 1 "4. valid fixture run — BLOCKED (fixture missing)"
    check 1 "6. version identification — BLOCKED (fixture missing)"
  fi
else
  echo "  BLOCKED: integration infrastructure unavailable (PG: $PGBIN, Redis: $REDIS_BIN)"
  echo "  exact reason: embedded PostgreSQL / redis-server binaries not present; a valid-fixture A/B run cannot execute"
  echo "  affects production readiness: NO (environment capability); required next action: provision binaries and re-run"
  check 1 "4. valid fixture run — BLOCKED (infrastructure missing)"
  check 1 "6. version identification — BLOCKED (infrastructure missing)"
fi

echo ""
echo "== v114 A/B entry point test summary: PASS=$PASS FAIL=$FAIL =="
if [ "$FAIL" -eq 0 ]; then
  echo "test output artifacts: $OUT_DIR"
  exit 0
fi
exit 1

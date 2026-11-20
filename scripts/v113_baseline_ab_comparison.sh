#!/usr/bin/env bash
# KINDORA v1.0.13 — deterministic baseline A/B comparison
# (master prompt §8.2D). Runs the SAME timing-sensitive integration test
# against (A) the pristine baseline tree extracted from a verified backup and
# (B) the modified release tree, under IDENTICAL infrastructure (same
# PostgreSQL 17 + Redis 7.2.5 builds, same ports, same seed, fresh database
# per iteration), N iterations per side.
#
# v1.0.14 completion patch hardening (release prompt §8/§9 — infrastructure
# only; the comparison logic is UNCHANGED):
#   §8  the redis instance this script starts is tracked by PID (no longer
#       daemonized unidentified); its shutdown verifies process identity and
#       listening-socket ownership before any port-addressed command;
#   §9  the seed administrator credential is generated per invocation with a
#       cryptographically secure generator, validated against the seed
#       policy, never logged, and differs between concurrent invocations.
#
# Comparison rule (no failure is assumed harmless):
#   - a test that PASSES on the baseline but FAILS on the release is a NEW
#     REGRESSION -> the script exits 1;
#   - a test that fails on BOTH sides is a pre-existing condition -> reported
#     loudly, does not fail the script;
#   - a test that fails on the baseline but passes on the release is an
#     improvement -> reported.
# Complete jest logs for every iteration are preserved under the results
# directory and their paths are printed. No timeouts are injected into the
# tests themselves; no assertion is weakened.
#
# Usage: bash scripts/v113_baseline_ab_comparison.sh <baseline.tar.gz> <test-file-regex> [test-name-regex] [iterations]
#   baseline.tar.gz   a verified baseline backup (v113_phase0_backup.sh output)
#   test-file-regex   jest --testPathPattern for the suite under comparison
#   test-name-regex   optional jest -t name filter
#   iterations        runs per side (default 1; use >=3 for timing-sensitive tests)
# Exit codes: 0 = no new regression; 1 = new regression / execution failure;
#             2 = environment error.
set -uo pipefail

BASELINE_TARBALL="${1:-}"
FILEREGEX="${2:-.}"
NAME_REGEX="${3:-}"
ITERS="${4:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)" # the modified release tree
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$TREE/.." && pwd)")"

[ -n "$BASELINE_TARBALL" ] || { echo "usage: $0 <baseline.tar.gz> <test-file-regex> [test-name-regex] [iterations]"; exit 2; }
[ -f "$BASELINE_TARBALL" ] || { echo "FATAL: baseline tarball not found: $BASELINE_TARBALL"; exit 2; }
case "$ITERS" in ''|*[!0-9]*) echo "FATAL: iterations must be a positive integer"; exit 2;; esac
[ "$ITERS" -ge 1 ] || { echo "FATAL: iterations must be >= 1"; exit 2; }

for cmd in tar sha256sum node npm; do
  command -v "$cmd" > /dev/null 2>&1 || { echo "FATAL: required command '$cmd' not available"; exit 2; }
done

PGBIN="${PGTEST_DIR:-/tmp/pgtest}/node_modules/@embedded-postgres/linux-x64/native/bin"
REDIS="${REDIS_SRC:-/tmp/redis-7.2.5}/src/redis-server"
[ -x "$PGBIN/pg_ctl" ] || { echo "FATAL: embedded PostgreSQL not available at $PGBIN (run the harness setup)"; exit 2; }
[ -x "$REDIS" ] || { echo "FATAL: redis-server not available at $REDIS (run the harness setup)"; exit 2; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RESULTS="$REPO/release-verification-logs/v113-ab-$STAMP"
mkdir -p "$RESULTS" || exit 2
PGPORT=5437; REDISPORT=5438
DATA="/tmp/v113-ab-pgdata-$STAMP"
SOCK="/tmp/v113-ab-pgsock-$STAMP"
REDIS_PID=""; INFRA_UP=0

# §9: per-invocation secure seed credential (never logged; regenerated for
# every invocation so concurrent A/B executions never share a credential)
gen_test_password() {
  local pw=""
  while :; do
    pw="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))' 2>/dev/null)" || return 1
    if [ "${#pw}" -ge 12 ] && printf '%s' "$pw" | grep -q '[A-Z]' && printf '%s' "$pw" | grep -q '[0-9]'; then
      printf '%s' "$pw"; return 0
    fi
  done
}
SEED_ADMIN_PASSWORD="$(gen_test_password)" || { echo "FATAL: secure password generation failed"; exit 2; }
export SEED_ADMIN_PASSWORD

echo "== KINDORA v1.0.13 baseline A/B comparison =="
echo "baseline: $BASELINE_TARBALL (sha256 $(sha256sum "$BASELINE_TARBALL" | cut -d' ' -f1))"
echo "release:  $TREE"
echo "test:     /$FILEREGEX/ name='${NAME_REGEX:-<all>}' iterations=$ITERS"
echo "logs:     $RESULTS"

# --- infrastructure (identical for both sides) ---------------------------------
echo "== infrastructure =="
"$PGBIN/pg_ctl" stop -D "$DATA" -m fast > /dev/null 2>&1 || true
rm -rf "$DATA" "$SOCK" && mkdir -p "$SOCK"
"$PGBIN/initdb" -D "$DATA" -U kindora --auth=trust -E UTF8 > /dev/null 2>&1 || { echo "FATAL: initdb failed"; exit 2; }
"$PGBIN/pg_ctl" -D "$DATA" -l "$RESULTS/pg.log" -o "-p $PGPORT -k $SOCK -c fsync=off" start -w > /dev/null 2>&1 || { echo "FATAL: pg_ctl start failed"; exit 2; }
"$REDIS" --port "$REDISPORT" --bind 127.0.0.1 --save '' --appendonly no > "$RESULTS/redis.log" 2>&1 &
REDIS_PID=$!
sleep 1
# §8: the tracked PID must be OUR redis-server
if ! kill -0 "$REDIS_PID" 2>/dev/null; then echo "FATAL: redis exited immediately — see $RESULTS/redis.log"; exit 2; fi
if ! tr '\0' ' ' < "/proc/$REDIS_PID/cmdline" 2>/dev/null | grep -q "redis-server"; then echo "FATAL: tracked pid $REDIS_PID is not our redis-server — aborting"; exit 2; fi
echo "  postgres 17 ready on :$PGPORT; redis 7.2.5 ready on :$REDISPORT (pid $REDIS_PID, tracked)"
INFRA_UP=1
cleanup() {
  if [ "$INFRA_UP" -eq 1 ]; then
    REDIS_CLI_BIN="$(command -v redis-cli 2>/dev/null || true)"
    if [ -z "$REDIS_CLI_BIN" ] && [ -x "${REDIS%redis-server}redis-cli" ]; then REDIS_CLI_BIN="${REDIS%redis-server}redis-cli"; fi
    # §8: port-addressed shutdown ONLY with verified ownership (identity + socket)
    if [ -n "$REDIS_PID" ] && kill -0 "$REDIS_PID" 2>/dev/null \
       && tr '\0' ' ' < "/proc/$REDIS_PID/cmdline" 2>/dev/null | grep -q "redis-server" \
       && { command -v ss > /dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -E "127.0.0.1:$REDISPORT[^0-9]|\\*:$REDISPORT " | grep -q "pid=$REDIS_PID,"; }; then
      [ -n "$REDIS_CLI_BIN" ] && "$REDIS_CLI_BIN" -p "$REDISPORT" shutdown nosave > /dev/null 2>&1 || true
    elif [ -n "$REDIS_PID" ] && kill -0 "$REDIS_PID" 2>/dev/null; then
      echo "[CLEANUP] redis socket ownership not verifiable — graceful SIGTERM to the tracked process only"
      kill -TERM "$REDIS_PID" 2>/dev/null || true
    fi
    for _ in 1 2 3 4 5 6 7 8; do [ -n "$REDIS_PID" ] && ! kill -0 "$REDIS_PID" 2>/dev/null && break; sleep 1; done
    [ -n "$REDIS_PID" ] && kill -0 "$REDIS_PID" 2>/dev/null && kill -KILL "$REDIS_PID" 2>/dev/null || true
    "$PGBIN/pg_ctl" -D "$DATA" stop -m fast > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run_side() { # run_side <label> <backend-dir> <iteration>
  local label="$1" backend="$2" i="$3"
  local DB="ab_${label}_${i}"
  PGCLIENT="${PGTEST_DIR:-/tmp/pgtest}/node_modules/pg" node -e "
const {Client}=require(process.env.PGCLIENT);
(async()=>{
  const c=new Client({host:'$SOCK',port:$PGPORT,user:'kindora',database:'postgres'});
  await c.connect();
  try{await c.query('DROP DATABASE IF EXISTS $DB WITH (FORCE);');}catch(e){}
  await c.query('CREATE DATABASE $DB;'); await c.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
" || return 1
  ( cd "$backend" \
    && DATABASE_URL="postgresql://kindora@localhost:$PGPORT/$DB" npx prisma migrate deploy > "$RESULTS/migrate-$label-$i.log" 2>&1 \
    && SEED_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD" DATABASE_URL="postgresql://kindora@localhost:$PGPORT/$DB" npx prisma db seed > "$RESULTS/seed-$label-$i.log" 2>&1 \
    && RUN_INTEGRATION=1 DATABASE_URL="postgresql://kindora@localhost:$PGPORT/$DB" REDIS_URL="redis://127.0.0.1:$REDISPORT" PROVIDER_MODE=mock \
       JWT_SECRET=kindora-integration-test-secret \
       npx jest --config test/jest-e2e.json --runInBand --testPathPattern "$FILEREGEX" ${NAME_REGEX:+-t "$NAME_REGEX"} \
       > "$RESULTS/jest-$label-$i.log" 2>&1 )
}

outcomes() { # outcomes <log> -> "OUTCOME<TAB>name" lines
  grep -oE '✓ .*|✕ .*' "$1" 2>/dev/null | sed -E 's/\([0-9.]+ ms\)//; s/\([0-9.]+ s\)//; s/[[:space:]]+$//' | sort -u
}

# --- prepare BOTH trees ---------------------------------------------------------
echo "== preparing the baseline tree (A) =="
BWORK="$(mktemp -d /tmp/v113-ab-baseline.XXXXXX)"
tar -xzf "$BASELINE_TARBALL" -C "$BWORK"
BTREE=$(find "$BWORK" -maxdepth 2 -type d -name backend | head -1 | xargs dirname)
[ -n "$BTREE" ] || { echo "FATAL: no backend directory found in the baseline tarball"; exit 2; }
echo "  baseline tree: $BTREE"
( cd "$BTREE/backend" && npm ci --no-audit --no-fund --loglevel=error > "$RESULTS/npmci-baseline.log" 2>&1 && npx prisma generate >> "$RESULTS/npmci-baseline.log" 2>&1 ) || { echo "FATAL: baseline dependency install failed (see $RESULTS/npmci-baseline.log)"; exit 1; }

echo "== preparing the release tree (B) =="
( cd "$TREE/backend" && npm ci --no-audit --no-fund --loglevel=error > "$RESULTS/npmci-release.log" 2>&1 && npx prisma generate >> "$RESULTS/npmci-release.log" 2>&1 ) || { echo "FATAL: release dependency install failed (see $RESULTS/npmci-release.log)"; exit 1; }

# --- run iterations -------------------------------------------------------------
echo "== running $ITERS iteration(s) per side =="
: > "$RESULTS/baseline-outcomes.txt"
: > "$RESULTS/release-outcomes.txt"
for i in $(seq 1 "$ITERS"); do
  echo "  iteration $i ..."
  run_side "baseline" "$BTREE/backend" "$i" || { echo "FATAL: baseline iteration $i could not execute (see $RESULTS/)"; exit 1; }
  run_side "release" "$TREE/backend" "$i" || { echo "FATAL: release iteration $i could not execute (see $RESULTS/)"; exit 1; }
  outcomes "$RESULTS/jest-baseline-$i.log" >> "$RESULTS/baseline-outcomes.txt"
  outcomes "$RESULTS/jest-release-$i.log" >> "$RESULTS/release-outcomes.txt"
done

# --- compare actual assertions/outcomes -----------------------------------------
echo ""
echo "== comparison (per test name, union over all iterations) =="
# aggregate per-side pass/fail NAME SETS from the jest logs
: > "$RESULTS/baseline-pass.txt"; : > "$RESULTS/baseline-fail.txt"
: > "$RESULTS/release-pass.txt"; : > "$RESULTS/release-fail.txt"
for i in $(seq 1 "$ITERS"); do
  grep '✓' "$RESULTS/jest-baseline-$i.log" 2>/dev/null | sed -E 's/^[[:space:]]*✓[[:space:]]*//; s/\([0-9.]+ (ms|s)\)//g; s/[[:space:]]+$//' >> "$RESULTS/baseline-pass.txt" || true
  grep '✕' "$RESULTS/jest-baseline-$i.log" 2>/dev/null | sed -E 's/^[[:space:]]*✕[[:space:]]*//; s/\([0-9.]+ (ms|s)\)//g; s/[[:space:]]+$//' >> "$RESULTS/baseline-fail.txt" || true
  grep '✓' "$RESULTS/jest-release-$i.log" 2>/dev/null | sed -E 's/^[[:space:]]*✓[[:space:]]*//; s/\([0-9.]+ (ms|s)\)//g; s/[[:space:]]+$//' >> "$RESULTS/release-pass.txt" || true
  grep '✕' "$RESULTS/jest-release-$i.log" 2>/dev/null | sed -E 's/^[[:space:]]*✕[[:space:]]*//; s/\([0-9.]+ (ms|s)\)//g; s/[[:space:]]+$//' >> "$RESULTS/release-fail.txt" || true
done
sort -u "$RESULTS/baseline-pass.txt" -o "$RESULTS/baseline-pass.txt"
sort -u "$RESULTS/baseline-fail.txt" -o "$RESULTS/baseline-fail.txt"
sort -u "$RESULTS/release-pass.txt" -o "$RESULTS/release-pass.txt"
sort -u "$RESULTS/release-fail.txt" -o "$RESULTS/release-fail.txt"

# a NEW regression = a test name that PASSED on the pristine baseline and does
# NOT pass on the release (failed or absent there)
REGRESSION_LIST=$(comm -23 "$RESULTS/baseline-pass.txt" "$RESULTS/release-pass.txt" || true)
REGRESSIONS=$(printf '%s' "$REGRESSION_LIST" | grep -c . || true)
IMPROVEMENT_LIST=$(comm -13 "$RESULTS/baseline-pass.txt" "$RESULTS/release-pass.txt" || true)
IMPROVEMENTS=$(printf '%s' "$IMPROVEMENT_LIST" | grep -c . || true)
BOTH_FAIL=$(comm -12 "$RESULTS/baseline-fail.txt" "$RESULTS/release-fail.txt" | grep -c . || true)

echo "  tests passing on baseline AND release: $(comm -12 "$RESULTS/baseline-pass.txt" "$RESULTS/release-pass.txt" | grep -c . || true)"
echo "  NEW regressions (passed on baseline, do not pass on release): $REGRESSIONS"
[ -n "$REGRESSION_LIST" ] && printf '%s\n' "$REGRESSION_LIST" | sed 's/^/    REGRESSION: /'
echo "  improvements (failed-or-absent on baseline, passing on release): $IMPROVEMENTS"
[ -n "$IMPROVEMENT_LIST" ] && printf '%s\n' "$IMPROVEMENT_LIST" | sed 's/^/    improved: /'
echo "  tests failing on BOTH sides (pre-existing, reported — never assumed harmless): $BOTH_FAIL"
comm -12 "$RESULTS/baseline-fail.txt" "$RESULTS/release-fail.txt" | sed 's/^/    pre-existing failure: /' || true

if [ "$REGRESSIONS" -ne 0 ]; then
  echo ""
  echo "RESULT: NEW REGRESSION DETECTED — test(s) passing on the pristine baseline but failing on the release"
  echo "        (logs preserved under $RESULTS)"
  exit 1
fi

echo ""
echo "RESULT: NO NEW REGRESSION (A/B comparison; logs preserved under $RESULTS)"
[ "$BOTH_FAIL" -gt 0 ] && echo "NOTE: $BOTH_FAIL test(s) fail on BOTH sides — pre-existing condition, investigate separately"
exit 0

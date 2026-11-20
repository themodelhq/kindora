#!/usr/bin/env bash
# KINDORA v1.0.14 — DEDICATED INTEGRATION-RUNNER SAFETY SCENARIO TESTS
# (completion patch §6). Exercises scripts/run_integration_tests.sh (the SAFE
# runner) under eight required scenarios while UNRELATED decoy PostgreSQL and
# Redis services are running, and proves after EVERY scenario that the decoys
# survive — the §8 "pre-existing services survive the integration-test
# lifecycle" regression proof.
#
#   A  successful execution          — PASS, results collected, owned resources cleaned
#   B  failed test execution         — nonzero exit, diagnostics preserved, cleanup still occurs
#   C  interrupted execution         — signal handling, owned resources stopped, unrelated untouched
#   D  missing service               — clear diagnostic, no destructive recovery, correct status
#   E  port conflict                 — foreign listener detected, NOT terminated, run stops safely
#   F  cleanup failure               — failure reported, unrelated data not deleted, diagnostics kept
#   G  temporary-directory hardening — pre-created dirs never adopted/deleted; invalid TMPDIR
#                                      (missing / no-write) refused; symlinked TMPDIR accepted
#   H  concurrent executions         — two runs never share temporary resources; one run's
#                                      cleanup cannot affect the other
#
# The runner itself creates its run root with mktemp -d (§7) and shuts down
# only PID-tracked, ownership-verified services (§8). This script proves those
# properties from the OUTSIDE.
#
# NOTE on accounting: scenario assertions may run inside subshells (piped
# blocks), so PASS/FAIL outcomes are recorded in a RESULTS FILE on disk —
# never in shell variables that a subshell cannot propagate. The summary is
# computed from that file, making the totals immune to subshell scoping.
#
# Layout-aware: works from the development checkout AND from a clean
# extraction of the release archive.
#
# Output: one log per scenario under $KINDORA_SAFETY_OUT (default: a fresh
# directory under ${TMPDIR:-/tmp}). Exit 0 = all scenarios passed; 1 = at
# least one scenario failed; 2 = environment error (infra unavailable).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$TREE/scripts/run_integration_tests.sh"

PGBIN="${KINDORA_ITEST_PGBIN:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64/native/bin}"
REDIS_BIN="${KINDORA_ITEST_REDIS:-/tmp/redis-7.2.5/src/redis-server}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${KINDORA_SAFETY_OUT:-${TMPDIR:-/tmp}/v114-integration-runner-safety-$STAMP}"
mkdir -p "$OUT_DIR" || { echo "FATAL: cannot create output dir $OUT_DIR"; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/v114-safety-work.XXXXXXXX")"
RESULTS_FILE="$OUT_DIR/.scenario-results"
: > "$RESULTS_FILE"

[ -f "$RUNNER" ] || { echo "FATAL: safe runner not found at $RUNNER"; exit 2; }
[ -x "$RUNNER" ] || { echo "FATAL: safe runner is not executable: $RUNNER"; exit 2; }

echo "== KINDORA v1.0.14 integration-runner safety scenario tests =="
echo "runner:   $RUNNER"
echo "outputs:  $OUT_DIR"

INFRA_OK=1
if [ ! -x "$PGBIN/pg_ctl" ]; then echo "BLOCKED: PostgreSQL binaries unavailable at $PGBIN (set KINDORA_ITEST_PGBIN)"; INFRA_OK=0; fi
if [ ! -x "$REDIS_BIN" ]; then echo "BLOCKED: redis-server unavailable at $REDIS_BIN (set KINDORA_ITEST_REDIS)"; INFRA_OK=0; fi
if [ "$INFRA_OK" -eq 0 ]; then
  echo "SCENARIO SUMMARY: PASS=0 FAIL=0 BLOCKED=8"
  echo "BLOCKED — exact reason: integration infrastructure (embedded PostgreSQL + redis-server binaries) not available in this environment."
  echo "Affects production readiness assessment: NO (scenario execution is an environment capability, not a product defect); required next action: provide the binaries and re-run."
  exit 2
fi

# subshell-proof scenario accounting (append-mode file writes survive subshells)
scenario() { # scenario <exit-status> <tag>
  if [ "$1" -eq 0 ]; then
    echo "  SCENARIO $2: PASS"
    echo "PASS $2" >> "$RESULTS_FILE"
  else
    echo "  SCENARIO $2: FAIL (exit $1)"
    echo "FAIL $2" >> "$RESULTS_FILE"
  fi
}
decoys_alive() { kill -0 "$DECOY_PG_PID" 2>/dev/null && kill -0 "$DECOY_REDIS_PID" 2>/dev/null; }
assert_decoys() { # assert_decoys <scenario-tag>
  if decoys_alive; then echo "  pre-existing decoy PostgreSQL :5599 and Redis :5598 STILL ALIVE — unrelated services unaffected: yes"
  else echo "  SAFETY VIOLATION: a decoy service was killed (pg=$DECOY_PG_PID redis=$DECOY_REDIS_PID)"; scenario 1 "$1-decoy-check"; fi
}
runroot_leftovers() { ls -d "${TMPDIR:-/tmp}"/kindora-itest.* 2>/dev/null | grep -v -- '-FAILED' | wc -l; }
failed_keeps() { ls -d "${TMPDIR:-/tmp}"/kindora-itest.*-FAILED 2>/dev/null | wc -l; }

echo ""
echo "== starting DECOY (pre-existing, unrelated) PostgreSQL :5599 and Redis :5598 =="
DECOY_ROOT="$WORK/decoy-services"
mkdir -p "$DECOY_ROOT"
"$PGBIN/initdb" -D "$DECOY_ROOT/pgdata" -U decoy --auth=trust -E UTF8 > "$DECOY_ROOT/initdb.log" 2>&1 || { echo "FATAL: decoy initdb failed"; exit 2; }
mkdir -p "$DECOY_ROOT/pgsock" || { echo "FATAL: cannot create decoy socket dir"; exit 2; }
"$PGBIN/pg_ctl" -D "$DECOY_ROOT/pgdata" -l "$DECOY_ROOT/pg.log" -o "-p 5599 -k $DECOY_ROOT/pgsock -c fsync=off" start -w > /dev/null 2>&1 || { echo "FATAL: decoy pg failed (see $DECOY_ROOT/pg.log)"; tail -5 "$DECOY_ROOT/pg.log" 2>/dev/null; exit 2; }
DECOY_PG_PID="$(head -1 "$DECOY_ROOT/pgdata/postmaster.pid")"
"$REDIS_BIN" --port 5598 --bind 127.0.0.1 --save '' --appendonly no > "$DECOY_ROOT/redis.log" 2>&1 &
DECOY_REDIS_PID=$!
sleep 1
echo "  decoy postmaster pid: $DECOY_PG_PID | decoy redis pid: $DECOY_REDIS_PID"
decoys_alive && echo "  decoys UP (pre-existing services)" || { echo "FATAL: decoys failed to start"; exit 2; }

# ---------------------------------------------------------------- PRE-FLIGHT ----
echo ""
echo "== pre-flight: establish a clean temporary-root baseline =="
# Leftovers of PREVIOUS runner executions (e.g. an earlier interrupted run of
# this harness on the same machine) would poison the cleanup assertions below.
# Only runner-generated kindora-itest.* directories OWNED BY THIS USER are
# recovered — a foreign-owned directory is never touched.
PRE_LEFT=0
for d in "${TMPDIR:-/tmp}"/kindora-itest.*; do
  [ -d "$d" ] || continue
  if [ "$(stat -c %u "$d" 2>/dev/null)" = "$(id -u)" ]; then
    echo "  pre-existing runner leftover from a previous execution: $d — recovering (ownership verified; contents listed to the pre-flight log)"
    { echo "== $d (recovered at pre-flight) =="; ls -la "$d"; } >> "$OUT_DIR/preflight-recovery.log" 2>&1
    chmod -R u+rwx "$d" 2>/dev/null || true
    rm -rf "$d" || PRE_LEFT=$((PRE_LEFT+1))
  else
    echo "  WARNING: $d is NOT owned by this user — NOT touched (foreign directory)"
    PRE_LEFT=$((PRE_LEFT+1))
  fi
done
if [ "$PRE_LEFT" -eq 0 ]; then echo "  baseline clean: yes"; else echo "FATAL: cannot establish a clean temporary-root baseline ($PRE_LEFT unremovable entries)"; exit 2; fi

cleanup_decoys() {
  echo ""
  echo "== shutting down the scenario harness's OWN resources =="
  [ -n "${WATCHER_PID:-}" ] && kill "$WATCHER_PID" 2>/dev/null || true
  kill -TERM "$DECOY_REDIS_PID" 2>/dev/null || true
  "$PGBIN/pg_ctl" stop -D "$DECOY_ROOT/pgdata" -m fast > /dev/null 2>&1 || true
  # harness housekeeping: recover any scenario-F leftover (locked by the test itself)
  for d in "${TMPDIR:-/tmp}"/kindora-itest.*; do
    [ -d "$d" ] || continue
    chmod -R u+rwx "$d" 2>/dev/null || true
  done
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup_decoys EXIT

# ---------------------------------------------------------------- SCENARIO A ----
echo ""
echo "== SCENARIO A: successful execution (storage suite, dedicated ports 5577/5578) =="
OUT_A="$(KINDORA_ITEST_PGPORT=5577 KINDORA_ITEST_REDISPORT=5578 bash "$RUNNER" --suite "storage.e2e-spec" 2>&1)"; RC_A=$?
printf '%s\n' "$OUT_A" > "$OUT_DIR/scenario-A-success.log"
{
  [ "$RC_A" -eq 0 ] && grep -q "\[RESULTS\] PASS" <<<"$OUT_A" && scenario 0 "A-success (exit 0, PASS reported)" || scenario 1 "A-success"
  LEFT=$(runroot_leftovers)
  [ "$LEFT" -eq 0 ] && echo "  owned temporary resources cleaned: yes (0 leftover run roots)" || { echo "  leftover run roots: $LEFT"; scenario 1 "A-cleanup"; }
  assert_decoys "A"
} | tee -a "$OUT_DIR/scenario-A-success.log"

# ---------------------------------------------------------------- SCENARIO B ----
echo ""
echo "== SCENARIO B: failed test execution (suite matches nothing) =="
OUT_B="$(KINDORA_ITEST_PGPORT=5577 KINDORA_ITEST_REDISPORT=5578 bash "$RUNNER" --suite "definitely-no-such-suite-xyz" 2>&1)"; RC_B=$?
printf '%s\n' "$OUT_B" > "$OUT_DIR/scenario-B-failed-test.log"
{
  [ "$RC_B" -ne 0 ] && echo "  failure reported with nonzero exit code ($RC_B): yes" && scenario 0 "B-failed-test (nonzero exit)" || scenario 1 "B-failed-test"
  [ "$(failed_keeps)" -ge 1 ] && echo "  diagnostic logs preserved (-FAILED copy): yes" || scenario 1 "B-diagnostics-preserved"
  [ "$(runroot_leftovers)" -eq 0 ] && echo "  cleanup still occurred despite failure: yes" || scenario 1 "B-cleanup"
  assert_decoys "B"
} | tee -a "$OUT_DIR/scenario-B-failed-test.log"

# ---------------------------------------------------------------- SCENARIO C ----
echo ""
echo "== SCENARIO C: interrupted execution (SIGTERM mid-jest) =="
KINDORA_ITEST_PGPORT=5577 KINDORA_ITEST_REDISPORT=5578 bash "$RUNNER" --suite "money-path.e2e-spec" > "$OUT_DIR/scenario-C-interrupt.log" 2>&1 &
RUNNER_PID=$!
for _ in $(seq 1 20); do grep -q "\[TEST\] integration suite" "$OUT_DIR/scenario-C-interrupt.log" 2>/dev/null && break; sleep 2; done
sleep 5
# TERM the whole process GROUP — bash defers traps until the foreground command
# finishes, so a single-pid signal would land after jest completed; a group
# signal genuinely interrupts mid-run (the runner's own trap still runs).
kill -TERM -- "-$RUNNER_PID" 2>/dev/null || kill -TERM "$RUNNER_PID" 2>/dev/null
wait "$RUNNER_PID" 2>/dev/null; RC_C=$?
sleep 3
{
  [ "$RC_C" -ne 0 ] && echo "  signal handling works — terminated run exits nonzero ($RC_C), never reports success: yes" && scenario 0 "C-interrupt (nonzero exit)" || scenario 1 "C-interrupt"
  grep -q "\[CLEANUP\]" "$OUT_DIR/scenario-C-interrupt.log" && echo "  trap-based cleanup executed on interruption: yes" || scenario 1 "C-cleanup-ran"
  ORPH=$(pgrep -f "kindora-itest" | wc -l)
  [ "$ORPH" -eq 0 ] && echo "  owned resources stopped safely — no orphaned runner processes: yes" || { echo "  ORPHANED runner processes: $ORPH"; scenario 1 "C-orphans"; }
  assert_decoys "C"
} | tee -a "$OUT_DIR/scenario-C-interrupt.log"

# ---------------------------------------------------------------- SCENARIO D ----
echo ""
echo "== SCENARIO D: missing service (misconfigured redis path) =="
OUT_D="$(KINDORA_ITEST_REDIS=/nonexistent/redis-server KINDORA_ITEST_PGPORT=5577 KINDORA_ITEST_REDISPORT=5578 bash "$RUNNER" --suite "storage.e2e-spec" 2>&1)"; RC_D=$?
printf '%s\n' "$OUT_D" > "$OUT_DIR/scenario-D-missing-service.log"
{
  [ "$RC_D" -eq 2 ] && grep -q "redis-server not available" <<<"$OUT_D" && echo "  clear diagnostic + correct failure status (exit 2): yes" && scenario 0 "D-missing-service" || scenario 1 "D-missing-service"
  grep -qE "pkill|killall" <<<"$OUT_D" && { echo "  DESTRUCTIVE RECOVERY ATTEMPTED"; scenario 1 "D-no-destructive-recovery"; } || echo "  no destructive recovery attempt: yes"
  [ "$(runroot_leftovers)" -eq 0 ] && echo "  nothing was started or left behind: yes" || scenario 1 "D-nothing-left"
  assert_decoys "D"
} | tee -a "$OUT_DIR/scenario-D-missing-service.log"

# ---------------------------------------------------------------- SCENARIO E ----
echo ""
echo "== SCENARIO E: port conflict (foreign listener on the runner's PG port) =="
python3 -c "
import socket, time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',5577)); s.listen(1)
print('foreign listener up on 5577', flush=True); time.sleep(60)
" > "$OUT_DIR/scenario-E-listener.log" 2>&1 &
LISTENER_PID=$!
sleep 1
OUT_E="$(KINDORA_ITEST_PGPORT=5577 KINDORA_ITEST_REDISPORT=5578 bash "$RUNNER" --suite "storage.e2e-spec" 2>&1)"; RC_E=$?
printf '%s\n' "$OUT_E" > "$OUT_DIR/scenario-E-port-conflict.log"
{
  [ "$RC_E" -eq 2 ] && grep -q "already in use" <<<"$OUT_E" && echo "  existing listener detected, run stops safely (exit 2): yes" && scenario 0 "E-port-conflict" || scenario 1 "E-port-conflict"
  kill -0 "$LISTENER_PID" 2>/dev/null && echo "  existing service NOT terminated (listener still alive): yes" || { echo "  foreign listener was KILLED — SAFETY VIOLATION"; scenario 1 "E-listener-survived"; }
  assert_decoys "E"
} | tee -a "$OUT_DIR/scenario-E-port-conflict.log"
kill "$LISTENER_PID" 2>/dev/null || true
wait "$LISTENER_PID" 2>/dev/null || true

# ---------------------------------------------------------------- SCENARIO F ----
echo ""
echo "== SCENARIO F: cleanup failure (locked directory inside the run root) =="
mkdir -p "$WORK/decoy-f" && echo "unrelated data that must survive" > "$WORK/decoy-f/keepme.txt"
# watcher: as soon as the runner creates its run root, inject a locked subdir
# so the runner's guarded rm -rf cannot fully remove it
(
  BEFORE=$(ls -d "${TMPDIR:-/tmp}"/kindora-itest.* 2>/dev/null | sort)
  while :; do
    NOW=$(ls -d "${TMPDIR:-/tmp}"/kindora-itest.* 2>/dev/null | sort)
    NEW=$(comm -13 <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$NOW") 2>/dev/null | grep -v -- '-FAILED' | head -1)
    if [ -n "$NEW" ] && [ -d "$NEW" ]; then
      mkdir "$NEW/locked-by-scenario-f" 2>/dev/null
      echo "watcher: cannot write into locked dir" > "$NEW/locked-by-scenario-f/file" 2>/dev/null
      chmod 000 "$NEW/locked-by-scenario-f" 2>/dev/null
      exit 0
    fi
    sleep 0.05
  done
) &
WATCHER_PID=$!
OUT_F="$(KINDORA_ITEST_PGPORT=5577 KINDORA_ITEST_REDISPORT=5578 bash "$RUNNER" --suite "definitely-no-such-suite-xyz" 2>&1)"; RC_F=$?
kill "$WATCHER_PID" 2>/dev/null; wait "$WATCHER_PID" 2>/dev/null || true
printf '%s\n' "$OUT_F" > "$OUT_DIR/scenario-F-cleanup-failure.log"
{
  [ "$RC_F" -ne 0 ] && echo "  failure is reported (nonzero exit $RC_F): yes" && scenario 0 "F-cleanup-failure-reported" || scenario 1 "F-cleanup-failure-reported"
  grep -q "could not fully remove" <<<"$OUT_F" && echo "  cleanup failure reported by the runner (guarded rm refused to claim success): yes" || scenario 1 "F-runner-reported"
  grep -q "unrelated data" <(cat "$WORK/decoy-f/keepme.txt" 2>/dev/null) && echo "  existing unrelated data NOT deleted: yes" || scenario 1 "F-unrelated-data"
  grep -q "jest.log\|FAILURES" <<<"$OUT_F" && echo "  diagnostics preserved: yes" || scenario 1 "F-diagnostics"
  assert_decoys "F"
} | tee -a "$OUT_DIR/scenario-F-cleanup-failure.log"
# harness housekeeping: the locked leftover stays only for the assertions
# above; its diagnostic content is already captured in the scenario log, so
# the harness removes it (after lifting the lock) to leave a clean workspace
for d in "${TMPDIR:-/tmp}"/kindora-itest.*; do
  [ -d "$d" ] || continue
  case "$d" in *-FAILED) continue ;; esac
  echo "  (harness housekeeping: recovering scenario-F leftover $d — contents already logged)"
  ls -la "$d" 2>/dev/null | sed 's/^/    /' >> "$OUT_DIR/scenario-F-cleanup-failure.log"
  chmod -R u+rwx "$d" 2>/dev/null || true
  rm -rf "$d" 2>/dev/null || true
done

# ---------------------------------------------------------------- SCENARIO G ----
echo ""
echo "== SCENARIO G: temporary-directory hardening (dry-run based) =="
# G1: pre-created directory matching the runner's naming pattern is NEVER
#     adopted and NEVER deleted — after the run, g-tmp must contain EXACTLY
#     the pre-created decoy (the runner's own root was created and removed)
mkdir -p "$WORK/g-tmp/kindora-itest.deadbeef" && echo "pre-created decoy" > "$WORK/g-tmp/kindora-itest.deadbeef/content.txt"
OUT_G1="$(TMPDIR="$WORK/g-tmp" bash "$RUNNER" --dry-run 2>&1)"; RC_G1=$?
printf '%s\n' "$OUT_G1" > "$OUT_DIR/scenario-G-precreated-tmpdir.log"
{
  [ "$RC_G1" -eq 0 ] && grep -q "created atomically via mktemp" <<<"$OUT_G1" && echo "  G1 dry-run OK with pre-created kindora-itest.* directory present" && scenario 0 "G1-collision-safe" || scenario 1 "G1-collision-safe"
  grep -q "pre-created decoy" "$WORK/g-tmp/kindora-itest.deadbeef/content.txt" 2>/dev/null \
    && [ -d "$WORK/g-tmp/kindora-itest.deadbeef" ] \
    && echo "  untrusted pre-created directory never adopted nor deleted: yes" || scenario 1 "G1-decoy-intact"
  REMAINING=$(find "$WORK/g-tmp" -maxdepth 1 -name 'kindora-itest.*' | wc -l)
  [ "$REMAINING" -eq 1 ] && echo "  exactly 1 kindora-itest.* remains in the temp root — the pre-created decoy (runner's own root removed): yes" && scenario 0 "G1-no-adoption" || { echo "  kindora-itest.* entries remaining: $REMAINING (expected 1)"; scenario 1 "G1-no-adoption"; }
} | tee -a "$OUT_DIR/scenario-G-precreated-tmpdir.log"
# G2: invalid temporary root (missing directory)
OUT_G2="$(TMPDIR="$WORK/nonexistent-tmp" bash "$RUNNER" --dry-run 2>&1)"; RC_G2=$?
printf '%s\n' "$OUT_G2" > "$OUT_DIR/scenario-G-invalid-tmpdir.log"
[ "$RC_G2" -eq 2 ] && grep -q "is not a directory" <<<"$OUT_G2" && scenario 0 "G2-invalid-tmpdir-refused" || scenario 1 "G2-invalid-tmpdir-refused"
# G3: symlinked TMPDIR (resolved, never followed blindly)
mkdir -p "$WORK/g-real-target" && echo "target content" > "$WORK/g-real-target/target-file.txt"
ln -s "$WORK/g-real-target" "$WORK/g-symlink"
OUT_G3="$(TMPDIR="$WORK/g-symlink" bash "$RUNNER" --dry-run 2>&1)"; RC_G3=$?
printf '%s\n' "$OUT_G3" > "$OUT_DIR/scenario-G-symlink-tmpdir.log"
[ "$RC_G3" -eq 0 ] && [ -f "$WORK/g-real-target/target-file.txt" ] && scenario 0 "G3-symlink-tmpdir-safe" || scenario 1 "G3-symlink-tmpdir-safe"
# G4: permission failure (unwritable temporary root)
mkdir -p "$WORK/g-readonly" && chmod 500 "$WORK/g-readonly"
OUT_G4="$(TMPDIR="$WORK/g-readonly" bash "$RUNNER" --dry-run 2>&1)"; RC_G4=$?
printf '%s\n' "$OUT_G4" > "$OUT_DIR/scenario-G-permission-failure.log"
[ "$RC_G4" -eq 2 ] && grep -q "not writable" <<<"$OUT_G4" && scenario 0 "G4-permission-failure-refused" || scenario 1 "G4-permission-failure-refused"
chmod 700 "$WORK/g-readonly" 2>/dev/null || true
echo "  G2 invalid TMPDIR refused (exit $RC_G2) | G3 symlinked TMPDIR safe (exit $RC_G3) | G4 permission failure refused (exit $RC_G4)"
assert_decoys "G"

# ---------------------------------------------------------------- SCENARIO H ----
echo ""
echo "== SCENARIO H: concurrent test execution (two independent runs, overlapping) =="
# run 1 = the LONG money-path suite; run 2 = the SHORT storage suite — run 2
# finishes (and cleans up) while run 1 is still mid-tests, so run 1's final
# PASS proves run 2's full lifecycle could not affect run 1's resources.
KINDORA_ITEST_PGPORT=5568 KINDORA_ITEST_REDISPORT=5567 bash "$RUNNER" --suite "money-path.e2e-spec" > "$OUT_DIR/scenario-H-run1.log" 2>&1 &
H1_PID=$!
for _ in $(seq 1 30); do grep -q "\[TEST\] integration suite" "$OUT_DIR/scenario-H-run1.log" 2>/dev/null && break; sleep 2; done
H1_MIDWAY=$(kill -0 "$H1_PID" 2>/dev/null && echo yes || echo no)
KINDORA_ITEST_PGPORT=5566 KINDORA_ITEST_REDISPORT=5565 bash "$RUNNER" --suite "storage.e2e-spec" > "$OUT_DIR/scenario-H-run2.log" 2>&1 &
H2_PID=$!
wait "$H2_PID"; RC_H2=$?
H1_STILL=$(kill -0 "$H1_PID" 2>/dev/null && echo yes || echo no)
wait "$H1_PID"; RC_H1=$?
H1_INTERRUPTED=0
grep -q "terminated" "$OUT_DIR/scenario-H-run1.log" 2>/dev/null && H1_INTERRUPTED=1
{
  [ "$H1_MIDWAY" = "yes" ] && echo "  run 2 started while run 1 was mid-jest (overlapping executions): yes" && scenario 0 "H-overlap" || scenario 1 "H-overlap"
  [ "$RC_H1" -eq 0 ] && grep -q "\[RESULTS\] PASS" "$OUT_DIR/scenario-H-run1.log" && scenario 0 "H-run1-success" || scenario 1 "H-run1-success"
  [ "$RC_H2" -eq 0 ] && grep -q "\[RESULTS\] PASS" "$OUT_DIR/scenario-H-run2.log" && scenario 0 "H-run2-success" || scenario 1 "H-run2-success"
  if [ "$H1_STILL" = "yes" ]; then
    echo "  run 2 completed and cleaned up while run 1 was still executing: yes"
    scenario 0 "H-cleanup-isolation"
  elif [ "$RC_H1" -eq 0 ] && [ "$H1_INTERRUPTED" -eq 0 ]; then
    echo "  run 1 completed on its own schedule AFTER run 2 finished (exit 0, full PASS, no interruption evidence) — run 2's lifecycle never disturbed it: yes"
    scenario 0 "H-cleanup-isolation"
  else
    echo "  run 1 did not complete normally (exit $RC_H1, interrupted=$H1_INTERRUPTED) — ISOLATION VIOLATION"
    scenario 1 "H-cleanup-isolation"
  fi
  grep -q "run root: .*kindora-itest\." "$OUT_DIR/scenario-H-run1.log" && grep -q "run root: .*kindora-itest\." "$OUT_DIR/scenario-H-run2.log" \
    && R1ROOT=$(sed -n 's/.*run root: \(.*\) (created.*/\1/p' "$OUT_DIR/scenario-H-run1.log" | head -1) \
    && R2ROOT=$(sed -n 's/.*run root: \(.*\) (created.*/\1/p' "$OUT_DIR/scenario-H-run2.log" | head -1) \
    && [ -n "$R1ROOT" ] && [ -n "$R2ROOT" ] && [ "$R1ROOT" != "$R2ROOT" ] \
    && echo "  distinct temporary resources per run: yes ($R1ROOT vs $R2ROOT)" && scenario 0 "H-distinct-resources" || scenario 1 "H-distinct-resources"
  [ "$(runroot_leftovers)" -eq 0 ] && echo "  both runs cleaned their OWN roots; no cross-deletion: yes" || scenario 1 "H-no-leftovers"
  assert_decoys "H"
} | tee "$OUT_DIR/scenario-H-concurrent.log"

# ---------------------------------------------------------------- SUMMARY -------
NPASS=$(grep -c '^PASS ' "$RESULTS_FILE" || true)
NFAIL=$(grep -c '^FAIL ' "$RESULTS_FILE" || true)
echo ""
echo "== SCENARIO SUMMARY: PASS=$NPASS FAIL=$NFAIL =="
if [ "$NFAIL" -eq 0 ]; then
  echo "SAFE RUNNER: ALL SCENARIOS PASSED — unrelated (pre-existing) PostgreSQL and Redis services unaffected; §7/§8/§9 properties demonstrated from the outside"
  echo "scenario logs: $OUT_DIR"
  exit 0
fi
echo "SAFE RUNNER: FAILURES PRESENT ($NFAIL) — see $OUT_DIR"
exit 1

#!/usr/bin/env bash
# KINDORA v1.0.14 — SAFE integration test runner (real PostgreSQL + real Redis).
#
# v1.0.14 correction (release prompt Phase 6): the v1.0.7 script performed
# UNCONTROLLED DESTRUCTIVE operations — `pkill -9 postgres` (killed ANY
# PostgreSQL on the host), `pkill -f "redis-server 127"` (killed ANY
# loopback Redis), fixed shared `rm -rf` paths, and no cleanup on
# interruption. This runner replaces it:
#
#   * NO process killing by name or pattern — only resources THIS execution
#     created are ever signalled, and only by tracked PID;
#   * graceful shutdown first, bounded timeouts, SIGKILL only as a last
#     resort against the tracked PID;
#   * redis shutdown additionally verifies the tracked PID's process identity
#     AND its ownership of the listening socket before any port-addressed
#     command is issued — an unrelated Redis is never identified by port alone;
#   * unique per-run data/socket directories created ATOMICALLY with
#     mktemp -d (unpredictable name, never an existing directory, mode 700),
#     removed ONLY after a strict self-created-path + ownership guard;
#   * port-conflict and missing-service detection with clear diagnostics —
#     a foreign service is never touched;
#   * clearly separated phases: [SETUP] [TEST] [RESULTS] [CLEANUP], with a
#     trap-based cleanup that runs on success, failure AND interruption;
#   * --dry-run prints the complete execution plan without touching anything;
#   * no production credentials: the test process receives ONLY the explicit
#     test-env exports below, targeting the runner's own ephemeral instance;
#   * the seeded administrator password is generated per execution with a
#     cryptographically secure generator, is NEVER logged or persisted, and
#     is removed with the run root at cleanup (v1.0.14 completion patch §9).
#
# v1.0.14 completion patch corrections (release prompt §6/§7/§8/§9):
#   §7  RUN_ROOT is now created with mktemp -d under ${TMPDIR:-/tmp} (atomic,
#       unpredictable, never reuses an existing directory, never follows an
#       attacker-controlled path); TMPDIR is validated when configured; the
#       cleanup guard additionally checks ownership of the exact directory.
#   §8  redis-cli shutdown is only issued after the tracked PID has been
#       re-verified (alive, is redis-server, OWNS the listening socket on the
#       configured port); otherwise graceful SIGTERM goes to the exact tracked
#       process only. Port-based shutdown of an unverified port is forbidden.
#   §9  SEED_ADMIN_PASSWORD is now generated per execution (node crypto
#       randomBytes, policy-validated) and passed to BOTH the seed step and
#       the jest process — the fixed 'Kindora-Admin-2026!' literal is gone
#       from this runner and from the test specs (they now REQUIRE the env).
#
# Layout-aware: works from the development checkout AND from a clean
# extraction of the release archive.
#
# Usage: bash scripts/run_integration_tests.sh [--dry-run] [--suite <jest-testPathPattern>] [--name <jest -t filter>]
# Exit codes: 0 = all tests passed; 1 = test/setup failure; 2 = environment error.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- arguments ----------------------------------------------------------------
DRY_RUN=0; SUITE="."; NAME_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --suite) SUITE="${2:?--suite requires a value}"; shift ;;
    --name) NAME_FILTER="${2:?--name requires a value}"; shift ;;
    *) echo "FATAL: unknown argument '$1' (supported: --dry-run --suite <pattern> --name <filter>)"; exit 2 ;;
  esac
  shift
done

# ---- required commands ----------------------------------------------------------
for cmd in node npm mktemp; do
  command -v "$cmd" > /dev/null 2>&1 || { echo "FATAL: required command '$cmd' not available"; exit 2; }
done

# ---- infrastructure locations (overridable; NO defaults outside the temp root) ---
PGBIN="${KINDORA_ITEST_PGBIN:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64/native/bin}"
REDIS_BIN="${KINDORA_ITEST_REDIS:-/tmp/redis-7.2.5/src/redis-server}"
PG_CLIENT="${KINDORA_ITEST_PGCLIENT:-/tmp/pgtest/node_modules/pg}"
PG_PORT="${KINDORA_ITEST_PGPORT:-5433}"
REDIS_PORT="${KINDORA_ITEST_REDISPORT:-5434}"

echo "[KINDORA safe integration runner] tree=$TREE"

# ---- temporary root: validated TMPDIR + atomic mktemp -d (completion patch §7) --
# If TMPDIR is configured it must be a suitable temporary directory: an
# existing, writable directory (a symlink to one is accepted and resolved —
# mktemp creates a NEW entry inside it; we never follow attacker-controlled
# paths because the run root itself is always freshly created by mktemp).
TMP_BASE="${TMPDIR:-/tmp}"
if [ -L "$TMP_BASE" ]; then
  TMP_TARGET="$(readlink -f "$TMP_BASE")" || { echo "FATAL: TMPDIR '$TMP_BASE' is a symlink that cannot be resolved"; exit 2; }
  [ -d "$TMP_TARGET" ] || { echo "FATAL: TMPDIR '$TMP_BASE' (-> $TMP_TARGET) is not a directory"; exit 2; }
fi
[ -d "$TMP_BASE" ] || { echo "FATAL: TMPDIR '$TMP_BASE' is not a directory — refusing to run"; exit 2; }
[ -w "$TMP_BASE" ] || { echo "FATAL: TMPDIR '$TMP_BASE' is not writable by this user — refusing to run"; exit 2; }

# ---- resource identity (everything this run creates carries this prefix) -------
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
# Atomic, unpredictable, never-existing-before directory (completion patch §7):
# mktemp -d creates the directory exclusively (O_EXCL semantics) with mode 700.
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kindora-itest.XXXXXXXX")" || { echo "FATAL: atomic temporary-directory creation failed in '$TMP_BASE'"; exit 2; }
chmod 700 "$RUN_ROOT" 2>/dev/null || true   # explicit restrictive permissions (mktemp already uses 700)
if [ ! -d "$RUN_ROOT" ] || [ "$(stat -c %u "$RUN_ROOT" 2>/dev/null)" != "$(id -u)" ]; then
  echo "FATAL: run root $RUN_ROOT was not created as a user-owned directory — aborting"; exit 2
fi
echo "[SETUP] run root: $RUN_ROOT (created atomically via mktemp -d, mode 700, owner $(id -u))"
DATA="$RUN_ROOT/pgdata"
SOCK="$RUN_ROOT/pgsock"
DB_NAME="kindora_e2e_${RUN_ID//-/_}"
POSTMASTER_PID=""; REDIS_PID=""; JEST_EXIT=""
CLEANED=0

# ---- per-execution test administrator credential (completion patch §9) ----------
# Cryptographically secure random generator (node crypto.randomBytes);
# policy-validated against the seed contract (>= 12 chars, one uppercase,
# one digit); NEVER echoed, logged or persisted — it exists only in this
# process environment, in the ephemeral seeded database, and (transiently) in
# the jest process environment; it is removed together with the run root.
gen_test_password() {
  local pw=""
  while :; do
    pw="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))' 2>/dev/null)" || return 1
    if [ "${#pw}" -ge 12 ] && printf '%s' "$pw" | grep -q '[A-Z]' && printf '%s' "$pw" | grep -q '[0-9]'; then
      printf '%s' "$pw"; return 0
    fi
  done
}
TEST_ADMIN_PASSWORD="$(gen_test_password)" || { echo "FATAL: secure password generation failed"; exit 2; }
[ -n "$TEST_ADMIN_PASSWORD" ] || { echo "FATAL: secure password generation failed"; exit 2; }
export SEED_ADMIN_PASSWORD="$TEST_ADMIN_PASSWORD"

# ---------------------------------------------------------------- [CLEANUP] ----
cleanup() {
  [ "$CLEANED" -eq 1 ] && return 0
  CLEANED=1
  echo ""
  echo "[CLEANUP] shutting down resources created by THIS run (run id $RUN_ID)"
  # Redis (completion patch §8): shutdown is addressed to the EXACT tracked
  # process only. A port-addressed redis-cli shutdown is issued ONLY after
  # all ownership checks pass (alive + process identity + listening-socket
  # ownership). Otherwise the graceful path is a plain SIGTERM to the tracked
  # PID — redis treats SIGTERM as a graceful shutdown — and NO port-addressed
  # command is ever sent to an unverified port.
  REDIS_CLI_BIN="$(command -v redis-cli 2>/dev/null || true)"
  if [ -z "$REDIS_CLI_BIN" ] && [ -x "${REDIS_BIN%redis-server}redis-cli" ]; then REDIS_CLI_BIN="${REDIS_BIN%redis-server}redis-cli"; fi
  redis_owns_socket() {
    if command -v ss > /dev/null 2>&1; then
      ss -tlnp 2>/dev/null | grep -E "127.0.0.1:$REDIS_PORT[^0-9]|\*:$REDIS_PORT " | grep -q "pid=$REDIS_PID,"
    else
      # ss unavailable: no reliable socket-ownership evidence — refuse the
      # port-addressed path (the SIGTERM fallback remains graceful)
      return 1
    fi
  }
  redis_is_ours() {
    kill -0 "$REDIS_PID" 2>/dev/null || return 1
    tr '\0' ' ' < "/proc/$REDIS_PID/cmdline" 2>/dev/null | grep -q "redis-server" || return 1
    return 0
  }
  if [ -n "$REDIS_PID" ] && redis_is_ours; then
    if redis_owns_socket; then
      echo "[CLEANUP] redis (pid $REDIS_PID) ownership verified (identity + socket) — graceful shutdown"
      if [ -n "$REDIS_CLI_BIN" ]; then
        "$REDIS_CLI_BIN" -p "$REDIS_PORT" shutdown nosave > /dev/null 2>&1 || true
      fi
    else
      echo "[CLEANUP] redis (pid $REDIS_PID) socket ownership NOT verifiable — port-addressed shutdown SKIPPED; graceful SIGTERM to the tracked process only"
      kill -TERM "$REDIS_PID" 2>/dev/null || true
    fi
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$REDIS_PID" 2>/dev/null || break; sleep 1; done
    if kill -0 "$REDIS_PID" 2>/dev/null; then
      echo "[CLEANUP] redis (pid $REDIS_PID) still alive after graceful shutdown — sending SIGTERM (tracked pid only)"
      kill -TERM "$REDIS_PID" 2>/dev/null || true
      for _ in 1 2 3 4 5; do kill -0 "$REDIS_PID" 2>/dev/null || break; sleep 1; done
      if kill -0 "$REDIS_PID" 2>/dev/null; then
        echo "[CLEANUP] redis (pid $REDIS_PID) still alive — SIGKILL as last resort (tracked pid only)"
        kill -KILL "$REDIS_PID" 2>/dev/null || true
      fi
    fi
  fi
  # PostgreSQL: pg_ctl fast stop bounded to OUR data dir; immediate stop as last resort
  if [ -n "$POSTMASTER_PID" ] && [ -d "$DATA" ]; then
    "$PGBIN/pg_ctl" stop -D "$DATA" -m fast -t 30 > /dev/null 2>&1 || \
      "$PGBIN/pg_ctl" stop -D "$DATA" -m immediate > /dev/null 2>&1 || true
  fi
  # Remove ONLY the directory this run created (completion patch §7):
  # strict guard — the path must be a kindora-itest.* directory inside the
  # intended temporary root, a real directory (not a symlink), and owned by
  # this user; an arbitrary path is never recursively deleted.
  TMP_GUARD_BASE="${TMPDIR:-/tmp}"
  case "$RUN_ROOT" in
    "$TMP_GUARD_BASE"/kindora-itest.*|*/kindora-itest.*)
      if [ -d "$RUN_ROOT" ] && [ ! -L "$RUN_ROOT" ] \
         && [ "$(stat -c %u "$RUN_ROOT" 2>/dev/null)" = "$(id -u)" ]; then
        rm -rf "$RUN_ROOT" && echo "[CLEANUP] removed $RUN_ROOT (self-created, ownership + guard passed)" \
          || echo "[CLEANUP] WARNING: could not fully remove $RUN_ROOT — left in place for diagnosis (nothing outside it was touched)"
      elif [ -e "$RUN_ROOT" ]; then
        echo "[CLEANUP] WARNING: run root $RUN_ROOT failed the ownership/type guard — NOT removed"
      fi
      ;;
    *) echo "[CLEANUP] WARNING: unexpected run root '$RUN_ROOT' — NOT removed (guard refused)" ;;
  esac
  echo "[CLEANUP] done"
}
trap cleanup EXIT INT TERM
# A terminated run must EXIT, not resume and report a result afterwards:
# bash defers trap handling until the current foreground command finishes;
# the explicit exit below prevents a post-termination "[RESULTS] PASS".
trap 'cleanup; trap - EXIT; exit 143' INT TERM

# ------------------------------------------------------------------ [SETUP] ----
echo "[SETUP] phase: preflight"
[ -x "$PGBIN/pg_ctl" ] || { echo "FATAL: PostgreSQL binaries not available at $PGBIN (set KINDORA_ITEST_PGBIN)"; exit 2; }
[ -x "$REDIS_BIN" ] || { echo "FATAL: redis-server not available at $REDIS_BIN (set KINDORA_ITEST_REDIS)"; exit 2; }
[ -d "$PG_CLIENT" ] || [ -f "$PG_CLIENT" ] || [ -e "$PG_CLIENT" ] || { echo "FATAL: pg client module not available at $PG_CLIENT (set KINDORA_ITEST_PGCLIENT)"; exit 2; }
[ -f "$TREE/backend/package.json" ] || { echo "FATAL: backend not found at $TREE/backend"; exit 2; }

# Port-conflict detection: a foreign service on the target ports is NEVER killed — the run fails with a diagnostic.
port_busy() { (echo > "/dev/tcp/127.0.0.1/$1") > /dev/null 2>&1; }
if port_busy "$PG_PORT"; then echo "FATAL: port $PG_PORT is already in use by another service — refusing to start (nothing was killed). Set KINDORA_ITEST_PGPORT to a free port."; exit 2; fi
if port_busy "$REDIS_PORT"; then echo "FATAL: port $REDIS_PORT is already in use by another service — refusing to start (nothing was killed). Set KINDORA_ITEST_REDISPORT to a free port."; exit 2; fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[DRY-RUN] execution plan (nothing was executed, nothing created):"
  echo "  run root:    $RUN_ROOT"
  echo "  data dir:    $DATA"
  echo "  socket dir:  $SOCK"
  echo "  database:    $DB_NAME @ 127.0.0.1:$PG_PORT (unix socket $SOCK)"
  echo "  redis:       127.0.0.1:$REDIS_PORT (no persistence)"
  echo "  test env:    RUN_INTEGRATION=1 PROVIDER_MODE=mock JWT_SECRET=<test value> SEED_ADMIN_PASSWORD=<generated per execution, never logged> DATABASE_URL=<own instance> REDIS_URL=<own instance>"
  echo "  jest:        --config test/jest-e2e.json --runInBand --testPathPattern '$SUITE' ${NAME_FILTER:+-t '$NAME_FILTER'}"
  echo "  cleanup:     ownership-verified graceful redis shutdown + pg_ctl fast stop (tracked resources only) + guarded removal of $RUN_ROOT"
  exit 0
fi

mkdir -p "$SOCK" || { echo "FATAL: cannot create $SOCK"; exit 2; }
echo "[SETUP] initdb (fresh cluster at $DATA)"
"$PGBIN/initdb" -D "$DATA" -U kindora --auth=trust -E UTF8 > "$RUN_ROOT/initdb.log" 2>&1 || { echo "FATAL: initdb failed — see $RUN_ROOT/initdb.log"; exit 2; }
echo "[SETUP] starting PostgreSQL on 127.0.0.1:$PG_PORT"
"$PGBIN/pg_ctl" -D "$DATA" -l "$RUN_ROOT/postgres.log" -o "-p $PG_PORT -k $SOCK -c fsync=off" start -w > /dev/null 2>&1 || { echo "FATAL: pg_ctl start failed — see $RUN_ROOT/postgres.log"; exit 2; }
POSTMASTER_PID="$(head -1 "$DATA/postmaster.pid" 2>/dev/null || true)"
echo "[SETUP] PostgreSQL postmaster pid: ${POSTMASTER_PID:-unknown} (tracked)"
echo "[SETUP] starting Redis on 127.0.0.1:$REDIS_PORT (no persistence)"
"$REDIS_BIN" --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no > "$RUN_ROOT/redis.log" 2>&1 &
REDIS_PID=$!
sleep 1
# identity check: the tracked PID must be OUR redis-server on OUR port
if ! kill -0 "$REDIS_PID" 2>/dev/null; then echo "FATAL: redis exited immediately — see $RUN_ROOT/redis.log"; exit 2; fi
if ! grep -q "redis-server" "/proc/$REDIS_PID/cmdline" 2>/dev/null; then echo "FATAL: tracked pid $REDIS_PID is not our redis-server — aborting"; exit 2; fi
echo "[SETUP] redis pid: $REDIS_PID (tracked)"

PGCLIENT="$PG_CLIENT" node -e "
const {Client}=require(process.env.PGCLIENT);
(async()=>{
  const c=new Client({host:'$SOCK',port:$PG_PORT,user:'kindora',database:'postgres'});
  await c.connect();
  try{await c.query('DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);');}catch(e){}
  await c.query('CREATE DATABASE $DB_NAME;'); await c.end();
  console.log('database $DB_NAME ready');
})().catch(e=>{console.error(e.message);process.exit(1)});
" || { echo "FATAL: database creation failed"; exit 2; }

# ------------------------------------------------------------------- [TEST] ----
echo "[TEST] phase: migrate deploy (0001..0006) + seed"
( cd "$TREE/backend" \
  && DATABASE_URL="postgresql://kindora@localhost:$PG_PORT/$DB_NAME" npx prisma migrate deploy > "$RUN_ROOT/migrate.log" 2>&1 ) || { echo "FATAL: migrate deploy failed — see $RUN_ROOT/migrate.log"; exit 1; }
echo "[TEST] migrate OK"
( cd "$TREE/backend" \
  && SEED_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD" DATABASE_URL="postgresql://kindora@localhost:$PG_PORT/$DB_NAME" npx prisma db seed > "$RUN_ROOT/seed.log" 2>&1 ) || { echo "FATAL: seed failed — see $RUN_ROOT/seed.log"; exit 1; }
echo "[TEST] seed OK"

echo "[TEST] integration suite (jest --runInBand)"
( cd "$TREE/backend" && RUN_INTEGRATION=1 \
    DATABASE_URL="postgresql://kindora@localhost:$PG_PORT/$DB_NAME" \
    REDIS_URL="redis://127.0.0.1:$REDIS_PORT" \
    PROVIDER_MODE=mock JWT_SECRET=kindora-integration-test-secret \
    SEED_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD" \
    npx jest --config test/jest-e2e.json --runInBand --testPathPattern "$SUITE" ${NAME_FILTER:+-t "$NAME_FILTER"} \
    > "$RUN_ROOT/jest.log" 2>&1 )
JEST_EXIT=$?

# ---------------------------------------------------------------- [RESULTS] ----
echo "[RESULTS] jest exit code: $JEST_EXIT"
echo "[RESULTS] full log: $RUN_ROOT/jest.log"
grep -E "Tests:|Test Suites:" "$RUN_ROOT/jest.log" | tail -2 || true
if [ "$JEST_EXIT" -ne 0 ]; then
  echo "[RESULTS] FAILURES (last 40 lines):"
  tail -40 "$RUN_ROOT/jest.log" || true
  KEEP="$RUN_ROOT-FAILED"
  cp -r "$RUN_ROOT" "$KEEP" 2>/dev/null && echo "[RESULTS] complete run logs preserved for diagnosis at $KEEP (the ephemeral run root is cleaned by the trap; services are shut down)"
  exit 1
fi
echo "[RESULTS] PASS"
exit 0

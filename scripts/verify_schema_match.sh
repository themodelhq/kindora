#!/usr/bin/env bash
# Definitive structural check: migrations 0001..0006 must produce EXACTLY prisma/schema.prisma
#
# v1.0.14 correction (release prompt Phase 6): the previous revision killed
# ANY host PostgreSQL (`pkill -9 postgres`) and reused fixed shared
# /tmp/kindora-pgdata paths with unrestricted rm -rf. This revision:
#   * NO process killing at all — port-conflict detection with a clear error;
#   * a UNIQUE per-run data/socket directory created ATOMICALLY with mktemp -d
#     (v1.0.14 completion patch §7: unpredictable name, never an existing
#     directory, mode 700, ownership-checked guard), removed only after a
#     strict self-created-path + ownership guard, with trap-based cleanup;
#   * layout-aware paths (works from the checkout and from a release
#     extraction).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"
PGBIN="${KINDORA_ITEST_PGBIN:-/tmp/pgtest/node_modules/@embedded-postgres/linux-x64/native/bin}"
export PATH="$PGBIN:$PATH"

command -v pg_ctl > /dev/null 2>&1 || { echo "FATAL: pg_ctl not available at $PGBIN"; exit 2; }
command -v node > /dev/null 2>&1 || { echo "FATAL: node not available"; exit 2; }

# completion patch §7: validate TMPDIR when configured, then create the run
# root atomically (mktemp -d) with restrictive permissions
TMP_BASE="${TMPDIR:-/tmp}"
[ -d "$TMP_BASE" ] || { echo "FATAL: TMPDIR '$TMP_BASE' is not a directory"; exit 2; }
[ -w "$TMP_BASE" ] || { echo "FATAL: TMPDIR '$TMP_BASE' is not writable by this user"; exit 2; }
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kindora-schemacheck.XXXXXXXX")" || { echo "FATAL: atomic temporary-directory creation failed"; exit 2; }
chmod 700 "$RUN_ROOT" 2>/dev/null || true
DATA="$RUN_ROOT/pgdata"
SOCK="$RUN_ROOT/pgsock"
PG_PORT="${KINDORA_ITEST_PGPORT:-5433}"
CLEANED=0
cleanup() {
  [ "$CLEANED" -eq 1 ] && return 0
  CLEANED=1
  if [ -d "$DATA" ]; then
    "$PGBIN/pg_ctl" stop -D "$DATA" -m fast -t 30 > /dev/null 2>&1 || \
      "$PGBIN/pg_ctl" stop -D "$DATA" -m immediate > /dev/null 2>&1 || true
  fi
  case "$RUN_ROOT" in
    */kindora-schemacheck.*)
      if [ -d "$RUN_ROOT" ] && [ ! -L "$RUN_ROOT" ] && [ "$(stat -c %u "$RUN_ROOT" 2>/dev/null)" = "$(id -u)" ]; then
        rm -rf "$RUN_ROOT" || echo "WARNING: could not fully remove $RUN_ROOT — left in place (nothing outside it was touched)"
      fi ;;
    *) echo "WARNING: unexpected run root '$RUN_ROOT' — NOT removed" ;;
  esac
}
trap cleanup EXIT INT TERM

# port-conflict detection: a foreign service is never killed
if (echo > "/dev/tcp/127.0.0.1/$PG_PORT") > /dev/null 2>&1; then
  echo "FATAL: port $PG_PORT is already in use by another service — refusing to start (nothing was killed). Set KINDORA_ITEST_PGPORT to a free port."
  exit 2
fi

mkdir -p "$SOCK"
"$PGBIN/initdb" -D "$DATA" -U kindora --auth=trust -E UTF8 > "$RUN_ROOT/initdb.log" 2>&1 || { echo "FATAL: initdb failed — see $RUN_ROOT/initdb.log"; exit 2; }
"$PGBIN/pg_ctl" -D "$DATA" -l "$RUN_ROOT/postgres.log" -o "-p $PG_PORT -k $SOCK -c fsync=off" start -w > /dev/null 2>&1 || { echo "FATAL: pg_ctl start failed — see $RUN_ROOT/postgres.log"; exit 2; }

# the shadow database must EXIST for prisma migrate diff; create it in the
# runner's own ephemeral cluster (pg client module, same pattern as the safe runner)
PGCLIENT="${KINDORA_ITEST_PGCLIENT:-/tmp/pgtest/node_modules/pg}"
PGCLIENT="$PGCLIENT" node -e "
const {Client}=require(process.env.PGCLIENT);
(async()=>{
  const c=new Client({host:'$SOCK',port:$PG_PORT,user:'kindora',database:'postgres'});
  await c.connect();
  try{await c.query('DROP DATABASE IF EXISTS kindora_shadow WITH (FORCE);');}catch(e){}
  await c.query('CREATE DATABASE kindora_shadow;'); await c.end();
  console.log('shadow database ready');
})().catch(e=>{console.error(e.message);process.exit(1)});
" || { echo "FATAL: shadow database creation failed"; exit 2; }

cd "$TREE/backend" || exit 2
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://kindora@localhost:$PG_PORT/kindora_shadow" \
  --exit-code > "$RUN_ROOT/prisma-diff.txt" 2>&1
DIFF_EXIT=$?
echo "prisma migrate diff exit code: $DIFF_EXIT (0 = no difference)"
head -30 "$RUN_ROOT/prisma-diff.txt"

[ "$DIFF_EXIT" = "0" ] && echo "STRUCTURAL_CHECK=PASS migrations match schema exactly" || echo "STRUCTURAL_CHECK=FAIL differences detected (see $RUN_ROOT/prisma-diff.txt)"
exit "$DIFF_EXIT"

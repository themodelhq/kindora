#!/usr/bin/env bash
# KINDORA v1.0.13 final backup (master prompt §8.2B): post-release source
# snapshot + manifest + archive verification.
#
# - Backs up the CURRENT application tree (the directory containing this
#   scripts/ folder) — source only; node_modules/dist/caches/logs and any
#   real-secret env files are excluded and the exclusions are documented.
# - Generates a SHA-256 manifest over EVERY archived file and an external
#   archive-checksum sidecar.
# - Independently extracts the archive and verifies EVERY manifest entry.
# - Fails if any REQUIRED source file is missing from the snapshot.
# - The archive is built deterministically (sorted entries, fixed mtime,
#   gzip -n) so the recorded SHA-256 is reproducible byte-for-byte.
#
# Usage: bash scripts/v113_final_backup.sh [output-dir]
# Output: KINDORA_v1.0.13_FINAL_BACKUP.tar.gz
#         KINDORA_v1.0.13_FINAL_BACKUP_MANIFEST.sha256
#         KINDORA_v1.0.13_FINAL_BACKUP.tar.gz.sha256
# Exit codes: 0 = verified; 1 = verification failure; 2 = environment error.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-}"
[ -n "$OUT_DIR" ] || OUT_DIR="${BACKUP_OUTPUT_DIR:-$(cd "$TREE/.." && pwd)/backups}"
mkdir -p "$OUT_DIR" || { echo "FATAL: cannot create $OUT_DIR"; exit 2; }

echo "== KINDORA v1.0.13 final backup (source snapshot of $TREE) =="

for cmd in tar sha256sum find gzip stat; do
  command -v "$cmd" > /dev/null 2>&1 || { echo "FATAL: required command '$cmd' not available"; exit 2; }
done

ARCHIVE="$OUT_DIR/KINDORA_v1.0.13_FINAL_BACKUP.tar.gz"
MANIFEST="$OUT_DIR/KINDORA_v1.0.13_FINAL_BACKUP_MANIFEST.sha256"
SIDECAR="$OUT_DIR/KINDORA_v1.0.13_FINAL_BACKUP.tar.gz.sha256"
WORK="$(mktemp -d /tmp/v113-final.XXXXXX)" || exit 2
STAGE="$WORK/kindora"
mkdir -p "$STAGE" || { echo "FATAL: cannot create staging directory"; exit 2; }
trap 'rm -rf "$WORK"' EXIT

# --- required source files (fail if missing BEFORE archiving, §8.2B) ----------
REQUIRED=(
  backend/src/payouts/adapters/flutterwave-payout.adapter.ts
  backend/src/payouts/adapters/flutterwave-envelope-null-v113.spec.ts
  backend/src/payouts/adapters/flutterwave-pagination-integrity-v112.spec.ts
  backend/prisma/schema.prisma
  backend/package.json
  frontend/package.json
  workers/package.json
  backend/prisma/migrations
  scripts/v113_phase0_backup.sh
  scripts/v113_final_backup.sh
  scripts/verify_release_zip_v113.sh
  scripts/v113_baseline_ab_comparison.sh
  docs/KINDORA_v1.0.13_RELEASE_NOTES.md
  docs/KINDORA_v1.0.13_TEST_REPORT.md
  docs/FINAL_ENGINEERING_REPORT_V1.0.13.md
  docs/PROVIDER_INTEGRATION_V1.0.13.md
  docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.13.md
  README.md
  render.yaml
)
MISSING=0
for f in "${REQUIRED[@]}"; do
  [ -e "$TREE/$f" ] || { echo "MISSING REQUIRED SOURCE: $f"; MISSING=$((MISSING+1)); }
done
[ "$MISSING" -eq 0 ] || { echo "FATAL: $MISSING required source file(s) missing — refusing to create an incomplete backup"; exit 1; }
echo "required source probe: all ${#REQUIRED[@]} present"

# --- snapshot (documented exclusions: generated deps/build/caches/secrets) -----
echo "== snapshot =="
tar -cf - -C "$TREE" \
  --exclude='backend/node_modules' \
  --exclude='frontend/node_modules' \
  --exclude='workers/node_modules' \
  --exclude='backend/dist' \
  --exclude='frontend/dist' \
  --exclude='workers/dist' \
  --exclude='*.tsbuildinfo' \
  --exclude='.env' --exclude='.env.local' --exclude='.env.*.local' \
  --exclude='*.log' \
  . | tar -x -C "$STAGE" || { echo "FATAL: snapshot failed"; exit 1; }

echo "== archive + manifest (deterministic) =="
SRC_FILES=$(find "$STAGE" -type f | wc -l)
echo "files in final backup: $SRC_FILES"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='1970-01-01 00:00:00Z' -c -C "$WORK" kindora | gzip -n > "$ARCHIVE" || { echo "FATAL: tar/gzip failed"; exit 1; }
BYTES=$(stat -c%s "$ARCHIVE")
SHA=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
echo "backup bytes: $BYTES"
echo "backup sha256: $SHA"
( cd "$WORK" && find kindora -type f -print0 | sort -z | xargs -0 sha256sum ) > "$MANIFEST"
echo "manifest entries: $(wc -l < "$MANIFEST")"
printf '%s  %s\n' "$SHA" "$(basename "$ARCHIVE")" > "$SIDECAR"

# --- verification: integrity + independent extraction + EVERY entry ------------
echo "== archive integrity =="
gzip -t "$ARCHIVE" || { echo "FATAL: gzip integrity failed"; exit 1; }
tar -tzf "$ARCHIVE" > /dev/null || { echo "FATAL: tar listing failed"; exit 1; }

echo "== independent extraction + EVERY-entry verification =="
VERIFY_DIR="$(mktemp -d /tmp/v113-final-verify.XXXXXX)"
tar -xzf "$ARCHIVE" -C "$VERIFY_DIR" || { echo "FATAL: independent extraction failed"; exit 1; }
FAILED=0
while IFS= read -r line; do
  hash="${line%% *}"
  file="${line#*  }"
  [ -f "$VERIFY_DIR/$file" ] || { echo "MISSING: $file"; FAILED=$((FAILED+1)); continue; }
  actual=$(sha256sum "$VERIFY_DIR/$file" | cut -d' ' -f1)
  [ "$actual" = "$hash" ] || { echo "HASH MISMATCH: $file"; FAILED=$((FAILED+1)); }
done < "$MANIFEST"
EXTRACTED=$(find "$VERIFY_DIR" -type f | wc -l)
echo "independently extracted files: $EXTRACTED; verification failures: $FAILED"

for f in "${REQUIRED[@]}"; do
  [ -e "$VERIFY_DIR/kindora/$f" ] || { echo "MISSING REQUIRED after extraction: $f"; FAILED=$((FAILED+1)); }
done
rm -rf "$VERIFY_DIR"

if [ "$FAILED" -ne 0 ] || [ "$EXTRACTED" -ne "$SRC_FILES" ]; then
  echo ""
  echo "FATAL: final backup verification FAILED"
  exit 1
fi

echo ""
echo "FINAL BACKUP OK: $ARCHIVE"
echo "  bytes: $BYTES  sha256: $SHA  files: $SRC_FILES  manifest: ALL VERIFIED"
exit 0

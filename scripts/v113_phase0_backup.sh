#!/usr/bin/env bash
# KINDORA v1.0.13 Phase-0 (master prompt §3): baseline inspection record +
# verified restorable backup of the PRISTINE v1.0.12 release source tree.
#
# Works in BOTH layouts:
#   - the development checkout (git toplevel contains kindora-v110/kindora):
#     the backup is built from the PINNED v1.0.12 release revision via
#     `git archive`, so the pristine baseline cannot drift;
#   - a clean extraction of KINDORA_v1.0.13_SECURITY_COMPLETE.zip (no
#     kindora-v110 layout): the backup is built from the extraction itself,
#     excluding only generated dependencies, build output, caches and any
#     secret-bearing local files — every exclusion is documented in the
#     phase-0 record.
#
# The backup is NOT accepted merely because the tar command completed: the
# archive is integrity-checked, independently extracted into a separate
# directory and EVERY manifest entry is re-verified byte-for-byte.
#
# Usage: bash scripts/v113_phase0_backup.sh [release-rev]
#   release-rev — git rev of the v1.0.12 release tree; default: autodetected
#                 from the release packaging commit message.
# Output: backups/KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz
#         backups/KINDORA_v1.0.12_BASELINE_BACKUP_MANIFEST.sha256
#         backups/KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz.sha256
#         backups/v1.0.13_phase0_baseline_record.txt
# Exit codes: 0 = verified; 1 = verification failure (STOP CONDITION §3.2);
#             2 = environment/argument error.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)" # the application tree (contains scripts/)

echo "== KINDORA v1.0.13 Phase-0: baseline inspection + verified backup =="

# --- required commands (§8.3) -------------------------------------------------
for cmd in tar sha256sum find gzip stat sort; do
  command -v "$cmd" > /dev/null 2>&1 || { echo "FATAL: required command '$cmd' not available"; exit 2; }
done

# --- locate the repository root (git optional in a clean extraction) ----------
GIT_AVAILABLE=0
RELEASE_REV="${1:-}"
REPO=""
if command -v git > /dev/null 2>&1; then
  REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$REPO" ]; then
    GIT_AVAILABLE=1
    [ -d "$REPO/.git" ] || GIT_AVAILABLE=0
  fi
fi

BACKUP_DIR="${BACKUP_OUTPUT_DIR:-$REPO/backups}"
[ -n "$BACKUP_DIR" ] || BACKUP_DIR="$(cd "$TREE/.." && pwd)/backups"
mkdir -p "$BACKUP_DIR" || { echo "FATAL: cannot create $BACKUP_DIR"; exit 2; }

BASELINE="$BACKUP_DIR/KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz"
MANIFEST="$BACKUP_DIR/KINDORA_v1.0.12_BASELINE_BACKUP_MANIFEST.sha256"
SIDECAR="$BACKUP_DIR/KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz.sha256"
RECORD="$BACKUP_DIR/v1.0.13_phase0_baseline_record.txt"

# --- §3.1 baseline inspection record ------------------------------------------
RECORD_TMP="$(mktemp)" || exit 2
ZIP="$BACKUP_DIR/../download/KINDORA_v1.0.12_SECURITY_COMPLETE.zip"
if [ "$GIT_AVAILABLE" -eq 1 ] && [ -f "$ZIP" ]; then
  for cmd in unzip zipinfo; do
    command -v "$cmd" > /dev/null 2>&1 || { echo "FATAL: required command '$cmd' not available"; exit 2; }
  done
fi
{
  echo "KINDORA v1.0.13 Phase-0 baseline inspection record (master prompt §3.1)"
  echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "layout: $([ "$GIT_AVAILABLE" -eq 1 ] && echo "development checkout (git root: $REPO)" || echo "clean extraction (no git) — backup from the extraction itself")"
  if [ "$GIT_AVAILABLE" -eq 1 ]; then
    echo "git_head_at_inspection: $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unavailable)"
    echo "working_tree_tracked_changes: $(git -C "$REPO" status --short 2>/dev/null | grep -cv '^??' || true)"
  fi
  echo ""
  echo "## baseline release archive figures"
  echo "archive_filename: KINDORA_v1.0.12_SECURITY_COMPLETE.zip"
  if [ -f "$ZIP" ]; then
    echo "archive_sha256: $(sha256sum "$ZIP" | cut -d' ' -f1)"
    echo "archive_bytes: $(stat -c%s "$ZIP")"
    echo "zip_entry_count: $(unzip -l "$ZIP" | tail -1 | awk '{print $2}')"
    echo "zip_file_count: $(zipinfo -1 "$ZIP" | grep -vc '/$')"
    echo "uncompressed_bytes: $(unzip -l "$ZIP" | tail -1 | awk '{print $1}')"
    echo "zip_integrity: $(unzip -t "$ZIP" > /dev/null 2>&1 && echo OK || echo FAILED)"
    echo "internal_manifest_entries: $(unzip -p "$ZIP" kindora-v1.0.12/SHA256SUMS.txt 2>/dev/null | grep -c . || echo 0)"
  else
    echo "archive: NOT PRESENT in this workspace"
  fi
  echo ""
  echo "## baseline source tree figures (backup source)"
  echo "existing_release_version: v1.0.12"
  echo "existing_database_migrations: $(find "$TREE/backend/prisma/migrations" -maxdepth 1 -type d -name '0*' 2>/dev/null | wc -l)"
  echo "existing_internal_manifest: SHA256SUMS.txt (inside the v1.0.12 archive)"
  echo "existing_backup_archives: nested KINDORA_v1.0.11_PRE_V112_BACKUP.tar.gz + KINDORA_v1.0.12_FINAL_BACKUP.tar.gz (inside the v1.0.12 archive)"
} > "$RECORD_TMP"
mv "$RECORD_TMP" "$RECORD"
cat "$RECORD"

# --- build the pristine source into a staging directory ------------------------
WORK="$(mktemp -d /tmp/v113-phase0.XXXXXX)" || exit 2
STAGE="$WORK/kindora-v1.0.12"
mkdir -p "$STAGE"

if [ "$GIT_AVAILABLE" -eq 1 ]; then
  # development checkout: pin the pristine v1.0.12 release revision
  if [ -z "$RELEASE_REV" ]; then
    RELEASE_REV="$(git -C "$REPO" log --format="%h %s" | grep "KINDORA v1.0.12 release packaging (FINAL)" | head -1 | cut -d' ' -f1)"
  fi
  [ -n "$RELEASE_REV" ] || { echo "FATAL: could not pin the v1.0.12 release revision (pass it as argument 1)"; exit 2; }
  if git -C "$REPO" cat-file -e "$RELEASE_REV:kindora-v110/kindora" 2>/dev/null; then
    echo "== backing up from pinned release rev $RELEASE_REV:kindora-v110/kindora =="
    git -C "$REPO" archive "$RELEASE_REV:kindora-v110/kindora" --format=tar | tar -x -C "$STAGE" || { echo "FATAL: git archive extraction failed"; exit 1; }
  else
    echo "no kindora-v110/kindora tree at $RELEASE_REV — falling back to the extraction layout"
    GIT_AVAILABLE=0
  fi
fi
if [ "$GIT_AVAILABLE" -eq 0 ] || [ ! -d "$STAGE/backend" ]; then
  echo "== backing up from the extraction itself ($TREE) =="
  RELEASE_REV="extraction"
  # documented exclusions (§3.2): generated dependencies, build output,
  # caches, logs and any secret-bearing local files. None of them carry
  # release content: node_modules/dist are reproducible from the lockfiles.
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
    . | tar -x -C "$STAGE" || { echo "FATAL: extraction backup failed"; exit 1; }
fi

# existing release + backup metadata (sidecars only — the tarballs themselves
# are recoverable from the committed release archive; see the record)
if [ -d "$BACKUP_DIR" ] && [ "$BACKUP_DIR" != "$STAGE" ]; then
  mkdir -p "$STAGE/release-metadata"
  for f in "$BACKUP_DIR"/v1.0.11_pre_v112.sha256 "$BACKUP_DIR"/v1.0.11_pre_v112_MANIFEST.sha256 \
           "$BACKUP_DIR"/v1.0.11_pre_v112_source_commit.txt "$BACKUP_DIR"/v1.0.12_final.sha256 \
           "$BACKUP_DIR"/v1.0.12_final_archive.sha256 "$BACKUP_DIR"/../download/KINDORA_v1.0.12_zip.sha256 \
           "$BACKUP_DIR"/../download/KINDORA_v1.0.11_zip.sha256; do
    [ -f "$f" ] && cp -p "$f" "$STAGE/release-metadata/"
  done
fi

# --- archive + manifest --------------------------------------------------------
echo "== archive + manifest =="
SRC_FILES=$(find "$STAGE" -type f | wc -l)
echo "files in baseline backup: $SRC_FILES"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='1970-01-01 00:00:00Z' -c -C "$WORK" kindora-v1.0.12 | gzip -n > "$BASELINE" || { echo "FATAL: tar/gzip failed"; exit 1; }
BYTES=$(stat -c%s "$BASELINE")
SHA=$(sha256sum "$BASELINE" | cut -d' ' -f1)
echo "backup bytes: $BYTES"
echo "backup sha256: $SHA"
( cd "$WORK" && find kindora-v1.0.12 -type f -print0 | sort -z | xargs -0 sha256sum ) > "$MANIFEST"
echo "manifest entries: $(wc -l < "$MANIFEST")"
printf '%s  %s\n' "$SHA" "$(basename "$BASELINE")" > "$SIDECAR"

# --- §3.2 verification: integrity + independent extraction + EVERY entry -------
echo "== archive integrity =="
gzip -t "$BASELINE" || { echo "FATAL: gzip integrity failed"; exit 1; }
tar -tzf "$BASELINE" > /dev/null || { echo "FATAL: tar listing failed"; exit 1; }

echo "== independent extraction + EVERY-entry verification (§3.2) =="
VERIFY_DIR="$(mktemp -d /tmp/v113-phase0-verify.XXXXXX)"
tar -xzf "$BASELINE" -C "$VERIFY_DIR" || { echo "FATAL: independent extraction failed"; exit 1; }
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

for d in backend frontend workers docs scripts; do
  [ -d "$VERIFY_DIR/kindora-v1.0.12/$d" ] || { echo "FATAL: missing directory $d in the extracted backup"; FAILED=$((FAILED+1)); }
done
MIGS=$(find "$VERIFY_DIR/kindora-v1.0.12/backend/prisma/migrations" -maxdepth 1 -type d -name '0*' 2>/dev/null | wc -l)
echo "migrations in extracted backup: $MIGS"
rm -rf "$VERIFY_DIR" "$WORK"

if [ "$FAILED" -ne 0 ] || [ "$EXTRACTED" -ne "$SRC_FILES" ]; then
  echo ""
  echo "FATAL: baseline backup verification FAILED (§3.2 STOP CONDITION — do not begin source modifications)"
  exit 1
fi

{
  echo ""
  echo "## baseline backup verification result (§3.2)"
  echo "backup_filename: KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz"
  echo "backup_source: $([ "$RELEASE_REV" = "extraction" ] && echo "clean extraction" || echo "git rev $RELEASE_REV (pristine v1.0.12 release tree)")"
  echo "backup_bytes: $BYTES"
  echo "backup_sha256: $SHA"
  echo "backup_file_count: $SRC_FILES"
  echo "manifest_entries: $(wc -l < "$MANIFEST")"
  echo "manifest_verification: ALL PASSED (failures=$FAILED)"
  echo "independent_extraction: PASSED ($EXTRACTED files)"
  echo "documented_exclusions: node_modules (reproducible via lockfiles), dist build output, *.tsbuildinfo, caches/logs, real-secret env files (.env/.env.local — must never exist in the tracked tree)"
} >> "$RECORD"

echo ""
echo "PHASE0_BASELINE_BACKUP_OK"
exit 0

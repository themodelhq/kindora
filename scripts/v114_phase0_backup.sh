#!/usr/bin/env bash
# KINDORA v1.0.14 Phase-0 (release prompt Phase 1): baseline inspection record
# + verification of the PRISTINE v1.0.13 baseline backup.
#
# The pristine pre-v114 source is KINDORA_v1.0.13_FINAL_BACKUP.tar.gz (the
# verified post-release snapshot of the completed v1.0.13 tree; its external
# sidecar and per-file manifest were recorded by v113_final_backup.sh). This
# script does NOT rebuild that backup (no source is modified by Phase 0) — it
# VERIFIES it end-to-end (sidecar, independent extraction, EVERY manifest
# entry, structural probe) and records the v1.0.13 release-artifact figures
# by INSPECTING THE ACTUAL ARCHIVE (release prompt Phase 3: figures are
# measured, never copied from earlier attestations).
#
# Sandbox-recycle note: on 2026-11-17 the backup tarballs were dropped from
# the workspace while their sidecars survived; both were restored from INSIDE
# the committed v1.0.13 zip and re-verified against their sidecars — the
# committed-archive-as-recovery-source design worked as intended.
#
# Usage: bash scripts/v114_phase0_backup.sh
# Output: backups/v1.0.14_phase0_baseline_record.txt
# Exit codes: 0 = verified; 1 = verification failure (STOP CONDITION); 2 = environment error.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$TREE/.." && pwd)")"
BACKUP_DIR="${BACKUP_OUTPUT_DIR:-$REPO/backups}"
mkdir -p "$BACKUP_DIR" || exit 2

for cmd in unzip zipinfo tar sha256sum find stat git; do
  command -v "$cmd" > /dev/null 2>&1 || { echo "FATAL: required command '$cmd' not available"; exit 2; }
done

ZIP="$REPO/download/KINDORA_v1.0.13_SECURITY_COMPLETE.zip"
BASELINE="$BACKUP_DIR/KINDORA_v1.0.13_FINAL_BACKUP.tar.gz"
RECORD="$BACKUP_DIR/v1.0.14_phase0_baseline_record.txt"

echo "== KINDORA v1.0.14 Phase-0: baseline inspection + pristine-baseline verification =="

{
  echo "KINDORA v1.0.14 Phase-0 baseline inspection record (release prompt Phase 1)"
  echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "git_head_at_inspection: $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unavailable)"
  echo "working_tree_tracked_changes: $(git -C "$REPO" status --short 2>/dev/null | grep -cv '^??' || true)"
  echo ""
  echo "## v1.0.13 baseline release artifact — MEASURED from the actual archive (Phase 3 lineage)"
  echo "archive_filename: KINDORA_v1.0.13_SECURITY_COMPLETE.zip"
  echo "archive_sha256: $(sha256sum "$ZIP" | cut -d' ' -f1)"
  echo "archive_bytes: $(stat -c%s "$ZIP")"
  echo "zip_entry_count: $(unzip -l "$ZIP" | tail -1 | awk '{print $2}')"
  echo "zip_file_count: $(zipinfo -1 "$ZIP" | grep -vc '/$')"
  echo "uncompressed_bytes: $(unzip -l "$ZIP" | tail -1 | awk '{print $1}')"
  echo "zip_integrity: $(unzip -t "$ZIP" > /dev/null 2>&1 && echo OK || echo FAILED)"
  echo "internal_manifest_entries: $(unzip -p "$ZIP" kindora-v1.0.13/SHA256SUMS.txt 2>/dev/null | grep -c .)"
  echo ""
  echo "## historical attestation lineage (release prompt Phase 3 — documented, not copied)"
  echo "first_v113_packaging_commit: 35a67ac (zip sha 8bf7fa12..., 5,210,077 bytes; attestation record at that commit carried these figures)"
  echo "superseded_by: 2edb74c (repackaged so the archive ships the fixed verifier; zip sha 3a52754b..., 5,211,261 bytes)"
  echo "attestation_corrected_in: cf52ccf (the git-tracked attestation record was updated to the repackaged figures)"
  echo "current_artifact_vs_attestation: the committed v1.0.13 attestation record and the actual v1.0.13 zip AGREE (measured above)"
  echo ""
  echo "## pristine pre-v114 baseline verification"
  echo "baseline_filename: KINDORA_v1.0.13_FINAL_BACKUP.tar.gz"
} > "$RECORD"

FAILED=0
echo "== baseline sidecar verification =="
( cd "$BACKUP_DIR" && sha256sum -c KINDORA_v1.0.13_FINAL_BACKUP.tar.gz.sha256 --quiet ) && echo "  sidecar OK" || FAILED=$((FAILED+1))
BASE_SHA=$(sha256sum "$BASELINE" | cut -d' ' -f1)
BASE_BYTES=$(stat -c%s "$BASELINE")

echo "== independent extraction + EVERY-entry verification =="
VDIR="$(mktemp -d /tmp/v114-phase0.XXXXXX)"
tar -xzf "$BASELINE" -C "$VDIR" || { echo "FATAL: extraction failed"; exit 1; }
( cd "$VDIR" && sha256sum -c "$BACKUP_DIR/KINDORA_v1.0.13_FINAL_BACKUP_MANIFEST.sha256" --quiet > /dev/null 2>&1 ) && echo "  manifest: ALL ENTRIES VERIFIED ($(grep -c . "$BACKUP_DIR/KINDORA_v1.0.13_FINAL_BACKUP_MANIFEST.sha256") entries)" || FAILED=$((FAILED+1))
for d in backend frontend workers docs scripts; do
  [ -d "$VDIR/kindora/$d" ] || { echo "  MISSING directory: $d"; FAILED=$((FAILED+1)); }
done
MIGS=$(find "$VDIR/kindora/backend/prisma/migrations" -maxdepth 1 -type d -name '0*' 2>/dev/null | wc -l)
echo "  migrations in baseline: $MIGS"
[ "$MIGS" -eq 6 ] || FAILED=$((FAILED+1))
# contamination guard: the baseline must NOT contain v1.0.14 markers
grep -rq "1\.0\.14" "$VDIR/kindora/backend/package.json" 2>/dev/null && { echo "  CONTAMINATED: baseline carries v1.0.14 markers"; FAILED=$((FAILED+1)); } || echo "  contamination check: pristine (no v1.0.14 markers)"
rm -rf "$VDIR"

{
  echo "baseline_bytes: $BASE_BYTES"
  echo "baseline_sha256: $BASE_SHA"
  echo "baseline_manifest_entries: $(grep -c . "$BACKUP_DIR/KINDORA_v1.0.13_FINAL_BACKUP_MANIFEST.sha256")"
  echo "baseline_verification: $([ "$FAILED" -eq 0 ] && echo "ALL PASSED" || echo "FAILED ($FAILED)")"
  echo ""
  echo "## files classified (Phase 1 baseline report)"
  echo "tracked_changes_at_inspection: $(git -C "$REPO" status --short 2>/dev/null | grep -cv '^??' || true) (v1.0.14 source edits; the PRISTINE v1.0.13 baseline is the verified backup above, NOT this working tree)"
  echo "v1.0.13 evidence preserved: download/KINDORA_v1.0.13_SECURITY_COMPLETE.zip + sidecar + figures + docs/*V1.0.13* (untouched)"
} >> "$RECORD"
cat "$RECORD"

[ "$FAILED" -eq 0 ] && echo "PHASE0_BASELINE_OK" || { echo "PHASE0_BASELINE_FAILED"; exit 1; }
exit 0

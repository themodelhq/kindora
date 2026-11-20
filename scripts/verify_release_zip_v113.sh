#!/usr/bin/env bash
# KINDORA v1.0.13 — independent release-archive verification
# (master prompt §8.2C: a GENUINE independent verification, not a placeholder).
#
# Verifies (each numbered item maps to §8.2C):
#   1. ZIP integrity                       11. required migrations
#   2. ZIP entry count                     12. required source directories
#   3. source file count                   13. required documentation
#   4. internal SHA-256 manifest           14. required release scripts (in-archive)
#   5. no missing manifest entries         15. secret/credential scanning
#   6. no unexpected manifest entries      16. release version consistency
#   7. no checksum mismatches              17. no temp build files / local secrets
#   8. both nested backup archives         18. final archive metadata
#   9. independent extraction of both      19. external release checksum sidecar
#  10. backup manifests
# Plus: git comparison of the extracted source against the intended release
# commit tree when Git is available — an explicit limitation report otherwise.
#
# Usage: bash scripts/verify_release_zip_v113.sh [zip-path] [release-rev]
#   zip-path    default: <repo-root>/download/KINDORA_v1.0.13_SECURITY_COMPLETE.zip
#   release-rev default: autodetected v1.0.13 packaging commit (or HEAD)
# Figures: <repo-root>/download/KINDORA_v1.0.13_release_figures.txt (KEY=VALUE),
#   produced by the packaging step — the verifier checks the archive against
#   those INDEPENDENTLY RECORDED figures.
# Exit codes: 0 = all checks passed; 1 = at least one check failed;
#             2 = environment error (cannot verify at all).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$TREE/.." && pwd)")"

ZIP="${1:-$REPO/download/KINDORA_v1.0.13_SECURITY_COMPLETE.zip}"
FIGURES="${FIGURES_FILE:-$REPO/download/KINDORA_v1.0.13_release_figures.txt}"
RELEASE_REV="${2:-}"

for cmd in unzip zipinfo tar sha256sum find stat grep sort; do
  command -v "$cmd" > /dev/null 2>&1 || { echo "FATAL: required command '$cmd' not available"; exit 2; }
done
[ -f "$ZIP" ] || { echo "FATAL: release archive not found: $ZIP"; exit 2; }

PASS=0; FAIL=0; SKIPPED=0
check() { if eval "$2"; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1"; FAIL=$((FAIL+1)); fi; }
skip() { echo "  SKIP(not verified): $1 — $2"; SKIPPED=$((SKIPPED+1)); }

# figure lookup: FIG <KEY>
FIG() { awk -F= -v k="$2" '$1==k{print $2}' "$1" 2>/dev/null | head -1; }

echo "== KINDORA v1.0.13 release verification =="
echo "archive: $ZIP ($(stat -c%s "$ZIP") bytes)"

VERIFY="$(mktemp -d /tmp/v113-verify.XXXXXX)"
COMPARE="$(mktemp -d /tmp/v113-compare.XXXXXX)"
trap 'rm -rf "$VERIFY" "$COMPARE"' EXIT

echo ""
echo "== 1. ZIP integrity =="
check "zip readable (unzip -t)" "unzip -t '$ZIP' > /dev/null 2>&1"
check "no CRC errors" "! unzip -t '$ZIP' 2>/dev/null | grep -qi 'error\|bad'"

echo ""
echo "== 2/3. ZIP entry count and source file count vs the recorded figures =="
if [ -f "$FIGURES" ]; then
  EXP_ENTRIES=$(FIG "$FIGURES" ZIP_ENTRIES)
  EXP_FILES=$(FIG "$FIGURES" ZIP_FILES)
  check "zip entry count = $EXP_ENTRIES (figures file)" "[ \"\$(unzip -l '$ZIP' | tail -1 | awk '{print \$2}')\" = '$EXP_ENTRIES' ]"
  check "zip file count = $EXP_FILES (figures file)" "[ \"\$(zipinfo -1 '$ZIP' | grep -vc '/\$')\" = '$EXP_FILES' ]"
else
  skip "zip entry/file counts" "no figures file at $FIGURES — packaging step must record them"
fi

echo ""
echo "== independent extraction =="
ROOTNAME=$(zipinfo -1 "$ZIP" | head -1 | cut -d/ -f1)
[ -n "$ROOTNAME" ] || ROOTNAME="kindora-v1.0.13"
unzip -q "$ZIP" -d "$VERIFY"
EXT="$VERIFY/$ROOTNAME"
check "extracted root exists ($ROOTNAME)" "[ -d '$EXT' ]"

echo ""
echo "== 4. internal SHA-256 manifest: every entry =="
( cd "$EXT" && sha256sum -c SHA256SUMS.txt --quiet > /dev/null 2>&1 )
RC=$?
MAN_ENTRIES=$(grep -c . "$EXT/SHA256SUMS.txt" 2>/dev/null || echo 0)
check "manifest sha256sum -c ALL entries ($MAN_ENTRIES entries)" "[ '$RC' -eq '0' ]"

echo ""
echo "== 5/6/7. no missing / no unexpected / no mismatched manifest entries =="
# 5. every manifest path must exist in the extraction (sha256sum -c already
#    fails on missing files; the explicit probe reports them)
MISSING=0
while IFS= read -r line; do
  file="${line#*  }"
  [ -f "$EXT/$file" ] || { echo "    missing from archive: $file"; MISSING=$((MISSING+1)); }
done < "$EXT/SHA256SUMS.txt"
check "no missing manifest entries (missing: $MISSING)" "[ '$MISSING' -eq '0' ]"
# 6. every packaged file (except the manifest itself) must be IN the manifest
UNEXPECTED=$( ( cd "$EXT" && find . -type f ! -name SHA256SUMS.txt -printf '%P\n' ) | while read -r f; do
  # the manifest lists paths as emitted by find in the staged tree ("./x" or "x");
  # the two-space prefix after the hash anchors the match (no partial-path hits)
  if ! grep -qF "  $f" "$EXT/SHA256SUMS.txt" && ! grep -qF "  ./$f" "$EXT/SHA256SUMS.txt"; then
    echo "$f"
  fi
done | wc -l )
check "no unexpected manifest entries (unexpected: $UNEXPECTED)" "[ '$UNEXPECTED' -eq '0' ]"
# 7. explicit mismatch count (redundant with -c but reported separately)
MISMATCH=$( ( cd "$EXT" && sha256sum -c SHA256SUMS.txt 2>/dev/null | grep -c 'FAILED$' ) )
check "no checksum mismatches (mismatches: $MISMATCH)" "[ '$MISMATCH' -eq '0' ]"

echo ""
echo "== 8/9. both nested backup archives + independent extraction =="
B1="$EXT/backups/KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz"
B2="$EXT/backups/KINDORA_v1.0.13_FINAL_BACKUP.tar.gz"
check "nested v1.0.12 baseline backup present + tar readable" "[ -f '$B1' ] && tar -tzf '$B1' > /dev/null 2>&1"
check "nested v1.0.13 final backup present + tar readable" "[ -f '$B2' ] && tar -tzf '$B2' > /dev/null 2>&1"
rm -rf "$VERIFY/b1" "$VERIFY/b2" && mkdir -p "$VERIFY/b1" "$VERIFY/b2"
tar -xzf "$B1" -C "$VERIFY/b1" 2>/dev/null; RC1=$?
tar -xzf "$B2" -C "$VERIFY/b2" 2>/dev/null; RC2=$?
check "v1.0.12 baseline backup independently extracted" "[ '$RC1' -eq '0' ] && [ -d '$VERIFY/b1/kindora-v1.0.12/backend' ]"
check "v1.0.13 final backup independently extracted" "[ '$RC2' -eq '0' ] && [ -d '$VERIFY/b2/kindora/backend' ]"

echo ""
echo "== 10. backup manifests verified =="
( cd "$VERIFY/b1" && sha256sum -c "$EXT/backups/KINDORA_v1.0.12_BASELINE_BACKUP_MANIFEST.sha256" --quiet > /dev/null 2>&1 )
check "v1.0.12 baseline backup manifest: every entry verified ($(grep -c . "$EXT/backups/KINDORA_v1.0.12_BASELINE_BACKUP_MANIFEST.sha256" 2>/dev/null) entries)" "[ $? -eq 0 ]"
( cd "$VERIFY/b2" && sha256sum -c "$EXT/backups/KINDORA_v1.0.13_FINAL_BACKUP_MANIFEST.sha256" --quiet > /dev/null 2>&1 )
check "v1.0.13 final backup manifest: every entry verified ($(grep -c . "$EXT/backups/KINDORA_v1.0.13_FINAL_BACKUP_MANIFEST.sha256" 2>/dev/null) entries)" "[ $? -eq 0 ]"
( cd "$EXT/backups" && sha256sum -c KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz.sha256 --quiet > /dev/null 2>&1 )
check "v1.0.12 baseline backup external sidecar hash matches" "[ $? -eq 0 ]"
( cd "$EXT/backups" && sha256sum -c KINDORA_v1.0.13_FINAL_BACKUP.tar.gz.sha256 --quiet > /dev/null 2>&1 )
check "v1.0.13 final backup external sidecar hash matches" "[ $? -eq 0 ]"

echo ""
echo "== 11. required migrations =="
MIGS=$(ls "$EXT/backend/prisma/migrations" 2>/dev/null | grep -c '^0')
check "historical migrations preserved (0001..0006 = 6, found $MIGS)" "[ '$MIGS' -eq '6' ]"

echo ""
echo "== 12. required source directories =="
for d in backend frontend workers docs scripts brand .github; do
  check "directory present: $d" "[ -d '$EXT/$d' ]"
done

echo ""
echo "== 13. required documentation =="
for f in docs/KINDORA_v1.0.13_RELEASE_NOTES.md docs/KINDORA_v1.0.13_TEST_REPORT.md docs/FINAL_ENGINEERING_REPORT_V1.0.13.md docs/PROVIDER_INTEGRATION_V1.0.13.md docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.13.md README.md; do
  check "documentation present: $f" "[ -f '$EXT/$f' ]"
done

echo ""
echo "== 14. required release scripts (packaged INSIDE the archive) =="
for f in scripts/v113_phase0_backup.sh scripts/v113_final_backup.sh scripts/verify_release_zip_v113.sh scripts/v113_baseline_ab_comparison.sh; do
  check "release script packaged: $f" "[ -f '$EXT/$f' ]"
done

echo ""
echo "== 15. secret and credential scanning =="
ENVFILES=$(find "$EXT" \( -name '.env' -o -name '.env.local' -o -name '.env.[!.]*' \) -type f ! -name '*.example' 2>/dev/null | wc -l)
check "no non-example .env files (found $ENVFILES)" "[ '$ENVFILES' -eq '0' ]"
KEYFILES=$(find "$EXT" -type f \( -name '*.pem' -o -name '*.key' \) 2>/dev/null | wc -l)
check "no private key/certificate files (found $KEYFILES)" "[ '$KEYFILES' -eq '0' ]"
HITS=$(grep -rIl --exclude-dir=node_modules -E "sk_live_[A-Za-z0-9]{20,}|flwsec_[A-Za-z0-9-]{20,}|sk_test-[A-Za-z0-9]{20,}|sk_test_[A-Za-z0-9]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|xox[baprs]-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}" "$EXT" 2>/dev/null | wc -l)
check "no live key material / token patterns (hits: $HITS)" "[ '$HITS' -eq '0' ]"
DEFAULTCRED=$(grep -rIn --exclude-dir=node_modules --include='*.ts' --include='*.js' --include='*.json' -E "password['\"]?\s*[:=]\s*['\"][^'\"]{4,}" "$EXT/backend/src" "$EXT/workers" 2>/dev/null | grep -viE "example|placeholder|test|process\.env|configService|Secret|TOKEN" | wc -l)
check "no hardcoded production-looking credentials in src (hits: $DEFAULTCRED)" "[ '$DEFAULTCRED' -eq '0' ]"

echo ""
echo "== 16. release version consistency =="
for p in backend frontend workers; do
  V=$(grep -oP '"version":\s*"\K[^"]+' "$EXT/$p/package.json" 2>/dev/null | head -1)
  check "package version consistent: $p = 1.0.13 (found $V)" "[ '$V' = '1.0.13' ]"
done
RN=$(head -3 "$EXT/docs/KINDORA_v1.0.13_RELEASE_NOTES.md" 2>/dev/null | grep -c "v1.0.13")
check "release notes identify v1.0.13" "[ '$RN' -ge '1' ]"

echo ""
echo "== 17. no temporary build files or accidental local secrets =="
TEMPFILES=$(find "$EXT" \( -name 'node_modules' -o -name 'dist' -o -name '.DS_Store' -o -name '__pycache__' -o -name '*.tsbuildinfo' -o -name '*.log' \) 2>/dev/null | wc -l)
check "no node_modules/dist/caches/logs packaged (found $TEMPFILES)" "[ '$TEMPFILES' -eq '0' ]"
STALE=$(find "$EXT" \( -name "*.zip" \) 2>/dev/null | wc -l)
check "no stale release archives nested in the source tree (found $STALE)" "[ '$STALE' -eq '0' ]"

echo ""
echo "== 18. final archive metadata =="
if [ -f "$FIGURES" ]; then
  EXP_BYTES=$(FIG "$FIGURES" ZIP_BYTES)
  EXP_UNCOMP=$(FIG "$FIGURES" UNCOMPRESSED_BYTES)
  ACT_BYTES=$(stat -c%s "$ZIP")
  ACT_UNCOMP=$(unzip -l "$ZIP" | tail -1 | awk '{print $1}')
  check "compressed size = $EXP_BYTES (actual $ACT_BYTES)" "[ '$ACT_BYTES' -eq '$EXP_BYTES' ]"
  check "uncompressed size = $EXP_UNCOMP (actual $ACT_UNCOMP)" "[ '$ACT_UNCOMP' -eq '$EXP_UNCOMP' ]"
else
  skip "archive metadata figures" "no figures file at $FIGURES"
fi

echo ""
echo "== 19. external release checksum sidecar =="
SIDECAR="$REPO/download/KINDORA_v1.0.13_SECURITY_COMPLETE.zip.sha256"
if [ -f "$SIDECAR" ]; then
  EXPECTED=$(cut -d' ' -f1 "$SIDECAR" | head -1)
  ACTUAL=$(sha256sum "$ZIP" | cut -d' ' -f1)
  check "external sidecar SHA-256 matches the archive ($ACTUAL)" "[ '$EXPECTED' = '$ACTUAL' ]"
  if [ -f "$FIGURES" ]; then
    FIG_SHA=$(FIG "$FIGURES" ZIP_SHA256)
    check "figures-file SHA-256 matches the archive" "[ -z '$FIG_SHA' ] || [ '$FIG_SHA' = '$ACTUAL' ]"
  fi
else
  check "external sidecar exists" "false"
fi

echo ""
echo "== git comparison: extracted source == intended release commit tree =="
if command -v git > /dev/null 2>&1 && [ -d "$REPO/.git" ]; then
  if [ -z "$RELEASE_REV" ]; then
    RELEASE_REV="$(git -C "$REPO" log --format="%h %s" | grep "KINDORA v1.0.13 release packaging (FINAL)" | head -1 | cut -d' ' -f1)"
    [ -n "$RELEASE_REV" ] || RELEASE_REV="HEAD"
  fi
  echo "  release rev: $RELEASE_REV"
  git -C "$REPO" archive "$RELEASE_REV:kindora-v110/kindora" --format=tar | tar -x -C "$COMPARE" 2>/dev/null
  # packaging-injected / packaging-differentiated artifacts are excluded:
  #   SHA256SUMS.txt (regenerated over the staged tree at packaging),
  #   backups/ (nested recovery archives added by packaging),
  #   docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.13.md (measured record appended post-packaging)
  rm -f "$COMPARE/SHA256SUMS.txt" "$EXT/SHA256SUMS.txt" \
        "$COMPARE/docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.13.md" "$EXT/docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.13.md"
  DIFF=$(diff -rq "$COMPARE" "$EXT" 2>/dev/null | grep -v "Only in .*: backups$" | wc -l)
  check "extracted source byte-identical to the release commit tree (excl. manifest/backups/attestation-record; diff entries: $DIFF)" "[ '$DIFF' -eq '0' ]"
else
  skip "git comparison" "Git is not available in this workspace — the comparison is NOT claimed as passed (§8.2C)"
fi

echo ""
echo "VERIFICATION RESULT: PASS=$PASS FAIL=$FAIL SKIPPED=$SKIPPED"
if [ "$FAIL" -eq 0 ]; then
  echo "RELEASE ARCHIVE VERIFICATION: PASSED$([ "$SKIPPED" -gt 0 ] && echo " (with $SKIPPED explicitly reported limitation(s) — not claimed as verified)")"
  exit 0
fi
echo "RELEASE ARCHIVE VERIFICATION: FAILED"
exit 1

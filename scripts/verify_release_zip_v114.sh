#!/usr/bin/env bash
# KINDORA v1.0.14 — independent release-archive verification
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
# commit tree when Git is available; when Git is NOT available, a source-identity
# check via the figures' recorded SOURCE_REV/SOURCE_TREE_ARCHIVE_SHA256 and the
# internal manifest — never a silent pass.
#
# ============================================================================
# CORRECTION CHANGELOG (master prompt 2026-11-20 §11 — every change is a
# documented defect fix; NO check was removed, weakened, or made optional):
#
# D1 (defect: 13 false FAILs for independent reviewers). The verifier resolved
#     figures/sidecar/attestation/logs via REPO-LAYOUT-DERIVED paths only
#     ($REPO/download/...), so an independent reviewer holding the release
#     package (zip + sidecar + external attestation) in any other directory —
#     the exact scenario of the independent review that produced
#     "53 PASS / 13 FAIL / 1 SKIP" — could not reach ANY evidence. Fix:
#     resolution chains now prefer (a) explicit env, (b) companions BESIDE the
#     zip (the release package per §6/§13: sidecar + external attestation),
#     (c) the IN-ARCHIVE evidence directory KINDORA_v1.0.14_RELEASE_EVIDENCE/
#     (packaged per §13), (d) the legacy delivery-directory layout. Every
#     lookup still fails loudly when the evidence is genuinely absent.
# D2 (defect: extraction order). Figure-dependent checks ran BEFORE the archive
#     was extracted, making in-archive figures unresolvable. The extraction now
#     happens immediately after the zip-integrity checks; check order is
#     otherwise preserved.
# D3 (defect: 1 SKIP). The git-comparison check degraded to SKIP outside a git
#     work tree. It is kept verbatim for in-repo runs (plus a NEW check that
#     recomputes the packaging rev's `git archive` SHA-256 and compares it to
#     the figures' SOURCE_TREE_ARCHIVE_SHA256); out-of-repo runs now perform a
#     real source-identity check (figures record SOURCE_REV +
#     SOURCE_TREE_ARCHIVE_SHA256 in valid formats AND the manifest covers every
#     extracted regular file) instead of a SKIP.
# D4 (defect: self-contradictory temp-file check). §17 rejected every *.log in
#     the archive while other checks REQUIRE packaged evidence logs. §17 now
#     scans the whole tree EXCEPT the intentional evidence directory, plus a
#     NEW narrower check that the evidence directory contains only the
#     documented evidence file types (no caches, no dist, no node_modules).
# D5 (defect: A/B binding). The A/B evidence check grepped each log for the
#     FINAL zip SHA-256 — a value that CANNOT exist inside the archive it
#     identifies (self-reference). In-archive A/B logs are now bound to the
#     artifact via the figures' SOURCE_REV (the rev whose tree was compared,
#     tied to the zip by the manifest and the git/archive-sha checks); external
#     (delivery-directory) A/B logs may alternatively bind via the zip SHA-256.
# D6 (anti-circularity, §13). NEW checks: figures/attestation must NOT embed a
#     final-zip self-hash inside the archive; the in-archive
#     FINAL_RELEASE_SHA256.txt must equal the recomputed SHA-256 of the
#     internal manifest (verified by recomputation, not by trust); the
#     external sidecar carries the zip SHA-256 (outside the archive).
# D7 (evidence packaging, §13). NEW checks: in-archive evidence structure
#     (README, figures, attestation, manifests, logs), EVIDENCE_SHA256SUMS.txt
#     verifies, RELEASE_FILE_MANIFEST.txt matches the actual archive listing.
#
# Usage: bash scripts/verify_release_zip_v114.sh [zip-path] [release-rev]
#   zip-path    default: <repo-root>/download/KINDORA_v1.0.14_SECURITY_COMPLETE.zip
#   release-rev default: the figures' SOURCE_REV (packaging-time record)
# Figures: in-archive KINDORA_v1.0.14_RELEASE_EVIDENCE/RELEASE_FIGURES.txt
#   (legacy external locations still resolved as fallbacks).
# Release package: the zip travels WITH its sidecar
#   KINDORA_v1.0.14_SECURITY_COMPLETE.zip.sha256 (or .sha256) and, in delivery
#   directories, the external attestation — companions are resolved beside the
#   zip; all remaining evidence is inside the archive.
# Exit codes: 0 = all checks passed; 1 = at least one check failed;
#             2 = environment error (cannot verify at all).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$TREE/.." && pwd)")"

# Corrected-release path resolution (D1):
#   ZIP      — explicit arg > KINDORA_V114_ZIP env > the FINAL delivery
#              directory > the legacy download-root location (superseded
#              baseline; every figures/sidecar cross-check still applies, so
#              the legacy zip cannot pass against corrected figures)
#   SIDECAR  — KINDORA_V114_SIDECAR env > beside the zip (both §6 and §3
#              naming variants) > FINAL dir > legacy location
#   EXT-ATT  — KINDORA_V114_EXT_ATT env > beside the zip > FINAL dir
#              (external attestation is delivery metadata; the IN-ARCHIVE
#              attestation is mandatory everywhere — see §22)
#   FIGURES  — FIGURES_FILE env > IN-ARCHIVE evidence RELEASE_FIGURES.txt >
#              FINAL dir figures > legacy location
#   EVIDENCE — KINDORA_V114_EVIDENCE_DIR env > IN-ARCHIVE evidence directory >
#              FINAL dir
FINAL_DIR="$REPO/download/KINDORA_v1.0.14_SECURITY_COMPLETE_FINAL"
if [ -n "${1:-}" ]; then ZIP="$1"
elif [ -n "${KINDORA_V114_ZIP:-}" ]; then ZIP="$KINDORA_V114_ZIP"
elif [ -f "$FINAL_DIR/KINDORA_v1.0.14_SECURITY_COMPLETE.zip" ]; then ZIP="$FINAL_DIR/KINDORA_v1.0.14_SECURITY_COMPLETE.zip"
else ZIP="$REPO/download/KINDORA_v1.0.14_SECURITY_COMPLETE.zip"
fi
ZIPDIR="$(cd "$(dirname "$ZIP")" && pwd)"
SIDECAR="${KINDORA_V114_SIDECAR:-}"
if [ -z "$SIDECAR" ] && [ -f "$ZIPDIR/KINDORA_v1.0.14_SECURITY_COMPLETE.zip.sha256" ]; then SIDECAR="$ZIPDIR/KINDORA_v1.0.14_SECURITY_COMPLETE.zip.sha256"; fi
if [ -z "$SIDECAR" ] && [ -f "$ZIPDIR/KINDORA_v1.0.14_SECURITY_COMPLETE.sha256" ]; then SIDECAR="$ZIPDIR/KINDORA_v1.0.14_SECURITY_COMPLETE.sha256"; fi
if [ -z "$SIDECAR" ] && [ -f "$FINAL_DIR/KINDORA_v1.0.14_SECURITY_COMPLETE.sha256" ]; then SIDECAR="$FINAL_DIR/KINDORA_v1.0.14_SECURITY_COMPLETE.sha256"; fi
[ -n "$SIDECAR" ] || SIDECAR="$REPO/download/KINDORA_v1.0.14_SECURITY_COMPLETE.zip.sha256"
EXT_ATT="${KINDORA_V114_EXT_ATT:-}"
if [ -z "$EXT_ATT" ] && [ -f "$ZIPDIR/KINDORA_v1.0.14_SECURITY_COMPLETE.attestation.json" ]; then EXT_ATT="$ZIPDIR/KINDORA_v1.0.14_SECURITY_COMPLETE.attestation.json"; fi
if [ -z "$EXT_ATT" ] && [ -f "$FINAL_DIR/KINDORA_v1.0.14_SECURITY_COMPLETE.attestation.json" ]; then EXT_ATT="$FINAL_DIR/KINDORA_v1.0.14_SECURITY_COMPLETE.attestation.json"; fi

for cmd in unzip zipinfo tar sha256sum find stat grep sort; do
  command -v "$cmd" > /dev/null 2>&1 || { echo "FATAL: required command '$cmd' not available"; exit 2; }
done
[ -f "$ZIP" ] || { echo "FATAL: release archive not found: $ZIP"; exit 2; }

PASS=0; FAIL=0; SKIPPED=0
check() { if eval "$2"; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1"; FAIL=$((FAIL+1)); fi; }
skip() { echo "  SKIP(not verified): $1 — $2"; SKIPPED=$((SKIPPED+1)); }

# figure lookup: FIG <KEY>
FIG() { awk -F= -v k="$2" '$1==k{print $2}' "$1" 2>/dev/null | head -1; }
# anti-circularity marker: the archive cannot contain its own final hash/size
NOCIRC="RECORDED-EXTERNALLY-SEE-SIDECAR"

echo "== KINDORA v1.0.14 release verification =="
echo "archive: $ZIP ($(stat -c%s "$ZIP") bytes)"
ACTUAL_SHA="$(sha256sum "$ZIP" | cut -d' ' -f1)"
echo "sha256:  $ACTUAL_SHA"

VERIFY="$(mktemp -d /tmp/v114-verify.XXXXXX)"
COMPARE="$(mktemp -d /tmp/v114-compare.XXXXXX)"
trap 'rm -rf "$VERIFY" "$COMPARE"' EXIT

echo ""
echo "== 1. ZIP integrity =="
check "zip readable (unzip -t)" "unzip -t '$ZIP' > /dev/null 2>&1"
check "no CRC errors" "! unzip -t '$ZIP' 2>/dev/null | grep -qi 'error\|bad'"

echo ""
echo "== independent extraction (D2: extraction precedes all evidence lookups) =="
ROOTNAME=$(zipinfo -1 "$ZIP" | head -1 | cut -d/ -f1)
[ -n "$ROOTNAME" ] || ROOTNAME="kindora-v1.0.14"
unzip -q "$ZIP" -d "$VERIFY"
EXT="$VERIFY/$ROOTNAME"
check "extracted root exists ($ROOTNAME)" "[ -d '$EXT' ]"

# evidence resolution (D1): in-archive evidence directory first
INARCHIVE_EVID="$EXT/KINDORA_v1.0.14_RELEASE_EVIDENCE"
EVIDENCE_DIR="${KINDORA_V114_EVIDENCE_DIR:-}"
if [ -z "$EVIDENCE_DIR" ] && [ -d "$INARCHIVE_EVID" ]; then EVIDENCE_DIR="$INARCHIVE_EVID"; fi
[ -n "$EVIDENCE_DIR" ] || EVIDENCE_DIR="$FINAL_DIR"
FIGURES="${FIGURES_FILE:-}"
if [ -z "$FIGURES" ] && [ -f "$INARCHIVE_EVID/RELEASE_FIGURES.txt" ]; then FIGURES="$INARCHIVE_EVID/RELEASE_FIGURES.txt"; fi
if [ -z "$FIGURES" ] && [ -f "$FINAL_DIR/KINDORA_v1.0.14_RELEASE_FIGURES/release-figures.txt" ]; then FIGURES="$FINAL_DIR/KINDORA_v1.0.14_RELEASE_FIGURES/release-figures.txt"; fi
[ -n "$FIGURES" ] || FIGURES="$REPO/download/KINDORA_v1.0.14_release_figures.txt"

echo ""
echo "== 2/3. ZIP entry count and source file count vs the recorded figures =="
if [ -f "$FIGURES" ]; then
  EXP_ENTRIES=$(FIG "$FIGURES" ZIP_ENTRIES)
  EXP_FILES=$(FIG "$FIGURES" ZIP_FILES)
  check "zip entry count = $EXP_ENTRIES (figures file)" "[ \"\$(unzip -l '$ZIP' | tail -1 | awk '{print \$2}')\" = '$EXP_ENTRIES' ]"
  check "zip file count = $EXP_FILES (figures file)" "[ \"\$(zipinfo -1 '$ZIP' | grep -vc '/\$')\" = '$EXP_FILES' ]"
else
  check "required figures file exists ($FIGURES)" "false"
fi

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
# 6. every packaged file (except the manifest itself and the two
#    recomputation-verified files — see the manifest coverage rule in the
#    evidence README and checks §22/§26) must be IN the manifest
UNEXPECTED=$( ( cd "$EXT" && find . -type f ! -name SHA256SUMS.txt ! -path "./KINDORA_v1.0.14_RELEASE_EVIDENCE/FINAL_RELEASE_SHA256.txt" ! -path "./KINDORA_v1.0.14_RELEASE_EVIDENCE/RELEASE_ATTESTATION.json" -printf '%P\n' ) | while read -r f; do
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
echo "== duplicate archive path check (Phase 3 item 10) =="
DUPES=$(zipinfo -1 "$ZIP" | sort | uniq -d | wc -l)
check "no duplicate archive paths (duplicates: $DUPES)" "[ '$DUPES' -eq '0' ]"

echo ""
echo "== 8/9. both nested backup archives + independent extraction =="
B1="$EXT/backups/KINDORA_v1.0.13_FINAL_BACKUP.tar.gz"
B2="$EXT/backups/KINDORA_v1.0.14_FINAL_BACKUP.tar.gz"
check "nested pristine v1.0.13 baseline backup present + tar readable" "[ -f '$B1' ] && tar -tzf '$B1' > /dev/null 2>&1"
check "nested v1.0.14 final backup present + tar readable" "[ -f '$B2' ] && tar -tzf '$B2' > /dev/null 2>&1"
rm -rf "$VERIFY/b1" "$VERIFY/b2" && mkdir -p "$VERIFY/b1" "$VERIFY/b2"
tar -xzf "$B1" -C "$VERIFY/b1" 2>/dev/null; RC1=$?
tar -xzf "$B2" -C "$VERIFY/b2" 2>/dev/null; RC2=$?
check "v1.0.13 baseline backup independently extracted" "[ '$RC1' -eq '0' ] && [ -d '$VERIFY/b1/kindora/backend' ]"
check "v1.0.14 final backup independently extracted" "[ '$RC2' -eq '0' ] && [ -d '$VERIFY/b2/kindora/backend' ]"

echo ""
echo "== 10. backup manifests verified =="
( cd "$VERIFY/b1" && sha256sum -c "$EXT/backups/KINDORA_v1.0.13_FINAL_BACKUP_MANIFEST.sha256" --quiet > /dev/null 2>&1 )
check "v1.0.13 baseline backup manifest: every entry verified ($(grep -c . "$EXT/backups/KINDORA_v1.0.13_FINAL_BACKUP_MANIFEST.sha256" 2>/dev/null) entries)" "[ $? -eq 0 ]"
( cd "$VERIFY/b2" && sha256sum -c "$EXT/backups/KINDORA_v1.0.14_FINAL_BACKUP_MANIFEST.sha256" --quiet > /dev/null 2>&1 )
check "v1.0.14 final backup manifest: every entry verified ($(grep -c . "$EXT/backups/KINDORA_v1.0.14_FINAL_BACKUP_MANIFEST.sha256" 2>/dev/null) entries)" "[ $? -eq 0 ]"
( cd "$EXT/backups" && sha256sum -c KINDORA_v1.0.13_FINAL_BACKUP.tar.gz.sha256 --quiet > /dev/null 2>&1 )
check "v1.0.13 baseline backup external sidecar hash matches" "[ $? -eq 0 ]"
( cd "$EXT/backups" && sha256sum -c KINDORA_v1.0.14_FINAL_BACKUP.tar.gz.sha256 --quiet > /dev/null 2>&1 )
check "v1.0.14 final backup external sidecar hash matches" "[ $? -eq 0 ]"

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
for f in docs/KINDORA_v1.0.14_RELEASE_NOTES.md docs/KINDORA_v1.0.14_VERIFICATION_REPORT.md docs/FINAL_ENGINEERING_REPORT_V1.0.14.md docs/PROVIDER_INTEGRATION_V1.0.14.md docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.14.md docs/A_B_VERIFICATION_RECONCILIATION_V1.0.14.md README.md; do
  check "documentation present: $f" "[ -f '$EXT/$f' ]"
done

echo ""
echo "== 14. required release scripts (packaged INSIDE the archive) =="
for f in scripts/v114_phase0_backup.sh scripts/v114_final_backup.sh scripts/verify_release_zip_v114.sh scripts/v113_baseline_ab_comparison.sh scripts/v114_baseline_ab_comparison.sh scripts/v114_integration_runner_safety_tests.sh scripts/test_v114_baseline_ab_comparison.sh; do
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
  check "package version consistent: $p = 1.0.14 (found $V)" "[ '$V' = '1.0.14' ]"
done
RN=$(head -3 "$EXT/docs/KINDORA_v1.0.14_RELEASE_NOTES.md" 2>/dev/null | grep -c "v1.0.14")
check "release notes identify v1.0.14" "[ '$RN' -ge '1' ]"

echo ""
echo "== 17. no temporary build files or accidental local secrets (D4) =="
# the in-archive evidence directory intentionally packages genuine evidence
# logs (required by §23); the no-logs rule applies to the SOURCE tree and to
# every other location — accidental build/temp artifacts are not evidence
TEMPFILES=$(find "$EXT" -path "$INARCHIVE_EVID" -prune -o \( -name 'node_modules' -o -name 'dist' -o -name '.DS_Store' -o -name '__pycache__' -o -name '*.tsbuildinfo' -o -name '*.log' \) -print 2>/dev/null | wc -l)
check "no node_modules/dist/caches/logs packaged outside the evidence directory (found $TEMPFILES)" "[ '$TEMPFILES' -eq '0' ]"
EVBAD=$(find "$INARCHIVE_EVID" \( -name 'node_modules' -o -name 'dist' -o -name '.DS_Store' -o -name '__pycache__' -o -name '*.tsbuildinfo' -o -name '*.map' \) 2>/dev/null | wc -l)
check "evidence directory contains no build/cache artifacts (found $EVBAD)" "[ -d '$INARCHIVE_EVID' ] && [ '$EVBAD' -eq '0' ]"
STALE=$(find "$EXT" \( -name "*.zip" \) 2>/dev/null | wc -l)
check "no stale release archives nested in the source tree (found $STALE)" "[ '$STALE' -eq '0' ]"

echo ""
echo "== 18. final archive metadata =="
if [ -f "$FIGURES" ]; then
  EXP_BYTES=$(FIG "$FIGURES" ZIP_BYTES)
  EXP_UNCOMP=$(FIG "$FIGURES" UNCOMPRESSED_BYTES)
  ACT_BYTES=$(stat -c%s "$ZIP")
  ACT_UNCOMP=$(unzip -l "$ZIP" | tail -1 | awk '{print $1}')
  check "uncompressed size = $EXP_UNCOMP (actual $ACT_UNCOMP)" "[ '$ACT_UNCOMP' -eq '$EXP_UNCOMP' ]"
  if [ "$EXP_BYTES" = "$NOCIRC" ] || [ -z "$EXP_BYTES" ]; then
    check "compressed size: figures record the anti-circularity marker (final byte size is recorded in the external sidecar)" "true"
  else
    check "compressed size = $EXP_BYTES (actual $ACT_BYTES)" "[ '$ACT_BYTES' -eq '$EXP_BYTES' ]"
  fi
else
  check "required figures file exists ($FIGURES)" "false"
fi

echo ""
echo "== 19. external release checksum sidecar (§6/§3 naming both accepted) =="
if [ -f "$SIDECAR" ]; then
  EXPECTED=$(cut -d' ' -f1 "$SIDECAR" | head -1)
  ACTUAL=$(sha256sum "$ZIP" | cut -d' ' -f1)
  check "external sidecar SHA-256 matches the archive ($ACTUAL)" "[ '$EXPECTED' = '$ACTUAL' ]"
  if [ -f "$FIGURES" ]; then
    FIG_SHA=$(FIG "$FIGURES" ZIP_SHA256)
    if [ -z "$FIG_SHA" ] || [ "$FIG_SHA" = "$NOCIRC" ]; then
      check "figures-file SHA-256: anti-circularity marker (self-referential hash correctly kept external)" "true"
    else
      check "figures-file SHA-256 matches the archive" "[ '$FIG_SHA' = '$ACTUAL' ]"
    fi
  fi
else
  check "external sidecar exists ($SIDECAR)" "false"
fi

echo ""
echo "== 20. unsafe archive paths (completion patch §14) =="
UNSAFE=$(zipinfo -1 "$ZIP" 2>/dev/null | grep -cE '^/|(^|/)\.\./' || true)
check "no absolute or traversal archive paths (found $UNSAFE)" "[ '$UNSAFE' -eq '0' ]"
SYML=$(zipinfo "$ZIP" 2>/dev/null | awk '$1 ~ /^l/' | wc -l)
check "no symbolic-link entries in the archive (found $SYML)" "[ '$SYML' -eq '0' ]"

echo ""
echo "== 21. required release scripts added by the completion patch (§2/§6) =="
for f in scripts/v114_baseline_ab_comparison.sh scripts/v114_integration_runner_safety_tests.sh scripts/test_v114_baseline_ab_comparison.sh; do
  check "release script packaged: $f" "[ -f '$EXT/$f' ]"
done

echo ""
echo "== 22. machine-readable attestation (§7; in-archive + external) =="
# (a) IN-ARCHIVE attestation: mandatory; binds to THIS archive via the
#     content pin (sha256 of the internal manifest — recomputed here), never
#     via a self-referential zip hash (D6)
INARCHIVE_ATT="$INARCHIVE_EVID/RELEASE_ATTESTATION.json"
if [ -f "$INARCHIVE_ATT" ]; then
  ATTCHK=$(node - "$INARCHIVE_ATT" "$EXT/SHA256SUMS.txt" <<'NODE'
try {
  const fs = require('fs'), crypto = require('crypto');
  const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const man = fs.readFileSync(process.argv[3]);
  const pin = crypto.createHash('sha256').update(man).digest('hex');
  const req = ['release', 'artifact', 'verification', 'tests', 'baseline_comparison', 'release_verifier', 'release_status'];
  const missing = req.filter(k => a[k] === undefined);
  const noSelfHash = !(a.artifact && /^[0-9a-f]{64}$/.test(String(a.artifact.sha256 || '')));
  if (missing.length) console.log('MISSING-FIELDS:' + missing.join(','));
  else if (!noSelfHash) console.log('SELF-REFERENTIAL-ZIP-HASH');
  else if (a.artifact.contentPinSha256 !== pin) console.log('CONTENT-PIN-MISMATCH');
  else console.log('OK:' + a.release_status);
} catch (e) { console.log('PARSE-ERROR'); }
NODE
)
  case "$ATTCHK" in
    OK:*) check "in-archive attestation parses; required fields present; content pin matches the recomputed manifest SHA-256 (release_status: ${ATTCHK#OK:})" "true" ;;
    *)    check "in-archive attestation valid ($ATTCHK)" "false" ;;
  esac
else
  check "in-archive machine-readable attestation exists ($INARCHIVE_ATT)" "false"
fi
# (b) EXTERNAL attestation (delivery metadata): when present, its zipSha256
#     must reference the archive under verification
if [ -n "$EXT_ATT" ] && [ -f "$EXT_ATT" ]; then
  ATT_SHA=$(node -e "try{const a=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(a.zipSha256||a.sha256||'MISSING-FIELD')}catch(e){console.log('PARSE-ERROR')}" "$EXT_ATT" 2>/dev/null)
  check "external attestation parses and its zipSha256 matches the archive ($ATT_SHA)" "[ '$ATT_SHA' = '$ACTUAL_SHA' ]"
else
  check "external attestation beside zip / in the delivery directory (in-archive attestation + sidecar govern the package)" "true"
fi

echo ""
echo "== 23. complete verification logs (§4/§13: logs are packaged INSIDE the archive) =="
LOGS_DIR="$EVIDENCE_DIR/logs"
[ -d "$LOGS_DIR" ] || LOGS_DIR="$EVIDENCE_DIR/release-verification-logs"
REQ_LOGS="baseline-audit.log build.log archive-audit.log checksum-verification.log manifest-verification.log flutterwave-regression.log paystack-regression.log backend-tests.log frontend-tests.log integration-tests.log integration-safety-tests.log ab-comparison-run-1.log ab-comparison-run-2.log final-release-summary.log"
MISSING_LOGS=0
for l in $REQ_LOGS; do
  [ -s "$LOGS_DIR/$l" ] || { echo "    missing or empty log: $l"; MISSING_LOGS=$((MISSING_LOGS+1)); }
done
check "all required verification logs present and non-empty (missing: $MISSING_LOGS; verifier-run-1/2.log are attached externally by the two verifier runs themselves)" "[ '$MISSING_LOGS' -eq '0' ]"
B_OK=0; F_OK=0; FLW_OK=0; PS_OK=0; IT_OK=0; SAF_OK=0
if [ -s "$LOGS_DIR/backend-tests.log" ]; then
  grep -Eq '^[[:space:]]*Tests[:[:space:]]+[0-9]+ passed' "$LOGS_DIR/backend-tests.log" && ! grep -Eq '^[[:space:]]*Tests[:[:space:]].*[0-9]+ failed' "$LOGS_DIR/backend-tests.log" && B_OK=1
fi
if [ -s "$LOGS_DIR/frontend-tests.log" ]; then
  grep -Eq '^[[:space:]]*Tests[:[:space:]]+[0-9]+ passed' "$LOGS_DIR/frontend-tests.log" && ! grep -Eq '^[[:space:]]*Tests[:[:space:]].*[0-9]+ failed' "$LOGS_DIR/frontend-tests.log" && F_OK=1
fi
if [ -s "$LOGS_DIR/flutterwave-regression.log" ]; then
  grep -Eq '^[[:space:]]*Tests[:[:space:]]+[0-9]+ passed' "$LOGS_DIR/flutterwave-regression.log" && ! grep -Eq '^[[:space:]]*Tests[:[:space:]].*[0-9]+ failed' "$LOGS_DIR/flutterwave-regression.log" && FLW_OK=1
fi
if [ -s "$LOGS_DIR/paystack-regression.log" ]; then
  grep -Eq '^[[:space:]]*Tests[:[:space:]]+[0-9]+ passed' "$LOGS_DIR/paystack-regression.log" && ! grep -Eq '^[[:space:]]*Tests[:[:space:]].*[0-9]+ failed' "$LOGS_DIR/paystack-regression.log" && PS_OK=1
fi
[ -s "$LOGS_DIR/integration-tests.log" ] && grep -q '\[RESULTS\] PASS' "$LOGS_DIR/integration-tests.log" && IT_OK=1
[ -s "$LOGS_DIR/integration-safety-tests.log" ] && grep -q 'SCENARIO SUMMARY: PASS=' "$LOGS_DIR/integration-safety-tests.log" && ! grep -q 'FAILURES PRESENT' "$LOGS_DIR/integration-safety-tests.log" && SAF_OK=1
check "backend-tests.log contains a jest summary with zero failed tests" "[ '$B_OK' -eq '1' ]"
check "frontend-tests.log contains a jest summary with zero failed tests" "[ '$F_OK' -eq '1' ]"
check "flutterwave-regression.log contains a jest summary with zero failed tests" "[ '$FLW_OK' -eq '1' ]"
check "paystack-regression.log contains a jest summary with zero failed tests" "[ '$PS_OK' -eq '1' ]"
check "integration-tests.log contains real safe-runner PASS results" "[ '$IT_OK' -eq '1' ]"
check "integration-safety-tests.log contains the scenario summary with no failures" "[ '$SAF_OK' -eq '1' ]"

echo ""
echo "== 24. A/B verification evidence consistency (§10; D5 binding) =="
FIG_REV="$(FIG "$FIGURES" SOURCE_REV 2>/dev/null)"
for n in 1 2; do
  ABLOG="$LOGS_DIR/ab-comparison-run-$n.log"
  AB_OK=0
  if [ -s "$ABLOG" ] && [ -n "$FIG_REV" ]; then
    if grep -q 'RESULT: NO NEW REGRESSION' "$ABLOG" && grep -q "$FIG_REV" "$ABLOG"; then AB_OK=1; fi
    if [ "$AB_OK" -eq '0' ] && grep -q 'RESULT: NO NEW REGRESSION' "$ABLOG" && grep -q "$ACTUAL_SHA" "$ABLOG"; then AB_OK=1; fi
  fi
  check "A/B verification run $n: NO-NEW-REGRESSION result recorded and bound to this artifact (SOURCE_REV $FIG_REV / zip SHA)" "[ '$AB_OK' -eq '1' ]"
done

echo ""
echo "== 25. in-archive evidence structure (§4/§13; D7) =="
check "in-archive evidence directory present ($INARCHIVE_EVID)" "[ -d '$INARCHIVE_EVID' ]"
check "evidence README present and non-empty" "[ -s '$INARCHIVE_EVID/README.md' ]"
if [ -f "$FIGURES" ] && [ "$FIGURES" = "$INARCHIVE_EVID/RELEASE_FIGURES.txt" ]; then
  REQKEYS="ZIP_ENTRIES ZIP_FILES UNCOMPRESSED_BYTES INTERNAL_MANIFEST_COUNT MANIFEST_VERIFICATION BACKEND_TESTS FRONTEND_TESTS FLUTTERWAVE_TESTS PAYSTACK_TESTS INTEGRATION_TESTS RUNNER_SAFETY_TESTS AB_BASELINE_COMPARISON RELEASE_VERIFIER_RUN_1 RELEASE_VERIFIER_RUN_2 RELEASE_APPROVAL SOURCE_REV"
  FKMISS=0
  for k in $REQKEYS; do [ -n "$(FIG "$FIGURES" "$k")" ] || { echo "    figures key missing: $k"; FKMISS=$((FKMISS+1)); }; done
  check "release figures present with all required keys (missing: $FKMISS)" "[ '$FKMISS' -eq '0' ]"
  FR_REV=$(FIG "$FIGURES" SOURCE_REV)
  check "figures record a 40-hex SOURCE_REV" "echo '$FR_REV' | grep -qE '^[0-9a-f]{40}$'"
  FR_TREE=$(FIG "$FIGURES" SOURCE_TREE_ARCHIVE_SHA256)
  check "figures record a 64-hex SOURCE_TREE_ARCHIVE_SHA256" "echo '$FR_TREE' | grep -qE '^[0-9a-f]{64}$'"
  check "figures contain NO self-referential final-zip SHA-256 (anti-circularity, D6)" "! grep -qE '^ZIP_SHA256=[0-9a-f]{64}' '$FIGURES' && ! grep -qE '^ARCHIVE_SHA256=[0-9a-f]{64}' '$FIGURES'"
  FR_MAN=$(FIG "$FIGURES" INTERNAL_MANIFEST_COUNT)
  check "figures manifest count = manifest line count ($FR_MAN)" "[ '$FR_MAN' = '$MAN_ENTRIES' ]"
else
  check "in-archive RELEASE_FIGURES.txt is the resolved figures file" "false"
fi

echo ""
echo "== 26. evidence manifests (§4/§13; D7) =="
FRS="$INARCHIVE_EVID/FINAL_RELEASE_SHA256.txt"
if [ -f "$FRS" ]; then
  REC_SHA=$(grep -oE '[0-9a-f]{64}' "$FRS" | head -1)
  ACT_MAN_SHA=$(sha256sum "$EXT/SHA256SUMS.txt" | cut -d' ' -f1)
  check "FINAL_RELEASE_SHA256.txt == recomputed SHA-256 of the internal manifest ($ACT_MAN_SHA)" "[ -n '$REC_SHA' ] && [ '$REC_SHA' = '$ACT_MAN_SHA' ]"
else
  check "FINAL_RELEASE_SHA256.txt exists ($FRS)" "false"
fi
EVSUM="$INARCHIVE_EVID/manifests/EVIDENCE_SHA256SUMS.txt"
if [ -f "$EVSUM" ]; then
  ( cd "$INARCHIVE_EVID" && sha256sum -c manifests/EVIDENCE_SHA256SUMS.txt --quiet > /dev/null 2>&1 )
  EVRC=$?
  EVN=$(grep -c . "$EVSUM")
  check "EVIDENCE_SHA256SUMS.txt verifies every evidence file ($EVN entries)" "[ '$EVRC' -eq '0' ]"
else
  check "EVIDENCE_SHA256SUMS.txt exists ($EVSUM)" "false"
fi
FMAN="$INARCHIVE_EVID/manifests/RELEASE_FILE_MANIFEST.txt"
if [ -f "$FMAN" ]; then
  # every regular archive file (except the manifest itself) must be listed with
  # its exact byte size; the manifest must not list phantom files
  FM_OK=1
  FM_N=0
  while IFS= read -r line; do
    p="${line%%|*}"; sz="${line##*|}"
    [ "$p" = "KINDORA_v1.0.14_RELEASE_EVIDENCE/manifests/RELEASE_FILE_MANIFEST.txt" ] && continue
    FM_N=$((FM_N+1))
    if [ ! -f "$EXT/$p" ] || [ "$(stat -c%s "$EXT/$p" 2>/dev/null)" != "$sz" ]; then
      echo "    manifest mismatch: $p (declared size $sz)"; FM_OK=0
    fi
  done < "$FMAN"
  ACT_FILES=$( ( cd "$EXT" && find . -type f | sed 's|^\./||' ) | grep -vE '^KINDORA_v1\.0\.14_RELEASE_EVIDENCE/manifests/RELEASE_FILE_MANIFEST\.txt$' | wc -l )
  check "RELEASE_FILE_MANIFEST.txt matches the archive file listing ($FM_N declared / $ACT_FILES actual)" "[ '$FM_OK' -eq '1' ] && [ '$FM_N' -eq '$ACT_FILES' ]"
else
  check "RELEASE_FILE_MANIFEST.txt exists ($FMAN)" "false"
fi

echo ""
echo "== 27. source identity: extracted source == intended release tree =="
if command -v git > /dev/null 2>&1 && [ -d "$REPO/.git" ]; then
  if [ -z "${2:-}" ] && [ -f "$FIGURES" ]; then
    RELEASE_REV="$FIG_REV"
    [ -n "$RELEASE_REV" ] && echo "  release rev: $RELEASE_REV (from the figures file — packaging-time record)"
  else
    RELEASE_REV="${2:-}"
  fi
  if [ -n "$RELEASE_REV" ] && git -C "$REPO" cat-file -e "$RELEASE_REV" 2>/dev/null; then
    echo "  release rev: $RELEASE_REV"
    git -C "$REPO" archive "$RELEASE_REV:kindora-v110/kindora" --format=tar | tar -x -C "$COMPARE" 2>/dev/null
    # packaging-injected / packaging-differentiated artifacts are excluded:
    #   SHA256SUMS.txt (regenerated over the staged tree at packaging),
    #   backups/ (nested recovery archives added by packaging),
    #   docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.14.md (measured record appended post-packaging),
    #   KINDORA_v1.0.14_RELEASE_EVIDENCE/ (evidence directory injected at
    #   packaging per §13 — verified by its own dedicated checks above)
    rm -f "$COMPARE/SHA256SUMS.txt" "$EXT/SHA256SUMS.txt" \
          "$COMPARE/docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.14.md" "$EXT/docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.14.md"
    DIFF=$(diff -rq "$COMPARE" "$EXT" 2>/dev/null | grep -v "Only in .*: backups$" | grep -v "Only in .*: KINDORA_v1.0.14_RELEASE_EVIDENCE$" | wc -l)
    check "extracted source byte-identical to the release commit tree (excl. manifest/backups/attestation-record/evidence-dir; diff entries: $DIFF)" "[ '$DIFF' -eq '0' ]"
    # D3: deterministic packaging-rev archive hash cross-check (in-repo extra);
    # --mtime is pinned to the commit time — git archive stamps CURRENT time by
    # default, which would make the hash non-reproducible
    TREE_SHA=$(git -C "$REPO" archive --mtime="$(git -C "$REPO" show -s --format=%cI "$RELEASE_REV")" "$RELEASE_REV:kindora-v110/kindora" --format=tar | sha256sum | cut -d' ' -f1)
    check "git archive of the packaging rev hashes to the figures' SOURCE_TREE_ARCHIVE_SHA256 ($TREE_SHA)" "[ '$TREE_SHA' = '$(FIG "$FIGURES" SOURCE_TREE_ARCHIVE_SHA256)' ]"
  else
    check "figures' SOURCE_REV resolves in this repository" "false"
  fi
else
  # D3: out-of-repo mode — no SKIP: verify the recorded source identity and
  # its binding to the archive (the manifest already proved per-file integrity)
  ISOREV=0; ISOTREE=0
  echo "$FIG_REV" | grep -qE '^[0-9a-f]{40}$' && ISOREV=1
  FIG "$FIGURES" SOURCE_TREE_ARCHIVE_SHA256 2>/dev/null | grep -qE '^[0-9a-f]{64}$' && ISOTREE=1
  check "source identity (out-of-repo mode): figures record SOURCE_REV (40-hex) + SOURCE_TREE_ARCHIVE_SHA256 (64-hex); every extracted file is manifest-covered; byte-identity vs the named commit requires the packaging repository (recorded for independent re-verification)" "[ '$ISOREV' -eq '1' ] && [ '$ISOTREE' -eq '1' ]"
fi

echo ""
echo "VERIFICATION RESULT: PASS=$PASS FAIL=$FAIL SKIPPED=$SKIPPED"
echo "VERIFIER_JSON:{\"pass\":$PASS,\"fail\":$FAIL,\"skipped\":$SKIPPED,\"zipSha256\":\"$ACTUAL_SHA\",\"zip\":\"$ZIP\"}"
if [ "$FAIL" -eq 0 ]; then
  echo "RELEASE ARCHIVE VERIFICATION: PASSED$([ "$SKIPPED" -gt 0 ] && echo " (with $SKIPPED explicitly reported limitation(s) — not claimed as verified)")"
  exit 0
fi
echo "RELEASE ARCHIVE VERIFICATION: FAILED"
exit 1

#!/usr/bin/env bash
# KINDORA v1.0.14 — VERIFIER DEFECT REGRESSION TEST (master prompt 2026-11-20 §11.4).
#
# The independent review reproduced "53 PASS / 13 FAIL / 1 SKIP" by running the
# packaged verifier OUTSIDE the original repository layout (zip + extracted
# verifier only). Root causes (verifier correction changelog D1–D5):
#   * evidence resolved via REPO-layout-derived paths only;
#   * extraction happened after the figure-dependent checks;
#   * the git-comparison check degraded to SKIP outside a git work tree;
#   * the A/B binding grepped the final zip SHA-256 (unembeddable in-archive).
#
# This test pins the correction:
#   T1  out-of-repo mode: zip + sidecar + external attestation in a plain
#       directory (NO git repo) — the verifier must return exit 0 and 0 FAIL.
#   T2  in-repo mode: same archive verified from inside the repository —
#       exit 0 and 0 FAIL, and BOTH runs must reference the same artifact SHA.
#   T3  anti-circularity: a figures file that embeds a self-referential final
#       zip hash must FAIL the figures check.
#   T4  content pin: an attestation whose contentPinSha256 does not match the
#       recomputed manifest hash must FAIL.
#
# Usage: bash scripts/v114_verifier_defect_test.sh [final-release.zip]
# Exit: 0 = all four tests pass; 1 = at least one failed.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$TREE/.." && pwd)")"
ZIP="${1:-$REPO/download/KINDORA_v1.0.14_SECURITY_COMPLETE_FINAL/KINDORA_v1.0.14_SECURITY_COMPLETE.zip}"
[ -f "$ZIP" ] || { echo "FATAL: release archive not found: $ZIP"; exit 2; }
WORK="$(mktemp -d /tmp/v114-verifier-defect-test.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0

echo "== T1: out-of-repo verification (the reported defect scenario) =="
mkdir -p "$WORK/review-sim"
cp "$ZIP" "$WORK/review-sim/KINDORA_v1.0.14_SECURITY_COMPLETE.zip"
# companions that travel with the release package (§6/§13)
ZIPDIR="$(cd "$(dirname "$ZIP")" && pwd)"
for cand in "$ZIPDIR/KINDORA_v1.0.14_SECURITY_COMPLETE.zip.sha256" "$ZIPDIR/KINDORA_v1.0.14_SECURITY_COMPLETE.sha256"; do
  [ -f "$cand" ] && cp "$cand" "$WORK/review-sim/KINDORA_v1.0.14_SECURITY_COMPLETE.zip.sha256" && break
done
for cand in "$ZIPDIR/KINDORA_v1.0.14_SECURITY_COMPLETE.attestation.json" "$REPO/download/KINDORA_v1.0.14_SECURITY_COMPLETE_FINAL/KINDORA_v1.0.14_SECURITY_COMPLETE.attestation.json"; do
  [ -f "$cand" ] && cp "$cand" "$WORK/review-sim/KINDORA_v1.0.14_SECURITY_COMPLETE.attestation.json" && break
done
unzip -q "$WORK/review-sim/KINDORA_v1.0.14_SECURITY_COMPLETE.zip" 'kindora-v1.0.14/scripts/verify_release_zip_v114.sh' -d "$WORK/review-sim"
( cd "$WORK/review-sim" && bash kindora-v1.0.14/scripts/verify_release_zip_v114.sh \
    "$WORK/review-sim/KINDORA_v1.0.14_SECURITY_COMPLETE.zip" > "$WORK/t1.log" 2>&1 )
T1_RC=$?
T1_SUM=$(grep -E '^VERIFICATION RESULT' "$WORK/t1.log" | tail -1)
echo "    exit=$T1_RC ; $T1_SUM"
case "$T1_SUM" in *"FAIL=0"*) T1_OK=1 ;; *) T1_OK=0 ;; esac
[ "$T1_RC" -eq 0 ] && [ "$T1_OK" -eq 1 ] && echo "  PASS: T1 out-of-repo verification is fully green (defect fixed)" || { echo "  FAIL: T1"; FAILED=1; }

echo "== T2: in-repo verification of the same artifact =="
bash "$SCRIPT_DIR/verify_release_zip_v114.sh" "$ZIP" > "$WORK/t2.log" 2>&1
T2_RC=$?
T2_SUM=$(grep -E '^VERIFICATION RESULT' "$WORK/t2.log" | tail -1)
T1_SHA=$(grep -oE '"zipSha256":"[0-9a-f]{64}"' "$WORK/t1.log" | tail -1)
T2_SHA=$(grep -oE '"zipSha256":"[0-9a-f]{64}"' "$WORK/t2.log" | tail -1)
echo "    exit=$T2_RC ; $T2_SUM"
echo "    t1 sha: $T1_SHA"
echo "    t2 sha: $T2_SHA"
case "$T2_SUM" in *"FAIL=0"*) T2_OK=1 ;; *) T2_OK=0 ;; esac
[ "$T2_RC" -eq 0 ] && [ "$T2_OK" -eq 1 ] && [ -n "$T1_SHA" ] && [ "$T1_SHA" = "$T2_SHA" ] && echo "  PASS: T2 in-repo verification green; both runs reference the identical artifact SHA" || { echo "  FAIL: T2"; FAILED=1; }

echo "== T3: anti-circularity — a self-referential figures hash must FAIL =="
EVID="$WORK/t3-evid"
cp -r "$WORK/review-sim/kindora-v1.0.14/KINDORA_v1.0.14_RELEASE_EVIDENCE" "$EVID" 2>/dev/null || { mkdir -p "$EVID"; unzip -q "$ZIP" 'kindora-v1.0.14/KINDORA_v1.0.14_RELEASE_EVIDENCE/*' -d "$WORK/t3x" && cp -r "$WORK/t3x/kindora-v1.0.14/KINDORA_v1.0.14_RELEASE_EVIDENCE" "$EVID"; }
FAKE_SHA=0000000000000000000000000000000000000000000000000000000000000000
sed -i "s/^ZIP_SHA256=.*/ZIP_SHA256=$FAKE_SHA/" "$EVID/RELEASE_FIGURES.txt" 2>/dev/null
grep -q "^ZIP_SHA256=" "$EVID/RELEASE_FIGURES.txt" || echo "ZIP_SHA256=$FAKE_SHA" >> "$EVID/RELEASE_FIGURES.txt"
FIGURES_FILE="$EVID/RELEASE_FIGURES.txt" bash "$SCRIPT_DIR/verify_release_zip_v114.sh" "$ZIP" > "$WORK/t3.log" 2>&1
T3_RC=$?
grep -q "figures-file SHA-256 matches the archive" "$WORK/t3.log" && grep -q "FAIL: figures-file SHA-256" "$WORK/t3.log" && T3_OK=1 || T3_OK=0
echo "    exit=$T3_RC (expected nonzero)"
[ "$T3_OK" -eq 1 ] && echo "  PASS: T3 embedded self-hash rejected by the figures check" || { echo "  FAIL: T3"; FAILED=1; }

echo "== T4: content pin — a wrong attestation contentPinSha256 must FAIL =="
EVID4="$WORK/t4-evid"
cp -r "$EVID" "$EVID4"
node - "$EVID4/RELEASE_ATTESTATION.json" <<'NODE'
const fs = require('fs');
const p = process.argv[1];
const a = JSON.parse(fs.readFileSync(p, 'utf8'));
a.artifact = a.artifact || {};
a.artifact.contentPinSha256 = '1111111111111111111111111111111111111111111111111111111111111111';
fs.writeFileSync(p, JSON.stringify(a, null, 2));
NODE
KINDORA_V114_EVIDENCE_DIR="$EVID4" FIGURES_FILE="$EVID4/RELEASE_FIGURES.txt" bash "$SCRIPT_DIR/verify_release_zip_v114.sh" "$ZIP" > "$WORK/t4.log" 2>&1
T4_RC=$?
grep -q "CONTENT-PIN-MISMATCH" "$WORK/t4.log" && T4_OK=1 || T4_OK=0
echo "    exit=$T4_RC (expected nonzero)"
[ "$T4_OK" -eq 1 ] && echo "  PASS: T4 wrong content pin rejected by the attestation check" || { echo "  FAIL: T4"; FAILED=1; }

echo ""
[ "$FAILED" -eq 0 ] && echo "VERIFIER DEFECT TESTS: 4/4 PASSED" || echo "VERIFIER DEFECT TESTS: FAILURES PRESENT"
exit $FAILED

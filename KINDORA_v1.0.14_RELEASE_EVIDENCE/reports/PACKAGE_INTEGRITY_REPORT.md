# PACKAGE INTEGRITY REPORT — KINDORA v1.0.14 SECURITY COMPLETE

This report documents the packaging procedure and the integrity checks applied
to the archive (master prompt §13/§14 Phase A–N). The machine-checked results
of the packaging-time audit are in `logs/archive-audit.log`,
`logs/manifest-verification.log` and `logs/checksum-verification.log`; the
post-freeze verification records are external (`verifier-run-1.log`,
`verifier-run-2.log` in the delivery directory) because they attest the FROZEN
artifact and cannot be embedded inside it.

## Packaging procedure (executed in this exact order)

1. **Source verification (Phase A)** — the stage is created from
   `git archive 755f0e9061954c69a5cc537259d14a77aa695faf:kindora-v110/kindora`
   (the committed corrected source; `SOURCE_REV` in RELEASE_FIGURES.txt).
   Secret scan, no temp/build artifacts, no stale archives.
2. **Tests (Phase B)** — fresh executions on 2026-11-20 (see
   `reports/TEST_RESULTS.md`); logs shipped in `logs/`.
3. **Safety tests (Phase C)** — integration-runner scenarios A–H, 16/16
   (`logs/integration-safety-tests.log` + `logs/safety-scenarios/`).
4. **Baseline comparison (Phase D)** — two independent runs, NO NEW REGRESSION
   (`logs/ab-comparison-run-1/2.log`).
5. **Nested recovery backups injected** — pristine v1.0.13 baseline + v1.0.14
   final backup, each with its own manifest + sidecar (unchanged from the
   reviewed archive).
6. **Evidence directory injected** — this directory (§13).
7. **Internal manifest (Phase E)** — `SHA256SUMS.txt` regenerated over the
   staged tree: every regular file EXCEPT itself, `FINAL_RELEASE_SHA256.txt`
   and `RELEASE_ATTESTATION.json` (the latter two are recomputation-verified —
   acyclic hash graph, see README.md). Every entry verified with
   `sha256sum -c` (`logs/manifest-verification.log`).
8. **Fixed-point figures** — entry count, file count, uncompressed size and
   manifest count are measured from the staged tree and recorded in
   `RELEASE_FIGURES.txt` with exact-width values; the final ZIP is then built
   and re-measured to confirm the recorded values equal the actual archive
   (the verifier re-checks this from the outside).
9. **Final ZIP (Phase F)** — built from the stage; nothing is modified after.
10. **Archive integrity (Phase G)** — CRC check, duplicate-path check,
    unsafe-path check, stale-archive check, figures re-measurement
    (`logs/archive-audit.log`).
11. **External checksum (Phase H)** — `KINDORA_v1.0.14_SECURITY_COMPLETE.zip.sha256`
    generated from the frozen ZIP only, verified with `sha256sum -c` by a
    separate command (`logs/checksum-verification.log` records the packaging-time
    verification; the sidecar file itself travels OUTSIDE the archive).
12. **Attestation + evidence manifests (Phase I/K)** — content pin, figures,
    `EVIDENCE_SHA256SUMS.txt`, `RELEASE_FILE_MANIFEST.txt` finalized.
13. **Verifier runs (Phase L/M)** — two independent runs against the frozen
    ZIP: run 1 inside the packaging repository, run 2 in a plain directory
    outside any repository (the independent-reviewer scenario). Both must be
    green and must reference the same artifact SHA-256; the records are the
    external `verifier-run-1.log` / `verifier-run-2.log`.
14. **Final integrity verification (Phase N)** — the ZIP SHA-256 re-measured
    after every step; the sidecar re-verified; figures/attestation re-checked.
    No file is changed after the final verification.

## Integrity facts (verified at packaging; re-verified post-freeze externally)

* 0 missing manifest entries, 0 unexpected entries, 0 checksum mismatches
* 0 duplicate archive paths, 0 unsafe (absolute/traversal) paths,
  0 symlink entries
* 0 stale archives, 0 temp/build files outside the evidence directory
* internal manifest coverage: every regular file except the three files with
  documented recomputation-based verification

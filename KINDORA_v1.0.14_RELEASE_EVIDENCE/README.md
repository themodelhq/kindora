# KINDORA v1.0.14 SECURITY COMPLETE — RELEASE EVIDENCE DIRECTORY

**Packaged inside the release archive** (master prompt 2026-11-20 §4/§13). An
independent reviewer holding the release package — the ZIP plus its external
checksum sidecar `KINDORA_v1.0.14_SECURITY_COMPLETE.zip.sha256` — finds every
required evidence artifact here, and the packaged verifier
(`scripts/verify_release_zip_v114.sh`) resolves this directory automatically.

## Structure

```text
KINDORA_v1.0.14_RELEASE_EVIDENCE/
├── README.md                     ← this file (provenance + procedure)
├── RELEASE_FIGURES.txt           ← measured release figures (§5 template)
├── RELEASE_ATTESTATION.json      ← machine-readable attestation (§7 schema)
├── FINAL_RELEASE_SHA256.txt      ← SHA-256 of the internal SHA256SUMS.txt
├── logs/                         ← genuine execution logs (see provenance)
├── reports/                      ← human-readable evidence reports
└── manifests/
    ├── EVIDENCE_SHA256SUMS.txt   ← sha256 of every evidence file (except
    │                               itself and the two recomputation-verified
    │                               files: FINAL_RELEASE_SHA256.txt and
    │                               RELEASE_ATTESTATION.json)
    └── RELEASE_FILE_MANIFEST.txt ← path|size of every regular archive file
                                    (except itself)
```

## Log name mapping (master prompt §4/§8 recommended names → established names)

The repository has an established evidence-log naming convention (referenced by
the verifier, the attestation and the release reports). The recommended names
map to it as follows — no duplicate copies are created:

| Recommended name | Actual file in `logs/` |
|---|---|
| backend_tests.log | `backend-tests.log` |
| frontend_tests.log | `frontend-tests.log` |
| flutterwave_tests.log | `flutterwave-regression.log` |
| paystack_tests.log | `paystack-regression.log` |
| integration_tests.log | `integration-tests.log` |
| integration_runner_safety_tests.log | `integration-safety-tests.log` |
| baseline_ab_run_1.log | `ab-comparison-run-1.log` |
| baseline_ab_run_2.log | `ab-comparison-run-2.log` |
| release_verifier_run_1.log | **external** — see below |
| release_verifier_run_2.log | **external** — see below |
| package_integrity.log | `archive-audit.log` (same evidence, established name) |

Additional genuine logs shipped: `engineering-gates.log` (typecheck, prisma,
migrations-vs-schema structural check, dependency audit gates),
`payout-ledger-regression.log` (payout/ledger financial-semantics regression),
`baseline-audit.log`, `build.log`, `checksum-verification.log`,
`manifest-verification.log`, `archive-audit.log`, `final-release-summary.log`.

## Provenance (master prompt §8)

Every log in `logs/` was produced by an ACTUAL execution on 2026-11-20 in the
packaging repository at source revision `755f0e9061954c69a5cc537259d14a77aa695faf`
(the committed corrected v1.0.14 source; recorded inside each log). No log is
copied from v1.0.13 or any other build; none was edited to change its result.
Environment: Linux sandbox, Node v24.22.3, npm ci from committed lockfiles,
PostgreSQL 17.9 (`@embedded-postgres/linux-x64@17.9.0-beta.16`), Redis 7.2.5
(source build from the sha256-verified tarball
`5981179706f8391f03be91d951acafaeda91af7fac56beffb2701963103e423d`).

Known execution-environment incidents, disclosed inside the logs:

* the integration orchestration hit execution-environment timeouts twice; the
  affected runner executions were re-executed in full and the partial runs
  discarded (see the `[orchestrator] disclosure:` lines in
  `integration-tests.log`);
* orphaned runner PostgreSQL processes from the killed attempts were terminated
  BY PID after `/proc/<pid>/cmdline` identity verification, and their owned run
  roots were removed after an ownership check — no port- or name-based killing;
* all shipped logs are from the FINAL dependency tree (after the scoped
  `effect` remediation documented in `docs/DEPENDENCY_SECURITY_REPORT.md`).

## Provider sandbox status (§8 BLOCKED template)

```text
STATUS: BLOCKED
REASON: FLUTTERWAVE_SECRET_KEY / PAYSTACK_SECRET_KEY are not available in the build environment
REQUIRED DEPENDENCY: provider sandbox API credentials
WHAT WAS NOT EXECUTED: live Flutterwave/Paystack sandbox verification (no live money-path test was executed or claimed)
```

The provider regression suites that run WITHOUT credentials (157 flutterwave +
111 paystack unit-level checks, 184 payout/ledger checks) were executed fresh
and are shipped in `logs/`. This blocker is accepted by the release policy for
ARCHIVE verification and does not establish production readiness (see
`reports/SECURITY_RELEASE_REPORT.md`).

## Circular-hash avoidance procedure (master prompt §13)

A file inside an archive cannot state the archive's own final SHA-256 or byte
size: writing the value would change the value (self-reference). The procedure
used here — verified mechanically by the packaged verifier (changelog D6):

1. **Inside the archive** (this directory):
   * `RELEASE_FIGURES.txt` records every measurable property (entry count,
     file count, uncompressed size, manifest count, test results, verbatim
     statuses) — except the final ZIP SHA-256 and ZIP byte size, which carry
     the marker `RECORDED-EXTERNALLY-SEE-SIDECAR`;
   * `RELEASE_ATTESTATION.json` records the same facts and binds itself to
     THIS archive via `artifact.contentPinSha256` = SHA-256 of the internal
     manifest `SHA256SUMS.txt` — the verifier RECOMPUTES that hash from the
     archive and fails on mismatch, so the attestation cannot be transplanted;
     it deliberately contains NO self-referential zip hash;
   * `FINAL_RELEASE_SHA256.txt` = SHA-256 of the internal manifest — verified
     by recomputation;
   * the internal manifest `SHA256SUMS.txt` covers every regular archive file
     EXCEPT itself, `FINAL_RELEASE_SHA256.txt` and `RELEASE_ATTESTATION.json`
     (the last two are recomputation-verified instead — this keeps the hash
     graph acyclic);
   * `EVIDENCE_SHA256SUMS.txt` covers every evidence file except itself and
     the two recomputation-verified files.
2. **Outside the archive** (release-package companions):
   * `KINDORA_v1.0.14_SECURITY_COMPLETE.zip.sha256` — the final archive
     SHA-256, generated only after the archive was frozen, in
     `sha256sum -c` format;
   * the delivery-directory attestation JSON records the final SHA-256, byte
     size, entry/file counts and the two post-freeze verifier runs.
3. If the archive were modified after freezing: re-measure, regenerate the
   sidecar, figures, attestation and manifests, and re-run all verification
   (master prompt §6) — the frozen archive is never touched in place.

## Verifier run logs

The two independent verifier runs required by §15 execute against the FROZEN
archive and are therefore recorded OUTSIDE it (in the delivery directory as
`verifier-run-1.log` / `verifier-run-2.log`); embedding them would modify the
artifact they attest. `logs/final-release-summary.log` is the genuine
packaging-phase summary and states this explicitly.

# KINDORA v1.0.14 — A/B VERIFICATION LOG RECONCILIATION (canonical summary)

Purpose (release prompt Phase 5): the v1.0.13 verification records contained
multiple A/B execution directories with differing completeness. This report
investigates the ORIGINAL artifacts, establishes one canonical summary, and
explicitly marks what the evidence cannot establish as **UNRESOLVED**. No
counts are added together; no result is chosen because it "looks better".

---

## 1. What A and B represent

* **A (baseline)**: the pristine KINDORA v1.0.12 release tree, extracted
  from `backups/KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz` (itself built from
  the pinned v1.0.12 release commit `3bf94f0` and verified 430/430 against
  its manifest). Dependencies installed from the backup's own lockfile.
* **B (release)**: the KINDORA v1.0.13 release tree (the working checkout
  containing the v1.0.13 envelope correction), dependencies installed from
  the same lockfile state.

## 2. Which scripts were executed

One script, `scripts/v113_baseline_ab_comparison.sh`, in THREE successive
revisions during the session:

| Revision | Defect observed |
|---|---|
| v0 (as first written) | DB-provisioning step referenced a wrong module path (`MODULE_NOT_FOUND`) — aborted BEFORE any test executed |
| v1 | aggregation stage crashed (`unbound variable`) AFTER both sides executed; the outcome extractor used an anchored `grep '^✓'` that missed jest's INDENTED result lines, so the aggregated pass/fail files were written EMPTY |
| v2 (final, committed at `9a30219`) | outcome extraction fixed (indented lines, per-test-name `comm` comparison); this is the committed script |

## 3. Execution-by-execution analysis (the four tracked directories)

Tracked evidence: `release-verification-logs/v113-ab-*/` — the aggregation
text files ONLY. The full jest/migrate/seed logs were matched by the
repository's `*.log` ignore rule and were therefore NOT committed; they
existed in the workspace but are not part of the tracked evidence. Each
item below states exactly what the tracked evidence establishes.

### v113-ab-20261116T131621Z — ABORTED (execution error, not a test result)
* What happened: script revision v0 failed at database provisioning
  (`MODULE_NOT_FOUND`) before creating the databases; no test ran on either
  side.
* Tracked artifacts: `baseline-outcomes.txt` / `release-outcomes.txt`
  (both empty).
* **Tests executed: 0. Contribution to the verification result: none.**

### v113-ab-20261116T131709Z — EXECUTED, AGGREGATION DEFECTIVE → **UNRESOLVED**
* What happened: script revision v1 executed BOTH sides (the console
  transcript recorded `Tests: 15 skipped, 1 passed, 16 total` per side for
  the payout-lockdown §3.1/§3.2 scenario) and then crashed at aggregation.
* Tracked artifacts: `baseline-pass.txt` / `release-pass.txt` /
  `baseline-fail.txt` — all EMPTY (written by the defective anchored
  extraction). Full jest logs not tracked (lost).
* **Test-level outcome from tracked evidence alone: UNRESOLVED.** The
  console transcript indicates both sides passed the selected test, but
  that transcript is not independently verifiable from tracked artifacts,
  so this invocation is NOT counted as verification evidence.

### v113-ab-20261116T131855Z — VALID (payout-lockdown §3.1/§3.2)
* Script revision v2, clean end-to-end run, 1 iteration per side.
* Tracked artifacts: `baseline-pass.txt` = `release-pass.txt` =
  `§3.1/§3.2: manual settlement is BLOCKED while a provider submission is
  pending or in flight (in-lock recheck + durable guard)`; both fail files
  empty.
* **Result: 1 test, PASSED on A AND PASSED on B — no new regression.**

### v113-ab-20261116T132035Z — VALID (withdrawals concurrency)
* Script revision v2, clean end-to-end run, 1 iteration per side.
* Tracked artifacts: both pass files contain `concurrent withdrawal
  requests cannot overdraw: exactly one of two 800k requests succeeds`;
  both fail files empty.
* **Result: 1 test, PASSED on A AND PASSED on B — no new regression.**

## 4. Canonical verification summary (one summary, not a sum)

| Quantity | Value | Basis |
|---|---|---|
| Test cases discovered (selected by name filters) | 2 distinct (payout-lockdown §3.1/§3.2; withdrawals concurrency) | the two `-t` name filters of the valid runs |
| Test cases EXECUTED (successful invocations) | 4 executions = 2 scenarios × 2 sides | tracked pass files of 131855Z + 132035Z |
| Successful executions | 4 | same |
| Failed executions | 0 | fail files empty in the valid runs |
| Skipped executions | 15 per suite-side invocation (the name filter selected 1 of the suite's 16 tests; jest reports the other 15 as skipped) | the suite structure; NOT test-level verification results |
| Repeated executions | the §3.1/§3.2 scenario was executed twice per side across invocations (131709Z + 131855Z); only the 131855Z execution carries tracked evidence — the repeat is documented, not double-counted | execution history above |
| Tests not executed | none claimed beyond the two scenarios | — |
| Verification errors | 2 script defects (v0 module path; v1 aggregation crash) — both fixed; the affected invocations are excluded from the result | execution history above |
| UNRESOLVED | the 131709Z invocation's test-level outcome (evidence lost to the log ignore rule) | explicitly carried into the v1.0.14 outstanding-issues list |

**Canonical A/B conclusion: across all VALID tracked executions, zero
regressions were observed (4/4 successful executions passed on both
sides); one invocation remains UNRESOLVED and is excluded.**

## 5. Why the counts "conflicted"

The v1.0.13 session records referenced A/B runs three times (aborted,
crashed, clean). Adding the directories' test counts together would have
produced an inflated figure mixing an aborted run and a defective-aggregation
run with valid runs; choosing only the best-looking run would have hidden
the two script defects. This report instead enumerates every invocation,
its script revision, and its evidentiary status.

## 6. Log-preservation correction carried into v1.0.14

Root cause of the lost evidence: the repository's `*.log` ignore rule
silently excluded the full jest/migrate/seed logs when the directory was
committed. For v1.0.14 the complete logs of every verification execution
are preserved under the release evidence package's
`release-verification-logs/` directory and are committed with an explicit
force-add, so no future reconciliation depends on untracked files. The
fresh v1.0.14 A/B evidence is generated with the committed v2 script, and
each run identifies its source commit and the artifact hash it verified.

## 7. Fresh v1.0.14 A/B runs

Per the release prompt (Phase 5), a FRESH clean verification run is
executed for v1.0.14 with the committed v2 script; every fresh run
identifies its source commit and the artifact hash it verified, and the
complete logs (jest, migrate, seed, infrastructure) are committed under
the release evidence package so no future reconciliation depends on
untracked files. The fresh-run results are recorded — with actual measured
outcomes only — in `docs/KINDORA_v1.0.14_VERIFICATION_REPORT.md` §A/B and
the `release-verification-logs/` directory of the release evidence
package.

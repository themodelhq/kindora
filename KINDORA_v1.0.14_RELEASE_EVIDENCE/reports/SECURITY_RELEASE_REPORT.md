# SECURITY RELEASE REPORT — KINDORA v1.0.14 SECURITY COMPLETE (evidence correction, 2026-11-20)

## 1. Scope discipline (master prompt §1)

This correction is a release-evidence/packaging/verifier task. The v1.0.14
security-corrected application is preserved. Changes made by this task
(source rev `072ee3910fabf3b9f8c4fd68d98752c48a617f37` vs the previous
corrected source):

| File | Why (release-gate defect it fixes) |
|---|---|
| `scripts/verify_release_zip_v114.sh` | verifier defects D1–D7 (see the changelog inside the file): the packaged verifier could not find ANY evidence outside the original repo layout — the exact cause of the independently reproduced `53 PASS / 13 FAIL / 1 SKIP`; the git-comparison degraded to SKIP out-of-repo; the temp-file check contradicted the evidence-log requirements; the A/B binding grepped an unembeddable self-hash. All previous checks preserved; new checks added; no check removed or weakened. |
| `scripts/v114_verifier_defect_test.sh` | NEW — regression test for the above defects (4 tests, §11.4). |
| `backend/package.json` + `backend/package-lock.json`, `workers/package.json` + `workers/package-lock.json` | scoped `overrides.effect@^3.22.1` — remediates GHSA-7589-6fvf-x4pw (ReDoS in `effect` via `@prisma/client → prisma → @prisma/config`, build-tooling chain, 0 runtime imports) which started failing the dependency audit gate when the registry advisory began naming `effect` separately. Verified post-change: all gates + full test battery green. |
| `docs/DEPENDENCY_SECURITY_REPORT.md` | dated remediation record for the `effect` override (the gate's co-documentation rule). |
| `KINDORA_v1.0.14_RELEASE_EVIDENCE/` | NEW — the in-archive evidence directory (§4/§13). |

NOT changed: backend/frontend/workers application source, payment providers,
ledger, webhooks, auth, campaigns, migrations, Prisma schema, deploy config.
The Flutterwave payout adapter is byte-identical to its v1.0.13-verified
counterpart: sha256 `d9b1aceddd947f19ca9750c3d2c589eed7d91125f22890f70b18d35bbb44dc17`
(measured in the packaging repo and inside the archive — UNCHANGED).

## 2. Security properties preserved

* Payment envelope semantics: `meta === undefined` → ABSENT, `meta === null` →
  MALFORMED (never silently reclassified); ambiguous transfers never
  auto-approved — 157/157 flutterwave + 111/111 paystack checks green.
* Ledger integrity / idempotency / payout authorization state machine — 184/184
  payout+ledger checks green; money-path integration 12/12; payout-lockdown 16/16.
* Integration-runner safety (v1.0.14 completion-patch §7/§8/§9): atomic
  `mktemp -d` run roots (mode 700, TMPDIR validated), PID-tracked +
  identity/socket-verified Redis shutdown, no broad `pkill`, per-execution
  crypto-random seed credentials (never logged), ownership-guarded cleanup —
  proven externally by safety scenarios A–H 16/16 with decoy PostgreSQL+Redis
  alive after every scenario.
* No secrets in the tree: verifier secret scanning + packaging audit.

## 3. Dependency security status

| Advisory | Package | Status |
|---|---|---|
| GHSA-ggr8-5vv4-36mx (+ GHSA-7589-6fvf-x4pw chain) | deepmerge-ts / @prisma/config via Prisma CLI | DOCUMENTED-ACCEPTED (build tooling only; fix with prisma ≥ 7.11 — unchanged policy, see DEPENDENCY_SECURITY_REPORT.md §3) |
| GHSA-7589-6fvf-x4pw | `effect` (newly flagged by the registry advisory graph) | **REMEDIATED** — scoped override to `^3.22.1` (resolves 3.22.5 ≥ patched 3.22.1); regression-proven |

## 4. Release status

`APPROVED-FOR-ARCHIVE-RELEASE` (see `RELEASE_ATTESTATION.json` `release_status`
and RELEASE_FIGURES.txt `RELEASE_APPROVAL`) — meaning: the artifact passes all
archive-verification gates with genuine, reproducible evidence. Provider
sandbox verification is BLOCKED (no credentials in this environment) and is
accepted by the archive release policy as a disclosed blocker.
**This is NOT production readiness** — live money movement requires provider
sandbox (and then production) verification by a credentialed operator.

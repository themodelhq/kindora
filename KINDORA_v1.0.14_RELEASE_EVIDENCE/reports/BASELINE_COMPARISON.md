# BASELINE COMPARISON — KINDORA v1.0.14 vs pristine v1.0.13 (§10)

Two independent A/B comparison runs were executed fresh on 2026-11-20 through
the packaged entry point `scripts/v114_baseline_ab_comparison.sh` over the
preserved implementation `scripts/v113_baseline_ab_comparison.sh`.

## Identities (recorded in each log)

| Item | Value |
|---|---|
| Baseline | pristine pre-v1.0.14 tree: `KINDORA_v1.0.13_FINAL_BACKUP.tar.gz`, sha256 `350c961e1ed5ce50a7cfc008c42de9d570a46cb2c79a7643ff7888b225b489eb` |
| Release candidate | committed corrected v1.0.14 source, source rev `072ee3910fabf3b9f8c4fd68d98752c48a617f37` (recorded in both logs) |
| Comparison target | `storage.e2e-spec` (all test names), 1 iteration per side, REAL PostgreSQL 17.9 + Redis 7.2.5 per run |
| Command | `bash scripts/v114_baseline_ab_comparison.sh <baseline.tar.gz> storage.e2e-spec` |

## Results

| Run | Executed at (UTC) | Exit | Result | Accounting (unique identities) |
|---|---|---|---|---|
| 1 | 20261120T084310Z | 0 | **NO NEW REGRESSION** | discovered 3 · executed 3 · passed baseline 3 · failed baseline 0 · passed release 3 · failed release 0 · errors 0 |
| 2 | 20261120T084411Z | 0 | **NO NEW REGRESSION** | identical accounting |

Both runs were executed independently (separate extractions, separate database
instances, separate processes). The accounting was never summed or deduplicated
across runs; each log carries its own measured numbers.

## Binding to the release artifact

The release tree compared is the committed source rev `755f0e9…` — the same rev
the final archive stages from (`git archive 755f0e9:kindora-v110/kindora`,
packaging-time record `SOURCE_REV` in `RELEASE_FIGURES.txt`, tree-archive hash
`SOURCE_TREE_ARCHIVE_SHA256=ded30d10…`). The archive↔rev binding is proven by
the internal manifest and the verifier's source-identity checks; in-repo runs
additionally prove byte-identity against the commit. The A/B logs therefore
bind to the artifact via `SOURCE_REV` (a final ZIP self-hash cannot be embedded
inside its own archive — see README.md).

## Financial-semantics preservation

The comparison target exercises the storage/money-path infrastructure; the
payment-semantics regression evidence lives in `logs/flutterwave-regression.log`
(envelope ABSENT/MALFORMED/PRESENT/AMBIGUOUS classification preserved —
`meta === null` is MALFORMED, never silently reclassified), `logs/paystack-regression.log`,
and `logs/payout-ledger-regression.log`. The Flutterwave payout adapter is
byte-identical to its v1.0.13-verified counterpart
(`d9b1aceddd947f19ca9750c3d2c589eed7d91125f22890f70b18d35bbb44dc17`).

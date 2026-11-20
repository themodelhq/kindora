# KINDORA — Goodness, in motion.

KINDORA is a global crowdfunding and social-impact platform: verified campaigns, guest and account donations through Paystack / Flutterwave / Stripe / PayPal, sponsor matching pools, giving circles, an organization portal, and a **public double-entry impact ledger** behind every money movement.

| Piece | Stack | Deployed to | Directory |
| --- | --- | --- | --- |
| Web app (PWA) | React 18, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand | Netlify | `frontend/` |
| REST API | NestJS 11, Prisma 6, PostgreSQL, BullMQ | Render | `backend/` |
| Background workers | BullMQ workers + cron scripts | Render Worker + Cron | `workers/` |

## v1.0.14 — release integrity correction, payment validation preservation & verification hardening

`v1.0.14_SECURITY_COMPLETE` is a verification-integrity release with ZERO
application-code change: the Flutterwave payout adapter is byte-identical
to v1.0.13 (the null-envelope correction is fully preserved and
re-verified). The destructive integration-test runner (`pkill -9 postgres`,
`pkill -f "redis-server 127"`, fixed shared `rm -rf` paths) is replaced by
a safe runner with PID tracking, graceful shutdown, bounded timeouts,
port-conflict detection, `--dry-run`, and trap-based cleanup — proven by
six scenarios (dry-run, success, failure, interruption, missing service,
port conflict) with unrelated decoy services unaffected. The A/B
verification evidence is reconciled in one canonical report (abort /
UNRESOLVED / valid invocations enumerated, nothing added together), with
fresh v1.0.14 runs passing on both sides. Artifact integrity: figures are
measured from the final frozen ZIP (measured twice by the verifier from
clean states), duplicate archive paths are checked, and the v1.0.13
checksum lineage is documented as historical reference only.

- A/B reconciliation: `docs/A_B_VERIFICATION_RECONCILIATION_V1.0.14.md`
- Release notes: `docs/KINDORA_v1.0.14_RELEASE_NOTES.md`
- Verification report (unit 595/595, integration 63/63 via the safe
  runner, frontend 53/53, safe-runner scenarios 6/6, provider sandbox
  BLOCKED): `docs/KINDORA_v1.0.14_VERIFICATION_REPORT.md`
- Release classification: **STAGING READY** — see
  `docs/FINAL_ENGINEERING_REPORT_V1.0.14.md`.

## v1.0.13 — strict Flutterwave envelope validation & release verification completion

`v1.0.13_SECURITY_COMPLETE` closes the two confirmed v1.0.12 defects —
strictly in the conservative direction. An explicitly NULL envelope `meta`
is now MALFORMED instead of ABSENT (`undefined` and `null` are materially
different): the exploit shape — `meta: null` over a complete valid nested
`data.meta`, which previously classified as an authoritative NOT_FOUND (an
automatic resubmission trigger) — is now AMBIGUOUS, with the full
classification table (absent / null / primitive / array / unrecognized /
valid `page_info`) implemented and unit-tested, and no malformed envelope
able to upgrade a lookup into FOUND or NOT_FOUND in either direction. The
release-verification scripts (phase-0 backup, final backup, 19-check
archive verifier, deterministic baseline A/B comparison) are now PACKAGED
INSIDE the archive, correcting the v1.0.12 discrepancy, and the archive
checksum/attestation handling separates nested-backup checksums, the
internal manifest, the external ZIP sidecar and the post-packaging
verification record. Every v1.0.12 pagination protection is preserved
(per-shape mandatory field sets, joint container validation, S3 removal,
S1/S2 distinction, 12-step sequence); no migration, no frontend or
pipeline change.

- Provider reference (envelope classification table, preserved pagination
  contract): `docs/PROVIDER_INTEGRATION_V1.0.13.md`
- Release notes: `docs/KINDORA_v1.0.13_RELEASE_NOTES.md`
- Test report (backend unit 595/595 incl. the new 27-test envelope suite,
  integration 63/63 on real PostgreSQL 17.9 + Redis 7.2.5 with zero
  flakes, frontend 53/53, provider sandbox BLOCKED):
  `docs/KINDORA_v1.0.13_TEST_REPORT.md`
- Release classification: **STAGING READY** — see
  `docs/FINAL_ENGINEERING_REPORT_V1.0.13.md`.

## v1.0.12 — Flutterwave pagination contract completeness & joint container validation

`v1.0.12_SECURITY_COMPLETE` closes the three structural gaps the v1.0.11
review left open — strictly in the conservative direction. The mandated
pagination fields are now explicit per-shape constants
(`{total, current_page, total_pages}` for BOTH supported shapes): a bare
result count (`total: 0` with no page context) no longer classifies and can
never produce an authoritative NOT_FOUND, and `current_page` is one-based.
Every supplied metadata container (outer `data.meta`, nested
`data.meta.pagination`, envelope `meta.page_info`) is validated JOINTLY —
containers that disagree are contradictory (the v1.0.11 nested-selection
could silently drop the outer evidence), malformed containers never
authorize outer-fallback, and fields may be satisfied collectively across
containers. The "legacy complete array" classification (S3) is REMOVED:
every metadata-free `data: [...]` array is AMBIGUOUS in both directions,
because a bare array on the current paginated endpoint is
byte-indistinguishable from a truncated page and no verifiable legacy
signal exists. The delta vs v1.0.11 is exclusively responses moving INTO
AMBIGUOUS — never out; no migration, no frontend or pipeline change.

- Provider reference (shapes S1/S2/S4, mandatory field sets, joint
  container rules, §5 removal rationale): `docs/PROVIDER_INTEGRATION_V1.0.12.md`
- Release notes: `docs/KINDORA_v1.0.12_RELEASE_NOTES.md`
- Test report (backend unit 568/568, integration 63/63 on real
  PostgreSQL 17.9 + Redis 7.2.5 with zero flakes, frontend 53/53,
  provider sandbox BLOCKED): `docs/KINDORA_v1.0.12_TEST_REPORT.md`
- Release classification: **STAGING READY** — see
  `docs/FINAL_ENGINEERING_REPORT_V1.0.12.md`.

## v1.0.11 — Flutterwave pagination integrity & transfer identity lockdown

`v1.0.11_SECURITY_COMPLETE` closes the three remaining v1.0.10 Flutterwave
lookup findings. Pagination validation is now STRICT alias-consistency across
every documented container (the official envelope-level `meta.page_info` —
which v1.0.10 never inspected — plus the content-revision containers):
conflicting aliases such as `{current_page:1, page:2}` are rejected, first-value
alias selection is gone, fractional/negative/malformed/`null` values fail the
page, and new relationship checks cover records-beyond-page-size and
zero-results-spanning-pages. A detailed transfer is adopted ONLY with the exact
requested reference AND a valid transfer id equal to the list-identified id —
a missing detail id is now AMBIGUOUS (the v1.0.10 guard let it pass). Paginated
responses require valid, complete, internally consistent metadata before ANY
classification — a matching reference inside an unverifiable page is never
adopted and an empty such page is never authoritative absence; the legacy
bare-array shape keeps its documented rules; unknown shapes are AMBIGUOUS.
The deterministic 12-step lookup sequence and the four-valued outcome contract
(FOUND/NOT_FOUND/AMBIGUOUS/ERROR) are preserved; no migration, no frontend or
architecture change.

- Provider reference (shapes S1–S4, alias groups, identity rules, contract
  verification): `docs/PROVIDER_INTEGRATION_V1.0.11.md`
- Release notes: `docs/KINDORA_v1.0.11_RELEASE_NOTES.md`
- Test report (629 executed / 628 green, provider sandbox BLOCKED):
  `docs/KINDORA_v1.0.11_TEST_REPORT.md`
- Release classification: **STAGING READY** — see
  `docs/FINAL_ENGINEERING_REPORT_V1.0.11.md` and the archive attestation
  `docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.11.md`.

## v1.0.10 — Provider reference integrity, reconciliation lockdown & payout concurrency

`v1.0.10_SECURITY_COMPLETE` closes the four v1.0.9 review findings. Provider
lookups now require EXACT requested-reference identity before a transfer can be
adopted (a transfer id or code is never a substitute for the merchant reference),
Flutterwave authoritative absence requires validated, internally consistent
pagination metadata (the contradictory `{content:[], meta:{total:1}}` class is
AMBIGUOUS — never a NOT_FOUND), the final payout reconciliation validates the
LOCKED executor identity (`initiatedById` read under the row lock — stale,
missing or colliding executors block settlement), and the payout-concurrency
guarantee is proven by SEVEN deterministic scenarios on REAL PostgreSQL 17 +
Redis 7.2.5 with a barrier-controlled mock provider: manual settlement and
automated provider submission can never both settle the same withdrawal, even
with workers crashing, provider requests in flight, leases expired, ambiguous
lookups or duplicate workers — at most one successful settlement and one ledger
posting per logical withdrawal.

- Architecture: `docs/PAYOUT_ARCHITECTURE_V1.0.10.md`
- Provider reference: `docs/PROVIDER_INTEGRATION_V1.0.10.md`
- Worker recovery: `docs/OUTBOX_RECOVERY_V1.0.10.md`
- Manual settlement: `docs/MANUAL_SETTLEMENT_PROCEDURES_V1.0.10.md`
- Release classification: **STAGING READY** — the external provider sandbox suite
  is BLOCKED (no credentials); see `docs/FINAL_ENGINEERING_REPORT_V1.0.10.md`.

## v1.0.9 — Duplicate payout prevention & final authorization lockdown

`v1.0.9_SECURITY_COMPLETE` hardens the payout path against the remaining duplicate-payment
and authorization-bypass risks found in the v1.0.8 review. Provider lookups now return an
EXPLICIT four-valued outcome (`FOUND / NOT_FOUND / AMBIGUOUS / ERROR`) — an unsuccessful
lookup can never masquerade as "transfer does not exist". Manual settlement and provider
submission are made mutually exclusive by a durable PostgreSQL coordination guard plus
in-lock rechecks (the pre-transaction check race is gone). Four-person separation is
re-proven at submission AND final reconciliation from the PERSISTED executor identity.
Manual settlement requires an immutable approval snapshot bound by a two-step
(authorize-intent → settle) protocol — legacy withdrawals are never grandfathered. A
partial UNIQUE index makes two concurrent unresolved payout attempts impossible at the
database level, expired-lease recovery reconciles the provider before it ever resubmits,
and payout-security observability counters expose the prevention controls.

- Architecture and prevention layers: `docs/PAYOUT_ARCHITECTURE_V1.0.9.md`
- Ambiguity recovery runbook: `docs/INCIDENT_RUNBOOK_AMBIGUOUS_PAYOUT.md`
- Two-step manual settlement: `docs/MANUAL_SETTLEMENT_PROCEDURES_V1.0.9.md`
- Release classification: **STAGING READY** — the external provider sandbox suite is
  BLOCKED (no credentials); see `docs/FINAL_ENGINEERING_REPORT_V1.0.9.md` §C/§F.

## v1.0.7 — Payout execution integrity

`v1.0.7_SECURITY_COMPLETE` upgrades the payout (money-leaving) path: real Paystack and
Flutterwave payout adapters behind a provider registry with explicit rejectors (Stripe
payouts are disabled; Stripe donations remain supported), a durable initiation pipeline
(attempt + outbox committed before any provider call, ambiguity resolved by provider lookup
instead of blind retry), fail-closed verification with atomic reconciliation for every
outcome, a provider-native beneficiary identity model, a controlled manual-review workflow,
and DB-level immutability triggers (migration `0004_payout_execution_integrity`). Release
classification: **STAGING READY** — not a production candidate until the real-PostgreSQL
integration run and the provider sandbox runs documented in the test report pass.

- Architecture: `docs/PAYOUT_ARCHITECTURE_V1.0.7.md`
- Provider endpoints, status semantics and error mapping: `docs/PROVIDER_INTEGRATION_V1.0.7.md`
- Operator runbook for escalated payout cases: `docs/MANUAL_REVIEW_PROCEDURES_V1.0.7.md`
- Release notes, env vars and migration notes: `docs/KINDORA_v1.0.7_RELEASE_NOTES.md`
- Executed vs NOT RUN verification: `docs/KINDORA_v1.0.7_TEST_REPORT.md`

## Repositories layout

```
kindora/
├── frontend/          # Vite React PWA (netlify.toml included)
├── backend/           # NestJS API (Prisma schema + migrations, seed)
├── workers/           # BullMQ processors + cron jobs
├── docs/              # 18 deployment & operations guides
├── .github/workflows/ # CI: builds, unit tests, integration tests on Postgres
└── render.yaml        # One-click Render Blueprint (API + DB + Redis + worker + 6 crons)
```

## Quick start (local development)

Prerequisites: Node 20+, PostgreSQL 14+ (or a hosted dev DB), optional Redis.

```bash
# 1. Backend
cd backend
cp .env.example .env                     # set DATABASE_URL
npm install
npx prisma migrate deploy                # or: npx prisma migrate dev
npm run prisma:seed                      # demo content + admin user
npm run start:dev                        # http://localhost:10000

# 2. Frontend
cd ../frontend
cp .env.example .env                     # VITE_API_URL=http://localhost:10000
npm install
npm run dev                              # http://localhost:3000

# 3. Workers (optional locally; requires REDIS_URL)
cd ../workers
cp .env.example .env 2>/dev/null || true # set REDIS_URL
npm install && npm run build && npm run start:prod
```

> Without Redis, the API still runs: queue jobs are logged and skipped, caching and locks are disabled. Notifications require SMTP + Redis in production.

**Seeded admin:** `admin@kindora.com` with the password you set in `SEED_ADMIN_PASSWORD`
(there is no default password by design; demo content requires `SEED_DEMO=1`; production
admins are created with `npm run bootstrap:admin`).

## Deployment (Netlify + Render)

1. Push this repository to GitHub.
2. **Render:** Dashboard → New → **Blueprint** → select the repo. Render provisions `kindora-api`, `kindora-db`, `kindora-redis`, `kindora-worker` and the cron jobs from `render.yaml`; you are prompted for the `sync: false` secrets. Follow `docs/RENDER_DEPLOYMENT.md`.
3. **Netlify:** Add new site → import the same repo → set **Base directory** `frontend`, build command and publish directory are read from `frontend/netlify.toml`. Set the `VITE_*` environment variables. Follow `docs/NETLIFY_DEPLOYMENT.md`.
4. Point `kindora.com` at Netlify and `api.kindora.com` at Render (`docs/DOMAIN_AND_DNS_SETUP.md`).
5. Configure payment webhooks to `https://api.kindora.com/api/v1/payments/<provider>/webhook` (`docs/PAYMENT_INTEGRATION.md`).

## Documentation index

All guides live in `docs/`: README, INSTALLATION, LOCAL_DEVELOPMENT, NETLIFY_DEPLOYMENT, RENDER_DEPLOYMENT, DATABASE_SETUP, REDIS_SETUP, DOMAIN_AND_DNS_SETUP, ENVIRONMENT_VARIABLES, PAYMENT_INTEGRATION, STORAGE_CONFIGURATION, BACKGROUND_WORKERS, CRON_JOBS, GITHUB_ACTIONS, SECURITY, BACKUP_AND_RECOVERY, PRODUCTION_CHECKLIST, TROUBLESHOOTING — plus `FINAL_REPORT.md`.

## Testing

```bash
cd backend && npm test               # unit tests (ledger, payments, auth, money)
RUN_INTEGRATION=1 npm run test:integration   # full money path on a real Postgres
cd ../frontend && npm test           # vitest unit tests
npm run e2e                          # Playwright (demo build)
```

## Money-safety design (summary)

- All amounts are **BigInt minor units** (kobo/cents); floats never touch balances.
- Every donation success, match, payout and refund posts a **balanced double-entry ledger transaction** (debits == credits per currency, enforced).
- Webhooks verify **provider signatures over the raw body**; state changes are guarded by conditional updates (exactly-once application), with idempotency keys on donation creation.
- Campaign balances are derived from the ledger; withdrawal availability subtracts in-flight payouts server-side. A client can never confirm a payment or change a balance.

License: proprietary — all rights reserved by the KINDORA project owners.

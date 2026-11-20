# ADMIN FRESH MFA POLICY — v1.0.4

**Scope:** step-up authentication for payout and financial operations.
**Source of truth:** `backend/src/mfa/` (`mfa.service.ts`, `mfa-fresh.guard.ts`, `mfa.controller.ts`), `backend/src/withdrawals/withdrawals.controller.ts`, `backend/src/admin/admin.controller.ts`.

---

## 1. What "fresh MFA" means

Every sensitive payout operation requires a verification that is:

1. **Current** — backed by a TOTP code generated within the last time step
   (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step drift tolerance).
2. **Single-use** — the issued challenge token is consumed atomically
   (Redis `GETDEL`) at the operation; a second use always fails. The TOTP code
   itself can mint only ONE challenge per time step (SET NX replay guard).
3. **Purpose-bound** — the challenge records the exact operation purpose it
   authorizes. A token issued for `PAYOUT_FIRST_APPROVAL` cannot authorize
   `PAYOUT_SETTLEMENT` (server-side check, tested).
4. **Scope-bound** — for withdrawal operations the challenge binds to the
   withdrawal id. A challenge for withdrawal A cannot approve withdrawal B
   (tested in the integration suite).
5. **Short-lived** — challenge TTL is 120 seconds (`MFA_CHALLENGE_TTL_SECONDS`).
6. **Fail-closed** — challenges live only in Redis. If Redis is unavailable,
   issuance and consumption throw `503 MFA verification backend is
   unavailable — sensitive payout operations are rejected (fail-closed)`.
   There is no per-process fallback and no bypass path.

## 2. Operations protected by fresh MFA

| Endpoint | Purpose binding |
|---|---|
| `POST /api/v1/withdrawals/:id/under-review` | `PAYOUT_STATE_CHANGE` (scope: withdrawal) |
| `POST /api/v1/withdrawals/:id/require-info` | `PAYOUT_STATE_CHANGE` |
| `POST /api/v1/withdrawals/:id/approve` (FIRST approval) | `PAYOUT_FIRST_APPROVAL` |
| `POST /api/v1/withdrawals/:id/second-approval` | `PAYOUT_SECOND_APPROVAL` |
| `POST /api/v1/withdrawals/:id/reject` | `PAYOUT_STATE_CHANGE` |
| `POST /api/v1/withdrawals/:id/settle` (manual settlement) | `PAYOUT_SETTLEMENT` |
| `POST /api/v1/withdrawals/:id/retry` | `PAYOUT_RETRY` |
| `POST /api/v1/withdrawals/attempts/:attemptId/verify` | `PAYOUT_RECONCILIATION` |
| `POST /api/v1/withdrawals/:id/reconcile` | `PAYOUT_RECONCILIATION` |
| `POST /api/v1/admin/refunds` | `REFUND_EXECUTION` (scope: donationRef) |
| `POST /api/v1/admin/reconciliation/run` | `PAYOUT_RECONCILIATION` (global scope) |

Read-only endpoints (lists, detail views, evidence metadata) remain behind
normal administrator authorization only. There is no financial configuration
endpoint in v1.0.4 (account configuration changes do not exist as an API);
if one is introduced it MUST take the `MfaFreshGuard` with a dedicated purpose.

## 3. Protocol

```
# one-time enrollment (ADMIN only)
POST /api/v1/mfa/enroll          -> { otpauthUri, secret (shown once) }
# add secret to authenticator app, then confirm with a current code
POST /api/v1/mfa/confirm { code } -> { ok: true }

# for EVERY sensitive operation:
POST /api/v1/mfa/challenge { purpose, scope, code } -> { challengeToken, expiresInSeconds: 120 }
POST /api/v1/withdrawals/:id/approve
  Header: x-mfa-challenge: <challengeToken>
```

- `GET /api/v1/mfa/status` — enrollment state for the admin UI.
- `GET /api/v1/mfa/policy` — machine-readable list of protected operations.
- The guard chain order is Throttler → JWT → Roles → **MfaFreshGuard**; the
  MFA guard consumes the challenge only after identity and role checks.

## 4. Step-up authorization requirements (§7.3) — verification matrix

| Requirement | Implementation |
|---|---|
| MFA challenge purpose | `StoredChallenge.purpose`; mismatch → 403 `purpose mismatch` |
| User identity | `StoredChallenge.userId` must equal the JWT subject |
| Expiry | Redis TTL (120 s) + token absent ⇒ `invalid or expired` |
| Single-use consumption | Atomic `GETDEL`; lost race ⇒ `MFA challenge was already used` |
| Operation scope | `StoredChallenge.scope` vs route param/body scope |
| Administrator role | `@Roles('ADMIN')` before the MFA guard |
| Account status | JWT strategy rejects suspended accounts upstream |
| Fresh verification timestamp | Challenge `issuedAt`; TTL bounds freshness |
| Unrelated token reuse | Purpose + scope + user triple must match exactly |

## 5. Secret storage

- TOTP secrets are stored AES-256-GCM encrypted (`MfaCredential.secretEnc`).
- Key material: `MFA_ENCRYPTION_KEY` when configured, otherwise a
  domain-separated scrypt derivation from `JWT_SECRET`
  (`scryptSync(secret, 'kindora-mfa-v1', 32)`).
- The enrollment secret is displayed exactly once; plaintext is never returned
  again, never logged, and never included in error messages.

## 6. Frontend integration (§7.4)

`frontend/src/components/mfa/mfa-challenge-dialog.tsx` implements the step-up
dialog used by the admin payout console:

- identifies the operation, shows the withdrawal publicRef + amount before the
  administrator authorizes;
- handles first-time enrollment (secret shown once + confirm) inside the same
  dialog;
- handles expired/rejected challenges (clear error, code reset, no double
  submission — the dialog disables the action while pending);
- displays the ACTUAL backend result (server error messages surface verbatim
  in toasts; 403 separation-of-duties and 409 duplicate-settlement messages
  are shown, not masked).

The frontend is never the enforcement layer: every rule in this document is
re-verified server-side on every request.

## 7. Redis failure posture

`/api/v1/health/redis` reports readiness. When Redis is down:

- MFA enrollment confirmation, challenge issuance and consumption → 503;
- every MFA-protected payout operation → 503 (fail-closed);
- donation and read traffic continues; only security-critical operations halt
  until Redis recovers.

This is intentional: v1.0.3's silent per-process fallbacks are removed.

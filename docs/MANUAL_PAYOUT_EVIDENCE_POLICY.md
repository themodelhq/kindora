# MANUAL PAYOUT EVIDENCE POLICY — v1.0.4

**Scope:** proof-of-transfer documents attached to manual payout settlements and reconciliations.
**Source of truth:** `backend/src/withdrawals/withdrawals.service.ts` (`validateEvidenceFile`, `bindEvidence`, `confirmSettlement`, `reconcile`, `getEvidenceUrl`), `backend/src/storage/`, `backend/prisma/schema.prisma` (`StoredFile`, `StoredFileKind.PAYOUT_EVIDENCE`).

---

## 1. What changed

v1.0.3 accepted an arbitrary `evidenceUrl` string on
`POST /withdrawals/:id/mark-paid` and `POST /withdrawals/:id/reconcile`. Any
external URL — or any string at all — could be recorded as "proof" of a
transfer. v1.0.4 replaces this with a registered-file workflow:

- `POST /withdrawals/:id/settle` requires `evidenceFileId` (a `StoredFile` id).
  The request body has **no** evidence URL field; sending the legacy
  `evidenceUrl` field fails validation (unknown property).
- `POST /withdrawals/:id/reconcile` accepts an optional `evidenceFileId`.
- Historical `evidenceUrl` values remain in the database for audit continuity
  but are no longer accepted as input anywhere.

## 2. Evidence file requirements

A `StoredFile` can serve as payout evidence only when ALL checks pass
(`WithdrawalsService.validateEvidenceFile`):

| Check | Rule | Failure |
|---|---|---|
| Exists | file row found | `Evidence file not found` |
| Ownership | `uploaderId === acting administrator` | `Evidence must be uploaded by the submitting administrator` |
| Lifecycle | not `QUARANTINED` / `REJECTED` / `FAILED` | `Evidence file is <status> and cannot be used` |
| Scan completeness | not `SCANNING`, `scanVerdict !== PENDING` | `Evidence file security scan has not completed` |
| Scan verdict | `CLEAN` only | `Evidence file did not pass the security scan` |
| Visibility | `PRIVATE` only | `Payout evidence must be stored privately` |
| Purpose | `kind === PAYOUT_EVIDENCE` | `Wrong evidence purpose (<kind>)` |
| Binding | `evidenceForWithdrawalId` null or equal to the target withdrawal | `Evidence is bound to a different withdrawal` |
| Attachment | `withdrawalId` null or equal | `Evidence is attached to a different withdrawal` |

## 3. Upload workflow (§10.2)

1. The administrator registers an upload intent:
   `POST /api/v1/storage/uploads` with `kind: 'payout-evidence'`.
2. The storage layer returns a presigned POST policy; the file uploads
   directly to private object storage (never a public URL).
3. `POST /api/v1/storage/confirm` starts the scan lifecycle (`SCANNING`).
4. The file reaches `APPROVED` + `scanVerdict: CLEAN` (malware scanning;
   without a scanner bridge sensitive files stay quarantined — fail-safe).
5. The settlement form offers the approved file; the id is submitted with
   fresh MFA.

Upload size and content type are enforced by the storage boundary
(`STORAGE_MAX_UPLOAD_MB`, allowed content types), metadata is stripped and
derivatives re-encoded per the media-security policy.

## 4. Reuse prevention

`StoredFile.evidenceForWithdrawalId` is **UNIQUE** at the database level —
a file can be bound as evidence for at most ONE withdrawal. Binding happens in
the same request as settlement/reconciliation; a second bind attempt yields
`P2002 → 409 Evidence file is already bound to a withdrawal (reuse
prevented)`. Cross-withdrawal evidence reuse without an explicit audited
correction workflow is therefore impossible.

## 5. Access control (§10.4)

- Evidence objects are stored PRIVATELY in object storage; no public URL
  exists.
- `GET /api/v1/withdrawals/:id/evidence-url` returns file metadata for
  authorized viewers only (ADMIN, requester, campaign creator, org members —
  the same entitlement matrix as destination details) and writes an audit
  entry `PRIVILEGED_DOCUMENT_ACCESS` with actor, file and context on every
  access.
- Short-lived signed read URLs are issued by the storage module after
  authorization (same mechanism as KYC document review); cross-withdrawal IDOR
  is prevented by the ownership checks.
- Evidence metadata is preserved (`StoredFile` rows are retained; financial
  record retention applies).
- Replacement after final settlement requires the reconciliation workflow with
  fresh MFA and is audited; settled records are never silently mutated.

## 6. Tests

- Unit: `withdrawals-approval.spec.ts › manual payout evidence validation (§10)`
  — valid evidence, nonexistent file, unauthorized file, wrong purpose,
  quarantined, rejected, still-scanning, infested, public visibility, wrong
  withdrawal binding, reuse prevention (P2002 → 409).
- Integration: `backend/test/storage.e2e-spec.ts` covers the upload/scan/
  access lifecycle; the withdrawal suite uses registered evidence files for
  settlement and asserts `settle` with a bare `evidenceUrl` is rejected (400).
- Real S3-compatible storage integration runs where credentials are configured
  (documented in the release test report; not executable in the offline
  release sandbox).

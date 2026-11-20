# RELEASE ARCHIVE ATTESTATION — KINDORA v1.0.11

This file exists in TWO copies by design:

1. **In-archive copy** (`docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.11.md` inside
   `KINDORA_v1.0.11_SECURITY_COMPLETE.zip`) — the section below up to the
   MARKER. It intentionally carries NO byte-size or checksum figures: the
   archive's own hash and byte totals are self-referential (the archive
   cannot contain figures that depend on the copy of this file inside it)
   and any embedded values would be stale by construction.
2. **Post-packaging record** (git-tracked version, this same path) — the
   section after the MARKER, appended immediately after the final archive
   was built and verified, with the ACTUAL measured values. That copy is
   the authoritative attestation. It lives in git history alongside the
   zip (the zip itself is force-tracked in git as the recycle-resilient
   recovery source).

## What this attestation covers

| Item | Where the actual value lives |
|---|---|
| Archive filename | `KINDORA_v1.0.11_SECURITY_COMPLETE.zip` (fixed by the packaging script) |
| Archive SHA-256 | sidecar `KINDORA_v1.0.11_zip.sha256` + the post-packaging record |
| Compressed / uncompressed size | the post-packaging record |
| ZIP entry / file counts | 521 zip entries / 424 files — verified by `scripts/verify_release_zip_v111.sh` check 9 against the final archive |
| Checksum manifest | `SHA256SUMS.txt` inside the archive — 423 entries, every entry verified by `sha256sum -c` (packaging log + verifier check 3) |
| Independent verification | `scripts/verify_release_zip_v111.sh` — 32 checks: zip integrity, per-entry manifest verification, extracted-source == release-commit-tree comparison, BOTH nested backups extracted + manifest-verified, structure completeness, migrations 0001–0006 present, secret scan clean |
| Nested original v1.0.10 backup | `backups/KINDORA_v1.0.10_PRE_V111_BACKUP.tar.gz` — SHA-256 `a7852fcf2f6aa2633159d7b18d7086dceaebc7161e7565f60e10002226ca155a`, 411-file manifest `v1.0.10_pre_v111_MANIFEST.sha256`, independently restorable (this backup predates all v1.0.11 work and its figures are stable) |
| Nested final v1.0.11 backup | `backups/KINDORA_v1.0.11_FINAL_BACKUP.tar.gz` — 417-file manifest `v1.0.11_final.sha256`, independently restorable; exact byte size + SHA-256 in the post-packaging record (the backup contains this file, so its own byte figures are self-referential too) |

## Release lineage

| Version | Release commit | Notes |
|---|---|---|
| v1.0.10 | `e17e96e` | zip SHA-256 `75a7a667722b0f4846f2e0e946be433088a60950ff8fa35bbbff7d5a04acda7a` (fixed historical value) |
| v1.0.11 | source `034fa86` + docs commits; final archive per the packaging script | SHA-256 in the sidecar + post-packaging record |

Classification: **STAGING READY** (see `FINAL_ENGINEERING_REPORT_V1.0.11.md`
§H — provider sandbox verification BLOCKED for lack of credentials; nothing
is claimed beyond executed evidence).

<!-- MARKER: the in-archive copy ends here. Everything below was appended
     AFTER the final archive was built and verified. -->

## Post-packaging measured record (authoritative figures)

_Appended after packaging; the in-archive copy above ends at the marker._
| Field | Actual measured value (final archive) |
|---|---|
| Archive filename | `KINDORA_v1.0.11_SECURITY_COMPLETE.zip` |
| Compressed size | 5,000,542 bytes (4.8 MB) |
| Uncompressed size | 7,838,984 bytes |
| ZIP entries | 521 (424 files + 97 directory entries) |
| File count | 424 (417 release-tree source files incl. docs + 7 nested backup/manifest files + SHA256SUMS.txt) |
| Archive SHA-256 | `2b605d052dc784ad7f306259e98055733c472ce6b888b0313a99dbfcf688d3d9` |
| Checksum manifest | `SHA256SUMS.txt` — 423 entries, every entry verified by `sha256sum -c` |
| Independent verification | `scripts/verify_release_zip_v111.sh` — 32/32 PASSED on this exact archive |
| Nested final v1.0.11 backup | `backups/KINDORA_v1.0.11_FINAL_BACKUP.tar.gz` — 1,570,139 bytes, SHA-256 `f4f3d50de2b320bbedf7224a9712f9d82814459282be825b95b3e7180477e6b1`, 417-file manifest verified after independent extraction |
| Nested original v1.0.10 backup | `backups/KINDORA_v1.0.10_PRE_V111_BACKUP.tar.gz` — 1,537,220 bytes, SHA-256 `a7852fcf2f6aa2633159d7b18d7086dceaebc7161e7565f60e10002226ca155a`, 411-file manifest verified after independent extraction |

Recycle-resilient recovery (git-tracked zip):
`git cat-file blob HEAD:download/KINDORA_v1.0.11_SECURITY_COMPLETE.zip > KINDORA_v1.0.11_SECURITY_COMPLETE.zip`

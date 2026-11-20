# RELEASE ARCHIVE ATTESTATION — KINDORA v1.0.12

This file exists in TWO copies by design:

1. **In-archive copy** (`docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.12.md` inside
   `KINDORA_v1.0.12_SECURITY_COMPLETE.zip`) — the section below up to the
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
| Archive filename | `KINDORA_v1.0.12_SECURITY_COMPLETE.zip` (fixed by the packaging script) |
| Archive SHA-256 | sidecar `KINDORA_v1.0.12_zip.sha256` + the post-packaging record |
| Compressed / uncompressed size | the post-packaging record |
| ZIP entry / file counts | the post-packaging record — verified by `scripts/verify_release_zip_v112.sh` check 9 against the final archive |
| Checksum manifest | `SHA256SUMS.txt` inside the archive — every entry verified by `sha256sum -c` (packaging log + verifier check 3) |
| Independent verification | `scripts/verify_release_zip_v112.sh` — zip integrity, per-entry manifest verification, extracted-source == release-commit-tree comparison, BOTH nested backups extracted + manifest-verified, structure completeness, migrations 0001–0006 present, secret scan clean |
| Nested pristine pre-v112 backup | `backups/KINDORA_v1.0.11_PRE_V112_BACKUP.tar.gz` — SHA-256 `224cbd60f35ff612f20b6904c207819702194e55c58251e7d0b46da85b407035` (stable: this backup is the pristine v1.0.11 release tree pinned to `git rev f888332`, 416-entry manifest `v1.0.11_pre_v112_MANIFEST.sha256`, source-commit pin `v1.0.11_pre_v112_source_commit.txt`, independently restorable; rebuilt verbatim from the pinned commit after sandbox recycles destroyed the working copies — see FINAL_ENGINEERING_REPORT_V1.0.12.md §G) |
| Nested final v1.0.12 backup | `backups/KINDORA_v1.0.12_FINAL_BACKUP.tar.gz` — 422-file manifest `v1.0.12_final.sha256`, independently restorable; exact byte size + SHA-256 in the post-packaging record (the backup contains this file, so its own byte figures are self-referential too) |

<!-- MARKER: everything below this line is the post-packaging measured record -->

## Post-packaging measured record (2026-11-16, appended after final archive was built and verified)

| Item | Measured value |
|---|---|
| Archive | `download/KINDORA_v1.0.12_SECURITY_COMPLETE.zip` |
| Archive SHA-256 | `0dad94de14bb776ffaa9178fbbdbeed13581d4994f417166d705fe35c4624d22` |
| Compressed size | 5,093,016 bytes |
| Uncompressed size | 7,999,342 bytes |
| ZIP entries / files | 527 entries / 430 files (423 committed source files + 7 nested backup artifacts) |
| Checksum manifest | `SHA256SUMS.txt` — 429 entries, every entry verified by `sha256sum -c` at packaging AND after independent extraction (verifier check 3) |
| Independent verification | `scripts/verify_release_zip_v112.sh` — **35/35 checks PASSED** (zip integrity, per-entry manifest verification, extracted source byte-identical to the release commit tree `547e331:kindora-v110/kindora`, both nested backups extracted + manifest-verified, pristine-adapter contamination check, structure completeness, migrations 0001–0006, secret scan clean, reported figures match the actual archive) |
| Nested pristine pre-v112 backup | `KINDORA_v1.0.11_PRE_V112_BACKUP.tar.gz` — SHA-256 `224cbd60f35ff612f20b6904c207819702194e55c58251e7d0b46da85b407035`, 417 files / 416-entry manifest, adapter blob byte-exact to the `f888332` release tree, restorable |
| Nested final v1.0.12 backup | `KINDORA_v1.0.12_FINAL_BACKUP.tar.gz` — SHA-256 `85b8d80638a3d5cfa54d210cb099c07e3588e31e69c44f9a86e375484cccf4fc`, 1,594,721 bytes, 422-file manifest verified after independent extraction, restorable |
| Secret scan | 0 non-example `.env` files, 0 key files, 0 live key-material patterns |
| Recovery source | the zip is force-tracked in git: `git cat-file blob HEAD:download/KINDORA_v1.0.12_SECURITY_COMPLETE.zip` |


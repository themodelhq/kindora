# Storage Configuration (S3-compatible)

KINDORA talks to any S3-compatible object store: Render Object Storage, Cloudflare R2,
Backblaze B2, MinIO, or AWS S3 itself. The backend never proxies file bytes - clients
upload directly with short-lived presigned URLs issued by the API.

Code references: `backend/src/storage/storage.service.ts`, `backend/src/storage/storage.controller.ts`,
`backend/src/storage/dto/storage.dto.ts`, `workers/src/processors/media.processor.ts`.

Related: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) | [SECURITY.md](SECURITY.md)

---

## 1. Choosing a provider

| Provider | Endpoint style | Notes |
| --- | --- | --- |
| Render Object Storage | Path-style | Simplest co-location with the API; create in the same region |
| Cloudflare R2 | Path-style endpoint per account | Enable a public bucket domain / CDN for `STORAGE_PUBLIC_BASE_URL`; zero egress fees |
| Backblaze B2 | Path-style (S3-compatible endpoints) | Use an application key scoped to the bucket |
| MinIO | Path-style | Self-hosted; set TLS on the endpoint |
| AWS S3 | Virtual-host or path-style | Standard IAM access keys; region required |

All providers are consumed through the same AWS SDK v3 S3Client
(`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` in `backend/package.json`), so
switching providers is an environment change, not a code change.

## 2. Environment variables

| Variable | Meaning | Unset behaviour |
| --- | --- | --- |
| `STORAGE_ENDPOINT` | S3 endpoint URL of the provider | Upload endpoints return `503 ServiceUnavailableException` ("Object storage is not configured") |
| `STORAGE_BUCKET` | Bucket name | same |
| `STORAGE_REGION` | Region string (default `us-east-1`; most S3-compatible providers accept the placeholder) | - |
| `STORAGE_ACCESS_KEY` | Access key ID | same |
| `STORAGE_SECRET_KEY` | Secret access key | same |
| `STORAGE_FORCE_PATH_STYLE` | `true` (default, set by `render.yaml`) = `endpoint/bucket/key` style URLs; required by MinIO/R2/B2/Render | - |
| `STORAGE_PUBLIC_BASE_URL` | Public base URL for serving public files (bucket CDN/public domain). When empty, URLs fall back to `<endpoint>/<bucket>/<key>` | - |
| `STORAGE_MAX_UPLOAD_MB` | Advertised max upload size (default `15`) | - |

Storage is **optional per deployment**: the API boots and serves donations without it.
`STORAGE_*` keys are secrets - store them only in service environment variables
([ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)).

## 3. Upload endpoints and key layout

All endpoints require authentication (JWT) and return `503` when storage is unconfigured.

### 3.1 `POST /api/v1/storage/uploads` (primary flow)

Request body (`UploadDto`): `{ kind, fileName, contentType }`.

| Kind | Allowed extensions | Visibility |
| --- | --- | --- |
| `campaign-image` | jpg, jpeg, png, webp | **Public** - served via `STORAGE_PUBLIC_BASE_URL` |
| `document` | jpg, jpeg, png, webp, pdf | **Private** - fetched via signed GET only |
| `avatar` | jpg, jpeg, png, webp | Public |

Allowed content types: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.

Response:

```json
{
  "uploadUrl": "<presigned PUT, 600 s>",
  "publicUrl": "<public URL of the key>",
  "key": "<kind>/<userId>/<random>-<sanitized-file-name>",
  "expiresIn": 600,
  "maxBytes": 15728640
}
```

Flow: the client PUTs the bytes **directly to the bucket** with the presigned URL; the API
never sees the file body. Keys are generated server-side (`<kind>/<userId>/<random
token>-<sanitized name>`); the 15 MB ceiling (`MAX_UPLOAD_BYTES`) is returned so clients
can enforce it before starting.

### 3.2 `GET /api/v1/storage/documents/*` (private documents)

Returns a **presigned GET valid for 300 seconds** for private `document/` objects (KYC
evidence etc.). Guards: the key must start with `document/` or `documents/`, and path
traversal (`..`) is rejected. Any authenticated caller can obtain a signed URL for a
document key in the current implementation - owner/admin checks are deliberately out of
scope here - so treat document keys as sensitive and tighten this endpoint for your
deployment if needed ([SECURITY.md](SECURITY.md)).

### 3.3 `POST /api/v1/storage/presign` (legacy)

Legacy presign flow with date-sharded keys (`<kind>/<yyyy>/<mm>/<random>-<name>`, 900 s
TTL) for kinds `campaign-media`, `avatar`, `identity`, `expense-evidence`. `identity`
objects (KYC identity documents) are private: downloads happen only via separately issued
GET presigns by staff tooling - never public URLs.

### 3.4 `POST /api/v1/storage/process`

Queues `media.process-image { key, url, kind }` onto the `media` queue for an existing
object ([BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md)).

## 4. Public vs private keys

| Key prefix | Kind | Visibility | Access pattern |
| --- | --- | --- | --- |
| `campaign-image/...` | Campaign images | **Public** | Served from `STORAGE_PUBLIC_BASE_URL` (CDN-friendly); frontend CSP `img-src ... https:` already allows any HTTPS host |
| `avatar/...`, `campaign-media/...` | Public media | Public | Same |
| `document/...` | Documents (PDFs, evidence) | **Private** | Presigned GET (300 s) via `/storage/documents/*` |
| `identity/...` | KYC identity documents | **Private** | Presigned GET by staff tooling only; never exposed as public URLs |

Do not grant bucket-wide public read on buckets holding `identity`/`document` objects.
Keep private kinds in the same bucket (path-prefixed) only if the bucket ACL honours the
presign-only pattern; otherwise use two buckets (one public, one strictly private).

## 5. Bucket CORS configuration (required for presigned PUT)

The browser performs a direct `PUT` to the presigned URL, so the bucket must allow the
frontend origin. Configure CORS on the bucket (all S3-compatible APIs accept this policy):

- **Allowed origins**: `https://kindora.com`, `https://www.kindora.com` (add preview
  origins such as `https://develop--<site>.netlify.app` if you test uploads on branch
  deploys; add `http://localhost:3000` only on a dev bucket).
- **Allowed methods**: `PUT` (and `GET` if objects are fetched client-side).
- **Allowed headers**: `Content-Type` plus the `x-amz-*` headers the SDK sends.
- **Expose headers**: `ETag`.
- **Max age**: `3600`.

Example (AWS-style XML):

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://kindora.com</AllowedOrigin>
    <AllowedOrigin>https://www.kindora.com</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedHeader>Content-Type</AllowedHeader>
    <AllowedHeader>x-amz-*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

Uploads failing with a browser CORS error but no API error almost always mean this policy
is missing or the origin string does not match exactly (scheme + host + port).

## 6. Image processing pipeline (current state)

The `media.process-image` job (`media` queue, concurrency 2) runs in the background
worker. Its current, honest state (`workers/src/processors/media.processor.ts`):

- The workers package **intentionally ships without a storage SDK** (no
  `@aws-sdk/client-s3`), so there is no authenticated way to download private objects or
  upload variants - the handler acknowledges the job and logs a structured line marking
  the object as `pending-external-processing`. It never retries forever.
- Non-image kinds are skipped (`kind != IMAGE`).
- Without `STORAGE_*` configured on the worker, the job logs a warning no-op and succeeds.
- The intended full implementation is documented in the processor: fetch object ->
  `sharp().resize({ width: 480 }).webp()` -> upload as `<dir>/thumb.webp` next to the
  source key. `sharp` is already a declared dependency, so the upgrade needs only an SDK
  and the handler body.
- Derived renditions are disposable; keeping the **originals** is what matters for
  backup ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)).

## 7. Malware scanning - documented external requirement

Uploaded media is **not** virus-scanned by this codebase. Per the worker's documented
contract, malware scanning is an **external requirement**: run ClamAV (or an equivalent)
as separate infrastructure - e.g. a container sidecar or a scheduled scanner job (a
serverless function / Lambda pointed at the bucket) - and have it:

1. scan newly uploaded objects (bucket event trigger on `PUT`);
2. quarantine flagged objects before any derived variant is generated;
3. wire its verdict into the processing pipeline before thumbnail generation ships.

Keep flagged objects out of the public base URL and surface them through the moderation
case flow (`ModerationCase` model) for review.

## 8. Verification checklist

- [ ] `STORAGE_*` env vars set on the API (and `STORAGE_*` on the worker when image
      processing is enabled)
- [ ] Bucket CORS policy allows `PUT` from the production frontend origins (section 5)
- [ ] `POST /api/v1/storage/uploads` (authenticated) returns `{uploadUrl, publicUrl, key,
      expiresIn: 600, maxBytes}`; HTTP 503 means storage env vars are unset
- [ ] Direct PUT with the presigned URL succeeds; the object lands under
      `<kind>/<userId>/...`
- [ ] Public kinds resolve via `STORAGE_PUBLIC_BASE_URL` over HTTPS and render in the
      frontend (no CSP violations)
- [ ] `GET /api/v1/storage/documents/<key>` returns a 300 s signed URL for `document/`
      keys only; `..` traversal rejected
- [ ] `identity/` objects never appear as public URLs anywhere
- [ ] `media.process-image` behaviour verified (worker logs the skip/mark line until the
      full pipeline is implemented)
- [ ] Malware-scanning plan documented and scheduled (external component; section 7)

Related: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) | [SECURITY.md](SECURITY.md) | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)

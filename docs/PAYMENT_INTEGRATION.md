# Payment Integration

How donations move through KINDORA, how to configure each payment provider (Paystack,
Flutterwave, Stripe, PayPal), how webhooks are verified, sandbox testing, reconciliation,
refunds, and the never-trust-the-redirect rule.

Code references: `backend/src/payments/payments.service.ts` (adapter resolution),
`backend/src/payments/donation-payment.service.ts` (idempotent state machine),
`backend/src/payments/webhooks.controller.ts` (webhook endpoints),
`backend/src/payments/providers/*.ts` (adapters), `backend/src/donations/donations.controller.ts`,
`backend/src/ledger/ledger.service.ts`, `backend/src/admin/admin.service.ts` (refunds).

Related: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [SECURITY.md](SECURITY.md) | [CRON_JOBS.md](CRON_JOBS.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)

---

## 1. Architecture

### 1.1 Flow

```
Browser                        Backend API                          Provider
   |  POST /api/v1/donations      |                                    |
   |----------------------------->|  create PENDING donation           |
   |                              |  provider.initialize() (server)    |
   |                              |----------------------------------->|
   |<--- redirect_url ------------|<--- authorization_url / link /     |
   |                              |     session.url / approve link     |
   |  redirect user               |                                    |
   |------------------------------------------------------------------>|
   |                          payer pays                               |
   |<--- provider redirects to callback -------------------------------|
   |  GET {FRONTEND_URL}/donate/status?ref=<publicRef>                 |
   |  (status page polls)                                              |
   |  GET /api/v1/donations/status/{provider}/{publicRef}              |
   |----------------------------->| provider.verify() server-side      |
   |                              |----------------------------------->|
   |<--- idempotent state         | applySuccess / applyFailure        |
   |     transition + ledger      |                                    |
   |                              |<==== signed webhook (async) =======|
   |                              | POST /api/v1/payments/{p}/webhook  |
```

Key endpoints (global prefix `api/v1`):

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/v1/donations` | POST | Create donation (guest or account), initialize with provider, return redirect URL. Accepts an `Idempotency-Key` header. Rate limit: 20/min |
| `/api/v1/donations/status/{provider}/{publicRef}` | GET | Server-side verification poll; provider must be `PAYSTACK`, `FLUTTERWAVE`, `STRIPE`, `PAYPAL` or `MOCK` |
| `/api/v1/payments/paystack/webhook` | POST | Signed webhook (public, signature-verified) |
| `/api/v1/payments/flutterwave/webhook` | POST | Signed webhook (public, signature-verified) |
| `/api/v1/payments/stripe/webhook` | POST | Signed webhook (public, signature-verified) |
| `/api/v1/payments/paypal/webhook` | POST | Signed webhook (public, signature-verified) |

**Exact webhook URLs to register with each provider** (assuming the API domain from
[DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md)):

| Provider | Webhook URL |
| --- | --- |
| Paystack | `https://api.kindora.com/api/v1/payments/paystack/webhook` |
| Flutterwave | `https://api.kindora.com/api/v1/payments/flutterwave/webhook` |
| Stripe | `https://api.kindora.com/api/v1/payments/stripe/webhook` |
| PayPal | `https://api.kindora.com/api/v1/payments/paypal/webhook` |

The callback URL sent to providers is built from `FRONTEND_URL`:
`${FRONTEND_URL}/donate/status?ref=${publicRef}` (e.g.
`https://kindora.com/donate/status?ref=KDO-AB12CD34`). The status page polls the status
endpoint - it does **not** decide the outcome itself.

### 1.2 Idempotent state machine

`DonationPaymentService` transitions each donation exactly once: the write path is guarded
by a conditional `updateMany` (`WHERE status = 'PENDING'`), so whichever signal arrives
first - webhook, status poll, or a retry racing the same donation - wins and later
duplicates become no-ops. Every webhook is also recorded as a `WebhookEvent` row
(provider + `eventId` unique per provider) for audit and duplicate detection; Paystack
events carry no event id, so dedupe for Paystack happens in the donation state machine.

- Success path (one transaction): donation -> `SUCCEEDED` (+ receipt number), ledger
  posting, matching-pool application, campaign counter updates (`raisedAmount`,
  `donorCount`, auto-`COMPLETED` at target). Post-commit: notifications created and
  `email.donation-receipt` / `email.donation-organizer` / `analytics.record-donation` /
  `fraud.score-donation` jobs enqueued.
- Failure events (`eventType` containing `failed`, e.g. `payment.failed`) apply `FAILED`
  with a reason via the same guarded transition.

### 1.3 Double-entry posting (account codes)

On success, `LedgerService.postDonationSuccess` posts a balanced transaction
(reference `donation:<donationId>`, unique -> exactly-once):

| Account code (`LEDGER_CODES`) | Type | Direction | Amount |
| --- | --- | --- | --- |
| `1100:CLEARING:<currency>` | ASSET | DEBIT | total charged (amount + tip) |
| `2000:CAMPAIGN:<campaignId>:<currency>` | LIABILITY | CREDIT | donation amount |
| `4000:PLATFORM_REVENUE:<currency>` | REVENUE | CREDIT | tip (only if > 0) |

Matching pools post separately: reference `match:<poolId>:<donationId>` with DEBIT
`2400:MATCH_POOL:<poolId>` and CREDIT `2000:CAMPAIGN:<campaignId>:<currency>`.
Withdrawals (`withdrawal:<withdrawalId>`, fee to `4000:PLATFORM_REVENUE:<currency>`, net
credit to clearing) and refunds (`refund:<refundId>`) post their own balanced
transactions; `5000:PROVIDER_FEES:<currency>` (EXPENSE) is reserved for provider fee
accounting. Invariants: debits == credits per currency, unique references, immutable
entries - see [SECURITY.md](SECURITY.md).

### 1.4 Reconciliation safety net

Two cooperating layers (neither calls provider APIs from the worker):

1. **Daily cron `kindora-reconciliation-digest`** (04:00 UTC,
   [CRON_JOBS.md](CRON_JOBS.md)): counts `WebhookEvent` rows with status `FAILED` in the
   last 24h and donations still `PENDING` older than 30 minutes on a live provider, then
   emails a digest to `ADMIN_EMAILS`. No state changes.
2. **Queue job `payments.reconcile`** ([BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md)):
   lists the same stale-PENDING set (batch 200) and emails the ops digest; read-only.
   Verification of live provider status is always the **backend verifyStatus flow's**
   responsibility (webhook + `GET /donations/status/...`), which applies outcomes
   idempotently.

Admin-facing view: `GET /api/v1/admin/reconciliation` returns last webhook processing
time, stale-pending count/sample and failed-webhook count (ADMIN role only).

## 2. Provider setup guides

Set the values on the Render `kindora-api` service only (never client-side). All four
providers can be enabled independently; a provider without its key reports `enabled: false`
via `availableMethods()` rather than failing unrelated donations. In mock mode all four
report enabled (mock serves everything).

### 2.1 Paystack

1. Log in at https://dashboard.paystack.com -> **Settings -> API Keys & Webhooks**. Copy
   the **secret key** (`sk_test_...` for sandbox, `sk_live_...` for production) ->
   `PAYSTACK_SECRET_KEY`. The secret key doubles as the webhook HMAC secret.
2. Webhook URL: `https://api.kindora.com/api/v1/payments/paystack/webhook`.
3. Signature verification: HMAC **SHA512 of the raw request body using your secret key**,
   delivered in the `x-paystack-signature` header; the API recomputes and compares it in
   constant time. Paystack sends no event id, so duplicate application is prevented by the
   donation state machine.
4. Callback URL (dashboard setting is a fallback - the API passes an explicit
   `callback_url` per transaction): `https://kindora.com/donate/status`.
5. Amounts: `initialize` sends **minor units** (kobo) with `reference = publicRef`;
   verification returns the provider fee (`fees` / `fee_charged`), stored on the donation.

### 2.2 Flutterwave

1. Log in at https://dashboard.flutterwave.com -> **Settings -> API**. Copy the **secret
   key** -> `FLUTTERWAVE_SECRET_KEY`.
2. Create your own **webhook secret hash**: generate a random string, set it as
   `FLUTTERWAVE_WEBHOOK_HASH` on the API **and** as the *secret hash* in Flutterwave
   -> Settings -> Webhooks. Incoming requests carry it in the `verif-hash` header; the API
   compares it in constant time.
3. Webhook URL: `https://api.kindora.com/api/v1/payments/flutterwave/webhook`.
4. Redirect/return URL is passed per transaction (`redirect_url` = the donate status page).
5. Amounts: Flutterwave expects **major units** - the adapter converts from minor units at
   initialize and converts `app_fee` back to minor for storage. Verification uses
   `/transactions/verify_by_reference?tx_ref=<publicRef>`; the Flutterwave transaction `id`
   serves as the webhook event id for dedupe.

### 2.3 Stripe

1. Log in at https://dashboard.stripe.com -> **Developers -> API keys**. Copy a **secret
   key** - a full key or a restricted key with Checkout Session create/read permissions
   (`sk_test_...` in sandbox, `sk_live_...` in production) -> `STRIPE_SECRET_KEY`.
2. Create a webhook: Developers -> Webhooks -> **Add endpoint** ->
   `https://api.kindora.com/api/v1/payments/stripe/webhook`. Subscribe to
   `checkout.session.completed` (add `checkout.session.expired` and `charge.failed` style
   events if you want explicit failures surfaced).
3. Copy the endpoint's **webhook signing secret** (`whsec_...`) -> `STRIPE_WEBHOOK_SECRET`.
4. Signature verification: the official Stripe SDK -
   `webhooks.constructEvent(rawBody, stripe-signature, secret)` over the **raw body**;
   a mismatch is rejected without processing. The Stripe event `id` provides webhook dedupe.
5. Checkout Sessions are created in `payment` mode with `client_reference_id = publicRef`
   and metadata `{donationId, publicRef}`; the webhook and the status verify read the
   reference back from either field.

### 2.4 PayPal

1. Create a REST app at https://developer.paypal.com -> **Apps & Credentials**
   (sandbox first, then a live app). Copy the Client ID -> `PAYPAL_CLIENT_ID` and Secret
   -> `PAYPAL_CLIENT_SECRET`.
2. Create a webhook (your app -> Webhooks) with URL
   `https://api.kindora.com/api/v1/payments/paypal/webhook`; copy its **Webhook ID** ->
   `PAYPAL_WEBHOOK_ID`.
3. `PAYPAL_ENV` selects the API base: `sandbox` ->
   `https://api-m.sandbox.paypal.com`, `live` -> `https://api-m.paypal.com`. The code and
   `render.yaml` default to `sandbox` - **set `PAYPAL_ENV=live` when going live**.
4. Signature verification: the API calls PayPal's **webhook signature verification API**
   (`/v1/notifications/verify-webhook-signature`) with the transmission headers
   (`paypal-transmission-id`, `-time`, `-sig`, `paypal-cert-url`, `paypal-auth-algo`) and
   your webhook ID. Requests missing any transmission header are rejected. The PayPal
   event `id` provides webhook dedupe.
5. Orders are created via `/v2/checkout/orders` with `intent: CAPTURE`,
   `reference_id = publicRef`, `custom_id = donationId`, amount in major units; verification
   reads the order status (`COMPLETED` -> succeeded, `VOIDED` -> failed, else pending).

## 3. PROVIDER_MODE: live vs mock

| Mode | Behaviour |
| --- | --- |
| `live` | Real HTTP calls to the providers; a provider without its secret key reports disabled |
| `mock` | Every adapter is swapped for the deterministic `MockProviderService`: `initialize` returns a redirect back to the callback with `mock=1&reference=<publicRef>` (no network), `verify` always reports succeeded with zero fee, webhook verification accepts any JSON body with a `reference` |

The full money path (state machine -> ledger -> counters -> notifications) runs
identically in both modes - mock exists for offline development, backend integration tests
and CI (`.github/workflows/ci.yml` sets `PROVIDER_MODE: mock`). **Never enable mock mode in
production**: it marks every donation as succeeded with zero fees. `render.yaml` pins
`PROVIDER_MODE=live`. See [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).

## 4. Sandbox testing instructions

Prerequisites: API deployed (or local) with the provider's **test** keys,
`PROVIDER_MODE=live`, webhooks registered against a publicly reachable URL (for local
testing use the tunneling tool of your choice - webhooks must reach the API's raw body
unmodified).

1. **Enable sandbox keys** (test secret keys only; `PAYPAL_ENV=sandbox`).
2. **Register the webhooks** (section 2). After each test transaction, check the provider's
   dashboard event log; the API also records every attempt in the `WebhookEvent` table,
   including rejected signatures (`status: FAILED`).
3. **Test cards / accounts** (commonly published sandbox values - always confirm against
   the provider's current test documentation):
   - **Paystack**: `4084 0840 8408 4081`, any future expiry, any CVV (standard success
     card in test mode); Paystack's docs list additional cards for declines and 3DS flows.
   - **Stripe**: `4242 4242 4242 4242` succeeds; `4000 0000 0000 0002` declines (full list
     in Stripe's testing docs).
   - **Flutterwave**: use the test cards listed in Flutterwave's documentation
     (e.g. `5531 8866 5214 2950` with any future expiry/CVV in test mode).
   - **PayPal**: use a sandbox **buyer** account created in the developer dashboard.
4. **Run a donation**: donate on a campaign, complete checkout on the provider page, land
   on `/donate/status?ref=...` and confirm the donation flips to succeeded.
5. **Verify the ledger**: admin console -> transactions: the `donation:<id>` transaction
   shows balanced DEBIT/CREDIT entries and the campaign payable increased by the amount.
6. **Verify the webhook path**: `WebhookEvent` rows show `RECEIVED`. A donation that
   succeeds only via the status poll means the webhook is not arriving (URL or signature
   issue) - fix before go-live.
7. **Test failure**: use the provider's decline card; confirm the donation goes `FAILED`
   and the user sees the failure state.
8. **Test idempotency**: re-deliver the same event from the provider dashboard (Stripe and
   PayPal allow resend); confirm only one ledger transaction exists and the event is
   recorded `DUPLICATE`.
9. **Test reconciliation**: create a pending donation, let the 04:00 UTC
   reconciliation-digest run (or trigger `payments.reconcile` manually) and confirm the
   digest email arrives listing it to `ADMIN_EMAILS`.

## 5. Never trust the success redirect

The redirect back to `/donate/status?ref=...` is **user-controllable** - anyone can browse
to that URL with any reference. Therefore:

- The status page only **displays** state; it polls the API, which re-verifies with the
  provider server-side on every poll (`provider.verify()`).
- Only two things can finalize a donation: a signature-verified webhook, or a server-side
  provider verification (status poll). Both run through the same guarded, exactly-once
  state machine.
- The backend never reads amount or status from the return URL - only the reference.
- Callback URLs (`callback_url`, `success_url`, `return_url`) are informational landing
  points, never authorization.

This is why a missing webhook configuration does not usually lose money (the status poll
recovers it) - and why signature secrets are mandatory: they are the only thing preventing
forged "success" events.

## 6. Reconciliation and refunds (admin)

### 6.1 Reconciliation

- `GET /api/v1/admin/reconciliation` (ADMIN): last webhook processed time, stale-pending
  donations (PENDING older than 30 minutes) count + sample, failed webhooks in the last
  24h.
- Daily digest email (04:00 UTC) and the `payments.reconcile` queue job surface the same
  signal to `ADMIN_EMAILS`. When the digest lists references, resolve them with the
  backend verifyStatus flow (open the donation's status endpoint) or refund/assist the
  donor - the state machine keeps every application exactly-once.

### 6.2 Refunds (admin, manual)

Refunds are executed by an administrator from the admin API
(`POST /api/v1/admin/refunds` with `{donationRef, reason}`):

- Only `SUCCEEDED` donations can be refunded; a `REFUNDED` donation is rejected.
- In **one transaction**: a `Refund` row is created (`providerRef` set to
  `manual:<refundId>` - refunds are settled off-platform in the provider dashboard),
  the donation transitions `SUCCEEDED -> REFUNDED` under a guarded update,
  `LedgerService.postRefund` posts the balanced reversal (DEBIT campaign payable, CREDIT
  provider clearing for `amount + tip`, DEBIT `4000:PLATFORM_REVENUE` for the tip), and
  campaign counters are decremented under guard.
- The unique ledger reference `refund:<refundId>` makes postings exactly-once; a duplicate
  attempt surfaces as a conflict, not a double posting.
- Post-commit: the donor receives an in-app notification and the `email.refund-processed`
  job is queued; an `AuditLog` row records the admin action with amount and reason.

## 7. E2E sandbox test checklist

- [ ] Test keys set; `PROVIDER_MODE=live`; `PAYPAL_ENV=sandbox`
- [ ] All four webhook URLs registered (section 2) and reachable (provider dashboard test
      event -> `WebhookEvent` row appears with `signatureValid=true`)
- [ ] Paystack success card completes; donation `SUCCEEDED`; `WebhookEvent` `RECEIVED`
- [ ] Stripe `4242...` completes; decline card yields `FAILED`
- [ ] Flutterwave test card completes; `tx_ref` matches the donation `publicRef`
- [ ] PayPal sandbox buyer completes; order status verified server-side
- [ ] Ledger: balanced `donation:<id>` transaction per success (debits == credits)
- [ ] Duplicate webhook delivery recorded `DUPLICATE`; no double ledger posting
- [ ] Status-page-only donation (webhook blocked deliberately) recovers via poll
- [ ] Refund executed from the admin console; ledger reversal balanced; donor email queued
- [ ] Reconciliation digest email arrives at `ADMIN_EMAILS` listing a stale test donation

## 8. Go-live (sandbox -> live keys)

- [ ] Live secret keys set on the API for every enabled provider
- [ ] `PAYPAL_ENV=live` added (default is sandbox)
- [ ] Webhook URLs confirmed on each provider's **live** settings
- [ ] Signature secrets match the live dashboards: Paystack secret key (HMAC),
      `FLUTTERWAVE_WEBHOOK_HASH` (matches dashboard secret hash), `STRIPE_WEBHOOK_SECRET`
      (`whsec_...` from the live endpoint), `PAYPAL_WEBHOOK_ID` (live webhook)
- [ ] Callback/return domain correct at each provider: `https://kindora.com/donate/status`
- [ ] Sandbox E2E checklist (section 7) fully passed before switching keys
- [ ] One small **real** transaction tested end-to-end and confirmed/refunded on the
      provider dashboard
- [ ] `WebhookEvent` rows show `RECEIVED` for live events; reconciliation digest enabled

Related: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [SECURITY.md](SECURITY.md) | [CRON_JOBS.md](CRON_JOBS.md) | [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)

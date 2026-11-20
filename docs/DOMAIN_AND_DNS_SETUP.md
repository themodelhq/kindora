# Domain and DNS Setup

Pointing `kindora.com` and `www.kindora.com` at Netlify, `api.kindora.com` at Render,
TLS, canonical redirects, and every configuration location where the domain appears.

Throughout this document replace `kindora.com` with **your registered domain** - the same
substitution applies to every config item in section 6.

Related: [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) | [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)

---

## 1. Proposed domain map

| Domain | Platform | Service |
| --- | --- | --- |
| `kindora.com` | Netlify | KINDORA PWA (production deploy of `frontend/dist`) |
| `www.kindora.com` | Netlify | Alias that 301-redirects to the canonical host |
| `api.kindora.com` | Render | `kindora-api` web service (NestJS, `/api/v1/*`) |

## 2. DNS records

Add these at your registrar (or delegate the zone entirely to Netlify DNS - see 2.3).

### 2.1 Records table

| Record | Name | Value | Purpose |
| --- | --- | --- | --- |
| `CNAME` | `www` | `your-site.netlify.app` (your site's Netlify subdomain) | www host on Netlify |
| `A` | `@` (apex) | `75.2.60.5` | Apex -> Netlify load balancer |
| `A` | `@` (apex) | `99.83.190.103` | Apex -> Netlify load balancer (second address) |
| `CNAME` | `api` | `your-render-service.onrender.com` (Render shows the exact target) | API subdomain -> Render |

Notes:

- Both apex `A` values (`75.2.60.5` and `99.83.190.103`) are Netlify's general load
  balancer addresses; adding both gives redundancy. Where your registrar supports ALIAS/
  ANAME flattening you may instead point the apex at
  `apex.loadbalancer.netlify.com` - either approach is fine; trust the values Netlify
  displays on the domain detail page if they differ.
- The `CNAME www` target is your own site's `*.netlify.app` name (shown by Netlify after
  the first deploy), not a generic name.
- The `CNAME api` target is the Render service hostname shown on the custom domain page
  of `kindora-api` (e.g. `kindora-api.onrender.com` / `kindora-api-xxxx.onrender.com`).

### 2.2 Adding the domains in Netlify

1. Netlify -> your site -> **Site configuration -> Domain management -> Add a domain**:
   add `kindora.com` and `www.kindora.com`.
2. Set the **primary domain** to `kindora.com` (recommended) so `www.kindora.com`
   301-redirects to it (or the reverse - pick ONE canonical host and keep `VITE_APP_URL`
   equal to it).
3. Netlify verifies the DNS records and marks both hosts "Netlify DNS verified".

### 2.3 Netlify DNS (alternative)

Instead of manual records at a registrar, you can delegate the zone: Domain management ->
Add a domain -> use Netlify DNS, then set the name servers at your registrar to the four
`ns*.netlify.com` values Netlify displays. Manage all records (apex, www, and the `api`
CNAME) from Netlify's DNS panel.

### 2.4 Adding the domain in Render

1. Render -> `kindora-api` -> **Settings -> Custom Domains -> Add Custom Domain**:
   `api.kindora.com`.
2. Render shows the DNS target; add the `CNAME api` record above.
3. Render verifies DNS and issues the TLS certificate automatically.
4. Keep the `onrender.com` hostname as a fallback for smoke tests; all production
   configuration should use `api.kindora.com`.

## 3. SSL/TLS notes

- **Netlify**: Domain management -> HTTPS -> provision the certificate (Let's Encrypt,
  auto-renewed) for both `kindora.com` and `www.kindora.com`; enable **Force HTTPS** so
  HTTP requests 301 to HTTPS. The shipped CSP includes `upgrade-insecure-requests`, which
  additionally upgrades in-page http:// subresource requests in modern browsers.
- **Render**: TLS is automatic once the custom domain verifies; no configuration needed.
- TLS terminates at the edges (Netlify CDN / Render load balancer); the Node services
  behind them receive proxied HTTPS traffic. `SameSite=None; Secure` refresh cookies
  (see [SECURITY.md](SECURITY.md)) require valid HTTPS on the API domain - one more
  reason the certificate must be active before go-live.
- After certificates are active, verify:

  ```bash
  curl -sI https://kindora.com | head -n 1                 # HTTP/2 200
  curl -sI https://www.kindora.com | head -n 1             # 301 to https://kindora.com
  curl -sI https://api.kindora.com/api/v1/health | head -n 1   # HTTP/2 200
  ```

## 4. Canonical redirects

- Choose one canonical frontend host (these docs assume the apex `kindora.com`).
- In Netlify, set the primary domain to `kindora.com`; `www.kindora.com` 301-redirects to
  it automatically.
- `CORS_ORIGINS` on `kindora-api` must include **both** hosts exactly
  (`https://kindora.com,https://www.kindora.com`): during navigation edge cases (e.g. a
  visitor landing on www before the redirect completes) the API can still receive requests
  from either origin, and the auth refresh/logout `Origin` check compares against this
  list ([SECURITY.md](SECURITY.md)).
- Keep `VITE_APP_URL` identical to the canonical host - the frontend uses it to build the
  share links campaigns rely on.

## 5. Propagation and verification

DNS changes typically take minutes to a few hours (TTL-dependent).

```bash
# DNS sanity
dig +short kindora.com A             # 75.2.60.5 and 99.83.190.103
dig +short www.kindora.com CNAME     # your-site.netlify.app
dig +short api.kindora.com CNAME     # your-render-service.onrender.com

# Frontend
curl -I https://kindora.com                # 200, valid certificate
curl -I https://www.kindora.com            # 301 -> https://kindora.com

# API
curl -i https://api.kindora.com/api/v1/health        # 200 {"status":"ok",...}

# Security headers on the frontend (from netlify.toml)
curl -sI https://kindora.com | grep -i -E 'content-security|x-frame|x-content-type'
```

Full acceptance checks: [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) section 9-10.

## 6. Everywhere the domain appears (update checklist)

Replace `kindora.com` with your domain in **all** of the following:

| Location | Variables / values | Doc |
| --- | --- | --- |
| Netlify env vars | `VITE_APP_URL=https://kindora.com`, `VITE_API_URL=https://api.kindora.com` | [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) |
| Render API env vars | `FRONTEND_URL=https://kindora.com`, `BACKEND_URL=https://api.kindora.com`, `CORS_ORIGINS=https://kindora.com,https://www.kindora.com` | [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) |
| Render worker env vars | `FRONTEND_URL` (links inside emails/push) | [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) |
| `frontend/netlify.toml` | CSP `connect-src https://api.kindora.com` (and provider hosts as needed) | [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) |
| Payment provider dashboards | Webhook URLs `https://api.kindora.com/api/v1/payments/<provider>/webhook` (paystack, flutterwave, stripe, paypal) and callback/return URL `https://kindora.com/donate/status` | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) |
| Push notifications | `VAPID_SUBJECT=mailto:<contact@your-domain>` | [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) |
| Email sending domain | SPF/DKIM verification at your SMTP provider for `EMAIL_FROM_ADDRESS` (e.g. `no-reply@kindora.com`) | Section 7 below |

## 7. Email sending domain (SPF/DKIM)

Transactional email (`EMAIL_FROM_ADDRESS`, e.g. `no-reply@kindora.com`) must be authorized
to send from your domain or receipts land in spam:

1. At your SMTP provider (Resend, Postmark, Mailgun, SES SMTP - any provider works; the
   backend uses plain SMTP), add the sending domain and follow its DNS verification steps.
2. Publish the DNS records it gives you at your registrar:
   - **SPF**: a `TXT` record on the apex, e.g.
     `v=spf1 include:<provider-domain> ~all` (merge with existing includes if present).
   - **DKIM**: the provider's `TXT`/CNAME record(s) under the selector hostname.
   - **DMARC** (recommended): `TXT _dmarc`, e.g.
     `v=DMARC1; p=none; rua=mailto:dmarc@kindora.com` to start monitoring, tightening
     later to `quarantine`/`reject`.
3. Verify with:

   ```bash
   dig TXT kindora.com +short            # SPF
   dig TXT _dmarc.kindora.com +short     # DMARC
   # DKIM: query the selector hostname the provider specifies
   ```

4. Send a test receipt (a sandbox donation) and confirm delivery + `EmailLog` rows show
   `SENT` ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)).

## 8. Verification checklist

- [ ] `dig +short kindora.com A` returns Netlify load-balancer addresses (`75.2.60.5`,
      `99.83.190.103`) or the zone is delegated to Netlify DNS
- [ ] `CNAME www -> your-site.netlify.app` in place; Netlify marks it verified
- [ ] `CNAME api -> your-render-service.onrender.com` in place; Render marks the custom
      domain verified with a TLS certificate
- [ ] HTTPS active and Force HTTPS enabled on Netlify; valid certificate on all three hosts
- [ ] Canonical redirect decided: one primary host, the other 301s to it
- [ ] `VITE_APP_URL` (Netlify) equals the canonical host; `VITE_API_URL` equals the API domain
- [ ] `FRONTEND_URL`, `BACKEND_URL`, `CORS_ORIGINS` (Render) updated to the real domains;
      no localhost values remain
- [ ] CSP `connect-src` in `frontend/netlify.toml` references the real API domain
- [ ] All four payment webhook URLs updated to
      `https://api.kindora.com/api/v1/payments/<provider>/webhook` and callback/return URL
      `https://kindora.com/donate/status`
- [ ] SPF/DKIM (and DMARC) published for the sending domain; test email delivered
- [ ] `VAPID_SUBJECT` updated to your contact address
- [ ] Deep-link test passed (`https://kindora.com/campaigns/<slug>` opens and refreshes)

Related: [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) | [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)

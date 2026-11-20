# Netlify Deployment (Frontend PWA)

Host the KINDORA React PWA on Netlify: connecting the repository, build settings, the
required `VITE_*` environment variables, SPA redirects, security headers and CSP, custom
domain, PWA verification, preview deployments and the acceptance checklist.

The frontend is built from `frontend/` (React 18, TypeScript, Vite 6, Tailwind CSS,
TanStack Query, Zustand) with `vite-plugin-pwa`. All build settings live in
`frontend/netlify.toml`.

Related: [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md) | [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## 1. Connect the repository

1. Log in at Netlify and choose **Add new site -> Import an existing project**.
2. Authorize GitHub and select the KINDORA repository.
3. Under **Build settings**, set the **Base (root) directory** to `frontend`. The build
   command and publish directory are then read from `frontend/netlify.toml`:

   ```toml
   [build]
     command = "npm ci && npm run build"
     publish = "dist"

   [build.environment]
     NODE_VERSION = "22"
   ```

   Equivalent UI values (only needed if the file were missing): build command
   `npm ci && npm run build`, publish directory `dist`.
4. Deploy. The build runs `npm ci` (respects `frontend/package-lock.json`) and
   `npm run build`, which is `tsc --noEmit && vite build` - typecheck failures block the
   deploy. Output is published from `frontend/dist`.
5. Set the required environment variables (section 2) and redeploy: `VITE_` variables are
   compile-time constants, so they must exist at build time.

`NODE_VERSION = "22"` pins the Node runtime for the build. Mirror Node 22 in the Netlify UI
(Site configuration -> Build & deploy -> environment) so dashboard-triggered builds match.

## 2. Required environment variables

Add these in **Site configuration -> Environment variables**. Every one is a public,
build-time `VITE_` variable baked into the browser bundle (values below are from
`frontend/.env.example`; substitute your production domain):

| Variable | Production value | Required | Notes |
| --- | --- | --- | --- |
| `VITE_APP_NAME` | `KINDORA` | yes | Display name |
| `VITE_APP_URL` | `https://kindora.com` | yes | Canonical public URL; used to build share links |
| `VITE_API_URL` | `https://api.kindora.com` | yes | Render API base; the browser calls it directly |
| `VITE_ENVIRONMENT` | `production` | no | Labels the build; example default is `development` |
| `VITE_DEFAULT_CURRENCY` | `NGN` | yes | Must match backend `DEFAULT_CURRENCY` |
| `VITE_DEFAULT_LANGUAGE` | `en` | yes | Default UI language |
| `VITE_DEMO_MODE` | *(unset / empty)* | - | **Must be empty in production.** See section 3 |

Rules:

- **Never put secrets in `VITE_` variables.** Everything prefixed `VITE_` is embedded in
  the public JavaScript bundle and readable by every visitor. Provider secret keys,
  database URLs, SMTP passwords, JWT secrets and storage keys must never appear here.
  All provider calls are made server-side by the API; the frontend only holds the API URL.
- Changing any `VITE_` variable requires a **new build and deploy**.
- Full reference including workers variables: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md).

## 3. Demo mode warning

`VITE_DEMO_MODE=1` makes `frontend/src/lib/demo/adapter.ts` intercept the API layer and
serve simulated data from an in-browser adapter (`frontend/src/lib/demo/data.ts`) instead
of calling the backend. It exists for offline UI previews and for the CI Playwright e2e
build (`ci.yml` sets `VITE_DEMO_MODE: "1"` for the `e2e` job on pull requests). A demo
build stores nothing and never touches real money.

**Never set `VITE_DEMO_MODE` in production.** A demo deployment looks fully functional
while persisting nothing - a visitor "donating" would see success screens backed by no
data. Keep the variable unset/empty in the production and `develop` deploy contexts on
Netlify; verify with the live-bundle check in [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md).

## 4. SPA redirects explained

`frontend/netlify.toml` contains:

```toml
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

KINDORA is a single-page app with client-side routing (React Router). This rewrite serves
the app shell for every path so deep links shared on WhatsApp, Facebook or Google - and
browser refreshes on nested routes such as `/campaigns/<slug>` or `/donate` - resolve to
the app instead of Netlify's 404 page. Without it, any refresh on a nested route breaks.

Note the PWA service worker adds its own app-shell fallback (`navigateFallback: /index.html`
in `vite.config.ts`) with a denylist for `/api/`, so API paths are never intercepted.

## 5. Security headers and CSP

`frontend/netlify.toml` sets these headers on every route (`for = "/*"`):

| Header | Value | Purpose |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | Blocks MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `X-Frame-Options` | `DENY` | Prevents clickjacking via iframing |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Denies sensitive browser features |
| `Content-Security-Policy` | see below | Restricts what the app may load and connect to |

The CSP as shipped (formatted for readability):

```text
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self' data:;
connect-src 'self' https://api.kindora.com https://*.paystack.co https://api.flutterwave.com
            https://api.stripe.com https://api-m.paypal.com https://api-m.sandbox.paypal.com
            https://*.sentry.io;
frame-src https://*.paystack.co https://api.flutterwave.com https://js.stripe.com
          https://www.paypal.com https://api-m.sandbox.paypal.com;
worker-src 'self' blob:;
manifest-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests;
```

### 5.1 Which hosts are allowed and why

| Directive | Allowed hosts | Reason |
| --- | --- | --- |
| `connect-src` | `'self'`, `https://api.kindora.com`, `https://*.paystack.co`, `https://api.flutterwave.com`, `https://api.stripe.com`, `https://api-m.paypal.com`, `https://api-m.sandbox.paypal.com`, `https://*.sentry.io` | XHR/fetch to the API, provider SDK endpoints, Sentry |
| `frame-src` | `https://*.paystack.co`, `https://api.flutterwave.com`, `https://js.stripe.com`, `https://www.paypal.com`, `https://api-m.sandbox.paypal.com` | Provider checkout iframes/redirect targets |
| `img-src` | `'self' data: blob: https:` | Campaign images from any HTTPS object-storage/CDN host |
| `script-src` | `'self' 'wasm-unsafe-eval'` | No third-party scripts; wasm allowance for build tooling |
| `worker-src` | `'self' blob:` | PWA service worker |
| `object-src`, `frame-ancestors` | `'none'` | No plugins; no embedding of the site |

### 5.2 How to extend the CSP

1. **Different API domain:** replace `https://api.kindora.com` in `connect-src` with your
   domain, commit, and redeploy. A mismatch means the browser blocks API calls with console
   CSP violations.
2. **New image/CDN host:** `img-src` already allows any HTTPS host; no change needed.
3. **New provider or SDK host:** add it to both `connect-src` (XHR) and `frame-src`
   (embedded checkout) as appropriate.
4. **New Sentry-like monitoring host:** add to `connect-src` (e.g. `https://*.sentry.io`
   is already included).

If you replace `kindora.com` with your own domain, edit every `api.kindora.com` occurrence
accordingly - otherwise API calls or provider frames are silently blocked by the browser.
See [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md).

## 6. Caching rules

| Path | Cache-Control | Reason |
| --- | --- | --- |
| `/index.html` | `public, max-age=0, must-revalidate` | HTML must revalidate on every deploy |
| `/sw.js` | `public, max-age=0, must-revalidate` | Service worker updates must be picked up immediately |
| `/manifest.webmanifest` | `public, max-age=0, must-revalidate` | PWA manifest stays fresh |
| `/assets/*` | `public, max-age=31536000, immutable` | Hashed Vite filenames are safe to cache forever |
| `/icons/*` | `public, max-age=604800` | 7 days |

## 7. Custom domain

Full DNS walkthrough: [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md). Summary:

1. Site configuration -> Domain management -> **Add a domain**: `kindora.com` and
   `www.kindora.com`.
2. At your registrar add the records from the DNS table in
   [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md) (apex `A` records to Netlify's load
   balancer, `CNAME www` to your `*.netlify.app` site).
3. Enable HTTPS in Netlify (Let's Encrypt, auto-renewed) and force HTTPS.
4. Pick one canonical host (recommended: `kindora.com`) and set it as the primary domain so
   the other host 301-redirects to it. Keep `VITE_APP_URL` identical to the canonical host.

## 8. Preview deployments and branch strategy

| Branch | Netlify context | Purpose |
| --- | --- | --- |
| `main` | Production | Deploys to `kindora.com` |
| `develop` | Branch deploy | Staging preview at `<branch>--<site>.netlify.app` |
| Pull requests | Deploy preview | Per-PR preview URL, posted on the PR |

Configure under Site configuration -> Build & deploy -> Continuous deployment. CI must
pass before merge ([GITHUB_ACTIONS.md](GITHUB_ACTIONS.md)); a failed `npm run build`
(type errors) blocks a broken bundle from being published. Keep `VITE_DEMO_MODE` unset in
all Netlify deploy contexts - demo data must never appear on previews that stakeholders
review as if real.

## 9. Verify the PWA after deploy

The PWA is produced by `vite-plugin-pwa` (`frontend/vite.config.ts`): manifest
`KINDORA - Goodness, in motion` (short name `KINDORA`, theme colour `#059669`,
display `standalone`, icons 192/512 + maskable 512), service worker `sw.js` with
`registerType: 'autoUpdate'`, and a Workbox rule that **never caches `/api/` responses**
(`NetworkOnly` - financial data must always be fresh).

1. Open the deployed site over **HTTPS** (installation requires a secure context).
2. Confirm `GET /manifest.webmanifest` returns 200 with
   `Cache-Control: public, max-age=0, must-revalidate`.
3. Confirm `GET /sw.js` returns 200 (same header) and registers: DevTools -> Application ->
   Service workers shows "activated and running".
4. Install: Chrome/Edge show the address-bar install icon or menu item "Install KINDORA";
   Android Chrome offers "Add to Home screen". Launch it and confirm standalone display
   with the emerald theme colour.
5. Deep-link test: paste `https://kindora.com/campaigns/<slug>` into a new tab and refresh -
   the SPA must render (redirect rule working), not 404.
6. Offline test: load the home page, go offline (DevTools -> Network), reload - the cached
   shell renders; an API-backed view shows its error state (API responses are NetworkOnly).
7. Update test: after the next deploy, the `autoUpdate` service worker picks up the new
   build on the next navigation - confirm the fresh bundle loads without a manual cache
   clear.

## 10. Netlify acceptance checklist

- [ ] Build uses `npm ci && npm run build` from `netlify.toml`; publish directory `dist`
- [ ] `NODE_VERSION = "22"`; build log shows no lockfile drift warnings
- [ ] `npm run build` succeeded (includes the `tsc --noEmit` typecheck)
- [ ] Homepage loads at the production domain with no blank screen or console errors
- [ ] Nested routes (`/campaigns/<slug>`, `/donate`) work on **refresh** and as shared
      deep links (WhatsApp/Facebook link test)
- [ ] All `VITE_*` variables set per section 2; `VITE_ENVIRONMENT=production`
- [ ] `VITE_DEMO_MODE` unset/empty; live bundle serves API data, not demo data
- [ ] No secrets in any `VITE_` variable
- [ ] Browser reaches the API: requests visible in Render logs, no CORS or CSP errors
- [ ] Security headers present on every route (check `curl -I https://kindora.com`)
- [ ] PWA installs and launches standalone; `sw.js` and `manifest.webmanifest` served
      with must-revalidate caching
- [ ] Offline shell test and deep-link test both pass

## 11. Rollback

Netlify keeps every deploy: **Deploys** -> pick the last known-good production deploy ->
**Rollback to this deploy**. Instant, no rebuild. After rolling back, check whether the bad
release also changed the API ([RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) rollback
section) so frontend and backend stay compatible.

Related: [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md) | [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

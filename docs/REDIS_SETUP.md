# Redis Setup

Why KINDORA needs Redis, where it comes from in the Blueprint, how `REDIS_URL` is wired,
exactly what Redis does, what degrades without it, and the `noeviction` requirement.

Related: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) | [CRON_JOBS.md](CRON_JOBS.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## 1. What Redis does in KINDORA

| Use | Where in the code |
| --- | --- |
| **BullMQ job queues** - 8 queues: `email`, `push`, `notifications`, `analytics`, `media`, `fraud`, `payments`, `reports` | Producer: `backend/src/common/queue.service.ts`; consumer: `workers/src/index.ts` + `workers/src/lib/queues.ts` |
| **Distributed locks** - `SET key value NX PX <ttl>` with compare-and-delete Lua release; lock keys look like `kindora:lock:cron:<name>` | API: `backend/src/common/redis.service.ts` (`acquireLock`/`releaseLock`); workers/crons: `workers/src/lib/redis.ts` |
| **Caching / Redis client on the API** | `backend/src/common/redis.service.ts` (`get`/`set`/`del`, `ping`) |
| **Retry bookkeeping** - BullMQ keeps completed/failed jobs for inspection (`removeOnComplete: {count: 1000}`, `removeOnFail: {count: 5000}`) | Queue defaults in both producer and consumer |

Money-movement features depend on it: recurring donation cycles, reconciliation digests,
email receipts and notifications are all queue/lock driven. **Production deployments must
configure Redis.**

## 2. The Blueprint Key Value service

`render.yaml` defines:

```yaml
  - type: keyvalue
    name: kindora-redis
    plan: starter
    maxmemoryPolicy: noeviction
```

- Created automatically by the Blueprint deploy
  ([RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md)); created manually if you follow the
  no-Blueprint path (Render Dashboard -> New -> Key Value, same region as the API).
- **`maxmemoryPolicy: noeviction` is deliberate.** Under memory pressure an evicting Redis
  would silently delete queued jobs, delayed job metadata, or lock keys - the exact data
  BullMQ and the cron locks must never lose. With `noeviction` Redis refuses writes when
  full instead of dropping data, which surfaces as a loud error you can act on (raise the
  plan) rather than silent corruption. Keep this setting.

## 3. REDIS_URL wiring

The Blueprint injects `REDIS_URL` automatically on every service that needs it:

```yaml
- key: REDIS_URL
  fromService:
    type: keyvalue
    name: kindora-redis
    property: connectionString
```

Set the same variable on **all** of: `kindora-api` (queue producer + cache + locks),
`kindora-worker` (queue consumer - **mandatory**), and each of the six cron jobs
(distributed locks; `kindora-weekly-reports` and `kindora-reconciliation-digest` also send
email via workers' mailer, which is SMTP-based, not Redis).

URL forms:

```env
REDIS_URL=redis://default:<password>@<host>:<port>     # Render Key Value / internal
REDIS_URL=rediss://default:<password>@<host>:<port>    # TLS endpoints (external providers)
```

Local development: `REDIS_URL=redis://localhost:6379`. The backend producer creates its
connection with `maxRetriesPerRequest: null` (a BullMQ requirement); the worker uses the
same setting with `enableReadyCheck: true` and pings Redis on boot.

External providers (e.g. Upstash) work: use their TLS URL (`rediss://`) and keep the
provider region close to the Render region - workers poll Redis continuously and latency
shows up as job throughput.

## 4. Behaviour without Redis (graceful degradation)

### 4.1 API (`kindora-api`) - degrades, never crashes

When `REDIS_URL` is empty or unreachable:

- `QueueService.enqueue` logs a warning and returns without queuing:

  ```text
  [inline-drop] email.email.donation-receipt (REDIS_URL not configured) data=...
  ```

  Consequences: emails are never sent, web push is never delivered, analytics are not
  recorded, media is not processed, fraud scoring does not run, reconciliation digests and
  recurring cycles never execute. Donation creation, checkout redirects and the status
  poll still work (they are synchronous, database-only).
- The `RedisService` reports `availability=false`; cache get/set and lock calls become
  no-ops.
- `GET /api/v1/health/redis` returns
  `503 {"status":"degraded","component":"redis","configured":false}` when unset, or 503
  with `"configured":true` when set but unreachable (`backend/src/health/health.controller.ts`).

The `[inline-drop]` warning lines are a **red flag in production logs**, not a benign
message. Alerts should fire on them.

### 4.2 Worker and crons - Redis is mandatory

`workers/src/lib/redis.ts` checks on boot:

```text
FATAL: REDIS_URL is not set. KINDORA workers consume BullMQ queues and take Redis locks;
the process cannot start without Redis. Set REDIS_URL (e.g. redis://default:password@host:6379) and restart.
```

The worker pings Redis after connecting and exits 1 if unreachable. On Render this surfaces
as `kindora-worker` failing to start - fix the environment variable and redeploy. Cron
scripts also require Redis for their `SET NX PX` locks; without it a script may run
concurrently with itself (acceptable only on a laptop).

## 5. Verification

```bash
curl -i https://api.kindora.com/api/v1/health/redis
# 200 {"status":"ok","component":"redis","configured":true}
# 503 {"status":"degraded","component":"redis","configured":true}   <- set but unreachable
# 503 {"status":"degraded","component":"redis","configured":false}  <- not set
```

Additional checks from a machine with `redis-cli` and network access:

```bash
redis-cli -u "$REDIS_URL" ping                                   # PONG
redis-cli -u "$REDIS_URL" --scan --pattern 'bull:*' | head       # BullMQ keys present
redis-cli -u "$REDIS_URL" --scan --pattern 'kindora:lock:*'      # cron locks present
redis-cli -u "$REDIS_URL" CONFIG GET maxmemory-policy            # must be noeviction
```

Worker boot log should show:

```text
[worker] booting KINDORA background worker...
[worker] redis connection verified
[worker] online — queues: email, push, notifications, analytics, media, fraud, payments, reports
```

## 6. Operational notes for production

- **Sizing**: BullMQ keeps job payloads in Redis (emails, push payloads, analytics data)
  plus retry bookkeeping (last 1000 completed / 5000 failed per queue). The `starter`
  Key Value plan is sufficient at launch; if `used_memory` approaches the plan cap and
  write errors appear (the `noeviction` policy refusing writes), upgrade the plan rather
  than raising limits - never switch to an evicting policy.
- **Persistence**: BullMQ queues survive a Redis restart only if the provider's data
  persists. Enable whatever persistence the provider offers; without it, in-flight jobs
  are lost on restart (money state stays correct: the ledger lives in PostgreSQL and the
  reconciliation digest re-surfaces anything unresolved).
- **Restart order**: Redis first (or simultaneously) - the API re-connects on demand, the
  worker retries with backoff, and cron locks simply expire by TTL. No special drain.
- **Monitoring checklist**:

  | Signal | Where | Meaning |
  | --- | --- | --- |
  | `/api/v1/health/redis` | Uptime monitor | 503 = misconfigured or unreachable |
  | `[inline-drop]` log lines | API logs | Jobs being dropped - misconfiguration, page the on-call |
  | `used_memory` | Provider metrics | Approaching cap -> upgrade plan |
  | `bull:<queue>:failed` length | `redis-cli` | Dead letters accumulating -> worker runbook |
  | `kindora:lock:cron:*` keys | `redis-cli --scan` | Locks held; stale locks expire by TTL |

## 7. Security

- **TLS**: any Redis reachable over the public internet must use `rediss://`. Render Key
  Value on the private network uses the injected `redis://` connection string.
- **Password**: always set; never expose Redis unauthenticated.
- **Least exposure**: only the API, worker and cron services need network access to Redis.
  Restrict where the provider supports it (IP allowlists, VPC).
- **Secret hygiene**: `REDIS_URL` is a secret - store it only in service environment
  variables, never in git or `VITE_` variables
  ([ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)).

## 8. Queue visibility without extra tooling

A BullMQ dashboard (bull-board) is not installed in this repository. Until you add one
(mount it behind admin authentication only), inspect queues with `redis-cli` and logs:

```bash
redis-cli -u "$REDIS_URL" LLEN bull:email:waiting        # depth per queue
redis-cli -u "$REDIS_URL" LLEN bull:email:failed         # dead-letter inspection
redis-cli -u "$REDIS_URL" ZCARD bull:email:delayed       # scheduled jobs
```

Worker logs mirror activity as `[worker:<queue>] <job>#<id> completed` / `failed`;
final failures log a `CRITICAL: ... permanently failed after N/N attempts` line for
log-based alerting ([BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md)).

Related: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) | [CRON_JOBS.md](CRON_JOBS.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

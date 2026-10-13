# Architecture

Status: **v1**. Sections 6 (data model) and 10 (implementation status) reflect code that exists today; the rest is the agreed design.

## 1. Overview

Two planes, with PostgreSQL as the single source of truth.

| Plane | Components | Responsibility |
|---|---|---|
| Control plane | Next.js (Vercel), Fastify API, BullMQ worker, Neon Postgres | Tenants, subscribers, packages, invoices, payments, dashboards, jobs |
| Data plane | FreeRADIUS, MikroTik routers at ISP sites | Authenticate and authorize users, enforce speed and session time, report accounting |

## 2. Design principles

1. **Database is authoritative.** Subscription state lives in Postgres. Redis holds only queue state and can be wiped without losing correctness.
2. **RADIUS-first enforcement.** Access is decided by FreeRADIUS reading database-derived data. The RouterOS API is a side channel (health, status, disconnect fallback), not the main provisioning path.
3. **Expiry survives failure.** Accept replies carry `Session-Timeout` equal to the time remaining, so sessions end on their own even if every job is down.
4. **Never trust the client or the callback blindly.** Activation happens only after a verified M-Pesa result (callback matched to a stored request, then confirmed or reconciled with STK Query).
5. **Tenant isolation in layers.** API scoping, repository functions that require a tenant id, composite foreign keys, and tests that attempt cross-tenant access.
6. **Small enough for one developer.** One VPS, one codebase for API and worker, no microservices.

## 3. Component responsibilities

| Component | Where | Responsibility | Exposure |
|---|---|---|---|
| Next.js | Vercel | Admin dashboard and hotspot portal UI. Holds no secrets besides the API URL | Public |
| Caddy | VPS | TLS termination, reverse proxy to the API | 443 |
| Fastify API | VPS | Auth, tenant-scoped REST API, Daraja callback endpoint | Via Caddy only |
| Worker | VPS | Expiry scanner, STK reconciliation, router health checks, retries | None |
| Redis | VPS | BullMQ queues | Localhost / Docker network, password, AOF |
| FreeRADIUS | VPS | Auth + accounting against Postgres | UDP 1812/1813 (and 3799 for CoA) **on the WireGuard interface only** |
| WireGuard | VPS + each router | Encrypted transport for RADIUS, RouterOS API, CoA; works through CGNAT | UDP 51820 |
| Neon | Cloud | PostgreSQL | TLS; separate roles per consumer |
| MikroTik | ISP site | Hotspot/PPPoE, NAS for RADIUS | Management reachable only via tunnel |

## 4. Topology

```
Customers -> MikroTik (ISP site) ==WireGuard==> VPS
                                                 |-- FreeRADIUS --+
 Vercel (Next.js) --HTTPS--> Caddy -> Fastify API --+--> Neon (Postgres)
 Safaricom Daraja --HTTPS callback--> Caddy -> API -+
                                      Worker <-> Redis
```

**Placement.** Put the VPS near the Neon region rather than near Kenya. API-to-DB and RADIUS-to-DB traffic is chatty and latency-sensitive; router-to-RADIUS is one round trip per authentication and tolerates distance. Measure with `pnpm db:check` from the real VPS before committing.

**Cookies.** Serve the web app and API from subdomains of one domain (`app.` and `api.`) and use `httpOnly`, `SameSite=Lax` cookies with an Origin check for CSRF.

## 5. Key flows

### 5.1 Hotspot purchase

1. Phone joins Wi-Fi; the router redirects to the portal (walled garden allows our domain).
2. User chooses a package and enters a phone number.
3. API creates or finds the subscriber, an invoice, a payment (`initiated`) and an `mpesa_requests` row, then calls STK Push.
4. Daraja calls the callback endpoint. The raw body is stored in `mpesa_callbacks` first.
5. In **one transaction**: match `CheckoutRequestID`, check the amount, set the payment `succeeded` (unique receipt number), the invoice `paid`, and the subscription `active` with computed `expires_at`.
6. The portal polls the API for payment status (not the customer's phone) and then logs the user in against the router. RADIUS accepts them.

If no callback arrives within the timeout, the worker calls STK Query and settles the same way.

### 5.2 Expiry

1. The worker runs a recurring scan (every minute) using the partial index on active subscriptions.
2. It marks due subscriptions `expired` (honouring the tenant grace period).
3. It enqueues an idempotent disconnect (CoA) per live session.
4. If CoA fails, retries run with backoff and the failure is visible in `provisioning_ops`. `Session-Timeout` is the backstop.

### 5.3 Reconciliation

Periodic job compares active RADIUS sessions with subscription state and records drift in `provisioning_ops` for retry or operator review.

## 6. Data model (implemented)

14 tables in `packages/db/src/schema`. All timestamps are `timestamptz` (UTC). Money is integer KES.

| Table | Purpose | Key constraints |
|---|---|---|
| `tenants` | An ISP | unique `slug`; `timezone` default `Africa/Nairobi`; encrypted M-Pesa config |
| `users` | Staff and platform admins | unique `lower(email)` |
| `memberships` | User-to-tenant role (`owner/admin/billing/viewer`) | unique `(user_id, tenant_id)` |
| `sessions` | Server-side sessions | PK is the SHA-256 of the token |
| `routers` | MikroTik devices | unique `nas_identifier` (global), unique `tunnel_ip`, unique `(tenant, name)`; encrypted credentials |
| `packages` | Sellable plans | unique `(tenant, name)`; checks on price, speed, duration |
| `subscribers` | Hotspot/PPPoE customers | unique `username` (global, RADIUS User-Name) |
| `subscriptions` | Time-boxed entitlement | **partial unique: one `active` per subscriber**; active rows must have `starts_at` and `expires_at` |
| `invoices` | Billing documents | unique `(tenant, invoice_number)`; `paid` requires `paid_at` |
| `payments` | Payment attempts | **partial unique `mpesa_receipt`**; amount > 0; `succeeded` requires `completed_at` |
| `mpesa_requests` | One row per STK Push | unique `checkout_request_id` |
| `mpesa_callbacks` | Append-only raw callback log | nullable tenant (forged callbacks may match nothing) |
| `provisioning_ops` | Retryable router operations | unique `(tenant, idempotency_key)` |
| `audit_logs` | Sensitive admin actions | index `(tenant, created_at desc)` |

### Relationships

```
tenants 1-* memberships *-1 users
tenants 1-* routers, packages, subscribers, invoices, payments, provisioning_ops
subscribers 1-* subscriptions *-1 packages
subscribers 1-* invoices; subscriptions 1-* invoices (optional link)
invoices 1-* payments 1-* mpesa_requests
users 1-* sessions
```

### Tenant isolation inside the database

Every parent that others reference has `UNIQUE (tenant_id, id)`. Child tables use **composite foreign keys** `(tenant_id, parent_id)`, so a row cannot reference a parent that belongs to another tenant, even if application code has a bug. The test suite proves this for subscriptions, invoices, payments and routers.

The unique `(tenant_id, id)` keys are *constraints*, not indexes, on purpose: Drizzle emits foreign keys before indexes, and Postgres needs the referenced unique constraint to exist at that point.

### State machines

| Entity | States | Notes |
|---|---|---|
| Subscription | `pending` -> `active` -> `expired`; `active` <-> `suspended`; `cancelled` | One active per subscriber |
| Invoice | `open` -> `paid` or `void` | **`overdue` is derived** (`open` and `due_at < now()`), not stored, to avoid a job that can drift |
| Payment | `initiated` -> `pending` -> `succeeded` / `failed` / `cancelled` / `timeout` | Receipt number is the duplicate guard |
| STK request | `pending` -> `success` / `failed` / `timeout` | |

### Time and money

- Store and compare in UTC. Display in the tenant timezone.
- Hour/day/week durations add fixed time. `month` adds a calendar month in the tenant timezone, clamped to month end.
- East Africa has no DST, but code must still use the IANA zone, not a hardcoded offset.

## 7. RADIUS integration (design, not yet built)

- FreeRADIUS reads **database views** named like the stock tables (`radcheck`, `radreply`, `radusergroup`) derived from subscribers, the active subscription and the package. There is no second copy of subscriber state to drift out of sync.
- Reply attributes: `Mikrotik-Rate-Limit` and `Session-Timeout`.
- `nas` is derived from `routers`; the view joins the NAS to the subscriber's tenant (FR-E5).
- Accounting tables use the official FreeRADIUS PostgreSQL schema, not a hand-written one. They arrive with the FreeRADIUS task.
- Interim-update interval 5 to 10 minutes; retention or partitioning decided before `radacct` grows.
- **Open decision:** how `subscribers.radius_password` is stored (see `requirements.md` section 8).

## 8. Security and networking

| Risk | Mitigation |
|---|---|
| Neon cold start or latency on RADIUS auth | Disable scale-to-zero in production; direct (non-pooled) connection with a small pool for FreeRADIUS; measure |
| RADIUS secret and RouterOS API exposed publicly | WireGuard only, firewall allow-lists, API-SSL (8729), least-privilege router user |
| Cross-tenant access, including RADIUS | Tenant-prefixed usernames, NAS-to-tenant join, composite FKs, repo functions requiring tenant id, cross-tenant tests |
| Forged or duplicate Daraja callbacks | Match stored `CheckoutRequestID`, verify with STK Query, unique receipt, amount check, single transaction, per-tenant secret callback path |
| Router and M-Pesa secrets at rest | AES-256-GCM with the key from the environment; never serialised to any API response |
| Redis state loss | DB is authoritative; scanner recomputes from the database |
| `radacct` growth | Interim interval, indexes, retention policy |
| MAC randomization on phones | Do not rely on MAC for identity; use phone number plus generated credential |
| Single VPS | Accept for pilot; backups with a tested restore; sessions persist while RADIUS is briefly down |
| Personal data | Phone numbers fall under the Data Protection Act 2019. Get legal advice on ODPC registration |

Firewall summary (VPS): allow 443 and 51820/udp publicly; allow 1812/1813/3799 udp and RouterOS API only on the WireGuard interface; Redis and Postgres never public.

## 9. Repository layout

```
isp-billing/
  apps/               api/ and web/ (later tasks)
  packages/db/        Drizzle schema, migrations, client, scripts, tests  <- exists
  packages/shared/    Zod schemas shared with web (later)
  infra/              compose helpers, FreeRADIUS, WireGuard, MikroTik templates, backup
  docs/               requirements.md, architecture.md, api.md
```

Domain modules inside `apps/api/src/modules/<domain>/` each hold `routes`, `service`, `repo`, `schemas`, and tests. External systems sit behind `integrations/` so tests can fake MikroTik and Daraja.

## 10. Implementation status

| Area | Status |
|---|---|
| Workspace, TypeScript strict, `packages/db` | Done |
| Schema (14 tables), first migration `0000_init_schema.sql` | Done, applied to local PostgreSQL 16 |
| Constraint tests (15) | Passing on local PostgreSQL 16 |
| Connectivity check script | Done; **run against local Postgres only. Neon not yet tested** |
| docker-compose (Postgres) | Written, **not run** |
| RLS policies | Not started (decision D3) |
| API, auth, worker, Redis | Not started |
| FreeRADIUS, RADIUS views, accounting tables | Not started |
| MikroTik integration | Not started; needs the RB941 |
| Daraja / M-Pesa | Not started; sandbox credentials needed |

Nothing involving a real router, Neon, Daraja or FreeRADIUS has been verified yet.

## 11. Decisions

All are **accepted defaults pending your confirmation**. Say so if you want to change any.

| # | Decision | Default |
|---|---|---|
| D1 | M-Pesa money flow | Each ISP's own Daraja credentials and shortcode |
| D2 | Enforcement authority | RADIUS-first, RouterOS API minimal |
| D3 | Postgres RLS | Yes, from the auth/tenancy task, using a non-superuser app role |
| D4 | RADIUS data | Views over application tables |
| D5 | VPS region | Near the Neon region |
| D6 | Router transport | WireGuard per router |
| D7 | Session auth | Database-backed sessions, argon2id, subdomain cookies |
| D8 | Hotspot identity | Phone number plus generated credential |
| D9 | "Recurring" billing | Next invoice plus customer prompt (STK needs a PIN) |
| D10 | SMS | Africa's Talking, post-MVP |
| D11 | Data allowances | Stored now, enforced later |
| D12 | Pilot ISP | Line one up early |
| D13 | DB driver | `pg` over TCP (long-lived VPS process), not Neon's serverless driver |
| D14 | IDs | UUID v4 via `gen_random_uuid()` |
| D15 | Migrations | `drizzle-kit generate`, applied by a script on a single direct connection |
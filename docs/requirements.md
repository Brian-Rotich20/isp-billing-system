# Requirements

Status: **v1 draft**. Scope follows the approved MVP cut. Items marked `MVP` are required for the first pilot; `POST` are deliberately postponed.

## 1. Purpose

A multi-tenant SaaS for small and medium WISPs, hotspot operators and broadband providers in Kenya. One platform operator hosts many ISPs ("tenants"). Each ISP manages its own subscribers, packages, routers, invoices and M-Pesa payments. Payment automatically grants internet access, and expiry automatically removes it.

## 2. Actors and roles

| Actor | Scope | Can |
|---|---|---|
| Platform admin | Whole platform | Create/suspend tenants, see platform health. Cannot see tenant M-Pesa secrets or router credentials. |
| Tenant `owner` | One tenant | Everything in the tenant, including team and M-Pesa settings |
| Tenant `admin` | One tenant | Subscribers, packages, routers, invoices, payments, reports. No team or M-Pesa settings |
| Tenant `billing` | One tenant | Invoices, payments, subscribers (read), reports |
| Tenant `viewer` | One tenant | Read-only dashboards and lists |
| Subscriber | Hotspot portal only | Pick a package, pay by M-Pesa, get online. No account login in MVP |

## 3. Functional requirements

IDs are stable; tasks and tests reference them.

### A. Tenancy and access

| ID | Requirement | Phase |
|---|---|---|
| FR-A1 | Platform admin creates, edits, suspends and reactivates tenants | MVP |
| FR-A2 | Staff log in with email + password; sessions are server-side and revocable | MVP |
| FR-A3 | A user may belong to several tenants with a role in each | MVP |
| FR-A4 | Every tenant-owned read and write is scoped to the caller's tenant, enforced in the API, the repository layer **and** the database (composite foreign keys; RLS is a Phase 2 decision) | MVP |
| FR-A5 | Per-tenant settings: name, timezone, expiry action (`disconnect` or `restrict`), grace period | MVP |
| FR-A6 | Per-tenant branding beyond name/logo | POST |
| FR-A7 | Sensitive admin actions are written to an audit log | MVP |

### B. Subscribers

| ID | Requirement | Phase |
|---|---|---|
| FR-B1 | Create, update, list, search subscribers (name, phone in E.164, email, type) | MVP |
| FR-B2 | Two types: `hotspot` and `pppoe`; each has a globally unique RADIUS username | MVP |
| FR-B3 | Suspend, reactivate and disable a subscriber | MVP |
| FR-B4 | View a subscriber's subscriptions, invoices, payments and sessions | MVP |
| FR-B5 | Subscriber self-service login portal | POST |

### C. Packages, subscriptions, invoices

| ID | Requirement | Phase |
|---|---|---|
| FR-C1 | Packages with duration (hour / day / week / month), price in whole KES, download/upload speed | MVP |
| FR-C2 | Packages store an optional data allowance; **enforcement is postponed** | MVP (store) / POST (enforce) |
| FR-C3 | A subscriber has at most one **active** subscription (database-enforced) | MVP |
| FR-C4 | Activation sets `starts_at` / `expires_at` only after a verified payment or an explicit manual action | MVP |
| FR-C5 | Expiry rule: instants are UTC; hour/day/week add fixed durations; `month` adds one calendar month in the tenant's timezone, clamped to the last day of a shorter month | MVP |
| FR-C6 | Invoices per purchase/renewal; `overdue` is derived (`open` and `due_at` in the past), not stored | MVP |
| FR-C7 | Manual cash payment recording, creating an audit entry | MVP |
| FR-C8 | Recurring auto-invoicing, proration, credit notes | POST |
| FR-C9 | Renewal for "recurring" packages = generate the next invoice and prompt the customer (STK Push needs the customer's PIN; there is no silent auto-charge) | POST |

### D. MikroTik

| ID | Requirement | Phase |
|---|---|---|
| FR-D1 | Register routers per tenant (name, NAS identifier, tunnel IP); credentials encrypted, never returned by any API | MVP |
| FR-D2 | Generate a RouterOS onboarding script (RADIUS, WireGuard, hotspot/PPPoE profile, walled garden) | MVP |
| FR-D3 | Periodic health check updates `status` and `last_seen_at` | MVP |
| FR-D4 | Disconnect an active session on demand (RADIUS CoA, RouterOS API as fallback) | MVP |
| FR-D5 | Full per-user provisioning over the RouterOS API | POST (RADIUS is authoritative) |
| FR-D6 | Router work is retried safely and idempotently (`provisioning_ops.idempotency_key`) | MVP |

### E. RADIUS

| ID | Requirement | Phase |
|---|---|---|
| FR-E1 | FreeRADIUS authenticates hotspot and PPPoE users from database-derived data | MVP |
| FR-E2 | Accept replies carry rate limit and `Session-Timeout` equal to the time left until expiry | MVP |
| FR-E3 | Expired, suspended or unknown users are rejected | MVP |
| FR-E4 | Accounting (start / interim / stop) stored in the database | MVP |
| FR-E5 | A subscriber can only authenticate through a router of **their own tenant** | MVP |
| FR-E6 | Data-cap enforcement, FUP, burst profiles | POST |

### F. M-Pesa

| ID | Requirement | Phase |
|---|---|---|
| FR-F1 | Initiate STK Push using the tenant's own Daraja credentials | MVP |
| FR-F2 | Callback endpoint records every callback raw, then processes idempotently | MVP |
| FR-F3 | A subscription is never activated from a frontend response, only from a verified callback or STK Query result | MVP |
| FR-F4 | Duplicate, late, failed and unknown callbacks are handled without double activation | MVP |
| FR-F5 | Pending requests are reconciled with the STK Query API after a timeout | MVP |
| FR-F6 | Manual C2B Paybill/Till reconciliation, Ratiba standing orders | POST |

### G. Background jobs

| ID | Requirement | Phase |
|---|---|---|
| FR-G1 | A recurring scanner finds `active` subscriptions past `expires_at` and expires them. The database is the source of truth, so a lost Redis queue cannot strand a subscription | MVP |
| FR-G2 | Expiry triggers a disconnect according to the tenant's policy | MVP |
| FR-G3 | Failed router operations retry with backoff; jobs are idempotent | MVP |
| FR-G4 | Reconciliation compares application state with router sessions and reports drift | MVP |
| FR-G5 | SMS reminders before expiry (Africa's Talking) | POST |

### H. Dashboard and reporting

| ID | Requirement | Phase |
|---|---|---|
| FR-H1 | Totals: subscribers, active, by type, expired | MVP |
| FR-H2 | Active sessions, router availability | MVP |
| FR-H3 | Daily/monthly collections; pending and failed payments | MVP |
| FR-H4 | Package performance, usage reports, exports | POST |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | TypeScript `strict`; schemas validated with Zod at every boundary (HTTP, env, webhooks) |
| NFR-2 | Passwords hashed with argon2id; session tokens stored only as SHA-256 hashes |
| NFR-3 | Secrets only in environment variables; tenant secrets encrypted at rest (AES-256-GCM) |
| NFR-4 | RADIUS, RouterOS API and CoA reachable only through the WireGuard tunnel |
| NFR-5 | Rate limiting on login, portal purchase and callback endpoints |
| NFR-6 | Structured JSON logs with request ids; health and readiness endpoints; job-failure tracking |
| NFR-7 | Daily database backup **and a tested restore**; documented runbook |
| NFR-8 | RADIUS authentication target: p95 under 300 ms server-side. Measure against Neon before trusting this number |
| NFR-9 | Migrations are forward-only, reviewed, and applied through a single connection (never a transaction-mode pooler) |
| NFR-10 | Automated tests cover billing rules, payment idempotency, tenant isolation and provisioning |
| NFR-11 | One developer must be able to operate and restore the whole system |

## 5. Constraints

- Stack is fixed: Fastify, Drizzle, Neon Postgres, BullMQ + Redis, FreeRADIUS, Next.js on Vercel, single Linux VPS, Docker Compose.
- Each ISP supplies its own Daraja credentials and shortcode; the platform never holds ISP funds.
- All money is whole-shilling integers (KES). All stored instants are UTC `timestamptz`.
- Lab hardware is a MikroTik RB941; its RouterOS version and feature support are **unverified** until tested.

## 6. Assumptions

These are accepted defaults from the architecture review, pending your confirmation (see `architecture.md` section 11):

1. Per-ISP M-Pesa credentials (D1) and RADIUS-first enforcement (D2).
2. One VPS placed near the Neon region, WireGuard per router (D5, D6).
3. Phone number plus a generated credential identifies a hotspot subscriber (D8).
4. Data allowances are stored but not enforced in the MVP (D11).
5. Kenyan phone numbers are normalised to E.164 (`+2547XXXXXXXX`, `+2541XXXXXXXX`).

## 7. Out of scope for the MVP

Subscriber self-service accounts, vouchers/agents, SMS, data-cap enforcement, multi-router load balancing, proration and credit notes, platform billing of ISPs, high availability, and mobile apps.

## 8. Open items that block later tasks

| Item | Blocks | Note |
|---|---|---|
| RADIUS credential storage (`subscribers.radius_password`) | FreeRADIUS task | PAP/CHAP/MS-CHAPv2 need a cleartext secret or NT hash on the RADIUS side. Decide in an ADR before this column is used |
| Per-tenant Daraja callback URL secrecy | M-Pesa task | Plan: derive a token by HMAC of the tenant id with a server secret, so no new column is needed |
| RLS yes/no (D3) | Auth/tenancy task | Needs a non-superuser application role |
| RB941 RouterOS version and WireGuard support | MikroTik task | Verify on the device |
| Daraja go-live approval | M-Pesa task | Start the application early; approval time is outside our control |
| Data Protection Act obligations | Pilot | Confirm ODPC registration and processing agreements with a lawyer |

## 9. Milestone 1 acceptance criteria and current status

| # | Criterion | Status |
|---|---|---|
| 1 | Workspace builds, TypeScript strict, test command runs | Done for `packages/db`. CI not set up yet |
| 2 | `.env.example` complete; env validated by Zod at startup | Done for the DB package |
| 3 | `docker compose up` starts Postgres | Compose file written; **not run** (no Docker in the build sandbox) |
| 4 | ERD and entity list reviewed | Written (`architecture.md` section 6); awaiting your review |
| 5 | Schema + first migration apply cleanly to an empty database | Done on local PostgreSQL 16 |
| 6 | Indexes for tenant lookups, unique receipt, one active subscription | Done and covered by tests |
| 7 | Database connectivity check | Done on local PostgreSQL 16. **Not yet run against Neon** |
| 8 | `/health` endpoint, structured logging | Not started (API scaffold task) |
| 9 | RADIUS views and `radtest` spike | Not started |
| 10 | RB941 capabilities documented | Not started; needs the device |
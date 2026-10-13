# API Contract

Status: **DRAFT v0, nothing here is implemented yet.** This is the target contract. Each implementation task updates this file with what actually shipped, so the doc never claims more than the code does.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://api.<domain>/v1` |
| Format | JSON in and out. Validated with Zod. Unknown fields are rejected |
| Auth | Session cookie (`httpOnly`, `Secure`, `SameSite=Lax`). Unsafe methods also check the `Origin` header |
| Tenant scope | The tenant comes from the session, **never** from the request body or query. Cross-tenant ids return `404`, not `403` |
| IDs | UUID strings |
| Money | Integer KES (whole shillings) |
| Time | ISO 8601 UTC (`2026-10-13T08:00:00Z`) |
| Phone | Input accepted as `07XX...`, `+2547XX...`, `2547XX...`; stored and returned as E.164 |
| Pagination | `?limit=50&cursor=<opaque>` returns `{ data, nextCursor }`. Max limit 200 |
| Idempotency | Payment initiation requires an `Idempotency-Key` header; replays return the original result |
| Rate limits | Stricter on login, portal purchase and webhooks. `429` with `Retry-After` |
| Secrets | Router credentials, RADIUS secrets and M-Pesa credentials are write-only and are never returned |

### Error format

```json
{ "error": { "code": "validation_failed", "message": "Human readable", "details": [], "requestId": "..." } }
```

| HTTP | `code` examples |
|---|---|
| 400 | `validation_failed` |
| 401 | `unauthenticated` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `conflict`, `active_subscription_exists`, `duplicate_username` |
| 422 | `invalid_state_transition` |
| 429 | `rate_limited` |
| 5xx | `internal`, `upstream_unavailable` |

## 2. Roles

`owner` > `admin` > `billing` > `viewer`. Platform admin is separate and only uses `/platform/*`.

| Resource | viewer | billing | admin | owner |
|---|---|---|---|---|
| Dashboards, lists | read | read | read | read |
| Subscribers | read | read | write | write |
| Packages | read | read | write | write |
| Invoices, payments | read | write | write | write |
| Routers | read | read | write | write |
| Team, M-Pesa settings | no | no | no | write |
| Audit log | no | no | read | read |

## 3. Endpoints

All paths are relative to `/v1`. Auth column: `public`, `session`, `platform`, or `webhook`.

### System

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | public | Liveness |
| GET | `/ready` | public | Readiness: DB and Redis reachable |

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login` | public | Email + password; sets cookie. Rate limited, uniform error on failure |
| POST | `/auth/logout` | session | Revokes the current session |
| GET | `/auth/me` | session | User, memberships, active tenant |
| POST | `/auth/switch-tenant` | session | Change active tenant (must be a member) |
| POST | `/auth/change-password` | session | Revokes other sessions |

### Platform admin

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/platform/tenants` | platform | List tenants |
| POST | `/platform/tenants` | platform | Create tenant and its first owner |
| GET | `/platform/tenants/:id` | platform | Tenant summary (no secrets) |
| PATCH | `/platform/tenants/:id` | platform | Edit name, timezone |
| POST | `/platform/tenants/:id/suspend` | platform | Suspend |
| POST | `/platform/tenants/:id/activate` | platform | Reactivate |

### Tenant settings and team

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/settings` | session | Name, timezone, expiry action, grace period |
| PATCH | `/settings` | session (admin+) | Update |
| PUT | `/settings/mpesa` | session (owner) | Write-only Daraja credentials; response is only `{ configured: true }` |
| GET | `/team/members` | session (admin+) | List members |
| POST | `/team/members` | session (owner) | Invite or add a member |
| PATCH | `/team/members/:id` | session (owner) | Change role |
| DELETE | `/team/members/:id` | session (owner) | Remove |

### Subscribers

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/subscribers` | session | Filter: `type`, `status`, `q` (name/phone/username) |
| POST | `/subscribers` | session (admin+) | Create. Server generates the tenant-prefixed RADIUS username |
| GET | `/subscribers/:id` | session | Detail with current subscription |
| PATCH | `/subscribers/:id` | session (admin+) | Update name, email, phone |
| POST | `/subscribers/:id/suspend` | session (admin+) | Suspend and disconnect |
| POST | `/subscribers/:id/reactivate` | session (admin+) | Reactivate |
| POST | `/subscribers/:id/disconnect` | session (admin+) | Disconnect live sessions (idempotent op) |
| GET | `/subscribers/:id/subscriptions` | session | History |
| GET | `/subscribers/:id/invoices` | session | |
| GET | `/subscribers/:id/payments` | session | |
| GET | `/subscribers/:id/sessions` | session | Accounting history |

### Packages

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/packages` | session | |
| POST | `/packages` | session (admin+) | |
| PATCH | `/packages/:id` | session (admin+) | Price changes do not alter existing invoices |
| POST | `/packages/:id/archive` | session (admin+) | Sets `is_active = false` |

### Subscriptions

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/subscriptions` | session | Filter: `status`, `expiresBefore` |
| POST | `/subscribers/:id/subscriptions` | session (billing+) | Manual activation (requires a recorded payment or an explicit reason; audited) |
| POST | `/subscriptions/:id/cancel` | session (admin+) | |

### Invoices and payments

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/invoices` | session | Filter: `status`, `overdue=true`, date range |
| POST | `/invoices` | session (billing+) | Create for a subscriber and package |
| GET | `/invoices/:id` | session | With payments |
| POST | `/invoices/:id/void` | session (billing+) | Only while `open` |
| POST | `/invoices/:id/payments/cash` | session (billing+) | Record cash; audited |
| POST | `/invoices/:id/pay/mpesa` | session (billing+) | Staff-initiated STK Push. Requires `Idempotency-Key`. Body: `{ phone }` |
| GET | `/payments` | session | Filter: `status`, date range |
| GET | `/payments/:id` | session | With STK request and result |
| POST | `/payments/:id/reconcile` | session (billing+) | Runs STK Query now |

### Routers and sessions

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/routers` | session | Credentials never included |
| POST | `/routers` | session (admin+) | Registers router; response includes the one-time WireGuard config and onboarding script |
| GET | `/routers/:id` | session | |
| PATCH | `/routers/:id` | session (admin+) | |
| DELETE | `/routers/:id` | session (admin+) | Blocked while sessions exist |
| GET | `/routers/:id/onboarding-script` | session (admin+) | Regenerates the RouterOS script |
| POST | `/routers/:id/check` | session (admin+) | Run a health check now |
| GET | `/sessions/active` | session | Live sessions from accounting |
| POST | `/sessions/:id/disconnect` | session (admin+) | |

### Hotspot portal (public, tenant resolved by slug, strictly rate limited)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/portal/:tenantSlug/packages` | public | Active hotspot packages only |
| POST | `/portal/:tenantSlug/purchase` | public | Body: `{ packageId, phone }`. Creates invoice, payment and STK Push. Returns `{ paymentId, pollToken }` |
| GET | `/portal/payments/:paymentId?token=` | public | Status for polling. Unguessable token, minimal fields. **The result never activates anything by itself** |

### Reports

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/reports/summary` | session | Subscriber counts, active, by type, expired, router availability, active sessions |
| GET | `/reports/collections` | session | `from`, `to`, `granularity=day|month` |
| GET | `/reports/payments/problems` | session | Pending and failed payments |

### Audit

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/audit-logs` | session (admin+) | Filter: `action`, `actor`, date range |

### Webhooks

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/webhooks/mpesa/:callbackToken` | webhook | Daraja STK callback. Always answers `200` quickly. Stores the raw body first, then processes asynchronously and idempotently |

The Daraja callback is **unsigned**, so the safeguards are layered: a per-tenant secret path token (planned: HMAC of the tenant id with a server secret, no schema change needed), matching the `CheckoutRequestID` to a stored request, amount check, unique receipt number, and an STK Query confirmation for anything doubtful.

## 4. Planned, not in the MVP

Subscriber self-service login, vouchers and agents, SMS endpoints, data usage reports and exports, platform billing of ISPs, C2B Paybill reconciliation.

## 5. Change log

| Date | Change |
|---|---|
| 2026-10-13 | Initial draft; no endpoints implemented |
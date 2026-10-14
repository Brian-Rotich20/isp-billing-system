# ISP Billing SaaS — Practical Build Guide

**Purpose:** This guide explains what we are building, how the main parts work together, and the order in which to build them. It is written for one developer working on both the backend and frontend.

> **Working rule:** Complete one step, test it, demonstrate it, update the documentation, and only then move to the next step. Features that have not been tested with real external services or hardware must be marked **unverified**.

---

## 1. What are we building?

We are building a web application that lets internet service providers (ISPs) manage their customers, internet packages, subscriptions, and payments.

An ISP staff member should be able to:

- Sign in and access only the ISP they belong to.
- Create internet packages, such as hourly, daily, weekly, and monthly plans.
- Register and manage subscribers using Wi-Fi hotspots or PPPoE.
- Record cash payments and accept M-Pesa payments.
- See invoices, subscriptions, routers, and active internet sessions.
- Automatically expire access when a subscription ends.

A customer using a hotspot should eventually be able to choose a package, pay with M-Pesa, and get online without staff assistance.

### What is included in the first release?

The first release focuses on the features needed to run a pilot with one ISP:

1. Staff accounts, tenant management, and permissions.
2. Packages and subscribers.
3. Invoices, subscriptions, and manual payments.
4. Automatic subscription expiry.
5. MikroTik registration and FreeRADIUS authentication.
6. M-Pesa STK Push and the customer hotspot portal.
7. Basic dashboard, monitoring, backups, and security.

Features such as vouchers, SMS reminders, advanced usage analytics, data-cap enforcement, mobile apps, and high availability are postponed until there is a clear need for them.

---

## 2. How the system fits together

The application has a **management side** and a **network side**.

### Management side

| Component | What it does |
|---|---|
| **Next.js web app** | The dashboard used by ISP staff and the public hotspot purchase portal. |
| **Fastify API** | Receives requests from the web app, checks permissions, applies business rules, and returns responses. |
| **PostgreSQL (Neon)** | Stores tenants, users, subscribers, packages, invoices, payments, subscriptions, and audit records. It is the main source of truth. |
| **Drizzle ORM** | Lets the TypeScript backend query PostgreSQL and manage database schema changes. |
| **Redis + BullMQ** | Runs background tasks, such as expiry checks, payment reconciliation, and router health checks. Redis is not the permanent record of business data. |

### Network side

| Component | What it does |
|---|---|
| **MikroTik router** | Provides hotspot or PPPoE access at the ISP's site. |
| **FreeRADIUS** | Checks subscriber credentials and subscription eligibility, and returns access limits. It also receives session accounting data. |
| **WireGuard** | Creates an encrypted tunnel between a router and the server so network management traffic is not exposed publicly. |
| **RouterOS API integration** | Checks router health and provides a fallback for disconnecting sessions. It is not the main way subscriber access is configured. |
| **Safaricom Daraja** | Processes M-Pesa STK Push requests and provides payment status information. |

### Main architecture rule

**PostgreSQL holds the truth about a subscription.** FreeRADIUS uses database-derived information to decide whether a subscriber can connect. Redis and background jobs help the system act on time, but losing queued jobs must not erase billing data or prevent the system from discovering expired subscriptions.

### High-level request flow

```text
ISP staff / hotspot customer
            |
            v
      Next.js web app
            |
          HTTPS
            |
            v
       Fastify API ---------> PostgreSQL
            |                     ^
            |                     |
            +----> Redis/BullMQ --+ (background work)

Subscriber device -> MikroTik -> WireGuard -> FreeRADIUS -> PostgreSQL

Fastify API <---- secure callback/status flow ---- Safaricom Daraja
```

---

## 3. Backend code organisation

Keep the API in one codebase with two entry points:

- `server.ts` starts the HTTP API.
- `worker.ts` starts background jobs.

They share the same modules, configuration, database access, and integrations. This avoids creating separate services before the application needs them.

### Recommended repository layout

```text
isp-billing/
├── package.json                 # npm workspace scripts and shared tooling
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── server.ts
│   │       ├── worker.ts
│   │       ├── modules/
│   │       │   ├── auth/
│   │       │   ├── tenants/
│   │       │   ├── subscribers/
│   │       │   ├── packages/
│   │       │   ├── billing/
│   │       │   ├── payments/
│   │       │   ├── routers/
│   │       │   └── reports/
│   │       ├── integrations/
│   │       │   ├── mikrotik/
│   │       │   ├── daraja/
│   │       │   └── radius-coa/
│   │       ├── jobs/
│   │       ├── middleware/
│   │       └── lib/
│   └── web/                     # Next.js App Router
├── packages/
│   ├── db/                      # Drizzle schema, migrations, seeds and DB helpers
│   └── shared/                  # Schemas and types shared with the web app
├── infra/
│   ├── docker-compose.yml
│   ├── docker-compose.prod.yml
│   ├── freeradius/
│   ├── wireguard/
│   ├── mikrotik/
│   └── backup/
└── docs/
    ├── architecture.md
    ├── requirements.md
    ├── api.md
    ├── decisions/
    └── runbooks/
```

This guide uses **npm**. If the project is set up as an npm workspace, run workspace commands from the repository root or use `npm --workspace apps/api ...` for API-specific commands. Do not mix npm and pnpm lockfiles in the same repository.

### What belongs in each backend module?

Use a consistent structure where it adds value:

```text
subscribers/
├── routes.ts       # Defines the HTTP endpoints
├── controllers.ts  # Reads requests and sends HTTP responses
├── service.ts      # Applies subscriber business rules
├── repo.ts         # Reads and writes subscriber data in PostgreSQL
├── schemas.ts      # Validates request data with Zod
├── types.ts        # Module-specific TypeScript types, when needed
└── subscribers.test.ts
```

The normal request path is:

**Route → Controller → Service → Repository → Database**

- **Route:** Which URL and HTTP method are available, and which validation and permission checks apply?
- **Controller:** What does this HTTP request need, and what response should be sent?
- **Service:** What business rules must be followed?
- **Repository:** How is information read from or written to the database?
- **Schema:** Is the incoming data valid?
- **Types:** What TypeScript shapes does this module use?

Not every small module needs a separate repository or types file. Avoid creating empty files just to follow a template. For business-critical modules such as billing and payments, keep the separation explicit.

### Integrations are separate from business rules

Code that communicates with MikroTik, Daraja, or FreeRADIUS CoA belongs in `integrations/`. A service calls an integration through a small interface rather than embedding network calls throughout the business logic. This makes failures easier to handle and integrations easier to test with fake implementations.

---

## 4. Main data concepts

The exact database schema lives in `packages/db`. These are the main concepts and how they relate:

| Record | Meaning |
|---|---|
| **Tenant** | An ISP using the platform. Tenant-owned data must be isolated from other ISPs. |
| **User** | A staff account or platform administrator. |
| **Membership** | Connects a user to an ISP and defines that user's role there. |
| **Router** | A MikroTik device belonging to an ISP. |
| **Package** | An internet plan with a price, duration, and speed limits. |
| **Subscriber** | A customer's hotspot or PPPoE account. |
| **Subscription** | The period during which a subscriber is entitled to use a package. |
| **Invoice** | The amount the subscriber owes for a purchase or renewal. |
| **Payment** | A payment attempt or recorded payment against an invoice. |
| **M-Pesa request/callback** | Records STK Push attempts and received callback payloads so payments can be reconciled safely. |
| **Provisioning operation** | A retryable record of an operation involving network access, such as disconnecting a session. |
| **Audit log** | A record of important actions performed by staff or administrators. |
| **RADIUS accounting** | Records login/session information reported by routers. |

### Important data rules

- Tenant-owned records must always be scoped to the correct `tenant_id`.
- Database constraints must prevent records belonging to one ISP from referencing another ISP's records.
- Use integer amounts in Kenyan shillings (KES), not floating-point values.
- Store timestamps in UTC; display them using the ISP's configured timezone.
- Keep invoices and payment history even when a package is archived or a subscription ends.
- Enforce at most one active subscription per subscriber, using both service logic and a database constraint.
- Treat invoice overdue status as something calculated from its due date and payment state rather than relying on a background job to keep a stored status accurate.

---

## 5. Rules that protect the system

### User access and tenant isolation

- There is no public staff sign-up. A platform administrator creates an ISP and invites its owner; the owner invites other staff.
- Tenant roles are `owner`, `admin`, `billing`, and `viewer`. Platform administrator access is separate from tenant roles.
- The active tenant must be taken from the authenticated session, not trusted from a request body or URL.
- Every tenant-owned query must be scoped by tenant. Add database constraints and Row Level Security (RLS) as an additional layer, with the application connecting through a role that does not bypass RLS.
- Suspended tenants and disabled accounts must be blocked centrally, not through scattered checks in each route.
- Test access using at least two tenants and verify that one tenant cannot read, change, or delete another tenant's data.

### Payment safety

A browser response or incoming M-Pesa callback is not enough on its own to mark an invoice paid. The backend must match the callback to a stored STK request, check the expected amount and receipt, handle duplicate callbacks safely, and reconcile uncertain outcomes using STK Query. Payment, invoice, and subscription changes must be made in one database transaction.

### Network safety

- Do not expose RADIUS, Redis, PostgreSQL, or the router management API publicly.
- Use WireGuard to carry router-management and RADIUS traffic between the router and server.
- Encrypt router API credentials and tenant M-Pesa secrets at rest. Never return them from normal API endpoints or write them to logs.
- RADIUS must verify that the connecting router and subscriber belong to the same tenant.

### Recovery

- Background jobs must be safe to retry.
- A periodic database scan must find expired subscriptions even if Redis is cleared or a job is missed.
- Backups only count as a recovery plan after a restore has been tested.
- Keep an audit trail for sensitive actions and manual billing adjustments.

---

## 6. How the main workflows operate

### A. Staff records a cash payment

1. Staff selects a subscriber and package.
2. The API checks the user's permission and the tenant's ownership of the records.
3. The billing service creates an invoice and records the payment in a database transaction.
4. The subscription is activated or extended and receives the correct expiry time.
5. The UI shows the invoice, payment, subscription status, and printable receipt.

Renewing before expiry extends from the existing expiry time. Renewing after expiry starts from the current time. The same request must not create duplicate payments if it is retried.

### B. A customer pays using M-Pesa

1. The customer selects a hotspot package and enters a phone number.
2. The API creates a pending payment and an STK request, then asks Daraja to send the payment prompt.
3. Daraja sends a callback to the API. The callback is stored before it is processed.
4. The backend checks the callback against the stored request and verifies the amount and receipt. It uses STK Query to reconcile uncertain results.
5. If payment is verified, one transaction marks the payment successful, the invoice paid, and the subscription active.
6. The portal checks payment status through the API and helps the customer log in to the router.

The browser must never activate a subscription merely because it displays a success message.

### C. FreeRADIUS allows or rejects a login

1. A device tries to connect through the MikroTik hotspot or PPPoE.
2. The router sends an authentication request to FreeRADIUS through the WireGuard tunnel.
3. FreeRADIUS checks database-derived RADIUS views. A row is returned only when the subscriber and tenant are eligible and the router belongs to the same tenant.
4. For an eligible subscriber, FreeRADIUS returns the package's speed limit and a session timeout based on the remaining subscription time. Invalid, expired, or suspended subscribers are rejected.
5. FreeRADIUS accounting records session activity.

The `radcheck`, `radreply`, and `radusergroup` data should be derived from application records through database views, avoiding a separate copy of authorization state that could become outdated.

### D. A subscription expires

1. A recurring worker scans the database for active subscriptions whose expiry and applicable grace period have passed.
2. It marks them expired and records the action.
3. It queues a request to disconnect any remaining live session.
4. Failed disconnects are retried and exposed for review.
5. `Session-Timeout` remains a fallback so an existing session does not continue indefinitely merely because a background job failed.

### E. A router goes offline

The health-check job updates the router's status and last-seen time. A single missed check should not immediately mark it offline. The dashboard shows the current status, and failed network operations remain visible for retry or operator review.

---

## 7. Frontend approach

Use **Next.js App Router, TypeScript, Tailwind CSS, and shadcn/ui** for the web application.

- The frontend displays information and collects input; business rules and security checks remain in the API.
- Use TanStack Query for API data and caching.
- Use React Hook Form with Zod for form validation where appropriate.
- Keep one typed API client responsible for sending cookies and handling standard API errors.
- Share Zod schemas with the API only where it is practical to do so through `packages/shared`.
- The frontend may hide actions a user cannot perform, but the API must still enforce permissions.

### Main screens, added over time

| Area | Screens |
|---|---|
| Authentication | Login, forgot password, reset password, accept invitation |
| Platform administration | ISP list, create ISP, ISP details, suspend/reactivate ISP |
| ISP settings | General settings, staff/team, audit log, M-Pesa setup, onboarding checklist |
| Packages | List, create, edit, archive |
| Subscribers | List, search, filters, details, create/edit, CSV import |
| Billing | Invoices, invoice details, payments, activate/renew subscription, printable receipt |
| Operations | Background jobs, routers, active sessions, network-operation history |
| Reporting | Dashboard, collections, payment issues, basic exports |
| Public portal | Package selection, phone entry, payment status, router login |

Use consistent tables, forms, confirmation dialogs, loading states, empty states, and error states. The staff dashboard should prioritise clear information over decorative effects. The hotspot portal should be mobile-friendly and lightweight for weak connections.

---

## 8. Build order

Build the backend and frontend together in small, testable slices. Each step should leave behind something that can be demonstrated.

### Stage 1 — Foundation

**Step 1: Set up the project and environments**

- Establish the npm workspace, API, web app, shared package, and database package.
- Configure strict TypeScript, linting, tests, environment validation with Zod, request logging, and central error handling.
- Add Fastify health endpoints: `/health` for process health and `/ready` for dependency readiness.
- Start local PostgreSQL and confirm the current migrations can be applied.
- Create the first frontend shell and verify that it can call the API.
- Establish CI and a staging path early enough to catch deployment and cookie issues.

**Step 1 is complete when:** the API starts, configuration errors fail clearly, database connectivity is checked, the web page reads API status, and tests run in CI.

**Early network experiment (time-boxed):** before depending heavily on RADIUS, test FreeRADIUS against PostgreSQL, record authentication latency, and check the available RouterOS version and capabilities of the RB941. This is a technical experiment, not a production implementation. Document any blocker and fallback.

### Stage 2 — Identity and ISP accounts

**Step 2: Authentication and permissions**

- Use Better Auth inside the Fastify API; do not build a second independent authentication system in the frontend.
- Configure login, logout, password reset, invitations, tenant membership, and platform administrator access.
- Define the `owner`, `admin`, `billing`, and `viewer` permission rules.
- Create shared middleware that checks the session, active tenant, user status, tenant status, and permissions.
- Disable public staff registration.

**Step 3: Platform administration**

- Allow platform administrators to create, view, suspend, and reactivate ISPs.
- Create the first ISP owner through an invitation or secure password-setup flow.
- Begin recording audit events for sensitive actions.

**Step 4: Tenant settings and team management**

- Add tenant timezone, subscription-expiry policy, and grace-period settings.
- Allow owners to invite staff, change roles, and remove team members.
- Prevent removal or demotion of the last owner.
- Add audit-log and onboarding-checklist screens.

**Stage 2 is complete when:** users can sign in, access is limited by role and tenant, platform administrators can manage ISPs, and owners can manage their teams.

### Stage 3 — Packages, subscribers, and billing

**Step 5: Packages**

- Add create, edit, list, and archive operations.
- Store prices, durations, speed limits, and optional data allowances.
- Keep old invoice amounts unchanged when a package's price changes.
- Implement and test expiry calculations, including calendar-month end dates.

**Step 6: Subscribers**

- Add subscriber creation, editing, searching, filtering, suspension, and reactivation.
- Support both hotspot and PPPoE subscribers.
- Normalise phone numbers and generate unique RADIUS usernames server-side.
- Add CSV import with a preview/dry run and row-level errors before committing the import.

**Step 7: Invoices, subscriptions, and manual payments**

- Implement invoice numbering per tenant.
- Support cash/manual payments, subscription activation, renewal, cancellation, and printable receipts.
- Keep invoice, payment, and subscription changes consistent using database transactions.
- Add audited manual adjustments with a required reason.
- Make retries safe and test simultaneous activation attempts.

**Stage 3 is complete when:** an ISP can register subscribers, create packages, record cash payments, issue invoices, and activate or renew subscriptions correctly.

### Stage 4 — Background processing

**Step 8: Redis, BullMQ, and subscription expiry**

- Add Redis and BullMQ for repeatable jobs, retry rules, and failed-job visibility.
- Build a database-backed expiry scanner that runs regularly and safely handles repeat executions.
- Add a basic job-monitoring screen.
- Confirm that clearing Redis does not prevent the next scan from finding expired subscriptions.

**Milestone A — Manual ISP:** staff can run the billing side of the business without router integration, and subscriptions expire automatically in the application.

### Stage 5 — Router and RADIUS integration

**Step 9: Router registration and onboarding**

- Let an ISP register a MikroTik router and check its status.
- Generate an onboarding bundle containing the necessary RouterOS and WireGuard configuration.
- Protect router credentials and show secrets only when a one-time setup flow requires it.
- Test the configuration on the actual router; until then, label the integration unverified.

**Step 10: FreeRADIUS authentication and accounting**

- Configure FreeRADIUS to read authorised users and package limits from PostgreSQL views.
- Add the official FreeRADIUS PostgreSQL accounting tables.
- Restrict RADIUS traffic to the WireGuard interface.
- Show active sessions and session history in the dashboard.
- Test valid, invalid, expired, suspended, and cross-tenant logins with `radtest` and the real router.

**Step 11: Disconnects and reconciliation**

- Disconnect active sessions after expiry or suspension using RADIUS CoA, with RouterOS API fallback where needed.
- Retry failed operations safely and show their status to staff.
- Compare active sessions with subscription state and resolve safe discrepancies.

**Milestone B — Network works:** a paid subscriber can connect through a real MikroTik, an expired subscriber is rejected, and session information is visible in the dashboard.

### Stage 6 — M-Pesa and self-service

**Step 12: M-Pesa payments**

- Configure each ISP's own Daraja credentials and shortcode; keep credentials encrypted and write-only through the UI.
- Implement STK Push, stored callbacks, duplicate protection, amount checks, and STK Query reconciliation.
- Provide staff with a way to inspect pending, failed, and uncertain payments.
- Test success, timeout, duplicate callback, wrong amount, cancellation, and forged/unknown callback scenarios.

**Step 13: Public hotspot portal**

- Display available hotspot packages and collect the customer's phone number.
- Start an STK Push and show a waiting screen with retry and error handling.
- Poll the API for payment status; only verified payment processing may activate a subscription.
- On success, submit the required login details to the MikroTik hotspot flow.
- Test on a real phone over a slow connection.

**Milestone C — Self-service:** a customer can choose a package, pay using the Daraja sandbox, and get online through the hotspot. Sandbox success is not proof that production payments are ready.

### Stage 7 — Reporting and production readiness

**Step 14: Dashboard and reports**

- Show subscriber counts, active subscriptions, active sessions, router status, collections, and payment problems.
- Add date filters and basic CSV exports where needed.
- Verify totals using known test data and the tenant's timezone.

**Step 15: Security and reliability review**

- Review permissions, tenant isolation, RLS, secrets handling, logging, rate limits, and session security.
- Add two-factor authentication for platform administrators and owners if retained in the pilot scope.
- Configure alerts, backups, and perform a real restore test.
- Test recovery from worker failure, Redis loss, payment-callback failure, and router tunnel loss.
- Measure RADIUS authentication latency under realistic test load.

**Step 16: Deploy and pilot with one ISP**

- Match production configuration to staging and review firewall rules.
- Complete production Daraja approval and test a small real payment with the pilot ISP.
- Follow a documented onboarding checklist and prepare rollback steps.
- Write short runbooks for common issues, including payment succeeded but no internet, router offline, and payment stuck.
- Prepare terms, privacy information, and data-processing documentation with appropriate legal guidance.

**Milestone D — Pilot-ready:** one ISP has completed a real end-to-end trial, backups can be restored, alerts are working, and known limitations are documented.

---

## 9. What to leave until later

Do not let these items delay the first working pilot unless an ISP's real needs make one essential:

- SMS reminders and receipts.
- Vouchers and agent sales.
- Subscriber self-service accounts.
- Data-cap enforcement, fair-use policies, and throttling.
- Automatic recurring invoices and standing orders.
- Manual Paybill/Till reconciliation and automated refunds.
- Advanced usage analytics, multiple-router failover, and detailed network provisioning through RouterOS API.
- Custom domains and extensive white-label branding.
- Mobile app and high-availability infrastructure.
- Billing the ISPs for their SaaS subscription; invoice them manually at first.

Record new ideas in `docs/parking-lot.md`. Revisit them after the pilot or when a real customer need justifies them.

---

## 10. External items to arrange early

Some work cannot be completed by code alone. Arrange these while building the foundation:

- A domain and DNS for the app and API, including staging subdomains.
- A VPS placed near the chosen Neon database region, then measure the real connection latency.
- A Daraja developer account and sandbox credentials; start the production go-live process early.
- An email provider for invitations and password resets.
- Access to the RB941 or other test MikroTik, plus a phone and a PPPoE test client.
- One pilot ISP willing to test with its real network and subscriber data.
- Legal guidance on Kenyan data-protection obligations, terms, and privacy documents.

---

## 11. How to decide that a step is complete

Before moving to the next step, check the items that apply:

- [ ] Database migrations work on a fresh database and upgrade an existing database safely.
- [ ] API inputs are validated, permissions are enforced, and tenant-scoped tests pass.
- [ ] Tests cover normal cases, invalid input, failures, and retries where relevant.
- [ ] The UI uses the real API and handles loading, empty, error, and forbidden states.
- [ ] Sensitive actions are recorded in the audit log.
- [ ] `docs/api.md`, `docs/requirements.md`, and this guide reflect what has actually been implemented.
- [ ] The feature has been demonstrated locally or in staging.
- [ ] Any service or device that has not been tested in reality is clearly marked **unverified**.

Do not mark a feature complete merely because the code compiles. For network and payment integrations, completion requires successful tests against the relevant router or provider environment.

---

## 12. Documentation to keep alongside this guide

| Document | Purpose |
|---|---|
| `docs/architecture.md` | Explains the system components and how they communicate. |
| `docs/requirements.md` | Defines what the system must do and what is out of scope. |
| `docs/api.md` | Documents the API endpoints and request/response contracts that actually exist. |
| `docs/decisions/` | Records important technical choices and why they were made. |
| `docs/runbooks/` | Gives step-by-step instructions for deployment, recovery, and common incidents. |
| `docs/parking-lot.md` | Captures ideas that should not interrupt current work. |

**Current next step:** finish the local API foundation, verify the health endpoint, and confirm PostgreSQL/Drizzle migrations work. Then proceed to authentication and tenant handling before building packages, subscribers, and billing. Keep RADIUS and the actual RB941 test as an early risk check rather than postponing all network validation until the end.

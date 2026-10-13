# Product decisions and build plan

Last updated: 2026-10-13
Status: Phase 1 local demo built and manually verified; commercial validation and production hardening remain open.

## Product understanding (10 lines)

1. This is a multi-tenant operations product for Kenyan commercial cleaning and facility-maintenance companies.
2. The buyer is the owner or office administrator who coordinates recurring work at customer sites.
3. Field workers and supervisors need a very simple mobile workflow that tolerates weak or absent connectivity.
4. The main business problem is the gap between work being completed and the customer accepting and paying for it.
5. The product's wedge is job-level proof of work that travels with a clear client report and invoice-ready summary.
6. Office staff manually turn requests into jobs, assign workers, and manage schedules in the first release.
7. Workers complete a checklist, record notes, capture compressed photos, and collect client sign-off.
8. Offline work must queue locally, sync safely, and remain visible until the server confirms receipt.
9. Recurring schedules, client approval or dispute, and basic company data isolation belong in the MVP.
10. AI, M-Pesa collection, eTIMS issuance, payroll, inventory, GPS tracking, and advanced analytics are later extensions; the core workflow must work without AI.

## Recommended data model

All company-owned rows carry `tenant_id`. Use composite foreign keys (tenant plus row ID) and enforce tenant scope in the API and database policies so a guessed ID cannot expose another company's data.

- **Tenant**: company identity, settings, timezone, report branding, retention policy.
- **User**: login identity and minimal profile.
- **Membership**: tenant, user, role, active state; initial roles are owner/admin, supervisor, and worker.
- **Client**: company customer and contact methods.
- **Site**: client location, site instructions, and access notes; access notes require tighter permissions and retention.
- **ServiceTemplate**: job type, checklist version, default duration and report wording.
- **Contract**: tenant/client/site, recurrence rule, service template, billing cadence, active period, and cancellation state.
- **Job**: one scheduled service occurrence, site, template snapshot, due window, status, contract reference, and optimistic version.
- **JobAssignment**: worker/supervisor assignments and their effective dates.
- **ChecklistItem / ChecklistResponse**: versioned template item and per-job answer, note, actor, and captured time.
- **WorkEvent**: append-only job activity with client-generated mutation ID, actor/device, occurrence time, server receipt time, and event type. This is the sync/idempotency record.
- **Evidence**: photo/sign-off metadata, storage key, size/hash, captured-by/time, upload state, and consent/notice record where applicable. Binary data lives in object storage.
- **ClientDecision**: approval or dispute, actor, time, and dispute reason.
- **ReportSnapshot**: immutable version of the client report and invoice-ready summary, with totals/rounding inputs and generation time.
- **ReportShare**: one-job, revocable client access token stored as a hash, expiry, and access history.
- **AIActivity** (later): provider/model and prompt version, referenced inputs, generated output, human reviewer, accepted/edited/rejected result, and retention metadata. Avoid unnecessary raw personal data in logs.

## Recommended architecture

- **Worker/admin app**: TypeScript React PWA, responsive and mobile-first. Service worker caches the app shell; IndexedDB caches only assigned work and queues offline events and compressed evidence. Show a persistent unsynced count and retain queued records until server acknowledgement.
- **API**: typed TypeScript REST API with a published OpenAPI contract. Validate every request and resolve tenant membership/role on the server; never trust a tenant ID sent by the browser.
- **Database**: managed PostgreSQL with migrations, tenant-scoped constraints, transactionally recorded sync receipts, and backups. Keep hosting region/provider configurable until data-transfer, cost, and support requirements are agreed.
- **Offline sync**: client-generated UUID per mutation; server idempotency prevents duplicate completion on retry. Treat schedule/assignment edits as server-owned versioned state; accept field evidence as append-only events. A stale completion is retained and flagged for supervisor review instead of silently overwriting newer office changes.
- **Evidence storage**: compress images on-device, enforce file/count limits, upload through short-lived authorized URLs after reconnect, and store metadata/hash in Postgres. Generate the client report from a server-side immutable snapshot after evidence sync.
- **Client access**: initially use a short-lived, revocable, single-job report link with approval/dispute actions; no client account unless pilots require one. Do not expose other sites, jobs, or internal notes through that link.
- **Authentication**: phone-based verification for company accounts; workers can unlock a previously authenticated device with a local PIN while offline. Choose an SMS/OTP provider only after pricing, coverage, and data handling are checked.
- **Invoice boundary**: generate an invoice-ready service summary with tested arithmetic, but label it clearly as a draft/supporting document. Do not represent it as a KRA eTIMS tax invoice or collect money in the MVP.
- **AI boundary**: later, call a provider-swappable adapter that returns schema-validated drafts. A human must approve edits before they affect jobs, reports, or invoices. Record decisions and corrections for quality review.

## Phased build plan

### Phase 0 — validate one real workflow

Observe one pilot company's request-to-payment flow, collect a redacted job/checklist/report example, confirm billing rules, identify target Android devices and agree on link access/retention. Define status transitions and invoice arithmetic before UI work.

### Phase 1 — smallest demoable vertical slice

Create a tenant, admin, customer, site, one manual job, and a worker assignment. On the worker PWA, open an assigned job, complete a checklist while offline, add a compressed photo and sign-off, then reconnect and sync exactly once. Admin sees evidence and sync state. Start with one service template and one company, while keeping tenant boundaries in the schema from day one.

**Tests first:** unit tests for invoice-summary arithmetic/rounding and sync tests for offline queue, retry/idempotency, ordering, and stale-job conflict behavior. Also test tenant isolation before a second tenant is enabled.

### Phase 2 — client report and billing handoff

Create an immutable client-facing job report plus invoice-ready summary from synced work. Share it through a revocable single-job link. Let the client approve or dispute and require a reason for disputes. Make corrections create a new report snapshot rather than editing the sent version.

### Phase 3 — recurring operations

Add weekly/monthly contract schedules that create job occurrences idempotently, allow skip/reschedule/cancel, and define how visits roll up to a billing period. Validate daylight-saving/timezone behavior and duplicate generation even though Kenya uses one civil timezone.

### Phase 4 — pilot hardening and rollout

Pilot with real low-end Android phones and poor connectivity. Measure completion time, sync failures/duplicates, missing evidence, report corrections, time from completion to invoice-ready, client disputes, and staff adoption. Add monitoring, backups/restore rehearsal, retention controls, support/onboarding, and role audit before expanding.

### Later, not MVP

AI-assisted intake/reporting and anomaly flags behind an adapter; M-Pesa through a payment provider; eTIMS via the appropriate KRA integration/certification path; then payroll/inventory/analytics only if customers pay for them. Confirm integration obligations before implementation.

## Reference links to verify during implementation

- [ODPC data protection laws](https://www.odpc.go.ke/data-protection-laws-kenya/) and [ODPC guidance notes](https://www.odpc.go.ke/guidelines-2/).
- [KRA eTIMS system-to-system integration](https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration).

## Changed from the brief

- **First demo uses browser APIs, Python's standard-library HTTP server, and local SQLite.** The workspace has no app scaffold, package dependencies, Docker, or local Postgres. This avoids external installs and gives the demo a persistent transactional sync target. Trade-off: it is not the selected production architecture; before a real pilot with customer data, move to a typed API and managed PostgreSQL, add real authentication, and review hosting/data-transfer choices.
- **Invoice-ready summary is a draft/supporting document, not a legal tax invoice.** The brief defers eTIMS. This avoids implying tax compliance before an approved integration exists; trade-off: an owner may still need to issue the official invoice separately.
- **Use append-only field events and idempotent sync rather than last-write-wins.** This reduces lost work on reconnect; trade-off: supervisors need a small review flow for stale/conflicting completions.
- **Start with a one-job report link, not a full client portal.** This keeps the first slice small; trade-off: the first pilot may later require client accounts or stronger verification.
- The existing `outputs/savanna-routes-demo.html` is a separate tourism concept from the earlier discussion; it is not the foundation for this product.

## Concerns

- Browser storage on low-end Android can be evicted or the device can be lost. PWA offline behavior must be proven on the actual target phones; do not promise durable offline capture until device trials pass. If it fails, evaluate a thin native shell.
- Photos and signatures can consume bandwidth/storage and contain personal information. Set limits, show upload state, minimize capture, and define retention/deletion before pilots.
- Conflicting office edits during a worker's offline period need an explicit review path; silent overwrite is unacceptable.
- Client report links can be forwarded. Expiry, revocation, least-privilege scope, and access logs are required; confirm whether a PIN/OTP challenge is needed.
- Phone numbers, site instructions, photos, signatures, and worker activity are personal data. Document purpose/lawful basis, notice/consent where required, processor terms, retention, access controls, and cross-border transfer handling with Kenyan privacy guidance. Avoid collecting precise location because GPS is out of scope.
- Invoice arithmetic, taxes, contract proration, and rounding rules can damage trust. Keep invoice calculations deterministic and versioned; never let an LLM calculate totals.
- OTP and messaging fees can scale with logins and notifications. Keep provider adapters and cost alerts; do not send automatic messages until customer consent and unit economics are clear.
- Multi-tenancy failures are high impact. Tenant scoping must be enforced server-side and covered by automated authorization tests before any real customer data is used.

## Missing from the brief

- Initial pilot company, exact service category, job/checklist examples, and number of workers/sites.
- Whether workers use company-owned/shared phones or personal BYOD devices, and minimum Android/browser version.
- Maximum expected offline duration and acceptable queued photo volume per worker/day.
- What proof constitutes customer sign-off, who can dispute, dispute deadlines, and how corrections are approved.
- Billing model: per visit versus monthly contract; service lines, discounts, VAT/tax handling, deposit/retention, and rounding rules.
- Client-link access requirements, report availability period, and whether the customer contact needs a PIN/OTP.
- Whether users can belong to more than one tenant (e.g. subcontractors) and whether worker names/contact details are visible to clients.
- Data retention/deletion schedule, backup retention, incident response, data processor/controller responsibilities, and preferred hosting/data-transfer constraints.
- Onboarding/support owner, pilot success threshold, and the price customers will pay.

## Suggested next experiments

1. Interview 5 owners/admins and 5 field workers in one service category; observe a real job being assigned, evidenced, signed off, reported, and invoiced.
2. Ask for three redacted examples: current job card/checklist, client report, and invoice/supporting statement. Compare them to the proposed schema and calculations.
3. Measure the current median time from job completion to client-ready report/invoice, and count disputes caused by missing proof over the last month.
4. Run a paper/PWA prototype with one crew on low-end Android, airplane mode for a full shift, then reconnect. Include app closure/restart, repeated taps, and a supervisor edit made while offline.
5. Offer a paid pilot with a clear success metric and setup/support fee before adding AI or payment integrations.

## Open questions and current assumptions

1. **Which first service category and pilot workflow?** Assumption: commercial cleaning first, with a single site visit checklist.
2. **What phones and offline duration must work?** Assumption: low-end Android using current Chrome, offline for a work shift, then reconnect; use PWA unless device trials show it fails.
3. **How is the customer report accessed and approved?** Assumption: revocable one-job link, 30-day expiry, no client account; approval/dispute recorded with timestamp and contact identity.
4. **How are visits priced and billed?** Assumption: KSh line items stored in integer cents, no tax computation in v1, invoice-ready summary reflects approved contract/job charges, and monthly contracts are invoiced as a period roll-up.
5. **Can staff work across company tenants?** Assumption: no cross-tenant worker membership in v1; each person is explicitly invited to one company.

## Accepted assumptions

The user agreed the direction is solid and asked to continue. Proceed with the five assumptions above unless the user changes them. The first slice is limited to manual job creation/assignment and offline worker completion/sync; client reports and recurrence remain subsequent slices.

## Brand direction

- Product name: **KaziProof**, connecting the Swahili word *kazi* (work) with proof of service.
- Visual mark: a simple K monogram; palette: clear teal, cool light surfaces, and restrained blue/amber status colors.
- The fictional seeded tenant is **KaziProof Demo**; the app displays tenant labels separately from the KaziProof product brand.

## Implementation and verification record

- The local demo supports office job creation/assignment, a mobile worker checklist, notes, compressed photo selection, client signature capture, IndexedDB outbox, and idempotent server sync.
- Manual browser walkthrough on 2026-10-13: saved a fictional completion while **Simulate offline** was on; verified it showed as queued on the worker view, then reconnected and saw the single received update and its checklist, note, and sign-off on the office board.
- Automated verification: all 9 unit tests pass, covering invoice arithmetic and sync retry, stale completion, worker assignment, and tenant scope. Python and JavaScript syntax checks pass. SQLite `PRAGMA foreign_key_check` returned no violations.
- The walkthrough used the app's offline simulation, not Android airplane mode or a full-shift low-connectivity trial. Photo capture/compression and job creation still need a device-level/manual pilot check.
- A fresh database seeds an assigned Mwangaza Offices demo job. The local verification database may contain later demo activity; it is ignored by Git.
- The tested invoice arithmetic is not yet surfaced in a job-level invoice-ready summary or client report. Those remain the next product slice, after a pilot operator confirms how their visits are priced and billed.

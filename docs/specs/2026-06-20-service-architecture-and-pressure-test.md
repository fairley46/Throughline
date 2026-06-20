# Supplement — Service Architecture dimension + three-scale pressure test

**Date:** 2026-06-20
**Status:** Locked (Brad directive 2026-06-20)
**Extends:** `2026-06-20-value-stream-reconciliation-design.md` and `docs/BUILD_BRIEF.md`
**Builds on:** existing commit `7726f36` (do NOT restart the structure — extend it).

---

## Part A — The service-architecture dimension (new model axis)

The model so far captures the **value stream** (journeys of entities through stages). Brad's
directive adds a second axis: the **service architecture** — the applications, services,
vendors, and infrastructure the business actually runs on, and what they cost. This is the
other half of the "invisible operating floor": not just *how work flows*, but *what the work
runs on and what it costs to run*.

### The bridge (why this is powerful)

Each service is tagged with the **stages it powers** (`stages_served[]`). That edge is the
bridge between the two axes. It turns cost-per-stage from labor-only into the real number:

```
cost(stage) = labor (FTE) + allocated tooling/services + direct costs
```

and unlocks diagnostics that are invisible from either axis alone.

### New node: `ServiceNode` (add to `packages/core/src/model.ts`)

```
service_id
name              // "Dentrix", "Salesforce", "AWS", "Stripe"
category          // practice_mgmt | crm | accounting | comms | infra | payments | hr | bi | security | ...
cost_model        // subscription_per_seat | subscription_flat | usage | transaction_fee | one_time
monthly_cost      // normalized to monthly (number)
seats             // licensed seats (nullable)
utilized_seats    // seats actually in use, if known (nullable) -> waste signal
usage_volume      // for usage/transaction models (nullable)
fte_roles[]       // which roles/FTEs use it (nullable)
stages_served[]   // stage ids this powers -- THE BRIDGE (may be empty -> orphan candidate)
vendor
source            // which input revealed this
confidence        // how sure we are about placement/cost
```

Add `services: ServiceNode[]` to `ValueStreamModel`. Extend `validateModel` so every service
either maps to ≥1 known stage or is represented as an orphan gap (no silent drops, mirroring
the event rule).

### New gap types (the philosophy carries over)

An **orphan app** is the service-architecture twin of an **interval seam nobody owns** — paid
for, serves nothing captured. Same gap-as-first-class-object idea, new axis. Add to the `Gap`
type union:

- `orphan_service` — a paid service that maps to no captured stage (zombie subscription /
  shadow IT). Cost is real; value is unaccounted.
- `redundant_service` — two+ services in the same `category` serving the same stage(s)
  (app sprawl / overlap).
- `underutilized_service` — `utilized_seats / seats` below a threshold (paying for unused
  licenses).

Each carries its cost so the render can total "$X/mo flowing into gaps."

### New diagnostics (extend `diagnostics.ts`)

- **Tooling cost per stage** — sum of allocated service cost per stage (a service serving N
  stages allocates `monthly_cost / N` to each, unless usage data says otherwise).
- **True cost per stage** = labor proxy + tooling + direct.
- **Cost per journey / per completed outcome**, including the stack.
- **App sprawl index** — count of distinct services per category; flag categories with > 1
  active tool serving overlapping stages.
- **Vendor / stack concentration risk** — a stage whose tooling is entirely one vendor.
- **Spend-in-gaps total** — $/mo across orphan + underutilized services.

### Render additions (`dashboard/`)

- A **service-architecture view/layer** alongside EVENT and STAGE views: services grouped by
  the stage they power, with cost, seat utilization, and category.
- Per-stage drill-down now also shows **the apps that power this stage and their cost.**
- Surface the **spend-in-gaps** list (orphan / underutilized / redundant) as visibly as the
  journey ledger — same honesty principle.

---

## Part B — Three-scale pressure test (the headline deliverable)

Generate realistic **faked** data at three business scales and run the full pipeline on each.
Each scale must include BOTH axes: multi-source value-stream data AND a service-architecture
inventory source (e.g. a subscription/SaaS-spend/expense export). The scales stress different
parts of the system on purpose.

> Enterprise volume: generate a **representative sample**, not millions of rows — and `log`/note
> in the report that it is sampled. Realism of shape and traps matters more than row count.

### Scale 1 — Dentist office (micro, ~3–8 staff)

- **Value stream:** patient books → insurance verify → visit → treatment → billing →
  insurance claim → payment → recall/recurring visit.
- **Sources:** practice-management export (Dentrix/Open Dental shape), payment processor,
  insurance clearinghouse, an appointments spreadsheet, accounting (QuickBooks shape).
- **Service architecture (~6–10 apps):** practice-mgmt (~$300–600/mo), accounting, payments
  (transaction fee), VoIP phone, insurance clearinghouse, patient-reminder SMS, maybe imaging.
- **Trap:** one patient, multiple **separate** treatment plans/visits over time — the
  over-merge trap at micro scale (records share only patient identity across sources).
- **Stresses:** can the pipeline work with tiny, messy, low-volume data and still not merge
  two distinct treatment episodes.

### Scale 2 — SMB (50–200 employees, B2B SaaS/services)

- **Value stream:** lead → deal → close → onboarding/implementation → support →
  renewal/expansion.
- **Sources:** CRM export (HubSpot/Salesforce shape), billing (Stripe/Chargebee shape),
  support (Zendesk/Intercom shape), implementation/project tool (Asana/Jira shape).
- **Service architecture (~30–60 apps):** CRM, marketing automation, billing, support, project
  mgmt, Slack, Google Workspace, cloud/AWS, HR/payroll, accounting, BI — per-seat costs scaled
  to ~100 employees.
- **Traps:** customer with multiple deals/orders (over-merge); cross-source linkage with **no
  shared key** (deal in CRM, invoice in Stripe, ticket in Zendesk linked only by email/domain);
  **two overlapping PM tools** (redundant_service); a couple of zombie subscriptions.
- **Stresses:** the core reconciliation (Tier-2 probabilistic links carrying real weight) and
  the first real app sprawl.

### Scale 3 — Enterprise (1000s employees, multi-BU)

- **Value stream:** more stages, multiple business units, partner/channel **distribution**.
- **Sources:** multiple CRMs (post-acquisition duplication), an ERP/billing system, ITSM
  (ServiceNow shape), a data-warehouse export, and a **procurement/SaaS-management export**
  (Zylo/Productiv shape) for the app inventory.
- **Service architecture (200+ apps):** SaaS sprawl, shadow IT, redundant tools across BUs,
  large infra spend, many underutilized licenses.
- **Traps:** same customer across **many orders/regions/merged systems** (heavy over-merge
  risk); conflicting IDs across merged CRMs; large **orphan/zombie-subscription** surface;
  **interval seams across BU handoffs**.
- **Stresses:** scale, the over-merge guard under adversarial ID collisions, and the gap
  surface (both interval seams and service gaps) exploding.

### Vertical configs

Current configs: `saas-implementation`, `vehicle-service-bay`, `generic`. Add:
- `dental-practice` (Scale 1) — stages + cardinality (e.g. one treatment-plan → one claim;
  one patient → many treatment-plans, which is exactly the over-merge tripwire).
- `enterprise-b2b` (Scale 3) — extended stages incl. distribution/channel; reuse SMB grain
  where sensible.
SMB (Scale 2) maps to `saas-implementation`.

### Deliverable — the pressure-test report

`docs/PRESSURE-TEST.md` plus the three rendered outputs. For each scale, report:
- Row/source/service counts (note enterprise sampling).
- The honest ledger (reconstructed/inferred/orphaned %).
- **Proof the over-merge guard held** — the planted multi-order/multi-treatment trap did NOT
  collapse into one journey (assert this in a test per scale).
- Top interval-seam bottlenecks and top service gaps (spend-in-gaps total).
- Where the pipeline strained or a heuristic was too crude at a given scale (honest failure
  notes — do not paper over).

---

## Build instructions

1. Extend the model/diagnostics/render/verticals on top of commit `7726f36`. Do not restart.
2. Keep the script/agent split and the deterministic, testable over-merge guard.
3. Generate the three datasets under `examples/{dentist,smb,enterprise}/`.
4. Run `run-pipeline.mjs` on each → model.json + HTML in `out/`.
5. Write `docs/PRESSURE-TEST.md`. Add a per-scale over-merge regression test.
6. Commit incrementally with the gamertagged-studios identity + the standard trailers.

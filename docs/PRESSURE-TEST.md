# Pressure Test — dentist → SMB → enterprise

**Date:** 2026-06-20
**Datasets:** `examples/dentist`, `examples/smb`, `examples/enterprise` (all synthetic).
**Regression tests:** `packages/core/src/__tests__/pressure.test.ts` (runs the real pipeline
on each scale and asserts the contracts below).

The goal was not to prove the engine perfect. It was to stress it at three scales of volume and
messiness and find where it bends. It found something real — documented honestly below.

## Results at a glance

| Scale | Sources | Events | Services | Journeys | Ledger (recon/inferred/orphan) | Service gaps | Spend-in-gaps/mo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Dentist | 4 + inventory | 23 | 8 | 4 | 100 / 0 / 0 | 4 | $344 |
| SMB | 5 + inventory | 113 | 36 | 19 | 47 / 53 / 0 | 30 | $21,117 |
| Enterprise* | 6 + inventory | 104 | 88 | 13 | 54 / 46 / 0 | 97 | $203,804 |

*Enterprise is a **representative sample**, not a full enterprise volume — realism of shape and
traps over row count.

Every scale validates clean: **no silent drops** (every event lands in a journey or a gap).

## What held

- **The over-merge guard's core contract holds at every scale.** A customer with multiple
  distinct orders never collapses into a single journey. Dentist's Maria (2 treatment plans) →
  2 journeys; SMB's Northwind (2 deals) → 2 journeys; enterprise's Globex (5 orders) → 3
  journeys. The catastrophic, plausible-looking single-blob failure does not occur. This is now
  a regression test per scale.
- **Tiered, explainable linkage degrades gracefully.** Where sources share a real key, links are
  Tier-1 (dentist: 100% reconstructed). Where they share only email/domain (SMB, enterprise),
  the reconciler falls back to Tier-2 probabilistic links and the ledger honestly reports the
  shift (SMB 53% inferred, enterprise 46% inferred) rather than asserting false certainty.
- **The service-architecture axis works and scales believably.** Orphan (zombie), redundant
  (sprawl), and underutilized services are all detected; spend-in-gaps scales from $344/mo
  (a single dentist's Adobe seat) to $203,804/mo (enterprise SaaS sprawl, 37 zombie apps at
  $95k/mo alone). Interval-seam bottlenecks surface the sales→implementation handoff (enterprise:
  12 such seams, up to 80 days unowned).

## What bent — the real finding

**The guard prevents the blob, but it does not guarantee clean per-order event partitioning,
and segmentation degrades with scale.**

Concretely, from the actual model output:

- **Dentist:** the two journeys are correct in count, but journey-1 wrongly absorbs the August
  plan's `appointment_booked` and `treatment_performed` events alongside February's.
- **SMB:** both deals' `deal_created`/`deal_won` events pack into journey-1; the split correctly
  fires at the first downstream `max:1` stage (billing).
- **Enterprise:** Globex's 5 orders produce only 3 journeys, and `order-0001` is a 27-event
  mega-journey spanning multiple orders' full lifecycles. Not one blob — but under-segmented.

**Root cause:** the cardinality guard splits a journey only at stages that are the *destination*
(`to`) of a `max:1` rule. Entry-stage events (lead / deal / purchase) and events on `max:"many"`
fan-out stages are never split points, so they pack into the first sibling journey. The
consequence is distorted per-journey cycle times — a journey that appears to span February to
August because it inherited a sibling's events.

**Why it matters:** this is exactly the "plausible-but-wrong" failure the project was built to
avoid. The headline ledger and bottlenecks remain directionally honest, but per-journey
diagnostics on multi-order customers are not yet trustworthy at enterprise scale.

**Recommended fix (next engine work, not done here):** extend the guard so entry-stage and
`many`-side events are partitioned to their nearest downstream `max:1` anchor — or to their
order-level foreign key when one is present in the source — instead of defaulting to the first
chain. The regression tests deliberately assert only the anti-blob contract today; tighten them
to assert per-order partitioning once the fix lands.

## Bug fixed during the test

**Silent source misclassification.** Source files were classified as service-inventory by
*filename* (`/service|saas|spend/`), so an `itsm-servicenow.csv` was silently swallowed as
inventory — dropping an entire support axis without warning. Now classification is by **content**
(presence of service-inventory columns), and a filename that looks like inventory but isn't
emits an explicit `NOTE` and is treated as a value-stream source. Silent drops are the one thing
this project must never do. Fixed in `run-pipeline.mjs`.

## How to reproduce

```bash
npm test                              # includes the per-scale pressure regression tests
# or run a single scale and open the dashboard:
node skills/reconstruct-value-stream/run-pipeline.mjs \
  --vertical enterprise-b2b --sources examples/enterprise --out out/enterprise
npm run dashboard -- --model out/enterprise/model.json
```

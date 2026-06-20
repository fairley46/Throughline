# Value-Stream Reconciliation — Design v0

**Date:** 2026-06-20
**Status:** Locked (Brad sign-off 2026-06-20)
**Working project name:** `throughline` (provisional — dedicated naming pass still owed, per the build spec's naming note; precedent: ShipSignal → Legibly)
**Parent build spec:** Business Value-Stream Reconstruction Skill (the `/remote-control` brief)

---

## Scope of this document

This designs the **net-new reconciliation layer** only — the part with no analogue in
`Lum1104/Understand-Anything`, because code hands you the graph for free and business data
does not. Everything else in the pipeline (source-profiler, event-normalizer, stage-mapper,
diagnostician, model-reviewer, render) mirrors UA's existing architecture and is specified in
the build brief, not here.

Per the build spec: spend disproportionate design effort here. This is the product.

---

## The reframe (load-bearing decision)

Standard "entity resolution" dedupes a **set**: "is this the same customer across two CRMs?"
Our problem is **sequence linkage**: reconstruct one journey's *chain* across sources
(deal → invoice → ticket → renewal), under a chosen unit of analysis.

Conflating the two produces the **over-merge bug**, which is worse than an obvious failure
because the output still looks plausible while every downstream number is wrong.

### The over-merge bug, concretely

Unit of analysis = the order. Acme Corp buys twice:

- **Order A (Jan):** deal #4471 → invoice #2025-113 → ticket #9982
- **Order B (Jun):** deal #5500 → invoice #2025-440 → ticket #9999

Many of these records only share `"Acme Corp" / john@acme.com`. Off-the-shelf entity
resolution draws a similarity edge between any two lookalike records, then takes
**connected components** — every record reachable through similarity edges becomes one cluster.
Because all six share the customer, they collapse into **one blob** reported as a single
journey: one deal, two invoices, two tickets. Cycle-time and cost math now span two unrelated
orders as if they were one.

### The fix

Two guardrails, both required:

1. **Stage-and-time-ordered clustering.** A journey runs along the value stream in a direction
   (deal → invoice → ticket) and roughly in time order. Order A's records cluster in January,
   Order B's in June. Linkage walks the chain in stage + temporal order rather than taking
   undirected connected components — so the January invoice binds to the January deal, not the
   June one.
2. **Expected shape (cardinality), from vertical config.** "One deal has one invoice" means a
   cluster trying to attach two invoices to one deal is a red flag: split into two journeys
   rather than merge. Cardinality bounds the fan-out (one deal → many tickets is allowed;
   one deal → two invoices is not).

**This is the single corner that must not be cut.** `unit-detector` and `reconciler` are
therefore co-designed: the unit defines the journey grain, and the vertical's cardinality
config defines the legal shape that prevents the blob.

---

## The script / agent boundary (mirrored from UA)

UA's efficiency trick: deterministic scripts compute structure cheaply; LLM agents judge
meaning. `extract-import-map.mjs` finds cross-file edges; `file-analyzer` interprets them.
We mirror it for cross-*source* edges:

- **`detect-join-candidates.mjs`** — deterministic, no LLM. Column-value overlap analysis,
  key normalization (email casing, name / phone / company variants), temporal-window candidate
  generation, value correlation. Emits a candidate-link list with **raw per-signal scores.**
  This is our analogue of `extract-import-map.mjs`.
- **`reconciler`** — LLM agent. Takes candidates + signal scores and makes the semantic calls a
  script cannot: is this column overlap a genuine foreign key or coincidence? does this fuzzy
  match make business sense? is this 11-day gap a real seam or just a weekend? Assigns final
  confidence; classifies gaps.

Scripts compute evidence; the agent judges meaning. Same split, same reason as UA.

---

## Tiered, explainable linkage (not one fuzzy score)

Every link records *why it exists*, because the output must be honest about known-vs-guessed.

- **Tier 1 — deterministic join (~0.95–1.0):** a verified shared key
  (`invoice.deal_id == deal.id`). Script proposes; agent confirms it's a real FK, not
  coincidental overlap.
- **Tier 2 — composite probabilistic (0.5–0.9):** no single key, but multiple weak signals
  agree (fuzzy email + temporal window + value correlation). Score = weighted sum of agreeing
  fields (Fellegi-Sunter-flavored). The link **stores which signals fired and each one's
  contribution** — auditable, not a black box.
- **Tier 3 — could-not-connect:** a record the journey *expects* a counterpart for (per
  cardinality) but nothing clears threshold → becomes a gap object (below), never dropped.

---

## Gaps are first-class — and they are two different things

This distinction is where the bottleneck signal comes from.

- **Linkage gap** — orphan records, or "we believe these belong together but can't prove it"
  (signals below threshold).
- **Interval seam** — the link *is* made, but timestamps leave an **unowned interval**: handoff
  stamped day 0, implementation start stamped day 11, no record owns days 1–10.
  **Bottlenecks live in interval seams.** They are invisible from any single source by
  construction — visible only when two sources are linked and disagree.

The diagnostician's bottleneck metric is literally: aggregate interval seams across all
journeys; surface seams with the largest / most consistent unowned time. That is the
"invisible operating floor" made visible.

### Gap object schema

```
gap_id
type            // "orphan" | "weak_link" | "interval_seam" | "missing_expected_stage"
entity_id       // journey it belongs to (or candidate)
stage_from      // seam start, if interval type
stage_to        // seam end, if interval type
records[]       // source records bracketing the gap
interval        // unowned time, if applicable
expected_by     // which rule / cardinality predicted a counterpart should exist
confidence      // how sure the gap is real vs an artifact of bad linkage
```

---

## The honest ledger (top-level, never hidden)

Every journey is classified by provenance:

- **reconstructed** — Tier-1 keys end to end. We *know* this journey.
- **inferred** — held together by Tier-2 probabilistic links. We *believe* this journey.
- **could-not-connect** — chain broken by orphans / unresolved gaps.

Output a headline ledger — *X% reconstructed / Y% inferred / Z% orphaned* — and the HTML
surfaces it rather than burying it. The skill is honest about what is known vs. guessed.

---

## Reconciler I/O contract

**Input:** normalized events (common event model from `event-normalizer`) + a chosen unit of
analysis (from `unit-detector`) + the vertical's cardinality/stage-order config + candidate
links with raw signal scores (from `detect-join-candidates.mjs`).

**Output:**
- `journeys[]` — each a stage-ordered chain of events under one `entity_id`, with a provenance
  class and the per-link evidence trail.
- `gaps[]` — first-class gap objects per the schema above.
- `ledger` — the reconstructed/inferred/orphaned breakdown.

These feed `stage-mapper` and `diagnostician` downstream, and the render surfaces the ledger,
the per-link evidence, and the interval seams.

---

## Open items

- **Naming pass** still owed (working name `throughline`).
- **Cardinality config format** — define the per-vertical schema for expected stage order +
  legal cardinalities; ship 2–3 verticals + a generic fallback (per parent spec).
- **Threshold defaults** for Tier-2 promotion vs. gap demotion — start conservative
  (bias toward declaring a gap over asserting a weak link), tune on real data.

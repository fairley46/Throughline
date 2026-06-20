# Build Brief — throughline *(working name)*

**For:** the build session (autonomous agent) executing this project.
**Read first:** `docs/specs/2026-06-20-value-stream-reconciliation-design.md` — the reconciliation
layer is **already designed and locked**. Do not re-propose it. Build to it.

---

## What you are building

A standalone, vertical-agnostic skill that ingests an assortment of business data
(CSV / JSON / XLSX / text from different sources and shapes), reconstructs the end-to-end value
stream (customer purchase → logistics → sales → implementation → support → ongoing support →
distribution / retention), and renders it as an interactive, interrogable HTML view with
time / cost / FTE / bottleneck diagnostics.

The point of the product: make the **invisible operating floor** of a business visible — the
BMW-service-bay / factory-floor view of an operation that otherwise has no single visible
structure.

---

## Prior art to mirror — and the hard constraint

Mirror the architecture of [`Lum1104/Understand-Anything`](https://github.com/Lum1104/Understand-Anything)
(MIT): **multi-agent pipeline → persisted JSON model → separate interactive render.** It turns
code into a knowledge graph and renders an interactive dashboard. We build the equivalent for
business data instead of code.

> **HARD CONSTRAINT: do not modify Understand-Anything's existing skills, agents, or packages.**
> It is installed locally (read-only reference) at
> `~/.claude/plugins/cache/understand-anything/understand-anything/2.7.7/` and public on GitHub.
> We are building a **separate, standalone skill in this repo.** Borrow the *architecture and
> patterns*; ship our own code.

### UA's actual architecture (verified from the local source — study it before you start)

It is a pnpm monorepo:

- `packages/core` — TypeScript engine (parsers, extractors, persistence, analyzer).
- `packages/dashboard` — the interactive render, reads the persisted JSON.
- `skills/<name>/` — each skill is a `SKILL.md` plus deterministic helper scripts
  (`scan-project.mjs`, `extract-structure.mjs`, `extract-import-map.mjs`, `compute-batches.mjs`,
  `merge-batch-graphs.py`, …).
- `agents/*.md` — the LLM agents (`project-scanner`, `file-analyzer`, `domain-analyzer`,
  `graph-reviewer`, …).

**The pattern to steal — the script/agent split:** deterministic `.mjs`/`.py` scripts do the
cheap structural extraction (no LLM); LLM agents do only the semantic inference; a merge script
assembles; a reviewer agent validates; the dashboard renders from persisted JSON. Reproduce
this division of labor.

**Propose your own file structure** for this repo based on the *actual* UA layout you study —
do not invent one from this brief, and do not let this brief prescribe it from the outside.
Recommend the structure, then build it.

---

## The agent pipeline (ours)

| Agent | Role | Origin |
| --- | --- | --- |
| `source-profiler` | Accept the assortment; profile each source: columns, candidate entities, timestamps, things that look like cost or a person/FTE | mirror UA `project-scanner` |
| `event-normalizer` | Map every source onto the common event model below | adapt UA `file-analyzer` |
| `unit-detector` | Scan normalized events, count transitions per candidate entity, **propose** the unit of analysis with the most complete end-to-end journey, surface for confirmation | **net-new** (co-designed with reconciler) |
| `reconciler` | Infer which records across sources belong to the same journey; score confidence; represent gaps as first-class objects | **net-new — see the locked design spec; this is the product** |
| `stage-mapper` | Map reconciled events onto value-stream stages; vertical config supplies stage labels | adapt UA `domain-analyzer` |
| `diagnostician` | Compute cycle time, cost-per-stage, FTE load, handoff gaps, bottlenecks (bottlenecks = aggregated interval seams from the reconciler) | **net-new** |
| `model-reviewer` | Validate model completeness + referential integrity before render | mirror UA `graph-reviewer` |

Run normalizers in parallel in batches, as UA does. Support **incremental updates**: feeding
more data later patches the model rather than rebuilding.

Deterministic script feeding the reconciler: **`detect-join-candidates.mjs`** (the analogue of
UA's `extract-import-map.mjs`) — see the design spec.

---

## Common event model (normalization target)

Everything, whatever its source shape, collapses to:

```
entity_id    // the journey this event belongs to (post-reconciliation)
event        // what happened
timestamp    // when
actor / FTE  // who / what role did it (nullable)
cost         // attached cost if any (nullable)
stage        // value-stream stage (assigned by stage-mapper)
source       // which input this came from
confidence   // how sure we are this event is correctly placed/linked
```

Stages differ by vertical; primitives do not.

---

## Reconciliation layer — LOCKED (read the spec, do not redesign)

Summary of what the spec mandates; the spec is authoritative:

- **Sequence linkage, not set dedup.** Reconstruct each journey's *chain* in stage + time order
  under a chosen unit. **Stage-and-time-ordered clustering + cardinality from vertical config**
  is the corner that must not be cut — naïve connected-components over-merges separate journeys
  that share a customer.
- **Script computes evidence, agent judges meaning** (`detect-join-candidates.mjs` → `reconciler`).
- **Tiered, explainable links:** Tier-1 deterministic join / Tier-2 composite probabilistic
  (store which signals fired + each contribution) / Tier-3 could-not-connect.
- **Gaps are first-class, two kinds:** linkage gaps and **interval seams** (the unowned interval
  where bottlenecks live). Gap object schema in the spec.
- **Honest ledger:** reconstructed / inferred / could-not-connect, surfaced not hidden.

---

## Persistence & runs

- Every run writes a structured JSON **model artifact** (the business equivalent of UA's
  `knowledge-graph.json`). The JSON file *is* the persistence layer. Runs are stateless; the
  artifact is durable. Re-run to refresh; commit to share; load to interrogate later.
- Keep an `intermediate/` scratch dir that is **not** part of durable output (gitignored).

---

## Diagnostics to derive

Per stage and end-to-end: cycle time, cost-per-stage, FTE load/allocation, handoff gaps,
bottlenecks. Bottlenecks are computed from aggregated interval seams across journeys.

---

## HTML output

- **Model-first render** — from the JSON model, never straight from raw data.
- Static for v1, but build **each stage as a self-contained component** so adding interactivity
  later is a swap, not a rewrite.
- "Pull it apart": click a stage → its metrics, drill-down records, and the underlying source
  events.
- Color-coded stage legend (mirror UA's layer visualization).
- **Show the confidence / gap layer visibly** — surface the honest ledger and interval seams;
  do not hide uncertainty.
- Two altitudes (mirror UA's structural/domain toggle): a raw **EVENT** view (every record) and
  a **STAGE** view (value-stream altitude). Adapt detail to audience (operator / exec / analyst).

---

## Vertical-agnostic design

Pipeline is common; only a small per-vertical config changes (stage labels, expected stage
order + legal cardinalities, typical handoffs). Ship **2–3 vertical configs + a generic
fallback** (e.g. a SaaS implementation flow and a vehicle-service-bay flow share primitives and
differ only in stage configuration).

---

## Deliverables for this build session

1. A recommended repo file structure (derived from studying UA's actual layout), then built.
2. The seven agents + `detect-join-candidates.mjs`, wired into a runnable pipeline.
3. The persisted JSON model schema + a sample run on synthetic multi-source data.
4. The model-first HTML render with EVENT/STAGE views and the visible confidence/gap layer.
5. 2–3 vertical configs + generic fallback.
6. Tests (mirror UA's vitest setup where it fits) — especially for the over-merge guard in the
   reconciler.

## Out of scope / do not do

- Do not modify UA's installed skills/agents/packages.
- Do not redesign the reconciliation layer — build to the locked spec.
- Do not render straight from raw data — model-first only.
- Do not pick a final product name — `throughline` is a placeholder; naming pass is owed.

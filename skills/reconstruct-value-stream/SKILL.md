---
name: reconstruct-value-stream
description: Reconstruct an end-to-end business value stream from multi-source operational data (CRM, billing, support, scheduling, accounting, SaaS-spend exports) and produce an interactive model that shows how work flows, where it stalls, what it runs on, and what it costs.
argument-hint: ["--vertical <id> --sources <dir> [--out <dir>] [--unit <unit>] [--sample N] [--full|--review|--live]"]
---

# /reconstruct-value-stream

Analyze a directory of operational data sources and produce a `model.json` artifact in the
output directory, then render it to `index.html`. The model is this tool's durable output.
A run is stateless; the JSON file *is* the persistence layer. Re-run to refresh, commit to share,
load to interrogate or render later. The render reads **only** the model, never the raw sources.

The architecture splits work cleanly: deterministic scripts compute structure cheaply; LLM agents
judge meaning. Unlike a codebase, business data carries no explicit dependency graph, so the
load-bearing layer here is **reconciliation** — the part that reconstructs one entity's chain
across sources without over-merging two unrelated journeys that merely share a customer. See
`docs/specs/2026-06-20-value-stream-reconciliation-design.md` (the locked design) and
`docs/specs/2026-06-20-service-architecture-and-pressure-test.md` (the service-architecture
axis).

## Options

- `$ARGUMENTS` may contain:
  - `--vertical <id>` — the vertical config to use (e.g. `saas-implementation`,
    `dental-practice`, `vehicle-service-bay`, `enterprise-b2b`, `generic`). Required. Configs
    live in `verticals/*.json`; they supply stage order, legal cardinalities (half the
    over-merge fix), and join-key aliases.
  - `--sources <dir>` — directory of source files (CSV / TSV / JSON / TXT). Required. Any file
    whose name matches `service|saas|subscription|spend|app-inventory|expense` is treated as a
    **service-architecture** inventory rather than value-stream events.
  - `--out <dir>` — output directory for `model.json` + `index.html` (default `out/`).
  - `--unit <unit>` — the unit of analysis (the journey grain, e.g. `order`, `treatment_plan`,
    `repair_order`). If omitted, the vertical's `defaultUnit`; with `--live` the `unit-detector`
    agent proposes it and surfaces it for confirmation.
  - `--sample N` — cap each value-stream source to N rows (for enterprise-scale inputs; the run
    notes it sampled).
  - `--full` — ignore any existing `model.json` and rebuild from scratch.
  - `--review` — run the full `model-reviewer` agent instead of only the deterministic
    `validateModel` check before render.
  - `--live` — dispatch the LLM agents per phase (the live-agent path) instead of running the
    deterministic harness. See **Two execution paths** below.

---

## The model (the durable artifact)

Everything the pipeline produces collapses into one `ValueStreamModel`
(`packages/core/src/model.ts`). Its parts:

- `events[]` — every fact lifted from every source, normalized onto the common event model
  (`event-model.ts`). The EVENT-view substrate.
- `journeys[]` — reconstructed entity chains: a stage-ordered list of `event_ids` under one
  `entity_id`, with the per-link evidence trail and a `provenance` class.
- `services[]` — the service-architecture inventory (the second axis). Each `ServiceNode`
  carries `stages_served[]`, the **bridge** that turns cost-per-stage from labor-only into
  labor + allocated tooling.
- `gaps[]` — first-class gap objects (orphan, weak_link, interval_seam,
  missing_expected_stage, orphan_service, redundant_service, underutilized_service). Nothing is
  silently dropped: every event is in a journey **or** a gap; every service maps to a stage
  **or** is a service gap.
- `ledger` — the honest headline: % reconstructed / % inferred / % could-not-connect.
- `diagnostics` — cycle time, cost-per-stage, FTE proxy, bottlenecks (aggregated interval
  seams), and the service-architecture rollup.

`MODEL_VERSION` and `validateModel()` (the mechanical referential-integrity check) live next to
the schema.

---

## Two execution paths

UA's `SKILL.md` is driven by a live agent runtime dispatching subagents per phase. This skill
supports both that and a self-contained deterministic harness, because the deliverable must be
runnable and CI-testable without a live agent loop (see `docs/STRUCTURE.md`, decision #2).

1. **Deterministic harness (default).** `run-pipeline.mjs` wires the deterministic stages into
   one runnable script. Where the live pipeline would call an LLM agent (e.g. the `reconciler`
   confirming a fuzzy match makes business sense, the `stage-mapper` labelling an ambiguous
   event), the harness uses the vertical config + deterministic heuristics as the agent-judgement
   stand-in — and emits the **same** model artifact the agents would. The over-merge guard
   itself is pure TypeScript in `packages/core/src/reconcile.ts`, so it is provable in CI and
   never depends on an LLM being careful.

   ```bash
   node skills/reconstruct-value-stream/run-pipeline.mjs \
     --vertical saas-implementation --sources examples/synthetic-saas --out out
   # or: npm run pipeline -- --vertical <id> --sources <dir> --out <dir>
   # or: npm run demo
   ```

2. **Live-agent path (`--live`).** Each phase below dispatches the corresponding agent in
   `agents/*.md`. The agents are the authoritative spec of what each LLM step must do; they
   consume the same deterministic script outputs the harness uses and emit the same model
   sub-structures. Swapping the harness's heuristic stand-ins for `claude -p` per agent is a
   substitution at the phase boundaries, not a rewrite — the script/agent split and the model
   contract are identical on both paths.

The phases are numbered identically on both paths; only the actor (script vs. agent) differs at
the phases marked **(LLM)**.

---

## Scratch and durable output

- `intermediate/` — per-run scratch (profiles, candidate-link lists, per-agent inputs/outputs).
  Gitignored; not durable. The harness writes its intermediates (`_candidates-in.json`,
  `_candidates-out.json`) under the output dir; the live path uses `intermediate/`.
- `out/model.json` + `out/index.html` — the durable artifact and its render. `model.json` is
  what you commit / share; the HTML is regenerable from it at any time.

---

## Phases

### Phase 0 — Pre-flight

1. Resolve `--vertical`, `--sources`, `--out`, `--unit`, `--sample` from `$ARGUMENTS`. Verify the
   sources directory exists and the vertical config (`verticals/<id>.json`) loads. If the config
   is missing, report the available verticals and **STOP**.
2. Ensure `@throughline/core` is built (`npm run build`). Later phases import it.
3. Create `intermediate/` (live path) or the output dir (harness). Decide full vs. incremental:
   on `--full` or no existing `model.json`, run all phases; otherwise see **Incremental updates**.

### Phase 0 — Profile sources *(deterministic — `profile-sources.mjs`)*

For each source file, profile its columns and flag which look like timestamps, money,
person/FTE, or identifiers (candidate join keys). This is the analogue of UA's `scan-project.mjs`:
cheap structure, no LLM. The harness reuses `parseFile()` + `profile()` directly; the live path
runs `profile-sources.mjs <sourcesDir> <out>` and hands the profiles to the `source-profiler`
agent.

### Phase 0b — Profile interpretation *(LLM — `source-profiler` agent)*

The agent reads the deterministic profiles and decides what each source *is*: which column is
the canonical timestamp, which is cost, which is the actor/FTE, which columns are real join keys
vs. coincidental, and — critically — whether the source is value-stream events or a
service-architecture inventory. The script enumerates; the agent narrates.

### Phase 1 — Normalize events *(deterministic mapping; LLM judgement on ambiguity)*

Map each source row onto the common `NormalizedEvent` shape (event_id, event name, timestamp,
actor, cost, source, and the raw `attributes` that carry the join keys verbatim). The harness
does this with the column heuristics in `run-pipeline.mjs`; the live path dispatches the
`event-normalizer` agent for rows the heuristics can't classify
(ambiguous event names, multi-event rows). Output: the `events[]` substrate, `stage` still null.

### Phase 1b — Ingest the service inventory *(deterministic)*

Any source detected as a service inventory is normalized into `ServiceNode`s
(`toServiceNode()` in `run-pipeline.mjs`): name, category, cost_model, monthly_cost, seats,
utilized_seats, `stages_served[]`, vendor. This is the second axis; it does not become events.

### Phase 1c — Detect the unit of analysis *(LLM — `unit-detector` agent)*

Propose the unit whose end-to-end journey is most complete across sources (the journey grain),
and surface it for confirmation. **Net-new; co-designed with the reconciler** — the unit defines
the grain, and the vertical's cardinality config defines the legal shape that prevents the
over-merge blob. The harness uses the vertical's `defaultUnit` (or `--unit`); the live path runs
the agent.

### Phase 2 — Detect join candidates *(deterministic — `detect-join-candidates.mjs`)*

Compute cross-**source** evidence: column-value overlap, key normalization (email case-fold,
company-suffix stripping), temporal-window candidates, value correlation. Emit a candidate-link
list with **raw per-signal scores** and a `hasSharedKey` flag. The deterministic join-candidate
detector computes evidence, it does not decide membership. It deliberately
scores customer-level overlap (email/company) as a *weak* signal, never as a shared key, because
customer-level overlap is exactly the over-merge trap.

```bash
node skills/reconstruct-value-stream/detect-join-candidates.mjs <input.json> <candidates.json>
```

### Phase 3 — Reconcile *(THE product; engine deterministic, semantic confirm LLM)*

Build journeys by **sequence linkage**, not set dedup: stage-and-time-ordered chain building
under a **cardinality guard** that splits rather than merges when a `max:1` bound would be
violated (the single corner that must not be cut). The mechanical guardrails live in
`reconcile.ts` (`reconcile()`), so the over-merge regression test can assert them deterministically.
On the live path, the `reconciler` agent makes the semantic calls the script cannot — is this column overlap a real
foreign key or coincidence, does this fuzzy match make business sense, is this 11-day gap a real
seam or a weekend — and assigns final confidence / classifies gaps. Output: `journeys[]` (with
tiered, explainable links), the first-class `gaps[]`, and the honest `ledger`.

### Phase 4 — Map stages *(LLM — `stage-mapper` agent)*

Assign each reconciled event a value-stream `stage` from the vertical config. The harness uses
the deterministic event-name → stage map (`buildEventStageMap`); the live path dispatches the
`stage-mapper` agent for events whose name doesn't match a
configured stage event. Also detect service gaps for the second axis (`detectServiceGaps`).

### Phase 5 — Diagnose *(deterministic — `diagnostics.ts`; LLM narration optional)*

Compute cycle time, true cost per stage (labor + allocated tooling + direct), FTE load,
bottlenecks (aggregated interval seams — bottlenecks are *not* a separate computation), and the
service-architecture diagnostics (tooling-cost-per-stage via the bridge, app-sprawl index,
vendor-concentration risk, spend-in-gaps). On the live path the `diagnostician` agent reads the
reconciled model and produces the same `Diagnostics` structure plus prose findings. Net-new axis;
see the supplement spec.

### Phase 6 — Assemble + review *(deterministic `validateModel`; LLM `model-reviewer` on `--review`)*

Assemble the `ValueStreamModel`, then validate it. `validateModel()` mechanically checks
referential integrity and the no-silent-drop invariants (every event in a journey or gap; every
service mapped or represented as a gap; ledger sums). On `--review`, the `model-reviewer` agent
additionally judges completeness and plausibility the mechanical
check can't — does the ledger look honest, are the journeys coherent, do the gaps make sense — and
renders approve/reject. Do not render a rejected model.

### Phase 7 — Render *(deterministic — `dashboard/render.mjs`)*

Generate `index.html` from the model only. EVENT view, STAGE view, and a service-architecture
layer; per-stage drill-down with the apps that power it and their cost; the honest ledger and the
spend-in-gaps list surfaced as visibly as the journeys.

---

## Incremental updates

The model is content-addressed by its sources. On a non-`--full` re-run with an existing
`model.json`: re-profile and re-normalize only sources whose file changed (by mtime/hash),
re-run candidate detection and reconciliation (linkage is global — a new source can re-link
existing orphans), recompute diagnostics, re-validate, re-render. Reconciliation is cheap at
these data scales (thousands of rows), so the incremental win is mostly in profiling /
normalization / agent dispatch, not the engine. Always re-validate before re-rendering.

---

## Running the deterministic harness vs. the live path

- **Harness (CI, demo, pressure test):** `npm run pipeline -- --vertical <id> --sources <dir>
  --out <dir>`. Deterministic, self-contained, fast, testable. This is what the over-merge
  regression tests and the three-scale pressure test run against.
- **Live agents:** add `--live`. Each `(LLM)`-marked phase dispatches its agent in `agents/`.
  Use this when the heuristic stand-ins are too crude for real, messy data — ambiguous event
  names, fuzzy matches that need business judgement, a unit of analysis that isn't the default.

The agents and the harness emit the same model contract by construction, so a model produced by
either path renders and validates identically.

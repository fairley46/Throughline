# Repo Structure — derived from Understand-Anything's actual layout

This is the recommended file structure for `throughline`, derived by studying the real
layout of `Lum1104/Understand-Anything` (UA) v2.7.7 installed locally. We mirror its
*architecture and division of labor*, not its domain. UA is a code→knowledge-graph tool;
we are the business-data→value-stream equivalent.

## What UA actually looks like (the parts we steal)

```
understand-anything/
  pnpm-workspace.yaml          # monorepo: packages/*
  package.json  vitest.config.ts  tsconfig.json
  packages/core/               # TS engine: parsers, persistence, schema, types
    src/{types.ts, schema.ts, ...}
  packages/dashboard/          # interactive render, reads persisted JSON
  skills/<name>/               # SKILL.md + deterministic .mjs/.py helper scripts
    understand/
      SKILL.md                 # the orchestrator: phases 0–7, dispatches agents
      scan-project.mjs         # deterministic structural extraction (no LLM)
      extract-structure.mjs    # deterministic
      extract-import-map.mjs   # deterministic cross-file edges  <-- our analogue target
      compute-batches.mjs      # deterministic batching
      merge-batch-graphs.py    # deterministic assembly
  agents/*.md                  # LLM agents (project-scanner, file-analyzer, graph-reviewer…)
```

The load-bearing pattern, verbatim from UA:

- **Deterministic scripts compute structure cheaply (no LLM).** `extract-import-map.mjs`
  finds cross-file edges; `file-analyzer` (LLM) interprets them.
- **LLM agents judge meaning only.** Each agent is a Markdown prompt in `agents/`.
- **A merge script assembles** batch outputs into one artifact.
- **A reviewer agent validates** before render.
- **The dashboard renders from persisted JSON**, never from raw input.
- Each `skills/<name>/` is a `SKILL.md` (the orchestration prose) plus the deterministic
  helpers it shells out to. Agents live one level up in `agents/`.
- `intermediate/` (UA calls it `.understand-anything/intermediate/`) is scratch, gitignored;
  the durable artifact (`knowledge-graph.json`) is committed/shared.

## Our structure

```
throughline/
  package.json                 # pnpm workspace root; scripts: build, test
  pnpm-workspace.yaml
  tsconfig.json  vitest.config.ts
  README.md  LICENSE
  .gitignore                   # already ignores node_modules/ dist/ intermediate/

  docs/
    BUILD_BRIEF.md
    STRUCTURE.md               # this file
    specs/2026-06-20-value-stream-reconciliation-design.md   # LOCKED design

  packages/
    core/                      # the TS engine (analogue of UA packages/core)
      src/
        model.ts               # the persisted JSON MODEL schema (zod) + TS types.
                               #   business analogue of UA's knowledge-graph.json schema:
                               #   events, journeys, gaps, ledger, stages, diagnostics.
        event-model.ts         # the common event model (normalization target) types
        verticals.ts           # vertical config types (stage order, cardinality, handoffs)
        reconcile.ts           # the reconciliation ENGINE (sequence linkage, stage+time
                               #   clustering, cardinality guard, tiered links, gaps).
                               #   Deterministic core the `reconciler` agent calls; keeping
                               #   it as testable TS (not buried in an .mjs) is what lets us
                               #   write the over-merge regression test.
        diagnostics.ts         # cycle time, cost/stage, FTE, bottlenecks from interval seams
        index.ts
        __tests__/
          reconcile.test.ts    # OVER-MERGE GUARD regression test (the required one)
          diagnostics.test.ts
    dashboard/                 # the render (analogue of UA packages/dashboard)
      views.mjs                # SHARED, environment-agnostic view builders (one source
                               #   of truth). Pure (model)->html string fns: LEDGER, STAGE,
                               #   SERVICE, GAPS, EVENT + the stage/journey DRILL-DOWN
                               #   builders, the shared STYLE, and CLIENT_SCRIPT (tab
                               #   switching + click-through). No node/DOM/fetch APIs, so
                               #   it renders server-side for the static file AND is shipped
                               #   verbatim to the browser for the served dashboard.
      render.mjs               # STATIC generator: builds out/index.html from views.mjs and
                               #   embeds the model + drill builders so click-through works
                               #   offline. The portable artifact (no server, no build).
      template.mjs             # the static page shell (wires views.mjs STYLE/CLIENT_SCRIPT
                               #   + embedded model into one self-contained HTML file).
      serve.mjs                # SERVED dashboard: token-gated localhost server (analogue of
                               #   UA's understand-dashboard Vite server). Binds 127.0.0.1,
                               #   prints `🔑 Dashboard URL: http://127.0.0.1:<PORT>/?token=`,
                               #   gates /model.json behind ?token= (403 without). Serves a
                               #   shell that fetches the model and renders the SAME views.mjs
                               #   builders client-side. Zero runtime deps (node:http+crypto).
                               #   `npm run dashboard` (default out/model.json, port 4317;
                               #   --model/--port or MODEL_PATH/PORT env to override).

  skills/
    value-stream-dashboard/
      SKILL.md                 # launch path mirroring UA's understand-dashboard: start the
                               #   token-gated server and report the tokenized URL. The served
                               #   counterpart to the portable static out/index.html.
    reconstruct-value-stream/
      SKILL.md                 # the orchestrator: phases mirroring UA's phase model
      detect-join-candidates.mjs   # DETERMINISTIC, no LLM. Our analogue of
                                   #   extract-import-map.mjs: column-value overlap,
                                   #   key normalization, temporal-window candidates,
                                   #   value correlation -> raw per-signal scores.
      profile-sources.mjs      # deterministic source profiling (cols, types, candidate
                               #   timestamps/cost/person) feeding source-profiler agent
      run-pipeline.mjs         # end-to-end deterministic runner (wires the deterministic
                               #   stages + a stub LLM-judgement so the pipeline is runnable
                               #   and testable without live agent dispatch). See note below.

  agents/                      # the seven LLM agents, each a Markdown prompt
    source-profiler.md
    event-normalizer.md
    unit-detector.md
    reconciler.md
    stage-mapper.md
    diagnostician.md
    model-reviewer.md

  verticals/                   # the per-vertical configs (2–3 + generic fallback)
    saas-implementation.json
    vehicle-service-bay.json
    generic.json

  examples/
    synthetic-saas/            # synthetic multi-source test data (the over-merge trap)
      crm-deals.csv
      billing-invoices.csv
      support-tickets.csv
    README.md

  intermediate/                # gitignored scratch (per-run); NOT durable output
  out/                         # gitignored; rendered HTML + model.json land here
```

## Rationale for the few places we deviate from UA

1. **`reconcile.ts` lives in `packages/core`, not as a `.mjs` in `skills/`.** UA's
   deterministic helpers are `.mjs` because their logic (tree-sitter resolution) is glue.
   Our reconciler is *the product* and the design spec demands an auditable over-merge
   guard with a regression test. Putting the engine in typed, unit-tested `core` (and
   keeping `detect-join-candidates.mjs` as the cheap evidence-gathering helper that mirrors
   `extract-import-map.mjs`) preserves UA's script/agent split while making the load-bearing
   part testable. The `reconciler` *agent* (LLM) still owns the semantic judgement; the
   engine owns the mechanical guardrails (stage+time ordering, cardinality split) that must
   not depend on an LLM being careful.

2. **`run-pipeline.mjs` exists as a runnable harness.** UA's `SKILL.md` is driven by a live
   agent runtime dispatching subagents per phase. To deliver a *runnable end-to-end* artifact
   (deliverable #3 and the synthetic-run proof) without a live agent loop, the deterministic
   stages are wired into one script. Where the real pipeline would call an LLM agent
   (`reconciler` semantic confirm, `stage-mapper` labelling), the script uses the
   vertical config + deterministic heuristics as the "agent judgement" stand-in, and emits
   the same model artifact the agents would. The `agents/*.md` files remain the authoritative
   spec of what each LLM step must do when run under a live runtime; the SKILL.md documents
   both paths. This mirrors UA's reality (deterministic scripts do the heavy lifting; the LLM
   adds judgement) while keeping the deliverable self-contained and CI-testable.

3. **`verticals/` is top-level.** UA folds language configs under the skill; our vertical
   configs are first-class product surface (the cardinality config is half of the over-merge
   fix per the locked spec), so they get a top-level directory the engine, agents, and tests
   all read.

## Open decisions (flagged for Brad — not blocking)

- **LLM-in-the-loop vs. deterministic stand-in.** `run-pipeline.mjs` runs the pipeline
  end-to-end deterministically (decision #2). The `reconciler` and other agents are written
  as full prompts but are not invoked by the runnable harness in this build. When wired to a
  live runtime, the agents replace the heuristic stand-ins. Chosen so the deliverable is
  self-contained and the over-merge guard is provable in CI. If you'd rather the harness shell
  out to `claude -p` per agent, that's a swap, not a rewrite.
- **Cardinality config format.** The spec left this open. Chosen schema (see
  `packages/core/src/verticals.ts` and `verticals/*.json`): per-vertical `stages[]` (ordered),
  and `cardinality` rules of the form `{ from, to, max, min }` where `max: 1` means "one
  `from` may attach at most one `to`" (the over-merge tripwire) and `max: "many"` allows
  fan-out. Conservative defaults; tune on real data.
- **Tier-2 thresholds.** Per spec, biased toward declaring a gap over asserting a weak link.
  Default promote-to-link threshold 0.55, below which a candidate becomes a `weak_link` gap.
  Constants centralized in `reconcile.ts` (`THRESHOLDS`) for tuning.
- **Product name.** Still `throughline`, placeholder. Naming pass owed.

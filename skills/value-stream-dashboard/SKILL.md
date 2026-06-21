---
name: value-stream-dashboard
description: Launch the interactive, token-gated localhost dashboard to explore a reconstructed value-stream model. Serves the click-through EVENT / STAGE / SERVICE-ARCHITECTURE views from a persisted model.json.
argument-hint: ["[--model <path>] [--port <n>]"]
---

# /value-stream-dashboard

Start the Throughline dashboard to explore a reconstructed value-stream model interactively.
This is the served, token-gated counterpart to the portable static `out/index.html`: it serves
the full click-through experience from a server bound to `127.0.0.1`,
reading **only** the persisted `model.json` (model-first; never the raw sources).

It runs a dependency-free `node:http` server that binds `127.0.0.1`, prints a tokenized URL, and
gates the model data behind a one-time token. The model is small and the views are pure HTML
strings, so a heavyweight bundler would be overkill. The token gate and `127.0.0.1`-only binding
are the load-bearing parts.

## Instructions

1. **Ensure a model exists.** The dashboard reads a persisted `model.json` (produced by
   `/reconstruct-value-stream` or `npm run demo`). Default location: `out/model.json`.
   If it does not exist, tell the user:
   ```
   No model found. Run `npm run demo` (or /reconstruct-value-stream) first.
   ```

2. **Start the server.** From the repo root:
   ```bash
   npm run dashboard                      # serves out/model.json on the default port (4317)
   # or point it at another model / port:
   node packages/dashboard/serve.mjs --model path/to/model.json --port 4400
   ```
   Model path resolution priority: `--model <path>` arg > `MODEL_PATH` env > default `out/model.json`.
   Port: `--port <n>` arg > `PORT` env > default `4317` (auto-increments if the port is busy).
   Run it in the background so the user can keep working.

3. **Capture the tokenized URL from the server output.** On start it prints:
   ```
     📊  throughline dashboard serving model: <abs path to model.json>
     🔑  Dashboard URL: http://127.0.0.1:<PORT>/?token=<TOKEN>
   ```
   Extract the full URL **including the `?token=` parameter**. The token is a one-time value
   generated per process start; it is required to fetch `/model.json`. Without it the dashboard
   shows an "Access Token Required" gate and `/model.json` returns HTTP 403.

4. **Report to the user, including the full tokenized URL:**
   ```
   Dashboard started at http://127.0.0.1:<PORT>/?token=<TOKEN>
   Viewing: <abs path to model.json>

   Running in the background. Press Ctrl+C in the terminal to stop it.
   ```
   **Always include `?token=`** — omit it and the user hits the token gate.

## What the dashboard shows (click-through)

- **Ledger** — the honest provenance split (reconstructed / inferred / could-not-connect),
  end-to-end median, and service spend. Click a journey to drill into its event chain + the
  tiered links (Tier-1 deterministic / Tier-2 probabilistic) holding it together, with the
  per-signal evidence.
- **Stages & cost** — the value-stream altitude: per-stage events, journeys, labor + allocated
  tooling = true cost, cycle time, actors. **Click a stage** to drill into its metrics, the
  apps powering it (the service-architecture bridge), the interval seams touching it, and the
  underlying source events that landed there.
- **Service architecture** — apps grouped by the stage they power, with cost / seat-utilization
  / category, orphan apps, and the app-sprawl index. Click a stage label to drill in.
- **Gaps & spend-in-gaps** — the spend flowing into orphan / underutilized / redundant services,
  surfaced as visibly as the journey ledger, plus value-stream gaps (interval seams, weak links,
  missing-expected-stage) — never silently dropped.
- **Events** — every normalized record (the substrate). Click a row to drill into its stage.

## Security model

- Binds `127.0.0.1` **only** — never `0.0.0.0`. No LAN / WiFi exposure.
- A one-time `crypto`-random token per process start (override with `THROUGHLINE_ACCESS_TOKEN`
  for deterministic CI/tests).
- `/model.json` requires `?token=<TOKEN>`; mismatch → HTTP 403. The HTML shell holds no data.

## Notes

- The static `out/index.html` remains the portable artifact (openable with no server, and it
  embeds the model so its click-through drill-down works offline too). The served dashboard is
  the richer option. Both render from the **same** shared view builders in
  `packages/dashboard/views.mjs` — one source of truth.
- If the default port is in use, the server auto-increments (up to 20 attempts) and prints the
  actual port in the URL.

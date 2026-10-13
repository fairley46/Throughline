---
name: verify-throughline
description: Drive the Throughline token-gated localhost dashboard and prove model-backed views load. Use when verifying demo, dashboard, or README quickstart behavior.
---

# Verify Throughline

Primary surface: the token-gated dashboard at `127.0.0.1` (`pnpm run dashboard`). Secondary: static `out/index.html` from `pnpm run demo`. No cloud deploy.

## Launch

From the repo root, with Node 20+ and pnpm:

```bash
corepack enable
pnpm install
pnpm run build
pnpm run demo
THROUGHLINE_ACCESS_TOKEN=verifytoken pnpm run dashboard -- --port 4317
```

Ready when stdout prints `Dashboard URL: http://127.0.0.1:4317/?token=verifytoken`.

Teardown: kill the node process you started for `packages/dashboard/serve.mjs` (by PID), not by name.

## Doctor

```bash
bash .cursor/skills/verify-throughline/scripts/doctor.sh
```

Expects HTTP 200 for `/?token=verifytoken` and `/model.json?token=verifytoken`, and HTTP 403 for `/model.json` without a token. Non-zero exit means do not drive.

## Drive

Prefer a real browser (CDP / computer-use) against `http://127.0.0.1:4317/?token=verifytoken`.

Stable handles:

- Brand text `Throughline` in the toolbar
- Tab labels from the model views: Map, Flow, Connections, Stages, Services, Gaps
- Search input in the search bar

HTTP-only smoke (no UI proof):

```bash
curl -sf "http://127.0.0.1:4317/model.json?token=verifytoken" | head -c 200
```

## Evidence

Proof standards:

- Exercise the user path: open the gated URL, wait for the model to render, switch at least one tab
- Capture action and result (token gate → loaded explorer), not only a final crop
- Keep side-effect proof: `out/model.json` exists after `pnpm run demo`

Write screenshots and recordings under `/opt/cursor/artifacts/` (or `docs/screenshots/` when committing a README image). Cleanup must not delete evidence.

## Cleanup

Stop only the dashboard PID from this run. Leave `out/` and `/opt/cursor/artifacts/` in place.

## Helpers

- `scripts/doctor.sh` — read-only health check for the local dashboard

# Throughline verification map

Maintained recipes for verifying user-facing Throughline behavior. Read this index, then open the matching feature file.

## Baseline preconditions

- Repo root has a built `@throughline/core` (`pnpm run build`) and a fresh demo model (`pnpm run demo` → `out/model.json`).
- Dashboard started with `THROUGHLINE_ACCESS_TOKEN=verifytoken` on port `4317`.
- `bash .cursor/skills/verify-throughline/scripts/doctor.sh` exits 0.
- Drive only an instance this run started.

## Driving conventions

- Open `http://127.0.0.1:4317/?token=verifytoken` for UI paths.
- Prefer visible tab labels and the `Throughline` brand over CSS selectors.
- Capture screenshots under `/opt/cursor/artifacts/`.

## Features

- [Load the explorer](./load-explorer.md) — gated URL loads the value-stream map from `model.json`.
- [Token gate](./token-gate.md) — `/model.json` rejects missing tokens with 403.
- [Demo pipeline](./demo-pipeline.md) — `pnpm run demo` writes `out/model.json` and `out/index.html`.

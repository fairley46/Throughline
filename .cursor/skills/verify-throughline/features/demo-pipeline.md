# Demo pipeline

`pnpm run demo` runs the reconstruction pipeline on `examples/synthetic-saas` and writes `out/model.json` plus `out/index.html`.

## Sub-features

- `demo-model` writes a validating `out/model.json`.
- `demo-html` writes `out/index.html` for offline viewing.

## How to get to it (user POV)

- From a built checkout, run `pnpm run demo` at the repo root.

## Driving it with shell

Preconditions:

- `pnpm install` and `pnpm run build` have succeeded.

- **Run demo.** `pnpm run demo`. Exit code `0`. Stdout includes `wrote` paths for `model.json` and `index.html`.
- **Confirm artifacts.** `test -f out/model.json && test -f out/index.html`.
- **Proof.** `wc -c out/model.json out/index.html` shows non-empty files; optional `open out/index.html` for a static view.

## Gotchas

- Demo imports `@throughline/core/dist`. Build before demo or the module resolve fails.
- `out/` is gitignored. Absence after a failed run is expected; re-run demo after fixing build.

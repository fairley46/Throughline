# Load the explorer

The dashboard loads the persisted value-stream model behind the token gate and shows the interactive explorer with the Throughline brand and view tabs.

## Sub-features

- `explorer-open` opens the gated URL and fetches `/model.json`.
- `explorer-brand` shows the Throughline brand in the toolbar.
- `explorer-tabs` exposes Map and supporting views (Flow, Connections, Stages, Services, Gaps).

## How to get to it (user POV)

- Run `pnpm run demo`, then `pnpm run dashboard`, and open the printed Dashboard URL.
- Or open `http://127.0.0.1:4317/?token=verifytoken` when the server was started with that token.

## Driving it with browser

Preconditions:

- Doctor passes on port 4317 with token `verifytoken`.
- `out/model.json` exists from the current demo run.

- **Open gated URL.** Navigate to `http://127.0.0.1:4317/?token=verifytoken`. The loading note clears and the explorer renders.
- **Confirm brand.** The toolbar shows `Throughline`.
- **Switch a tab.** Click `Gaps` (or another labeled tab). The active view content changes.
- **Proof.** Screenshot `/opt/cursor/artifacts/throughline-explorer.png` showing the brand and a populated view.

## Gotchas

- Without `?token=`, the shell loads but the model does not. That is the token-gate path, not explorer proof.
- A stale `out/model.json` from an older vertical can confuse visual expectations. Re-run `pnpm run demo` for the SaaS example.

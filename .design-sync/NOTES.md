# design-sync notes — Throughline

## Repo shape: NOT a component library (converter N/A)
Throughline's UI is HTML-string builders in `packages/dashboard/views.mjs` (+ `serve.mjs`,
`render.mjs`, `template.mjs`). There is no React/web-component library, no `dist/` of
renderable components, no Storybook. The `/design-sync` converter (which compiles a component
`dist/` into `_ds_bundle.js` for the Claude Design agent to build WITH) therefore does not apply.

## Chosen approach (2026-06-20): visual redesign + manual port-back
- Target project: "Design System" (projectId `019deb04-c6ab-7ee8-a925-f61e574e323b`).
- We pushed 14 hand-authored standalone preview cards (foundations / components / data / viz)
  extracted faithfully from the real `STYLE` + view markup in `views.mjs`. These are a visual
  "before" reference, not a renderable component bundle.
- Redesign happens in the Claude Design canvas (user-driven).
- Round-trip BACK: read the redesigned card files via `DesignSync(get_file)`, then port the new
  CSS / SVG into `packages/dashboard/views.mjs` (the single source of truth for both the static
  render and the token-gated localhost dashboard). Rebuild + restart servers to see it.

## If we ever want the full design-sync pipeline
Extract the dashboard UI into a real component library (React or web components) with a compiled
dist + Storybook. Then the converter applies and the design agent can build with real Throughline
components. Not done — flagged as the heavier option Brad deferred.

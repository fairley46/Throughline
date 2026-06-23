/**
 * render.mjs — model-first STATIC HTML generator (the portable artifact).
 *
 * Reads ONLY the persisted ValueStreamModel (never raw input). Produces a
 * single self-contained out/index.html: no server, no build step, openable by
 * double-click. Views are built by the shared, environment-agnostic builders in
 * views.mjs (one source of truth, shared with the served dashboard serve.mjs).
 *
 * The static file embeds the model (window.__MODEL__) and the drill builders
 * (window.__VIEWS__) so the click-through drill-down works offline too — the
 * served dashboard is the richer/token-gated path, this stays portable.
 *
 * Exposes renderModel(model) -> html string.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { page } from './template.mjs';
import { buildViews } from './views.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inline views.mjs as an ES module the browser can import via a blob/module
// script. We strip the node-only `import`/`export` and expose the drill
// builders on window.__VIEWS__ so CLIENT_SCRIPT can call them with no network.
function browserViewsModule() {
  const src = readFileSync(join(__dirname, 'views.mjs'), 'utf8');
  // Remove `export ` keywords so the file is a plain script, then hang the
  // builders we need at runtime off window.
  const stripped = src.replace(/^export\s+/gm, '');
  return `${stripped}
window.__VIEWS__ = {
  stageDrill: stageDrill, journeyDrill: journeyDrill,
  stageInfo: stageInfo, mapInfoDefault: mapInfoDefault, buildTour: buildTour,
  buildTabs: buildTabs, buildViews: buildViews, subtitleFor: subtitleFor,
  buildToolbar: buildToolbar, buildSearchBar: buildSearchBar
};`;
}

export function renderModel(model) {
  const views = buildViews(model);
  return page({
    title: 'throughline — value-stream + service-architecture',
    views,
    model,
    viewsModule: browserViewsModule(),
  });
}

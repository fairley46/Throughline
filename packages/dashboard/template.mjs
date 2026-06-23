/**
 * template.mjs — the HTML page shell for the STATIC artifact.
 *
 * Styles + view markup come from the shared views.mjs (one source of truth with
 * the served dashboard). This shell wires the page together and embeds the model
 * + drill builders so the click-through drill-down works in the offline file.
 *
 * The served dashboard (serve.mjs) uses the same STYLE / CLIENT_SCRIPT but
 * fetches the model from a token-gated endpoint instead of inlining it.
 */

import { STYLE, CLIENT_SCRIPT, esc, buildToolbar, buildSearchBar } from './views.mjs';

// Re-export formatting helpers for any legacy callers.
export { esc, money, days } from './views.mjs';
export { STYLE } from './views.mjs';

export function page({ title, views, model, viewsModule }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>
<div class="toolbar" id="toolbar">${buildToolbar(model)}</div>
${buildSearchBar()}
<div id="views">${views}</div>
<div class="drill-overlay" id="drill-overlay"><div class="drill-panel" id="drill-body"></div></div>
<script>window.__MODEL__ = ${JSON.stringify(model)};</script>
<script>${viewsModule}</script>
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}

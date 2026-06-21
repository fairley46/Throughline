/**
 * serve.mjs — token-gated localhost dashboard server.
 *
 * Instead of static out/index.html, this serves the full interactive
 * click-through dashboard from a server bound to 127.0.0.1, gated by a one-time
 * access token printed to the terminal:
 *
 *   🔑  Dashboard URL: http://127.0.0.1:<PORT>/?token=<TOKEN>
 *
 * Security model:
 *   - bind 127.0.0.1 ONLY (never 0.0.0.0) — no LAN exposure.
 *   - a one-time crypto token generated per process start.
 *   - the data endpoint /model.json requires ?token=<TOKEN>, else HTTP 403.
 *
 * It reads ONLY the persisted ValueStreamModel (model-first). The model path is
 * resolved via (priority): --model <path> arg, MODEL_PATH env, then the default
 * out/model.json relative to the repo root. The views are the SAME shared
 * builders the static render uses (packages/dashboard/views.mjs), so there is
 * one source of truth for both the portable file and the served dashboard.
 *
 * Zero runtime dependencies — node:http + node:crypto only. The model is small
 * and the views are pure HTML strings, so a tiny http server is the cleaner fit
 * and keeps the package dependency-free.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { STYLE, CLIENT_SCRIPT } from './views.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---- resolve the model path (arg > env > default) ---------------------------
function resolveModelPath() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--model');
  let p = i !== -1 && argv[i + 1] ? argv[i + 1] : process.env.MODEL_PATH || join(REPO_ROOT, 'out', 'model.json');
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

const MODEL_PATH = resolveModelPath();
const HOST = '127.0.0.1';
const BASE_PORT = (() => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--port');
  const fromArg = i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : NaN;
  return fromArg || Number(process.env.PORT) || 4317;
})();
// One-time access token (override via env for deterministic tests/CI).
const ACCESS_TOKEN = process.env.THROUGHLINE_ACCESS_TOKEN || randomBytes(16).toString('hex');

// The browser-side views module: strip node import/export, expose drill
// builders + subtitle/tabs/views builders on window.__VIEWS__.
function browserViewsModule() {
  const src = readFileSync(join(__dirname, 'views.mjs'), 'utf8');
  const stripped = src.replace(/^export\s+/gm, '');
  return `${stripped}
window.__VIEWS__ = {
  stageDrill: stageDrill, journeyDrill: journeyDrill,
  buildTabs: buildTabs, buildViews: buildViews, subtitleFor: subtitleFor
};`;
}

// The served HTML shell. Unlike the static file it does NOT inline the model;
// it fetches /model.json?token=... (the token gate) and renders client-side.
function shellHtml() {
  const viewsModule = browserViewsModule();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>throughline — value-stream + service-architecture</title><style>${STYLE}</style></head>
<body>
<header><h1>throughline — value-stream + service-architecture</h1><div class="sub" id="sub">loading model…</div></header>
<div class="tabs" id="tabs"></div>
<div id="views"><div class="view active" style="padding:24px 28px"><div class="note" id="status">Loading model from the token-gated endpoint…</div></div></div>
<div class="drill-overlay" id="drill-overlay"><div class="drill-panel" id="drill-body"></div></div>
<script>${viewsModule}</script>
<script>
(function(){
  var token = new URLSearchParams(location.search).get('token') || '';
  if(!token){ gate('Access Token Required', 'Paste the access token from your terminal. Look for the 🔑 line, then reload with ?token=<TOKEN>.'); return; }
  fetch('/model.json?token=' + encodeURIComponent(token)).then(function(r){
    if(r.status === 403){ gate('Invalid token', 'The token did not match. Copy the 🔑 Dashboard URL from the terminal exactly.'); return null; }
    if(!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function(model){
    if(!model) return;
    window.__MODEL__ = model;
    document.getElementById('sub').innerHTML = window.subtitleFor(model);
    document.getElementById('tabs').innerHTML = window.buildTabs();
    document.getElementById('views').innerHTML = window.buildViews(model);
  }).catch(function(e){
    document.getElementById('status').textContent = 'Failed to load model: ' + e.message;
  });
  function gate(title, msg){
    document.getElementById('views').innerHTML =
      '<div class="view active" style="padding:48px 28px;max-width:560px;margin:0 auto;text-align:center">'
      + '<div class="section">' + title + '</div><div class="note">' + msg + '</div></div>';
  }
})();
</script>
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}

function send(res, status, type, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(body);
}

function loadModel() {
  if (!existsSync(MODEL_PATH)) return null;
  try {
    return readFileSync(MODEL_PATH, 'utf8');
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const pathname = url.pathname;

  // The single protected data endpoint — the token gate, mirrored from UA.
  if (pathname === '/model.json') {
    if (url.searchParams.get('token') !== ACCESS_TOKEN) {
      send(res, 403, 'application/json', JSON.stringify({ error: 'Forbidden: missing or invalid token' }));
      return;
    }
    const raw = loadModel();
    if (raw == null) {
      send(
        res,
        404,
        'application/json',
        JSON.stringify({ error: `No model found at ${MODEL_PATH}. Run \`npm run demo\` first.` }),
      );
      return;
    }
    send(res, 200, 'application/json', raw);
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    // The shell is unprotected (it holds no data); the model behind it is gated.
    send(res, 200, 'text/html; charset=utf-8', shellHtml());
    return;
  }

  send(res, 404, 'text/plain', 'Not found');
});

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`[throughline] server error: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/?token=${ACCESS_TOKEN}`;
    console.log(`\n  📊  throughline dashboard serving model: ${MODEL_PATH}`);
    console.log(`  🔑  Dashboard URL: ${url}\n`);
    console.log('  Token-gated on 127.0.0.1. Requests to /model.json without ?token= get 403.');
    console.log('  Press Ctrl+C to stop.\n');
  });
}

listen(BASE_PORT, 20);

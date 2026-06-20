/**
 * template.mjs — self-contained HTML/CSS/JS string templates for the render.
 *
 * Analogue of UA packages/dashboard: the render reads ONLY the persisted model
 * (model-first; never raw input). Everything is inlined into one HTML file so an
 * output is openable with no server and no build step.
 */

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function money(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function days(ms) {
  if (ms == null) return '—';
  return (ms / 86400000).toFixed(1) + 'd';
}

export const STYLE = `
:root {
  --bg:#0b0f17; --panel:#141b2a; --panel2:#1b2438; --ink:#e7ecf5; --muted:#8b97ad;
  --line:#26304a; --good:#16a34a; --warn:#d97706; --bad:#dc2626; --accent:#3b82f6;
}
* { box-sizing:border-box; }
body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--ink); }
header { padding:20px 28px; border-bottom:1px solid var(--line); }
h1 { margin:0; font-size:20px; }
.sub { color:var(--muted); font-size:13px; margin-top:4px; }
.tabs { display:flex; gap:6px; padding:14px 28px 0; border-bottom:1px solid var(--line); flex-wrap:wrap; }
.tab { padding:8px 14px; border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0;
  background:var(--panel); color:var(--muted); cursor:pointer; font-weight:600; }
.tab.active { background:var(--panel2); color:var(--ink); }
.view { display:none; padding:24px 28px; }
.view.active { display:block; }
.cards { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:20px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 18px; min-width:150px; }
.card .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.card .v { font-size:22px; font-weight:700; margin-top:4px; }
.ledger-bar { display:flex; height:30px; border-radius:8px; overflow:hidden; border:1px solid var(--line); margin:8px 0 18px; }
.ledger-bar div { display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#fff; }
.seg-r { background:var(--good); } .seg-i { background:var(--warn); } .seg-o { background:var(--bad); }
table { width:100%; border-collapse:collapse; font-size:13px; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; position:sticky; top:0; background:var(--panel2); }
tr:hover td { background:rgba(59,130,246,.06); }
.pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; }
.p-recon { background:rgba(22,163,74,.18); color:#5ee08a; }
.p-inf { background:rgba(217,119,6,.18); color:#f0b860; }
.p-orph { background:rgba(220,38,38,.18); color:#f08a8a; }
.tier1 { color:#5ee08a; } .tier2 { color:#f0b860; }
.stage-dot { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; vertical-align:middle; }
.section { margin:26px 0 10px; font-size:15px; font-weight:700; }
.note { color:var(--muted); font-size:12px; margin:4px 0 14px; }
details { background:var(--panel); border:1px solid var(--line); border-radius:10px; margin:8px 0; padding:4px 12px; }
summary { cursor:pointer; font-weight:600; padding:8px 0; }
.gap-orphan_service,.gap-orphan { border-left:3px solid var(--bad); }
.gap-underutilized_service { border-left:3px solid var(--warn); }
.gap-redundant_service { border-left:3px solid var(--accent); }
.gap-interval_seam { border-left:3px solid var(--warn); }
.warn { color:var(--warn); } .bad { color:var(--bad); } .good { color:var(--good); }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
.bar { height:8px; border-radius:4px; background:var(--accent); }
.kvs { display:flex; gap:18px; flex-wrap:wrap; color:var(--muted); font-size:12px; }
.right { text-align:right; }
`;

export const SCRIPT = `
function showView(id, el){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
}
`;

export function page({ title, subtitle, tabs, views }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>
<header><h1>${esc(title)}</h1><div class="sub">${subtitle}</div></header>
<div class="tabs">${tabs}</div>
${views}
<script>${SCRIPT}</script>
</body></html>`;
}

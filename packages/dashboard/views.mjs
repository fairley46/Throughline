/**
 * views.mjs — shared, environment-agnostic view builders.
 *
 * One source of truth for the dashboard's views, used by BOTH:
 *   - render.mjs   (static, server-side -> out/index.html, no server/build)
 *   - serve.mjs    (served, token-gated localhost; ships these same builders
 *                   to the browser so the click-through drill-down reads the
 *                   in-memory model without round-tripping to the server)
 *
 * Every function here is pure: (model, ...) -> html string. They read ONLY the
 * persisted ValueStreamModel (model-first; never raw input). No DOM, no fetch,
 * no node APIs — so the exact same code renders on the server for the portable
 * artifact and runs in the browser for the interactive dashboard.
 *
 * The visual language is Throughline "Executive Map": a dark, premium node-map.
 * The flagship view is the MAP explorer (mapView) — a pan/zoom graph canvas of
 * stage node cards inside dashed cluster frames, curved labeled flow edges, and
 * ember-glow bottleneck seams, with a right-hand INFO/TOUR panel, a minimap, a
 * fuzzy search bar, filter chips and category cards. The other tabs (Flow,
 * Connections, Stages, Services, Gaps) reuse the prior builders, restyled to the
 * same token system.
 *
 * The interactivity layer (tab switching, pan/zoom, search, filters, tour,
 * click-through drill-down) is the CLIENT_SCRIPT string at the bottom.
 */

// ---- formatting helpers (duplicated tiny, so this file has zero imports and
// can be shipped to the browser verbatim) -------------------------------------
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
function daysInt(ms) {
  if (ms == null) return '—';
  return Math.round(ms / 86400000) + 'd';
}

function stageColor(model, id) {
  return model.stages.find((s) => s.id === id)?.color ?? '#64748b';
}
function stageLabel(model, id) {
  return model.stages.find((s) => s.id === id)?.label ?? id ?? '—';
}
function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// =============================================================================
// MAP graph helpers — shared geometry/derivation used by the canvas + the tour.
// These are pure and run identically on server and browser. The browser also
// re-derives some of this for the live INFO panel and minimap.
// =============================================================================

/** Transition counts between distinct consecutive stages along journeys. */
function deriveTransitions(model) {
  const idx = new Map(model.stages.map((s) => [s.id, true]));
  const byId = new Map(model.events.map((e) => [e.event_id, e]));
  const transitions = new Map(); // "from|to" -> count
  for (const j of model.journeys) {
    let prev = null;
    for (const id of j.event_ids) {
      const e = byId.get(id);
      if (!e || !idx.has(e.stage)) continue;
      const st = e.stage;
      if (prev != null && prev !== st) {
        const k = prev + '|' + st;
        transitions.set(k, (transitions.get(k) || 0) + 1);
      }
      prev = st;
    }
  }
  return transitions;
}

/** Bucket stages into named cluster phases (early / mid / late) by order. */
function deriveClusters(model) {
  const stages = model.stages.slice().sort((a, b) => a.order - b.order);
  const n = stages.length;
  if (n === 0) return [];
  // Three sensible phases for a value stream. With few stages, collapse.
  const phases =
    n <= 3
      ? [{ name: 'Value stream', ids: stages.map((s) => s.id) }]
      : [
          { name: 'Acquire', ids: [] },
          { name: 'Fulfil', ids: [] },
          { name: 'Retain', ids: [] },
        ];
  if (phases.length === 1) return phases;
  const a = Math.ceil(n / 3);
  const b = Math.ceil((2 * n) / 3);
  stages.forEach((s, i) => {
    if (i < a) phases[0].ids.push(s.id);
    else if (i < b) phases[1].ids.push(s.id);
    else phases[2].ids.push(s.id);
  });
  return phases.filter((p) => p.ids.length);
}

// =============================================================================
// MAP view — the flagship graph explorer (the default tab).
//
// Layout: stages laid left->right by order as node cards, grouped into dashed
// cluster frames. Curved bezier flow edges (width ∝ journey count) connect
// consecutive stages a journey traverses; bottleneck seams (diagnostics) are
// drawn as ember dashed glowing edges labeled with median unowned days.
//
// One .map-world div holds an SVG (cluster frames + flow/seam edges, in world
// coords) AND absolutely-positioned HTML node cards in the SAME coords; a single
// CSS transform on .map-world pans/zooms both together (no foreignObject — that
// detaches under WebKit). Nodes carry data-* hooks so the INFO/TOUR panel +
// search + filters can act on them.
// =============================================================================
export function mapView(model) {
  const stages = model.stages.slice().sort((a, b) => a.order - b.order);
  const idx = new Map(stages.map((s, i) => [s.id, i]));
  const sdById = new Map(model.diagnostics.stages.map((s) => [s.stage, s]));
  const svcPerStage = new Map((model.diagnostics.services?.perStage ?? []).map((s) => [s.stage, s]));
  const transitions = deriveTransitions(model);
  const clusters = deriveClusters(model);

  // forward bottleneck seams keyed for edge styling.
  const bnEdge = new Map();
  const bnSelf = new Map();
  for (const b of model.diagnostics.bottlenecks) {
    if (b.stage_from === b.stage_to) {
      if (idx.has(b.stage_from)) bnSelf.set(b.stage_from, b);
    } else {
      bnEdge.set(b.stage_from + '|' + b.stage_to, b);
    }
  }

  // ---- geometry -------------------------------------------------------------
  const NW = 192, NH = 126, GAPX = 132, PADX = 96, PADY = 132;
  const W = PADX * 2 + stages.length * NW + Math.max(0, stages.length - 1) * GAPX;
  const H = PADY + NH + 188;
  const nodeY = PADY;
  const nodeX = (i) => PADX + i * (NW + GAPX);
  const cx = (i) => nodeX(i) + NW / 2;

  const maxCount = Math.max(1, ...transitions.values());
  const strokeFor = (n) => 2 + (n / maxCount) * 12;

  // status color per stage: red if it sits on the worst inbound bottleneck,
  // gold if it has any seam, blue otherwise (healthy flow). reconstructed-heavy
  // stages lean green.
  const worstBn = model.diagnostics.bottlenecks
    .filter((b) => b.stage_from !== b.stage_to)
    .slice()
    .sort((a, b) => b.medianIntervalMs - a.medianIntervalMs)[0];
  const seamStages = new Set();
  for (const b of model.diagnostics.bottlenecks) {
    if (b.stage_from !== b.stage_to) {
      seamStages.add(b.stage_to);
    }
  }
  function statusOf(id) {
    if (worstBn && (worstBn.stage_to === id || worstBn.stage_from === id)) return 'red';
    if (seamStages.has(id) || bnSelf.has(id)) return 'gold';
    return 'blue';
  }
  const STATUS = { blue: '#6aa0ff', gold: '#e3c27e', red: '#e06a6a', green: '#5ee0a0' };

  // ---- cluster frames (drawn first, behind everything) ----------------------
  let frames = '';
  for (const c of clusters) {
    const is = c.ids.map((id) => idx.get(id)).filter((i) => i != null);
    if (!is.length) continue;
    const lo = Math.min(...is), hi = Math.max(...is);
    const fx = nodeX(lo) - 34;
    const fw = nodeX(hi) + NW + 34 - fx;
    const fy = nodeY - 56;
    const fh = NH + 112;
    frames += `<g class="cluster-frame">
      <rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="22"
        fill="rgba(20,29,51,0.35)" stroke="var(--blue)" stroke-opacity="0.28"
        stroke-width="1.4" stroke-dasharray="2 8" stroke-linecap="round"/>
      <text x="${fx + 18}" y="${fy + 26}" class="cluster-label">${esc(c.name.toUpperCase())}</text>
    </g>`;
  }

  // ---- edges (under nodes) --------------------------------------------------
  let edges = '';
  const labelSpecs = [];
  for (const [k, count] of transitions) {
    const [from, to] = k.split('|');
    const i = idx.get(from), j = idx.get(to);
    if (i == null || j == null) continue;
    const bn = bnEdge.get(k);
    const back = j < i;
    const sw = strokeFor(count);
    let path, lx, ly;
    if (back) {
      const sx = cx(i), ex = cx(j);
      const dip = nodeY + NH + 96;
      path = `M ${sx} ${nodeY + NH} C ${sx} ${dip}, ${ex} ${dip}, ${ex} ${nodeY + NH}`;
      lx = (sx + ex) / 2; ly = dip - 6;
    } else {
      const x1 = nodeX(i) + NW, y1 = nodeY + NH / 2;
      const x2 = nodeX(j), y2 = nodeY + NH / 2;
      const mx = (x1 + x2) / 2;
      path = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      lx = mx; ly = y1 - 14;
    }
    const tip = bn
      ? `${stageLabel(model, from)} → ${stageLabel(model, to)} · ${count} journeys · BOTTLENECK ${daysInt(bn.medianIntervalMs)} unowned (${bn.occurrences}×)`
      : `${stageLabel(model, from)} → ${stageLabel(model, to)} · ${count} journeys`;
    if (bn) {
      edges += `<path class="edge edge-seam" data-from="${esc(from)}" data-to="${esc(to)}" d="${path}" fill="none"
        stroke="var(--red)" stroke-width="${Math.max(2.4, sw * 0.7).toFixed(1)}" stroke-dasharray="7 6"
        stroke-linecap="round" filter="url(#emberGlow)"><title>${esc(tip)}</title></path>`;
      labelSpecs.push({ lx, ly, half: 52, kind: 'seam', text: `${daysInt(bn.medianIntervalMs)} unowned`, from, to });
    } else {
      edges += `<path class="edge edge-flow" data-from="${esc(from)}" data-to="${esc(to)}" d="${path}" fill="none"
        stroke="var(--blue)" stroke-width="${sw.toFixed(1)}" stroke-opacity="0.5" stroke-linecap="round"><title>${esc(tip)}</title></path>`;
      if (count > 1) labelSpecs.push({ lx, ly, half: 14, kind: 'flow', text: String(count), from, to });
    }
  }
  // Place edge labels with vertical staggering so overlapping seams/counts never collide.
  labelSpecs.sort((a, b) => a.lx - b.lx);
  const placedLabels = [];
  let edgeLabels = '';
  for (const s of labelSpecs) {
    let row = 0, y = s.ly;
    while (row < 7 && placedLabels.some((p) => Math.abs(p.x - s.lx) < p.half + s.half + 8 && Math.abs(p.y - y) < 22)) {
      row++; y = s.ly - row * 24;
    }
    placedLabels.push({ x: s.lx, y, half: s.half });
    if (s.kind === 'seam') {
      edgeLabels += `<g class="edge-label seam-label" data-from="${esc(s.from)}" data-to="${esc(s.to)}">
        <rect x="${(s.lx - 52).toFixed(1)}" y="${(y - 22).toFixed(1)}" width="104" height="20" rx="10" fill="#1a0e12" stroke="var(--red)" stroke-opacity="0.5"/>
        <text x="${s.lx.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" fill="var(--red)" font-size="11" font-weight="700">${esc(s.text)}</text></g>`;
    } else {
      edgeLabels += `<g class="edge-label flow-label" data-from="${esc(s.from)}" data-to="${esc(s.to)}">
        <rect x="${(s.lx - 13).toFixed(1)}" y="${(y - 13).toFixed(1)}" width="26" height="16" rx="8" fill="var(--panel)" stroke="var(--line)"/>
        <text x="${s.lx.toFixed(1)}" y="${(y - 1).toFixed(1)}" text-anchor="middle" fill="var(--muted)" font-size="10" font-weight="600">${esc(s.text)}</text></g>`;
    }
  }

  // ---- node cards (HTML, absolutely positioned in WORLD coordinates) --------
  // Cards are real HTML <div>s, not SVG <foreignObject>. They live in the same
  // CSS-transformed .map-world as the SVG edges, so a single transform scales
  // both together — no detachment (the WebKit foreignObject bug is gone) and
  // CSS contains every line of text at any zoom.
  let nodes = '';
  stages.forEach((s, i) => {
    const sd = sdById.get(s.id) || { eventCount: 0, journeyCount: 0, medianCycleMs: null };
    const ss = svcPerStage.get(s.id);
    const x = nodeX(i), y = nodeY;
    const status = statusOf(s.id);
    const col = STATUS[status];
    const sources = [...new Set(model.events.filter((e) => e.stage === s.id).map((e) => e.source ?? '—'))];
    const cluster = (clusters.find((c) => c.ids.includes(s.id)) || { name: '' }).name;
    const metric =
      ss && ss.trueCost
        ? money(ss.trueCost)
        : sd.medianCycleMs != null
        ? days(sd.medianCycleMs)
        : sd.eventCount + ' events';
    const metricLabel = ss && ss.trueCost ? 'true cost' : sd.medianCycleMs != null ? 'cycle → next' : 'volume';
    const reworkBadge = bnSelf.has(s.id)
      ? (() => {
          const sb = bnSelf.get(s.id);
          return `<span class="node-rework" title="${esc(s.label + ' rework seam · ' + daysInt(sb.medianIntervalMs) + ' unowned (' + sb.occurrences + '×)')}">↻</span>`;
        })()
      : '';
    nodes += `<div class="node-card" data-node="stage" data-id="${esc(s.id)}"
        data-sources="${esc(sources.join(','))}" data-status="${status}"
        data-search="${esc((s.label + ' ' + s.id).toLowerCase())}"
        data-cx="${cx(i)}" data-cy="${y + NH / 2}" tabindex="0" role="button"
        aria-label="${esc(s.label)} stage"
        title="${esc(s.label + ' — ' + sd.eventCount + ' events, ' + sd.journeyCount + ' journeys (click for detail)')}"
        style="left:${x}px;top:${y}px;width:${NW}px;height:${NH}px;--node-accent:${col}">
      <div class="node-eyebrow">STAGE · ${esc(cluster.toUpperCase())}</div>
      <div class="node-title">${esc(s.label)}</div>
      <div class="node-metric">${esc(metric)}</div>
      <div class="node-metric-label">${esc(metricLabel)} · ${sd.journeyCount} journeys</div>
      ${reworkBadge}
    </div>`;
  });

  // Minimap node rects (drawn server-side; the minimap SVG is a static W×H
  // schematic of frames + edges + node blocks, with a live viewport overlay).
  let miniNodes = '';
  stages.forEach((s, i) => {
    const col = STATUS[statusOf(s.id)];
    miniNodes += `<rect x="${nodeX(i)}" y="${nodeY}" width="${NW}" height="${NH}" rx="14" fill="${col}" fill-opacity="0.85"/>`;
  });

  const defs = `<defs>
    <filter id="emberGlow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="3.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

  // The SVG holds ONLY frames + edges (no nodes), sized to the full world W×H
  // in 1:1 world units. Both it and the HTML node cards are children of
  // .map-world, which CLIENT_SCRIPT pans/zooms with a single CSS transform
  // (transform-origin:0 0). Default load = Fit, computed in screen↔world space.
  const svg = `<svg class="map-edges" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
      font-family="-apple-system,Segoe UI,Roboto,sans-serif" aria-hidden="true"
      style="position:absolute;left:0;top:0;width:${W}px;height:${H}px">
      ${defs}
      ${frames}${edges}${edgeLabels}
    </svg>`;

  const world = `<div class="map-world" id="map-world" data-w="${W}" data-h="${H}"
      style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0">
      ${svg}
      ${nodes}
    </div>`;

  // ---- chrome inside the map view: filter chips, info/tour panel, minimap,
  //      category cards. The toolbar + search live in the page shell. ---------
  const sources = [...new Set(model.events.map((e) => e.source ?? '—'))].sort();
  const sourcePal = sourcePalette(model);
  const sourceChips = sources
    .map(
      (s) =>
        `<button class="chip" data-chip="source" data-val="${esc(s)}" style="--chip:${sourcePal.get(s)}">
          <span class="chip-dot"></span>${esc(s)}</button>`,
    )
    .join('');
  const statusChips = [
    ['blue', 'Healthy flow', STATUS.blue],
    ['gold', 'Watch', STATUS.gold],
    ['red', 'Decision / seam', STATUS.red],
  ]
    .map(
      ([v, label, col]) =>
        `<button class="chip" data-chip="status" data-val="${v}" style="--chip:${col}">
          <span class="chip-dot"></span>${label}</button>`,
    )
    .join('');

  const filterBar = `<div class="map-filters">
    <span class="filter-group-label">SOURCE</span>${sourceChips}
    <span class="filter-divider"></span>
    <span class="filter-group-label">STATUS</span>${statusChips}
  </div>`;

  // category cards — service categories with counts + spend.
  const catCards = buildCategoryCards(model);

  // info panel default state.
  const infoDefault = mapInfoDefault(model);

  const minimap = `<div class="minimap" id="minimap" aria-hidden="true">
    <svg id="minimap-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">${frames}${edges}${miniNodes}</svg>
    <div class="minimap-viewport" id="minimap-viewport"></div>
  </div>`;

  const zoomCtl = `<div class="zoom-ctl" role="group" aria-label="Zoom controls">
    <button class="zoom-btn" id="zoom-out" aria-label="Zoom out">−</button>
    <button class="zoom-btn" id="zoom-in" aria-label="Zoom in">+</button>
    <button class="zoom-btn zoom-fit" id="zoom-fit" aria-label="Fit to screen">FIT</button>
  </div>`;

  return `<div class="view active map-view" id="v-map">
    ${filterBar}
    <div class="map-stage">
      <div class="map-canvas-wrap" id="map-canvas-wrap" tabindex="0" aria-label="Map canvas — drag to pan, scroll to zoom">
        ${world}
        ${zoomCtl}
        ${minimap}
      </div>
      <aside class="info-panel" id="info-panel" aria-live="polite">${infoDefault}</aside>
    </div>
    ${catCards}
  </div>`;
}

/** Default INFO-panel content (before any node is selected). */
export function mapInfoDefault(model) {
  const l = model.ledger;
  const d = model.diagnostics;
  const spend = d.services?.spendInGapsMonthly ?? 0;
  return `<div class="info-eyebrow">EXECUTIVE MAP</div>
    <div class="info-title">${esc(model.meta.vertical)}</div>
    <div class="info-sub">${model.events.length} events · ${model.journeys.length} journeys · ${model.stages.length} stages</div>
    <div class="info-headline-cards">
      <div class="info-hc"><div class="ihc-v" style="color:var(--green)">${l.pct_reconstructed}%</div><div class="ihc-k">reconstructed</div></div>
      <div class="info-hc"><div class="ihc-v">${days(d.endToEndMedianMs)}</div><div class="ihc-k">end-to-end median</div></div>
      <div class="info-hc"><div class="ihc-v" style="color:var(--red)">${money(spend)}</div><div class="ihc-k">spend in gaps / mo</div></div>
    </div>
    <p class="info-body">Click any stage node to inspect its true cost, the records that landed there, the apps powering it, and the seams that touch it. Or take the guided tour.</p>
    <button class="tour-start" id="tour-start">▶ Start guided tour</button>
    <div class="info-hint">Drag to pan · scroll to zoom · type in the search bar to highlight nodes.</div>`;
}

/** Service-category cards along the bottom of the map. */
function buildCategoryCards(model) {
  if (!model.services?.length) {
    return `<div class="cat-cards"><div class="cat-card"><div class="cat-name">No service inventory</div><div class="cat-meta">—</div></div></div>`;
  }
  const byCat = new Map();
  for (const s of model.services) {
    if (!byCat.has(s.category)) byCat.set(s.category, { count: 0, cost: 0 });
    const c = byCat.get(s.category);
    c.count++;
    c.cost += s.monthly_cost || 0;
  }
  const cards = [...byCat.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 8)
    .map(
      ([cat, c], i) =>
        `<button class="cat-card" data-chip="category" data-val="${esc(cat)}">
          <div class="cat-name"><span class="cat-dot" style="background:${SOURCE_PALETTE[i % SOURCE_PALETTE.length]}"></span>${esc(cat.replace(/_/g, ' '))}</div>
          <div class="cat-meta"><span class="cat-count">${c.count}</span> apps · ${money(c.cost)}/mo</div>
        </button>`,
    )
    .join('');
  return `<div class="cat-cards"><div class="cat-cards-label">SERVICE CATEGORIES</div>${cards}</div>`;
}

// =============================================================================
// LEDGER content (kept as a helper; surfaced inside the map info default and
// available for the tour). Not its own tab anymore.
// =============================================================================

// =============================================================================
// STAGE view (value-stream altitude). Stage rows are click-through.
// =============================================================================
export function stageView(model) {
  const d = model.diagnostics;
  const svcPerStage = new Map((d.services?.perStage ?? []).map((s) => [s.stage, s]));

  const rows = d.stages
    .map((sd) => {
      const ss = svcPerStage.get(sd.stage);
      const concentration =
        ss?.singleVendor && ss.toolingCost > 0
          ? `<span class="warn"> ⚠ single-vendor (${esc(ss.vendors[0])})</span>`
          : '';
      return `<tr class="clickable" data-drill="stage" data-id="${esc(sd.stage)}">
        <td><span class="stage-dot" style="background:${stageColor(model, sd.stage)}"></span>${esc(sd.label)}</td>
        <td class="right">${sd.eventCount}</td>
        <td class="right">${sd.journeyCount}</td>
        <td class="right">${money(ss?.laborCost ?? sd.totalCost)}</td>
        <td class="right">${money(ss?.toolingCost ?? 0)}</td>
        <td class="right"><b>${money(ss?.trueCost ?? sd.totalCost)}</b></td>
        <td>${days(sd.medianCycleMs)}</td>
        <td>${sd.actors.length} ${concentration}</td>
        <td class="note">drill ▸</td>
      </tr>`;
    })
    .join('');

  const bottlenecks = d.bottlenecks
    .map(
      (b) => `<tr>
      <td>${esc(stageLabel(model, b.stage_from))} → ${esc(stageLabel(model, b.stage_to))}</td>
      <td class="right">${b.occurrences}</td>
      <td class="right warn">${days(b.medianIntervalMs)}</td>
      <td class="right">${days(b.maxIntervalMs)}</td></tr>`,
    )
    .join('');

  return `<div class="view" id="v-stage">
    <div class="section">Cost per stage — labor + tooling = true cost</div>
    <div class="note">Tooling cost is allocated from the service inventory via each service's stages_served bridge (monthly_cost / #stages served). Click a stage to drill into its metrics, the records that landed there, the underlying source events, and the spend powering it.</div>
    <table><thead><tr><th>Stage</th><th class="right">Events</th><th class="right">Journeys</th>
      <th class="right">Labor</th><th class="right">Tooling/mo</th><th class="right">True cost</th><th>Cycle→next</th><th>Actors</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
    <div class="section">Bottlenecks = aggregated interval seams</div>
    <div class="note">Invisible from any single source by construction — visible only where two linked sources disagree on time. No record owns this interval.</div>
    ${
      bottlenecks
        ? `<table><thead><tr><th>Seam</th><th class="right">Journeys</th><th class="right">Median unowned</th><th class="right">Max</th></tr></thead><tbody>${bottlenecks}</tbody></table>`
        : `<div class="note">No interval seams above the noise floor.</div>`
    }
  </div>`;
}

// =============================================================================
// STAGE DRILL-DOWN — the click-through payload for one stage. Also used by the
// INFO panel (live) so the same detail renders in-panel and in the side overlay.
// =============================================================================
export function stageDrill(model, stageId) {
  const d = model.diagnostics;
  const sd = d.stages.find((s) => s.stage === stageId);
  if (!sd) return `<div class="note">Unknown stage ${esc(stageId)}.</div>`;
  const ss = (d.services?.perStage ?? []).find((s) => s.stage === stageId);
  const servicesById = new Map(model.services.map((s) => [s.service_id, s]));

  const events = model.events.filter((e) => e.stage === stageId);
  const eventRows = events
    .slice(0, 200)
    .map(
      (e) => `<tr>
      <td class="mono">${esc(e.event_id)}</td><td>${esc(e.event)}</td>
      <td class="note">${esc(e.source ?? '—')}</td>
      <td class="note">${esc(e.timestamp ?? '—')}</td><td>${esc(e.actor ?? '—')}</td>
      <td class="right">${e.cost != null ? money(e.cost) : '—'}</td>
      <td class="mono">${esc(e.entity_id ?? '—')}</td></tr>`,
    )
    .join('');

  const apps = (ss?.service_ids ?? [])
    .map((id) => servicesById.get(id))
    .filter(Boolean)
    .map(
      (s) =>
        `<tr><td>${esc(s.name)}</td><td>${esc(s.category)}</td><td>${esc(s.vendor)}</td>
        <td class="right">${money(s.monthly_cost)}/mo</td>
        <td class="note">${s.seats != null ? `${s.utilized_seats ?? '?'}/${s.seats} seats` : '—'}</td></tr>`,
    )
    .join('');

  const seams = d.bottlenecks
    .filter((b) => b.stage_from === stageId || b.stage_to === stageId)
    .map(
      (b) =>
        `<tr><td>${esc(stageLabel(model, b.stage_from))} → ${esc(stageLabel(model, b.stage_to))}</td>
        <td class="right">${b.occurrences}</td><td class="right warn">${days(b.medianIntervalMs)}</td>
        <td class="right">${days(b.maxIntervalMs)}</td></tr>`,
    )
    .join('');

  return `<div class="drill-head">
      <span class="stage-dot" style="background:${stageColor(model, stageId)}"></span>
      <b>${esc(sd.label)}</b> <span class="note">stage drill-down</span>
    </div>
    <div class="cards">
      <div class="card"><div class="k">Events</div><div class="v">${sd.eventCount}</div></div>
      <div class="card"><div class="k">Journeys</div><div class="v">${sd.journeyCount}</div></div>
      <div class="card"><div class="k">Labor cost</div><div class="v">${money(ss?.laborCost ?? sd.totalCost)}</div></div>
      <div class="card"><div class="k">Tooling/mo</div><div class="v">${money(ss?.toolingCost ?? 0)}</div></div>
      <div class="card"><div class="k">True cost</div><div class="v">${money(ss?.trueCost ?? sd.totalCost)}</div></div>
      <div class="card"><div class="k">Cycle→next</div><div class="v">${days(sd.medianCycleMs)}</div></div>
      <div class="card"><div class="k">Actors</div><div class="v">${sd.actors.length}</div></div>
    </div>
    <div class="section">Apps powering this stage${
      ss?.singleVendor && ss.toolingCost > 0 ? ` <span class="warn">⚠ single-vendor</span>` : ''
    }</div>
    ${
      apps
        ? `<table><thead><tr><th>App</th><th>Category</th><th>Vendor</th><th class="right">$/mo</th><th>Seats</th></tr></thead><tbody>${apps}</tbody></table>`
        : '<div class="note">No service maps to this stage.</div>'
    }
    <div class="section">Interval seams touching this stage</div>
    ${
      seams
        ? `<table><thead><tr><th>Seam</th><th class="right">Journeys</th><th class="right">Median unowned</th><th class="right">Max</th></tr></thead><tbody>${seams}</tbody></table>`
        : '<div class="note">No interval seams touch this stage.</div>'
    }
    <div class="section">Underlying source events (${events.length})</div>
    <div class="note">The raw normalized records that landed at this stage. Showing up to 200.</div>
    ${
      eventRows
        ? `<table><thead><tr><th>ID</th><th>Event</th><th>Source</th><th>Timestamp</th><th>Actor</th><th class="right">Cost</th><th>Journey</th></tr></thead><tbody>${eventRows}</tbody></table>`
        : '<div class="note">No events at this stage.</div>'
    }`;
}

// =============================================================================
// STAGE INFO (compact) — the in-panel version of a stage, for the right rail.
// =============================================================================
export function stageInfo(model, stageId) {
  const d = model.diagnostics;
  const sd = d.stages.find((s) => s.stage === stageId);
  if (!sd) return `<div class="note">Unknown stage ${esc(stageId)}.</div>`;
  const ss = (d.services?.perStage ?? []).find((s) => s.stage === stageId);
  const servicesById = new Map(model.services.map((s) => [s.service_id, s]));
  const col = stageColor(model, stageId);

  const apps = (ss?.service_ids ?? [])
    .map((id) => servicesById.get(id))
    .filter(Boolean)
    .slice(0, 5)
    .map(
      (s) =>
        `<div class="info-row"><span class="ir-name">${esc(s.name)}</span><span class="ir-meta">${money(s.monthly_cost)}/mo</span></div>`,
    )
    .join('');

  const seams = d.bottlenecks
    .filter((b) => (b.stage_from === stageId || b.stage_to === stageId) && b.stage_from !== b.stage_to)
    .sort((a, b) => b.medianIntervalMs - a.medianIntervalMs)
    .slice(0, 4)
    .map(
      (b) =>
        `<div class="info-row seam"><span class="ir-name">${esc(stageLabel(model, b.stage_from))} → ${esc(stageLabel(model, b.stage_to))}</span><span class="ir-meta" style="color:var(--red)">${daysInt(b.medianIntervalMs)}</span></div>`,
    )
    .join('');

  const records = model.events
    .filter((e) => e.stage === stageId)
    .slice(0, 5)
    .map(
      (e) =>
        `<div class="info-row"><span class="ir-name">${esc(e.event)}</span><span class="ir-meta">${esc(e.source ?? '—')}</span></div>`,
    )
    .join('');

  return `<div class="info-eyebrow" style="color:${col}">STAGE</div>
    <div class="info-title">${esc(sd.label)}</div>
    <div class="info-sub">${sd.eventCount} events · ${sd.journeyCount} journeys · ${sd.actors.length} actors</div>
    <div class="info-headline-cards">
      <div class="info-hc"><div class="ihc-v">${money(ss?.trueCost ?? sd.totalCost)}</div><div class="ihc-k">true cost</div></div>
      <div class="info-hc"><div class="ihc-v">${money(ss?.toolingCost ?? 0)}</div><div class="ihc-k">tooling/mo</div></div>
      <div class="info-hc"><div class="ihc-v">${days(sd.medianCycleMs)}</div><div class="ihc-k">cycle → next</div></div>
    </div>
    ${seams ? `<div class="info-section">SEAMS TOUCHING THIS STAGE</div>${seams}` : ''}
    ${apps ? `<div class="info-section">APPS POWERING IT</div>${apps}` : ''}
    ${records ? `<div class="info-section">TOP RECORDS</div>${records}` : ''}
    <button class="info-more" data-drill="stage" data-id="${esc(stageId)}">Open full drill-down →</button>`;
}

// =============================================================================
// JOURNEY DRILL-DOWN — click a journey to see its event chain + links.
// =============================================================================
export function journeyDrill(model, entityId) {
  const j = model.journeys.find((x) => x.entity_id === entityId);
  if (!j) return `<div class="note">Unknown journey ${esc(entityId)}.</div>`;
  const byId = new Map(model.events.map((e) => [e.event_id, e]));
  const cls =
    j.provenance === 'reconstructed' ? 'p-recon' : j.provenance === 'inferred' ? 'p-inf' : 'p-orph';

  const chain = j.event_ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map(
      (e) => `<tr>
      <td><span class="stage-dot" style="background:${stageColor(model, e.stage)}"></span>${esc(
        stageLabel(model, e.stage),
      )}</td>
      <td>${esc(e.event)}</td><td class="mono">${esc(e.event_id)}</td>
      <td class="note">${esc(e.source ?? '—')}</td>
      <td class="note">${esc(e.timestamp ?? '—')}</td>
      <td class="right">${e.cost != null ? money(e.cost) : '—'}</td></tr>`,
    )
    .join('');

  const links = j.links
    .map(
      (l) => `<tr>
      <td class="mono">${esc(l.from_event)} → ${esc(l.to_event)}</td>
      <td><span class="${l.tier === 'tier1_deterministic' ? 'tier1' : 'tier2'}">${esc(l.tier)}</span></td>
      <td class="right">${l.confidence.toFixed(2)}</td>
      <td class="note">${(l.evidence ?? [])
        .map((s) => `${esc(s.signal)} (+${s.contribution.toFixed(2)})`)
        .join(', ')}</td></tr>`,
    )
    .join('');

  return `<div class="drill-head"><b>${esc(j.entity_id)}</b>
      <span class="pill ${cls}">${j.provenance}</span>
      <span class="note">confidence ${j.confidence.toFixed(2)} · ${j.event_ids.length} events · ${
    j.links.length
  } links</span></div>
    <div class="section">Event chain (stage + time order)</div>
    <table><thead><tr><th>Stage</th><th>Event</th><th>ID</th><th>Source</th><th>Timestamp</th><th class="right">Cost</th></tr></thead><tbody>${chain}</tbody></table>
    <div class="section">Links holding the chain</div>
    ${
      links
        ? `<table><thead><tr><th>Link</th><th>Tier</th><th class="right">Conf.</th><th>Evidence</th></tr></thead><tbody>${links}</tbody></table>`
        : '<div class="note">No links (orphan / single-event journey).</div>'
    }`;
}

// =============================================================================
// SERVICE-ARCHITECTURE view (apps/cost per stage). Stage blocks are click-through.
// =============================================================================
export function serviceView(model) {
  if (!model.services.length) {
    return `<div class="view" id="v-service"><div class="note">No service-architecture inventory was provided for this run.</div></div>`;
  }
  const svcs = model.services;
  const d = model.diagnostics.services || {};
  const known = new Set(model.stages.map((x) => x.id));
  const utilOf = (s) =>
    s.seats != null && s.utilized_seats != null && s.seats > 0 ? s.utilized_seats / s.seats : null;

  // --- portfolio rollups -----------------------------------------------------
  const totalSpend = d.totalMonthlyServiceSpend ?? svcs.reduce((a, b) => a + (b.monthly_cost || 0), 0);
  const gapSpend = d.spendInGapsMonthly ?? 0;
  const gapPct = totalSpend ? Math.round((gapSpend / totalSpend) * 100) : 0;
  const vendors = new Set(svcs.map((s) => s.vendor).filter(Boolean));
  const utils = svcs.map(utilOf).filter((x) => x != null);
  const avgUtil = utils.length ? Math.round((utils.reduce((a, b) => a + b, 0) / utils.length) * 100) : null;

  const orphans = svcs.filter((s) => s.stages_served.filter((st) => known.has(st)).length === 0);
  const orphanCost = orphans.reduce((a, b) => a + (b.monthly_cost || 0), 0);
  const underused = svcs.filter((s) => !orphans.includes(s) && utilOf(s) != null && utilOf(s) < 0.6);
  const underusedWaste = underused.reduce((a, b) => a + b.monthly_cost * (1 - utilOf(b)), 0);
  const sprawlCost = (d.appSprawl ?? []).reduce((a, b) => a + b.monthlyCost, 0);

  // --- true cost per stage (the bridge) --------------------------------------
  const perStage = (d.perStage ?? []).slice().sort((a, b) => b.trueCost - a.trueCost);
  const maxTrue = Math.max(1, ...perStage.map((s) => s.trueCost));
  const stageCostRows = perStage
    .map(
      (s) => `<tr>
      <td>${esc(s.label)}${s.singleVendor ? ' <span class="lock-tag" title="all tooling is one vendor">lock-in</span>' : ''}</td>
      <td class="right mono">${money(s.toolingCost)}</td>
      <td class="right mono">${money(s.laborCost)}</td>
      <td class="right mono"><b>${money(s.trueCost)}</b></td>
      <td style="width:30%"><div class="svc-bar"><span class="bar-tool" style="width:${(s.toolingCost / maxTrue) * 100}%"></span><span class="bar-labor" style="width:${(s.laborCost / maxTrue) * 100}%"></span></div></td>
      <td class="note">${s.service_ids.length} app${s.service_ids.length === 1 ? '' : 's'} · ${s.vendors.length} vendor${s.vendors.length === 1 ? '' : 's'}</td></tr>`,
    )
    .join('');

  // --- spend by category -----------------------------------------------------
  const byCat = new Map();
  for (const s of svcs) {
    const c = byCat.get(s.category) || { cost: 0, n: 0 };
    c.cost += s.monthly_cost || 0;
    c.n += 1;
    byCat.set(s.category, c);
  }
  const allCats = [...byCat.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const cats = allCats.slice(0, 14);
  const hiddenCats = allCats.length - cats.length;
  const hiddenCatCost = allCats.slice(14).reduce((a, c) => a + c[1].cost, 0);
  const maxCat = Math.max(1, ...cats.map((c) => c[1].cost));
  const catRows = cats
    .map(
      ([cat, c]) => `<tr><td>${esc(cat)}</td><td class="right">${c.n}</td><td class="right mono">${money(c.cost)}</td>
      <td style="width:42%"><div class="svc-bar"><span class="bar-tool" style="width:${(c.cost / maxCat) * 100}%"></span></div></td></tr>`,
    )
    .join('');

  // --- detail rows -----------------------------------------------------------
  const svcRow = (s) => {
    const u = utilOf(s);
    const pct = u != null ? Math.round(u * 100) : null;
    return `<tr>
      <td>${esc(s.name)}</td><td>${esc(s.category)}</td><td>${esc(s.vendor)}</td>
      <td class="note">${esc(s.cost_model)}</td>
      <td class="right mono">${money(s.monthly_cost)}</td>
      <td class="right ${pct != null && pct < 60 ? 'bad' : ''}">${pct != null ? (s.utilized_seats + '/' + s.seats + ' · ' + pct + '%') : '—'}</td></tr>`;
  };
  const svcTable = (rows) =>
    `<table><thead><tr><th>App</th><th>Category</th><th>Vendor</th><th>Model</th><th class="right">$/mo</th><th class="right">Seats used</th></tr></thead><tbody>${rows}</tbody></table>`;

  const byStage = new Map();
  for (const s of svcs)
    for (const st of s.stages_served.filter((x) => known.has(x)))
      (byStage.get(st) || byStage.set(st, []).get(st)).push(s);
  const stageBlocks = model.stages
    .filter((st) => byStage.has(st.id))
    .map((st) => {
      const list = byStage.get(st.id);
      const total = list.reduce((a, b) => a + b.monthly_cost, 0);
      return `<details><summary class="clickable" data-drill="stage" data-id="${esc(st.id)}"><span class="stage-dot" style="background:${st.color}"></span>${esc(st.label)} — ${list.length} apps · ${money(total)}/mo</summary>${svcTable(list.map(svcRow).join(''))}</details>`;
    })
    .join('');

  const lockRows = (d.vendorConcentrationStages ?? [])
    .map((v) => `<tr><td>${esc(stageLabel(model, v.stage))}</td><td>${esc(v.vendor)}</td><td class="right mono">${money(v.cost)}</td></tr>`)
    .join('');
  const sprawlRows = (d.appSprawl ?? [])
    .map(
      (s) => `<tr><td>${esc(s.category)}</td><td class="right">${s.service_ids.length}</td>
      <td>${s.overlappingStages.map((x) => esc(stageLabel(model, x))).join(', ')}</td>
      <td class="right mono">${money(s.monthlyCost)}</td></tr>`,
    )
    .join('');

  return `<div class="view" id="v-service">
    <div class="section">Service architecture — what the work runs on</div>
    <div class="note">Every app the business pays for, bridged to the stages it powers — so tooling spend is mapped onto the value stream and the waste is named.</div>
    <div class="cards">
      <div class="card"><div class="k">Apps</div><div class="v">${svcs.length}</div></div>
      <div class="card"><div class="k">Total spend/mo</div><div class="v">${money(totalSpend)}</div></div>
      <div class="card"><div class="k bad">Spend in gaps/mo</div><div class="v bad">${money(gapSpend)}</div><div class="card-sub">${gapPct}% of spend</div></div>
      <div class="card"><div class="k">Cost / journey</div><div class="v">${d.costPerJourney != null ? money(d.costPerJourney) : '—'}</div></div>
      <div class="card"><div class="k">Vendors</div><div class="v">${vendors.size}</div></div>
      <div class="card"><div class="k ${avgUtil != null && avgUtil < 60 ? 'warn' : ''}">Avg seat use</div><div class="v">${avgUtil != null ? avgUtil + '%' : '—'}</div></div>
    </div>

    <div class="section">True cost per stage — the bridge</div>
    <div class="note">Each app's monthly cost is split across the stages it powers (cost ÷ stages served). <span style="color:var(--blue)">■ tooling</span> + <span style="color:var(--gold)">■ labor</span> = true cost — so you see where money actually flows through the stream.</div>
    ${
      perStage.length
        ? `<table><thead><tr><th>Stage</th><th class="right">Tooling/mo</th><th class="right">Labor</th><th class="right">True cost/mo</th><th>Tooling ■ / labor ■</th><th></th></tr></thead><tbody>${stageCostRows}</tbody></table>`
        : '<div class="note">No service maps to a captured stage.</div>'
    }

    <div class="section">Spend by category</div>
    <table><thead><tr><th>Category</th><th class="right">Apps</th><th class="right">$/mo</th><th>Share</th></tr></thead><tbody>${catRows}</tbody></table>
    ${hiddenCats ? `<div class="note">+ ${hiddenCats} smaller categories · ${money(hiddenCatCost)}/mo</div>` : ''}

    <div class="section bad">Where the spend leaks — ${money(gapSpend)}/mo</div>
    <div class="cards">
      <div class="card"><div class="k bad">Zombie apps</div><div class="v bad">${money(orphanCost)}</div><div class="card-sub">${orphans.length} powering no stage</div></div>
      <div class="card"><div class="k warn">Underused licenses</div><div class="v warn">${money(underusedWaste)}</div><div class="card-sub">${underused.length} below 60% seat use</div></div>
      <div class="card"><div class="k warn">App sprawl</div><div class="v warn">${money(sprawlCost)}</div><div class="card-sub">${(d.appSprawl ?? []).length} overlapping categories</div></div>
    </div>
    ${orphans.length ? `<details><summary class="clickable">Zombie apps — paid, power no captured stage (${orphans.length})</summary>${svcTable(orphans.sort((a, b) => b.monthly_cost - a.monthly_cost).map(svcRow).join(''))}</details>` : ''}
    ${underused.length ? `<details><summary class="clickable">Underused licenses — below 60% seat use (${underused.length})</summary>${svcTable(underused.sort((a, b) => utilOf(a) - utilOf(b)).map(svcRow).join(''))}</details>` : ''}
    ${sprawlRows ? `<details><summary class="clickable">App sprawl — overlapping tools in one category</summary><table><thead><tr><th>Category</th><th class="right">Tools</th><th>Overlapping stages</th><th class="right">$/mo</th></tr></thead><tbody>${sprawlRows}</tbody></table></details>` : ''}

    ${lockRows ? `<div class="section warn">Vendor lock-in — stages run entirely on one vendor</div><table><thead><tr><th>Stage</th><th>Sole vendor</th><th class="right">$/mo at risk</th></tr></thead><tbody>${lockRows}</tbody></table>` : ''}

    <div class="section">Every app, by the stage it powers</div>
    ${stageBlocks || '<div class="note">No service maps to a captured stage.</div>'}
  </div>`;
}

// =============================================================================
// GAPS view (spend-in-gaps + value-stream gaps, held to the honesty standard).
// =============================================================================
// Plain-English definition of every gap type — what it IS and why it matters.
const GAP_INFO = {
  interval_seam: {
    name: 'Bottleneck seam', accent: 'var(--red)', unit: 'time',
    what: 'A handoff nobody owns — time passes between two stages with no record accounting for it. This is where work stalls.',
  },
  orphan_service: {
    name: 'Zombie subscription', accent: 'var(--red)', unit: 'cost',
    what: 'An app you pay for that powers no captured stage — pure waste, or shadow IT nobody tracks.',
  },
  redundant_service: {
    name: 'App sprawl', accent: 'var(--gold)', unit: 'cost',
    what: 'Two or more tools in the same category doing overlapping work — a consolidation opportunity.',
  },
  underutilized_service: {
    name: 'Underused licenses', accent: 'var(--gold)', unit: 'cost',
    what: 'Seats you pay for that sit largely unused — right-size the plan.',
  },
  orphan: {
    name: 'Orphan record', accent: 'var(--gold)', unit: 'count',
    what: "Records that link to nothing — the journey can't be reconstructed through here.",
  },
  weak_link: {
    name: 'Unproven link', accent: 'var(--gold)', unit: 'count',
    what: "Records we believe belong together but couldn't prove — held as a gap rather than asserted as fact.",
  },
  missing_expected_stage: {
    name: 'Missing stage', accent: 'var(--muted)', unit: 'count',
    what: "A step the journey should have, but the data doesn't show it — a blind spot, not a fabrication.",
  },
};

export function gapsView(model) {
  const g = model.gaps || [];
  const spendTypes = new Set(['orphan_service', 'underutilized_service', 'redundant_service']);
  const spendTotal = g.filter((x) => spendTypes.has(x.type)).reduce((a, b) => a + (b.cost ?? 0), 0);
  const vsCount = g.filter((x) => !spendTypes.has(x.type)).length;

  // group by type, keep a sensible display order
  const byType = new Map();
  for (const x of g) (byType.get(x.type) || byType.set(x.type, []).get(x.type)).push(x);
  const ORDER = ['interval_seam', 'orphan_service', 'redundant_service', 'underutilized_service', 'orphan', 'weak_link', 'missing_expected_stage'];
  const typesPresent = ORDER.filter((t) => byType.has(t)).concat([...byType.keys()].filter((t) => !ORDER.includes(t)));

  // overview cards — one per gap type, defining what it is + its impact
  const typeCards = typesPresent
    .map((t) => {
      const items = byType.get(t);
      const info = GAP_INFO[t] || { name: t, accent: 'var(--muted)', unit: 'count', what: '' };
      let metric;
      if (info.unit === 'cost') metric = money(items.reduce((a, b) => a + (b.cost ?? 0), 0)) + '/mo';
      else if (info.unit === 'time') {
        const ivs = items.map((i) => i.interval_ms ?? 0).filter(Boolean).sort((a, b) => a - b);
        metric = ivs.length ? days(ivs[Math.floor(ivs.length / 2)]) + ' median unowned' : '—';
      } else metric = items.length === 1 ? '1 instance' : items.length + ' instances';
      return `<div class="gap-type" style="--gap-accent:${info.accent}">
        <div class="gap-type-head"><span class="gap-type-name">${esc(info.name)}</span><span class="gap-type-count">${items.length}</span></div>
        <div class="gap-type-metric">${esc(metric)}</div>
        <div class="gap-type-what">${esc(info.what)}</div>
      </div>`;
    })
    .join('');

  // worst-first detail rows — severity = cost (spend) or interval (seam)
  const sev = (x) => (x.cost ?? 0) * 1e6 + (x.interval_ms ?? 0);
  const rows = g
    .slice()
    .sort((a, b) => sev(b) - sev(a))
    .slice(0, 300)
    .map((x) => {
      const info = GAP_INFO[x.type] || { name: x.type, accent: 'var(--muted)' };
      const impact = x.cost != null ? money(x.cost) + '/mo' : x.interval_ms != null ? days(x.interval_ms) : '—';
      return `<tr><td><span class="gap-dot" style="background:${info.accent}"></span>${esc(info.name)}</td>
        <td class="mono" style="color:${info.accent}">${impact}</td>
        <td>${esc(x.detail)}</td><td class="right">${(x.confidence ?? 0).toFixed(2)}</td></tr>`;
    })
    .join('');

  return `<div class="view" id="v-gaps">
    <div class="gap-hero">
      <div><div class="gap-hero-k">Spend flowing into gaps</div><div class="gap-hero-v bad">${money(spendTotal)}/mo</div></div>
      <div><div class="gap-hero-k">Value-stream gaps</div><div class="gap-hero-v">${vsCount}</div></div>
      <div class="gap-hero-note">Every gap is first-class and named — held to the same honesty standard as the ledger. A zombie app is the service-architecture twin of a seam nobody owns.</div>
    </div>
    <div class="section">What's leaking — and what each gap is</div>
    <div class="gap-types">${typeCards || '<div class="note">No gaps detected.</div>'}</div>
    <div class="section">The gaps, worst first</div>
    <table><thead><tr><th>Gap</th><th>Impact</th><th>Detail</th><th class="right">Conf.</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

// =============================================================================
// Shared visual helpers (palette for sources; pure, browser-safe).
// =============================================================================
const SOURCE_PALETTE = [
  '#6aa0ff', '#5ee0a0', '#e3c27e', '#e06a6a', '#7cc4ff',
  '#b794f6', '#4fd1c5', '#f6ad55', '#fc8181', '#9ae6b4',
];
function sourcePalette(model) {
  const sources = [...new Set(model.events.map((e) => e.source ?? '—'))].sort();
  const map = new Map();
  sources.forEach((s, i) => map.set(s, SOURCE_PALETTE[i % SOURCE_PALETTE.length]));
  return map;
}

// =============================================================================
// FLOW view — the headline value-stream flow diagram. (Restyled to tokens.)
// =============================================================================
export function flowView(model) {
  const stages = model.stages.slice().sort((a, b) => a.order - b.order);
  const idx = new Map(stages.map((s, i) => [s.id, i]));
  const sdById = new Map(model.diagnostics.stages.map((s) => [s.stage, s]));

  const transitions = deriveTransitions(model);
  const key = (a, b) => a + '|' + b;

  const bottleneck = new Map();
  for (const b of model.diagnostics.bottlenecks) {
    if (b.stage_from !== b.stage_to) bottleneck.set(key(b.stage_from, b.stage_to), b);
  }

  const NW = 150, NH = 86, GAP = 96, PADX = 28, PADY = 96;
  const W = PADX * 2 + stages.length * NW + Math.max(0, stages.length - 1) * GAP;
  const H = PADY + NH + 120;
  const nodeY = PADY;
  const nodeX = (i) => PADX + i * (NW + GAP);

  const maxCount = Math.max(1, ...transitions.values());
  const strokeFor = (n) => 1.5 + (n / maxCount) * 13;

  let edges = '';
  for (const [k, count] of transitions) {
    const [from, to] = k.split('|');
    const i = idx.get(from), j = idx.get(to);
    if (i == null || j == null) continue;
    const x1 = nodeX(i) + NW, y1 = nodeY + NH / 2;
    const x2 = nodeX(j), y2 = nodeY + NH / 2;
    const bn = bottleneck.get(k);
    const back = j < i;
    const sw = strokeFor(count);
    const color = bn ? 'var(--red)' : 'var(--blue)';
    const op = bn ? 0.95 : 0.55;
    let path, lx, ly;
    if (back) {
      const sx = nodeX(i) + NW / 2, ex = nodeX(j) + NW / 2;
      const dip = nodeY + NH + 64;
      path = `M ${sx} ${nodeY + NH} C ${sx} ${dip}, ${ex} ${dip}, ${ex} ${nodeY + NH}`;
      lx = (sx + ex) / 2; ly = dip + 4;
    } else {
      const mx = (x1 + x2) / 2;
      path = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      lx = mx; ly = y1 - 10;
    }
    const tip = bn
      ? `${stageLabel(model, from)} → ${stageLabel(model, to)} · ${count} journeys · BOTTLENECK median ${days(bn.medianIntervalMs)} unowned (${bn.occurrences}×)`
      : `${stageLabel(model, from)} → ${stageLabel(model, to)} · ${count} journeys`;
    edges += `<path d="${path}" fill="none" stroke="${color}" stroke-width="${sw.toFixed(1)}" stroke-opacity="${op}" stroke-linecap="round"${bn ? ' stroke-dasharray="7 6"' : ''}><title>${esc(tip)}</title></path>`;
    if (bn) {
      const lbl = `${days(bn.medianIntervalMs)} · ${bn.occurrences}×`;
      edges += `<text x="${lx}" y="${ly}" text-anchor="middle" fill="var(--red)" font-size="11" font-weight="700">${esc(lbl)}</text>`;
    } else if (count > 1) {
      edges += `<text x="${lx}" y="${ly}" text-anchor="middle" fill="var(--muted)" font-size="10">${count}</text>`;
    }
  }

  const selfBn = new Map();
  for (const b of model.diagnostics.bottlenecks) {
    if (b.stage_from === b.stage_to && idx.has(b.stage_from)) selfBn.set(b.stage_from, b);
  }

  let nodes = '';
  stages.forEach((s, i) => {
    const sd = sdById.get(s.id) || { eventCount: 0, journeyCount: 0 };
    const x = nodeX(i), y = nodeY;
    nodes += `<g class="flow-node" data-drill="stage" data-id="${esc(s.id)}" style="cursor:pointer">
      <title>${esc(s.label)} — ${sd.eventCount} events, ${sd.journeyCount} journeys (click to drill)</title>
      <rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="12" fill="var(--raised)" stroke="${s.color}" stroke-width="1.5"/>
      <rect x="${x}" y="${y}" width="3" height="${NH}" rx="2" fill="${s.color}"/>
      <text x="${x + NW / 2}" y="${y + 28}" text-anchor="middle" fill="var(--ink)" font-size="12.5" font-weight="700">${esc(truncate(s.label, 17))}</text>
      <text x="${x + NW / 2}" y="${y + 50}" text-anchor="middle" fill="var(--muted)" font-size="11">${sd.eventCount} events</text>
      <text x="${x + NW / 2}" y="${y + 68}" text-anchor="middle" fill="var(--muted)" font-size="11">${sd.journeyCount} journeys</text>`;
    const sb = selfBn.get(s.id);
    if (sb) {
      nodes += `<g><title>${esc(s.label + ' rework seam · ' + days(sb.medianIntervalMs) + ' unowned (' + sb.occurrences + '×)')}</title>
        <circle cx="${x + NW - 10}" cy="${y + 10}" r="9" fill="var(--gold)" stroke="var(--bg)" stroke-width="1.5"/>
        <text x="${x + NW - 10}" y="${y + 14}" text-anchor="middle" fill="#1a140a" font-size="10" font-weight="700">↻</text></g>`;
    }
    nodes += `</g>`;
  });

  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:${W}px" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${edges}${nodes}</svg>`;

  return `<div class="view" id="v-flow">
    <div class="section">The operating floor — value stream, left to right</div>
    <div class="note">One node per stage (click to drill). Edge thickness = how many journeys make that transition. Ember dashed edges and labels are bottleneck seams: time nobody owns, median unowned shown. A ↻ badge marks a stage that journeys churn inside before moving on.</div>
    <div style="overflow-x:auto; border:1px solid var(--line); border-radius:12px; background:var(--panel); padding:12px;">${svg}</div>
    <div class="kvs" style="margin-top:14px">
      <span><span class="legend-line" style="background:var(--blue)"></span> journey flow (thicker = more journeys)</span>
      <span><span class="legend-line" style="background:var(--red)"></span> bottleneck seam (unowned time)</span>
      <span>↻ in-stage rework seam</span>
    </div>
  </div>`;
}

// =============================================================================
// CONNECTIONS view — reconciliation made visible. (Restyled to tokens.)
// =============================================================================
export function connectionsView(model) {
  const stages = model.stages.slice().sort((a, b) => a.order - b.order);
  const idx = new Map(stages.map((s, i) => [s.id, i]));
  const palette = sourcePalette(model);
  const byId = new Map(model.events.map((e) => [e.event_id, e]));

  const SHOW = 14;
  const ordered = model.journeys.slice().sort((a, b) => b.event_ids.length - a.event_ids.length);
  const shown = ordered.slice(0, SHOW);
  const hidden = ordered.length - shown.length;

  const COLX = 168, PADX = 150, PADY = 56, ROWH = 64, R = 9;
  const W = PADX + stages.length * COLX + 40;
  const H = PADY + shown.length * ROWH + 30;
  const colX = (i) => PADX + i * COLX;
  const rowY = (r) => PADY + r * ROWH + ROWH / 2;

  let cols = '';
  stages.forEach((s, i) => {
    const x = colX(i);
    cols += `<line x1="${x}" y1="${PADY - 18}" x2="${x}" y2="${H - 14}" stroke="${s.color}" stroke-opacity="0.18" stroke-width="1"/>`;
    cols += `<text x="${x}" y="${PADY - 26}" text-anchor="middle" fill="${s.color}" font-size="11" font-weight="700">${esc(truncate(s.label, 13))}</text>`;
  });

  let rows = '';
  shown.forEach((j, r) => {
    const baseY = rowY(r);
    const cls =
      j.provenance === 'reconstructed' ? 'var(--green)' : j.provenance === 'inferred' ? 'var(--gold)' : 'var(--red)';
    rows += `<text x="12" y="${baseY + 4}" fill="${cls}" font-size="11" font-family="ui-monospace,Menlo,monospace">${esc(truncate(j.entity_id, 18))}</text>`;

    const stageCount = new Map();
    const pos = new Map();
    for (const id of j.event_ids) {
      const e = byId.get(id);
      if (!e || !idx.has(e.stage)) continue;
      const i = idx.get(e.stage);
      const n = stageCount.get(i) || 0;
      stageCount.set(i, n + 1);
      const yoff = (n % 3) * 13 - 13;
      pos.set(id, { x: colX(i), y: baseY + yoff, e });
    }

    for (const l of j.links) {
      const a = pos.get(l.from_event), b = pos.get(l.to_event);
      if (!a || !b) continue;
      const t1 = l.tier === 'tier1_deterministic';
      const op = (0.3 + 0.6 * Math.max(0, Math.min(1, l.confidence))).toFixed(2);
      const ev = (l.evidence ?? [])
        .map((s) => `${s.signal} (+${(s.contribution ?? 0).toFixed(2)})`)
        .join(', ');
      const tip = `${l.from_event} → ${l.to_event} · ${t1 ? 'Tier-1 deterministic' : 'Tier-2 probabilistic'} · conf ${l.confidence.toFixed(2)}${ev ? ' · ' + ev : ''}`;
      const mx = (a.x + b.x) / 2;
      const path = `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
      rows += `<path d="${path}" fill="none" stroke="${t1 ? 'var(--green)' : 'var(--gold)'}" stroke-width="${t1 ? 2 : 1.6}" stroke-opacity="${op}"${t1 ? '' : ' stroke-dasharray="5 4"'}><title>${esc(tip)}</title></path>`;
    }

    for (const { x, y, e } of pos.values()) {
      const color = palette.get(e.source ?? '—') || '#64748b';
      const tip = `${e.event} · ${e.source ?? '—'} · ${stageLabel(model, e.stage)}${e.timestamp ? ' · ' + e.timestamp : ''}`;
      rows += `<circle cx="${x}" cy="${y}" r="${R}" fill="${color}" stroke="var(--bg)" stroke-width="2"><title>${esc(tip)}</title></circle>`;
    }
  });

  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:${W}px" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${cols}${rows}</svg>`;

  const srcLegend = [...palette.entries()]
    .map(
      ([src, color]) =>
        `<span><span class="legend-dot" style="background:${color}"></span>${esc(src)}</span>`,
    )
    .join('');

  return `<div class="view" id="v-connections">
    <div class="section">Reconciliation — how records across systems become one journey</div>
    <div class="note">Each row is a journey; each dot is a source record placed at its stage. Dot color = the source system it came from, so a row spanning many colors is the cross-system linkage made visible. Solid green links are Tier-1 deterministic (shared key); dashed gold are Tier-2 probabilistic (composite evidence) — opacity tracks confidence. Hover any link for the signals that fired.</div>
    ${
      hidden > 0
        ? `<div class="note warn">Showing the ${shown.length} largest journeys of ${ordered.length}. ${hidden} smaller journeys are not drawn here.</div>`
        : ''
    }
    <div class="kvs" style="margin:6px 0 12px">
      <span><span class="legend-line" style="background:var(--green)"></span> Tier-1 deterministic (solid)</span>
      <span><span class="legend-line" style="background:var(--gold);height:0;border-top:2px dashed var(--gold)"></span> Tier-2 probabilistic (dashed)</span>
    </div>
    <div style="overflow-x:auto; border:1px solid var(--line); border-radius:12px; background:var(--panel); padding:12px;">${svg}</div>
    <div class="section">Source systems</div>
    <div class="kvs">${srcLegend}</div>
  </div>`;
}

// =============================================================================
// TOUR — a guided ordered walkthrough of the map. Pure data: each step names a
// stage to pan/select plus narration. CLIENT_SCRIPT drives it.
// =============================================================================
export function buildTour(model) {
  const d = model.diagnostics;
  const l = model.ledger;
  const steps = [];

  // 1. headline ledger
  steps.push({
    target: null,
    eyebrow: 'TOUR · THE LEDGER',
    title: 'What we could honestly reconstruct',
    body: `${l.reconstructed} of ${l.total_journeys} journeys were reconstructed end-to-end (${l.pct_reconstructed}%), ${l.inferred} inferred, ${l.could_not_connect} could not connect. End-to-end median is ${days(d.endToEndMedianMs)}. The map below is that stream — every stage, every seam.`,
  });

  // 2. worst bottleneck seam
  const worst = d.bottlenecks
    .filter((b) => b.stage_from !== b.stage_to)
    .slice()
    .sort((a, b) => b.medianIntervalMs - a.medianIntervalMs)[0];
  if (worst) {
    steps.push({
      target: worst.stage_to,
      eyebrow: 'TOUR · WORST SEAM',
      title: `${daysInt(worst.medianIntervalMs)} nobody owns`,
      body: `Between ${stageLabel(model, worst.stage_from)} and ${stageLabel(model, worst.stage_to)}, journeys sit ${daysInt(worst.medianIntervalMs)} (median, ${worst.occurrences}×; max ${daysInt(worst.maxIntervalMs)}). No single source owns this interval — it's only visible where two linked systems disagree on time.`,
    });
  }

  // 3. biggest spend gap
  const spendGaps = model.gaps
    .filter((x) => ['orphan_service', 'underutilized_service', 'redundant_service'].includes(x.type))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  if (spendGaps[0]) {
    const g = spendGaps[0];
    const targetStage = g.stage_to || g.stage_from || null;
    steps.push({
      target: targetStage,
      eyebrow: 'TOUR · BIGGEST SPEND GAP',
      title: `${money(g.cost)}/mo into a gap`,
      body: esc(g.detail),
      rawBody: true,
    });
  }

  // 4. an opportunity — the costliest stage to act on, or single-vendor risk.
  const perStage = (d.services?.perStage ?? []).slice().sort((a, b) => b.trueCost - a.trueCost);
  const opp = perStage[0];
  if (opp) {
    steps.push({
      target: opp.stage,
      eyebrow: 'TOUR · THE OPPORTUNITY',
      title: `${stageLabel(model, opp.stage)} costs the most`,
      body: `At ${money(opp.trueCost)} true cost (${money(opp.toolingCost)}/mo tooling + labor)${opp.singleVendor ? `, and it's single-vendor (${opp.vendors[0]}) — concentration risk` : ''}. This is where shaving cycle time or consolidating tools pays back fastest.`,
    });
  }

  return steps;
}

// =============================================================================
// Toolbar + search — the page chrome. Rendered into the shell by both paths.
// =============================================================================
export function buildToolbar(model) {
  return `<div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="4" cy="10" r="2.4" fill="var(--gold)"/><line x1="6" y1="10" x2="16" y2="10" stroke="var(--gold)" stroke-width="1.6"/><circle cx="16" cy="10" r="2.4" fill="none" stroke="var(--gold)" stroke-width="1.6"/></svg>
      </span>
      <span class="brand-name">Throughline</span>
      <span class="breadcrumb">‹ ${esc(model.meta.vertical)}</span>
    </div>
    <div class="tabs" id="tabs">${buildTabs()}</div>
    <div class="toolbar-right">
      <button class="chrome-btn" id="export-model" title="Download this model.json">Export</button>
    </div>`;
}

export function buildSearchBar() {
  return `<div class="searchbar">
    <span class="search-icon" aria-hidden="true">⌕</span>
    <input id="map-search" type="search" placeholder="Search stages, journeys, services…" aria-label="Fuzzy search the map" autocomplete="off"/>
    <span class="search-mode">Fuzzy</span>
  </div>`;
}

// =============================================================================
// Assembly: tabs + all views. Shared by static and served.
// =============================================================================
export function buildTabs() {
  return [
    ['v-map', 'Map', true],
    ['v-flow', 'Flow', false],
    ['v-connections', 'Connections', false],
    ['v-stage', 'Stages', false],
    ['v-service', 'Services', false],
    ['v-gaps', 'Gaps', false],
  ]
    .map(
      ([id, label, active]) =>
        `<button class="tab${active ? ' active' : ''}" data-view="${id}">${label}</button>`,
    )
    .join('');
}

export function buildViews(model) {
  return [
    mapView(model),
    flowView(model),
    connectionsView(model),
    stageView(model),
    serviceView(model),
    gapsView(model),
  ].join('\n');
}

export function subtitleFor(model) {
  const m = model.meta;
  return `vertical <b>${esc(m.vertical)}</b> · unit <b>${esc(m.unit)}</b> · ${
    model.events.length
  } events · ${model.journeys.length} journeys · ${model.services.length} services${
    m.sampled ? ' · <span class="warn">SAMPLED</span>' : ''
  } · generated ${esc(m.generatedAt)}`;
}

// =============================================================================
// Shared style — Throughline "Executive Map" token system.
// =============================================================================
export const STYLE = `
:root {
  --bg:#0a0e1a; --panel:#101728; --raised:#141d33; --line:#1e2a44;
  --ink:#eef2f9; --muted:#8a96ad;
  --blue:#6aa0ff; --gold:#e3c27e; --red:#e06a6a; --green:#5ee0a0;
  /* legacy aliases so older view markup keeps its semantics */
  --panel2:#141d33; --good:#5ee0a0; --warn:#e3c27e; --bad:#e06a6a; --accent:#6aa0ff;
}
* { box-sizing:border-box; }
html, body { height:100%; }
body {
  margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  color:var(--ink);
  background:
    radial-gradient(900px 600px at 8% -5%, rgba(106,160,255,0.10), transparent 60%),
    radial-gradient(820px 560px at 102% 108%, rgba(227,194,126,0.07), transparent 60%),
    var(--bg);
  background-attachment:fixed;
}
::selection { background:rgba(106,160,255,0.28); }

/* ---- header / toolbar ---- */
header { display:none; }
.toolbar {
  display:flex; align-items:center; gap:18px; padding:12px 22px;
  background:rgba(16,23,40,0.86); backdrop-filter:blur(10px);
  border-bottom:1px solid var(--line); position:sticky; top:0; z-index:20;
}
.brand { display:flex; align-items:center; gap:10px; }
.brand-mark { display:inline-flex; }
.brand-name { font-weight:700; font-size:15px; letter-spacing:0.01em; }
.breadcrumb { color:var(--muted); font-size:13px; margin-left:4px; }
.toolbar-right { margin-left:auto; display:flex; gap:8px; }
.chrome-btn {
  background:var(--raised); border:1px solid var(--line); color:var(--ink);
  border-radius:9px; padding:7px 14px; cursor:pointer; font-weight:600; font-size:13px;
  transition:border-color .15s, background .15s;
}
.chrome-btn:hover { border-color:var(--blue); }

/* ---- tabs ---- */
.tabs { display:flex; gap:4px; flex-wrap:wrap; }
.tab {
  padding:7px 14px; border:1px solid transparent; border-radius:9px;
  background:transparent; color:var(--muted); cursor:pointer; font-weight:600; font-size:13px;
  font-family:inherit; transition:color .15s, background .15s, border-color .15s;
}
.tab:hover { color:var(--ink); background:var(--raised); }
.tab.active { background:var(--raised); color:var(--ink); border-color:var(--line); box-shadow:inset 0 -2px 0 var(--blue); }

/* ---- search bar ---- */
.searchbar {
  display:flex; align-items:center; gap:10px; margin:14px 22px 0;
  background:var(--raised); border:1px solid var(--line); border-radius:11px;
  padding:9px 14px; max-width:560px;
}
.search-icon { color:var(--muted); font-size:16px; }
#map-search {
  flex:1; background:transparent; border:none; outline:none; color:var(--ink);
  font:14px inherit; font-family:inherit;
}
#map-search::placeholder { color:var(--muted); }
.search-mode {
  font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase;
  color:var(--blue); background:rgba(106,160,255,0.12); border:1px solid rgba(106,160,255,0.3);
  border-radius:6px; padding:2px 8px;
}

/* ---- generic views ---- */
.view { display:none; padding:22px; }
.view.active { display:block; }
.section { margin:24px 0 10px; font-size:15px; font-weight:700; }
.note { color:var(--muted); font-size:12px; margin:4px 0 14px; max-width:80ch; }
.cards { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:18px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 18px; min-width:150px; }
.card .k { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
.card .v { font-size:22px; font-weight:700; margin-top:4px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; position:sticky; top:54px; background:var(--panel); }
tr:hover td { background:rgba(106,160,255,.05); }
tr.clickable { cursor:pointer; }
tr.clickable:hover td { background:rgba(106,160,255,.12); }
.pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; }
.p-recon { background:rgba(94,224,160,.16); color:var(--green); }
.p-inf { background:rgba(227,194,126,.16); color:var(--gold); }
.p-orph { background:rgba(224,106,106,.16); color:var(--red); }
.tier1 { color:var(--green); } .tier2 { color:var(--gold); }
.stage-dot { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; vertical-align:middle; }
details { background:var(--panel); border:1px solid var(--line); border-radius:10px; margin:8px 0; padding:4px 12px; }
summary { cursor:pointer; font-weight:600; padding:8px 0; }
.gap-orphan_service,.gap-orphan { border-left:3px solid var(--red); }
.gap-underutilized_service { border-left:3px solid var(--gold); }
.gap-redundant_service { border-left:3px solid var(--blue); }
.gap-interval_seam { border-left:3px solid var(--gold); }
.warn { color:var(--gold); } .bad { color:var(--red); } .good { color:var(--green); }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
.kvs { display:flex; gap:18px; flex-wrap:wrap; color:var(--muted); font-size:12px; }
.right { text-align:right; }
.legend-dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:middle; }
.legend-line { display:inline-block; width:22px; height:3px; border-radius:2px; margin-right:6px; vertical-align:middle; }

/* ====================== MAP EXPLORER ====================== */
.map-view { display:none; padding:0; }
.map-view.active { display:flex; flex-direction:column; height:calc(100vh - 118px); min-height:560px; }

.map-filters {
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  padding:12px 22px; border-bottom:1px solid var(--line);
}
.filter-group-label { font-size:10px; font-weight:700; letter-spacing:0.08em; color:var(--muted); margin-right:2px; }
.filter-divider { width:1px; height:18px; background:var(--line); margin:0 4px; }
.chip {
  display:inline-flex; align-items:center; gap:7px; cursor:pointer; font-family:inherit;
  background:var(--raised); border:1px solid var(--line); color:var(--ink);
  border-radius:999px; padding:5px 12px; font-size:12px; font-weight:600;
  transition:border-color .15s, background .15s, opacity .15s;
}
.chip-dot { width:9px; height:9px; border-radius:50%; background:var(--chip,var(--muted)); box-shadow:0 0 0 0 transparent; }
.chip:hover { border-color:var(--chip,var(--blue)); }
.chip.active { border-color:var(--chip,var(--blue)); background:color-mix(in srgb, var(--chip) 16%, var(--raised)); }
.chip.dim { opacity:0.45; }

.map-stage { flex:1; display:flex; min-height:0; }
.map-canvas-wrap {
  flex:1; position:relative; overflow:hidden; min-width:0;
  background-image:radial-gradient(rgba(138,150,173,0.10) 1px, transparent 1px);
  background-size:26px 26px; background-position:center;
  cursor:grab; outline:none;
}
.map-canvas-wrap:active { cursor:grabbing; }
.map-canvas-wrap:focus-visible { box-shadow:inset 0 0 0 2px var(--blue); }

/* ONE transformed world: SVG edges + HTML node cards share its coordinate
   space, so a single CSS transform pans/zooms both together (transform-origin
   set inline to 0 0). No foreignObject, no detachment. */
.map-world { will-change:transform; }
.map-edges { pointer-events:none; overflow:visible; }
.map-edges .edge { pointer-events:stroke; }

/* node cards — real HTML, absolutely positioned in world coords. CSS contains
   every line at any zoom (clamp + ellipsis), so text can never spill the box. */
.node-card {
  position:absolute; box-sizing:border-box;
  display:flex; flex-direction:column; justify-content:center; gap:2px;
  padding:12px 16px 12px 18px; overflow:hidden;
  background:var(--raised); border:1px solid var(--line);
  border-left:3px solid var(--node-accent,var(--blue)); border-radius:14px;
  box-shadow:0 4px 14px rgba(0,0,0,0.28);
  font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  cursor:pointer; transition:border-color .15s, box-shadow .15s, opacity .15s; outline:none;
}
.node-card .node-eyebrow {
  font-size:9px; font-weight:700; letter-spacing:0.1em; color:var(--node-accent,var(--blue));
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.node-card .node-title {
  color:var(--ink); font-size:15px; font-weight:700; line-height:1.18;
  overflow:hidden; text-overflow:ellipsis;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
  word-break:break-word;
}
.node-card .node-metric {
  color:var(--ink); font-size:16px; font-weight:700;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px;
}
.node-card .node-metric-label {
  color:var(--muted); font-size:10px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.node-card .node-rework {
  position:absolute; top:8px; right:8px; width:20px; height:20px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  background:var(--gold); color:#1a140a; font-size:12px; font-weight:800;
  border:2px solid var(--bg);
}
.node-card:hover { border-color:var(--blue); }
.node-card:focus-visible { border-color:var(--blue); box-shadow:0 0 0 2px var(--blue); }
.node-card.selected { border-color:var(--blue); box-shadow:0 0 0 2px var(--blue), 0 4px 14px rgba(0,0,0,0.28); }
.node-card.dim { opacity:0.22; }
.node-card.match { border-color:var(--green); box-shadow:0 0 0 2px var(--green), 0 4px 14px rgba(0,0,0,0.28); }
.cluster-label { fill:var(--blue); fill-opacity:0.7; font-size:11px; font-weight:700; letter-spacing:0.14em; }
.edge.dim { opacity:0.1; }
/* Gaps overview — defines what each gap type is */
.gap-hero { display:flex; gap:28px; align-items:flex-start; flex-wrap:wrap; margin:6px 0 22px; }
.gap-hero-k { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; }
.gap-hero-v { font-size:26px; font-weight:700; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; margin-top:3px; }
.gap-hero-note { color:var(--muted); font-size:12px; max-width:440px; line-height:1.5; margin-left:auto; }
.gap-types { display:grid; grid-template-columns:repeat(auto-fill,minmax(248px,1fr)); gap:12px; margin:8px 0 28px; }
.gap-type { background:var(--raised); border:1px solid var(--line); border-left:3px solid var(--gap-accent,var(--muted)); border-radius:12px; padding:14px 16px; }
.gap-type-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.gap-type-name { font-size:14px; font-weight:700; color:var(--ink); }
.gap-type-count { font-size:13px; font-weight:700; color:var(--gap-accent,var(--ink)); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.gap-type-metric { font-size:13px; color:var(--gap-accent,var(--ink)); font-weight:600; margin:5px 0 7px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.gap-type-what { font-size:12px; color:var(--muted); line-height:1.5; }
.gap-dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:7px; vertical-align:middle; }
/* Service-architecture detail */
.card-sub { color:var(--muted); font-size:11px; margin-top:3px; }
.svc-bar { height:11px; background:var(--bg); border:1px solid var(--line); border-radius:6px; overflow:hidden; display:flex; min-width:60px; }
.svc-bar .bar-tool { background:var(--blue); height:100%; }
.svc-bar .bar-labor { background:var(--gold); height:100%; }
.lock-tag { display:inline-block; font-size:9px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; color:var(--gold); border:1px solid var(--gold); border-radius:4px; padding:1px 5px; margin-left:6px; vertical-align:middle; }
.view details { border-top:1px solid var(--line); }
.view details > summary { cursor:pointer; padding:10px 2px; color:var(--ink); font-size:13px; font-weight:600; list-style:none; }
.view details > summary::-webkit-details-marker { display:none; }
.view details > summary::before { content:'▸ '; color:var(--muted); }
.view details[open] > summary::before { content:'▾ '; }
.edge-label.dim { opacity:0.1; }

/* zoom controls */
.zoom-ctl { position:absolute; left:16px; bottom:16px; display:flex; flex-direction:column; gap:6px; z-index:5; }
.zoom-btn {
  width:36px; height:36px; border-radius:9px; border:1px solid var(--line);
  background:rgba(20,29,51,0.92); color:var(--ink); font-size:18px; font-weight:700;
  cursor:pointer; display:flex; align-items:center; justify-content:center; font-family:inherit;
  transition:border-color .15s;
}
.zoom-btn:hover { border-color:var(--blue); }
.zoom-fit { font-size:11px; letter-spacing:0.06em; }

/* minimap */
.minimap {
  position:absolute; left:50%; transform:translateX(-50%); bottom:16px;
  width:240px; height:130px; border:1px solid var(--line); border-radius:10px;
  background:rgba(10,14,26,0.82); overflow:hidden; z-index:4; backdrop-filter:blur(4px);
}
#minimap-svg { width:100%; height:100%; opacity:0.7; }
.minimap-viewport {
  position:absolute; border:1.5px solid var(--blue); background:rgba(106,160,255,0.10);
  border-radius:3px; pointer-events:none;
}

/* info / tour panel */
.info-panel {
  width:340px; flex:0 0 340px; border-left:1px solid var(--line);
  background:rgba(16,23,40,0.72); backdrop-filter:blur(8px);
  padding:22px 22px 40px; overflow-y:auto;
}
.info-eyebrow { font-size:10px; font-weight:700; letter-spacing:0.14em; color:var(--gold); margin-bottom:6px; }
.info-title { font-size:20px; font-weight:700; line-height:1.2; }
.info-sub { color:var(--muted); font-size:12px; margin-top:4px; }
/* 3-up grid that always fits the panel width — equal columns, no minimum that
   could push a tile past the edge. Big values shrink to fit; labels wrap. */
.info-headline-cards { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin:18px 0; }
.info-hc { min-width:0; background:var(--raised); border:1px solid var(--line); border-radius:10px; padding:10px 8px; overflow:hidden; }
.ihc-v {
  font-size:14px; font-weight:700; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:-0.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.ihc-k { font-size:8.5px; color:var(--muted); text-transform:uppercase; letter-spacing:0; margin-top:4px; line-height:1.3; overflow-wrap:normal; word-break:keep-all; }
.info-body { color:var(--muted); font-size:13px; line-height:1.55; }
.info-section { font-size:10px; font-weight:700; letter-spacing:0.1em; color:var(--muted); margin:18px 0 8px; }
.info-row { display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid var(--line); font-size:13px; }
.info-row .ir-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.info-row .ir-meta { color:var(--muted); font-family:ui-monospace,Menlo,monospace; font-size:12px; flex:0 0 auto; }
.info-row.seam .ir-name { color:var(--ink); }
.info-more, .tour-start {
  margin-top:18px; width:100%; background:var(--raised); border:1px solid var(--line);
  color:var(--ink); border-radius:10px; padding:10px 14px; cursor:pointer; font-weight:600;
  font-family:inherit; font-size:13px; transition:border-color .15s;
}
.info-more:hover, .tour-start:hover { border-color:var(--blue); }
.tour-start { background:color-mix(in srgb, var(--blue) 16%, var(--raised)); border-color:rgba(106,160,255,0.4); }
.info-hint { color:var(--muted); font-size:11px; margin-top:14px; line-height:1.5; }

/* tour controls */
.tour-counter { font-size:10px; font-weight:700; letter-spacing:0.12em; color:var(--blue); margin-bottom:6px; }
.tour-nav { display:flex; gap:8px; margin-top:18px; }
.tour-nav button {
  flex:1; background:var(--raised); border:1px solid var(--line); color:var(--ink);
  border-radius:9px; padding:9px; cursor:pointer; font-weight:600; font-family:inherit; font-size:13px;
  transition:border-color .15s;
}
.tour-nav button:hover:not(:disabled) { border-color:var(--blue); }
.tour-nav button:disabled { opacity:0.4; cursor:default; }
.tour-exit { margin-top:8px; width:100%; background:transparent; border:none; color:var(--muted); cursor:pointer; font-family:inherit; font-size:12px; padding:6px; }
.tour-exit:hover { color:var(--ink); }

/* category cards */
.cat-cards { display:flex; align-items:center; gap:10px; padding:12px 22px; border-top:1px solid var(--line); overflow-x:auto; }
.cat-cards-label { font-size:10px; font-weight:700; letter-spacing:0.08em; color:var(--muted); flex:0 0 auto; margin-right:4px; }
.cat-card {
  flex:0 0 auto; background:var(--raised); border:1px solid var(--line); border-radius:10px;
  padding:9px 14px; cursor:pointer; font-family:inherit; text-align:left; transition:border-color .15s, opacity .15s;
}
.cat-card:hover { border-color:var(--blue); }
.cat-card.active { border-color:var(--gold); }
.cat-card.dim { opacity:0.45; }
.cat-name { font-size:12px; font-weight:700; text-transform:capitalize; color:var(--ink);
  max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cat-meta { font-size:11px; color:var(--muted); margin-top:3px; white-space:nowrap; }
.cat-count { color:var(--ink); font-family:ui-monospace,Menlo,monospace; }
.cat-card .cat-dot { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:6px; vertical-align:middle; }

/* ---- drill overlay ---- */
.drill-overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; z-index:50; }
.drill-overlay.open { display:block; }
.drill-panel { position:fixed; top:0; right:0; height:100%; width:min(760px,94vw); background:var(--bg);
  border-left:1px solid var(--line); box-shadow:-12px 0 40px rgba(0,0,0,.5); overflow-y:auto; padding:20px 24px 60px; }
.drill-close { position:sticky; top:0; float:right; background:var(--raised); border:1px solid var(--line);
  color:var(--ink); border-radius:8px; padding:6px 12px; cursor:pointer; font-weight:600; font-family:inherit; }
.drill-head { font-size:18px; margin:6px 0 8px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }

/* focus visibility */
button:focus-visible, .chip:focus-visible, .cat-card:focus-visible, .tab:focus-visible, input:focus-visible {
  outline:2px solid var(--blue); outline-offset:2px;
}

/* responsive */
@media (max-width:980px) {
  .info-panel { width:280px; flex-basis:280px; }
  .minimap { display:none; }
}
@media (max-width:760px) {
  .map-stage { flex-direction:column; }
  .info-panel { width:auto; flex:0 0 auto; border-left:none; border-top:1px solid var(--line); max-height:40vh; }
  .map-view.active { height:auto; }
  .map-canvas-wrap { min-height:380px; }
}
@media (prefers-reduced-motion:reduce) {
  * { transition:none !important; scroll-behavior:auto !important; }
}
`;

// =============================================================================
// CLIENT_SCRIPT — tabs, pan/zoom, search, filters, tour, drill-down.
// Reads window.__MODEL__ + window.__VIEWS__ (set by both shells). No network.
// =============================================================================
export const CLIENT_SCRIPT = `
(function(){
  var MODEL = window.__MODEL__, V = window.__VIEWS__;

  // ---------- tabs ----------
  function showView(id){
    document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
    document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
    var view = document.getElementById(id); if(view) view.classList.add('active');
    var tab = document.querySelector('.tab[data-view="'+id+'"]'); if(tab) tab.classList.add('active');
    if(id === 'v-map' && MAP) { MAP.refit(); }
  }

  // ---------- drill overlay ----------
  function openDrill(html){
    var overlay = document.getElementById('drill-overlay');
    var body = document.getElementById('drill-body');
    if(!overlay || !body) return;
    body.innerHTML = '<button class="drill-close" id="drill-close">Close ✕</button>' + html;
    overlay.classList.add('open');
    var c = document.getElementById('drill-close'); if(c) c.addEventListener('click', closeDrill);
  }
  function closeDrill(){ var o=document.getElementById('drill-overlay'); if(o) o.classList.remove('open'); }
  function drill(kind, id){
    if(!MODEL || !V) return;
    if(kind === 'stage') openDrill(V.stageDrill(MODEL, id));
    else if(kind === 'journey') openDrill(V.journeyDrill(MODEL, id));
  }

  // ---------- MAP controller ----------
  // Architecture: ONE .map-world div (holding the SVG edges + HTML node cards,
  // all in shared world coordinates) is pan/zoomed by a SINGLE CSS transform:
  //   transform: translate(tx,ty) scale(s)   (transform-origin:0 0)
  // This scales the HTML cards AND the SVG edges together — no foreignObject, no
  // detachment. All math is screen↔world: screen = world*s + t.
  var MAP = null;
  function initMap(){
    var wrap = document.getElementById('map-canvas-wrap');
    var world = document.getElementById('map-world');
    if(!wrap || !world) return null;
    var W = +world.getAttribute('data-w'), H = +world.getAttribute('data-h');
    // (tx,ty) = screen px offset of world origin; scale = screen-px per world-px.
    var tx=0, ty=0, scale=1;
    var minS=0.12, maxS=2.6;

    function apply(){
      world.style.transform = 'translate('+tx+'px,'+ty+'px) scale('+scale+')';
      updateMinimap();
    }
    function vp(){ return wrap.getBoundingClientRect(); }
    // screen client px -> world units
    function toWorld(clientX, clientY){
      var r = vp();
      return { x:(clientX - r.left - tx)/scale, y:(clientY - r.top - ty)/scale };
    }
    function fit(){
      var r = vp(); if(!r.width || !r.height) return;
      var pad = 36;
      var s = Math.min((r.width - pad*2)/W, (r.height - pad*2)/H);
      s = Math.max(minS, Math.min(maxS, s || 1));
      scale = s;
      // center the world inside the (panel-excluded) viewport
      tx = (r.width - W*scale)/2;
      ty = (r.height - H*scale)/2;
      apply();
    }
    function zoomAt(factor, clientX, clientY){
      var r = vp();
      var cx, cy;
      if(clientX==null){ cx = r.left + r.width/2; cy = r.top + r.height/2; }
      else { cx = clientX; cy = clientY; }
      var w = toWorld(cx, cy);
      var ns = Math.max(minS, Math.min(maxS, scale*factor));
      // keep the world point under the cursor pinned to the same screen spot:
      // screen = world*s + t  =>  t = screen - world*s
      tx = (cx - r.left) - w.x*ns;
      ty = (cy - r.top) - w.y*ns;
      scale = ns; apply();
    }
    function centerWorld(wx, wy){
      var r = vp();
      tx = r.width/2 - wx*scale;
      ty = r.height/2 - wy*scale;
      apply();
    }
    function focusNode(id){
      var n = world.querySelector('.node-card[data-id="'+CSS.escape(id)+'"]');
      if(!n) return;
      var wx = +n.getAttribute('data-cx'), wy = +n.getAttribute('data-cy');
      scale = Math.max(scale, Math.min(maxS, 1.0));
      centerWorld(wx, wy); selectNode(id);
    }
    function panToWorld(wx, wy){ centerWorld(wx, wy); }

    // ---- minimap (static W×H schematic + live viewport overlay) ----
    var miniVp = document.getElementById('minimap-viewport');
    var mini = document.getElementById('minimap');
    function updateMinimap(){
      if(!miniVp || !mini) return;
      var mr = mini.getBoundingClientRect();
      if(!mr.width) return;
      var ms = Math.min(mr.width/W, mr.height/H);
      var offx = (mr.width - W*ms)/2, offy=(mr.height - H*ms)/2;
      // visible world rect = the part of the world currently inside the viewport
      var r = vp();
      var wx = -tx/scale, wy = -ty/scale;
      var ww = r.width/scale, wh = r.height/scale;
      var cwx = Math.max(0, wx), cwy = Math.max(0, wy);
      var cww = Math.min(W, wx+ww) - cwx, cwh = Math.min(H, wy+wh) - cwy;
      miniVp.style.left = (offx + cwx*ms)+'px';
      miniVp.style.top = (offy + cwy*ms)+'px';
      miniVp.style.width = Math.max(6, cww*ms)+'px';
      miniVp.style.height = Math.max(6, cwh*ms)+'px';
    }

    // ---- pan (drag) ----
    var dragging=false, sx0=0, sy0=0, tx0=0, ty0=0, moved=false;
    wrap.addEventListener('pointerdown', function(e){
      if(e.target.closest('.zoom-ctl') || e.target.closest('.minimap') || e.target.closest('.info-panel')) return;
      dragging=true; moved=false; sx0=e.clientX; sy0=e.clientY; tx0=tx; ty0=ty;
      try{ wrap.setPointerCapture(e.pointerId); }catch(_){}
    });
    wrap.addEventListener('pointermove', function(e){
      if(!dragging) return;
      var dx=e.clientX-sx0, dy=e.clientY-sy0;
      if(Math.abs(dx)+Math.abs(dy) > 2) moved=true;
      tx = tx0+dx; ty = ty0+dy; apply();
    });
    wrap.addEventListener('pointerup', function(e){
      dragging=false;
      try{ wrap.releasePointerCapture(e.pointerId); }catch(_){}
      if(!moved){
        var node = e.target.closest && e.target.closest('.node-card');
        if(node){ selectNode(node.getAttribute('data-id')); }
      }
    });

    // ---- wheel zoom (cursor-anchored) ----
    wrap.addEventListener('wheel', function(e){
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.12 : 1/1.12;
      zoomAt(factor, e.clientX, e.clientY);
    }, {passive:false});

    // ---- keyboard on nodes ----
    world.addEventListener('keydown', function(e){
      var node = e.target.closest && e.target.closest('.node-card');
      if(node && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); selectNode(node.getAttribute('data-id')); }
    });

    var zi=document.getElementById('zoom-in'), zo=document.getElementById('zoom-out'), zf=document.getElementById('zoom-fit');
    if(zi) zi.addEventListener('click', function(){ zoomAt(1.2); });
    if(zo) zo.addEventListener('click', function(){ zoomAt(1/1.2); });
    if(zf) zf.addEventListener('click', fit);

    if(mini){
      mini.addEventListener('pointerdown', function(e){
        var mr = mini.getBoundingClientRect();
        var ms = Math.min(mr.width/W, mr.height/H);
        var offx=(mr.width-W*ms)/2, offy=(mr.height-H*ms)/2;
        var wx=(e.clientX-mr.left-offx)/ms, wy=(e.clientY-mr.top-offy)/ms;
        panToWorld(wx,wy);
      });
    }

    window.addEventListener('resize', function(){ updateMinimap(); });

    // Reset == fit the whole stream (the signature default on load).
    function reset(){ fit(); }

    return { fit:fit, reset:reset, refit:fit, focusNode:focusNode };
  }

  // ---------- node selection + info panel ----------
  function selectNode(id){
    document.querySelectorAll('.node-card').forEach(function(n){ n.classList.toggle('selected', n.getAttribute('data-id')===id); });
    var panel = document.getElementById('info-panel');
    if(panel && V && MODEL){ panel.innerHTML = V.stageInfo(MODEL, id); }
  }

  // ---------- search (fuzzy) ----------
  function fuzzy(hay, needle){
    if(!needle) return true;
    hay = hay.toLowerCase(); needle = needle.toLowerCase();
    var hi=0;
    for(var i=0;i<needle.length;i++){
      hi = hay.indexOf(needle[i], hi);
      if(hi === -1) return false;
      hi++;
    }
    return true;
  }
  function runSearch(q){
    q = (q||'').trim();
    document.querySelectorAll('.node-card').forEach(function(n){
      var hay = n.getAttribute('data-search')||'';
      var match = q && fuzzy(hay, q);
      n.classList.toggle('match', !!match);
      n.classList.toggle('dim', !!q && !match);
    });
  }

  // ---------- filter chips ----------
  var filters = { source:new Set(), status:new Set(), category:new Set() };
  function catStages(cat){
    // stages served by any service in this category
    var set = new Set();
    if(!MODEL) return set;
    MODEL.services.forEach(function(s){ if(s.category===cat){ (s.stages_served||[]).forEach(function(st){ set.add(st); }); } });
    return set;
  }
  function applyFilters(){
    var anySrc = filters.source.size>0, anyStatus = filters.status.size>0, anyCat = filters.category.size>0;
    var catSet = new Set();
    filters.category.forEach(function(c){ catStages(c).forEach(function(st){ catSet.add(st); }); });
    document.querySelectorAll('.node-card').forEach(function(n){
      var srcs = (n.getAttribute('data-sources')||'').split(',');
      var status = n.getAttribute('data-status');
      var id = n.getAttribute('data-id');
      var ok = true;
      if(anySrc) ok = ok && srcs.some(function(s){ return filters.source.has(s); });
      if(anyStatus) ok = ok && filters.status.has(status);
      if(anyCat) ok = ok && catSet.has(id);
      n.classList.toggle('dim', !ok);
    });
  }
  function toggleChip(btn){
    var kind = btn.getAttribute('data-chip'), val = btn.getAttribute('data-val');
    var set = filters[kind]; if(!set) return;
    if(set.has(val)){ set.delete(val); btn.classList.remove('active'); }
    else { set.add(val); btn.classList.add('active'); }
    applyFilters();
    // mark category chips that exist in both the bottom cards and any filter row
    document.querySelectorAll('[data-chip="'+kind+'"][data-val="'+CSS.escape(val)+'"]').forEach(function(el){
      el.classList.toggle('active', set.has(val));
    });
  }

  // ---------- tour ----------
  var TOUR = { steps:[], i:0, on:false };
  function startTour(){
    if(!V || !MODEL) return;
    TOUR.steps = V.buildTour(MODEL); TOUR.i=0; TOUR.on=true;
    renderTour();
  }
  function renderTour(){
    var panel = document.getElementById('info-panel'); if(!panel) return;
    var s = TOUR.steps[TOUR.i]; if(!s){ exitTour(); return; }
    var n = TOUR.steps.length;
    panel.innerHTML =
      '<div class="tour-counter">TOUR '+(TOUR.i+1)+'/'+n+'</div>'+
      '<div class="info-eyebrow">'+s.eyebrow+'</div>'+
      '<div class="info-title">'+s.title+'</div>'+
      '<p class="info-body" style="margin-top:14px">'+s.body+'</p>'+
      '<div class="tour-nav">'+
        '<button id="tour-prev"'+(TOUR.i===0?' disabled':'')+'>‹ Prev</button>'+
        '<button id="tour-next">'+(TOUR.i===n-1?'Done':'Next ›')+'</button>'+
      '</div>'+
      '<button class="tour-exit" id="tour-exit">Exit Tour</button>';
    document.querySelectorAll('.node-card').forEach(function(node){ node.classList.remove('selected'); });
    if(s.target && MAP){ MAP.focusNode(s.target); }
    var p=document.getElementById('tour-prev'), nx=document.getElementById('tour-next'), ex=document.getElementById('tour-exit');
    if(p) p.addEventListener('click', function(){ if(TOUR.i>0){TOUR.i--; renderTour();} });
    if(nx) nx.addEventListener('click', function(){ if(TOUR.i<n-1){TOUR.i++; renderTour();} else exitTour(); });
    if(ex) ex.addEventListener('click', exitTour);
  }
  function exitTour(){
    TOUR.on=false;
    var panel = document.getElementById('info-panel');
    if(panel && V && MODEL) panel.innerHTML = V.mapInfoDefault(MODEL);
    wireInfoDefault();
  }

  // ---------- export ----------
  function exportModel(){
    if(!MODEL) return;
    var blob = new Blob([JSON.stringify(MODEL, null, 2)], {type:'application/json'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (MODEL.meta && MODEL.meta.vertical ? MODEL.meta.vertical : 'throughline') + '.model.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
  }

  // ---------- wiring ----------
  function wireInfoDefault(){
    var t = document.getElementById('tour-start'); if(t) t.addEventListener('click', startTour);
  }
  function wire(){
    MODEL = window.__MODEL__; V = window.__VIEWS__;
    MAP = initMap();
    // open framed to the FULL value stream — double-rAF so the canvas has its
    // final layout dimensions before fit() measures (avoids a load-race that
    // leaves the map zoomed into one cluster).
    if(MAP) requestAnimationFrame(function(){ requestAnimationFrame(function(){ MAP.fit(); }); });
    wireInfoDefault();

    var search = document.getElementById('map-search');
    if(search) search.addEventListener('input', function(){ runSearch(search.value); });

    var ex = document.getElementById('export-model'); if(ex) ex.addEventListener('click', exportModel);

    document.addEventListener('click', function(ev){
      var tab = ev.target.closest && ev.target.closest('.tab[data-view]');
      if(tab){ showView(tab.getAttribute('data-view')); return; }
      var chip = ev.target.closest && ev.target.closest('.chip[data-chip], .cat-card[data-chip]');
      if(chip){ toggleChip(chip); return; }
      var d = ev.target.closest && ev.target.closest('[data-drill]');
      if(d){ drill(d.getAttribute('data-drill'), d.getAttribute('data-id')); return; }
      var overlay = document.getElementById('drill-overlay');
      if(ev.target === overlay) closeDrill();
    });
    document.addEventListener('keydown', function(ev){
      if(ev.key === 'Escape'){ closeDrill(); if(TOUR.on) exitTour(); }
    });
  }

  // Boot is explicit so the served (async-fetch) path can call it AFTER the
  // model + views are injected, while the static path can call it on load.
  window.__BOOT__ = wire;
  if(window.__MODEL__ && window.__VIEWS__){
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }
})();
`;

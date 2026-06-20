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
 * The interactivity layer (tab switching + click-through drill-down) is the
 * CLIENT_SCRIPT string at the bottom: it is inert in the static file (the views
 * are all present, drill-down panels render on click from the embedded model)
 * and fully live in the served dashboard.
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

function stageColor(model, id) {
  return model.stages.find((s) => s.id === id)?.color ?? '#64748b';
}
function stageLabel(model, id) {
  return model.stages.find((s) => s.id === id)?.label ?? id ?? '—';
}

// =============================================================================
// LEDGER view
// =============================================================================
export function ledgerView(model) {
  const l = model.ledger;
  const seg = (cls, pct, n, label) =>
    pct > 0 ? `<div class="${cls}" style="width:${pct}%">${pct}% ${label}</div>` : '';
  const d = model.diagnostics;
  const svc = d.services;
  const byId = new Map(model.events.map((e) => [e.event_id, e]));
  return `<div class="view active" id="v-ledger">
    <div class="section">The honest ledger</div>
    <div class="note">Every journey classified by provenance. We are explicit about what is known vs. guessed. Click a journey to drill into its events.</div>
    <div class="ledger-bar">
      ${seg('seg-r', l.pct_reconstructed, l.reconstructed, 'reconstructed')}
      ${seg('seg-i', l.pct_inferred, l.inferred, 'inferred')}
      ${seg('seg-o', l.pct_orphaned, l.could_not_connect, 'could-not-connect')}
    </div>
    <div class="cards">
      <div class="card"><div class="k">Journeys</div><div class="v">${l.total_journeys}</div></div>
      <div class="card"><div class="k good">Reconstructed</div><div class="v">${l.reconstructed}</div></div>
      <div class="card"><div class="k warn">Inferred</div><div class="v">${l.inferred}</div></div>
      <div class="card"><div class="k bad">Could-not-connect</div><div class="v">${l.could_not_connect}</div></div>
      <div class="card"><div class="k">End-to-end median</div><div class="v">${days(d.endToEndMedianMs)}</div></div>
      <div class="card"><div class="k">Events</div><div class="v">${model.events.length}</div></div>
    </div>
    ${
      svc
        ? `<div class="cards">
      <div class="card"><div class="k">Service spend / mo</div><div class="v">${money(svc.totalMonthlyServiceSpend)}</div></div>
      <div class="card"><div class="k bad">Spend in gaps / mo</div><div class="v bad">${money(svc.spendInGapsMonthly)}</div></div>
      <div class="card"><div class="k">Cost / journey</div><div class="v">${money(svc.costPerJourney)}</div></div>
      <div class="card"><div class="k">Services</div><div class="v">${model.services.length}</div></div>
    </div>`
        : ''
    }
    <div class="section">Journeys</div>
    <table><thead><tr><th>Entity</th><th>Provenance</th><th>Stages</th><th>Conf.</th><th>Links</th></tr></thead><tbody>
    ${model.journeys
      .slice()
      .sort((a, b) => b.event_ids.length - a.event_ids.length)
      .slice(0, 200)
      .map((j) => {
        const cls =
          j.provenance === 'reconstructed' ? 'p-recon' : j.provenance === 'inferred' ? 'p-inf' : 'p-orph';
        const dots = j.event_ids
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map(
            (e) =>
              `<span class="stage-dot" style="background:${stageColor(model, e.stage)}" title="${esc(
                stageLabel(model, e.stage),
              )}"></span>`,
          )
          .join('');
        return `<tr class="clickable" data-drill="journey" data-id="${esc(j.entity_id)}"><td class="mono">${esc(
          j.entity_id,
        )}</td><td><span class="pill ${cls}">${j.provenance}</span></td>
          <td>${dots} <span class="note">${j.event_ids.length} events</span></td>
          <td>${j.confidence.toFixed(2)}</td><td>${j.links.length}</td></tr>`;
      })
      .join('')}
    </tbody></table>
  </div>`;
}

// =============================================================================
// STAGE view (value-stream altitude). Stage rows are click-through.
// =============================================================================
export function stageView(model) {
  const d = model.diagnostics;
  const svcPerStage = new Map((d.services?.perStage ?? []).map((s) => [s.stage, s]));
  const servicesById = new Map(model.services.map((s) => [s.service_id, s]));

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
// STAGE DRILL-DOWN — the click-through payload for one stage. Rendered into the
// drill panel (browser) or appended as a <details> block (static fallback).
// =============================================================================
export function stageDrill(model, stageId) {
  const d = model.diagnostics;
  const sd = d.stages.find((s) => s.stage === stageId);
  if (!sd) return `<div class="note">Unknown stage ${esc(stageId)}.</div>`;
  const ss = (d.services?.perStage ?? []).find((s) => s.stage === stageId);
  const servicesById = new Map(model.services.map((s) => [s.service_id, s]));

  // Underlying source events that landed at this stage.
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

  // Apps powering this stage (the service-architecture bridge for this stage).
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

  // Interval seams (bottlenecks) touching this stage.
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
  const d = model.diagnostics.services;
  const byStage = new Map();
  const orphans = [];
  for (const s of model.services) {
    const mapped = s.stages_served.filter((st) => model.stages.some((x) => x.id === st));
    if (mapped.length === 0) orphans.push(s);
    for (const st of mapped) {
      if (!byStage.has(st)) byStage.set(st, []);
      byStage.get(st).push(s);
    }
  }
  const svcRow = (s) => {
    const util =
      s.seats != null && s.utilized_seats != null && s.seats > 0
        ? Math.round((s.utilized_seats / s.seats) * 100)
        : null;
    const utilCls = util != null && util < 60 ? 'bad' : '';
    return `<tr>
      <td>${esc(s.name)}</td><td>${esc(s.category)}</td><td>${esc(s.vendor)}</td>
      <td class="note">${esc(s.cost_model)}</td>
      <td class="right">${money(s.monthly_cost)}</td>
      <td class="right ${utilCls}">${util != null ? util + '%' : '—'}</td></tr>`;
  };

  const stageBlocks = model.stages
    .filter((st) => byStage.has(st.id))
    .map((st) => {
      const list = byStage.get(st.id);
      const total = list.reduce((a, b) => a + b.monthly_cost, 0);
      return `<details open><summary class="clickable" data-drill="stage" data-id="${esc(
        st.id,
      )}"><span class="stage-dot" style="background:${st.color}"></span>${esc(
        st.label,
      )} — ${list.length} apps, ${money(total)}/mo gross <span class="note">(click label to drill)</span></summary>
        <table><thead><tr><th>App</th><th>Category</th><th>Vendor</th><th>Model</th><th class="right">$/mo</th><th class="right">Seat util</th></tr></thead>
        <tbody>${list.map(svcRow).join('')}</tbody></table></details>`;
    })
    .join('');

  const sprawl = (d?.appSprawl ?? [])
    .map(
      (s) =>
        `<tr><td>${esc(s.category)}</td><td>${s.service_ids.length} tools</td>
        <td>${s.overlappingStages.map((x) => esc(stageLabel(model, x))).join(', ')}</td>
        <td class="right">${money(s.monthlyCost)}</td></tr>`,
    )
    .join('');

  return `<div class="view" id="v-service">
    <div class="section">Service architecture — what the work runs on</div>
    <div class="cards">
      <div class="card"><div class="k">Total spend/mo</div><div class="v">${money(d.totalMonthlyServiceSpend)}</div></div>
      <div class="card"><div class="k bad">Spend in gaps/mo</div><div class="v bad">${money(d.spendInGapsMonthly)}</div></div>
      <div class="card"><div class="k">Categories sprawled</div><div class="v">${d.appSprawl.length}</div></div>
      <div class="card"><div class="k warn">Vendor-locked stages</div><div class="v">${d.vendorConcentrationStages.length}</div></div>
    </div>
    <div class="section">Apps grouped by the stage they power</div>
    ${stageBlocks || '<div class="note">No service maps to a captured stage.</div>'}
    ${
      orphans.length
        ? `<div class="section bad">Orphan apps — paid, power no captured stage (${orphans.length})</div>
      <table><thead><tr><th>App</th><th>Category</th><th>Vendor</th><th>Model</th><th class="right">$/mo</th><th class="right">Seat util</th></tr></thead>
      <tbody>${orphans.map(svcRow).join('')}</tbody></table>`
        : ''
    }
    ${
      sprawl
        ? `<div class="section">App-sprawl index — overlapping tools in one category</div>
      <table><thead><tr><th>Category</th><th>Tools</th><th>Overlapping stages</th><th class="right">$/mo</th></tr></thead><tbody>${sprawl}</tbody></table>`
        : ''
    }
  </div>`;
}

// =============================================================================
// GAPS view (spend-in-gaps + value-stream gaps, held to the honesty standard).
// =============================================================================
export function gapsView(model) {
  const g = model.gaps;
  const spendGaps = g.filter(
    (x) =>
      x.type === 'orphan_service' || x.type === 'underutilized_service' || x.type === 'redundant_service',
  );
  const spendTotal = spendGaps.reduce((a, b) => a + (b.cost ?? 0), 0);
  const vsGaps = g.filter((x) => !spendGaps.includes(x));

  const gapRow = (x) =>
    `<tr class="gap-${x.type}"><td><b>${esc(x.type)}</b></td>
      <td>${x.cost != null ? money(x.cost) + '/mo' : x.interval_ms != null ? days(x.interval_ms) : '—'}</td>
      <td>${esc(x.detail)}</td><td class="right">${x.confidence.toFixed(2)}</td></tr>`;

  return `<div class="view" id="v-gaps">
    <div class="section bad">Spend flowing into gaps: ${money(spendTotal)}/mo</div>
    <div class="note">Held to the same honesty standard as the journey ledger. An orphan app is the service-architecture twin of an interval seam nobody owns.</div>
    ${
      spendGaps.length
        ? `<table><thead><tr><th>Type</th><th>Cost</th><th>Detail</th><th class="right">Conf.</th></tr></thead><tbody>${spendGaps
            .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
            .map(gapRow)
            .join('')}</tbody></table>`
        : '<div class="note">No service-spend gaps detected.</div>'
    }
    <div class="section">Value-stream gaps (${vsGaps.length})</div>
    <div class="note">Linkage gaps, interval seams (bottlenecks), and missing-expected-stage gaps — never silently dropped.</div>
    <table><thead><tr><th>Type</th><th>Interval</th><th>Detail</th><th class="right">Conf.</th></tr></thead><tbody>
      ${vsGaps
        .slice()
        .sort((a, b) => (b.interval_ms ?? 0) - (a.interval_ms ?? 0))
        .slice(0, 300)
        .map(gapRow)
        .join('')}</tbody></table>
  </div>`;
}

// =============================================================================
// EVENT view (every record, the substrate). Rows are click-through to the stage.
// =============================================================================
export function eventView(model) {
  const rows = model.events
    .slice(0, 1000)
    .map(
      (e) => `<tr class="clickable" data-drill="stage" data-id="${esc(e.stage)}">
      <td class="mono">${esc(e.event_id)}</td><td>${esc(e.event)}</td>
      <td><span class="stage-dot" style="background:${stageColor(model, e.stage)}"></span>${esc(
        stageLabel(model, e.stage),
      )}</td>
      <td class="note">${esc(e.source ?? '—')}</td>
      <td class="note">${esc(e.timestamp ?? '—')}</td><td>${esc(e.actor ?? '—')}</td>
      <td class="right">${e.cost != null ? money(e.cost) : '—'}</td>
      <td class="mono">${esc(e.entity_id ?? '—')}</td></tr>`,
    )
    .join('');
  return `<div class="view" id="v-event">
    <div class="section">Normalized events — the substrate</div>
    <div class="note">Every source row collapsed to the common event model. Click a row to drill into its stage. Showing up to 1000 of ${model.events.length}.</div>
    <table><thead><tr><th>ID</th><th>Event</th><th>Stage</th><th>Source</th><th>Timestamp</th><th>Actor</th><th class="right">Cost</th><th>Journey</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>`;
}

// =============================================================================
// Assembly: tabs + all views. Shared by static and served.
// =============================================================================
export function buildTabs() {
  return [
    ['v-ledger', 'Ledger', true],
    ['v-stage', 'Stages & cost', false],
    ['v-service', 'Service architecture', false],
    ['v-gaps', 'Gaps & spend-in-gaps', false],
    ['v-event', 'Events', false],
  ]
    .map(
      ([id, label, active]) =>
        `<div class="tab${active ? ' active' : ''}" data-view="${id}">${label}</div>`,
    )
    .join('');
}

export function buildViews(model) {
  return [
    ledgerView(model),
    stageView(model),
    serviceView(model),
    gapsView(model),
    eventView(model),
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
// Shared style.
// =============================================================================
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
tr.clickable { cursor:pointer; }
tr.clickable:hover td { background:rgba(59,130,246,.14); }
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
.drill-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); display:none; z-index:50; }
.drill-overlay.open { display:block; }
.drill-panel { position:fixed; top:0; right:0; height:100%; width:min(760px,94vw); background:var(--bg);
  border-left:1px solid var(--line); box-shadow:-12px 0 40px rgba(0,0,0,.5); overflow-y:auto; padding:20px 24px 60px; }
.drill-close { position:sticky; top:0; float:right; background:var(--panel2); border:1px solid var(--line);
  color:var(--ink); border-radius:8px; padding:6px 12px; cursor:pointer; font-weight:600; }
.drill-head { font-size:18px; margin:6px 0 8px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
`;

// =============================================================================
// CLIENT_SCRIPT — tab switching + click-through drill-down.
//
// Reads the model already embedded in the page (window.__MODEL__) and the
// drill builders (window.__VIEWS__), so drill-down is instant and works whether
// the model was inlined (static) or fetched (served). No further network calls.
// =============================================================================
export const CLIENT_SCRIPT = `
(function(){
  function showView(id){
    document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
    document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
    var view = document.getElementById(id); if(view) view.classList.add('active');
    var tab = document.querySelector('.tab[data-view="'+id+'"]'); if(tab) tab.classList.add('active');
  }
  function openDrill(html){
    var overlay = document.getElementById('drill-overlay');
    var body = document.getElementById('drill-body');
    body.innerHTML = '<button class="drill-close" id="drill-close">Close ✕</button>' + html;
    overlay.classList.add('open');
    document.getElementById('drill-close').addEventListener('click', closeDrill);
  }
  function closeDrill(){ document.getElementById('drill-overlay').classList.remove('open'); }
  function drill(kind, id){
    var model = window.__MODEL__, V = window.__VIEWS__;
    if(!model || !V) return;
    if(kind === 'stage') openDrill(V.stageDrill(model, id));
    else if(kind === 'journey') openDrill(V.journeyDrill(model, id));
  }
  document.addEventListener('click', function(ev){
    var tab = ev.target.closest && ev.target.closest('.tab[data-view]');
    if(tab){ showView(tab.getAttribute('data-view')); return; }
    var d = ev.target.closest && ev.target.closest('[data-drill]');
    if(d){
      // don't hijack the native <details> toggle when clicking the summary chevron area
      drill(d.getAttribute('data-drill'), d.getAttribute('data-id'));
    }
    var overlay = document.getElementById('drill-overlay');
    if(ev.target === overlay) closeDrill();
  });
  document.addEventListener('keydown', function(ev){ if(ev.key === 'Escape') closeDrill(); });
})();
`;

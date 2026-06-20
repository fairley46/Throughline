/**
 * render.mjs — model-first HTML generator.
 *
 * Reads ONLY the persisted ValueStreamModel (never raw input). Renders:
 *   - LEDGER  the honest reconstructed/inferred/orphaned headline (never hidden)
 *   - STAGE   per-stage rollup with cost/cycle + per-stage app & cost drill-down
 *             (the service-architecture bridge) + bottlenecks
 *   - SERVICE the service-architecture view: services grouped by the stage they
 *             power, with cost/seat-utilization/category
 *   - GAPS    value-stream gaps AND service gaps (spend-in-gaps) surfaced as
 *             visibly as the journey ledger — same honesty principle
 *   - EVENT   the raw normalized-event substrate (source drill-down)
 *
 * Exposes renderModel(model) -> html string.
 */

import { page, esc, money, days } from './template.mjs';

function stageColor(model, id) {
  return model.stages.find((s) => s.id === id)?.color ?? '#64748b';
}
function stageLabel(model, id) {
  return model.stages.find((s) => s.id === id)?.label ?? id ?? '—';
}

// --------------------------------------------------------------------------
function ledgerView(model) {
  const l = model.ledger;
  const seg = (cls, pct, n, label) =>
    pct > 0 ? `<div class="${cls}" style="width:${pct}%">${pct}% ${label}</div>` : '';
  const d = model.diagnostics;
  const svc = d.services;
  return `<div class="view active" id="v-ledger">
    <div class="section">The honest ledger</div>
    <div class="note">Every journey classified by provenance. We are explicit about what is known vs. guessed.</div>
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
        const byId = new Map(model.events.map((e) => [e.event_id, e]));
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
        return `<tr><td class="mono">${esc(j.entity_id)}</td><td><span class="pill ${cls}">${j.provenance}</span></td>
          <td>${dots} <span class="note">${j.event_ids.length} events</span></td>
          <td>${j.confidence.toFixed(2)}</td><td>${j.links.length}</td></tr>`;
      })
      .join('')}
    </tbody></table>
  </div>`;
}

// --------------------------------------------------------------------------
function stageView(model) {
  const d = model.diagnostics;
  const svcPerStage = new Map((d.services?.perStage ?? []).map((s) => [s.stage, s]));
  const servicesById = new Map(model.services.map((s) => [s.service_id, s]));

  const rows = d.stages
    .map((sd) => {
      const ss = svcPerStage.get(sd.stage);
      const apps = (ss?.service_ids ?? [])
        .map((id) => servicesById.get(id))
        .filter(Boolean)
        .map(
          (s) =>
            `<div class="kvs"><span>${esc(s.name)} <span class="note">(${esc(
              s.category,
            )})</span></span><span>${money(s.monthly_cost)}/mo</span><span>${
              s.seats != null ? `${s.utilized_seats ?? '?'}/${s.seats} seats` : ''
            }</span></div>`,
        )
        .join('');
      const concentration =
        ss?.singleVendor && ss.toolingCost > 0
          ? `<span class="warn"> ⚠ single-vendor (${esc(ss.vendors[0])})</span>`
          : '';
      return `<tr>
        <td><span class="stage-dot" style="background:${stageColor(model, sd.stage)}"></span>${esc(sd.label)}</td>
        <td class="right">${sd.eventCount}</td>
        <td class="right">${sd.journeyCount}</td>
        <td class="right">${money(ss?.laborCost ?? sd.totalCost)}</td>
        <td class="right">${money(ss?.toolingCost ?? 0)}</td>
        <td class="right"><b>${money(ss?.trueCost ?? sd.totalCost)}</b></td>
        <td>${days(sd.medianCycleMs)}</td>
        <td>${sd.actors.length} ${concentration}</td>
      </tr>
      ${
        apps
          ? `<tr><td colspan="8"><details><summary>Apps powering ${esc(
              sd.label,
            )} (${ss?.service_ids.length ?? 0})</summary>${apps}</details></td></tr>`
          : ''
      }`;
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
    <div class="note">Tooling cost is allocated from the service inventory via each service's stages_served bridge (monthly_cost / #stages served). Expand a stage to see the apps that power it.</div>
    <table><thead><tr><th>Stage</th><th class="right">Events</th><th class="right">Journeys</th>
      <th class="right">Labor</th><th class="right">Tooling/mo</th><th class="right">True cost</th><th>Cycle→next</th><th>Actors</th></tr></thead>
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

// --------------------------------------------------------------------------
function serviceView(model) {
  if (!model.services.length) {
    return `<div class="view" id="v-service"><div class="note">No service-architecture inventory was provided for this run.</div></div>`;
  }
  const d = model.diagnostics.services;
  // Group services by the stage they power.
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
      return `<details open><summary><span class="stage-dot" style="background:${st.color}"></span>${esc(
        st.label,
      )} — ${list.length} apps, ${money(total)}/mo gross</summary>
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

// --------------------------------------------------------------------------
function gapsView(model) {
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

// --------------------------------------------------------------------------
function eventView(model) {
  const rows = model.events
    .slice(0, 500)
    .map(
      (e) => `<tr>
      <td class="mono">${esc(e.event_id)}</td><td>${esc(e.event)}</td>
      <td><span class="stage-dot" style="background:${stageColor(model, e.stage)}"></span>${esc(
        stageLabel(model, e.stage),
      )}</td>
      <td class="note">${esc(e.timestamp ?? '—')}</td><td>${esc(e.actor ?? '—')}</td>
      <td class="right">${e.cost != null ? money(e.cost) : '—'}</td>
      <td class="mono">${esc(e.entity_id ?? '—')}</td></tr>`,
    )
    .join('');
  return `<div class="view" id="v-event">
    <div class="section">Normalized events — the substrate</div>
    <div class="note">Every source row collapsed to the common event model. Showing up to 500 of ${model.events.length}.</div>
    <table><thead><tr><th>ID</th><th>Event</th><th>Stage</th><th>Timestamp</th><th>Actor</th><th class="right">Cost</th><th>Journey</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>`;
}

export function renderModel(model) {
  const m = model.meta;
  const subtitle = `vertical <b>${esc(m.vertical)}</b> · unit <b>${esc(m.unit)}</b> · ${
    model.events.length
  } events · ${model.journeys.length} journeys · ${model.services.length} services${
    m.sampled ? ' · <span class="warn">SAMPLED</span>' : ''
  } · generated ${esc(m.generatedAt)}`;

  const tabs = [
    ['v-ledger', 'Ledger', true],
    ['v-stage', 'Stages & cost', false],
    ['v-service', 'Service architecture', false],
    ['v-gaps', 'Gaps & spend-in-gaps', false],
    ['v-event', 'Events', false],
  ]
    .map(
      ([id, label, active]) =>
        `<div class="tab${active ? ' active' : ''}" onclick="showView('${id}',this)">${label}</div>`,
    )
    .join('');

  const views = [
    ledgerView(model),
    stageView(model),
    serviceView(model),
    gapsView(model),
    eventView(model),
  ].join('\n');

  return page({ title: 'throughline — value-stream + service-architecture', subtitle, tabs, views });
}

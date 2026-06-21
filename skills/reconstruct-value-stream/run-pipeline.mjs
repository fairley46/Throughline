#!/usr/bin/env node
/**
 * run-pipeline.mjs — the end-to-end deterministic runner.
 *
 * Per docs/STRUCTURE.md (decision #2): the live skill is driven by an agent
 * runtime dispatching subagents per phase. To deliver a runnable, CI-testable
 * end-to-end artifact without a live agent loop, the deterministic stages are
 * wired into one script. Where the real pipeline would call an LLM agent
 * (reconciler semantic-confirm, stage-mapper labelling), the script uses the
 * vertical config + deterministic heuristics as the "agent judgement" stand-in,
 * and emits the SAME model artifact the agents would.
 *
 * Phases:
 *   0. profile-sources        deterministic (profile-sources.mjs)
 *   1. event-normalize        deterministic column->primitive mapping (here)
 *   1b. ingest service inventory (service-architecture axis source)
 *   2. detect-join-candidates deterministic cross-source edges (detect-join-candidates.mjs)
 *   3. reconcile              core engine (reconcile) — the over-merge guard
 *   4. service-gap detection  core (detectServiceGaps)
 *   5. diagnostics            core (computeDiagnostics, incl. service axis)
 *   6. assemble + validate    core (validateModel)
 *   7. render                 dashboard (render.mjs)
 *
 * Usage:
 *   node run-pipeline.mjs --vertical <id> --sources <dir> --out <dir> [--unit <unit>] [--sample N]
 *
 * Service inventory: any source file whose name contains "service", "saas",
 * "subscription", "spend", or "app-inventory" is treated as the service-
 * architecture axis (not value-stream events). See ingestServices().
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  parseFile,
  profile,
  listSourceFiles,
  sourceNameOf,
} from './profile-sources.mjs';
import { reconcile, computeDiagnostics, detectServiceGaps, validateModel, MODEL_VERSION } from '@throughline/core';
import { renderModel } from '../../packages/dashboard/render.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { unit: null, sample: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vertical') out.vertical = argv[++i];
    else if (a === '--sources') out.sources = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--unit') out.unit = argv[++i];
    else if (a === '--sample') out.sample = Number(argv[++i]);
  }
  return out;
}

function loadVertical(id) {
  const p = join(REPO, 'verticals', `${id}.json`);
  if (!existsSync(p)) throw new Error(`vertical config not found: ${p}`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Service-inventory detection + ingest
// ---------------------------------------------------------------------------
const SERVICE_FILE_RE = /service|saas|subscription|spend|app[-_]?inventory|expense/i;

// Service-inventory columns. Classification is by CONTENT, not filename, so a
// value-stream source that merely happens to contain "service" in its name
// (e.g. an ITSM/ServiceNow export) is never silently swallowed as inventory.
const SERVICE_COLS = ['service_id', 'monthly_cost', 'stages_served', 'cost_model', 'utilized_seats'];

function classifySource(name, records) {
  const cols = records.length ? Object.keys(records[0]).map((c) => c.toLowerCase()) : [];
  const colHits = SERVICE_COLS.filter((c) => cols.includes(c)).length;
  return {
    isService: colHits >= 2, // needs ≥2 service-inventory columns to qualify
    nameMatches: SERVICE_FILE_RE.test(name),
    colHits,
  };
}

const COST_MODELS = new Set([
  'subscription_per_seat',
  'subscription_flat',
  'usage',
  'transaction_fee',
  'one_time',
]);

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isNaN(n) ? null : n;
}

/** Normalize an inventory record into a ServiceNode. Column convention below. */
function toServiceNode(rec, source, idx) {
  const get = (...keys) => {
    for (const k of keys) {
      for (const [col, val] of Object.entries(rec)) {
        if (col.toLowerCase() === k) return val;
      }
    }
    return undefined;
  };
  const stagesRaw = get('stages_served', 'stages', 'stage') ?? '';
  const stages_served = String(stagesRaw)
    .split(/[|;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const rolesRaw = get('fte_roles', 'roles', 'users') ?? '';
  const fte_roles = String(rolesRaw)
    .split(/[|;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  let cost_model = String(get('cost_model', 'model') ?? 'subscription_flat').trim();
  if (!COST_MODELS.has(cost_model)) cost_model = 'subscription_flat';
  return {
    service_id: String(get('service_id', 'id') ?? `${source}:${idx}`),
    name: String(get('name', 'service', 'app', 'tool') ?? `service-${idx}`),
    category: String(get('category', 'type') ?? 'other'),
    cost_model,
    monthly_cost: num(get('monthly_cost', 'monthly', 'cost', 'mrr', 'amount')) ?? 0,
    seats: num(get('seats', 'licenses', 'licensed_seats')),
    utilized_seats: num(get('utilized_seats', 'active_seats', 'used_seats')),
    usage_volume: num(get('usage_volume', 'usage', 'volume')),
    fte_roles,
    stages_served,
    vendor: String(get('vendor', 'provider') ?? get('name', 'service') ?? 'unknown'),
    source,
    confidence: num(get('confidence')) ?? 0.9,
  };
}

// ---------------------------------------------------------------------------
// Event normalization (the deterministic column->primitive mapping)
// ---------------------------------------------------------------------------
const TS_HINT = /date|time|_at$|created|issued|opened|resolved|received|paid|started|verified|booked|scheduled|placed|won|live/i;
const COST_HINT = /cost|price|amount|total|fee|revenue|mrr|arr|charge|paid|balance/i;
const ACTOR_HINT = /owner|rep|agent|tech|technician|assignee|user|actor|csm|engineer|provider|dentist|hygienist|by$/i;

function pickColumn(prof, hint, kinds) {
  // Prefer a profiled column of the right kind whose name matches the hint.
  const byKind = prof.columns.filter((c) => kinds.includes(c.kind));
  const hinted = byKind.find((c) => hint.test(c.name));
  return (hinted ?? byKind[0])?.name ?? null;
}

function normalizeSource(source, records, prof) {
  const tsCol =
    prof.columns.find((c) => c.kind === 'timestamp' && TS_HINT.test(c.name))?.name ??
    prof.timestampColumns[0] ??
    null;
  const costCol = pickColumn(prof, COST_HINT, ['cost', 'number']);
  const actorCol = pickColumn(prof, ACTOR_HINT, ['actor', 'text', 'id']);

  return records.map((rec, i) => {
    const event = String(rec.event ?? rec.Event ?? rec.event_type ?? inferEvent(source, rec));
    const ts = tsCol ? toIso(rec[tsCol]) : null;
    const cost = costCol ? num(rec[costCol]) : null;
    const actor = actorCol ? (rec[actorCol] || null) : null;
    // attributes = the raw fields verbatim (carry the join keys).
    const attributes = {};
    for (const [k, v] of Object.entries(rec)) attributes[k] = v === '' ? null : v;
    return {
      event_id: `${source}:${i}`,
      entity_id: null,
      event,
      timestamp: ts,
      actor: actor ? String(actor) : null,
      cost,
      stage: null,
      source,
      confidence: 1,
      attributes,
    };
  });
}

function inferEvent(source, rec) {
  // Fallback: derive a coarse event name from the source name.
  return `${source.replace(/[-_]/g, '_')}_record`;
}

function toIso(v) {
  if (v == null || v === '') return null;
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

// Deterministic stage assignment from vertical config (stage-mapper stand-in).
function buildEventStage(vertical) {
  const m = new Map();
  for (const s of vertical.stages) for (const e of s.events) m.set(e, s.id);
  return m;
}

// ---------------------------------------------------------------------------
// detect-join-candidates via the deterministic helper script
// ---------------------------------------------------------------------------
function detectCandidates(events, vertical, outDir) {
  const inPath = join(outDir, '_candidates-in.json');
  const candPath = join(outDir, '_candidates-out.json');
  writeFileSync(inPath, JSON.stringify({ events, vertical }));
  execFileSync('node', [join(__dirname, 'detect-join-candidates.mjs'), inPath, candPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const { candidates } = JSON.parse(readFileSync(candPath, 'utf-8'));
  return candidates;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv);
  if (!args.vertical || !args.sources || !args.out) {
    process.stderr.write(
      'Usage: run-pipeline.mjs --vertical <id> --sources <dir> --out <dir> [--unit <unit>] [--sample N]\n',
    );
    process.exit(1);
  }
  const vertical = loadVertical(args.vertical);
  const unit = args.unit ?? vertical.defaultUnit;
  const sourcesDir = join(REPO, args.sources);
  const outDir = join(REPO, args.out);
  mkdirSync(outDir, { recursive: true });

  const files = listSourceFiles(sourcesDir);
  const log = (m) => process.stderr.write(m + '\n');
  log(`[pipeline] vertical=${vertical.id} unit=${unit} sources=${files.length}`);

  // Phase 0/1: profile + normalize value-stream sources; ingest service inventory.
  const eventStage = buildEventStage(vertical);
  let events = [];
  let services = [];
  const sourceProfiles = [];
  const sourceNames = [];
  let sampled = false;

  for (const file of files) {
    const name = sourceNameOf(file);
    let records = parseFile(file);
    const cls = classifySource(name, records);
    if (cls.isService) {
      const nodes = records.map((r, i) => toServiceNode(r, name, i));
      services = services.concat(nodes);
      log(`[pipeline]   service-inventory ${name}: ${nodes.length} services`);
      continue;
    }
    if (cls.nameMatches) {
      log(
        `[pipeline]   NOTE: ${name} matches the service-name pattern but lacks service-inventory columns (found ${cls.colHits}/2) — treating it as a value-stream source.`,
      );
    }
    if (args.sample && records.length > args.sample) {
      records = records.slice(0, args.sample);
      sampled = true;
      log(`[pipeline]   SAMPLED ${name}: capped to ${records.length} rows`);
    }
    const prof = profile(name, records);
    sourceProfiles.push(prof);
    sourceNames.push(name);
    const evs = normalizeSource(name, records, prof).map((e) => ({
      ...e,
      stage: eventStage.get(e.event) ?? null,
    }));
    events = events.concat(evs);
    log(`[pipeline]   ${name}: ${evs.length} events`);
  }

  // Phase 2: candidate links (deterministic helper).
  const candidates = detectCandidates(events, vertical, outDir);
  log(`[pipeline] candidates: ${candidates.length}`);

  // Phase 3: reconcile (the over-merge guard).
  const rec = reconcile({ events, vertical, unit, candidates });
  log(
    `[pipeline] journeys=${rec.journeys.length} ledger=${rec.ledger.pct_reconstructed}/${rec.ledger.pct_inferred}/${rec.ledger.pct_orphaned} gaps=${rec.gaps.length}`,
  );

  // Phase 4: service-gap detection (axis 2). Append to value-stream gaps.
  const knownStages = new Set(vertical.stages.map((s) => s.id));
  const serviceGaps = detectServiceGaps(services, knownStages, rec.gaps.length);
  const gaps = rec.gaps.concat(serviceGaps);
  log(`[pipeline] service inventory=${services.length} service-gaps=${serviceGaps.length}`);

  // Phase 5: diagnostics (value-stream + service axis).
  const diagnostics = computeDiagnostics(rec.events, rec.journeys, gaps, vertical, services);

  // Phase 6: assemble + validate.
  const model = {
    version: MODEL_VERSION,
    meta: {
      generatedAt: new Date().toISOString(),
      vertical: vertical.id,
      unit,
      sources: sourceNames,
      sampled,
    },
    events: rec.events,
    sourceProfiles,
    journeys: rec.journeys,
    services,
    gaps,
    ledger: rec.ledger,
    stages: vertical.stages
      .map((s) => ({ id: s.id, label: s.label, color: s.color, order: s.order }))
      .sort((a, b) => a.order - b.order),
    diagnostics,
  };

  const issues = validateModel(model);
  if (issues.length) {
    log(`[pipeline] WARNING: ${issues.length} validation issue(s):`);
    for (const i of issues.slice(0, 20)) log(`  - ${i}`);
  } else {
    log('[pipeline] model validates clean (no silent drops).');
  }

  // Persist artifact + render.
  const modelPath = join(outDir, 'model.json');
  writeFileSync(modelPath, JSON.stringify(model, null, 2));
  const html = renderModel(model);
  const htmlPath = join(outDir, 'index.html');
  writeFileSync(htmlPath, html);
  log(`[pipeline] wrote ${modelPath}`);
  log(`[pipeline] wrote ${htmlPath}`);

  // Print a compact JSON summary on stdout for callers/tests.
  process.stdout.write(
    JSON.stringify({
      vertical: vertical.id,
      sources: sourceNames,
      counts: {
        events: rec.events.length,
        journeys: rec.journeys.length,
        services: services.length,
        gaps: gaps.length,
      },
      ledger: rec.ledger,
      validationIssues: issues.length,
      spendInGapsMonthly: diagnostics.services?.spendInGapsMonthly ?? 0,
      modelPath,
      htmlPath,
    }) + '\n',
  );
}

main();

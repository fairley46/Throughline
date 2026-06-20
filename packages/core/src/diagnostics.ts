/**
 * Diagnostician — derive cycle time, cost-per-stage, FTE load, handoff gaps,
 * and bottlenecks from the reconciled model.
 *
 * Bottlenecks are NOT a separate computation: per the design spec they are
 * aggregated interval seams across journeys. A seam is invisible from any single
 * source by construction; it becomes visible only when two sources are linked
 * and their timestamps disagree.
 */

import type { NormalizedEvent } from './event-model.js';
import type { VerticalConfig } from './verticals.js';
import type {
  Journey,
  Gap,
  Diagnostics,
  StageDiagnostics,
  Bottleneck,
  ServiceNode,
} from './model.js';
import { computeServiceDiagnostics } from './services.js';

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function tsMs(e: NormalizedEvent): number | null {
  if (!e.timestamp) return null;
  const t = Date.parse(e.timestamp);
  return Number.isNaN(t) ? null : t;
}

export function computeDiagnostics(
  events: NormalizedEvent[],
  journeys: Journey[],
  gaps: Gap[],
  vertical: VerticalConfig,
  services: ServiceNode[] = [],
): Diagnostics {
  const byId = new Map(events.map((e) => [e.event_id, e]));

  // Per-stage rollup.
  const stages: StageDiagnostics[] = vertical.stages
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((sd) => {
      const stageEvents = events.filter((e) => e.stage === sd.id);
      const journeysTouching = new Set(
        stageEvents.map((e) => e.entity_id).filter(Boolean) as string[],
      );
      const actors = Array.from(
        new Set(stageEvents.map((e) => e.actor).filter(Boolean) as string[]),
      );
      const totalCost = stageEvents.reduce((s, e) => s + (e.cost ?? 0), 0);

      // Cycle time into the NEXT stage: for each journey, time from this stage's
      // event to the next-stage event.
      const cycleMs: number[] = [];
      const nextStage = vertical.stages.find((s) => s.order === sd.order + 1);
      if (nextStage) {
        for (const j of journeys) {
          const here = j.event_ids.map((id) => byId.get(id)!).find((e) => e.stage === sd.id);
          const next = j.event_ids.map((id) => byId.get(id)!).find((e) => e.stage === nextStage.id);
          if (here && next) {
            const a = tsMs(here);
            const b = tsMs(next);
            if (a != null && b != null && b >= a) cycleMs.push(b - a);
          }
        }
      }

      return {
        stage: sd.id,
        label: sd.label,
        eventCount: stageEvents.length,
        journeyCount: journeysTouching.size,
        totalCost,
        actors,
        medianCycleMs: median(cycleMs),
      };
    });

  // Bottlenecks = aggregated interval seams.
  const seams = gaps.filter((g) => g.type === 'interval_seam' && g.interval_ms != null);
  const byPair = new Map<string, Gap[]>();
  for (const g of seams) {
    const key = `${g.stage_from}->${g.stage_to}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(g);
  }
  const bottlenecks: Bottleneck[] = Array.from(byPair.entries())
    .map(([key, gs]) => {
      const [stage_from, stage_to] = key.split('->');
      const intervals = gs.map((g) => g.interval_ms!) as number[];
      return {
        stage_from,
        stage_to,
        occurrences: gs.length,
        medianIntervalMs: median(intervals) ?? 0,
        maxIntervalMs: Math.max(...intervals),
        gap_ids: gs.map((g) => g.gap_id),
      };
    })
    // Rank: most consistent + largest unowned time first.
    .sort((a, b) => b.occurrences * b.medianIntervalMs - a.occurrences * a.medianIntervalMs);

  // End-to-end median cycle: first to last event per non-orphan journey.
  const e2e: number[] = [];
  for (const j of journeys) {
    if (j.provenance === 'could_not_connect') continue;
    const ts = j.event_ids.map((id) => tsMs(byId.get(id)!)).filter((x): x is number => x != null);
    if (ts.length >= 2) e2e.push(Math.max(...ts) - Math.min(...ts));
  }

  const totalCost = events.reduce((s, e) => s + (e.cost ?? 0), 0);
  const totalActors = new Set(events.map((e) => e.actor).filter(Boolean) as string[]).size;

  const serviceDiagnostics = computeServiceDiagnostics(
    services,
    vertical.stages.map((s) => ({ id: s.id, label: s.label })),
    stages,
    gaps,
    journeys,
  );

  return {
    stages,
    bottlenecks,
    endToEndMedianMs: median(e2e),
    totalCost,
    totalActors,
    services: serviceDiagnostics,
  };
}

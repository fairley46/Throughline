/**
 * Service-architecture axis (supplement spec, Part A).
 *
 * Two responsibilities, mirroring the value-stream axis:
 *
 *   1. Detect service GAPS as first-class objects (no silent drops): an orphan
 *      app is the service-architecture twin of an interval seam nobody owns —
 *      paid for, serves nothing captured. Same gap-as-first-class-object idea,
 *      new axis.
 *        - orphan_service        paid, maps to no captured stage (zombie / shadow IT)
 *        - redundant_service     2+ services in the same category serving the same stage(s)
 *        - underutilized_service utilized_seats/seats below a threshold
 *
 *   2. Compute service DIAGNOSTICS: tooling-cost-per-stage (the bridge),
 *      true-cost-per-stage, cost-per-journey, app-sprawl index, vendor-
 *      concentration risk, and the spend-in-gaps total.
 *
 * Cost allocation rule (from the spec): a service serving N stages allocates
 * monthly_cost / N to each stage, unless usage data says otherwise. We keep the
 * even split; usage-weighted allocation is a documented future refinement.
 */

import type {
  ServiceNode,
  Gap,
  Journey,
  ServiceDiagnostics,
  StageServiceDiagnostics,
  CategorySprawl,
  StageDiagnostics,
} from './model.js';

/** Below this seat-utilization ratio a service is flagged underutilized. */
export const UNDERUTILIZED_RATIO = 0.6;

/**
 * Detect service gaps. Returns gaps with stable ids starting at `startCounter`.
 * `knownStages` is the set of stage ids actually present in the value stream.
 */
export function detectServiceGaps(
  services: ServiceNode[],
  knownStages: Set<string>,
  startCounter = 0,
): Gap[] {
  const gaps: Gap[] = [];
  let n = startCounter;
  const id = () => `svc-gap-${String(++n).padStart(4, '0')}`;

  for (const s of services) {
    const mappedStages = s.stages_served.filter((st) => knownStages.has(st));

    // orphan_service: maps to no captured stage. Cost is real, value unaccounted.
    if (mappedStages.length === 0) {
      gaps.push({
        gap_id: id(),
        type: 'orphan_service',
        entity_id: null,
        service_id: s.service_id,
        cost: s.monthly_cost,
        stage_from: null,
        stage_to: null,
        records: [],
        interval_ms: null,
        expected_by: 'a paid service should power at least one captured stage',
        confidence: 0.85,
        detail: `"${s.name}" (${s.category}, ${s.vendor}) costs $${s.monthly_cost.toLocaleString()}/mo but powers no captured stage — zombie subscription / shadow IT. Value unaccounted.`,
      });
    }

    // underutilized_service: paying for unused licenses.
    if (
      s.seats != null &&
      s.seats > 0 &&
      s.utilized_seats != null &&
      s.utilized_seats / s.seats < UNDERUTILIZED_RATIO
    ) {
      const ratio = s.utilized_seats / s.seats;
      // Cost attributable to the gap = the wasted fraction of seat cost.
      const wasted = s.cost_model === 'subscription_per_seat'
        ? s.monthly_cost * (1 - ratio)
        : s.monthly_cost * (1 - ratio);
      gaps.push({
        gap_id: id(),
        type: 'underutilized_service',
        entity_id: null,
        service_id: s.service_id,
        cost: Number(wasted.toFixed(2)),
        stage_from: null,
        stage_to: null,
        records: [],
        interval_ms: null,
        expected_by: `seat utilization should be >= ${(UNDERUTILIZED_RATIO * 100).toFixed(0)}%`,
        confidence: 0.8,
        detail: `"${s.name}" uses ${s.utilized_seats}/${s.seats} seats (${(ratio * 100).toFixed(0)}%). ~$${wasted.toFixed(0)}/mo paid for unused licenses.`,
      });
    }
  }

  // redundant_service: 2+ services in the same category serving overlapping stages.
  const byCategory = new Map<string, ServiceNode[]>();
  for (const s of services) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category)!.push(s);
  }
  for (const [category, group] of byCategory) {
    if (group.length < 2) continue;
    // Find pairs sharing at least one served stage.
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const overlap = a.stages_served.filter(
          (st) => b.stages_served.includes(st) && knownStages.has(st),
        );
        if (overlap.length === 0) continue;
        // Cost of the gap = the cheaper of the two (the candidate to consolidate).
        const cost = Math.min(a.monthly_cost, b.monthly_cost);
        gaps.push({
          gap_id: id(),
          type: 'redundant_service',
          entity_id: null,
          service_id: b.service_id, // the consolidation candidate (cheaper-or-tie listed second)
          cost: Number(cost.toFixed(2)),
          stage_from: overlap[0],
          stage_to: overlap[overlap.length - 1],
          records: [],
          interval_ms: null,
          expected_by: `one ${category} tool per overlapping stage`,
          confidence: 0.7,
          detail: `"${a.name}" and "${b.name}" are both ${category} tools serving stage(s) ${overlap.join(', ')} — app sprawl / overlap. Consolidation could free ~$${cost.toFixed(0)}/mo.`,
        });
      }
    }
  }

  return gaps;
}

/**
 * Compute service-architecture diagnostics. `stageDiags` supplies the labor
 * proxy (direct event cost) per stage; `services` supplies the tooling axis.
 */
export function computeServiceDiagnostics(
  services: ServiceNode[],
  stageLabels: { id: string; label: string }[],
  stageDiags: StageDiagnostics[],
  gaps: Gap[],
  journeys: Journey[],
): ServiceDiagnostics | null {
  if (!services || services.length === 0) return null;

  const knownStages = new Set(stageLabels.map((s) => s.id));
  const labelOf = new Map(stageLabels.map((s) => [s.id, s.label]));
  const laborByStage = new Map(stageDiags.map((s) => [s.stage, s.totalCost]));

  // Per-stage allocation: a service serving N captured stages allocates
  // monthly_cost / N to each.
  const toolingByStage = new Map<string, number>();
  const servicesByStage = new Map<string, ServiceNode[]>();
  const vendorsByStage = new Map<string, Set<string>>();
  for (const s of services) {
    const mapped = s.stages_served.filter((st) => knownStages.has(st));
    if (mapped.length === 0) continue; // orphan -> counts in spend-in-gaps, not per-stage
    const alloc = s.monthly_cost / mapped.length;
    for (const st of mapped) {
      toolingByStage.set(st, (toolingByStage.get(st) ?? 0) + alloc);
      if (!servicesByStage.has(st)) servicesByStage.set(st, []);
      servicesByStage.get(st)!.push(s);
      if (!vendorsByStage.has(st)) vendorsByStage.set(st, new Set());
      vendorsByStage.get(st)!.add(s.vendor);
    }
  }

  const perStage: StageServiceDiagnostics[] = stageLabels.map((sd) => {
    const tooling = toolingByStage.get(sd.id) ?? 0;
    const labor = laborByStage.get(sd.id) ?? 0;
    const vendors = Array.from(vendorsByStage.get(sd.id) ?? []);
    return {
      stage: sd.id,
      label: sd.label,
      service_ids: (servicesByStage.get(sd.id) ?? []).map((s) => s.service_id),
      toolingCost: Number(tooling.toFixed(2)),
      laborCost: Number(labor.toFixed(2)),
      trueCost: Number((tooling + labor).toFixed(2)),
      vendors,
      singleVendor: vendors.length === 1 && (servicesByStage.get(sd.id)?.length ?? 0) >= 1,
    };
  });

  const totalMonthlyServiceSpend = Number(
    services.reduce((s, x) => s + x.monthly_cost, 0).toFixed(2),
  );

  // Cost per journey: (total tooling allocated to captured stages + total labor)
  // / non-orphan journeys. Tooling here excludes orphan spend by construction.
  const nonOrphan = journeys.filter((j) => j.provenance !== 'could_not_connect').length;
  const allocatedTooling = Array.from(toolingByStage.values()).reduce((a, b) => a + b, 0);
  const totalLabor = stageDiags.reduce((a, b) => a + b.totalCost, 0);
  const costPerJourney =
    nonOrphan > 0 ? Number(((allocatedTooling + totalLabor) / nonOrphan).toFixed(2)) : null;

  // App-sprawl index: distinct services per category; flag categories with >1
  // active tool serving overlapping captured stages.
  const byCategory = new Map<string, ServiceNode[]>();
  for (const s of services) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category)!.push(s);
  }
  const appSprawl: CategorySprawl[] = [];
  for (const [category, group] of byCategory) {
    if (group.length < 2) continue;
    const overlapping = new Set<string>();
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        for (const st of group[i].stages_served) {
          if (group[j].stages_served.includes(st) && knownStages.has(st)) overlapping.add(st);
        }
      }
    }
    if (overlapping.size === 0) continue;
    appSprawl.push({
      category,
      service_ids: group.map((s) => s.service_id),
      overlappingStages: Array.from(overlapping),
      monthlyCost: Number(group.reduce((a, b) => a + b.monthly_cost, 0).toFixed(2)),
    });
  }
  appSprawl.sort((a, b) => b.monthlyCost - a.monthlyCost);

  // Vendor concentration: stages whose tooling is entirely one vendor.
  const vendorConcentrationStages = perStage
    .filter((s) => s.singleVendor && s.toolingCost > 0)
    .map((s) => ({ stage: s.stage, vendor: s.vendors[0], cost: s.toolingCost }))
    .sort((a, b) => b.cost - a.cost);

  // Spend-in-gaps: $/mo across orphan + underutilized + redundant service gaps.
  const spendInGapsMonthly = Number(
    gaps
      .filter(
        (g) =>
          g.type === 'orphan_service' ||
          g.type === 'underutilized_service' ||
          g.type === 'redundant_service',
      )
      .reduce((s, g) => s + (g.cost ?? 0), 0)
      .toFixed(2),
  );

  void labelOf;
  return {
    perStage,
    totalMonthlyServiceSpend,
    costPerJourney,
    appSprawl,
    vendorConcentrationStages,
    spendInGapsMonthly,
  };
}

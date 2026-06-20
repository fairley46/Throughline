/**
 * The persisted value-stream MODEL — the durable artifact.
 *
 * This is the business analogue of UA's knowledge-graph.json. A run is
 * stateless; this JSON file IS the persistence layer. Re-run to refresh,
 * commit to share, load to interrogate / render later.
 *
 * The render reads ONLY this model (model-first; never raw data).
 */

import type { NormalizedEvent, SourceProfile } from './event-model.js';

/** Provenance class for a journey (the honest ledger lives at this grain). */
export type Provenance = 'reconstructed' | 'inferred' | 'could_not_connect';

/** Linkage tier — why a link between two events exists. */
export type LinkTier = 'tier1_deterministic' | 'tier2_probabilistic';

/** One per-signal contribution to a Tier-2 composite score (auditable). */
export interface SignalContribution {
  /** e.g. "shared_key:deal_id", "fuzzy_email", "temporal_window", "value_correlation". */
  signal: string;
  /** This signal's contribution to the composite score. */
  contribution: number;
  /** Human note, e.g. "emails match after case-fold". */
  detail: string;
}

/** A directed link between two events within a journey chain. */
export interface EventLink {
  from_event: string; // event_id
  to_event: string; // event_id
  tier: LinkTier;
  confidence: number;
  /** Which signals fired and each contribution (Tier-2); single key (Tier-1). */
  evidence: SignalContribution[];
}

/** A reconstructed journey: a stage-ordered chain of events under one entity. */
export interface Journey {
  entity_id: string;
  /** The unit of analysis grain, e.g. "order". */
  unit: string;
  /** Event ids in stage + time order. */
  event_ids: string[];
  /** The directed links holding the chain together. */
  links: EventLink[];
  provenance: Provenance;
  /** Overall confidence (min over the chain's links, roughly). */
  confidence: number;
}

/**
 * The service-architecture axis (supplement spec, Part A).
 *
 * The second axis of the "invisible operating floor": not just how work flows
 * (the value stream / journeys), but what the work runs on and what it costs.
 * `stages_served[]` is THE BRIDGE between this axis and the value-stream axis —
 * it turns cost-per-stage from labor-only into labor + allocated tooling.
 */
export interface ServiceNode {
  service_id: string;
  /** "Dentrix", "Salesforce", "AWS", "Stripe". */
  name: string;
  /** practice_mgmt | crm | accounting | comms | infra | payments | hr | bi | security | ... */
  category: string;
  /** subscription_per_seat | subscription_flat | usage | transaction_fee | one_time. */
  cost_model:
    | 'subscription_per_seat'
    | 'subscription_flat'
    | 'usage'
    | 'transaction_fee'
    | 'one_time';
  /** Normalized to monthly. */
  monthly_cost: number;
  /** Licensed seats (nullable). */
  seats: number | null;
  /** Seats actually in use, if known (nullable) -> waste signal. */
  utilized_seats: number | null;
  /** For usage / transaction models (nullable). */
  usage_volume: number | null;
  /** Which roles / FTEs use it (nullable). */
  fte_roles: string[];
  /** Stage ids this service powers -- THE BRIDGE. Empty -> orphan candidate. */
  stages_served: string[];
  vendor: string;
  /** Which input revealed this. */
  source: string;
  /** How sure we are about placement / cost. */
  confidence: number;
}

/** A first-class gap. Value-stream kinds + service-architecture kinds. */
export interface Gap {
  gap_id: string;
  type:
    | 'orphan'
    | 'weak_link'
    | 'interval_seam'
    | 'missing_expected_stage'
    | 'orphan_service'
    | 'redundant_service'
    | 'underutilized_service';
  /** For service gaps: the service this gap is about (null otherwise). */
  service_id?: string | null;
  /** Monthly cost flowing into this gap (service gaps) so the render can total it. */
  cost?: number | null;
  /** Journey it belongs to (or candidate). Null for unattached orphans. */
  entity_id: string | null;
  /** Seam start stage, if interval type. */
  stage_from: string | null;
  /** Seam end stage, if interval type. */
  stage_to: string | null;
  /** Source records bracketing the gap (event_ids). */
  records: string[];
  /** Unowned time in ms, if applicable (interval seam). */
  interval_ms: number | null;
  /** Which rule / cardinality predicted a counterpart should exist. */
  expected_by: string | null;
  /** How sure the gap is real vs. an artifact of bad linkage. */
  confidence: number;
  /** Human explanation surfaced in the render. */
  detail: string;
}

/** The honest ledger — top-level, never hidden. */
export interface Ledger {
  total_journeys: number;
  reconstructed: number;
  inferred: number;
  could_not_connect: number;
  /** Percentages, rounded for display. */
  pct_reconstructed: number;
  pct_inferred: number;
  pct_orphaned: number;
}

/** Per-stage diagnostics. */
export interface StageDiagnostics {
  stage: string;
  label: string;
  eventCount: number;
  /** Distinct journeys touching this stage. */
  journeyCount: number;
  totalCost: number;
  /** Distinct actors observed at this stage (FTE proxy). */
  actors: string[];
  /** Median dwell/cycle time INTO the next stage, ms (null if unknown). */
  medianCycleMs: number | null;
}

/** An aggregated bottleneck = interval seams of the same shape across journeys. */
export interface Bottleneck {
  stage_from: string;
  stage_to: string;
  /** How many journeys exhibit this seam. */
  occurrences: number;
  /** Median unowned interval across those journeys, ms. */
  medianIntervalMs: number;
  /** Max unowned interval, ms. */
  maxIntervalMs: number;
  /** The gap_ids that aggregate into this bottleneck. */
  gap_ids: string[];
}

/** Per-stage service-architecture rollup (the bridge made numeric). */
export interface StageServiceDiagnostics {
  stage: string;
  label: string;
  /** Services powering this stage (service_ids). */
  service_ids: string[];
  /** Allocated tooling cost: sum of monthly_cost/|stages_served| per service. */
  toolingCost: number;
  /** Labor proxy: direct event cost observed at the stage (from value-stream). */
  laborCost: number;
  /** True cost = tooling + labor (+ direct). */
  trueCost: number;
  /** Distinct vendors powering this stage. */
  vendors: string[];
  /** True when all tooling at this stage is a single vendor (concentration risk). */
  singleVendor: boolean;
}

/** App-sprawl signal: >1 active service in a category serving overlapping stages. */
export interface CategorySprawl {
  category: string;
  service_ids: string[];
  /** Stages where >1 service in this category overlap. */
  overlappingStages: string[];
  monthlyCost: number;
}

/** Service-architecture diagnostics (supplement spec, Part A). */
export interface ServiceDiagnostics {
  /** Per-stage tooling/true cost (the bridge). */
  perStage: StageServiceDiagnostics[];
  /** Total monthly service spend across the inventory. */
  totalMonthlyServiceSpend: number;
  /** Tooling + labor + direct cost allocated per completed/non-orphan journey. */
  costPerJourney: number | null;
  /** App-sprawl index: distinct services per category; flagged overlaps. */
  appSprawl: CategorySprawl[];
  /** Stages whose tooling is entirely one vendor (concentration risk). */
  vendorConcentrationStages: { stage: string; vendor: string; cost: number }[];
  /** $/mo across orphan + underutilized + redundant services. */
  spendInGapsMonthly: number;
}

export interface Diagnostics {
  stages: StageDiagnostics[];
  bottlenecks: Bottleneck[];
  /** End-to-end median cycle time across reconstructed+inferred journeys, ms. */
  endToEndMedianMs: number | null;
  totalCost: number;
  /** Distinct actors across the whole stream (FTE proxy). */
  totalActors: number;
  /** Service-architecture diagnostics (null when no service inventory present). */
  services: ServiceDiagnostics | null;
}

/** The full persisted artifact. */
export interface ValueStreamModel {
  version: string;
  meta: {
    generatedAt: string;
    vertical: string;
    unit: string;
    sources: string[];
  };
  /** All normalized events (the EVENT-view substrate). */
  events: NormalizedEvent[];
  /** Source profiles (for the render's source-events drill-down). */
  sourceProfiles: SourceProfile[];
  /** The reconstructed journeys. */
  journeys: Journey[];
  /** The service-architecture inventory (second axis). Empty if none provided. */
  services: ServiceNode[];
  /** First-class gaps (value-stream + service-architecture). */
  gaps: Gap[];
  /** The honest ledger. */
  ledger: Ledger;
  /** Stage definitions used (for legend + ordering in the render). */
  stages: { id: string; label: string; color: string; order: number }[];
  /** Derived diagnostics. */
  diagnostics: Diagnostics;
}

export const MODEL_VERSION = '1.0.0';

/**
 * Deterministic referential-integrity validation of a model — the mechanical
 * half of what the `model-reviewer` agent does (mirror of UA's inline
 * validate). Returns a list of issues (empty = clean).
 */
export function validateModel(model: ValueStreamModel): string[] {
  const issues: string[] = [];
  const eventIds = new Set(model.events.map((e) => e.event_id));

  if (!Array.isArray(model.events)) issues.push('events is not an array');
  if (!Array.isArray(model.journeys)) issues.push('journeys is not an array');
  if (!Array.isArray(model.gaps)) issues.push('gaps is not an array');

  const seenEvent = new Set<string>();
  for (const e of model.events) {
    if (!e.event_id) issues.push('event missing event_id');
    else if (seenEvent.has(e.event_id)) issues.push(`duplicate event_id ${e.event_id}`);
    else seenEvent.add(e.event_id);
  }

  const seenJourney = new Set<string>();
  for (const j of model.journeys) {
    if (!j.entity_id) issues.push('journey missing entity_id');
    else if (seenJourney.has(j.entity_id)) issues.push(`duplicate journey ${j.entity_id}`);
    else seenJourney.add(j.entity_id);
    for (const id of j.event_ids) {
      if (!eventIds.has(id)) issues.push(`journey ${j.entity_id} refs missing event ${id}`);
    }
    for (const l of j.links) {
      if (!eventIds.has(l.from_event)) issues.push(`link refs missing event ${l.from_event}`);
      if (!eventIds.has(l.to_event)) issues.push(`link refs missing event ${l.to_event}`);
    }
  }

  for (const g of model.gaps) {
    for (const id of g.records) {
      if (!eventIds.has(id)) issues.push(`gap ${g.gap_id} refs missing event ${id}`);
    }
  }

  // Ledger must sum to total.
  const { reconstructed, inferred, could_not_connect, total_journeys } = model.ledger;
  if (reconstructed + inferred + could_not_connect !== total_journeys) {
    issues.push('ledger counts do not sum to total_journeys');
  }

  // Every event should be assigned to a journey OR appear in a gap (no silent drops).
  const placed = new Set<string>();
  for (const j of model.journeys) for (const id of j.event_ids) placed.add(id);
  for (const g of model.gaps) for (const id of g.records) placed.add(id);
  for (const e of model.events) {
    if (!placed.has(e.event_id)) {
      issues.push(`event ${e.event_id} is neither in a journey nor a gap (silent drop)`);
    }
  }

  // Service-architecture axis: mirror the event rule. Every service must map to
  // >= 1 known stage OR be represented as a service gap (no silent drops).
  if (model.services && !Array.isArray(model.services)) {
    issues.push('services is not an array');
  }
  const knownStages = new Set(model.stages.map((s) => s.id));
  const seenService = new Set<string>();
  // Services referenced by any service gap (orphan/redundant/underutilized).
  const serviceInGap = new Set<string>();
  for (const g of model.gaps) {
    if (g.service_id) serviceInGap.add(g.service_id);
  }
  for (const s of model.services ?? []) {
    if (!s.service_id) issues.push('service missing service_id');
    else if (seenService.has(s.service_id)) issues.push(`duplicate service ${s.service_id}`);
    else seenService.add(s.service_id);
    // stages_served must reference real stages.
    for (const st of s.stages_served) {
      if (!knownStages.has(st)) {
        issues.push(`service ${s.service_id} refs unknown stage ${st}`);
      }
    }
    const mapped = s.stages_served.filter((st) => knownStages.has(st)).length;
    if (mapped < 1 && !serviceInGap.has(s.service_id)) {
      issues.push(
        `service ${s.service_id} maps to no known stage and is not represented as a gap (silent drop)`,
      );
    }
  }
  // Service gaps must reference a real service.
  for (const g of model.gaps) {
    if (
      (g.type === 'orphan_service' ||
        g.type === 'redundant_service' ||
        g.type === 'underutilized_service') &&
      g.service_id &&
      !seenService.has(g.service_id)
    ) {
      issues.push(`service gap ${g.gap_id} refs missing service ${g.service_id}`);
    }
  }

  return issues;
}

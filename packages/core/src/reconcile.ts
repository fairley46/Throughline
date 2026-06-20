/**
 * The reconciliation ENGINE — the product.
 *
 * Implements the locked design (docs/specs/2026-06-20-value-stream-reconciliation-design.md):
 *
 *   1. Sequence linkage, NOT set dedup. Reconstruct each journey's chain in
 *      stage + time order under a chosen unit.
 *   2. Stage-and-time-ordered clustering + cardinality guard. The single corner
 *      that must not be cut: naive connected-components over-merges separate
 *      journeys that share a customer. We walk the chain directionally and split
 *      when a cardinality bound (e.g. one deal -> one invoice) would be violated.
 *   3. Tiered, explainable links: Tier-1 deterministic / Tier-2 composite
 *      probabilistic (stores which signals fired + each contribution) /
 *      Tier-3 could-not-connect -> gap.
 *   4. Gaps first-class, two kinds: linkage gaps and interval seams.
 *   5. Honest ledger: reconstructed / inferred / could-not-connect.
 *
 * The DETERMINISTIC mechanics live here so the over-merge guard is unit-testable
 * and never depends on an LLM being careful. The `reconciler` AGENT supplies
 * semantic confirmation (is this column overlap a real FK? does this fuzzy match
 * make business sense?) — modelled here by the candidate signal scores produced
 * by detect-join-candidates and the thresholds below. When run under a live
 * runtime the agent can override these calls; the guardrails remain.
 */

import type { NormalizedEvent } from './event-model.js';
import type { VerticalConfig, CardinalityRule } from './verticals.js';
import { buildStageOrder, buildEventStageMap } from './verticals.js';
import type {
  Journey,
  Gap,
  Ledger,
  EventLink,
  SignalContribution,
  LinkTier,
} from './model.js';

/** Tuning constants — centralized for the threshold-defaults open item. */
export const THRESHOLDS = {
  /** A candidate link at or above this composite score is promoted to a link. */
  PROMOTE_LINK: 0.55,
  /** At/above this we treat it as a Tier-1 deterministic (verified shared key). */
  TIER1_FLOOR: 0.95,
  /** Interval (ms) below which a seam is ignored as noise (a weekend ~ 2.5d). */
  SEAM_MIN_MS: 2.5 * 24 * 3600 * 1000,
};

/**
 * A candidate link from detect-join-candidates.mjs: a proposed connection
 * between two events with raw per-signal scores. The engine + (agent) decide
 * whether it becomes a real link, and at which tier.
 */
export interface CandidateLink {
  from_event: string;
  to_event: string;
  /** Raw per-signal scores, e.g. { "shared_key:deal_id": 1.0, fuzzy_email: 0.9 }. */
  signals: Record<string, number>;
  /** Whether a verified shared foreign key was found (Tier-1 path). */
  hasSharedKey: boolean;
  /** Human note for each signal, mirrored into evidence. */
  details: Record<string, string>;
}

export interface ReconcileInput {
  events: NormalizedEvent[];
  vertical: VerticalConfig;
  unit: string;
  candidates: CandidateLink[];
}

export interface ReconcileOutput {
  journeys: Journey[];
  gaps: Gap[];
  ledger: Ledger;
  /** Events with entity_id assigned (a copy; the caller persists these). */
  events: NormalizedEvent[];
}

/** Weighted composite of agreeing signals (Fellegi-Sunter-flavored). */
function compositeScore(signals: Record<string, number>): number {
  // Diminishing-returns combination: 1 - prod(1 - s_i). Multiple weak signals
  // agreeing raise the score, but no single weak signal dominates.
  let acc = 1;
  for (const v of Object.values(signals)) acc *= 1 - Math.max(0, Math.min(1, v));
  return 1 - acc;
}

function toEvidence(c: CandidateLink): SignalContribution[] {
  return Object.entries(c.signals).map(([signal, contribution]) => ({
    signal,
    contribution: Number(contribution.toFixed(3)),
    detail: c.details[signal] ?? '',
  }));
}

function tierFor(score: number, hasSharedKey: boolean): LinkTier | null {
  if (hasSharedKey && score >= THRESHOLDS.TIER1_FLOOR) return 'tier1_deterministic';
  if (score >= THRESHOLDS.PROMOTE_LINK) return 'tier2_probabilistic';
  return null;
}

/**
 * Stage rank of an event (lower = earlier in the value stream). Events whose
 * stage is unknown sort last but keep time order among themselves.
 */
function rankOf(e: NormalizedEvent, stageOrder: Map<string, number>): number {
  if (e.stage == null) return Number.MAX_SAFE_INTEGER;
  const r = stageOrder.get(e.stage);
  return r == null ? Number.MAX_SAFE_INTEGER : r;
}

function tsMs(e: NormalizedEvent): number {
  if (!e.timestamp) return Number.MAX_SAFE_INTEGER;
  const t = Date.parse(e.timestamp);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

/**
 * The core. Stage-and-time-ordered chain building with a cardinality guard.
 *
 * Approach (deliberately NOT undirected connected-components):
 *
 *  - Group candidate-linked events into provisional clusters, but instead of
 *    transitively merging everything reachable, we BUILD CHAINS directionally:
 *    sort each provisional cluster by (stageRank, timestamp), then walk forward
 *    attaching each event to the most recent upstream anchor — UNLESS doing so
 *    would violate a cardinality bound (max:1), in which case we OPEN A NEW
 *    JOURNEY. This is what stops Order A (Jan) and Order B (Jun) — which share
 *    only the customer — from collapsing into one blob.
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const { events, vertical, unit } = input;
  const stageOrder = buildStageOrder(vertical);
  const eventStage = buildEventStageMap(vertical);

  // Ensure every event has a stage (deterministic mapping from event name).
  const evs: NormalizedEvent[] = events.map((e) => ({
    ...e,
    stage: e.stage ?? eventStage.get(e.event) ?? null,
    entity_id: null,
  }));
  const byId = new Map(evs.map((e) => [e.event_id, e]));

  // 1. Promote candidates to real links (tiered). Keep only those that clear
  //    threshold; the rest become weak_link gaps later.
  const promoted: { c: CandidateLink; score: number; tier: LinkTier }[] = [];
  const weakCandidates: { c: CandidateLink; score: number }[] = [];
  for (const c of input.candidates) {
    const score = compositeScore(c.signals);
    const tier = tierFor(score, c.hasSharedKey);
    if (tier) promoted.push({ c, score, tier });
    else weakCandidates.push({ c, score });
  }

  // 2. Build an undirected adjacency from PROMOTED links only, to find
  //    provisional clusters (events that might belong together). The
  //    cardinality split happens INSIDE each cluster — connected components
  //    here is just a coarse pre-grouping, not the final journey assignment.
  const adj = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    if (!adj.has(id)) adj.set(id, new Set());
    return adj.get(id)!;
  };
  for (const e of evs) ensure(e.event_id);
  for (const { c } of promoted) {
    ensure(c.from_event).add(c.to_event);
    ensure(c.to_event).add(c.from_event);
  }

  const seen = new Set<string>();
  const provisionalClusters: string[][] = [];
  for (const e of evs) {
    if (seen.has(e.event_id)) continue;
    const stack = [e.event_id];
    const comp: string[] = [];
    seen.add(e.event_id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const n of adj.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    provisionalClusters.push(comp);
  }

  // Index promoted links for evidence lookup when we accept an attachment.
  const linkIndex = new Map<string, { c: CandidateLink; score: number; tier: LinkTier }>();
  for (const p of promoted) {
    linkIndex.set(`${p.c.from_event}|${p.c.to_event}`, p);
    linkIndex.set(`${p.c.to_event}|${p.c.from_event}`, p);
  }

  const cardByPair = new Map<string, CardinalityRule>();
  for (const r of vertical.cardinality) cardByPair.set(`${r.from}->${r.to}`, r);

  const journeys: Journey[] = [];
  const gaps: Gap[] = [];
  let journeyCounter = 0;
  let gapCounter = 0;

  // 3. Within each provisional cluster, split into stage+time-ordered chains
  //    under the cardinality guard.
  for (const cluster of provisionalClusters) {
    const members = cluster.map((id) => byId.get(id)!).filter(Boolean);
    // Sort by stage rank, then time. This is the directional walk order.
    members.sort((a, b) => {
      const ra = rankOf(a, stageOrder);
      const rb = rankOf(b, stageOrder);
      if (ra !== rb) return ra - rb;
      return tsMs(a) - tsMs(b);
    });

    // Active open chains. Each is a list of event_ids with a per-stage count so
    // the cardinality guard can detect "a second invoice for this deal".
    interface Chain {
      ids: string[];
      links: EventLink[];
      stageCount: Map<string, number>;
      lastByStage: Map<string, NormalizedEvent>;
    }
    const chains: Chain[] = [];

    const openChain = (e: NormalizedEvent): Chain => {
      const ch: Chain = {
        ids: [e.event_id],
        links: [],
        stageCount: new Map([[e.stage ?? '?', 1]]),
        lastByStage: new Map([[e.stage ?? '?', e]]),
      };
      chains.push(ch);
      return ch;
    };

    /**
     * Does attaching `e` to chain `ch` violate a max:1 cardinality? We check
     * the rule from the chain's most-recent upstream stage to e's stage.
     */
    const violatesCardinality = (ch: Chain, e: NormalizedEvent): boolean => {
      const toStage = e.stage;
      if (!toStage) return false;
      // If the chain already holds an event of e's stage and some upstream
      // stage has a max:1 rule into e's stage, a second one is illegal.
      const already = ch.stageCount.get(toStage) ?? 0;
      if (already === 0) return false;
      for (const [pairKey, rule] of cardByPair) {
        if (rule.to !== toStage) continue;
        if (rule.max === 1 && (ch.stageCount.get(rule.from) ?? 0) >= 1) {
          return true; // second `to` for a from that allows only one.
        }
        void pairKey;
      }
      return false;
    };

    /**
     * Best promoted link from `e` to an upstream anchor in `ch` (directional:
     * anchor must be at an earlier-or-equal stage). Returns the strongest such
     * link (Tier-1 beats Tier-2; higher score breaks ties).
     */
    const bestLinkToChain = (
      ch: Chain,
      e: NormalizedEvent,
    ): { anchor: NormalizedEvent; p: { c: CandidateLink; score: number; tier: LinkTier } } | null => {
      let best: { anchor: NormalizedEvent; p: { c: CandidateLink; score: number; tier: LinkTier } } | null =
        null;
      for (let i = ch.ids.length - 1; i >= 0; i--) {
        const anchor = byId.get(ch.ids[i])!;
        if (rankOf(anchor, stageOrder) > rankOf(e, stageOrder)) continue;
        const p = linkIndex.get(`${anchor.event_id}|${e.event_id}`);
        if (!p) continue;
        if (!best || betterLink(p, best.p)) best = { anchor, p };
      }
      return best;
    };

    const betterLink = (
      a: { score: number; tier: LinkTier },
      b: { score: number; tier: LinkTier },
    ): boolean => {
      const ta = a.tier === 'tier1_deterministic' ? 1 : 0;
      const tb = b.tier === 'tier1_deterministic' ? 1 : 0;
      if (ta !== tb) return ta > tb;
      return a.score > b.score;
    };

    for (const e of members) {
      // Gather the best LEGAL link across ALL chains, then attach to the single
      // strongest one. Choosing globally (not first-match) is what makes a
      // ticket bind to its OWN order's deal via the Tier-1 deal_id edge instead
      // of latching onto another order through a coincidental Tier-2 email edge
      // — the over-merge fix for fan-out (max:"many") stages where the
      // cardinality guard alone does not split.
      let bestChain: Chain | null = null;
      let bestLink: { anchor: NormalizedEvent; p: { c: CandidateLink; score: number; tier: LinkTier } } | null =
        null;
      for (const ch of chains) {
        const link = bestLinkToChain(ch, e);
        if (!link) continue;
        if (violatesCardinality(ch, e)) {
          // Cardinality guard fires: this event belongs to a DIFFERENT journey
          // even though it shares signals (the over-merge fix). Skip this chain.
          continue;
        }
        if (!bestLink || betterLink(link.p, bestLink.p)) {
          bestLink = link;
          bestChain = ch;
        }
      }
      if (bestChain && bestLink) {
        bestChain.ids.push(e.event_id);
        bestChain.stageCount.set(e.stage ?? '?', (bestChain.stageCount.get(e.stage ?? '?') ?? 0) + 1);
        bestChain.lastByStage.set(e.stage ?? '?', e);
        bestChain.links.push({
          from_event: bestLink.anchor.event_id,
          to_event: e.event_id,
          tier: bestLink.p.tier,
          confidence: Number(bestLink.p.score.toFixed(3)),
          evidence: toEvidence(bestLink.p.c),
        });
      } else {
        // No legal chain to attach to -> start a new journey chain.
        openChain(e);
      }
    }

    // Materialize chains as journeys.
    for (const ch of chains) {
      const entity_id = `${unit}-${String(++journeyCounter).padStart(4, '0')}`;
      // stage+time order already enforced by member sort; keep ids in that order.
      const ordered = ch.ids
        .map((id) => byId.get(id)!)
        .sort((a, b) => {
          const ra = rankOf(a, stageOrder);
          const rb = rankOf(b, stageOrder);
          if (ra !== rb) return ra - rb;
          return tsMs(a) - tsMs(b);
        });
      for (const e of ordered) e.entity_id = entity_id;

      const allTier1 = ch.links.length > 0 && ch.links.every((l) => l.tier === 'tier1_deterministic');
      const hasAnyLink = ch.links.length > 0;
      // Single-event chains are "could_not_connect" (a lone record) unless the
      // vertical doesn't expect counterparts; classify conservatively.
      let provenance: Journey['provenance'];
      if (ordered.length === 1) provenance = 'could_not_connect';
      else if (allTier1) provenance = 'reconstructed';
      else if (hasAnyLink) provenance = 'inferred';
      else provenance = 'could_not_connect';

      const confidence = hasAnyLink
        ? Number(Math.min(...ch.links.map((l) => l.confidence)).toFixed(3))
        : 0;

      journeys.push({
        entity_id,
        unit,
        event_ids: ordered.map((e) => e.event_id),
        links: ch.links,
        provenance,
        confidence,
      });
    }
  }

  // 4a. Linkage gaps: weak candidates (below threshold) -> weak_link gaps.
  for (const { c, score } of weakCandidates) {
    const from = byId.get(c.from_event);
    const to = byId.get(c.to_event);
    if (!from || !to) continue;
    gaps.push({
      gap_id: `gap-${String(++gapCounter).padStart(4, '0')}`,
      type: 'weak_link',
      entity_id: from.entity_id ?? to.entity_id ?? null,
      stage_from: from.stage,
      stage_to: to.stage,
      records: [c.from_event, c.to_event],
      interval_ms: null,
      expected_by: null,
      confidence: Number((1 - score).toFixed(3)), // sure it's a gap when score is low
      detail: `Records share weak signals (composite ${score.toFixed(2)}) below promote threshold ${THRESHOLDS.PROMOTE_LINK}; believed related but not proven.`,
    });
  }

  // 4b. Orphan gaps: single-event journeys are reported as orphans too (a record
  //     the stream has but cannot connect).
  for (const j of journeys) {
    if (j.event_ids.length === 1) {
      const e = byId.get(j.event_ids[0])!;
      gaps.push({
        gap_id: `gap-${String(++gapCounter).padStart(4, '0')}`,
        type: 'orphan',
        entity_id: j.entity_id,
        stage_from: e.stage,
        stage_to: null,
        records: [e.event_id],
        interval_ms: null,
        expected_by: null,
        confidence: 0.8,
        detail: `Event "${e.event}" from ${e.source} could not be linked to any other record.`,
      });
    }
  }

  // 4c. Interval seams: within each multi-event journey, adjacent linked events
  //     whose timestamp gap exceeds SEAM_MIN_MS leave an unowned interval.
  for (const j of journeys) {
    for (const link of j.links) {
      const a = byId.get(link.from_event)!;
      const b = byId.get(link.to_event)!;
      const ta = tsMs(a);
      const tb = tsMs(b);
      if (ta === Number.MAX_SAFE_INTEGER || tb === Number.MAX_SAFE_INTEGER) continue;
      const interval = tb - ta;
      if (interval >= THRESHOLDS.SEAM_MIN_MS) {
        gaps.push({
          gap_id: `gap-${String(++gapCounter).padStart(4, '0')}`,
          type: 'interval_seam',
          entity_id: j.entity_id,
          stage_from: a.stage,
          stage_to: b.stage,
          records: [a.event_id, b.event_id],
          interval_ms: interval,
          expected_by: `time gap between ${a.stage} and ${b.stage}`,
          confidence: 0.9,
          detail: `Unowned interval of ${(interval / 86400000).toFixed(1)} days between "${a.event}" and "${b.event}" — no record owns this time. Bottlenecks live here.`,
        });
      }
    }
  }

  // 4d. Missing-expected-stage gaps: per cardinality rules with expected:true,
  //     a journey that has the `from` stage but no `to` stage gets a gap.
  for (const j of journeys) {
    const stagesPresent = new Set(
      j.event_ids.map((id) => byId.get(id)!.stage).filter(Boolean) as string[],
    );
    for (const rule of vertical.cardinality) {
      if (!rule.expected) continue;
      if (stagesPresent.has(rule.from) && !stagesPresent.has(rule.to)) {
        const anchor = j.event_ids
          .map((id) => byId.get(id)!)
          .find((e) => e.stage === rule.from)!;
        gaps.push({
          gap_id: `gap-${String(++gapCounter).padStart(4, '0')}`,
          type: 'missing_expected_stage',
          entity_id: j.entity_id,
          stage_from: rule.from,
          stage_to: rule.to,
          records: [anchor.event_id],
          interval_ms: null,
          expected_by: `cardinality rule ${rule.from}->${rule.to} (expected)`,
          confidence: 0.7,
          detail: `Journey has a "${rule.from}" stage but no "${rule.to}" — the value stream expected one.`,
        });
      }
    }
  }

  // 5. Honest ledger.
  const total = journeys.length;
  const reconstructed = journeys.filter((j) => j.provenance === 'reconstructed').length;
  const inferred = journeys.filter((j) => j.provenance === 'inferred').length;
  const could = journeys.filter((j) => j.provenance === 'could_not_connect').length;
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));
  const ledger: Ledger = {
    total_journeys: total,
    reconstructed,
    inferred,
    could_not_connect: could,
    pct_reconstructed: pct(reconstructed),
    pct_inferred: pct(inferred),
    pct_orphaned: pct(could),
  };

  return { journeys, gaps, ledger, events: evs };
}

/**
 * Vertical configuration.
 *
 * The pipeline is common; only this small per-vertical config changes. It
 * supplies stage labels, expected stage order, the legal cardinalities (half
 * of the over-merge fix per the locked design spec), and typical handoffs.
 *
 * Cardinality config format (was an open item in the design spec; resolved
 * here and in docs/STRUCTURE.md):
 *   { from, to, max }  where
 *     max: 1       -> a single `from` event may bind at most one `to` event.
 *                     This is the over-merge tripwire: a cluster trying to
 *                     attach a second `to` to the same `from` must SPLIT into
 *                     two journeys, not merge.
 *     max: "many"  -> fan-out allowed (one deal -> many tickets).
 */

export interface StageDef {
  /** Stable id, used in events + cardinality rules, e.g. "sale". */
  id: string;
  /** Human label for the render, e.g. "Sale / Deal". */
  label: string;
  /** Hex color for the stage legend. */
  color: string;
  /** Position in the value stream (0-based); defines expected order. */
  order: number;
  /** Event names that map to this stage. */
  events: string[];
}

export interface CardinalityRule {
  /** Stage id of the upstream anchor. */
  from: string;
  /** Stage id of the downstream counterpart. */
  to: string;
  /** Max `to` per single `from`. 1 = over-merge tripwire; "many" = fan-out. */
  max: 1 | 'many';
  /**
   * Whether the journey EXPECTS a `to` for each `from`. If true and none
   * resolves, that is a `missing_expected_stage` gap (a Tier-3 could-not-connect),
   * never silently dropped.
   */
  expected: boolean;
}

export interface VerticalConfig {
  id: string;
  label: string;
  /** Default unit of analysis (grain) the unit-detector should prefer. */
  defaultUnit: string;
  stages: StageDef[];
  cardinality: CardinalityRule[];
  /**
   * Candidate join keys by normalized name, used by detect-join-candidates to
   * recognize foreign keys vs. coincidental overlap. Each entry: a logical key
   * and the source-column aliases that represent it.
   */
  joinKeys: { key: string; aliases: string[] }[];
}

/** Map of event-name -> stage-id for a config (built from stages[].events). */
export function buildEventStageMap(cfg: VerticalConfig): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of cfg.stages) for (const e of s.events) m.set(e, s.id);
  return m;
}

/** Stage order lookup. */
export function buildStageOrder(cfg: VerticalConfig): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of cfg.stages) m.set(s.id, s.order);
  return m;
}

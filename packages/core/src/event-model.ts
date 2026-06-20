/**
 * The common event model — the normalization target.
 *
 * Everything, whatever its source shape (CSV/JSON/XLSX/text), collapses to a
 * NormalizedEvent. This is the business analogue of UA's per-file structural
 * extraction: the cheap, deterministic shape every source is mapped onto before
 * any semantic inference (reconciliation, stage mapping) happens.
 *
 * Primitives are constant across verticals; only `stage` labels differ.
 */

/** A single fact lifted from one source, mapped onto the common shape. */
export interface NormalizedEvent {
  /** Stable id for this event within a run: `<source>:<rowIndex>`. */
  event_id: string;
  /**
   * The journey this event belongs to. Pre-reconciliation this is `null`
   * (we don't know yet). The reconciler assigns it.
   */
  entity_id: string | null;
  /** What happened, e.g. "deal_created", "invoice_issued", "ticket_opened". */
  event: string;
  /** When, ISO-8601. Nullable: some records carry no usable timestamp. */
  timestamp: string | null;
  /** Who / what role did it (nullable). */
  actor: string | null;
  /** Attached cost if any, in the source's currency units (nullable). */
  cost: number | null;
  /** Value-stream stage — assigned by stage-mapper, null until then. */
  stage: string | null;
  /** Which input this came from, e.g. "crm-deals". */
  source: string;
  /**
   * How sure we are this event is correctly placed/linked. 1.0 at
   * normalization (the event is real); the reconciler lowers it when the
   * linkage is probabilistic.
   */
  confidence: number;
  /**
   * The raw fields that did NOT map to a primitive, kept verbatim for the
   * reconciler's evidence-gathering (these carry the join keys, e.g. deal_id,
   * customer email, company name).
   */
  attributes: Record<string, string | number | null>;
}

/** Profile of one source produced by the deterministic profiler. */
export interface SourceProfile {
  source: string;
  rowCount: number;
  columns: ColumnProfile[];
  /** Columns that look like timestamps. */
  timestampColumns: string[];
  /** Columns that look like money. */
  costColumns: string[];
  /** Columns that look like a person / actor / FTE. */
  actorColumns: string[];
  /** Columns that look like identifiers (candidate join keys). */
  idColumns: string[];
}

export interface ColumnProfile {
  name: string;
  /** Inferred semantic type. */
  kind: 'id' | 'timestamp' | 'cost' | 'actor' | 'text' | 'number' | 'unknown';
  /** Fraction of non-empty values (0..1). */
  fill: number;
  /** Fraction of distinct values among non-empty (0..1); high = id-like. */
  distinctness: number;
  /** A few sample values for inspection / the render. */
  samples: string[];
}

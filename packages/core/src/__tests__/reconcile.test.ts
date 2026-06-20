import { describe, it, expect } from 'vitest';
import { reconcile, type CandidateLink } from '../reconcile.js';
import type { NormalizedEvent } from '../event-model.js';
import type { VerticalConfig } from '../verticals.js';

/**
 * The SaaS implementation vertical, minimal, for the over-merge guard test.
 * One deal -> one invoice (max:1, the tripwire), one deal -> many tickets.
 */
const saas: VerticalConfig = {
  id: 'saas-implementation',
  label: 'SaaS Implementation',
  defaultUnit: 'order',
  stages: [
    { id: 'sale', label: 'Sale', color: '#2563eb', order: 0, events: ['deal_created'] },
    { id: 'billing', label: 'Billing', color: '#16a34a', order: 1, events: ['invoice_issued'] },
    { id: 'support', label: 'Support', color: '#dc2626', order: 2, events: ['ticket_opened'] },
  ],
  cardinality: [
    { from: 'sale', to: 'billing', max: 1, expected: true },
    { from: 'sale', to: 'support', max: 'many', expected: false },
  ],
  joinKeys: [
    { key: 'deal_id', aliases: ['deal_id', 'deal'] },
    { key: 'email', aliases: ['email', 'contact_email'] },
  ],
};

function ev(
  event_id: string,
  event: string,
  timestamp: string,
  attributes: Record<string, string> = {},
): NormalizedEvent {
  return {
    event_id,
    entity_id: null,
    event,
    timestamp,
    actor: null,
    cost: null,
    stage: null,
    source: event_id.split(':')[0],
    confidence: 1,
    attributes,
  };
}

describe('over-merge guard (the locked design corner)', () => {
  // Acme buys twice. Order A (Jan), Order B (Jun). Many records share only the
  // customer email "john@acme.com". Off-the-shelf entity resolution would draw
  // a similarity edge between any two lookalike records and take connected
  // components -> all six collapse into one blob (one deal, two invoices, two
  // tickets). The guard must keep them as TWO journeys.
  const events: NormalizedEvent[] = [
    // Order A — January
    ev('crm:0', 'deal_created', '2025-01-05T09:00:00Z', { deal_id: '4471', email: 'john@acme.com' }),
    ev('billing:0', 'invoice_issued', '2025-01-08T09:00:00Z', { deal: '4471', email: 'john@acme.com' }),
    ev('support:0', 'ticket_opened', '2025-01-20T09:00:00Z', { deal: '4471', email: 'john@acme.com' }),
    // Order B — June
    ev('crm:1', 'deal_created', '2025-06-05T09:00:00Z', { deal_id: '5500', email: 'john@acme.com' }),
    ev('billing:1', 'invoice_issued', '2025-06-08T09:00:00Z', { deal: '5500', email: 'john@acme.com' }),
    ev('support:1', 'ticket_opened', '2025-06-25T09:00:00Z', { deal: '5500', email: 'john@acme.com' }),
  ];

  // Candidate links. The deterministic detector found the deal_id FK between
  // same-order records (Tier-1), AND the shared-email coincidence across ALL
  // six (the over-merge trap). We feed BOTH, exactly as a naive detector would.
  const candidates: CandidateLink[] = [];

  // Tier-1 shared-key links within each order.
  for (const [from, to] of [
    ['crm:0', 'billing:0'],
    ['crm:0', 'support:0'],
    ['crm:1', 'billing:1'],
    ['crm:1', 'support:1'],
  ] as const) {
    candidates.push({
      from_event: from,
      to_event: to,
      signals: { 'shared_key:deal_id': 1.0 },
      hasSharedKey: true,
      details: { 'shared_key:deal_id': 'identical deal_id' },
    });
  }

  // The trap: shared-email similarity edges across DIFFERENT orders. High enough
  // to promote (a naive pipeline would). e.g. Jan deal <-> Jun invoice.
  for (const [from, to] of [
    ['crm:0', 'billing:1'],
    ['crm:1', 'billing:0'],
    ['crm:0', 'support:1'],
    ['crm:1', 'support:0'],
    ['billing:0', 'billing:1'],
  ] as const) {
    candidates.push({
      from_event: from,
      to_event: to,
      signals: { fuzzy_email: 0.9, value_correlation: 0.4 },
      hasSharedKey: false,
      details: { fuzzy_email: 'same customer email', value_correlation: 'similar amounts' },
    });
  }

  const out = reconcile({ events, vertical: saas, unit: 'order', candidates });

  it('does NOT merge the two orders into one journey', () => {
    // Exactly two multi-event journeys (the two orders), not one blob.
    const multi = out.journeys.filter((j) => j.event_ids.length > 1);
    expect(multi.length).toBe(2);
  });

  it('keeps one invoice per journey (cardinality max:1 holds)', () => {
    const byId = new Map(out.events.map((e) => [e.event_id, e]));
    for (const j of out.journeys) {
      const invoices = j.event_ids
        .map((id) => byId.get(id)!)
        .filter((e) => e.event === 'invoice_issued');
      expect(invoices.length).toBeLessThanOrEqual(1);
    }
  });

  it('binds the January invoice to the January deal, not the June one', () => {
    const byId = new Map(out.events.map((e) => [e.event_id, e]));
    // crm:0 (Jan deal) and billing:0 (Jan invoice) share a journey.
    expect(byId.get('crm:0')!.entity_id).toBe(byId.get('billing:0')!.entity_id);
    // crm:0 (Jan) and billing:1 (June invoice) must be in DIFFERENT journeys.
    expect(byId.get('crm:0')!.entity_id).not.toBe(byId.get('billing:1')!.entity_id);
  });

  it('each order keeps its own deal/invoice/ticket triple', () => {
    const byId = new Map(out.events.map((e) => [e.event_id, e]));
    const a = byId.get('crm:0')!.entity_id;
    expect(byId.get('billing:0')!.entity_id).toBe(a);
    expect(byId.get('support:0')!.entity_id).toBe(a);
    const b = byId.get('crm:1')!.entity_id;
    expect(byId.get('billing:1')!.entity_id).toBe(b);
    expect(byId.get('support:1')!.entity_id).toBe(b);
    expect(a).not.toBe(b);
  });

  it('classifies the two clean chains as reconstructed (Tier-1 end to end)', () => {
    const multi = out.journeys.filter((j) => j.event_ids.length > 1);
    for (const j of multi) expect(j.provenance).toBe('reconstructed');
  });
});

describe('interval seams become first-class gaps', () => {
  const events: NormalizedEvent[] = [
    ev('crm:0', 'deal_created', '2025-01-05T00:00:00Z', { deal_id: '1' }),
    // 15-day unowned gap to the invoice.
    ev('billing:0', 'invoice_issued', '2025-01-20T00:00:00Z', { deal: '1' }),
  ];
  const candidates: CandidateLink[] = [
    {
      from_event: 'crm:0',
      to_event: 'billing:0',
      signals: { 'shared_key:deal_id': 1.0 },
      hasSharedKey: true,
      details: { 'shared_key:deal_id': 'identical deal_id' },
    },
  ];
  const out = reconcile({ events, vertical: saas, unit: 'order', candidates });

  it('emits an interval_seam gap for the unowned interval', () => {
    const seams = out.gaps.filter((g) => g.type === 'interval_seam');
    expect(seams.length).toBe(1);
    expect(seams[0].interval_ms).toBe(15 * 86400000);
  });
});

describe('honest ledger sums correctly', () => {
  const events: NormalizedEvent[] = [
    ev('crm:0', 'deal_created', '2025-01-05T00:00:00Z', { deal_id: '1' }),
    ev('billing:0', 'invoice_issued', '2025-01-08T00:00:00Z', { deal: '1' }),
    ev('orphan:0', 'ticket_opened', '2025-03-01T00:00:00Z', { deal: '999' }),
  ];
  const candidates: CandidateLink[] = [
    {
      from_event: 'crm:0',
      to_event: 'billing:0',
      signals: { 'shared_key:deal_id': 1.0 },
      hasSharedKey: true,
      details: { 'shared_key:deal_id': 'identical deal_id' },
    },
  ];
  const out = reconcile({ events, vertical: saas, unit: 'order', candidates });

  it('ledger counts sum to total journeys', () => {
    const { reconstructed, inferred, could_not_connect, total_journeys } = out.ledger;
    expect(reconstructed + inferred + could_not_connect).toBe(total_journeys);
  });

  it('the unlinked ticket is reported as could_not_connect + orphan gap', () => {
    expect(out.ledger.could_not_connect).toBeGreaterThanOrEqual(1);
    expect(out.gaps.some((g) => g.type === 'orphan')).toBe(true);
  });
});

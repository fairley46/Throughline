/**
 * Three-scale pressure test (dentist → SMB → enterprise).
 *
 * Runs the real pipeline on each bundled dataset and asserts the contracts that
 * ACTUALLY hold — chiefly the over-merge guard's core guarantee:
 *
 *   A customer with multiple distinct orders must NOT collapse into a single
 *   journey (the anti-blob contract).
 *
 * Note on scope: this asserts the guard does not produce one blob. It does NOT
 * assert perfect per-order event partitioning — entry-stage and fuzzy fan-out
 * events can still land in a sibling journey (documented in docs/PRESSURE-TEST.md).
 * These tests encode what is true today, on purpose.
 */
import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const RUNNER = 'skills/reconstruct-value-stream/run-pipeline.mjs';

interface Scale {
  name: string;
  vertical: string;
  dir: string;
  /** Lowercase substring identifying the planted multi-order trap customer. */
  trap: string;
}

const SCALES: Scale[] = [
  { name: 'dentist', vertical: 'dental-practice', dir: 'examples/dentist', trap: 'maria' },
  { name: 'smb', vertical: 'saas-implementation', dir: 'examples/smb', trap: 'northwind' },
  { name: 'enterprise', vertical: 'enterprise-b2b', dir: 'examples/enterprise', trap: 'globex' },
];

const outDirs: string[] = [];

function runScale(s: Scale) {
  const out = `out/_pressure_${s.name}`;
  outDirs.push(out);
  execSync(`node ${RUNNER} --vertical ${s.vertical} --sources ${s.dir} --out ${out}`, {
    cwd: ROOT,
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(resolve(ROOT, out, 'model.json'), 'utf8'));
}

afterAll(() => {
  for (const d of outDirs) rmSync(resolve(ROOT, d), { recursive: true, force: true });
});

describe.each(SCALES)('pressure: $name', (s) => {
  const model = runScale(s);

  it('produces a model that validates clean (no silent drops)', () => {
    const placed = new Set<string>();
    for (const j of model.journeys) for (const id of j.event_ids) placed.add(id);
    for (const g of model.gaps) for (const id of g.records) placed.add(id);
    for (const e of model.events) expect(placed.has(e.event_id)).toBe(true);
  });

  it('captures the service-architecture axis (services + service gaps)', () => {
    expect(model.services.length).toBeGreaterThan(0);
    const serviceGapTypes = new Set([
      'orphan_service',
      'redundant_service',
      'underutilized_service',
    ]);
    expect(model.gaps.some((g: { type: string }) => serviceGapTypes.has(g.type))).toBe(true);
  });

  it('does NOT collapse the multi-order trap customer into one journey', () => {
    const trapEventIds = new Set(
      model.events
        .filter((e: { source: string; attributes?: Record<string, unknown> }) =>
          JSON.stringify(e).toLowerCase().includes(s.trap),
        )
        .map((e: { event_id: string }) => e.event_id),
    );
    expect(trapEventIds.size).toBeGreaterThan(0);
    const trapJourneys = model.journeys.filter((j: { event_ids: string[] }) =>
      j.event_ids.some((id) => trapEventIds.has(id)),
    );
    // The anti-blob guarantee: the trap customer's distinct orders span >= 2 journeys.
    expect(trapJourneys.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the ledger internally consistent', () => {
    const { reconstructed, inferred, could_not_connect, total_journeys } = model.ledger;
    expect(reconstructed + inferred + could_not_connect).toBe(total_journeys);
    expect(total_journeys).toBe(model.journeys.length);
  });
});

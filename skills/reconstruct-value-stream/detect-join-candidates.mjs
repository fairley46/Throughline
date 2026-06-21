#!/usr/bin/env node
/**
 * detect-join-candidates.mjs
 *
 * Deterministic candidate-link generation for the `reconciler` agent.
 * A cheap, no-LLM script that computes the cross-SOURCE evidence, so the LLM
 * agent can spend its judgement on meaning rather than mechanics.
 *
 * It does NOT decide which records belong together — that is the reconciler's
 * job (engine + agent). It only emits a candidate-link list with RAW per-signal
 * scores. Per the locked design: "scripts compute evidence; the agent judges
 * meaning."
 *
 * Signals computed:
 *   - shared_key:<key>   verified shared join key (the Tier-1 path). Uses the
 *                        vertical's joinKeys aliases to recognize a real FK vs.
 *                        coincidental column overlap.
 *   - fuzzy_email        normalized email match (case-fold, trim).
 *   - fuzzy_company      normalized company/customer-name match.
 *   - temporal_window    closeness in time (a downstream event soon after an
 *                        upstream one scores higher).
 *   - value_correlation  matching monetary amounts.
 *
 * Usage:
 *   node detect-join-candidates.mjs <input.json> <output.json>
 *
 * Input JSON:
 *   { events: NormalizedEvent[], vertical: VerticalConfig }
 *
 * Output JSON:
 *   { scriptCompleted, stats, candidates: CandidateLink[] }
 *
 * Logging: stderr only.
 */

import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Normalization helpers (key normalization, per the design spec).
// ---------------------------------------------------------------------------

function normEmail(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

function normCompany(v) {
  if (v == null) return '';
  return String(v)
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|ltd|corp|co|company|gmbh)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normKey(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

function tsMs(e) {
  if (!e.timestamp) return null;
  const t = Date.parse(e.timestamp);
  return Number.isNaN(t) ? null : t;
}

/** Build alias->logicalKey map and collect per-event value for each logical key. */
function buildKeyAccessors(vertical) {
  const aliasToKey = new Map();
  const emailAliases = new Set();
  const companyAliases = new Set();
  for (const jk of vertical.joinKeys ?? []) {
    for (const a of jk.aliases) aliasToKey.set(a.toLowerCase(), jk.key);
    if (/email/.test(jk.key)) for (const a of jk.aliases) emailAliases.add(a.toLowerCase());
    if (/company|customer|account|owner/.test(jk.key))
      for (const a of jk.aliases) companyAliases.add(a.toLowerCase());
  }
  return { aliasToKey, emailAliases, companyAliases };
}

/** Extract logical-key values present on an event's attributes. */
function keyValuesOf(e, aliasToKey) {
  const out = new Map(); // logicalKey -> normalized value
  for (const [attr, val] of Object.entries(e.attributes ?? {})) {
    const lk = aliasToKey.get(attr.toLowerCase());
    if (!lk) continue;
    const nv = normKey(val);
    if (nv) out.set(lk, nv);
  }
  return out;
}

function emailOf(e, emailAliases) {
  for (const [attr, val] of Object.entries(e.attributes ?? {})) {
    if (emailAliases.has(attr.toLowerCase())) {
      const v = normEmail(val);
      if (v) return v;
    }
  }
  return '';
}

function companyOf(e, companyAliases) {
  for (const [attr, val] of Object.entries(e.attributes ?? {})) {
    if (companyAliases.has(attr.toLowerCase())) {
      const v = normCompany(val);
      if (v) return v;
    }
  }
  return '';
}

// Logical keys that are CUSTOMER-level (shared across a customer's many orders)
// rather than ORDER-level. A shared customer key is NOT a Tier-1 foreign key —
// it is exactly the over-merge trap. We score it as a weak signal, never as
// hasSharedKey. Order-level keys (deal_id, invoice_id, repair_order) ARE FKs.
function isCustomerLevelKey(key) {
  return /email|company|customer|account|owner|phone/.test(key);
}

function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    process.stderr.write('Usage: node detect-join-candidates.mjs <input.json> <output.json>\n');
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const events = input.events ?? [];
  const vertical = input.vertical;
  if (!vertical) {
    process.stderr.write('Error: input.vertical is required\n');
    process.exit(1);
  }

  const { aliasToKey, emailAliases, companyAliases } = buildKeyAccessors(vertical);

  // Precompute per-event projections.
  const projected = events.map((e) => ({
    e,
    keys: keyValuesOf(e, aliasToKey),
    email: emailOf(e, emailAliases),
    company: companyOf(e, companyAliases),
    ts: tsMs(e),
    cost: typeof e.cost === 'number' ? e.cost : null,
  }));

  const candidates = [];
  let sharedKeyHits = 0;
  let fuzzyHits = 0;

  // O(n^2) pairwise — fine for the data scales this tool targets (thousands of
  // rows). For larger inputs this is where a blocking key would be introduced.
  for (let i = 0; i < projected.length; i++) {
    for (let j = i + 1; j < projected.length; j++) {
      const a = projected[i];
      const b = projected[j];
      const signals = {};
      const details = {};
      let hasSharedKey = false;

      // shared order-level key -> Tier-1 path.
      for (const [key, av] of a.keys) {
        const bv = b.keys.get(key);
        if (bv && bv === av) {
          if (isCustomerLevelKey(key)) {
            // Customer-level overlap: weak signal only (the over-merge trap).
            signals[`shared_customer:${key}`] = 0.45;
            details[`shared_customer:${key}`] =
              `both records carry the same ${key} (customer-level, not a per-order FK)`;
          } else {
            signals[`shared_key:${key}`] = 1.0;
            details[`shared_key:${key}`] = `identical ${key} "${av}"`;
            hasSharedKey = true;
          }
        }
      }

      // fuzzy email (only if not already an order-level FK match — still useful
      // as corroboration, but on its own it is the customer-level trap signal).
      if (a.email && a.email === b.email && !signals[`shared_customer:account_email`]) {
        signals.fuzzy_email = 0.45;
        details.fuzzy_email = `same customer email ${a.email}`;
      }
      if (a.company && a.company === b.company && a.company.length > 1) {
        signals.fuzzy_company = 0.35;
        details.fuzzy_company = `same company "${a.company}"`;
      }

      // temporal window — closer in time scores higher. Only meaningful when at
      // least one other signal already links them (avoid all-pairs-in-a-week).
      if (a.ts != null && b.ts != null && Object.keys(signals).length > 0) {
        const days = Math.abs(a.ts - b.ts) / 86400000;
        // 0 days -> 0.4, ~30 days -> ~0.2, decays.
        const score = 0.4 * Math.exp(-days / 45);
        if (score > 0.02) {
          signals.temporal_window = Number(score.toFixed(3));
          details.temporal_window = `${days.toFixed(1)} days apart`;
        }
      }

      // value correlation — matching monetary amounts.
      if (a.cost != null && b.cost != null && a.cost > 0 && Math.abs(a.cost - b.cost) < 0.01) {
        signals.value_correlation = 0.4;
        details.value_correlation = `matching amount ${a.cost}`;
      }

      if (Object.keys(signals).length === 0) continue;
      if (hasSharedKey) sharedKeyHits++;
      else fuzzyHits++;

      candidates.push({
        from_event: a.e.event_id,
        to_event: b.e.event_id,
        signals,
        hasSharedKey,
        details,
      });
    }
  }

  const out = {
    scriptCompleted: true,
    stats: {
      events: events.length,
      candidates: candidates.length,
      sharedKeyHits,
      fuzzyHits,
    },
    candidates,
  };
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  process.stderr.write(
    `detect-join-candidates: ${events.length} events -> ${candidates.length} candidate links ` +
      `(${sharedKeyHits} shared-key, ${fuzzyHits} fuzzy-only)\n`,
  );
}

main();

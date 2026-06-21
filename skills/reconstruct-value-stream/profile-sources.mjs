#!/usr/bin/env node
/**
 * profile-sources.mjs
 *
 * Deterministic source profiling, feeding the `source-profiler` agent. No LLM.
 * For each source file it profiles
 * columns and flags which look like timestamps, cost, person/FTE, or ids
 * (candidate join keys).
 *
 * Supports CSV and JSON (array-of-objects). XLSX is out of scope for this build
 * without a parser dependency; the design path is the same (rows -> records).
 *
 * Exposes parseFile() + profile() as named exports so run-pipeline.mjs reuses
 * them without re-parsing.
 *
 * Usage (standalone):
 *   node profile-sources.mjs <sourcesDir> <output.json>
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// --- minimal CSV parser (RFC-4180-ish: quotes, commas, newlines in quotes) ---
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => (obj[h] = r[idx] ?? ''));
    return obj;
  });
}

/** Parse a source file into an array of plain record objects. */
export function parseFile(path) {
  const ext = extname(path).toLowerCase();
  const raw = readFileSync(path, 'utf-8');
  if (ext === '.json') {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : data.records ?? [];
  }
  if (ext === '.csv' || ext === '.tsv') return parseCsv(raw);
  // text: one record per non-empty line under a single "line" column.
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => ({ line: l }));
}

const TS_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/;
const MONEY_RE = /^-?\$?\d[\d,]*(\.\d+)?$/;

function classifyColumn(name, values) {
  const nonEmpty = values.filter((v) => v != null && String(v).trim() !== '');
  const fill = values.length ? nonEmpty.length / values.length : 0;
  const distinct = new Set(nonEmpty.map((v) => String(v))).size;
  const distinctness = nonEmpty.length ? distinct / nonEmpty.length : 0;
  const lname = name.toLowerCase();

  let kind = 'unknown';
  const sample = nonEmpty.slice(0, 5).map((v) => String(v));

  if (/email|phone|_id$|^id$|number|deal|invoice|order|vin|ro\b|ref/.test(lname)) kind = 'id';
  if (TS_RE.test(sample[0] ?? '') || /date|time|_at$|created|updated/.test(lname)) kind = 'timestamp';
  if (/cost|price|amount|total|fee|revenue|mrr|arr|\$/.test(lname) || (sample[0] && MONEY_RE.test(sample[0])))
    kind = 'cost';
  if (/owner|rep|agent|tech|technician|assignee|user|actor|by$|csm|engineer/.test(lname)) kind = 'actor';
  if (kind === 'unknown' && distinctness > 0.9 && fill > 0.8) kind = 'id';
  if (kind === 'unknown' && sample.every((s) => MONEY_RE.test(s))) kind = 'number';
  if (kind === 'unknown') kind = 'text';

  return {
    name,
    kind,
    fill: Number(fill.toFixed(3)),
    distinctness: Number(distinctness.toFixed(3)),
    samples: sample,
  };
}

export function profile(source, records) {
  const colNames = Array.from(new Set(records.flatMap((r) => Object.keys(r))));
  const columns = colNames.map((c) => classifyColumn(c, records.map((r) => r[c])));
  return {
    source,
    rowCount: records.length,
    columns,
    timestampColumns: columns.filter((c) => c.kind === 'timestamp').map((c) => c.name),
    costColumns: columns.filter((c) => c.kind === 'cost').map((c) => c.name),
    actorColumns: columns.filter((c) => c.kind === 'actor').map((c) => c.name),
    idColumns: columns.filter((c) => c.kind === 'id').map((c) => c.name),
  };
}

/** List source files in a directory (csv/json/tsv/txt). */
export function listSourceFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /\.(csv|tsv|json|txt)$/i.test(f))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
}

export function sourceNameOf(path) {
  return basename(path, extname(path));
}

function main() {
  const [, , dir, outputPath] = process.argv;
  if (!dir || !outputPath) {
    process.stderr.write('Usage: node profile-sources.mjs <sourcesDir> <output.json>\n');
    process.exit(1);
  }
  const files = listSourceFiles(dir);
  const profiles = files.map((p) => profile(sourceNameOf(p), parseFile(p)));
  writeFileSync(outputPath, JSON.stringify({ scriptCompleted: true, profiles }, null, 2));
  process.stderr.write(`profile-sources: profiled ${profiles.length} sources\n`);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main();

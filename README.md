# Throughline

Ingest an assortment of business data from different sources and shapes, reconstruct the
end-to-end value stream (purchase → logistics → sales → implementation → support → retention),
and render it as an interactive, interrogable HTML view with time / cost / FTE / bottleneck
diagnostics.

Mirrors the architecture of [`Lum1104/Understand-Anything`](https://github.com/Lum1104/Understand-Anything)
— multi-agent pipeline → persisted JSON model → separate interactive render — for business data
instead of code. The net-new part is the **reconciliation layer**: inferring which records
across sources belong to the same journey, scoring confidence, and representing gaps as
first-class objects. A bottleneck is invisible from any single source; it is visible in the
seam nobody owns. That reconciliation is the product.

## Design

- [`docs/specs/2026-06-20-value-stream-reconciliation-design.md`](docs/specs/2026-06-20-value-stream-reconciliation-design.md)
  — locked reconciliation-layer design.

## Status

**v1** (`v1.0.0`). Both model axes (value stream + service architecture), the reconciliation
engine with the over-merge guard, the seven LLM agents + `SKILL.md`, and the model-first HTML
render are in place. Build + tests + demo pass. Pressure-test datasets (dentist → SMB →
enterprise) are the next step.

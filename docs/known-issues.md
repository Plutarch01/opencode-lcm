# Known Issues

Audit date: 2026-03-30

This file captures the issue review that came out of debugging `opencode-lcm` in a live OpenCode session.

## Status

- Fixed in this patch: `lcm_expand` could lose summary node references after a summary graph rebuild.
- Still open: search hardening, event payload fidelity, a couple of low-priority performance issues.

## 1. `lcm_expand` could return `Unknown summary node`

Severity: critical

Root cause:

- Summary nodes were recreated with fresh random IDs on every graph rebuild.
- `lcm_resume` and active compaction notes exposed those IDs to the model.
- As soon as the archived window shifted and the graph rebuilt, the previous IDs stopped existing.
- A later `lcm_expand(nodeID=...)` call then failed even though the referenced archived content was still present.

Fix:

- Summary node IDs are now deterministic by session, level, and slot position.
- Managed resume notes are refreshed on `lcm_resume()` instead of being returned verbatim forever.
- Regression tests cover both the archived-window growth case and stale managed resume-note refresh.

## 2. FTS query building is brittle around special syntax

Severity: medium

Problem:

- Search uses SQLite FTS5 with BM25-style keyword matching.
- Queries are tokenized, but malformed or special-match syntax can still degrade into failed MATCH parsing and lower-quality fallback behavior.

Follow-up:

- Harden token sanitization before building MATCH expressions.
- Add tests for punctuation-heavy and operator-like input.

## 3. Automatic recall can still overfit on archive/meta noise

Severity: medium

Problem:

- Recall query generation is heuristic and keyword-based.
- The plugin already strips many synthetic reminder strings, but this area is fragile because recalled/system-generated text can still leak signal into future retrieval queries.

Follow-up:

- Keep expanding the synthetic/noise filters.
- Add regression coverage using more real captured reminder variants.

## 4. Event storage is optimized for replay, not deep debugging fidelity

Severity: low

Problem:

- The stored event log is enough for the plugin's state reconstruction, but it is not a perfect forensic trace for every original event shape.

Follow-up:

- Decide whether the plugin should preserve full-fidelity original event payloads for debugging/export scenarios.

## 5. Some session reads still do extra per-session work

Severity: low

Problem:

- Some derived session reads perform additional queries that will scale poorly with larger stores.

Follow-up:

- Batch more header/derived-state reads when loading large session sets.

## 6. Deferred init can front-load work onto the first capture

Severity: low

Problem:

- The first post-init capture can pay for artifact cleanup, lineage refresh, summary sync, and FTS rebuild work.

Follow-up:

- Consider moving more of that work into explicit init or chunking it across later operations.

## Notes

- Search is lexical, not semantic. There is no embedding or vector retrieval layer.
- Summary generation is heuristic/extractive, not LLM-generated.
- The summary graph is stored in SQLite tables and indexed in FTS5 for lookup.

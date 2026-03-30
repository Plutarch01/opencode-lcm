# Known Issues

Audit date: 2026-03-30

This file captures the issue review that came out of debugging `opencode-lcm` in a live OpenCode session.

## Status

- Fixed in this patch: `lcm_expand` could lose summary node references after a summary graph rebuild.
- Fixed in this patch: search hardening, session read batching, deferred-init shift.
- Improved in this patch: recall-noise filtering.
- Still open: event payload fidelity.

## Implemented Fix

Shipped in commit `43aeef1` (`Stabilize summary node references across rebuilds`).

What changed:

- Summary node IDs are now deterministic instead of random.
- The ID format now encodes the session hash, summary level, and slot position.
- Resume output now refreshes managed notes instead of returning stale stored summary-root IDs forever.
- Archived summary validation now checks the expected deterministic node IDs while reusing an existing summary graph.
- `shortNodeID()` now preserves enough of the identifier to stay readable after the longer deterministic format change.

Files changed:

- `src/store.ts`
- `src/archive-transform.ts`
- `tests/helpers.mjs`
- `tests/store-transform.test.mjs`

Behavior change:

- A node ID returned by `lcm_resume` or an archived compaction note remains valid across later summary graph rebuilds, as long as the same archived slice is still represented by that node position.
- `lcm_resume` no longer keeps serving an older managed resume note whose root IDs have gone stale.

Verification:

- Targeted regression tests passed for summary rebuild, old-node expansion after archive growth, and managed-resume refresh.
- The built plugin module imported successfully from `dist/index.js`.
- The global OpenCode loader in `~/.config/opencode/plugins/opencode-lcm.ts` successfully loaded the rebuilt plugin.

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

Status: **Fixed**

Fix:

- Added `sanitizeFtsTokens()` that drops FTS5 reserved words (and/or/not/match/bm25/select/from/where...) and sub-2-character tokens before building MATCH expressions.
- `buildFtsQuery()` now chains through `sanitizeFtsTokens` so malformed or operator-heavy queries never hit FTS5 syntax errors.
- Tests cover: reserved-word-only queries, mixed reserved+valid queries, punctuation-heavy input, and the `near` keyword.

## 3. Automatic recall can still overfit on archive/meta noise

Severity: medium

Status: **Improved**

Fix:

- `guessMessageText()` skips metadata-marked synthetic parts and explicitly drops `[Archived by opencode-lcm:` placeholders before text is indexed or scanned.
- This reduces archive/meta noise in grep results and in recall token extraction, while leaving the metadata-based filter in `isSyntheticLcmTextPart()` unchanged.
- Tests verify that retrieved-context and archive-placeholder content stay out of grep results when real message text is present.

## 4. Event storage is optimized for replay, not deep debugging fidelity

Severity: low

Problem:

- The stored event log is enough for the plugin's state reconstruction, but it is not a perfect forensic trace for every original event shape.

Follow-up:

- Decide whether the plugin should preserve full-fidelity original event payloads for debugging/export scenarios.

## 5. Session reads still do extra per-session work

Severity: low

Status: **Fixed**

Fix:

- Added `readSessionsBatchSync()` that loads sessions, messages, parts, and artifacts for N sessions in 4 base queries, plus one blob query when artifact blobs are present, instead of 4N per-session queries.
- `readAllSessionsSync()` and `readScopedSessionsSync()` now route through the batched path for N > 1 sessions; single-session reads keep using `readSessionSync()` directly.

## 6. Deferred init can front-load work onto the first capture

Severity: low

Status: **Fixed**

Fix:

- `completeDeferredInit()` (artifact blob backfill, orphan cleanup, lineage refresh, summary sync, FTS rebuild) now runs at the end of `init()` instead of on the first `capture()` call.
- Tests verify that grep works immediately after reopening a store with no new captures.

## Notes

- Search is lexical, not semantic. There is no embedding or vector retrieval layer.
- Summary generation is heuristic/extractive, not LLM-generated.
- The summary graph is stored in SQLite tables and indexed in FTS5 for lookup.

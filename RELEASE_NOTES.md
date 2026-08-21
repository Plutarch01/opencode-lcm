## [0.15.0] - 2026-08-21

This release expands archive retrieval, deterministic artifact exploration, and storage lifecycle safety.

### Highlights
- `lcm_grep` supports pagination, summary-node scoping, and covering leaf annotations.
- Text artifacts expose deterministic JSON, CSV/TSV, SQL, and code exploration summaries.
- `lcm_status` and `lcm_doctor` report hook failures and repair managed resume-note drift.
- Removed messages are preserved as tombstones with explicit `[removed]` and `[pruned: <id>]` expansion markers.
- Storage operations use immediate transactions and WAL checkpoints for safer concurrent maintenance.

### Migration notes
- Snapshot imports now require an explicit `merge` or `replace` mode.
- `lcm_expand` returns summaries by default; pass `includeRaw=true` for raw messages.
- The removed `interop.contextMode` and `interop.neverOverrideCompactionPrompt` options must be deleted from configuration.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.1] - 2026-04-18

### Fixed
- Bun on Windows now keeps core archive/retrieval functionality by routing SQLite-backed work through a Node sidecar instead of loading SQLite in the Bun host process
- Config-only unsafe overrides no longer bypass the Bun/Windows sidecar; `OPENCODE_LCM_ALLOW_UNSAFE_BUN_WINDOWS=1` is reserved for deliberate in-process debugging

## [0.14.0] - 2026-04-13

### Added
- New `lcm_retrieval_debug` MCP tool surfaces the latest automatic-retrieval recall decision per session: status, query tokens, scope budgets, raw/selected hit counts, stop reason, and hit previews
- `lcm_status` now reports `db_bytes`, `wal_bytes`, `shm_bytes`, `total_bytes`, `prunable_events`, top-10 prunable event-type breakdowns, and FTS row counts (`message_fts`, `summary_fts`, `artifact_fts`)
- `StoreStats` type extended with storage-size, prunable-event, and FTS-index diagnostic fields

### Fixed
- Merged `fix/corrupted-json-row-loads-origin` branch: `readSessionSync`, `readMessageSync`, `readMessageSyncV2`, and grep scan paths now skip stored messages/parts with corrupted `info_json` or `part_json` instead of throwing
- `lcm_doctor` detects and reports malformed stored rows and orphaned message-fts entries

## [0.13.6] - 2026-04-11

### Fixed
- Bun on Windows now leaves the plugin in a pre-SQLite safe mode by default and requires an explicit override to enable the full archive hooks

## [0.13.5] - 2026-04-11

### Fixed
- Restored schema-v2 compatibility for persisted stores after the PR #6 merge
- Removed the unfinished `llm-cli` summary configuration surface before shipping it
- Restored Biome-clean formatting so the full cross-platform CI matrix passes again

## [0.13.4] - 2026-04-09

### Fixed
- Publish validation now keeps the Bun-on-Windows lightweight capture regression test portable across non-Windows CI runners
- Republish the current malformed-message and Bun Windows capture fixes to npm after the failed 0.13.3 release check

## [0.13.3] - 2026-04-09

### Fixed
- Bun on Windows now tolerates part-update capture when the parent message has not been materialized yet
- Additional malformed-message hardening now covers `message.info.time.created` reads and grep scan fallback paths
- Restored CI-clean formatting after the PR #5 merge so release validation and publish can complete

## [0.13.2] - 2026-04-08

### Fixed
- Republish of 0.13.1 malformed-message hardening through CI with provenance

## [0.13.1] - 2026-04-07

### Fixed
- Archive transform now removes malformed messages from the outbound message array before returning control to OpenCode, preventing follow-on backend `Bad Request` failures
- Archive, resume, describe, search indexing, and capture paths now skip malformed `message.info` metadata defensively instead of throwing when required fields are missing

### Added
- Opt-in `perf:archive` harness for large-archive regression coverage across transform, grep, snapshot, reopen, resume, and retention paths
- Separate advisory `Archive Performance` workflow for scheduled/manual perf runs with JSON artifact upload

## [0.11.0] - 2026-04-02

### Added
- Cross-platform CI matrix for Linux, Windows, and macOS on Node 22 and 24
- Opt-in CI dogfood smoke job for the existing `dogfood:opencode` flow, including workflow-managed OpenCode CLI installation
- Privacy controls for excluding tool payloads, suppressing matching file-path capture, and redacting configured regex patterns before archive storage/indexing

### Changed
- `lcm_status` now reports configured privacy-control counts and excluded tool prefixes
- `tests/store.test.mjs` cleanup now retries transient Windows SQLite file-lock races
- Archived recall and summary reminders now use terse inline formatting and attach after the active user text instead of leading it
- Automatic-retrieval sanitization now strips archived reminder boilerplate before indexing and artifact externalization

### Fixed
- Pasted reminder text no longer pollutes retrieval candidates or dominates later archive recall

## [0.1.0] - 2026-03-31

### Added
- Initial release of opencode-lcm plugin
- SQLite-based session storage with FTS5 full-text search
- Hierarchical summary graph for message archiving
- Artifact deduplication via content hashing
- Snapshot export/import for portable session data
- Automatic retrieval with TF-IDF query weighting
- Session lineage tracking (parent/child/root relationships)
- Retention policy enforcement (stale sessions, deleted sessions, orphan blobs)
- Resume notes for session continuation
- Doctor command for diagnosing and repairing store integrity
- Binary preview providers for file artifacts (image dimensions, PDF metadata, ZIP entries)
- Context-mode interop for sandboxed command execution
- Worktree-aware scoping for multi-workspace projects
- 141 tests covering core functionality
- `CHANGELOG.md` for tracking release history
- Direct regression coverage for scoped FTS refresh and snapshot replace-import stale-row cleanup

### Changed
- `parseJson()` now wraps errors with input preview and original message for easier debugging
- Silent `catch {}` blocks in `store-search.ts` replaced with `getLogger().debug()` logging
- Bun SQLite import replaced with direct `await import('bun:sqlite')` + ambient type declaration (`bun-sqlite.d.ts`)
- Duplicated artifact hydration switch/case extracted into `hydratePartFromArtifacts()` helper
- All manual `BEGIN/COMMIT/ROLLBACK` blocks replaced with `withTransaction()` helper
- Row type definitions unified — `store-snapshot.ts` is the canonical source
- `validateRow()` added to `sql-utils.ts` for runtime SQL result validation; applied to all `stats()` method queries
- Dead modules (`store-schema.ts`, `store-session-read.ts`) folded into `store.ts` as private functions with re-exports for test compatibility
- TF-IDF `filterTokensByTfidf()` doc-frequency ratio fixed to use actual `docFreq/totalDocs`
- `computeTfidfWeights()` return type extended with `docFreq` field
- `buildFtsQuery()` now preserves quoted phrases as FTS5 phrase clauses
- `resolveWorkspacePath()` absolute-path bypass fixed — absolute paths now validated against workspace root
- Duplicate `COUNT(*)` queries in TF-IDF eliminated — extracted `getTotalDocCount()` helper
- `importStoreSnapshot()` manual transaction replaced with `withTransaction()`
- Deduplicated `truncate()`, `shortNodeID()` from `archive-transform.ts` → imported from `utils.ts`
- Deduplicated `clamp()` from `store.ts` → imported from `utils.ts`
- Snapshot paths now support absolute paths (portable snapshots) and relative paths resolved from workspace with traversal guard
- `resolveWorkspacePath()` false-positive fix: names like `..hidden` no longer rejected
- Search index maintenance can now refresh only selected sessions instead of always rebuilding every FTS table
- Binary preview providers now use async file reads, and session/message externalization awaits preview generation before writing transactionally
- Test workspace cleanup now retries transient Windows SQLite file-lock races

### Fixed
- TF-IDF retrieval filtering bug where document frequency ratio was computed incorrectly
- Phrase query support broken in FTS5 — quoted strings now passed through as phrase clauses
- Workspace path security bypass where absolute paths skipped containment check
- Snapshot path resolution broke portable snapshot imports
- `store-retention.ts` module recreated after accidental deletion
- Snapshot replace-import left stale FTS rows behind for replaced sessions

### Security
- Fixed workspace path validation bypass that allowed absolute paths to escape the workspace root
- Added `validateRow()` runtime validation for all SQL query results in `stats()` method

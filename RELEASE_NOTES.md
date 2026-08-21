## [0.14.0] - 2026-04-13

### Added
- New `lcm_retrieval_debug` MCP tool surfaces the latest automatic-retrieval recall decision per session
- `lcm_status` now reports storage-size, prunable-event, and FTS-index diagnostic fields
- `StoreStats` type extended with storage-size, prunable-event, and FTS-index diagnostic fields

### Fixed
- `readSessionSync`, `readMessageSync`, `readMessageSyncV2`, and grep scan paths now skip corrupted `info_json`/`part_json` rows instead of throwing
- `lcm_doctor` detects and reports malformed stored rows and orphaned message-fts entries

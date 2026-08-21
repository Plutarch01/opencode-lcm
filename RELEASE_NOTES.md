## [0.15.1] - 2026-08-21

This hotfix locks in backward compatibility for SQLite stores created before 0.15.0.

### Highlights
- Added regression fixtures based on legacy schema-v1 and schema-v2 stores.
- Verified that opening a legacy store adds `messages.deleted_at` without deleting or tombstoning existing messages.
- Verified that schema-v1 stores also gain `summary_nodes.strategy` and advance to schema version 2 automatically.
- Behavioral reads continue to expose legacy message content after migration.

### Migration notes
- No manual migration is required.
- Existing databases are upgraded additively on first open; legacy messages remain live.

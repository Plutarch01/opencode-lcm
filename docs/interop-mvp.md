# Interop-safe MVP

## Goal

Make an OpenCode LCM plugin that works alongside `context-mode` instead of competing with it.

## Hook ownership

`context-mode` keeps ownership of:

- `tool.execute.before`
- `tool.execute.after`
- `experimental.session.compacting`

`opencode-lcm` focuses on:

- `event`
- `tool`
- `experimental.chat.messages.transform`
- `experimental.chat.system.transform`

`opencode-lcm` should avoid `tool.execute.before` entirely.

## Conflict rules

1. Never set `output.prompt` inside `experimental.session.compacting` when `context-mode` is enabled.
2. Prefer normal-turn context assembly over compaction-time prompt replacement.
3. Preserve any pre-existing compaction notes already present in `output.context`.
4. Do not re-ingest `context-mode` resume snapshots into the long-memory store.
5. Treat `ctx_*` tool traffic as infrastructure, not as high-priority semantic memory.

## MVP data model

Current prototype persists to `.lcm/lcm.db` using Node 22's built-in `node:sqlite`.

- `events` - append-only capture of OpenCode bus events
- `sessions` - normalized session metadata plus parent/root lineage and worktree keys
- `messages` - stored message headers as JSON
- `parts` - stored parts as JSON, ordered per message
- `artifacts` - externalized large content keyed by session/message/part
- `artifact_blobs` - deduplicated large payload storage keyed by content hash
- `resumes` - latest compact resume note by session
- `summary_nodes` - deterministic summary DAG nodes over archived message windows
- `summary_edges` - parent/child relationships between summary nodes
- `summary_state` - rebuild guard for archived message coverage
- `message_fts` - FTS5 lookup over archived message text
- `summary_fts` - FTS5 lookup over summary node text
- `artifact_fts` - FTS5 lookup over externalized artifact content

Legacy file-based artifacts are auto-migrated on startup if they exist:

- `.lcm/events.jsonl`
- `.lcm/resume.json`
- `.lcm/sessions/<sessionID>.json`

Next schema expansion:

- `summary_nodes`
- `summary_edges`
- `tool_refs`
- retrieval/FTS tables

## MVP features

### Phase 1

- event capture
- `lcm_status`
- `lcm_resume`
- `lcm_grep`
- `lcm_describe`
- tiny compaction note, append-only

### Phase 2

- normalized transcript storage
- synthetic context blocks from archived summaries
- fresh-tail protection
- deterministic archive compression without modifying OpenCode internals
- deterministic summary DAG with expandable node IDs
- `lcm_expand` for child/raw-message inspection
- branch-aware session lineage via parent/root session tracking
- large-content externalization with `lcm_artifact` retrieval
- file/blob-aware artifact metadata for file parts and tool attachments
- deduplicated artifact blob storage shared across sessions
- richer narrative previews for non-text artifacts like images and PDFs
- configurable binary preview providers for hashes, byte peeks, image dimensions, and PDF hints
- explicit blob stats and orphan-blob GC tooling
- retention report/prune tools for stale sessions and orphaned blobs
- FTS-backed `lcm_grep` over archived messages, summaries, and artifacts
- root-branch and worktree-scoped retrieval for `lcm_grep` and `lcm_describe`
- configurable default retrieval scopes through plugin defaults and worktree profiles
- retention reporting and pruning for stale sessions and orphaned blobs
- summary invalidation keyed to archived transcript signatures
- query-driven targeted rehydration through `lcm_expand`
- hybrid reranking so direct message hits can outrank noisier summary/artifact matches

### Phase 3

- `lcm_expand`
- large-file interception and content references
- stateless subagent rules
- retrieval ranking

## Success criteria

- `context-mode` routing still blocks unsafe raw commands
- `ctx_*` tools still work unchanged
- long sessions survive compaction with a recoverable resume note
- archived session facts can be searched, rehydrated, and externalized without dumping full raw history back into context

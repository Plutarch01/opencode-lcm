# opencode-lcm

`opencode-lcm` is a transparent long-memory layer for OpenCode. It captures older session context outside the active prompt, compresses it into searchable summaries and artifacts, then automatically recalls the relevant archived details back into the prompt when the current turn needs them. The model does not become smarter, but it behaves much better across long, compacted sessions because important prior context stops disappearing.

## Current shape

- Plugin-first implementation intended for real OpenCode use and package distribution.
- Assumes `context-mode` keeps owning sandbox routing and tool capture.
- Stores raw events, normalized session state, branch lineage, summary DAG nodes, externalized large-content artifacts, and resume notes in SQLite under `.lcm/lcm.db`.
- Adds a plugin-only message transform that compresses older turns without touching OpenCode internals.

## Why this shape

OpenCode already exposes the plugin hooks we need, but `context-mode` is also using some of the same extension points. The main interop rule is simple:

- do not replace the compaction prompt when `context-mode` is installed
- keep normal-turn memory work in `experimental.chat.messages.transform`
- keep routing ownership in `context-mode`

That lets both plugins coexist without fighting over `experimental.session.compacting`.

## Context-Mode Compatibility

- Designed to run alongside `context-mode`, not replace it.
- Leaves sandbox routing and `ctx_*` command ownership to `context-mode`.
- Avoids `tool.execute.before` and does not override the compaction prompt when `context-mode` interop is enabled.
- Treats `ctx_*` traffic as infrastructure so archive summaries and retrieval do not get polluted by routing noise.
- Live dogfood runs in this workspace were executed with `context-mode` loaded and still showed the expected A/B behavior: automatic retrieval `OFF` lost the archived fact, automatic retrieval `ON` recalled it successfully.

## Files

- `src/index.ts` - plugin entrypoint and OpenCode hooks
- `src/options.ts` - option normalization
- `src/store.ts` - SQLite-backed event log, normalized session state, branch lineage, artifact externalization, FTS search, summary DAG storage, expansion, resume notes, and archive transform logic
- `src/types.ts` - shared types
- `docs/interop-mvp.md` - hook ownership, conflict rules, and next milestones

## Capabilities

The current package provides:

- capture OpenCode events and session state in `.lcm/lcm.db`
- track parent/root session lineage for branched sessions
- build deterministic summary nodes and edges for archived turns
- externalize oversized text, tool output, file text, snapshot text, and similar payloads into artifact records
- capture file/blob-aware artifact metadata for file parts and tool attachments
- deduplicate repeated externalized payloads across sessions through shared artifact blobs
- generate richer preview narratives for non-text artifacts like images and PDFs
- support configurable binary preview providers such as fingerprint, byte peek, image dimensions, and PDF metadata
- expose `lcm_status`, `lcm_resume`, `lcm_grep`, `lcm_describe`, `lcm_lineage`, `lcm_expand`, `lcm_artifact`, `lcm_blob_stats`, `lcm_blob_gc`, `lcm_retention_report`, and `lcm_retention_prune`
- support root-branch and worktree-scoped retrieval in `lcm_grep` and `lcm_describe`
- support configurable default retrieval scopes through plugin-level defaults and worktree profiles
- support retention reports and pruning for stale sessions and orphaned blob storage
- append a compact resume note during compaction without overriding the prompt
- compress older prompt turns in `experimental.chat.messages.transform`
- use SQLite FTS tables for `lcm_grep` across archived messages, summary nodes, and externalized artifacts
- invalidate summary DAG state when archived message content changes, not just when counts change
- support query-driven `lcm_expand` so descendants and raw payloads can be rehydrated selectively
- rerank archive search results so direct message hits beat weaker summary/artifact matches when appropriate
- auto-migrate legacy `.lcm/events.jsonl`, `.lcm/resume.json`, and `.lcm/sessions/*.json` if present

## Next milestones

1. Improve summary invalidation for more complex branch merges/rebases.
2. Add an optional TUI inspector.
3. Add export/import tooling for portable long-memory snapshots.
4. Add richer media-specific preview providers on top of the binary preview framework.
5. Add retention exemptions or pinning for important sessions.

## Requirements

- Node 22 or newer
- OpenCode with plugin support
- Recommended alongside `context-mode`

## Install

- Build locally with `npm install` then `npm run test`
- Run a live OpenCode dogfood probe with `npm run dogfood:opencode` to compare archive recall with automatic retrieval off vs on
- Publish with `npm publish` once you are happy with the package name/version/license settings
- Or load from a local path/symlink during development

## Local development notes

This folder is meant to be a standalone workspace. For real OpenCode loading you can either:

- move or symlink the entrypoint into `.opencode/plugins/`
- or publish the package later and reference it from `opencode.json`

Recommended `context-mode` coexistence config shape:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context-mode": {
      "type": "local",
      "command": ["context-mode"]
    }
  },
  "plugin": [
    "context-mode",
    ["opencode-lcm", {
      "interop": {
        "contextMode": true,
        "neverOverrideCompactionPrompt": true,
        "ignoreToolPrefixes": ["ctx_"]
      },
      "scopeDefaults": {
        "grep": "session",
        "describe": "session"
      },
      "scopeProfiles": [
        {
          "worktree": "c:/repo/monorepo",
          "grep": "worktree",
          "describe": "root"
        }
      ],
      "retention": {
        "staleSessionDays": 90,
        "deletedSessionDays": 30,
        "orphanBlobDays": 14
      },
      "binaryPreviewProviders": [
        "fingerprint",
        "byte-peek",
        "image-dimensions",
        "pdf-metadata"
      ],
      "previewBytePeek": 16,
      "freshTailMessages": 10,
      "minMessagesForTransform": 16,
      "summaryCharBudget": 1500
    }]
  ]
}
```

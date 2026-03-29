# opencode-lcm

A transparent long-memory plugin for [OpenCode](https://github.com/sst/opencode), based on the [Long Context Memory (LCM)](https://papers.voltropy.com/LCM) research. It captures older session context outside the active prompt, compresses it into searchable summaries and artifacts, then automatically recalls the relevant archived details back into the prompt when the current turn needs them. The model does not become smarter, but it behaves much better across long, compacted sessions because important prior context stops disappearing.

## Status

MVP, plugin-first, tested with OpenCode and SQLite. Designed for long-session recall across compaction boundaries. Tested primarily on Windows with Node 22 and OpenCode's plugin system.

## Recommended Companion: context-mode

We recommend pairing `opencode-lcm` with [`context-mode`](https://github.com/mksglu/context-mode/). `context-mode` is a separate project that reduces context-window token usage by routing large-output work through sandboxed tools. It blocks unsafe raw commands and cuts token waste from dumped tool output. `opencode-lcm` focuses on preserving and recalling older session context. They solve different problems and work well together in practice.

> **Note:** `opencode-lcm` is an independent project. We recommend `context-mode` for its context-protection and token-saving benefits, not as an official joint integration.

## How it works

OpenCode still handles compaction the normal way: when the active conversation gets too large, it shrinks the prompt so the session can keep going. `opencode-lcm` works alongside that mechanism by saving older details outside the prompt, then later searching that archive and pulling back only the pieces that matter to the current turn. In practice, OpenCode keeps the live context small, while `opencode-lcm` helps the assistant remember what compaction pushed out.

- Listens to OpenCode events and stores session state, messages, parts, and artifacts in `.lcm/lcm.db`.
- Builds deterministic summary nodes for archived turns when a session exceeds the transform threshold.
- Automatically repairs summary, index, lineage, resume, and orphan-blob drift during init and normal capture flows.
- Automatically inserts archived context into the prompt via `experimental.chat.messages.transform`, starting with the current session and escalating to broader scopes when needed.
- Appends a compact resume note during compaction without overriding the compaction prompt.

## Capabilities

- Track parent/root session lineage for branched sessions
- Externalize oversized payloads into deduplicated artifact records with metadata
- Expose `lcm_status`, `lcm_resume`, `lcm_grep`, `lcm_describe`, `lcm_lineage`, `lcm_pin_session`, `lcm_unpin_session`, `lcm_expand`, `lcm_artifact`, `lcm_blob_stats`, `lcm_blob_gc`, `lcm_doctor`, `lcm_retention_report`, `lcm_retention_prune`, `lcm_export_snapshot`, and `lcm_import_snapshot`
- Import/export portable snapshots with safe merge collision checks, explicit restore worktree modes (`auto`, `preserve`, `current`), and relative-path traversal protection
- SQLite FTS search across archived messages, summary nodes, and externalized artifacts
- Configurable default retrieval scopes (session, root, worktree) with worktree profiles
- Bounded automatic recall with configurable scope order, per-scope budgets, stop rules, recency-aware ranking, and visible recall telemetry
- Configurable binary preview providers (fingerprint, byte peek, image dimensions, PDF metadata)
- Auto-migrate legacy `.lcm/events.jsonl`, `.lcm/resume.json`, and `.lcm/sessions/*.json`

## Requirements

- Node 22 or newer
- OpenCode with plugin support

## Install

```sh
npm install
npm run build
npm run test
```

Load the plugin from a local path or symlink during development, or publish and reference from `opencode.json`.

Run a live dogfood probe to compare archive recall with automatic retrieval off vs on:

```sh
npm run dogfood:opencode
```

## Configuration

Add `opencode-lcm` to your `opencode.json` (project or global `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-lcm", {
      "scopeDefaults": {
        "grep": "session",
        "describe": "session"
      },
      "retention": {
        "staleSessionDays": 90,
        "deletedSessionDays": 30,
        "orphanBlobDays": 14
      },
      "automaticRetrieval": {
        "enabled": true,
        "scopeOrder": ["session", "root", "worktree"],
        "scopeBudgets": {
          "session": 16,
          "root": 12,
          "worktree": 8,
          "all": 6
        },
        "stop": {
          "targetHits": 3,
          "stopOnFirstScopeWithHits": false
        },
        "maxMessageHits": 2,
        "maxSummaryHits": 1,
        "maxArtifactHits": 1
      },
      "freshTailMessages": 10,
      "minMessagesForTransform": 16,
      "summaryCharBudget": 1500,
      "systemHint": true,
      "binaryPreviewProviders": ["fingerprint", "byte-peek", "image-dimensions", "pdf-metadata"],
      "previewBytePeek": 16
    }]
  ]
}
```

When using alongside `context-mode`, add the `interop` block to avoid hook conflicts:

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
      "retention": {
        "staleSessionDays": 90,
        "deletedSessionDays": 30,
        "orphanBlobDays": 14
      }
    }]
  ]
}
```

## Disabling

Three ways to turn off the plugin without removing it:

- Set `OPENCODE_DISABLE_OPENCODE_LCM=1` in the environment before starting OpenCode
- Create an empty file at `~/.config/opencode/plugins/opencode-lcm.disabled`
- Set `ENABLED = false` in the global loader at `~/.config/opencode/plugins/opencode-lcm.ts`

## Source layout

- `src/index.ts` - plugin entrypoint and OpenCode hooks
- `src/options.ts` - option normalization and defaults
- `src/types.ts` - shared types
- `src/store.ts` - SQLite store, FTS search, summary DAG, artifact externalization, and archive repair
- `src/store-snapshot.ts` - portable snapshot export/import with worktree-mode controls and path-safety guards
- `src/workspace-path.ts` - safe workspace-relative path resolution
- `src/worktree-key.ts` - worktree key normalization
- `src/archive-transform.ts` - archive window selection and synthetic context rendering
- `src/search-ranking.ts` - cross-source search ranking
- `src/doctor.ts` - archive health report formatting (includes `invalid-summary-graph` diagnosis)
- `src/preview-providers.ts` - configurable binary preview providers (fingerprint, byte peek, image dimensions, PDF metadata)
- `docs/interop-mvp.md` - hook ownership, conflict rules, and next milestones

## Next milestones

1. Continue hardening summary invalidation for more pathological lineage changes (multi-cycle reparents, cross-worktree collisions)
2. Add richer recall debugging and tuning controls once the heuristics settle
3. Add richer media-specific preview providers on top of the existing binary preview framework
4. Add per-worktree mapping tables for more selective multi-worktree snapshot restores

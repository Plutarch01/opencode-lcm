# opencode-lcm

[![CI](https://github.com/Plutarch01/opencode-lcm/actions/workflows/ci.yml/badge.svg)](https://github.com/Plutarch01/opencode-lcm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A transparent long-memory plugin for [OpenCode](https://github.com/sst/opencode), based on the [Lossless Context Memory (LCM)](https://papers.voltropy.com/LCM) research. It captures older session context outside the active prompt, compresses it into searchable summaries and artifacts, then automatically recalls the relevant archived details back into the prompt when the current turn needs them. The model does not become smarter, but it behaves much better across long, compacted sessions because important prior context stops disappearing.

## Status

`opencode-lcm` is an early release, and its behavior, archive internals, and configuration may still change as the project evolves.

This is an unofficial community plugin for [OpenCode](https://github.com/sst/opencode) and is not affiliated with or endorsed by the OpenCode project.

The plugin stores archived conversation context locally in `.lcm/`, so review the storage behavior before using it with sensitive data.

Actively tested with OpenCode and SQLite, with CI on Node 22 and 24. Tested primarily on Windows with Node 22 and OpenCode's plugin system. Issues and PRs are welcome.

## context-mode

`opencode-lcm` preserves archived conversation context so the assistant can recall earlier decisions without re-reading old files. Pairing it with [context-mode](https://github.com/mksglu/context-mode/) reduces tool-output token waste and keeps the active prompt lean.

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
- TF-IDF weighted automatic retrieval that queries FTS5 for document frequency to drop corpus-common noise tokens, replacing static stopword lists with corpus-aware scoring
- Bigram phrase queries for better adjacency matching in automatic retrieval
- Configurable binary preview providers (fingerprint, byte peek, image dimensions, PDF metadata)
- Auto-migrate legacy `.lcm/events.jsonl`, `.lcm/resume.json`, and `.lcm/sessions/*.json`

## Install

```sh
git clone https://github.com/plutarch01/opencode-lcm.git
cd opencode-lcm
npm install
npm run build
npm run test
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

## Disable

To disable `opencode-lcm` completely, remove its entry from the `plugin` array and restart OpenCode.

If you want to keep the archive store and `lcm_*` tools available but stop archived context from being injected back into the prompt, set `automaticRetrieval.enabled` to `false`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-lcm", {
      "automaticRetrieval": {
        "enabled": false
      }
    }]
  ]
}
```

## Startup Diagnostics

To log store startup phases during plugin initialization, set `OPENCODE_LCM_STARTUP_LOG=1` before starting OpenCode.

This emits one-line `[lcm] startup phase: ...` markers around DB open, schema setup, legacy migration, deferred init, and error handling so a Bun crash log shows the last active phase.

## Source layout

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entrypoint and OpenCode hooks |
| `src/options.ts` | Option normalization and defaults |
| `src/types.ts` | Shared types |
| `src/store-types.ts` | Internal store type definitions |
| `src/store.ts` | SQLite store with event-driven state machine, FTS, summary DAG, artifact externalization, archive repair |
| `src/store-search.ts` | FTS5 search module with TF-IDF weighting and query building |
| `src/store-snapshot.ts` | Portable snapshot export/import with worktree-mode controls |
| `src/store-artifacts.ts` | Artifact externalization and deduplication |
| `src/store-retention.ts` | Retention pruning and reporting |
| `src/workspace-path.ts` | Safe workspace-relative path resolution |
| `src/worktree-key.ts` | Worktree key normalization |
| `src/archive-transform.ts` | Archive window selection, automatic retrieval, synthetic context rendering |
| `src/search-ranking.ts` | Cross-source search ranking with named scoring constants |
| `src/sql-utils.ts` | Safe SQL query wrappers |
| `src/bun-sqlite.d.ts` | Type declarations for Bun's built-in SQLite |
| `src/logging.ts` | Structured debug logger |
| `src/doctor.ts` | Archive health report formatting |
| `src/preview-providers.ts` | Binary preview providers (fingerprint, byte peek, image dimensions, PDF metadata) |
| `src/utils.ts` | Shared utilities: tokenization, snippet building, TF-IDF helpers |
| `src/constants.ts` | Shared constants and thresholds |

## License

MIT

# opencode-lcm

[![npm version](https://img.shields.io/npm/v/opencode-lcm)](https://www.npmjs.com/package/opencode-lcm)
[![CI](https://github.com/Plutarch01/opencode-lcm/actions/workflows/ci.yml/badge.svg)](https://github.com/Plutarch01/opencode-lcm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A transparent long-memory plugin for [OpenCode](https://github.com/sst/opencode), based on the [Lossless Context Memory (LCM)](https://papers.voltropy.com/LCM) research. It captures older session context outside the active prompt, compresses it into searchable summaries and artifacts, then automatically recalls relevant details back into the prompt when the current turn needs them. The model does not become smarter, but it behaves much better across long, compacted sessions because important prior context stops disappearing.

<!-- Add a demo screenshot or GIF here -->
<!-- ![opencode-lcm in action](assets/images/lcm-demo.png) -->

> [!NOTE]
> This is an early community plugin for OpenCode and is not affiliated with or endorsed by the OpenCode project. Behavior, internals, and configuration may change as the project evolves.

## context-mode

`opencode-lcm` preserves archived conversation context so the assistant can recall earlier decisions without re-reading old files. Pairing it with [context-mode](https://github.com/mksglu/context-mode/) reduces tool-output token waste and keeps the active prompt lean.

## Installation

Add to your `opencode.json` (project or global `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-lcm"]
}
```

OpenCode will automatically download the latest version from npm on startup. No manual install needed.

### From source

```sh
git clone https://github.com/Plutarch01/opencode-lcm.git
cd opencode-lcm
npm install
npm run build
```

Then copy or symlink the built plugin into your plugins directory:

```sh
# Project-level
cp dist/index.js .opencode/plugins/opencode-lcm.js

# Or global
cp dist/index.js ~/.config/opencode/plugins/opencode-lcm.js
```

Local plugins in `.opencode/plugins/` or `~/.config/opencode/plugins/` are loaded automatically by OpenCode at startup.

## How It Works

OpenCode handles compaction normally — when the conversation gets too large, it shrinks the prompt. `opencode-lcm` works alongside that by saving older details *outside* the prompt, then searching that archive later to pull back only what matters.

### Archive

Listens to OpenCode events and stores session state, messages, parts, and artifacts in `.lcm/lcm.db`. Builds deterministic summary nodes for archived turns and automatically repairs summary, index, lineage, and resume drift.

### Automatic Recall

Inserts archived context into the prompt via `experimental.chat.messages.transform`. Starts with the current session and escalates to broader scopes when needed. Uses TF-IDF weighted retrieval with bigram phrase queries for corpus-aware ranking.

### Resume Notes

Appends a compact resume note during compaction so important context survives the shrink without overriding the compaction prompt.

## Capabilities

- **Session lineage** — track parent/root relationships for branched sessions
- **Artifact externalization** — deduplicated storage with metadata for oversized payloads
- **FTS search** — SQLite FTS5 across archived messages, summaries, and artifacts
- **Snapshot export/import** — portable snapshots with safe merge and worktree modes
- **Privacy controls** — tool-output exclusion, path-based capture exclusion, regex redaction
- **Configurable retrieval** — scope ordering, per-scope budgets, stop rules, recency-aware ranking
- **16 tools** — `lcm_status`, `lcm_resume`, `lcm_grep`, `lcm_describe`, `lcm_lineage`, `lcm_expand`, `lcm_artifact`, `lcm_pin_session`, `lcm_unpin_session`, `lcm_blob_stats`, `lcm_blob_gc`, `lcm_doctor`, `lcm_retention_report`, `lcm_retention_prune`, `lcm_export_snapshot`, `lcm_import_snapshot`
- **Legacy migration** — auto-migrates `.lcm/events.jsonl`, `.lcm/resume.json`, `.lcm/sessions/*.json`

## Configuration

Add `opencode-lcm` to your `opencode.json` (project or global `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-lcm", {
      "scopeDefaults": { "grep": "session", "describe": "session" },
      "automaticRetrieval": {
        "enabled": true,
        "scopeOrder": ["session", "root", "worktree"],
        "scopeBudgets": { "session": 16, "root": 12, "worktree": 8, "all": 6 }
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

> [!IMPORTANT]
> All defaults are applied automatically. Expand below only if you need to override settings.

<details>
<summary><strong>Full Configuration</strong> (click to expand)</summary>

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
      "privacy": {
        "excludeToolPrefixes": ["playwright_browser_"],
        "excludePathPatterns": ["[\\\\/]secrets[\\\\/]", "\\\\.env($|\\\\.)"],
        "redactPatterns": ["sk-[A-Za-z0-9_-]+", "ZX729ALBATROSS"]
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

</details>

## Privacy Controls

Privacy patterns run before archived content is stored or indexed.

- **`excludeToolPrefixes`** — do not archive tool payloads for matching tools
- **`excludePathPatterns`** — suppress file capture for matching paths, redact matching path strings
- **`redactPatterns`** — replace matching content with `[REDACTED]` before storage and indexing

These controls are not encryption and not retroactive. Existing archived rows keep their previous content until rewritten.

## context-mode Interop

Pairing with [context-mode](https://github.com/mksglu/context-mode/) reduces tool-output token waste. Add the `interop` block to avoid hook conflicts:

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
      "scopeDefaults": { "grep": "session", "describe": "session" },
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

Remove `opencode-lcm` from the `plugin` array and restart OpenCode. To keep the archive but stop automatic recall, set `automaticRetrieval.enabled` to `false`.

## Performance

Run the opt-in archive performance harness locally:

```sh
npm run perf:archive -- --json-out perf-results/archive-perf.json
```

Useful knobs: `--medium-messages`, `--large-messages`, `--samples`, `--warm-runs`, `--keep-workspaces`.

There is also a separate `Archive Performance` GitHub Actions workflow for scheduled/manual advisory runs.

## License

MIT

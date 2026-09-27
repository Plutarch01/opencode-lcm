import { Plugin } from '@opencode/plugin';
import type { Event as LcmEvent, LcmStore, Properties } from './lcm-store.js';
import { getLogger } from './logging.js';
import { NodeSidecarLcmStore } from './node-sidecar-store.js';
import { resolveOptions } from './options.js';
import { SqliteLcmStore } from './store.js';
import type { Message, OpencodeLcmOptions, Part, SearchResult } from './types.js';

type RuntimeBackend = 'in_process' | 'node_sidecar';

const ALLOW_UNSAFE_BUN_WINDOWS_ENV = 'OPENCODE_LCM_ALLOW_UNSAFE_BUN_WINDOWS';

const hookFailures: Array<{ op: string; message: string; at: number }> = [];

type BunWindowsSafetyDecision = {
  allowed: boolean;
  configRequested: boolean;
  envRequested: boolean;
};

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isBunRuntime(): boolean {
  return typeof globalThis === 'object' && globalThis !== null && 'Bun' in globalThis;
}

function isUnsafeBunWindowsRuntime(): boolean {
  return isBunRuntime() && process.platform === 'win32';
}

function resolveBunWindowsSafety(options: OpencodeLcmOptions): BunWindowsSafetyDecision {
  const configRequested = options.runtimeSafety.allowUnsafeBunWindows;
  const envRequested = isTruthyEnvFlag(process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV]);

  return {
    allowed: envRequested,
    configRequested,
    envRequested,
  };
}

function buildSafeModeStatus(decision: BunWindowsSafetyDecision): string {
  return [
    'status=disabled',
    'reason=bun_windows_runtime_guard',
    'available_tools=lcm_status',
    `platform=${process.platform}`,
    `bun_runtime=${isBunRuntime()}`,
    `runtime_safety_allow_unsafe_bun_windows=${decision.allowed}`,
    `runtime_safety_config_allow_unsafe_bun_windows=${decision.configRequested}`,
    `runtime_safety_env_allow_unsafe_bun_windows=${decision.envRequested}`,
    'runtime_safety_backend=disabled',
    'override_config=ignored_on_bun_windows',
    `override_env=${ALLOW_UNSAFE_BUN_WINDOWS_ENV}=1`,
    'message=opencode-lcm could not start its Node sidecar, so it disabled itself before opening SQLite in Bun on Windows; set OPENCODE_LCM_NODE_PATH to a working Node executable or use the env override only for deliberate debugging',
  ].join('\n');
}

function resolveRuntimeBackend(decision: BunWindowsSafetyDecision): RuntimeBackend {
  if (!isUnsafeBunWindowsRuntime()) return 'in_process';
  return decision.allowed ? 'in_process' : 'node_sidecar';
}

function createStore(
  directory: string,
  options: OpencodeLcmOptions,
  backend: RuntimeBackend,
): LcmStore {
  if (backend === 'node_sidecar') return new NodeSidecarLcmStore(directory, options);
  return new SqliteLcmStore(directory, options);
}

async function runOptionalPluginWork<T>(
  operation: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    hookFailures.push({
      op: operation,
      message: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    });
    if (hookFailures.length > 20) hookFailures.splice(0, hookFailures.length - 20);
    getLogger().warn('Optional LCM hook failed; continuing without archived context', {
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export default Plugin.define({
  id: 'opencode-lcm',
  async setup(ctx) {
    const options = resolveOptions(ctx.options);
    const bunWindowsSafety = resolveBunWindowsSafety(options);
    const runtimeBackend = resolveRuntimeBackend(bunWindowsSafety);

    const store = createStore(ctx.location.directory, options, runtimeBackend);

    try {
      await store.init();
    } catch (_error) {
      await store.close();
      if (runtimeBackend === 'node_sidecar') {
        // Register safe-mode tool when store init fails
        await ctx.tool.transform((editor) => {
          editor.add({
            name: 'lcm_status',
            description: 'Show archived LCM capture stats',
            input: {
              type: 'object',
              additionalProperties: false,
            },
            async execute() {
              return { content: buildSafeModeStatus(bunWindowsSafety) };
            },
          });
        });
        return;
      }
      throw _error;
    }

    // Event subscription — captures deferred events into the archive
    const controller = new AbortController();

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const detail = (event as unknown as { detail?: unknown }).detail as Properties | undefined;
        const lcmEvent: LcmEvent = {
          type: event.type,
          properties: detail ?? { part: {} as Part, info: {} as Message },
          sessionID: detail?.sessionID as string | undefined,
          timestamp: detail?.timestamp as number | undefined,
          payload: detail?.payload,
        };
        await runOptionalPluginWork('event.capture', () => store.captureDeferred(lcmEvent));
      }
    })();

    // Register all 18 custom tools via tool.transform
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'lcm_status',
        description: 'Show archived LCM capture stats',
        input: {
          type: 'object',
          additionalProperties: false,
        },
        async execute() {
          const stats = await store.stats();
          const lines = [
            `schema_version=${stats.schemaVersion}`,
            `total_events=${stats.totalEvents}`,
            `prunable_events=${stats.prunableEventCount}`,
            `session_count=${stats.sessionCount}`,
            `root_sessions=${stats.rootSessionCount}`,
            `branched_sessions=${stats.branchedSessionCount}`,
            `pinned_sessions=${stats.pinnedSessionCount}`,
            `worktrees=${stats.worktreeCount}`,
            `latest_event_at=${stats.latestEventAt ?? 'n/a'}`,
            `db_bytes=${stats.dbBytes}`,
            `wal_bytes=${stats.walBytes}`,
            `shm_bytes=${stats.shmBytes}`,
            `total_bytes=${stats.totalBytes}`,
            `summary_nodes=${stats.summaryNodeCount}`,
            `summary_states=${stats.summaryStateCount}`,
            `artifacts=${stats.artifactCount}`,
            `artifact_blobs=${stats.artifactBlobCount}`,
            `shared_artifact_blobs=${stats.sharedArtifactBlobCount}`,
            `orphan_artifact_blobs=${stats.orphanArtifactBlobCount}`,
            `message_fts=${stats.messageFtsCount}`,
            `summary_fts=${stats.summaryFtsCount}`,
            `artifact_fts=${stats.artifactFtsCount}`,
            `default_grep_scope=${options.scopeDefaults.grep}`,
            `default_describe_scope=${options.scopeDefaults.describe}`,
            `scope_profiles=${options.scopeProfiles.length}`,
            `retention_stale_session_days=${options.retention.staleSessionDays ?? 'disabled'}`,
            `retention_deleted_session_days=${options.retention.deletedSessionDays ?? 'disabled'}`,
            `retention_orphan_blob_days=${options.retention.orphanBlobDays ?? 'disabled'}`,
            ...(stats.recovery
              ? [
                  `recovery_at=${stats.recovery.at}`,
                  `recovery_reason=${stats.recovery.reason.replace(/[\r\n]+/g, ' ')}`,
                  `recovery_quarantined_files=${stats.recovery.quarantinedFiles.length}`,
                  ...stats.recovery.quarantinedFiles.map((file: string) => `recovery_file=${file}`),
                ]
              : ['recovery=none']),
            `automatic_retrieval_enabled=${options.automaticRetrieval.enabled}`,
            `automatic_retrieval_max_chars=${options.automaticRetrieval.maxChars}`,
            `automatic_retrieval_min_tokens=${options.automaticRetrieval.minTokens}`,
            `automatic_retrieval_message_hits=${options.automaticRetrieval.maxMessageHits}`,
            `automatic_retrieval_summary_hits=${options.automaticRetrieval.maxSummaryHits}`,
            `automatic_retrieval_artifact_hits=${options.automaticRetrieval.maxArtifactHits}`,
            `automatic_retrieval_scope_order=${options.automaticRetrieval.scopeOrder.join(',')}`,
            `automatic_retrieval_scope_budgets=session:${options.automaticRetrieval.scopeBudgets.session},root:${options.automaticRetrieval.scopeBudgets.root},worktree:${options.automaticRetrieval.scopeBudgets.worktree},all:${options.automaticRetrieval.scopeBudgets.all}`,
            `automatic_retrieval_stop_target_hits=${options.automaticRetrieval.stop.targetHits}`,
            `automatic_retrieval_stop_on_first_scope_with_hits=${options.automaticRetrieval.stop.stopOnFirstScopeWithHits}`,
            `fresh_tail_messages=${options.freshTailMessages}`,
            `min_messages_for_transform=${options.minMessagesForTransform}`,
            `large_content_threshold=${options.largeContentThreshold}`,
            `runtime_safety_allow_unsafe_bun_windows=${bunWindowsSafety.allowed}`,
            `runtime_safety_config_allow_unsafe_bun_windows=${bunWindowsSafety.configRequested}`,
            `runtime_safety_env_allow_unsafe_bun_windows=${bunWindowsSafety.envRequested}`,
            `runtime_safety_backend=${runtimeBackend}`,
            `binary_preview_providers=${options.binaryPreviewProviders.join(',')}`,
            `preview_byte_peek=${options.previewBytePeek}`,
            `privacy_exclude_tool_prefixes=${options.privacy.excludeToolPrefixes.join(',')}`,
            `privacy_exclude_path_patterns=${options.privacy.excludePathPatterns.length}`,
            `privacy_redact_patterns=${options.privacy.redactPatterns.length}`,
            `recent_hook_failures=${hookFailures.length}`,
            ...hookFailures
              .slice(-3)
              .map(
                (failure) =>
                  `hook_failure=${failure.at} op=${failure.op} message=${failure.message.replace(/[\r\n]+/g, ' ')}`,
              ),
            ...Object.entries(stats.prunableEventTypes as Record<string, number>)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([type, count]) => `prunable_${type}=${count}`),
            ...Object.entries(stats.eventTypes as Record<string, number>)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([type, count]) => `${type}=${count}`),
          ];
          return { content: lines.join('\n') };
        },
      });

      editor.add({
        name: 'lcm_retrieval_debug',
        description: 'Show latest automatic retrieval diagnostics',
        input: {
          type: 'object',
          properties: {
            sessionID: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const sessionID = (input as { sessionID?: string }).sessionID;
          return { content: await store.automaticRetrievalDebug(sessionID) };
        },
      });

      editor.add({
        name: 'lcm_resume',
        description: 'Show the latest archived resume note',
        input: {
          type: 'object',
          properties: {
            sessionID: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const sessionID = (input as { sessionID?: string }).sessionID;
          return { content: await store.resume(sessionID) };
        },
      });

      editor.add({
        name: 'lcm_grep',
        description:
          'Search archived LCM capture with scope. Paginate by repeating with offset = previous offset + limit.',
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1 },
            sessionID: { type: 'string' },
            scope: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
            offset: { type: 'integer', minimum: 0, maximum: 200 },
            summaryID: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as {
            query: string;
            sessionID?: string;
            scope?: string;
            limit?: number;
            offset?: number;
            summaryID?: string;
          };
          const results = await store.grep({
            query: typedInput.query,
            sessionID: typedInput.sessionID,
            scope: typedInput.scope,
            limit: typedInput.limit ?? 5,
            offset: typedInput.offset,
            summaryID: typedInput.summaryID,
          });
          if (typeof results === 'string') return { content: results };
          if (results.length === 0) return { content: 'No archived matches found.' };

          return {
            content: results
              .map((result: SearchResult) => {
                const session = result.sessionID ?? '-';
                return `[${result.type}] session=${session} node=${result.nodeID ?? '-'} ${result.snippet}`;
              })
              .join('\n\n'),
          };
        },
      });

      editor.add({
        name: 'lcm_describe',
        description: 'Summarize archived session capture with scope',
        input: {
          type: 'object',
          properties: {
            sessionID: { type: 'string' },
            scope: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as { sessionID?: string; scope?: string };
          return { content: await store.describe({
            sessionID: typedInput.sessionID,
            scope: typedInput.scope,
          })};
        },
      });

      editor.add({
        name: 'lcm_lineage',
        description: 'Show archived branch lineage for a session',
        input: {
          type: 'object',
          properties: {
            sessionID: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const sessionID = (input as { sessionID?: string }).sessionID;
          return { content: await store.lineage(sessionID) };
        },
      });

      editor.add({
        name: 'lcm_pin_session',
        description: 'Pin a session so retention pruning will skip it',
        input: {
          type: 'object',
          properties: {
            sessionID: { type: 'string' },
            reason: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as { sessionID?: string; reason?: string };
          return { content: await store.pinSession({
            sessionID: typedInput.sessionID,
            reason: typedInput.reason,
          })};
        },
      });

      editor.add({
        name: 'lcm_unpin_session',
        description: 'Remove a session retention pin',
        input: {
          type: 'object',
          properties: {
            sessionID: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const sessionID = (input as { sessionID?: string }).sessionID;
          return { content: await store.unpinSession({ sessionID }) };
        },
      });

      editor.add({
        name: 'lcm_expand',
        description:
          'Progressively expand archived summary nodes. Raw messages are excluded by default; pass includeRaw=true only when summaries are insufficient.',
        input: {
          type: 'object',
          properties: {
            sessionID: { type: 'string' },
            nodeID: { type: 'string' },
            query: { type: 'string' },
            depth: { type: 'integer', minimum: 1, maximum: 4 },
            messageLimit: { type: 'integer', minimum: 1, maximum: 20 },
            includeRaw: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as {
            sessionID?: string;
            nodeID?: string;
            query?: string;
            depth?: number;
            messageLimit?: number;
            includeRaw?: boolean;
          };
          return { content: await store.expand({
            sessionID: typedInput.sessionID,
            nodeID: typedInput.nodeID,
            query: typedInput.query,
            depth: typedInput.depth,
            messageLimit: typedInput.messageLimit,
            includeRaw: typedInput.includeRaw,
          })};
        },
      });

      editor.add({
        name: 'lcm_artifact',
        description: 'View externalized archived content by artifact ID',
        input: {
          type: 'object',
          properties: {
            artifactID: { type: 'string', minLength: 1 },
            chars: { type: 'integer', minimum: 200, maximum: 20000 },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as { artifactID: string; chars?: number };
          return { content: await store.artifact({
            artifactID: typedInput.artifactID,
            chars: typedInput.chars,
          })};
        },
      });

      editor.add({
        name: 'lcm_blob_stats',
        description: 'Show deduplicated artifact blob stats',
        input: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as { limit?: number };
          return { content: await store.blobStats({
            limit: typedInput.limit,
          })};
        },
      });

      editor.add({
        name: 'lcm_blob_gc',
        description: 'Preview or delete orphaned artifact blobs',
        input: {
          type: 'object',
          properties: {
            apply: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as { apply?: boolean; limit?: number };
          return { content: await store.gcBlobs({
            apply: typedInput.apply,
            limit: typedInput.limit,
          })};
        },
      });

      editor.add({
        name: 'lcm_compact',
        description:
          'Measure and reclaim archive database space (prune internal events, checkpoint WAL, and VACUUM when worthwhile)',
        input: {
          type: 'object',
          properties: {
            apply: { type: 'boolean' },
            vacuum: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as { apply?: boolean; vacuum?: boolean; limit?: number };
          return { content: await store.compact({
            apply: typedInput.apply,
            vacuum: typedInput.vacuum,
            limit: typedInput.limit,
          })};
        },
      });

      editor.add({
        name: 'lcm_doctor',
        description: 'Inspect or repair archive summaries and indexes',
        input: {
          type: 'object',
          properties: {
            apply: { type: 'boolean' },
            sessionID: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as { apply?: boolean; sessionID?: string; limit?: number };
          return { content: await store.doctor({
            apply: typedInput.apply,
            sessionID: typedInput.sessionID,
            limit: typedInput.limit,
          })};
        },
      });

      editor.add({
        name: 'lcm_retention_report',
        description: 'Preview stale-session and orphan-blob retention candidates',
        input: {
          type: 'object',
          properties: {
            staleSessionDays: { type: 'number' },
            deletedSessionDays: { type: 'number' },
            orphanBlobDays: { type: 'number' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as {
            staleSessionDays?: number;
            deletedSessionDays?: number;
            orphanBlobDays?: number;
            limit?: number;
          };
          return { content: await store.retentionReport({
            staleSessionDays: typedInput.staleSessionDays,
            deletedSessionDays: typedInput.deletedSessionDays,
            orphanBlobDays: typedInput.orphanBlobDays,
            limit: typedInput.limit,
          })};
        },
      });

      editor.add({
        name: 'lcm_retention_prune',
        description: 'Preview or apply stale-session and orphan-blob retention pruning',
        input: {
          type: 'object',
          properties: {
            apply: { type: 'boolean' },
            staleSessionDays: { type: 'number' },
            deletedSessionDays: { type: 'number' },
            orphanBlobDays: { type: 'number' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as {
            apply?: boolean;
            staleSessionDays?: number;
            deletedSessionDays?: number;
            orphanBlobDays?: number;
            limit?: number;
          };
          return { content: await store.retentionPrune({
            apply: typedInput.apply,
            staleSessionDays: typedInput.staleSessionDays,
            deletedSessionDays: typedInput.deletedSessionDays,
            orphanBlobDays: typedInput.orphanBlobDays,
            limit: typedInput.limit,
          })};
        },
      });

      editor.add({
        name: 'lcm_export_snapshot',
        description: 'Export a portable long-memory snapshot to a JSON file',
        input: {
          type: 'object',
          properties: {
            filePath: { type: 'string', minLength: 1 },
            sessionID: { type: 'string' },
            scope: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as { filePath: string; sessionID?: string; scope?: string };
          return { content: await store.exportSnapshot({
            filePath: typedInput.filePath,
            sessionID: typedInput.sessionID,
            scope: typedInput.scope,
          })};
        },
      });

      editor.add({
        name: 'lcm_import_snapshot',
        description: 'Import a portable long-memory snapshot from a JSON file',
        input: {
          type: 'object',
          properties: {
            filePath: { type: 'string', minLength: 1 },
            mode: { type: 'string' },
            worktreeMode: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const typedInput = input as {
            filePath: string;
            mode?: string;
            worktreeMode?: string;
          };
          if (typedInput.mode !== 'merge' && typedInput.mode !== 'replace') {
            return { content: 'Snapshot import mode is required; choose "merge" or "replace".' };
          }
          return { content: await store.importSnapshot({
            filePath: typedInput.filePath,
            mode: typedInput.mode,
            worktreeMode:
              typedInput.worktreeMode === 'preserve' || typedInput.worktreeMode === 'current'
                ? typedInput.worktreeMode
                : 'auto',
          })};
        },
      });
    });

    // Hook: chat.messages.transform → session.hook("context")
    // This transforms messages before they're sent to the model (automatic recall)
    await ctx.session.hook('context', async (event) => {
      // Convert V2 SDK messages to local ConversationMessage[] for the store
      const conversationMessages: Array<{ info: Message; parts: Part[] }> = event.messages.map((msg) => ({
        info: {
          id: msg.id,
          sessionID: event.sessionID,
          role: msg.role,
          time: { created: Date.now() },
        } as Message,
        parts: (msg.content ?? []) as Part[],
      }));
      await runOptionalPluginWork('chat.messages.transform', () =>
        store.transformMessages(conversationMessages),
      );
    });

    // Hook: chat.system.transform → session.hook("context")
    // This adds the system hint to the system messages
    await ctx.session.hook('context', (event) => {
      const hint = store.systemHint();
      if (!hint) return;
      event.system.push({ type: 'text', text: hint });
    });

    // Hook: session.compacting → session.hook("compaction")
    // This adds the resume note during compaction
    await ctx.session.hook('compaction', async (event) => {
      const note = await runOptionalPluginWork('session.compacting', () =>
        store.buildCompactionContext(event.sessionID),
      );
      if (!note || typeof note !== 'string') return;
      if (event.system.some((s) => s.type === 'text' && s.text.includes('LCM prototype resume note'))) return;
      event.system.push({ type: 'text', text: note });
    });

    // Cleanup: abort the event subscription when the plugin unloads
    return () => controller.abort();
  },
});

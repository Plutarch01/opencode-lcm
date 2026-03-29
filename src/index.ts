import { type Hooks, type PluginInput, tool } from "@opencode-ai/plugin";

import { resolveOptions } from "./options.js";
import { SqliteLcmStore } from "./store.js";

type PluginWithOptions = (ctx: PluginInput, rawOptions?: unknown) => Promise<Hooks>;

export const OpencodeLcmPlugin: PluginWithOptions = async (ctx, rawOptions) => {
  const options = resolveOptions(rawOptions);
  const store = new SqliteLcmStore(ctx.directory, options);

  await store.init();

  return {
    event: async ({ event }) => {
      await store.capture(event);
    },

    tool: {
      lcm_status: tool({
        description: "Show archived LCM capture stats",
        args: {},
        async execute() {
          const stats = await store.stats();
          const lines = [
            `total_events=${stats.totalEvents}`,
            `session_count=${stats.sessionCount}`,
            `root_sessions=${stats.rootSessionCount}`,
            `branched_sessions=${stats.branchedSessionCount}`,
            `pinned_sessions=${stats.pinnedSessionCount}`,
            `worktrees=${stats.worktreeCount}`,
            `latest_event_at=${stats.latestEventAt ?? "n/a"}`,
            `summary_nodes=${stats.summaryNodeCount}`,
            `summary_states=${stats.summaryStateCount}`,
            `artifacts=${stats.artifactCount}`,
            `artifact_blobs=${stats.artifactBlobCount}`,
            `shared_artifact_blobs=${stats.sharedArtifactBlobCount}`,
            `orphan_artifact_blobs=${stats.orphanArtifactBlobCount}`,
            `default_grep_scope=${options.scopeDefaults.grep}`,
            `default_describe_scope=${options.scopeDefaults.describe}`,
            `scope_profiles=${options.scopeProfiles.length}`,
            `retention_stale_session_days=${options.retention.staleSessionDays ?? "disabled"}`,
            `retention_deleted_session_days=${options.retention.deletedSessionDays ?? "disabled"}`,
            `retention_orphan_blob_days=${options.retention.orphanBlobDays ?? "disabled"}`,
            `automatic_retrieval_enabled=${options.automaticRetrieval.enabled}`,
            `automatic_retrieval_max_chars=${options.automaticRetrieval.maxChars}`,
            `automatic_retrieval_min_tokens=${options.automaticRetrieval.minTokens}`,
            `automatic_retrieval_message_hits=${options.automaticRetrieval.maxMessageHits}`,
            `automatic_retrieval_summary_hits=${options.automaticRetrieval.maxSummaryHits}`,
            `automatic_retrieval_artifact_hits=${options.automaticRetrieval.maxArtifactHits}`,
            `automatic_retrieval_scope_order=${options.automaticRetrieval.scopeOrder.join(",")}`,
            `automatic_retrieval_scope_budgets=session:${options.automaticRetrieval.scopeBudgets.session},root:${options.automaticRetrieval.scopeBudgets.root},worktree:${options.automaticRetrieval.scopeBudgets.worktree},all:${options.automaticRetrieval.scopeBudgets.all}`,
            `automatic_retrieval_stop_target_hits=${options.automaticRetrieval.stop.targetHits}`,
            `automatic_retrieval_stop_on_first_scope_with_hits=${options.automaticRetrieval.stop.stopOnFirstScopeWithHits}`,
            `fresh_tail_messages=${options.freshTailMessages}`,
            `min_messages_for_transform=${options.minMessagesForTransform}`,
            `large_content_threshold=${options.largeContentThreshold}`,
            `binary_preview_providers=${options.binaryPreviewProviders.join(",")}`,
            `preview_byte_peek=${options.previewBytePeek}`,
            ...Object.entries(stats.eventTypes)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([type, count]) => `${type}=${count}`),
          ];
          return lines.join("\n");
        },
      }),

      lcm_resume: tool({
        description: "Show the latest archived resume note",
        args: {
          sessionID: tool.schema.string().optional(),
        },
        async execute(args) {
          return await store.resume(args.sessionID);
        },
      }),

      lcm_grep: tool({
        description: "Search archived LCM capture with scope",
        args: {
          query: tool.schema.string().min(1),
          sessionID: tool.schema.string().optional(),
          scope: tool.schema.string().optional(),
          limit: tool.schema.number().int().min(1).max(20).optional(),
        },
        async execute(args) {
          const results = await store.grep({
            query: args.query,
            sessionID: args.sessionID,
            scope: args.scope,
            limit: args.limit ?? 5,
          });
          if (results.length === 0) return "No archived matches found.";

          return results
            .map((result) => {
              const suffix = result.sessionID ? ` session=${result.sessionID}` : "";
              return `[${result.type}]${suffix} ${result.snippet}`;
            })
            .join("\n\n");
        },
      }),

      lcm_describe: tool({
        description: "Summarize archived session capture with scope",
        args: {
          sessionID: tool.schema.string().optional(),
          scope: tool.schema.string().optional(),
        },
        async execute(args) {
          return await store.describe({
            sessionID: args.sessionID,
            scope: args.scope,
          });
        },
      }),

      lcm_lineage: tool({
        description: "Show archived branch lineage for a session",
        args: {
          sessionID: tool.schema.string().optional(),
        },
        async execute(args) {
          return await store.lineage(args.sessionID);
        },
      }),

      lcm_pin_session: tool({
        description: "Pin a session so retention pruning will skip it",
        args: {
          sessionID: tool.schema.string().optional(),
          reason: tool.schema.string().optional(),
        },
        async execute(args) {
          return await store.pinSession({
            sessionID: args.sessionID,
            reason: args.reason,
          });
        },
      }),

      lcm_unpin_session: tool({
        description: "Remove a session retention pin",
        args: {
          sessionID: tool.schema.string().optional(),
        },
        async execute(args) {
          return await store.unpinSession({
            sessionID: args.sessionID,
          });
        },
      }),

      lcm_expand: tool({
        description: "Expand archived summary nodes into targeted descendants or raw messages",
        args: {
          sessionID: tool.schema.string().optional(),
          nodeID: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          depth: tool.schema.number().int().min(1).max(4).optional(),
          messageLimit: tool.schema.number().int().min(1).max(20).optional(),
          includeRaw: tool.schema.boolean().optional(),
        },
        async execute(args) {
          return await store.expand({
            sessionID: args.sessionID,
            nodeID: args.nodeID,
            query: args.query,
            depth: args.depth,
            messageLimit: args.messageLimit,
            includeRaw: args.includeRaw,
          });
        },
      }),

      lcm_artifact: tool({
        description: "View externalized archived content by artifact ID",
        args: {
          artifactID: tool.schema.string().min(1),
          chars: tool.schema.number().int().min(200).max(20000).optional(),
        },
        async execute(args) {
          return await store.artifact({
            artifactID: args.artifactID,
            chars: args.chars,
          });
        },
      }),

      lcm_blob_stats: tool({
        description: "Show deduplicated artifact blob stats",
        args: {
          limit: tool.schema.number().int().min(1).max(20).optional(),
        },
        async execute(args) {
          return await store.blobStats({
            limit: args.limit,
          });
        },
      }),

      lcm_blob_gc: tool({
        description: "Preview or delete orphaned artifact blobs",
        args: {
          apply: tool.schema.boolean().optional(),
          limit: tool.schema.number().int().min(1).max(50).optional(),
        },
        async execute(args) {
          return await store.gcBlobs({
            apply: args.apply,
            limit: args.limit,
          });
        },
      }),

      lcm_doctor: tool({
        description: "Inspect or repair archive summaries and indexes",
        args: {
          apply: tool.schema.boolean().optional(),
          sessionID: tool.schema.string().optional(),
          limit: tool.schema.number().int().min(1).max(50).optional(),
        },
        async execute(args) {
          return await store.doctor({
            apply: args.apply,
            sessionID: args.sessionID,
            limit: args.limit,
          });
        },
      }),

      lcm_retention_report: tool({
        description: "Preview stale-session and orphan-blob retention candidates",
        args: {
          staleSessionDays: tool.schema.number().min(0).optional(),
          deletedSessionDays: tool.schema.number().min(0).optional(),
          orphanBlobDays: tool.schema.number().min(0).optional(),
          limit: tool.schema.number().int().min(1).max(50).optional(),
        },
        async execute(args) {
          return await store.retentionReport({
            staleSessionDays: args.staleSessionDays,
            deletedSessionDays: args.deletedSessionDays,
            orphanBlobDays: args.orphanBlobDays,
            limit: args.limit,
          });
        },
      }),

      lcm_retention_prune: tool({
        description: "Preview or apply stale-session and orphan-blob retention pruning",
        args: {
          apply: tool.schema.boolean().optional(),
          staleSessionDays: tool.schema.number().min(0).optional(),
          deletedSessionDays: tool.schema.number().min(0).optional(),
          orphanBlobDays: tool.schema.number().min(0).optional(),
          limit: tool.schema.number().int().min(1).max(50).optional(),
        },
        async execute(args) {
          return await store.retentionPrune({
            apply: args.apply,
            staleSessionDays: args.staleSessionDays,
            deletedSessionDays: args.deletedSessionDays,
            orphanBlobDays: args.orphanBlobDays,
            limit: args.limit,
          });
        },
      }),

      lcm_export_snapshot: tool({
        description: "Export a portable long-memory snapshot to a JSON file",
        args: {
          filePath: tool.schema.string().min(1),
          sessionID: tool.schema.string().optional(),
          scope: tool.schema.string().optional(),
        },
        async execute(args) {
          return await store.exportSnapshot({
            filePath: args.filePath,
            sessionID: args.sessionID,
            scope: args.scope,
          });
        },
      }),

      lcm_import_snapshot: tool({
        description: "Import a portable long-memory snapshot from a JSON file",
        args: {
          filePath: tool.schema.string().min(1),
          mode: tool.schema.string().optional(),
          worktreeMode: tool.schema.string().optional(),
        },
        async execute(args) {
          return await store.importSnapshot({
            filePath: args.filePath,
            mode: args.mode === "merge" ? "merge" : "replace",
            worktreeMode: args.worktreeMode === "preserve" || args.worktreeMode === "current" ? args.worktreeMode : "auto",
          });
        },
      }),
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      await store.transformMessages(output.messages);
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const hint = store.systemHint();
      if (!hint) return;
      output.system.push(hint);
    },

    "experimental.session.compacting": async (input, output) => {
      const note = await store.buildCompactionContext(input.sessionID);
      if (!note) return;
      if (output.context.some((entry) => entry.includes("LCM prototype resume note"))) return;
      output.context.push(note);
    },
  };
};

export default OpencodeLcmPlugin;

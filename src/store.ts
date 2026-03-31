import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Event, Message, Part } from '@opencode-ai/sdk';

import {
  buildActiveSummaryText,
  renderAutomaticRetrievalContext,
  resolveArchiveTransformWindow,
  selectAutomaticRetrievalHits,
} from './archive-transform.js';
import {
  AUTOMATIC_RETRIEVAL_QUERY_TOKENS,
  AUTOMATIC_RETRIEVAL_QUERY_VARIANTS,
  AUTOMATIC_RETRIEVAL_RECENT_MESSAGES,
  EXPAND_MESSAGE_LIMIT,
  STORE_SCHEMA_VERSION,
  SUMMARY_BRANCH_FACTOR,
  SUMMARY_LEAF_MESSAGES,
  SUMMARY_NODE_CHAR_LIMIT,
} from './constants.js';
import { type DoctorReport, type DoctorSessionIssue, formatDoctorReport } from './doctor.js';
import { getLogger } from './logging.js';
import { runBinaryPreviewProviders } from './preview-providers.js';
import { safeQuery, safeQueryOne } from './sql-utils.js';
import {
  buildFtsQuery,
  rebuildSearchIndexesSync as rebuildSearchIndexesModule,
  replaceMessageSearchRowSync as replaceMessageSearchRowModule,
  replaceMessageSearchRowsSync as replaceMessageSearchRowsModule,
  searchByScan as searchByScanModule,
  searchWithFts as searchWithFtsModule,
} from './store-search.js';
import {
  type ArtifactBlobRow,
  type ArtifactRow,
  exportStoreSnapshot,
  importStoreSnapshot,
  type MessageRow,
  type PartRow,
  type SessionRow,
  type SnapshotScope,
  type SnapshotWorktreeMode,
  type SummaryEdgeRow,
  type SummaryNodeRow,
  type SummaryStateRow,
} from './store-snapshot.js';
import type {
  CapturedEvent,
  ConversationMessage,
  NormalizedSession,
  OpencodeLcmOptions,
  ScopeName,
  SearchResult,
  StoreStats,
} from './types.js';
import {
  asRecord,
  classifyFileCategory,
  filterIntentTokens,
  firstFiniteNumber,
  formatMetadataValue,
  formatRetentionDays,
  hashContent,
  inferFileExtension,
  inferUrlScheme,
  isAutomaticRetrievalNoise,
  sanitizeAutomaticRetrievalSourceText,
  shortNodeID,
  shouldSuppressLowSignalAutomaticRetrievalAnchor,
  tokenizeQuery,
  truncate,
} from './utils.js';
import { normalizeWorktreeKey } from './worktree-key.js';

type ResumeMap = Record<string, string>;

type SummaryNodeData = {
  nodeID: string;
  sessionID: string;
  level: number;
  nodeKind: 'leaf' | 'internal';
  startIndex: number;
  endIndex: number;
  messageIDs: string[];
  summaryText: string;
  createdAt: number;
};

type ArtifactData = {
  artifactID: string;
  sessionID: string;
  messageID: string;
  partID: string;
  artifactKind: string;
  fieldName: string;
  previewText: string;
  contentText: string;
  contentHash: string;
  charCount: number;
  createdAt: number;
  metadata: Record<string, unknown>;
};

import type {
  ResolvedRetentionPolicy,
  RetentionBlobCandidate,
  RetentionSessionCandidate,
} from './store-retention.js';
import type { SqlDatabaseLike, SqlStatementLike } from './store-types.js';

type ReadSessionOptions = {
  artifactMessageIDs?: string[];
};

function extractSessionID(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) return undefined;

  if (typeof record.sessionID === 'string') return record.sessionID;

  const properties = asRecord(record.properties);
  if (!properties) return undefined;

  if (typeof properties.sessionID === 'string') return properties.sessionID;

  const info = asRecord(properties.info);
  if (info && typeof info.sessionID === 'string') return info.sessionID;

  const part = asRecord(properties.part);
  if (part && typeof part.sessionID === 'string') return part.sessionID;

  return undefined;
}

function extractTimestamp(event: unknown): number {
  const record = asRecord(event);
  if (!record) return Date.now();

  const properties = asRecord(record.properties);
  const time = asRecord(properties?.time);

  if (typeof record.timestamp === 'number') return record.timestamp;
  if (typeof properties?.timestamp === 'number') return properties.timestamp;
  if (typeof time?.created === 'number') return time.created;
  if (typeof properties?.time === 'number') return properties.time;

  return Date.now();
}

function normalizeEvent(event: unknown): CapturedEvent | null {
  const record = asRecord(event);
  if (!record || typeof record.type !== 'string') return null;

  return {
    id: randomUUID(),
    type: record.type,
    sessionID: extractSessionID(event),
    timestamp: extractTimestamp(event),
    payload: event,
  };
}

function compareMessages(a: ConversationMessage, b: ConversationMessage): number {
  return a.info.time.created - b.info.time.created;
}

function buildSummaryNodeID(sessionID: string, level: number, slot: number): string {
  return `sum_${hashContent(`summary:${sessionID}`).slice(0, 12)}_l${level}_p${slot}`;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isSyntheticLcmTextPart(part: Part, markers?: string[]): boolean {
  if (part.type !== 'text') return false;
  const marker = part.metadata?.opencodeLcm;
  if (typeof marker !== 'string') return false;
  return markers ? markers.includes(marker) : true;
}

function guessMessageText(message: ConversationMessage, ignoreToolPrefixes: string[]): string {
  const segments: string[] = [];

  for (const part of message.parts) {
    switch (part.type) {
      case 'text':
        if (isSyntheticLcmTextPart(part, ['archive-summary', 'retrieved-context', 'archived-part']))
          break;
        if (part.text.startsWith('[Archived by opencode-lcm:')) break;
        segments.push(part.text);
        break;
      case 'reasoning':
        if (part.text.startsWith('[Archived by opencode-lcm:')) break;
        segments.push(part.text);
        break;
      case 'file': {
        const sourcePath = part.source?.path;
        const filename = part.filename;
        const inlineText = part.source?.text?.value;
        segments.push([sourcePath ?? filename ?? 'file', inlineText].filter(Boolean).join(': '));
        break;
      }
      case 'tool': {
        if (ignoreToolPrefixes.some((prefix) => part.tool.startsWith(prefix))) break;
        const state = part.state;
        if (state.status === 'completed') segments.push(`${part.tool}: ${state.output}`);
        if (state.status === 'error') segments.push(`${part.tool}: ${state.error}`);
        if (state.status === 'pending' || state.status === 'running') {
          segments.push(`${part.tool}: ${JSON.stringify(state.input)}`);
        }
        if (state.status === 'completed' && state.attachments && state.attachments.length > 0) {
          const attachmentNames = state.attachments
            .map((file) => file.source?.path ?? file.filename ?? file.url)
            .filter(Boolean)
            .slice(0, 4);
          if (attachmentNames.length > 0)
            segments.push(`${part.tool} attachments: ${attachmentNames.join(', ')}`);
        }
        break;
      }
      case 'subtask':
        segments.push(`${part.agent}: ${part.description}`);
        break;
      case 'agent':
        segments.push(part.name);
        break;
      case 'snapshot':
        segments.push(part.snapshot);
        break;
      default:
        break;
    }
  }

  return truncate(segments.filter(Boolean).join('\n').replace(/\s+/g, ' ').trim(), 500);
}

function listFiles(message: ConversationMessage): string[] {
  const files = new Set<string>();

  for (const part of message.parts) {
    if (part.type === 'file') {
      if (part.source?.path) files.add(part.source.path);
      else if (part.filename) files.add(part.filename);
    }

    if (part.type === 'patch') {
      for (const file of part.files.slice(0, 20)) files.add(file);
    }
  }

  return [...files];
}

function makeSessionTitle(session: NormalizedSession): string | undefined {
  if (session.title) return session.title;

  const firstUser = session.messages.find((message) => message.info.role === 'user');
  if (!firstUser) return undefined;

  return truncate(guessMessageText(firstUser, []), 80);
}

function archivePlaceholder(label: string): string {
  return `[Archived by opencode-lcm: ${label}. Use lcm_resume, lcm_grep, or lcm_expand for details.]`;
}

function artifactPlaceholder(
  artifactID: string,
  label: string,
  preview: string,
  charCount: number,
): string {
  const body = preview ? ` Preview: ${preview}` : '';
  return `[Externalized ${label} as ${artifactID} (${charCount} chars). Use lcm_artifact for full content.]${body}`;
}

function fileCategoryHint(category: string): string {
  switch (category) {
    case 'image':
      return 'Visual asset or screenshot; exact pixels still require the source file.';
    case 'pdf':
      return 'Formatted document; exact layout and embedded pages still require the source file.';
    case 'audio':
      return 'Audio asset; waveform and transcription details still require the source file.';
    case 'video':
      return 'Video asset; frames and timing still require the source file.';
    case 'archive':
      return 'Bundled archive; internal file listing still requires unpacking the source file.';
    case 'spreadsheet':
      return 'Spreadsheet-like document; formulas and cell layout may require the source file.';
    case 'presentation':
      return 'Slide deck; visual layout and speaker notes may require the source file.';
    case 'document':
      return 'Rich document; styled content and embedded assets may require the source file.';
    case 'code':
      return 'Code or source-like file reference; load the file body if exact lines matter.';
    case 'structured-data':
      return 'Structured data file reference; exact records may require the full source body.';
    default:
      return 'Binary or opaque artifact reference; inspect the original file for exact contents.';
  }
}

async function openSqliteDatabase(dbPath: string): Promise<SqlDatabaseLike> {
  const isBunRuntime = typeof globalThis === 'object' && 'Bun' in globalThis;

  if (isBunRuntime) {
    const loadRuntimeModule = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<Record<string, unknown>>;
    const { Database } = (await loadRuntimeModule('bun:sqlite')) as Record<string, unknown>;
    const db = new (
      Database as new (
        path: string,
        opts?: { create: boolean },
      ) => {
        exec(sql: string): void;
        close(): void;
        prepare(sql: string): {
          run(...args: unknown[]): void;
          get(...args: unknown[]): Record<string, unknown>;
          all(...args: unknown[]): Record<string, unknown>[];
          values(...args: unknown[]): unknown[][];
        };
        query(sql: string): {
          run(...args: unknown[]): void;
          get(...args: unknown[]): Record<string, unknown>;
          all(...args: unknown[]): Record<string, unknown>[];
        };
      }
    )(dbPath, { create: true });
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');

    return {
      exec(sql: string) {
        return db.exec(sql);
      },
      close() {
        db.close();
      },
      prepare(sql: string) {
        const statement = typeof db.prepare === 'function' ? db.prepare(sql) : db.query(sql);
        return {
          run(...args: unknown[]) {
            return statement.run(...args);
          },
          get(...args: unknown[]) {
            return statement.get(...args);
          },
          all(...args: unknown[]) {
            return statement.all(...args);
          },
        };
      },
    };
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });

  return {
    exec(sql: string) {
      return db.exec(sql);
    },
    close() {
      db.close();
    },
    prepare(sql: string) {
      return db.prepare(sql) as SqlStatementLike;
    },
  };
}

export class SqliteLcmStore {
  private readonly baseDir: string;
  private readonly dbPath: string;
  private readonly workspaceDirectory: string;
  private db?: SqlDatabaseLike;

  constructor(
    projectDir: string,
    private readonly options: OpencodeLcmOptions,
  ) {
    this.workspaceDirectory = projectDir;
    this.baseDir = path.join(projectDir, options.storeDir ?? '.lcm');
    this.dbPath = path.join(this.baseDir, 'lcm.db');
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    this.db = await openSqliteDatabase(this.dbPath);

    const db = this.getDb();
    this.assertSupportedSchemaVersionSync();
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        event_type TEXT NOT NULL,
        ts INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT,
        session_directory TEXT,
        worktree_key TEXT,
        parent_session_id TEXT,
        root_session_id TEXT,
        lineage_depth INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        pin_reason TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0,
        compacted_at INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        info_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at, message_id);

      CREATE TABLE IF NOT EXISTS parts (
        part_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sort_key INTEGER NOT NULL DEFAULT 0,
        part_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_parts_message_sort ON parts(message_id, sort_key, part_id);

      CREATE TABLE IF NOT EXISTS resumes (
        session_id TEXT PRIMARY KEY,
        note TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        field_name TEXT NOT NULL,
        preview_text TEXT NOT NULL,
        content_text TEXT NOT NULL,
        content_hash TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        char_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_session_message ON artifacts(session_id, message_id, part_id);

      CREATE TABLE IF NOT EXISTS artifact_blobs (
        content_hash TEXT PRIMARY KEY,
        content_text TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS summary_nodes (
        node_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        node_kind TEXT NOT NULL,
        start_index INTEGER NOT NULL,
        end_index INTEGER NOT NULL,
        message_ids_json TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_summary_nodes_session_level ON summary_nodes(session_id, level);

      CREATE TABLE IF NOT EXISTS summary_edges (
        session_id TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        child_position INTEGER NOT NULL,
        PRIMARY KEY (parent_id, child_id),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES summary_nodes(node_id) ON DELETE CASCADE,
        FOREIGN KEY (child_id) REFERENCES summary_nodes(node_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_summary_edges_session_parent ON summary_edges(session_id, parent_id, child_position);

      CREATE TABLE IF NOT EXISTS summary_state (
        session_id TEXT PRIMARY KEY,
        archived_count INTEGER NOT NULL,
        latest_message_created INTEGER NOT NULL,
        archived_signature TEXT NOT NULL DEFAULT '',
        root_node_ids_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
        session_id UNINDEXED,
        message_id UNINDEXED,
        role UNINDEXED,
        created_at UNINDEXED,
        content
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS summary_fts USING fts5(
        session_id UNINDEXED,
        node_id UNINDEXED,
        level UNINDEXED,
        created_at UNINDEXED,
        content
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
        session_id UNINDEXED,
        artifact_id UNINDEXED,
        message_id UNINDEXED,
        part_id UNINDEXED,
        artifact_kind UNINDEXED,
        created_at UNINDEXED,
        content
      );
    `);

    this.ensureSessionColumnsSync();
    this.ensureSummaryStateColumnsSync();
    this.ensureArtifactColumnsSync();
    db.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_content_hash ON artifacts(content_hash)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_root ON sessions(root_session_id, updated_at DESC)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id, updated_at DESC)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_worktree ON sessions(worktree_key, updated_at DESC)',
    );
    await this.migrateLegacyArtifacts();
    this.writeSchemaVersionSync(STORE_SCHEMA_VERSION);
    this.db = db;
    this.completeDeferredInit();
  }

  private deferredInitCompleted = false;

  private readSchemaVersionSync(): number {
    return firstFiniteNumber(this.getDb().prepare('PRAGMA user_version').get()) ?? 0;
  }

  private assertSupportedSchemaVersionSync(): void {
    const schemaVersion = this.readSchemaVersionSync();
    if (schemaVersion <= STORE_SCHEMA_VERSION) return;
    throw new Error(
      `Unsupported store schema version: ${schemaVersion}. This build supports up to ${STORE_SCHEMA_VERSION}.`,
    );
  }

  private writeSchemaVersionSync(version: number): void {
    this.getDb().exec(`PRAGMA user_version = ${Math.max(0, Math.trunc(version))}`);
  }

  private completeDeferredInit(): void {
    if (this.deferredInitCompleted) return;
    this.backfillArtifactBlobsSync();
    this.deleteOrphanArtifactBlobsSync();
    if (
      this.options.retention.staleSessionDays !== undefined ||
      this.options.retention.deletedSessionDays !== undefined ||
      this.options.retention.orphanBlobDays !== undefined
    ) {
      this.applyRetentionPruneSync({ apply: true });
    }
    this.refreshAllLineageSync();
    this.syncAllDerivedSessionStateSync(true);
    this.rebuildSearchIndexesSync();
    this.deferredInitCompleted = true;
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = undefined;
  }

  async capture(event: Event): Promise<void> {
    const normalized = normalizeEvent(event);
    if (!normalized) return;

    this.writeEvent(normalized);

    if (!normalized.sessionID) return;
    if (!this.shouldPersistSessionForEvent(normalized.type)) return;

    const session = this.readSessionSync(normalized.sessionID, {
      artifactMessageIDs: this.captureArtifactHydrationMessageIDs(normalized),
    });
    const previousParentSessionID = session.parentSessionID;
    let next = this.applyEvent(session, normalized);
    next.updatedAt = Math.max(next.updatedAt, normalized.timestamp);
    next.eventCount += 1;
    next = this.prepareSessionForPersistence(next);
    const shouldSyncDerivedState = this.shouldSyncDerivedSessionStateForEvent(
      session,
      next,
      normalized,
    );

    const db = this.getDb();
    db.exec('BEGIN');
    try {
      this.persistCapturedSessionSync(next, normalized);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    if (this.shouldRefreshLineageForEvent(normalized.type)) {
      this.refreshAllLineageSync();
      const refreshed = this.readSessionHeaderSync(normalized.sessionID);
      if (refreshed) {
        next = {
          ...next,
          parentSessionID: refreshed.parentSessionID,
          rootSessionID: refreshed.rootSessionID,
          lineageDepth: refreshed.lineageDepth,
        };
      }
    }

    if (shouldSyncDerivedState) {
      this.syncDerivedSessionStateSync(this.readSessionSync(normalized.sessionID));
    }

    if (
      this.shouldSyncDerivedLineageSubtree(
        normalized.type,
        previousParentSessionID,
        next.parentSessionID,
      )
    ) {
      this.syncDerivedLineageSubtreeSync(normalized.sessionID, true);
    }

    if (this.shouldCleanupOrphanBlobsForEvent(normalized.type)) {
      this.deleteOrphanArtifactBlobsSync();
    }
  }

  async stats(): Promise<StoreStats> {
    const db = this.getDb();
    const totalRow = db
      .prepare('SELECT COUNT(*) AS count, MAX(ts) AS latest FROM events')
      .get() as {
      count: number;
      latest: number | null;
    };
    const sessionRow = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number;
    };
    const typeRows = safeQuery<{ event_type: string; count: number }>(
      db.prepare(
        'SELECT event_type, COUNT(*) AS count FROM events GROUP BY event_type ORDER BY count DESC',
      ),
      [],
      'stats.eventTypes',
    );
    const summaryNodeRow = db.prepare('SELECT COUNT(*) AS count FROM summary_nodes').get() as {
      count: number;
    };
    const summaryStateRow = db.prepare('SELECT COUNT(*) AS count FROM summary_state').get() as {
      count: number;
    };
    const artifactRow = db.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as {
      count: number;
    };
    const blobRow = db.prepare('SELECT COUNT(*) AS count FROM artifact_blobs').get() as {
      count: number;
    };
    const sharedBlobRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT content_hash FROM artifacts
           WHERE content_hash IS NOT NULL
           GROUP BY content_hash
           HAVING COUNT(*) > 1
         )`,
      )
      .get() as { count: number };
    const orphanBlobRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM artifact_blobs b
         WHERE NOT EXISTS (
           SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
         )`,
      )
      .get() as { count: number };
    const rootRow = db
      .prepare('SELECT COUNT(*) AS count FROM sessions WHERE parent_session_id IS NULL')
      .get() as { count: number };
    const branchedRow = db
      .prepare('SELECT COUNT(*) AS count FROM sessions WHERE parent_session_id IS NOT NULL')
      .get() as {
      count: number;
    };
    const pinnedRow = db
      .prepare('SELECT COUNT(*) AS count FROM sessions WHERE pinned = 1')
      .get() as { count: number };
    const worktreeRow = db
      .prepare(
        'SELECT COUNT(DISTINCT worktree_key) AS count FROM sessions WHERE worktree_key IS NOT NULL',
      )
      .get() as {
      count: number;
    };

    return {
      schemaVersion: this.readSchemaVersionSync(),
      totalEvents: totalRow.count,
      sessionCount: sessionRow.count,
      latestEventAt: totalRow.latest ?? undefined,
      eventTypes: Object.fromEntries(typeRows.map((row) => [row.event_type, row.count])),
      summaryNodeCount: summaryNodeRow.count,
      summaryStateCount: summaryStateRow.count,
      rootSessionCount: rootRow.count,
      branchedSessionCount: branchedRow.count,
      artifactCount: artifactRow.count,
      artifactBlobCount: blobRow.count,
      sharedArtifactBlobCount: sharedBlobRow.count,
      orphanArtifactBlobCount: orphanBlobRow.count,
      worktreeCount: worktreeRow.count,
      pinnedSessionCount: pinnedRow.count,
    };
  }

  async grep(input: {
    query: string;
    sessionID?: string;
    scope?: string;
    limit?: number;
  }): Promise<SearchResult[]> {
    const resolvedScope = this.resolveConfiguredScope('grep', input.scope, input.sessionID);
    const sessionIDs = this.resolveScopeSessionIDs(resolvedScope, input.sessionID);
    const limit = input.limit ?? 5;
    const needle = input.query.trim();
    if (!needle) return [];

    const ftsResults = this.searchWithFts(needle, sessionIDs, limit);
    if (ftsResults.length > 0) return ftsResults;
    return this.searchByScan(needle.toLowerCase(), sessionIDs, limit);
  }

  async describe(input?: { sessionID?: string; scope?: string }): Promise<string> {
    const scope = this.resolveConfiguredScope('describe', input?.scope, input?.sessionID);
    const sessionID = input?.sessionID;

    if (scope !== 'session') {
      const scopedSessions = this.readScopedSessionsSync(
        this.resolveScopeSessionIDs(scope, sessionID),
      );
      if (scopedSessions.length === 0) return 'No archived sessions yet.';

      return [
        `Scope: ${scope}`,
        `Sessions: ${scopedSessions.length}`,
        `Latest update: ${Math.max(...scopedSessions.map((session) => session.updatedAt))}`,
        `Root sessions: ${new Set(scopedSessions.map((session) => session.rootSessionID ?? session.sessionID)).size}`,
        `Worktrees: ${new Set(scopedSessions.map((session) => normalizeWorktreeKey(session.directory)).filter(Boolean)).size}`,
        'Matching sessions:',
        ...scopedSessions
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 8)
          .map((session) => {
            const root = session.rootSessionID ?? session.sessionID;
            const worktree = normalizeWorktreeKey(session.directory) ?? 'unknown';
            return `- ${session.sessionID}: ${makeSessionTitle(session) ?? 'Untitled session'} (root=${root}, worktree=${worktree})`;
          }),
      ].join('\n');
    }

    if (!sessionID) {
      const sessions = this.readAllSessionsSync();
      if (sessions.length === 0) return 'No archived sessions yet.';

      return [
        `Archived sessions: ${sessions.length}`,
        `Latest update: ${Math.max(...sessions.map((session) => session.updatedAt))}`,
        `Root sessions: ${sessions.filter((session) => !session.parentSessionID).length}`,
        `Branched sessions: ${sessions.filter((session) => Boolean(session.parentSessionID)).length}`,
        'Recent sessions:',
        ...sessions
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 5)
          .map(
            (session) =>
              `- ${session.sessionID}: ${makeSessionTitle(session) ?? 'Untitled session'}`,
          ),
      ].join('\n');
    }

    const session = this.readSessionSync(sessionID);
    if (session.messages.length === 0) return 'No archived events yet.';

    const roots = this.getSummaryRootsForSession(session);
    const userMessages = session.messages.filter((message) => message.info.role === 'user');
    const assistantMessages = session.messages.filter(
      (message) => message.info.role === 'assistant',
    );
    const files = new Set(session.messages.flatMap(listFiles));
    const recent = session.messages.slice(-5).map((message) => {
      const snippet =
        guessMessageText(message, this.options.interop.ignoreToolPrefixes) || '(no text content)';
      return `- ${message.info.role} ${message.info.id}: ${snippet}`;
    });

    return [
      `Session: ${session.sessionID}`,
      `Title: ${makeSessionTitle(session) ?? 'Unknown'}`,
      `Directory: ${session.directory ?? 'unknown'}`,
      `Parent session: ${session.parentSessionID ?? 'none'}`,
      `Root session: ${session.rootSessionID ?? session.sessionID}`,
      `Lineage depth: ${session.lineageDepth ?? 0}`,
      `Pinned: ${session.pinned ? `yes${session.pinReason ? ` (${session.pinReason})` : ''}` : 'no'}`,
      `Messages: ${session.messages.length}`,
      `User messages: ${userMessages.length}`,
      `Assistant messages: ${assistantMessages.length}`,
      `Tracked files: ${files.size}`,
      `Summary roots: ${roots.length}`,
      `Child branches: ${this.readChildSessionsSync(session.sessionID).length}`,
      `Last updated: ${session.updatedAt}`,
      ...(roots.length > 0
        ? [
            'Summary root previews:',
            ...roots
              .slice(0, 4)
              .map((node) => `- ${shortNodeID(node.nodeID)}: ${node.summaryText}`),
          ]
        : []),
      'Recent entries:',
      ...recent,
    ].join('\n');
  }

  async doctor(input?: { sessionID?: string; apply?: boolean; limit?: number }): Promise<string> {
    const limit = clamp(input?.limit ?? 10, 1, 50);
    const sessionID = input?.sessionID;
    const apply = input?.apply ?? false;

    const before = this.collectDoctorReport(sessionID);
    if (!apply || !this.hasDoctorIssues(before)) {
      return formatDoctorReport(before, limit);
    }

    const checkedSessions = sessionID
      ? [sessionID]
      : this.readAllSessionsSync().map((session) => session.sessionID);
    const appliedActions: string[] = [];

    this.ensureSessionColumnsSync();
    this.ensureSummaryStateColumnsSync();
    this.ensureArtifactColumnsSync();
    appliedActions.push('ensured schema columns');

    if (before.summarySessionsNeedingRebuild.length > 0 || before.orphanSummaryEdges > 0) {
      this.rebuildSummarySessionsSync(checkedSessions);
      appliedActions.push(`rebuilt summary DAGs for ${checkedSessions.length} checked session(s)`);
    }

    if (before.lineageSessionsNeedingRefresh.length > 0) {
      this.refreshAllLineageSync();
      this.syncAllDerivedSessionStateSync(true);
      appliedActions.push('refreshed lineage metadata');
    }

    if (before.orphanArtifactBlobs > 0) {
      this.backfillArtifactBlobsSync();
      const deleted = this.deleteOrphanArtifactBlobsSync();
      if (deleted.length > 0) {
        appliedActions.push(`deleted ${deleted.length} orphan artifact blob(s)`);
      }
    }

    if (
      before.messageFts.expected !== before.messageFts.actual ||
      before.summaryFts.expected !== before.summaryFts.actual ||
      before.artifactFts.expected !== before.artifactFts.actual ||
      before.summarySessionsNeedingRebuild.length > 0 ||
      before.orphanSummaryEdges > 0
    ) {
      this.rebuildSearchIndexesSync();
      appliedActions.push('rebuilt FTS indexes');
    }

    const after = this.collectDoctorReport(sessionID);
    after.status = this.hasDoctorIssues(after) ? 'issues-found' : 'repaired';
    after.appliedActions = appliedActions;
    return formatDoctorReport(after, limit);
  }

  private collectDoctorReport(sessionID?: string): DoctorReport {
    const sessions = sessionID ? [this.readSessionSync(sessionID)] : this.readAllSessionsSync();
    const sessionIDs = sessions.map((session) => session.sessionID);
    const summarySessionsNeedingRebuild = sessions
      .map((session) => this.diagnoseSummarySession(session))
      .filter((issue): issue is DoctorSessionIssue => Boolean(issue));
    const lineageSessionsNeedingRefresh = sessions
      .filter((session) => this.needsLineageRefresh(session))
      .map((session) => session.sessionID);

    const messageFtsExpected = sessions.reduce((count, session) => {
      return (
        count +
        session.messages.filter(
          (message) =>
            guessMessageText(message, this.options.interop.ignoreToolPrefixes).length > 0,
        ).length
      );
    }, 0);

    const report: DoctorReport = {
      scope: sessionID ? `session:${sessionID}` : 'all',
      checkedSessions: sessions.length,
      summarySessionsNeedingRebuild,
      lineageSessionsNeedingRefresh,
      orphanSummaryEdges: this.countScopedOrphanSummaryEdges(sessionIDs),
      messageFts: {
        expected: messageFtsExpected,
        actual: this.countScopedFtsRows('message_fts', sessionIDs),
      },
      summaryFts: {
        expected: this.readScopedSummaryRowsSync(sessionIDs).length,
        actual: this.countScopedFtsRows('summary_fts', sessionIDs),
      },
      artifactFts: {
        expected: this.readScopedArtifactRowsSync(sessionIDs).length,
        actual: this.countScopedFtsRows('artifact_fts', sessionIDs),
      },
      orphanArtifactBlobs: this.readOrphanArtifactBlobRowsSync().length,
      status: 'clean',
    };

    report.status = this.hasDoctorIssues(report) ? 'issues-found' : 'clean';
    return report;
  }

  private hasDoctorIssues(report: DoctorReport): boolean {
    return (
      report.summarySessionsNeedingRebuild.length > 0 ||
      report.lineageSessionsNeedingRefresh.length > 0 ||
      report.orphanSummaryEdges > 0 ||
      report.messageFts.expected !== report.messageFts.actual ||
      report.summaryFts.expected !== report.summaryFts.actual ||
      report.artifactFts.expected !== report.artifactFts.actual ||
      report.orphanArtifactBlobs > 0
    );
  }

  private diagnoseSummarySession(session: NormalizedSession): DoctorSessionIssue | undefined {
    const issues: string[] = [];
    const archived = this.getArchivedMessages(session.messages);
    const state = safeQueryOne<SummaryStateRow>(
      this.getDb().prepare('SELECT * FROM summary_state WHERE session_id = ?'),
      [session.sessionID],
      'diagnoseSummarySession',
    );
    const summaryNodeCount = safeQueryOne<{ count: number }>(
      this.getDb().prepare('SELECT COUNT(*) AS count FROM summary_nodes WHERE session_id = ?'),
      [session.sessionID],
      'diagnoseSummarySession.nodeCount',
    ) ?? { count: 0 };
    const summaryEdgeCount = safeQueryOne<{ count: number }>(
      this.getDb().prepare('SELECT COUNT(*) AS count FROM summary_edges WHERE session_id = ?'),
      [session.sessionID],
      'diagnoseSummarySession.edgeCount',
    ) ?? { count: 0 };

    if (archived.length === 0) {
      if (state) issues.push('unexpected-summary-state');
      if (summaryNodeCount.count > 0) issues.push('unexpected-summary-nodes');
      if (summaryEdgeCount.count > 0) issues.push('unexpected-summary-edges');
      return issues.length > 0 ? { sessionID: session.sessionID, issues } : undefined;
    }

    const latestMessageCreated = archived.at(-1)?.info.time.created ?? 0;
    const archivedSignature = this.buildArchivedSignature(archived);
    const rootIDs = state ? parseJson<string[]>(state.root_node_ids_json) : [];
    const roots = rootIDs
      .map((nodeID) => this.readSummaryNodeSync(nodeID))
      .filter((node): node is SummaryNodeData => Boolean(node));

    if (!state) {
      issues.push('missing-summary-state');
    } else {
      if (state.archived_count !== archived.length) issues.push('archived-count-mismatch');
      if (state.latest_message_created !== latestMessageCreated)
        issues.push('latest-message-mismatch');
      if (state.archived_signature !== archivedSignature)
        issues.push('archived-signature-mismatch');
      if (rootIDs.length === 0) issues.push('missing-root-node-ids');
      if (roots.length !== rootIDs.length) {
        issues.push('missing-root-node-record');
      } else if (
        rootIDs.length > 0 &&
        !this.canReuseSummaryGraphSync(session.sessionID, archived, roots)
      ) {
        issues.push('invalid-summary-graph');
      }
    }

    if (summaryNodeCount.count === 0) issues.push('missing-summary-nodes');
    return issues.length > 0 ? { sessionID: session.sessionID, issues } : undefined;
  }

  private needsLineageRefresh(session: NormalizedSession): boolean {
    const chain = this.readLineageChainSync(session.sessionID);
    const expectedRoot = chain[0]?.sessionID ?? session.sessionID;
    const expectedDepth = Math.max(0, chain.length - 1);
    return (
      (session.rootSessionID ?? session.sessionID) !== expectedRoot ||
      (session.lineageDepth ?? 0) !== expectedDepth
    );
  }

  private rebuildSummarySessionsSync(sessionIDs: string[]): void {
    for (const sessionID of sessionIDs) {
      const session = this.readSessionSync(sessionID);
      this.ensureSummaryGraphSync(sessionID, this.getArchivedMessages(session.messages));
    }
  }

  private countScopedFtsRows(
    table: 'message_fts' | 'summary_fts' | 'artifact_fts',
    sessionIDs?: string[],
  ): number {
    if (sessionIDs && sessionIDs.length === 0) return 0;

    if (!sessionIDs) {
      const row = this.getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      return row.count;
    }

    const placeholders = sessionIDs.map(() => '?').join(', ');
    const row = this.getDb()
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id IN (${placeholders})`)
      .get(...sessionIDs) as { count: number };
    return row.count;
  }

  private countScopedOrphanSummaryEdges(sessionIDs?: string[]): number {
    if (sessionIDs && sessionIDs.length === 0) return 0;

    const scopeClause = sessionIDs
      ? `e.session_id IN (${sessionIDs.map(() => '?').join(', ')}) AND `
      : '';
    const row = this.getDb()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM summary_edges e
         WHERE ${scopeClause}(
           NOT EXISTS (SELECT 1 FROM summary_nodes parent WHERE parent.node_id = e.parent_id)
           OR NOT EXISTS (SELECT 1 FROM summary_nodes child WHERE child.node_id = e.child_id)
         )`,
      )
      .get(...(sessionIDs ?? [])) as { count: number };
    return row.count;
  }

  private shouldRefreshLineageForEvent(eventType: string): boolean {
    return (
      eventType === 'session.created' ||
      eventType === 'session.updated' ||
      eventType === 'session.deleted'
    );
  }

  private shouldPersistSessionForEvent(eventType: string): boolean {
    return (
      eventType === 'session.created' ||
      eventType === 'session.updated' ||
      eventType === 'session.deleted' ||
      eventType === 'session.compacted' ||
      eventType === 'message.updated' ||
      eventType === 'message.removed' ||
      eventType === 'message.part.updated' ||
      eventType === 'message.part.removed'
    );
  }

  private shouldSyncDerivedLineageSubtree(
    eventType: string,
    previousParentSessionID?: string,
    nextParentSessionID?: string,
  ): boolean {
    return (
      eventType === 'session.created' ||
      (eventType === 'session.updated' && previousParentSessionID !== nextParentSessionID)
    );
  }

  private shouldCleanupOrphanBlobsForEvent(eventType: string): boolean {
    return (
      eventType === 'message.removed' ||
      eventType === 'message.part.updated' ||
      eventType === 'message.part.removed'
    );
  }

  private captureArtifactHydrationMessageIDs(event: CapturedEvent): string[] {
    const payload = event.payload as Event;

    switch (payload.type) {
      case 'message.updated':
        return [payload.properties.info.id];
      case 'message.part.updated':
        return [payload.properties.part.messageID];
      case 'message.part.removed':
        return [payload.properties.messageID];
      default:
        return [];
    }
  }

  private archivedMessageIDs(messages: ConversationMessage[]): string[] {
    return this.getArchivedMessages(messages).map((message) => message.info.id);
  }

  private didArchivedMessagesChange(
    before: ConversationMessage[],
    after: ConversationMessage[],
  ): boolean {
    const beforeIDs = this.archivedMessageIDs(before);
    const afterIDs = this.archivedMessageIDs(after);
    if (beforeIDs.length !== afterIDs.length) return true;
    return beforeIDs.some((messageID, index) => messageID !== afterIDs[index]);
  }

  private isArchivedMessage(messages: ConversationMessage[], messageID?: string): boolean {
    if (!messageID) return false;
    return this.archivedMessageIDs(messages).includes(messageID);
  }

  private shouldSyncDerivedSessionStateForEvent(
    previous: NormalizedSession,
    next: NormalizedSession,
    event: CapturedEvent,
  ): boolean {
    const payload = event.payload as Event;

    switch (payload.type) {
      case 'message.updated': {
        const messageID = payload.properties.info.id;
        return (
          this.didArchivedMessagesChange(previous.messages, next.messages) ||
          this.isArchivedMessage(previous.messages, messageID) ||
          this.isArchivedMessage(next.messages, messageID)
        );
      }
      case 'message.removed':
        return this.didArchivedMessagesChange(previous.messages, next.messages);
      case 'message.part.updated': {
        const messageID = payload.properties.part.messageID;
        return (
          this.isArchivedMessage(previous.messages, messageID) ||
          this.isArchivedMessage(next.messages, messageID)
        );
      }
      case 'message.part.removed': {
        const messageID = payload.properties.messageID;
        return (
          this.isArchivedMessage(previous.messages, messageID) ||
          this.isArchivedMessage(next.messages, messageID)
        );
      }
      default:
        return false;
    }
  }

  private syncAllDerivedSessionStateSync(preserveExistingResume = false): void {
    for (const session of this.readAllSessionsSync()) {
      this.syncDerivedSessionStateSync(session, preserveExistingResume);
    }
  }

  private syncDerivedSessionStateSync(
    session: NormalizedSession,
    preserveExistingResume = false,
  ): SummaryNodeData[] {
    const roots = this.ensureSummaryGraphSync(
      session.sessionID,
      this.getArchivedMessages(session.messages),
    );
    this.writeResumeSync(session, roots, preserveExistingResume);
    return roots;
  }

  private syncDerivedLineageSubtreeSync(sessionID: string, preserveExistingResume = false): void {
    const queue = [sessionID];
    const seen = new Set<string>([sessionID]);

    while (queue.length > 0) {
      const currentSessionID = queue.shift();
      if (!currentSessionID) continue;

      if (currentSessionID !== sessionID) {
        this.syncDerivedSessionStateSync(
          this.readSessionSync(currentSessionID),
          preserveExistingResume,
        );
      }

      for (const child of this.readChildSessionsSync(currentSessionID)) {
        if (seen.has(child.sessionID)) continue;
        seen.add(child.sessionID);
        queue.push(child.sessionID);
      }
    }
  }

  private writeResumeSync(
    session: NormalizedSession,
    roots: SummaryNodeData[],
    preserveExistingResume = false,
  ): void {
    const db = this.getDb();
    if (session.messages.length === 0) {
      db.prepare('DELETE FROM resumes WHERE session_id = ?').run(session.sessionID);
      return;
    }

    const existing = this.getResumeSync(session.sessionID);
    if (preserveExistingResume && existing && !this.isManagedResumeNote(existing)) {
      return;
    }

    const note = this.buildResumeNote(session, roots);
    db.prepare(
      `INSERT INTO resumes (session_id, note, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
    ).run(session.sessionID, note, Date.now());
  }

  private isManagedResumeNote(note: string): boolean {
    return note.startsWith('LCM prototype resume note\n') || note === 'LCM prototype resume note';
  }

  private resolveRetentionPolicy(input?: {
    staleSessionDays?: number;
    deletedSessionDays?: number;
    orphanBlobDays?: number;
  }): ResolvedRetentionPolicy {
    return {
      staleSessionDays: input?.staleSessionDays ?? this.options.retention.staleSessionDays,
      deletedSessionDays: input?.deletedSessionDays ?? this.options.retention.deletedSessionDays,
      orphanBlobDays: input?.orphanBlobDays ?? this.options.retention.orphanBlobDays,
    };
  }

  private retentionCutoff(days: number): number {
    return Date.now() - days * 24 * 60 * 60 * 1000;
  }

  private applyRetentionPruneSync(input?: {
    staleSessionDays?: number;
    deletedSessionDays?: number;
    orphanBlobDays?: number;
    apply?: boolean;
  }): { deletedSessions: number; deletedBlobs: number; deletedBlobChars: number } {
    const policy = this.resolveRetentionPolicy(input);

    if (input?.apply === false) {
      return { deletedSessions: 0, deletedBlobs: 0, deletedBlobChars: 0 };
    }

    const staleSessions =
      policy.staleSessionDays === undefined
        ? []
        : this.readSessionRetentionCandidates(false, policy.staleSessionDays);
    const deletedSessions =
      policy.deletedSessionDays === undefined
        ? []
        : this.readSessionRetentionCandidates(true, policy.deletedSessionDays);
    const combinedSessions = [...staleSessions, ...deletedSessions];
    const uniqueSessionIDs = [...new Set(combinedSessions.map((row) => row.session_id))];
    const initialOrphanBlobs =
      policy.orphanBlobDays === undefined
        ? []
        : this.readOrphanBlobRetentionCandidates(policy.orphanBlobDays);

    if (uniqueSessionIDs.length === 0 && initialOrphanBlobs.length === 0) {
      return { deletedSessions: 0, deletedBlobs: 0, deletedBlobChars: 0 };
    }

    const db = this.getDb();
    let deletedBlobs: RetentionBlobCandidate[] = [];
    db.exec('BEGIN');
    try {
      for (const sessionID of uniqueSessionIDs) {
        this.clearSessionDataSync(sessionID);
      }

      deletedBlobs =
        policy.orphanBlobDays === undefined
          ? []
          : this.readOrphanBlobRetentionCandidates(policy.orphanBlobDays);
      if (deletedBlobs.length > 0) {
        const deleteBlob = db.prepare('DELETE FROM artifact_blobs WHERE content_hash = ?');
        for (const blob of deletedBlobs) deleteBlob.run(blob.content_hash);
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    this.refreshAllLineageSync();
    this.syncAllDerivedSessionStateSync(true);
    this.rebuildSearchIndexesSync();

    return {
      deletedSessions: uniqueSessionIDs.length,
      deletedBlobs: deletedBlobs.length,
      deletedBlobChars: deletedBlobs.reduce((sum, row) => sum + row.char_count, 0),
    };
  }

  private formatRetentionSessionCandidate(row: RetentionSessionCandidate): string {
    const title = row.title ?? 'Untitled session';
    const worktree = normalizeWorktreeKey(row.session_directory ?? undefined) ?? 'unknown';
    const root = row.root_session_id ?? row.session_id;
    return `- ${row.session_id} pinned=${row.pinned === 1 ? 'true' : 'false'} deleted=${row.deleted === 1 ? 'true' : 'false'} updated_at=${row.updated_at} messages=${row.message_count} artifacts=${row.artifact_count} root=${root} worktree=${worktree} title=${title}`;
  }

  private readSessionRetentionCandidates(
    deleted: boolean,
    days: number,
    limit?: number,
  ): RetentionSessionCandidate[] {
    const params: Array<number | string> = [this.retentionCutoff(days), deleted ? 1 : 0];
    const sql = `
      SELECT
        s.session_id,
        s.title,
        s.session_directory,
        s.root_session_id,
        s.pinned,
        s.deleted,
        s.updated_at,
        s.event_count,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id) AS message_count,
        (SELECT COUNT(*) FROM artifacts a WHERE a.session_id = s.session_id) AS artifact_count
      FROM sessions s
      WHERE s.updated_at <= ?
        AND s.deleted = ?
        AND s.pinned = 0
        AND NOT EXISTS (
          SELECT 1 FROM sessions child WHERE child.parent_session_id = s.session_id
        )
      ORDER BY s.updated_at ASC
      ${limit ? 'LIMIT ?' : ''}`;

    if (limit) params.push(limit);
    return this.getDb()
      .prepare(sql)
      .all(...params) as RetentionSessionCandidate[];
  }

  private countSessionRetentionCandidates(deleted: boolean, days: number): number {
    const row = this.getDb()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions s
         WHERE s.updated_at <= ?
           AND s.deleted = ?
           AND s.pinned = 0
           AND NOT EXISTS (
             SELECT 1 FROM sessions child WHERE child.parent_session_id = s.session_id
           )`,
      )
      .get(this.retentionCutoff(days), deleted ? 1 : 0) as { count: number };
    return row.count;
  }

  private readOrphanBlobRetentionCandidates(
    days: number,
    limit?: number,
  ): RetentionBlobCandidate[] {
    const params: Array<number> = [this.retentionCutoff(days)];
    const sql = `
      SELECT content_hash, char_count, created_at
      FROM artifact_blobs b
      WHERE b.created_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
        )
      ORDER BY char_count DESC, created_at ASC
      ${limit ? 'LIMIT ?' : ''}`;
    if (limit) params.push(limit);
    return this.getDb()
      .prepare(sql)
      .all(...params) as RetentionBlobCandidate[];
  }

  private countOrphanBlobRetentionCandidates(days: number): number {
    const row = this.getDb()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM artifact_blobs b
         WHERE b.created_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
           )`,
      )
      .get(this.retentionCutoff(days)) as { count: number };
    return row.count;
  }

  private sumOrphanBlobRetentionChars(days: number): number {
    const row = this.getDb()
      .prepare(
        `SELECT COALESCE(SUM(char_count), 0) AS chars
         FROM artifact_blobs b
         WHERE b.created_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
           )`,
      )
      .get(this.retentionCutoff(days)) as { chars: number };
    return row.chars;
  }

  private normalizeScope(scope?: string): SnapshotScope | undefined {
    if (scope === 'session' || scope === 'root' || scope === 'worktree' || scope === 'all')
      return scope;
    return undefined;
  }

  private resolveConfiguredScope(
    operation: 'grep' | 'describe',
    explicitScope?: string,
    sessionID?: string,
  ): 'session' | 'root' | 'worktree' | 'all' {
    const explicit = this.normalizeScope(explicitScope);
    if (explicit) return explicit;

    const worktreeKey = this.resolveScopeWorktreeKey(sessionID);
    if (worktreeKey) {
      const profile = this.options.scopeProfiles.find(
        (entry) => normalizeWorktreeKey(entry.worktree) === worktreeKey,
      );
      if (profile?.[operation]) return profile[operation];
    }

    return this.options.scopeDefaults[operation];
  }

  private resolveScopeWorktreeKey(sessionID?: string): string | undefined {
    if (sessionID) {
      const session = this.readSessionHeaderSync(sessionID);
      const sessionWorktree = normalizeWorktreeKey(session?.directory);
      if (sessionWorktree) return sessionWorktree;
    }

    return normalizeWorktreeKey(this.workspaceDirectory);
  }

  private resolveScopeSessionIDs(scope?: string, sessionID?: string): string[] | undefined {
    const normalizedScope = this.normalizeScope(scope) ?? this.options.scopeDefaults.grep;
    if (normalizedScope === 'all') return undefined;

    const resolvedSessionID = sessionID ?? this.latestSessionIDSync();
    if (!resolvedSessionID) return [];
    if (normalizedScope === 'session') return [resolvedSessionID];

    const session = this.readSessionHeaderSync(resolvedSessionID);
    if (!session) return [];

    if (normalizedScope === 'root') {
      const rootSessionID = session.rootSessionID ?? session.sessionID;
      const rows = this.getDb()
        .prepare(
          'SELECT session_id FROM sessions WHERE root_session_id = ? OR session_id = ? ORDER BY updated_at DESC',
        )
        .all(rootSessionID, rootSessionID) as Array<{ session_id: string }>;
      return [...new Set(rows.map((row) => row.session_id))];
    }

    const worktreeKey = normalizeWorktreeKey(session.directory);
    if (!worktreeKey) return [resolvedSessionID];
    const rows = this.getDb()
      .prepare('SELECT session_id FROM sessions WHERE worktree_key = ? ORDER BY updated_at DESC')
      .all(worktreeKey) as Array<{ session_id: string }>;
    return [...new Set(rows.map((row) => row.session_id))];
  }

  private readScopedSessionRowsSync(sessionIDs?: string[]): SessionRow[] {
    if (!sessionIDs) {
      return this.getDb()
        .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
        .all() as SessionRow[];
    }
    if (sessionIDs.length === 0) return [];

    return this.getDb()
      .prepare(
        `SELECT * FROM sessions WHERE session_id IN (${sessionIDs.map(() => '?').join(', ')}) ORDER BY updated_at DESC`,
      )
      .all(...sessionIDs) as SessionRow[];
  }

  private readScopedMessageRowsSync(sessionIDs?: string[]): MessageRow[] {
    if (!sessionIDs) {
      return this.getDb()
        .prepare('SELECT * FROM messages ORDER BY created_at ASC, message_id ASC')
        .all() as MessageRow[];
    }
    if (sessionIDs.length === 0) return [];

    return this.getDb()
      .prepare(
        `SELECT * FROM messages WHERE session_id IN (${sessionIDs.map(() => '?').join(', ')}) ORDER BY created_at ASC, message_id ASC`,
      )
      .all(...sessionIDs) as MessageRow[];
  }

  private readScopedPartRowsSync(sessionIDs?: string[]): PartRow[] {
    if (!sessionIDs) {
      return this.getDb()
        .prepare('SELECT * FROM parts ORDER BY message_id ASC, sort_key ASC, part_id ASC')
        .all() as PartRow[];
    }
    if (sessionIDs.length === 0) return [];

    return this.getDb()
      .prepare(
        `SELECT * FROM parts WHERE session_id IN (${sessionIDs.map(() => '?').join(', ')}) ORDER BY message_id ASC, sort_key ASC, part_id ASC`,
      )
      .all(...sessionIDs) as PartRow[];
  }

  private readScopedResumeRowsSync(
    sessionIDs?: string[],
  ): Array<{ session_id: string; note: string; updated_at: number }> {
    if (!sessionIDs) {
      return this.getDb().prepare('SELECT * FROM resumes ORDER BY updated_at DESC').all() as Array<{
        session_id: string;
        note: string;
        updated_at: number;
      }>;
    }
    if (sessionIDs.length === 0) return [];

    return this.getDb()
      .prepare(
        `SELECT * FROM resumes WHERE session_id IN (${sessionIDs.map(() => '?').join(', ')}) ORDER BY updated_at DESC`,
      )
      .all(...sessionIDs) as Array<{ session_id: string; note: string; updated_at: number }>;
  }

  private readScopedSessionsSync(sessionIDs?: string[]): NormalizedSession[] {
    if (!sessionIDs) return this.readAllSessionsSync();
    if (sessionIDs.length === 0) return [];
    if (sessionIDs.length <= 1) return sessionIDs.map((id) => this.readSessionSync(id));

    return this.readSessionsBatchSync(sessionIDs).filter(
      (session) => session.messages.length > 0 || session.eventCount > 0,
    );
  }

  private readScopedSummaryRowsSync(sessionIDs?: string[]): SummaryNodeRow[] {
    if (!sessionIDs) {
      return this.getDb()
        .prepare('SELECT * FROM summary_nodes ORDER BY created_at DESC')
        .all() as SummaryNodeRow[];
    }
    if (sessionIDs.length === 0) return [];

    return this.getDb()
      .prepare(
        `SELECT * FROM summary_nodes WHERE session_id IN (${sessionIDs.map(() => '?').join(', ')}) ORDER BY created_at DESC`,
      )
      .all(...sessionIDs) as SummaryNodeRow[];
  }

  private readScopedSummaryEdgeRowsSync(sessionIDs?: string[]): SummaryEdgeRow[] {
    if (!sessionIDs) {
      return this.getDb()
        .prepare(
          'SELECT * FROM summary_edges ORDER BY session_id ASC, parent_id ASC, child_position ASC',
        )
        .all() as SummaryEdgeRow[];
    }
    if (sessionIDs.length === 0) return [];

    return this.getDb()
      .prepare(
        `SELECT * FROM summary_edges WHERE session_id IN (${sessionIDs.map(() => '?').join(', ')}) ORDER BY session_id ASC, parent_id ASC, child_position ASC`,
      )
      .all(...sessionIDs) as SummaryEdgeRow[];
  }

  private readScopedSummaryStateRowsSync(sessionIDs?: string[]): SummaryStateRow[] {
    if (!sessionIDs) {
      return this.getDb()
        .prepare('SELECT * FROM summary_state ORDER BY updated_at DESC')
        .all() as SummaryStateRow[];
    }
    if (sessionIDs.length === 0) return [];

    return this.getDb()
      .prepare(
        `SELECT * FROM summary_state WHERE session_id IN (${sessionIDs.map(() => '?').join(', ')}) ORDER BY updated_at DESC`,
      )
      .all(...sessionIDs) as SummaryStateRow[];
  }

  private readScopedArtifactRowsSync(sessionIDs?: string[]): ArtifactRow[] {
    if (!sessionIDs) {
      return this.getDb()
        .prepare('SELECT * FROM artifacts ORDER BY created_at DESC')
        .all() as ArtifactRow[];
    }
    if (sessionIDs.length === 0) return [];

    return this.getDb()
      .prepare(
        `SELECT * FROM artifacts WHERE session_id IN (${sessionIDs.map(() => '?').join(', ')}) ORDER BY created_at DESC`,
      )
      .all(...sessionIDs) as ArtifactRow[];
  }

  private readScopedArtifactBlobRowsSync(sessionIDs?: string[]): ArtifactBlobRow[] {
    if (!sessionIDs) {
      return this.getDb()
        .prepare('SELECT * FROM artifact_blobs ORDER BY created_at ASC')
        .all() as ArtifactBlobRow[];
    }
    if (sessionIDs.length === 0) return [];

    return this.getDb()
      .prepare(
        `SELECT DISTINCT b.*
         FROM artifact_blobs b
         JOIN artifacts a ON a.content_hash = b.content_hash
         WHERE a.session_id IN (${sessionIDs.map(() => '?').join(', ')})
         ORDER BY b.created_at ASC`,
      )
      .all(...sessionIDs) as ArtifactBlobRow[];
  }

  async lineage(sessionID?: string): Promise<string> {
    const resolvedSessionID = sessionID ?? this.latestSessionIDSync();
    if (!resolvedSessionID) return 'No archived sessions yet.';

    const session = this.readSessionSync(resolvedSessionID);
    const chain = this.readLineageChainSync(resolvedSessionID);
    const children = this.readChildSessionsSync(resolvedSessionID);
    const siblings = session.parentSessionID
      ? this.readChildSessionsSync(session.parentSessionID).filter(
          (child) => child.sessionID !== resolvedSessionID,
        )
      : [];

    return [
      `Session: ${session.sessionID}`,
      `Title: ${makeSessionTitle(session) ?? 'Unknown'}`,
      `Worktree: ${normalizeWorktreeKey(session.directory) ?? 'unknown'}`,
      `Root session: ${session.rootSessionID ?? session.sessionID}`,
      `Parent session: ${session.parentSessionID ?? 'none'}`,
      `Lineage depth: ${session.lineageDepth ?? 0}`,
      'Lineage chain:',
      ...chain.map(
        (entry, index) =>
          `${entry.sessionID === resolvedSessionID ? '*' : '-'} depth=${index} ${entry.sessionID}: ${makeSessionTitle(entry) ?? 'Untitled session'}`,
      ),
      ...(siblings.length > 0
        ? [
            'Sibling branches:',
            ...siblings.map(
              (entry) => `- ${entry.sessionID}: ${makeSessionTitle(entry) ?? 'Untitled session'}`,
            ),
          ]
        : []),
      ...(children.length > 0
        ? [
            'Child branches:',
            ...children.map(
              (entry) => `- ${entry.sessionID}: ${makeSessionTitle(entry) ?? 'Untitled session'}`,
            ),
          ]
        : []),
    ].join('\n');
  }

  async pinSession(input: { sessionID?: string; reason?: string }): Promise<string> {
    const sessionID = input.sessionID ?? this.latestSessionIDSync();
    if (!sessionID) return 'No archived sessions yet.';

    const session = this.readSessionHeaderSync(sessionID);
    if (!session) return 'Unknown session.';
    const reason = input.reason?.trim() || 'Pinned by user';

    this.getDb()
      .prepare('UPDATE sessions SET pinned = 1, pin_reason = ? WHERE session_id = ?')
      .run(reason, sessionID);
    return [`session=${sessionID}`, 'pinned=true', `reason=${reason}`].join('\n');
  }

  async unpinSession(input: { sessionID?: string }): Promise<string> {
    const sessionID = input.sessionID ?? this.latestSessionIDSync();
    if (!sessionID) return 'No archived sessions yet.';

    const session = this.readSessionHeaderSync(sessionID);
    if (!session) return 'Unknown session.';
    this.getDb()
      .prepare('UPDATE sessions SET pinned = 0, pin_reason = NULL WHERE session_id = ?')
      .run(sessionID);
    return [`session=${sessionID}`, 'pinned=false'].join('\n');
  }

  async artifact(input: { artifactID: string; chars?: number }): Promise<string> {
    const artifact = this.readArtifactSync(input.artifactID);
    if (!artifact) return 'Unknown artifact.';

    const maxChars = Math.max(
      200,
      Math.min(this.options.artifactViewChars, input.chars ?? this.options.artifactViewChars),
    );
    return [
      `Artifact: ${artifact.artifactID}`,
      `Session: ${artifact.sessionID}`,
      `Message: ${artifact.messageID}`,
      `Part: ${artifact.partID}`,
      `Kind: ${artifact.artifactKind}`,
      `Field: ${artifact.fieldName}`,
      `Content hash: ${artifact.contentHash}`,
      `Characters: ${artifact.charCount}`,
      ...this.formatArtifactMetadataLines(artifact.metadata),
      'Preview:',
      truncate(artifact.previewText, this.options.artifactPreviewChars),
      'Content:',
      truncate(artifact.contentText, maxChars),
    ].join('\n');
  }

  async blobStats(input?: { limit?: number }): Promise<string> {
    const limit = clamp(input?.limit ?? 5, 1, 20);
    const db = this.getDb();
    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS blob_count,
           COALESCE(SUM(char_count), 0) AS blob_chars,
           COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash) THEN 0 ELSE char_count END), 0) AS orphan_chars
         FROM artifact_blobs b`,
      )
      .get() as { blob_count: number; blob_chars: number; orphan_chars: number };
    const referenced = db
      .prepare(
        'SELECT COUNT(DISTINCT content_hash) AS count FROM artifacts WHERE content_hash IS NOT NULL',
      )
      .get() as { count: number };
    const sharedCount = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT content_hash FROM artifacts
           WHERE content_hash IS NOT NULL
           GROUP BY content_hash
           HAVING COUNT(*) > 1
         )`,
      )
      .get() as { count: number };
    const orphanCount = db
      .prepare(
        `SELECT COUNT(*) AS count FROM artifact_blobs b
         WHERE NOT EXISTS (
           SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
         )`,
      )
      .get() as { count: number };
    const shared = db
      .prepare(
        `SELECT a.content_hash AS content_hash, COUNT(*) AS ref_count, MAX(b.char_count) AS char_count
         FROM artifacts a
         JOIN artifact_blobs b ON b.content_hash = a.content_hash
         WHERE a.content_hash IS NOT NULL
         GROUP BY a.content_hash
         HAVING COUNT(*) > 1
         ORDER BY ref_count DESC, char_count DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ content_hash: string; ref_count: number; char_count: number }>;
    const orphan = db
      .prepare(
        `SELECT content_hash, char_count, created_at
         FROM artifact_blobs b
         WHERE NOT EXISTS (
           SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
         )
         ORDER BY char_count DESC, created_at ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{ content_hash: string; char_count: number; created_at: number }>;
    const saved = db
      .prepare(
        `SELECT COALESCE(SUM((ref_count - 1) * char_count), 0) AS chars_saved FROM (
           SELECT a.content_hash AS content_hash, COUNT(*) AS ref_count, MAX(b.char_count) AS char_count
           FROM artifacts a
           JOIN artifact_blobs b ON b.content_hash = a.content_hash
           WHERE a.content_hash IS NOT NULL
           GROUP BY a.content_hash
           HAVING COUNT(*) > 1
         )`,
      )
      .get() as { chars_saved: number };

    return [
      `artifact_blobs=${totals.blob_count}`,
      `referenced_blobs=${referenced.count}`,
      `shared_blobs=${sharedCount.count}`,
      `orphan_blobs=${orphanCount.count}`,
      `blob_chars=${totals.blob_chars}`,
      `orphan_blob_chars=${totals.orphan_chars}`,
      `saved_chars_from_dedup=${saved.chars_saved}`,
      ...(shared.length > 0
        ? [
            'top_shared_blobs:',
            ...shared.map(
              (row) =>
                `- ${row.content_hash.slice(0, 16)} refs=${row.ref_count} chars=${row.char_count}`,
            ),
          ]
        : ['top_shared_blobs:', '- none']),
      ...(orphan.length > 0
        ? [
            'orphan_blobs_preview:',
            ...orphan.map(
              (row) =>
                `- ${row.content_hash.slice(0, 16)} chars=${row.char_count} created_at=${row.created_at}`,
            ),
          ]
        : ['orphan_blobs_preview:', '- none']),
    ].join('\n');
  }

  private readOrphanArtifactBlobRowsSync(): RetentionBlobCandidate[] {
    return this.getDb()
      .prepare(
        `SELECT content_hash, char_count, created_at
         FROM artifact_blobs b
         WHERE NOT EXISTS (
           SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
         )
         ORDER BY char_count DESC, created_at ASC`,
      )
      .all() as RetentionBlobCandidate[];
  }

  private deleteOrphanArtifactBlobsSync(): RetentionBlobCandidate[] {
    const orphanRows = this.readOrphanArtifactBlobRowsSync();
    if (orphanRows.length === 0) return [];

    this.getDb()
      .prepare(
        `DELETE FROM artifact_blobs
         WHERE NOT EXISTS (
           SELECT 1 FROM artifacts a WHERE a.content_hash = artifact_blobs.content_hash
         )`,
      )
      .run();

    return orphanRows;
  }

  async gcBlobs(input?: { apply?: boolean; limit?: number }): Promise<string> {
    const apply = input?.apply ?? false;
    const limit = clamp(input?.limit ?? 10, 1, 50);
    const orphanRows = this.readOrphanArtifactBlobRowsSync();

    const totalChars = orphanRows.reduce((sum, row) => sum + row.char_count, 0);
    if (orphanRows.length === 0) {
      return ['orphan_blobs=0', 'deleted_blobs=0', 'deleted_blob_chars=0', 'status=clean'].join(
        '\n',
      );
    }

    if (!apply) {
      return [
        `orphan_blobs=${orphanRows.length}`,
        `orphan_blob_chars=${totalChars}`,
        'status=dry-run',
        'preview:',
        ...orphanRows
          .slice(0, limit)
          .map(
            (row) =>
              `- ${row.content_hash.slice(0, 16)} chars=${row.char_count} created_at=${row.created_at}`,
          ),
        'Re-run with apply=true to delete orphan blobs.',
      ].join('\n');
    }

    this.deleteOrphanArtifactBlobsSync();

    return [
      `orphan_blobs=${orphanRows.length}`,
      `deleted_blobs=${orphanRows.length}`,
      `deleted_blob_chars=${totalChars}`,
      'status=applied',
      'deleted_preview:',
      ...orphanRows
        .slice(0, limit)
        .map(
          (row) =>
            `- ${row.content_hash.slice(0, 16)} chars=${row.char_count} created_at=${row.created_at}`,
        ),
    ].join('\n');
  }

  async retentionReport(input?: {
    staleSessionDays?: number;
    deletedSessionDays?: number;
    orphanBlobDays?: number;
    limit?: number;
  }): Promise<string> {
    const limit = clamp(input?.limit ?? 10, 1, 50);
    const policy = this.resolveRetentionPolicy(input);
    const staleSessions =
      policy.staleSessionDays === undefined
        ? []
        : this.readSessionRetentionCandidates(false, policy.staleSessionDays, limit);
    const deletedSessions =
      policy.deletedSessionDays === undefined
        ? []
        : this.readSessionRetentionCandidates(true, policy.deletedSessionDays, limit);
    const orphanBlobs =
      policy.orphanBlobDays === undefined
        ? []
        : this.readOrphanBlobRetentionCandidates(policy.orphanBlobDays, limit);

    const totalStaleSessions =
      policy.staleSessionDays === undefined
        ? 0
        : this.countSessionRetentionCandidates(false, policy.staleSessionDays);
    const totalDeletedSessions =
      policy.deletedSessionDays === undefined
        ? 0
        : this.countSessionRetentionCandidates(true, policy.deletedSessionDays);
    const totalOrphanBlobs =
      policy.orphanBlobDays === undefined
        ? 0
        : this.countOrphanBlobRetentionCandidates(policy.orphanBlobDays);
    const orphanBlobChars =
      policy.orphanBlobDays === undefined
        ? 0
        : this.sumOrphanBlobRetentionChars(policy.orphanBlobDays);

    return [
      `stale_session_days=${formatRetentionDays(policy.staleSessionDays)}`,
      `deleted_session_days=${formatRetentionDays(policy.deletedSessionDays)}`,
      `orphan_blob_days=${formatRetentionDays(policy.orphanBlobDays)}`,
      `stale_session_candidates=${totalStaleSessions}`,
      `deleted_session_candidates=${totalDeletedSessions}`,
      `orphan_blob_candidates=${totalOrphanBlobs}`,
      `orphan_blob_candidate_chars=${orphanBlobChars}`,
      ...(staleSessions.length > 0
        ? [
            'stale_sessions_preview:',
            ...staleSessions.map((row) => this.formatRetentionSessionCandidate(row)),
          ]
        : ['stale_sessions_preview:', '- none']),
      ...(deletedSessions.length > 0
        ? [
            'deleted_sessions_preview:',
            ...deletedSessions.map((row) => this.formatRetentionSessionCandidate(row)),
          ]
        : ['deleted_sessions_preview:', '- none']),
      ...(orphanBlobs.length > 0
        ? [
            'orphan_blobs_preview:',
            ...orphanBlobs.map(
              (row) =>
                `- ${row.content_hash.slice(0, 16)} chars=${row.char_count} created_at=${row.created_at}`,
            ),
          ]
        : ['orphan_blobs_preview:', '- none']),
    ].join('\n');
  }

  async retentionPrune(input?: {
    staleSessionDays?: number;
    deletedSessionDays?: number;
    orphanBlobDays?: number;
    apply?: boolean;
    limit?: number;
  }): Promise<string> {
    const apply = input?.apply ?? false;
    const limit = clamp(input?.limit ?? 10, 1, 50);
    const policy = this.resolveRetentionPolicy(input);
    const staleSessions =
      policy.staleSessionDays === undefined
        ? []
        : this.readSessionRetentionCandidates(false, policy.staleSessionDays);
    const deletedSessions =
      policy.deletedSessionDays === undefined
        ? []
        : this.readSessionRetentionCandidates(true, policy.deletedSessionDays);
    const combinedSessions = [...staleSessions, ...deletedSessions];
    const initialOrphanBlobs =
      policy.orphanBlobDays === undefined
        ? []
        : this.readOrphanBlobRetentionCandidates(policy.orphanBlobDays);

    if (!apply) {
      return [
        `stale_session_candidates=${staleSessions.length}`,
        `deleted_session_candidates=${deletedSessions.length}`,
        `orphan_blob_candidates=${initialOrphanBlobs.length}`,
        'status=dry-run',
        ...(combinedSessions.length > 0
          ? [
              'session_preview:',
              ...combinedSessions
                .slice(0, limit)
                .map((row) => this.formatRetentionSessionCandidate(row)),
            ]
          : ['session_preview:', '- none']),
        ...(initialOrphanBlobs.length > 0
          ? [
              'blob_preview:',
              ...initialOrphanBlobs
                .slice(0, limit)
                .map(
                  (row) =>
                    `- ${row.content_hash.slice(0, 16)} chars=${row.char_count} created_at=${row.created_at}`,
                ),
            ]
          : ['blob_preview:', '- none']),
        'Re-run with apply=true to prune the candidates above.',
      ].join('\n');
    }

    const result = this.applyRetentionPruneSync({ ...input, apply: true });

    let combinedPreview: string[] = [];
    if (combinedSessions.length > 0) {
      combinedPreview = [
        'deleted_sessions_preview:',
        ...combinedSessions.slice(0, limit).map((row) => this.formatRetentionSessionCandidate(row)),
      ];
    } else {
      combinedPreview = ['deleted_sessions_preview:', '- none'];
    }

    let deletedBlobPreview: string[] = [];
    if (initialOrphanBlobs.length > 0) {
      deletedBlobPreview = [
        'deleted_blobs_preview:',
        ...initialOrphanBlobs
          .slice(0, limit)
          .map(
            (row) =>
              `- ${row.content_hash.slice(0, 16)} chars=${row.char_count} created_at=${row.created_at}`,
          ),
      ];
    } else {
      deletedBlobPreview = ['deleted_blobs_preview:', '- none'];
    }

    return [
      `deleted_sessions=${result.deletedSessions}`,
      `deleted_blobs=${result.deletedBlobs}`,
      `deleted_blob_chars=${result.deletedBlobChars}`,
      'status=applied',
      ...combinedPreview,
      ...deletedBlobPreview,
    ].join('\n');
  }

  async exportSnapshot(input: {
    filePath: string;
    sessionID?: string;
    scope?: string;
  }): Promise<string> {
    return exportStoreSnapshot(
      {
        workspaceDirectory: this.workspaceDirectory,
        normalizeScope: this.normalizeScope.bind(this),
        resolveScopeSessionIDs: this.resolveScopeSessionIDs.bind(this),
        readScopedSessionRowsSync: this.readScopedSessionRowsSync.bind(this),
        readScopedMessageRowsSync: this.readScopedMessageRowsSync.bind(this),
        readScopedPartRowsSync: this.readScopedPartRowsSync.bind(this),
        readScopedResumeRowsSync: this.readScopedResumeRowsSync.bind(this),
        readScopedArtifactRowsSync: this.readScopedArtifactRowsSync.bind(this),
        readScopedArtifactBlobRowsSync: this.readScopedArtifactBlobRowsSync.bind(this),
        readScopedSummaryRowsSync: this.readScopedSummaryRowsSync.bind(this),
        readScopedSummaryEdgeRowsSync: this.readScopedSummaryEdgeRowsSync.bind(this),
        readScopedSummaryStateRowsSync: this.readScopedSummaryStateRowsSync.bind(this),
      },
      input,
    );
  }

  async importSnapshot(input: {
    filePath: string;
    mode?: 'replace' | 'merge';
    worktreeMode?: SnapshotWorktreeMode;
  }): Promise<string> {
    return importStoreSnapshot(
      {
        workspaceDirectory: this.workspaceDirectory,
        getDb: () => this.getDb(),
        clearSessionDataSync: this.clearSessionDataSync.bind(this),
        backfillArtifactBlobsSync: this.backfillArtifactBlobsSync.bind(this),
        refreshAllLineageSync: this.refreshAllLineageSync.bind(this),
        syncAllDerivedSessionStateSync: this.syncAllDerivedSessionStateSync.bind(this),
        rebuildSearchIndexesSync: this.rebuildSearchIndexesSync.bind(this),
      },
      input,
    );
  }

  async resume(sessionID?: string): Promise<string> {
    const resolvedSessionID = sessionID ?? this.latestSessionIDSync();
    if (!resolvedSessionID) return 'No stored resume snapshots yet.';

    const existing = this.getResumeSync(resolvedSessionID);
    if (existing && !this.isManagedResumeNote(existing)) return existing;

    const generated = await this.buildCompactionContext(resolvedSessionID);
    return generated ?? existing ?? 'No stored resume snapshot for that session.';
  }

  async expand(input: {
    sessionID?: string;
    nodeID?: string;
    query?: string;
    depth?: number;
    messageLimit?: number;
    includeRaw?: boolean;
  }): Promise<string> {
    const depth = clamp(input.depth ?? 1, 1, 4);
    const messageLimit = clamp(input.messageLimit ?? EXPAND_MESSAGE_LIMIT, 1, 20);
    const query = input.query?.trim();

    if (!input.nodeID) {
      const sessionID = input.sessionID ?? this.latestSessionIDSync();
      if (!sessionID) return 'No archived summary nodes yet.';

      const session = this.readSessionSync(sessionID);
      let roots = this.getSummaryRootsForSession(session);
      if (roots.length === 0) return 'No archived summary nodes yet.';

      if (query) {
        const matches = this.findExpandMatches(sessionID, query);
        roots = roots.filter((node) => this.nodeMatchesQuery(node, matches));
        if (roots.length === 0) return `No archived summary nodes matched "${query}".`;
      }

      return [
        `Session: ${sessionID}`,
        query
          ? `Archived summary roots matching "${query}": ${roots.length}`
          : `Archived summary roots: ${roots.length}`,
        'Use lcm_expand with one of these node IDs for more detail:',
        ...roots.map(
          (node) =>
            `- ${node.nodeID} (messages ${node.startIndex + 1}-${node.endIndex + 1}, level ${node.level}): ${node.summaryText}`,
        ),
      ].join('\n');
    }

    const node = this.readSummaryNodeSync(input.nodeID);
    if (!node) return 'Unknown summary node.';

    const session = this.readSessionSync(node.sessionID);
    if (!query)
      return this.renderExpandedNode(session, node, depth, input.includeRaw ?? true, messageLimit);

    const matches = this.findExpandMatches(node.sessionID, query);
    if (!this.nodeMatchesQuery(node, matches)) {
      return `No descendants in ${node.nodeID} matched "${query}".`;
    }

    return this.renderTargetedExpansion(
      session,
      node,
      depth,
      input.includeRaw ?? true,
      messageLimit,
      query,
      matches,
    );
  }

  async buildCompactionContext(sessionID: string): Promise<string | undefined> {
    const session = this.readSessionSync(sessionID);
    if (session.messages.length === 0) return undefined;

    const roots = this.getSummaryRootsForSession(session);
    const note = this.buildResumeNote(session, roots);
    this.getDb()
      .prepare(
        `INSERT INTO resumes (session_id, note, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(sessionID, note, Date.now());
    return note;
  }

  async transformMessages(messages: ConversationMessage[]): Promise<boolean> {
    if (messages.length < this.options.minMessagesForTransform) return false;

    const window = resolveArchiveTransformWindow(messages, this.options.freshTailMessages);
    if (!window) return false;

    const { anchor, archived, recent } = window;

    const roots = this.ensureSummaryGraphSync(anchor.info.sessionID, archived);
    if (roots.length === 0) return false;

    const summary = buildActiveSummaryText(roots, archived.length, this.options.summaryCharBudget);
    const retrieval = await this.buildAutomaticRetrievalContext(
      anchor.info.sessionID,
      recent,
      anchor,
    );
    for (const message of archived) {
      this.compactMessageInPlace(message);
    }

    anchor.parts = anchor.parts.filter(
      (part) => !isSyntheticLcmTextPart(part, ['archive-summary', 'retrieved-context']),
    );
    const syntheticParts: Part[] = [];
    if (retrieval) {
      syntheticParts.push({
        id: `lcm-memory-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        sessionID: anchor.info.sessionID,
        messageID: anchor.info.id,
        type: 'text',
        text: retrieval,
        synthetic: true,
        metadata: { opencodeLcm: 'retrieved-context' },
      });
    }
    syntheticParts.push({
      id: `lcm-summary-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      sessionID: anchor.info.sessionID,
      messageID: anchor.info.id,
      type: 'text',
      text: summary,
      synthetic: true,
      metadata: { opencodeLcm: 'archive-summary' },
    });
    anchor.parts.unshift(...syntheticParts);
    return true;
  }

  systemHint(): string | undefined {
    if (!this.options.systemHint) return undefined;

    return [
      'Archived session state may exist outside the active prompt.',
      'opencode-lcm may automatically recall archived context when it looks relevant to the current turn.',
      'Use lcm_describe, lcm_grep, lcm_resume, lcm_expand, or lcm_artifact only when deeper archive inspection is still needed.',
      'Keep ctx_* usage selective and treat those calls as infrastructure, not task intent.',
    ].join(' ');
  }

  private async buildAutomaticRetrievalContext(
    sessionID: string,
    recent: ConversationMessage[],
    anchor: ConversationMessage,
  ): Promise<string | undefined> {
    if (!this.options.automaticRetrieval.enabled) return undefined;

    const query = this.buildAutomaticRetrievalQuery(anchor, recent);
    if (!query) return undefined;

    const allowedHits =
      clamp(this.options.automaticRetrieval.maxMessageHits, 0, 4) +
      clamp(this.options.automaticRetrieval.maxSummaryHits, 0, 3) +
      clamp(this.options.automaticRetrieval.maxArtifactHits, 0, 3);
    if (allowedHits <= 0) return undefined;

    const targetHits = this.resolveAutomaticRetrievalTargetHits(allowedHits);
    const results: SearchResult[] = [];
    const seenResults = new Set<string>();
    const searchedScopes: ScopeName[] = [];
    const scopeStats: Array<{
      scope: string;
      budget: number;
      rawResults: number;
      selectedHits: number;
    }> = [];
    let stopReason = 'scope-order-exhausted';
    let hits = this.selectAutomaticRetrievalHits(sessionID, recent, query.tokens, results);

    for (const scope of this.buildAutomaticRetrievalScopeOrder(sessionID)) {
      const budget = this.resolveAutomaticRetrievalScopeBudget(scope);
      if (budget <= 0) {
        scopeStats.push({ scope, budget, rawResults: 0, selectedHits: 0 });
        continue;
      }

      searchedScopes.push(scope);
      let scopeRawResults = 0;
      let scopeSelectedHits = 0;

      for (const candidateQuery of query.queries) {
        const remainingBudget = budget - scopeRawResults;
        if (remainingBudget <= 0) break;

        const previousHits = hits;
        const scopedResults = await this.grep({
          query: candidateQuery,
          sessionID,
          scope,
          limit: remainingBudget,
        });

        for (const result of scopedResults) {
          const key = `${result.type}:${result.id}`;
          if (seenResults.has(key)) continue;
          seenResults.add(key);
          results.push(result);
          scopeRawResults += 1;
        }

        hits = this.selectAutomaticRetrievalHits(sessionID, recent, query.tokens, results);
        scopeSelectedHits += this.countNewAutomaticRetrievalHits(previousHits, hits);

        if (hits.length >= allowedHits) {
          stopReason = 'hit-quota-reached';
          break;
        }

        if (hits.length >= targetHits) {
          stopReason = 'target-hits-reached';
          break;
        }
      }

      scopeStats.push({
        scope,
        budget,
        rawResults: scopeRawResults,
        selectedHits: scopeSelectedHits,
      });

      if (
        hits.length > 0 &&
        this.options.automaticRetrieval.stop.stopOnFirstScopeWithHits &&
        scopeSelectedHits > 0
      ) {
        stopReason = 'first-scope-hit';
      }

      if (stopReason !== 'scope-order-exhausted') {
        return renderAutomaticRetrievalContext(
          searchedScopes,
          hits,
          clamp(this.options.automaticRetrieval.maxChars, 240, 4000),
          {
            queries: query.queries,
            rawResults: results.length,
            stopReason,
            scopeStats,
          },
        );
      }
    }

    if (hits.length === 0) return undefined;

    return renderAutomaticRetrievalContext(
      searchedScopes,
      hits,
      clamp(this.options.automaticRetrieval.maxChars, 240, 4000),
      {
        queries: query.queries,
        rawResults: results.length,
        stopReason,
        scopeStats,
      },
    );
  }

  private buildAutomaticRetrievalQuery(
    anchor: ConversationMessage,
    recent: ConversationMessage[],
  ): { queries: string[]; tokens: string[] } | undefined {
    const minTokens = clamp(
      this.options.automaticRetrieval.minTokens,
      1,
      AUTOMATIC_RETRIEVAL_QUERY_TOKENS,
    );
    const tokens: string[] = [];
    const anchorText = sanitizeAutomaticRetrievalSourceText(
      guessMessageText(anchor, this.options.interop.ignoreToolPrefixes),
    );
    const anchorFiles = listFiles(anchor);
    const pushTokens = (value?: string) => {
      if (!value || tokens.length >= AUTOMATIC_RETRIEVAL_QUERY_TOKENS) return;
      const sanitized = sanitizeAutomaticRetrievalSourceText(value);
      if (!sanitized) return;
      for (const token of filterIntentTokens(tokenizeQuery(sanitized))) {
        if (tokens.includes(token)) continue;
        tokens.push(token);
        if (tokens.length >= AUTOMATIC_RETRIEVAL_QUERY_TOKENS) break;
      }
    };

    pushTokens(anchorText);
    for (const file of anchorFiles) pushTokens(path.basename(file));
    const anchorSignalCount = tokens.length;
    if (anchorSignalCount === 0) return undefined;
    if (
      shouldSuppressLowSignalAutomaticRetrievalAnchor(
        anchorText,
        anchorSignalCount,
        minTokens,
        anchorFiles.length,
      )
    ) {
      return undefined;
    }

    for (const message of recent.slice(-AUTOMATIC_RETRIEVAL_RECENT_MESSAGES)) {
      for (const file of listFiles(message)) pushTokens(path.basename(file));
    }

    const recentUsers = recent
      .filter((message) => message.info.role === 'user' && message.info.id !== anchor.info.id)
      .slice(-AUTOMATIC_RETRIEVAL_RECENT_MESSAGES)
      .reverse();
    for (const message of recentUsers) {
      if (tokens.length >= minTokens) break;
      pushTokens(guessMessageText(message, this.options.interop.ignoreToolPrefixes));
    }

    if (tokens.length < minTokens) return undefined;
    const queryTokens = tokens.slice(0, 5);
    return {
      queries: this.buildAutomaticRetrievalQueries(queryTokens, minTokens),
      tokens: queryTokens,
    };
  }

  private buildAutomaticRetrievalQueries(tokens: string[], minTokens: number): string[] {
    const queries: string[] = [];
    const pushQuery = (parts: string[]) => {
      const normalized = parts.filter(Boolean);
      if (normalized.length < minTokens) return;
      const value = normalized.join(' ');
      if (!queries.includes(value)) queries.push(value);
    };

    // Full token set (descending window from front)
    for (let size = Math.min(tokens.length, 4); size >= minTokens; size -= 1) {
      pushQuery(tokens.slice(0, size));
      if (queries.length >= AUTOMATIC_RETRIEVAL_QUERY_VARIANTS) return queries;
    }

    // Sliding windows starting later in the token list
    for (let size = Math.min(tokens.length, 4); size >= Math.max(2, minTokens); size -= 1) {
      for (let start = 1; start + size <= tokens.length; start += 1) {
        pushQuery(tokens.slice(start, start + size));
        if (queries.length >= AUTOMATIC_RETRIEVAL_QUERY_VARIANTS) return queries;
      }
    }

    // Adjacent bigram phrases — FTS NEAR/phrase queries rank adjacency higher
    if (tokens.length >= 2) {
      for (let i = 0; i < tokens.length - 1; i += 1) {
        const phrase = `"${tokens[i]} ${tokens[i + 1]}"`;
        if (!queries.includes(phrase)) queries.push(phrase);
        if (queries.length >= AUTOMATIC_RETRIEVAL_QUERY_VARIANTS) return queries;
      }
    }

    // Skip-gram triples for longer token lists
    if (tokens.length >= 5) {
      pushQuery([tokens[0], tokens[1], tokens[4]]);
      pushQuery([tokens[0], tokens[2], tokens[4]]);
    }

    return queries.slice(0, AUTOMATIC_RETRIEVAL_QUERY_VARIANTS);
  }

  private buildAutomaticRetrievalScopeOrder(sessionID: string): ScopeName[] {
    const configured = this.resolveConfiguredScope('grep', undefined, sessionID);
    const candidates = [...this.options.automaticRetrieval.scopeOrder];
    if (configured === 'all' && !candidates.includes('all')) {
      candidates.push('all');
    }

    const ordered: ScopeName[] = [];
    const seenScopes = new Set<string>();

    for (const scope of candidates) {
      const sessionIDs = this.resolveScopeSessionIDs(scope, sessionID);
      const key = sessionIDs ? [...sessionIDs].sort().join(',') : 'all';
      if (seenScopes.has(key)) continue;
      seenScopes.add(key);
      ordered.push(scope);
    }

    return ordered;
  }

  private resolveAutomaticRetrievalScopeBudget(scope: ScopeName): number {
    return clamp(this.options.automaticRetrieval.scopeBudgets[scope], 0, 24);
  }

  private resolveAutomaticRetrievalTargetHits(allowedHits: number): number {
    return clamp(this.options.automaticRetrieval.stop.targetHits, 1, allowedHits);
  }

  private countNewAutomaticRetrievalHits(
    before: Array<{ kind: string; id: string }>,
    after: Array<{ kind: string; id: string }>,
  ): number {
    const seen = new Set(before.map((hit) => `${hit.kind}:${hit.id}`));
    return after.filter((hit) => !seen.has(`${hit.kind}:${hit.id}`)).length;
  }

  private selectAutomaticRetrievalHits(
    sessionID: string,
    recent: ConversationMessage[],
    tokens: string[],
    results: SearchResult[],
  ) {
    const filteredResults = results.filter(
      (result) => !this.isAutomaticRetrievalNoiseResult(result),
    );
    return selectAutomaticRetrievalHits({
      recent,
      tokens,
      results: filteredResults,
      quotas: {
        message: clamp(this.options.automaticRetrieval.maxMessageHits, 0, 4),
        summary: clamp(this.options.automaticRetrieval.maxSummaryHits, 0, 3),
        artifact: clamp(this.options.automaticRetrieval.maxArtifactHits, 0, 3),
      },
      isFreshResult: (result, freshMessageIDs) =>
        this.isFreshAutomaticRetrievalResult(sessionID, freshMessageIDs, result),
    });
  }

  private isAutomaticRetrievalNoiseResult(result: SearchResult): boolean {
    return isAutomaticRetrievalNoise(result.snippet);
  }

  private isFreshAutomaticRetrievalResult(
    sessionID: string,
    freshMessageIDs: Set<string>,
    result: SearchResult,
  ): boolean {
    if (result.sessionID !== sessionID) return false;
    if (result.type === 'summary') return false;
    if (result.type.startsWith('artifact:')) {
      const artifact = this.readArtifactSync(result.id);
      return artifact ? freshMessageIDs.has(artifact.messageID) : false;
    }
    return freshMessageIDs.has(result.id);
  }

  private buildResumeNote(session: NormalizedSession, roots: SummaryNodeData[]): string {
    const files = [...new Set(session.messages.flatMap(listFiles))].slice(0, 10);
    const recent = session.messages
      .slice(-4)
      .map(
        (message) =>
          `- ${message.info.role}: ${truncate(guessMessageText(message, this.options.interop.ignoreToolPrefixes), 160)}`,
      )
      .filter((line) => !line.endsWith(': '));

    return truncate(
      [
        'LCM prototype resume note',
        `Session: ${session.sessionID}`,
        `Title: ${makeSessionTitle(session) ?? 'Unknown'}`,
        `Root session: ${session.rootSessionID ?? session.sessionID}`,
        `Parent session: ${session.parentSessionID ?? 'none'}`,
        `Lineage depth: ${session.lineageDepth ?? 0}`,
        `Archived messages: ${Math.max(0, session.messages.length - this.options.freshTailMessages)}`,
        ...(roots.length > 0
          ? [
              'Summary roots:',
              ...roots
                .slice(0, 4)
                .map((node) => `- ${node.nodeID}: ${truncate(node.summaryText, 160)}`),
            ]
          : []),
        ...(files.length > 0 ? [`Files touched: ${files.join(', ')}`] : []),
        ...(recent.length > 0 ? ['Recent archived activity:', ...recent] : []),
        'Keep context-mode in charge of routing and sandbox tools.',
        'Use lcm_describe, lcm_grep, lcm_resume, lcm_expand, or lcm_artifact for archived details.',
      ].join('\n'),
      this.options.compactContextLimit,
    );
  }

  private compactMessageInPlace(message: ConversationMessage): void {
    for (const part of message.parts) {
      switch (part.type) {
        case 'text':
          if (part.metadata?.opencodeLcm === 'archive-summary') break;
          part.text = archivePlaceholder('older text elided');
          break;
        case 'reasoning':
          part.text = archivePlaceholder('reasoning omitted');
          break;
        case 'tool': {
          if (part.state.status === 'completed') {
            const label = this.shouldIgnoreTool(part.tool)
              ? 'infrastructure tool output omitted'
              : `tool output for ${part.tool} omitted`;
            part.state.output = archivePlaceholder(label);
            part.state.attachments = undefined;
          }
          if (part.state.status === 'error') {
            part.state.error = archivePlaceholder(`error output for ${part.tool} omitted`);
          }
          break;
        }
        case 'file':
          if (part.source?.text) {
            part.source.text.value = archivePlaceholder(
              part.source.path ?? part.filename ?? 'file contents omitted',
            );
            part.source.text.start = 0;
            part.source.text.end = part.source.text.value.length;
          }
          break;
        case 'snapshot':
          part.snapshot = archivePlaceholder('snapshot omitted');
          break;
        case 'agent':
          if (part.source) {
            part.source.value = archivePlaceholder(`agent source for ${part.name} omitted`);
            part.source.start = 0;
            part.source.end = part.source.value.length;
          }
          break;
        case 'patch':
          part.files = part.files.slice(0, 8);
          break;
        case 'subtask':
          part.prompt = truncate(part.prompt, this.options.partCharBudget);
          part.description = truncate(part.description, this.options.partCharBudget);
          break;
        default:
          break;
      }
    }
  }

  private shouldIgnoreTool(toolName: string): boolean {
    return this.options.interop.ignoreToolPrefixes.some((prefix) => toolName.startsWith(prefix));
  }

  private summarizeMessages(
    messages: ConversationMessage[],
    limit = SUMMARY_NODE_CHAR_LIMIT,
  ): string {
    const goals = messages
      .filter((message) => message.info.role === 'user')
      .map((message) => guessMessageText(message, this.options.interop.ignoreToolPrefixes))
      .filter(Boolean)
      .slice(0, 2)
      .map((text) => truncate(text, 90));

    const work = messages
      .filter((message) => message.info.role === 'assistant')
      .map((message) => guessMessageText(message, this.options.interop.ignoreToolPrefixes))
      .filter(Boolean)
      .slice(-2)
      .map((text) => truncate(text, 90));

    const files = [...new Set(messages.flatMap(listFiles))].slice(0, 4);
    const tools = [...new Set(this.listTools(messages))].slice(0, 4);

    const segments = [
      goals.length > 0 ? `Goals: ${goals.join(' | ')}` : '',
      work.length > 0 ? `Work: ${work.join(' | ')}` : '',
      files.length > 0 ? `Files: ${files.join(', ')}` : '',
      tools.length > 0 ? `Tools: ${tools.join(', ')}` : '',
    ].filter(Boolean);

    if (segments.length === 0) return truncate(`Archived messages ${messages.length}`, limit);
    return truncate(segments.join(' || '), limit);
  }

  private listTools(messages: ConversationMessage[]): string[] {
    const tools: string[] = [];
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== 'tool') continue;
        if (this.shouldIgnoreTool(part.tool)) continue;
        tools.push(part.tool);
      }
    }
    return tools;
  }

  private buildArchivedSignature(messages: ConversationMessage[]): string {
    const hash = createHash('sha256');
    for (const message of messages) {
      hash.update(message.info.id);
      hash.update(message.info.role);
      hash.update(String(message.info.time.created));
      hash.update(guessMessageText(message, this.options.interop.ignoreToolPrefixes));
      hash.update(JSON.stringify(listFiles(message)));
      hash.update(JSON.stringify(this.listTools([message])));
      hash.update(String(message.parts.length));
    }
    return hash.digest('hex');
  }

  private getArchivedMessages(messages: ConversationMessage[]): ConversationMessage[] {
    const window = resolveArchiveTransformWindow(messages, this.options.freshTailMessages);
    if (window) return window.archived;

    const archivedCount = Math.max(0, messages.length - this.options.freshTailMessages);
    return messages.slice(0, archivedCount);
  }

  private getSummaryRootsForSession(session: NormalizedSession): SummaryNodeData[] {
    const archived = this.getArchivedMessages(session.messages);
    return this.ensureSummaryGraphSync(session.sessionID, archived);
  }

  private ensureSummaryGraphSync(
    sessionID: string,
    archivedMessages: ConversationMessage[],
  ): SummaryNodeData[] {
    if (archivedMessages.length === 0) {
      this.clearSummaryGraphSync(sessionID);
      return [];
    }

    const latestMessageCreated = archivedMessages.at(-1)?.info.time.created ?? 0;
    const archivedSignature = this.buildArchivedSignature(archivedMessages);
    const state = safeQueryOne<SummaryStateRow>(
      this.getDb().prepare('SELECT * FROM summary_state WHERE session_id = ?'),
      [sessionID],
      'ensureSummaryGraphSync',
    );

    if (
      state &&
      state.archived_count === archivedMessages.length &&
      state.latest_message_created === latestMessageCreated &&
      state.archived_signature === archivedSignature
    ) {
      const rootIDs = parseJson<string[]>(state.root_node_ids_json);
      const roots = rootIDs
        .map((nodeID) => this.readSummaryNodeSync(nodeID))
        .filter((node): node is SummaryNodeData => Boolean(node));
      if (
        rootIDs.length > 0 &&
        roots.length === rootIDs.length &&
        this.canReuseSummaryGraphSync(sessionID, archivedMessages, roots)
      ) {
        return roots;
      }
    }

    return this.rebuildSummaryGraphSync(sessionID, archivedMessages, archivedSignature);
  }

  private canReuseSummaryGraphSync(
    sessionID: string,
    archivedMessages: ConversationMessage[],
    roots: SummaryNodeData[],
  ): boolean {
    if (roots.length === 0) return false;

    const expectedMessageIDs = archivedMessages.map((message) => message.info.id);
    const seen = new Set<string>();

    const validateNode = (node: SummaryNodeData, expectedSlot: number): boolean => {
      if (node.sessionID !== sessionID) return false;
      if (node.nodeID !== buildSummaryNodeID(sessionID, node.level, expectedSlot)) return false;
      if (seen.has(node.nodeID)) return false;
      seen.add(node.nodeID);

      if (
        node.startIndex < 0 ||
        node.endIndex < node.startIndex ||
        node.endIndex >= expectedMessageIDs.length
      ) {
        return false;
      }

      const expectedNodeMessageIDs = expectedMessageIDs.slice(node.startIndex, node.endIndex + 1);
      if (node.messageIDs.length !== expectedNodeMessageIDs.length) return false;
      for (let index = 0; index < expectedNodeMessageIDs.length; index += 1) {
        if (node.messageIDs[index] !== expectedNodeMessageIDs[index]) return false;
      }

      const expectedSummaryText = this.summarizeMessages(
        archivedMessages.slice(node.startIndex, node.endIndex + 1),
      );
      if (node.summaryText !== expectedSummaryText) return false;

      const children = this.readSummaryChildrenSync(node.nodeID);
      if (node.nodeKind === 'leaf') {
        return (
          children.length === 0 && node.endIndex - node.startIndex + 1 <= SUMMARY_LEAF_MESSAGES
        );
      }
      if (children.length === 0 || children.length > SUMMARY_BRANCH_FACTOR) return false;
      if (children[0]?.startIndex !== node.startIndex) return false;
      if (children.at(-1)?.endIndex !== node.endIndex) return false;

      let nextStartIndex = node.startIndex;
      for (const [childPosition, child] of children.entries()) {
        if (child.level !== node.level - 1) return false;
        if (child.startIndex !== nextStartIndex) return false;
        if (!validateNode(child, expectedSlot * SUMMARY_BRANCH_FACTOR + childPosition))
          return false;
        nextStartIndex = child.endIndex + 1;
      }

      return nextStartIndex === node.endIndex + 1;
    };

    let nextStartIndex = 0;
    for (const [rootSlot, root] of roots.entries()) {
      if (root.startIndex !== nextStartIndex) return false;
      if (!validateNode(root, rootSlot)) return false;
      nextStartIndex = root.endIndex + 1;
    }

    return nextStartIndex === expectedMessageIDs.length;
  }

  private rebuildSummaryGraphSync(
    sessionID: string,
    archivedMessages: ConversationMessage[],
    archivedSignature: string,
  ): SummaryNodeData[] {
    const now = Date.now();
    let level = 0;
    const nodes: SummaryNodeData[] = [];
    const edges: Array<{
      sessionID: string;
      parentID: string;
      childID: string;
      childPosition: number;
    }> = [];

    const makeNode = (input: {
      nodeKind: 'leaf' | 'internal';
      startIndex: number;
      endIndex: number;
      messageIDs: string[];
      summaryText: string;
      level: number;
      slot: number;
    }): SummaryNodeData => ({
      nodeID: buildSummaryNodeID(sessionID, input.level, input.slot),
      sessionID,
      level: input.level,
      nodeKind: input.nodeKind,
      startIndex: input.startIndex,
      endIndex: input.endIndex,
      messageIDs: input.messageIDs,
      summaryText: input.summaryText,
      createdAt: now,
    });

    let currentLevel: SummaryNodeData[] = [];
    for (
      let start = 0, slot = 0;
      start < archivedMessages.length;
      start += SUMMARY_LEAF_MESSAGES, slot += 1
    ) {
      const chunk = archivedMessages.slice(start, start + SUMMARY_LEAF_MESSAGES);
      const node = makeNode({
        nodeKind: 'leaf',
        startIndex: start,
        endIndex: start + chunk.length - 1,
        messageIDs: chunk.map((message) => message.info.id),
        summaryText: this.summarizeMessages(chunk),
        level,
        slot,
      });
      nodes.push(node);
      currentLevel.push(node);
    }

    while (currentLevel.length > 1) {
      level += 1;
      const nextLevel: SummaryNodeData[] = [];

      for (let index = 0; index < currentLevel.length; index += SUMMARY_BRANCH_FACTOR) {
        const children = currentLevel.slice(index, index + SUMMARY_BRANCH_FACTOR);
        const startIndex = children[0].startIndex;
        const endIndex = children.at(-1)?.endIndex ?? startIndex;
        const covered = archivedMessages.slice(startIndex, endIndex + 1);
        const node = makeNode({
          nodeKind: 'internal',
          startIndex,
          endIndex,
          messageIDs: covered.map((message) => message.info.id),
          summaryText: this.summarizeMessages(covered),
          level,
          slot: nextLevel.length,
        });
        nodes.push(node);
        nextLevel.push(node);
        children.forEach((child, childPosition) => {
          edges.push({
            sessionID,
            parentID: node.nodeID,
            childID: child.nodeID,
            childPosition,
          });
        });
      }

      currentLevel = nextLevel;
    }

    const roots = currentLevel;
    const db = this.getDb();
    db.exec('BEGIN');
    try {
      this.clearSummaryGraphSync(sessionID);

      const insertNode = db.prepare(
        `INSERT INTO summary_nodes
         (node_id, session_id, level, node_kind, start_index, end_index, message_ids_json, summary_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertEdge = db.prepare(
        `INSERT INTO summary_edges (session_id, parent_id, child_id, child_position)
         VALUES (?, ?, ?, ?)`,
      );
      const insertSummaryFts = db.prepare(
        'INSERT INTO summary_fts (session_id, node_id, level, created_at, content) VALUES (?, ?, ?, ?, ?)',
      );

      for (const node of nodes) {
        insertNode.run(
          node.nodeID,
          node.sessionID,
          node.level,
          node.nodeKind,
          node.startIndex,
          node.endIndex,
          JSON.stringify(node.messageIDs),
          node.summaryText,
          node.createdAt,
        );
        insertSummaryFts.run(
          node.sessionID,
          node.nodeID,
          String(node.level),
          String(node.createdAt),
          node.summaryText,
        );
      }

      for (const edge of edges) {
        insertEdge.run(edge.sessionID, edge.parentID, edge.childID, edge.childPosition);
      }

      db.prepare(
        `INSERT INTO summary_state (session_id, archived_count, latest_message_created, archived_signature, root_node_ids_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
            archived_count = excluded.archived_count,
            latest_message_created = excluded.latest_message_created,
            archived_signature = excluded.archived_signature,
            root_node_ids_json = excluded.root_node_ids_json,
            updated_at = excluded.updated_at`,
      ).run(
        sessionID,
        archivedMessages.length,
        archivedMessages.at(-1)?.info.time.created ?? 0,
        archivedSignature,
        JSON.stringify(roots.map((node) => node.nodeID)),
        now,
      );

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return roots;
  }

  private readSummaryNodeSync(nodeID: string): SummaryNodeData | undefined {
    const row = safeQueryOne<SummaryNodeRow>(
      this.getDb().prepare('SELECT * FROM summary_nodes WHERE node_id = ?'),
      [nodeID],
      'readSummaryNodeSync',
    );
    if (!row) return undefined;

    return {
      nodeID: row.node_id,
      sessionID: row.session_id,
      level: row.level,
      nodeKind: row.node_kind === 'leaf' ? 'leaf' : 'internal',
      startIndex: row.start_index,
      endIndex: row.end_index,
      messageIDs: parseJson<string[]>(row.message_ids_json),
      summaryText: row.summary_text,
      createdAt: row.created_at,
    };
  }

  private readSummaryChildrenSync(nodeID: string): SummaryNodeData[] {
    const rows = this.getDb()
      .prepare(
        `SELECT e.parent_id, e.child_id, e.child_position
         FROM summary_edges e
         WHERE e.parent_id = ?
         ORDER BY e.child_position ASC`,
      )
      .all(nodeID) as SummaryEdgeRow[];

    return rows
      .map((row) => this.readSummaryNodeSync(row.child_id))
      .filter((node): node is SummaryNodeData => Boolean(node));
  }

  private readArtifactBlobSync(contentHash?: string | null): ArtifactBlobRow | undefined {
    if (!contentHash) return undefined;
    return safeQueryOne<ArtifactBlobRow>(
      this.getDb().prepare('SELECT * FROM artifact_blobs WHERE content_hash = ?'),
      [contentHash],
      'readArtifactBlobSync',
    );
  }

  private materializeArtifactRow(row: ArtifactRow): ArtifactData {
    const blob = this.readArtifactBlobSync(row.content_hash);
    const contentText = blob?.content_text ?? row.content_text;
    return {
      artifactID: row.artifact_id,
      sessionID: row.session_id,
      messageID: row.message_id,
      partID: row.part_id,
      artifactKind: row.artifact_kind,
      fieldName: row.field_name,
      previewText: row.preview_text,
      contentText,
      contentHash: row.content_hash ?? hashContent(contentText),
      charCount: blob?.char_count ?? row.char_count,
      createdAt: row.created_at,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json || '{}'),
    };
  }

  private readArtifactSync(artifactID: string): ArtifactData | undefined {
    const row = safeQueryOne<ArtifactRow>(
      this.getDb().prepare('SELECT * FROM artifacts WHERE artifact_id = ?'),
      [artifactID],
      'readArtifactSync',
    );
    if (!row) return undefined;

    return this.materializeArtifactRow(row);
  }

  private readArtifactsForSessionSync(sessionID: string): ArtifactData[] {
    const rows = this.getDb()
      .prepare(
        'SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC, artifact_id ASC',
      )
      .all(sessionID) as ArtifactRow[];

    return rows.map((row) => this.materializeArtifactRow(row));
  }

  private readArtifactsForMessageSync(messageID: string): ArtifactData[] {
    const rows = this.getDb()
      .prepare(
        'SELECT * FROM artifacts WHERE message_id = ? ORDER BY created_at ASC, artifact_id ASC',
      )
      .all(messageID) as ArtifactRow[];

    return rows.map((row) => this.materializeArtifactRow(row));
  }

  private findExpandMatches(
    sessionID: string,
    query: string,
  ): {
    messageIDs: Set<string>;
    nodeIDs: Set<string>;
    artifactIDs: Set<string>;
  } {
    const messageIDs = new Set<string>();
    const nodeIDs = new Set<string>();
    const artifactIDs = new Set<string>();
    const ftsQuery = this.buildFtsQuery(query);
    const db = this.getDb();

    if (ftsQuery) {
      try {
        const messageRows = db
          .prepare(
            'SELECT message_id FROM message_fts WHERE session_id = ? AND message_fts MATCH ? LIMIT 200',
          )
          .all(sessionID, ftsQuery) as Array<{ message_id: string }>;
        for (const row of messageRows) messageIDs.add(row.message_id);

        const nodeRows = db
          .prepare(
            'SELECT node_id FROM summary_fts WHERE session_id = ? AND summary_fts MATCH ? LIMIT 200',
          )
          .all(sessionID, ftsQuery) as Array<{ node_id: string }>;
        for (const row of nodeRows) nodeIDs.add(row.node_id);

        const artifactRows = db
          .prepare(
            'SELECT artifact_id, message_id FROM artifact_fts WHERE session_id = ? AND artifact_fts MATCH ? LIMIT 200',
          )
          .all(sessionID, ftsQuery) as Array<{ artifact_id: string; message_id: string }>;
        for (const row of artifactRows) {
          artifactIDs.add(row.artifact_id);
          messageIDs.add(row.message_id);
        }
      } catch (error) {
        getLogger().debug('FTS query failed, falling back to scan', { query, error });
      }
    }

    if (messageIDs.size === 0 && nodeIDs.size === 0 && artifactIDs.size === 0) {
      const lower = query.toLowerCase();
      const session = this.readSessionSync(sessionID);
      for (const message of session.messages) {
        const text = guessMessageText(
          message,
          this.options.interop.ignoreToolPrefixes,
        ).toLowerCase();
        if (text.includes(lower)) messageIDs.add(message.info.id);
      }

      for (const artifact of this.readArtifactsForSessionSync(sessionID)) {
        if (`${artifact.previewText}\n${artifact.contentText}`.toLowerCase().includes(lower)) {
          artifactIDs.add(artifact.artifactID);
          messageIDs.add(artifact.messageID);
        }
      }

      const summaryRows = db
        .prepare(
          'SELECT node_id, summary_text FROM summary_nodes WHERE session_id = ? ORDER BY created_at ASC',
        )
        .all(sessionID) as Array<{ node_id: string; summary_text: string }>;
      for (const row of summaryRows) {
        if (row.summary_text.toLowerCase().includes(lower)) nodeIDs.add(row.node_id);
      }
    }

    return { messageIDs, nodeIDs, artifactIDs };
  }

  private nodeMatchesQuery(
    node: SummaryNodeData,
    matches: { messageIDs: Set<string>; nodeIDs: Set<string>; artifactIDs: Set<string> },
  ): boolean {
    if (matches.nodeIDs.has(node.nodeID)) return true;
    if (node.messageIDs.some((messageID) => matches.messageIDs.has(messageID))) return true;
    return this.readSummaryChildrenSync(node.nodeID).some((child) =>
      this.nodeMatchesQuery(child, matches),
    );
  }

  private renderRawMessagesForNode(
    session: NormalizedSession,
    node: SummaryNodeData,
    messageLimit: number,
    matches?: { messageIDs: Set<string>; nodeIDs: Set<string>; artifactIDs: Set<string> },
    indent = '',
  ): string[] {
    const byID = new Map(session.messages.map((message) => [message.info.id, message]));
    const allCovered = node.messageIDs
      .map((messageID) => byID.get(messageID))
      .filter((message): message is ConversationMessage => Boolean(message));

    const filteredCovered =
      matches && matches.messageIDs.size > 0
        ? allCovered.filter((message) => matches.messageIDs.has(message.info.id))
        : allCovered;
    const covered = (filteredCovered.length > 0 ? filteredCovered : allCovered).slice(
      0,
      messageLimit,
    );
    if (covered.length === 0) return [];

    const lines = [`${indent}Raw messages:`];
    for (const message of covered) {
      const snippet =
        guessMessageText(message, this.options.interop.ignoreToolPrefixes) || '(no text content)';
      lines.push(`${indent}- ${message.info.role} ${message.info.id}: ${truncate(snippet, 220)}`);
      const artifacts = this.readArtifactsForMessageSync(message.info.id);
      const shownArtifacts =
        matches && matches.artifactIDs.size > 0
          ? artifacts.filter((artifact) => matches.artifactIDs.has(artifact.artifactID))
          : artifacts;
      for (const artifact of shownArtifacts.slice(0, 4)) {
        lines.push(
          `${indent}  artifact ${artifact.artifactID} ${artifact.artifactKind}/${artifact.fieldName} (${artifact.charCount} chars): ${truncate(artifact.previewText, 120)}`,
        );
      }
      if (shownArtifacts.length > 4) {
        lines.push(`${indent}  ... ${shownArtifacts.length - 4} more artifact(s)`);
      }
    }

    if (
      (filteredCovered.length > 0 ? filteredCovered.length : allCovered.length) > covered.length
    ) {
      lines.push(
        `${indent}- ... ${(filteredCovered.length > 0 ? filteredCovered.length : allCovered.length) - covered.length} more message(s)`,
      );
    }
    return lines;
  }

  private collectTargetedNodeLines(
    session: NormalizedSession,
    node: SummaryNodeData,
    depth: number,
    includeRaw: boolean,
    messageLimit: number,
    matches: { messageIDs: Set<string>; nodeIDs: Set<string>; artifactIDs: Set<string> },
    indent = '',
  ): string[] {
    const lines = [
      `${indent}- ${node.nodeID} (level ${node.level}, messages ${node.startIndex + 1}-${node.endIndex + 1}): ${truncate(node.summaryText, 180)}`,
    ];
    const children = this.readSummaryChildrenSync(node.nodeID).filter((child) =>
      this.nodeMatchesQuery(child, matches),
    );

    if (children.length > 0 && depth > 0) {
      for (const child of children) {
        lines.push(
          ...this.collectTargetedNodeLines(
            session,
            child,
            depth - 1,
            includeRaw,
            messageLimit,
            matches,
            `${indent}  `,
          ),
        );
      }
      return lines;
    }

    if (includeRaw) {
      lines.push(
        ...this.renderRawMessagesForNode(session, node, messageLimit, matches, `${indent}  `),
      );
    }
    return lines;
  }

  private renderTargetedExpansion(
    session: NormalizedSession,
    node: SummaryNodeData,
    depth: number,
    includeRaw: boolean,
    messageLimit: number,
    query: string,
    matches: { messageIDs: Set<string>; nodeIDs: Set<string>; artifactIDs: Set<string> },
  ): string {
    const lines = [
      `Node: ${node.nodeID}`,
      `Session: ${node.sessionID}`,
      `Query: ${query}`,
      `Level: ${node.level}`,
      `Coverage: archived messages ${node.startIndex + 1}-${node.endIndex + 1}`,
      `Summary: ${node.summaryText}`,
      'Targeted descendants:',
    ];

    const children = this.readSummaryChildrenSync(node.nodeID).filter((child) =>
      this.nodeMatchesQuery(child, matches),
    );
    if (children.length > 0) {
      for (const child of children) {
        lines.push(
          ...this.collectTargetedNodeLines(
            session,
            child,
            depth - 1,
            includeRaw,
            messageLimit,
            matches,
            '',
          ),
        );
      }
      return lines.join('\n');
    }

    lines.push(...this.renderRawMessagesForNode(session, node, messageLimit, matches));
    return lines.join('\n');
  }

  private renderExpandedNode(
    session: NormalizedSession,
    node: SummaryNodeData,
    depth: number,
    includeRaw: boolean,
    messageLimit: number,
  ): string {
    const children = this.readSummaryChildrenSync(node.nodeID);
    const lines = [
      `Node: ${node.nodeID}`,
      `Session: ${node.sessionID}`,
      `Level: ${node.level}`,
      `Coverage: archived messages ${node.startIndex + 1}-${node.endIndex + 1}`,
      `Summary: ${node.summaryText}`,
    ];

    if (children.length > 0) {
      lines.push('Children:');
      for (const child of children) {
        lines.push(`- ${child.nodeID}: ${truncate(child.summaryText, 180)}`);
      }

      if (depth > 1) {
        lines.push('Deeper descendants:');
        for (const child of children) {
          const grandChildren = this.readSummaryChildrenSync(child.nodeID);
          for (const grandChild of grandChildren.slice(0, SUMMARY_BRANCH_FACTOR)) {
            lines.push(
              `- ${child.nodeID} -> ${grandChild.nodeID}: ${truncate(grandChild.summaryText, 160)}`,
            );
          }
        }
      }

      return lines.join('\n');
    }

    if (!includeRaw) return lines.join('\n');

    lines.push(...this.renderRawMessagesForNode(session, node, messageLimit));

    return lines.join('\n');
  }

  private buildFtsQuery(query: string): string | undefined {
    return buildFtsQuery(query);
  }

  private searchDeps() {
    return {
      getDb: () => this.getDb(),
      readScopedSessionsSync: (sessionIDs?: string[]) => this.readScopedSessionsSync(sessionIDs),
      readScopedSummaryRowsSync: (sessionIDs?: string[]) =>
        this.readScopedSummaryRowsSync(sessionIDs),
      readScopedArtifactRowsSync: (sessionIDs?: string[]) =>
        this.readScopedArtifactRowsSync(sessionIDs),
      ignoreToolPrefixes: this.options.interop.ignoreToolPrefixes,
      guessMessageText: (message: ConversationMessage, ignorePrefixes: string[]) =>
        guessMessageText(message, ignorePrefixes),
    };
  }

  private searchWithFts(query: string, sessionIDs?: string[], limit = 5): SearchResult[] {
    return searchWithFtsModule(this.searchDeps(), query, sessionIDs, limit);
  }

  private searchByScan(query: string, sessionIDs?: string[], limit = 5): SearchResult[] {
    return searchByScanModule(this.searchDeps(), query, sessionIDs, limit);
  }

  private replaceMessageSearchRowsSync(session: NormalizedSession): void {
    replaceMessageSearchRowsModule(this.searchDeps(), session);
  }

  private replaceMessageSearchRowSync(sessionID: string, message: ConversationMessage): void {
    replaceMessageSearchRowModule(this.searchDeps(), sessionID, message);
  }

  private rebuildSearchIndexesSync(): void {
    rebuildSearchIndexesModule(this.searchDeps());
  }

  private ensureSessionColumnsSync(): void {
    const db = this.getDb();
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    const ensure = (column: string, definition: string) => {
      if (names.has(column)) return;
      db.exec(`ALTER TABLE sessions ADD COLUMN ${definition}`);
      names.add(column);
    };

    ensure('session_directory', 'session_directory TEXT');
    ensure('worktree_key', 'worktree_key TEXT');
    ensure('parent_session_id', 'parent_session_id TEXT');
    ensure('root_session_id', 'root_session_id TEXT');
    ensure('lineage_depth', 'lineage_depth INTEGER');
    ensure('pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
    ensure('pin_reason', 'pin_reason TEXT');
  }

  private ensureSummaryStateColumnsSync(): void {
    const db = this.getDb();
    const columns = db.prepare('PRAGMA table_info(summary_state)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (names.has('archived_signature')) return;

    db.exec("ALTER TABLE summary_state ADD COLUMN archived_signature TEXT NOT NULL DEFAULT ''");
  }

  private ensureArtifactColumnsSync(): void {
    const db = this.getDb();
    const columns = db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    if (!names.has('metadata_json')) {
      db.exec("ALTER TABLE artifacts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' ");
      names.add('metadata_json');
    }

    if (!names.has('content_hash')) {
      db.exec('ALTER TABLE artifacts ADD COLUMN content_hash TEXT');
    }
  }

  private backfillArtifactBlobsSync(): void {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM artifacts ORDER BY created_at ASC, artifact_id ASC')
      .all() as ArtifactRow[];
    if (rows.length === 0) return;

    const insertBlob = db.prepare(
      `INSERT OR IGNORE INTO artifact_blobs (content_hash, content_text, char_count, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const updateArtifact = db.prepare(
      "UPDATE artifacts SET content_hash = ?, content_text = CASE WHEN content_text != '' THEN '' ELSE content_text END WHERE artifact_id = ?",
    );

    for (const row of rows) {
      const contentText =
        row.content_text || this.readArtifactBlobSync(row.content_hash)?.content_text || '';
      if (!contentText) continue;
      const contentHash = row.content_hash ?? hashContent(contentText);
      insertBlob.run(contentHash, contentText, contentText.length, row.created_at);
      if (row.content_hash !== contentHash || row.content_text !== '') {
        updateArtifact.run(contentHash, row.artifact_id);
      }
    }
  }

  private refreshAllLineageSync(): void {
    const db = this.getDb();
    const rows = db.prepare('SELECT session_id, parent_session_id FROM sessions').all() as Array<{
      session_id: string;
      parent_session_id: string | null;
    }>;
    const byID = new Map(rows.map((row) => [row.session_id, row]));

    const invalidParentSessionIDs = new Set<string>();
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const detectInvalidParents = (sessionID: string): void => {
      if (visited.has(sessionID)) return;

      visiting.add(sessionID);
      const row = byID.get(sessionID);
      const parentSessionID = row?.parent_session_id ?? undefined;

      if (parentSessionID) {
        if (parentSessionID === sessionID || visiting.has(parentSessionID)) {
          invalidParentSessionIDs.add(sessionID);
        } else if (byID.has(parentSessionID)) {
          detectInvalidParents(parentSessionID);
        }
      }

      visiting.delete(sessionID);
      visited.add(sessionID);
    };

    for (const row of rows) detectInvalidParents(row.session_id);

    if (invalidParentSessionIDs.size > 0) {
      const clearParent = db.prepare(
        'UPDATE sessions SET parent_session_id = NULL WHERE session_id = ?',
      );
      for (const sessionID of invalidParentSessionIDs) {
        clearParent.run(sessionID);
        const row = byID.get(sessionID);
        if (row) row.parent_session_id = null;
      }
    }

    const memo = new Map<string, { rootSessionID: string; lineageDepth: number }>();

    const resolve = (sessionID: string): { rootSessionID: string; lineageDepth: number } => {
      const existing = memo.get(sessionID);
      if (existing) return existing;

      const row = byID.get(sessionID);
      let resolved: { rootSessionID: string; lineageDepth: number };

      if (!row?.parent_session_id) {
        resolved = { rootSessionID: sessionID, lineageDepth: 0 };
      } else {
        const parent = resolve(row.parent_session_id);
        resolved = {
          rootSessionID: parent.rootSessionID,
          lineageDepth: parent.lineageDepth + 1,
        };
      }

      memo.set(sessionID, resolved);
      return resolved;
    };

    const update = db.prepare(
      'UPDATE sessions SET root_session_id = ?, lineage_depth = ? WHERE session_id = ?',
    );
    for (const row of rows) {
      const lineage = resolve(row.session_id);
      update.run(lineage.rootSessionID, lineage.lineageDepth, row.session_id);
    }
  }

  private resolveLineageSync(
    sessionID: string,
    parentSessionID?: string,
  ): { rootSessionID: string; lineageDepth: number } {
    if (!parentSessionID) return { rootSessionID: sessionID, lineageDepth: 0 };

    const parent = this.getDb()
      .prepare('SELECT root_session_id, lineage_depth FROM sessions WHERE session_id = ?')
      .get(parentSessionID) as
      | { root_session_id: string | null; lineage_depth: number | null }
      | undefined;

    if (!parent) return { rootSessionID: parentSessionID, lineageDepth: 1 };
    return {
      rootSessionID: parent.root_session_id ?? parentSessionID,
      lineageDepth: (parent.lineage_depth ?? 0) + 1,
    };
  }

  private applyEvent(session: NormalizedSession, event: CapturedEvent): NormalizedSession {
    const payload = event.payload as Event;

    switch (payload.type) {
      case 'session.created':
      case 'session.updated':
        session.title = payload.properties.info.title;
        session.directory = payload.properties.info.directory;
        session.parentSessionID = payload.properties.info.parentID ?? undefined;
        session.deleted = false;
        return session;
      case 'session.deleted':
        session.title = payload.properties.info.title;
        session.directory = payload.properties.info.directory;
        session.parentSessionID = payload.properties.info.parentID ?? session.parentSessionID;
        session.deleted = true;
        return session;
      case 'session.compacted':
        session.compactedAt = event.timestamp;
        return session;
      case 'message.updated': {
        const existing = session.messages.find(
          (message) => message.info.id === payload.properties.info.id,
        );
        if (existing) existing.info = payload.properties.info;
        else {
          session.messages.push({ info: payload.properties.info, parts: [] });
          session.messages.sort(compareMessages);
        }
        return session;
      }
      case 'message.removed':
        session.messages = session.messages.filter(
          (message) => message.info.id !== payload.properties.messageID,
        );
        return session;
      case 'message.part.updated': {
        const message = session.messages.find(
          (entry) => entry.info.id === payload.properties.part.messageID,
        );
        if (!message) return session;

        const existing = message.parts.findIndex((part) => part.id === payload.properties.part.id);
        if (existing >= 0) message.parts[existing] = payload.properties.part;
        else message.parts.push(payload.properties.part);
        return session;
      }
      case 'message.part.removed': {
        const message = session.messages.find(
          (entry) => entry.info.id === payload.properties.messageID,
        );
        if (!message) return session;
        message.parts = message.parts.filter((part) => part.id !== payload.properties.partID);
        return session;
      }
      default:
        return session;
    }
  }

  private getResumeSync(sessionID: string): string | undefined {
    const row = safeQueryOne<{ note: string }>(
      this.getDb().prepare('SELECT note FROM resumes WHERE session_id = ?'),
      [sessionID],
      'getResumeSync',
    );
    return row?.note;
  }

  private readSessionHeaderSync(sessionID: string): NormalizedSession | undefined {
    const row = safeQueryOne<SessionRow>(
      this.getDb().prepare('SELECT * FROM sessions WHERE session_id = ?'),
      [sessionID],
      'readSessionHeaderSync',
    );
    if (!row) return undefined;

    return {
      sessionID: row.session_id,
      title: row.title ?? undefined,
      directory: row.session_directory ?? undefined,
      parentSessionID: row.parent_session_id ?? undefined,
      rootSessionID: row.root_session_id ?? undefined,
      lineageDepth: row.lineage_depth ?? undefined,
      pinned: Boolean(row.pinned),
      pinReason: row.pin_reason ?? undefined,
      updatedAt: row.updated_at,
      compactedAt: row.compacted_at ?? undefined,
      deleted: Boolean(row.deleted),
      eventCount: row.event_count,
      messages: [],
    };
  }

  private clearSessionDataSync(sessionID: string): void {
    const db = this.getDb();
    db.prepare('DELETE FROM artifact_fts WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM summary_edges WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM summary_nodes WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM summary_state WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM resumes WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM parts WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionID);
  }

  private readChildSessionsSync(sessionID: string): NormalizedSession[] {
    const rows = this.getDb()
      .prepare(
        'SELECT session_id FROM sessions WHERE parent_session_id = ? ORDER BY updated_at DESC',
      )
      .all(sessionID) as Array<{ session_id: string }>;
    return rows
      .map((row) => this.readSessionHeaderSync(row.session_id))
      .filter((row): row is NormalizedSession => Boolean(row));
  }

  private readLineageChainSync(sessionID: string): NormalizedSession[] {
    const chain: NormalizedSession[] = [];
    const seen = new Set<string>();
    let currentID: string | undefined = sessionID;

    while (currentID && !seen.has(currentID)) {
      seen.add(currentID);
      const session = this.readSessionHeaderSync(currentID);
      if (!session) break;
      chain.unshift(session);
      currentID = session.parentSessionID;
    }

    return chain;
  }

  private readAllSessionsSync(): NormalizedSession[] {
    const rows = this.getDb()
      .prepare(
        'SELECT session_id FROM sessions WHERE event_count > 0 OR updated_at > 0 ORDER BY updated_at DESC',
      )
      .all() as Array<{ session_id: string }>;
    const sessionIDs = rows.map((row) => row.session_id);
    if (sessionIDs.length <= 1) return sessionIDs.map((id) => this.readSessionSync(id));
    return this.readSessionsBatchSync(sessionIDs);
  }

  private readSessionsBatchSync(sessionIDs: string[]): NormalizedSession[] {
    const db = this.getDb();
    const placeholders = sessionIDs.map(() => '?').join(', ');

    // 1. Session headers (batch)
    const sessionRows = db
      .prepare(`SELECT * FROM sessions WHERE session_id IN (${placeholders})`)
      .all(...sessionIDs) as SessionRow[];
    const sessionMap = new Map<string, SessionRow>();
    for (const row of sessionRows) sessionMap.set(row.session_id, row);

    // 2. Messages (batch)
    const messageRows = db
      .prepare(
        `SELECT * FROM messages WHERE session_id IN (${placeholders}) ORDER BY session_id ASC, created_at ASC, message_id ASC`,
      )
      .all(...sessionIDs) as MessageRow[];

    // 3. Parts (batch)
    const partRows = db
      .prepare(
        `SELECT * FROM parts WHERE session_id IN (${placeholders}) ORDER BY session_id ASC, message_id ASC, sort_key ASC, part_id ASC`,
      )
      .all(...sessionIDs) as PartRow[];

    // 4. Artifacts (batch)
    const artifactRows = db
      .prepare(
        `SELECT * FROM artifacts WHERE session_id IN (${placeholders}) ORDER BY created_at ASC, artifact_id ASC`,
      )
      .all(...sessionIDs) as ArtifactRow[];

    // 5. Artifact blobs (batch)
    const contentHashes = [
      ...new Set(artifactRows.map((r) => r.content_hash).filter(Boolean) as string[]),
    ];
    const blobMap = new Map<string, ArtifactBlobRow>();
    if (contentHashes.length > 0) {
      const blobPlaceholders = contentHashes.map(() => '?').join(', ');
      const blobRows = db
        .prepare(`SELECT * FROM artifact_blobs WHERE content_hash IN (${blobPlaceholders})`)
        .all(...contentHashes) as ArtifactBlobRow[];
      for (const blob of blobRows) blobMap.set(blob.content_hash, blob);
    }

    // Group artifacts by part ID
    const artifactsByPart = new Map<string, ArtifactData[]>();
    for (const row of artifactRows) {
      const contentHash = row.content_hash;
      const blob = contentHash ? blobMap.get(contentHash) : undefined;
      const contentText = blob?.content_text ?? row.content_text;
      const artifact: ArtifactData = {
        artifactID: row.artifact_id,
        sessionID: row.session_id,
        messageID: row.message_id,
        partID: row.part_id,
        artifactKind: row.artifact_kind,
        fieldName: row.field_name,
        previewText: row.preview_text,
        contentText,
        contentHash: contentHash ?? hashContent(contentText),
        charCount: blob?.char_count ?? row.char_count,
        createdAt: row.created_at,
        metadata: parseJson<Record<string, unknown>>(row.metadata_json || '{}'),
      };
      const list = artifactsByPart.get(artifact.partID) ?? [];
      list.push(artifact);
      artifactsByPart.set(artifact.partID, list);
    }

    // Assemble parts per session+message
    const partsBySessionMessage = new Map<string, Map<string, Part[]>>();
    for (const partRow of partRows) {
      const _messageKey = `${partRow.session_id}|${partRow.message_id}`;
      let partsByMessage = partsBySessionMessage.get(partRow.session_id);
      if (!partsByMessage) {
        partsByMessage = new Map();
        partsBySessionMessage.set(partRow.session_id, partsByMessage);
      }
      const part = parseJson<Part>(partRow.part_json);
      const artifacts = artifactsByPart.get(part.id) ?? [];
      for (const artifact of artifacts) {
        switch (part.type) {
          case 'text':
          case 'reasoning':
            if (artifact.fieldName === 'text') part.text = artifact.contentText;
            break;
          case 'tool':
            if (part.state.status === 'completed' && artifact.fieldName === 'output')
              part.state.output = artifact.contentText;
            if (part.state.status === 'error' && artifact.fieldName === 'error')
              part.state.error = artifact.contentText;
            if (
              part.state.status === 'completed' &&
              artifact.fieldName.startsWith('attachment_text:')
            ) {
              const index = Number(artifact.fieldName.split(':')[1]);
              const attachment = part.state.attachments?.[index];
              if (attachment?.source?.text) {
                attachment.source.text.value = artifact.contentText;
                attachment.source.text.start = 0;
                attachment.source.text.end = artifact.contentText.length;
              }
            }
            break;
          case 'file':
            if (artifact.fieldName === 'source' && part.source?.text) {
              part.source.text.value = artifact.contentText;
              part.source.text.start = 0;
              part.source.text.end = artifact.contentText.length;
            }
            break;
          case 'snapshot':
            if (artifact.fieldName === 'snapshot') part.snapshot = artifact.contentText;
            break;
          case 'agent':
            if (artifact.fieldName === 'source' && part.source) {
              part.source.value = artifact.contentText;
              part.source.start = 0;
              part.source.end = artifact.contentText.length;
            }
            break;
          case 'subtask':
            if (artifact.fieldName === 'prompt') part.prompt = artifact.contentText;
            if (artifact.fieldName === 'description') part.description = artifact.contentText;
            break;
          default:
            break;
        }
      }
      const parts = partsByMessage.get(partRow.message_id) ?? [];
      parts.push(part);
      partsByMessage.set(partRow.message_id, parts);
    }

    // Group messages per session
    const messagesBySession = new Map<string, Array<{ info: Message; parts: Part[] }>>();
    for (const messageRow of messageRows) {
      const sessionParts = partsBySessionMessage.get(messageRow.session_id);
      const messages = messagesBySession.get(messageRow.session_id) ?? [];
      messages.push({
        info: parseJson<Message>(messageRow.info_json),
        parts: sessionParts?.get(messageRow.message_id) ?? [],
      });
      messagesBySession.set(messageRow.session_id, messages);
    }

    // Build NormalizedSession results
    return sessionIDs.map((sessionID) => {
      const row = sessionMap.get(sessionID);
      const messages = messagesBySession.get(sessionID) ?? [];
      if (!row) {
        return { sessionID, updatedAt: 0, eventCount: 0, messages };
      }
      return {
        sessionID: row.session_id,
        title: row.title ?? undefined,
        directory: row.session_directory ?? undefined,
        parentSessionID: row.parent_session_id ?? undefined,
        rootSessionID: row.root_session_id ?? undefined,
        lineageDepth: row.lineage_depth ?? undefined,
        pinned: Boolean(row.pinned),
        pinReason: row.pin_reason ?? undefined,
        updatedAt: row.updated_at,
        compactedAt: row.compacted_at ?? undefined,
        deleted: Boolean(row.deleted),
        eventCount: row.event_count,
        messages,
      };
    });
  }

  private readSessionSync(sessionID: string, options?: ReadSessionOptions): NormalizedSession {
    const db = this.getDb();
    const row = safeQueryOne<SessionRow>(
      db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
      [sessionID],
      'readSessionSync',
    );
    const messageRows = db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, message_id ASC',
      )
      .all(sessionID) as MessageRow[];
    const partRows = db
      .prepare(
        'SELECT * FROM parts WHERE session_id = ? ORDER BY message_id ASC, sort_key ASC, part_id ASC',
      )
      .all(sessionID) as PartRow[];
    const artifactsByPart = new Map<string, ArtifactData[]>();
    const artifactMessageIDs = options?.artifactMessageIDs;
    const artifacts =
      artifactMessageIDs === undefined
        ? this.readArtifactsForSessionSync(sessionID)
        : [...new Set(artifactMessageIDs)].flatMap((messageID) =>
            this.readArtifactsForMessageSync(messageID),
          );
    for (const artifact of artifacts) {
      const list = artifactsByPart.get(artifact.partID) ?? [];
      list.push(artifact);
      artifactsByPart.set(artifact.partID, list);
    }

    const partsByMessage = new Map<string, Part[]>();
    for (const partRow of partRows) {
      const parts = partsByMessage.get(partRow.message_id) ?? [];
      const part = parseJson<Part>(partRow.part_json);
      const artifacts = artifactsByPart.get(part.id) ?? [];
      for (const artifact of artifacts) {
        switch (part.type) {
          case 'text':
          case 'reasoning':
            if (artifact.fieldName === 'text') part.text = artifact.contentText;
            break;
          case 'tool':
            if (part.state.status === 'completed' && artifact.fieldName === 'output')
              part.state.output = artifact.contentText;
            if (part.state.status === 'error' && artifact.fieldName === 'error')
              part.state.error = artifact.contentText;
            if (
              part.state.status === 'completed' &&
              artifact.fieldName.startsWith('attachment_text:')
            ) {
              const index = Number(artifact.fieldName.split(':')[1]);
              const attachment = part.state.attachments?.[index];
              if (attachment?.source?.text) {
                attachment.source.text.value = artifact.contentText;
                attachment.source.text.start = 0;
                attachment.source.text.end = artifact.contentText.length;
              }
            }
            break;
          case 'file':
            if (artifact.fieldName === 'source' && part.source?.text) {
              part.source.text.value = artifact.contentText;
              part.source.text.start = 0;
              part.source.text.end = artifact.contentText.length;
            }
            break;
          case 'snapshot':
            if (artifact.fieldName === 'snapshot') part.snapshot = artifact.contentText;
            break;
          case 'agent':
            if (artifact.fieldName === 'source' && part.source) {
              part.source.value = artifact.contentText;
              part.source.start = 0;
              part.source.end = artifact.contentText.length;
            }
            break;
          case 'subtask':
            if (artifact.fieldName === 'prompt') part.prompt = artifact.contentText;
            if (artifact.fieldName === 'description') part.description = artifact.contentText;
            break;
          default:
            break;
        }
      }
      parts.push(part);
      partsByMessage.set(partRow.message_id, parts);
    }

    const messages = messageRows.map((messageRow) => ({
      info: parseJson<Message>(messageRow.info_json),
      parts: partsByMessage.get(messageRow.message_id) ?? [],
    }));

    if (!row) {
      return {
        sessionID,
        updatedAt: 0,
        eventCount: 0,
        messages,
      };
    }

    return {
      sessionID: row.session_id,
      title: row.title ?? undefined,
      directory: row.session_directory ?? undefined,
      parentSessionID: row.parent_session_id ?? undefined,
      rootSessionID: row.root_session_id ?? undefined,
      lineageDepth: row.lineage_depth ?? undefined,
      pinned: Boolean(row.pinned),
      pinReason: row.pin_reason ?? undefined,
      updatedAt: row.updated_at,
      compactedAt: row.compacted_at ?? undefined,
      deleted: Boolean(row.deleted),
      eventCount: row.event_count,
      messages,
    };
  }

  private prepareSessionForPersistence(session: NormalizedSession): NormalizedSession {
    const parentSessionID = this.sanitizeParentSessionIDSync(
      session.sessionID,
      session.parentSessionID,
    );
    const lineage = this.resolveLineageSync(session.sessionID, parentSessionID);
    return {
      ...session,
      parentSessionID,
      rootSessionID: lineage.rootSessionID,
      lineageDepth: lineage.lineageDepth,
    };
  }

  private sanitizeParentSessionIDSync(
    sessionID: string,
    parentSessionID?: string,
  ): string | undefined {
    if (!parentSessionID || parentSessionID === sessionID) return undefined;

    const seen = new Set<string>([sessionID]);
    let currentSessionID: string | undefined = parentSessionID;
    while (currentSessionID) {
      if (seen.has(currentSessionID)) return undefined;
      seen.add(currentSessionID);
      const row = this.getDb()
        .prepare('SELECT parent_session_id FROM sessions WHERE session_id = ?')
        .get(currentSessionID) as { parent_session_id: string | null } | undefined;
      currentSessionID = row?.parent_session_id ?? undefined;
    }

    return parentSessionID;
  }

  private persistCapturedSessionSync(session: NormalizedSession, event: CapturedEvent): void {
    const payload = event.payload as Event;

    switch (payload.type) {
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
      case 'session.compacted':
        this.upsertSessionRowSync(session);
        return;
      case 'message.updated': {
        this.upsertSessionRowSync(session);
        const message = session.messages.find(
          (entry) => entry.info.id === payload.properties.info.id,
        );
        if (message) {
          this.upsertMessageInfoSync(session.sessionID, message);
          this.replaceMessageSearchRowSync(session.sessionID, message);
        }
        return;
      }
      case 'message.removed':
        this.upsertSessionRowSync(session);
        this.deleteMessageSync(session.sessionID, payload.properties.messageID);
        return;
      case 'message.part.updated': {
        this.upsertSessionRowSync(session);
        const message = session.messages.find(
          (entry) => entry.info.id === payload.properties.part.messageID,
        );
        if (message) this.replaceMessageSync(session.sessionID, message);
        return;
      }
      case 'message.part.removed': {
        this.upsertSessionRowSync(session);
        const message = session.messages.find(
          (entry) => entry.info.id === payload.properties.messageID,
        );
        if (message) this.replaceMessageSync(session.sessionID, message);
        return;
      }
      default:
        this.persistSession(session);
    }
  }

  private persistSession(session: NormalizedSession): void {
    const db = this.getDb();
    const preparedSession = this.prepareSessionForPersistence(session);
    const { storedSession, artifacts } = this.externalizeSessionSync(preparedSession);

    this.upsertSessionRowSync(storedSession);

    db.prepare('DELETE FROM artifact_fts WHERE session_id = ?').run(storedSession.sessionID);
    db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(storedSession.sessionID);
    db.prepare('DELETE FROM parts WHERE session_id = ?').run(storedSession.sessionID);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(storedSession.sessionID);

    const insertMessage = db.prepare(
      'INSERT INTO messages (message_id, session_id, created_at, info_json) VALUES (?, ?, ?, ?)',
    );
    const insertPart = db.prepare(
      'INSERT INTO parts (part_id, session_id, message_id, sort_key, part_json) VALUES (?, ?, ?, ?, ?)',
    );

    for (const message of storedSession.messages) {
      insertMessage.run(
        message.info.id,
        storedSession.sessionID,
        message.info.time.created,
        JSON.stringify(message.info),
      );

      message.parts.forEach((part, index) => {
        insertPart.run(
          part.id,
          storedSession.sessionID,
          part.messageID,
          index,
          JSON.stringify(part),
        );
      });
    }

    this.insertArtifactsSync(artifacts);
    this.replaceMessageSearchRowsSync(storedSession);
  }

  private upsertSessionRowSync(session: NormalizedSession): void {
    const db = this.getDb();
    const worktreeKey = normalizeWorktreeKey(session.directory);

    db.prepare(
      `INSERT INTO sessions (session_id, title, session_directory, worktree_key, parent_session_id, root_session_id, lineage_depth, pinned, pin_reason, updated_at, compacted_at, deleted, event_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         title = excluded.title,
         session_directory = excluded.session_directory,
         worktree_key = excluded.worktree_key,
         parent_session_id = excluded.parent_session_id,
         root_session_id = excluded.root_session_id,
         lineage_depth = excluded.lineage_depth,
         pinned = excluded.pinned,
         pin_reason = excluded.pin_reason,
         updated_at = excluded.updated_at,
         compacted_at = excluded.compacted_at,
         deleted = excluded.deleted,
         event_count = excluded.event_count`,
    ).run(
      session.sessionID,
      session.title ?? null,
      session.directory ?? null,
      worktreeKey ?? null,
      session.parentSessionID ?? null,
      session.rootSessionID ?? session.sessionID,
      session.lineageDepth ?? 0,
      session.pinned ? 1 : 0,
      session.pinReason ?? null,
      session.updatedAt,
      session.compactedAt ?? null,
      session.deleted ? 1 : 0,
      session.eventCount,
    );
  }

  private upsertMessageInfoSync(sessionID: string, message: ConversationMessage): void {
    this.getDb()
      .prepare(
        `INSERT INTO messages (message_id, session_id, created_at, info_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           session_id = excluded.session_id,
           created_at = excluded.created_at,
           info_json = excluded.info_json`,
      )
      .run(message.info.id, sessionID, message.info.time.created, JSON.stringify(message.info));
  }

  private deleteMessageSync(sessionID: string, messageID: string): void {
    const db = this.getDb();
    db.prepare('DELETE FROM artifact_fts WHERE message_id = ?').run(messageID);
    db.prepare('DELETE FROM message_fts WHERE message_id = ?').run(messageID);
    db.prepare('DELETE FROM artifacts WHERE session_id = ? AND message_id = ?').run(
      sessionID,
      messageID,
    );
    db.prepare('DELETE FROM parts WHERE session_id = ? AND message_id = ?').run(
      sessionID,
      messageID,
    );
    db.prepare('DELETE FROM messages WHERE session_id = ? AND message_id = ?').run(
      sessionID,
      messageID,
    );
  }

  private replaceMessageSync(sessionID: string, message: ConversationMessage): void {
    const db = this.getDb();
    const { storedMessage, artifacts } = this.externalizeMessageSync(message);

    this.deleteMessageSync(sessionID, message.info.id);
    this.upsertMessageInfoSync(sessionID, storedMessage);

    const insertPart = db.prepare(
      'INSERT INTO parts (part_id, session_id, message_id, sort_key, part_json) VALUES (?, ?, ?, ?, ?)',
    );

    storedMessage.parts.forEach((part, index) => {
      insertPart.run(part.id, sessionID, part.messageID, index, JSON.stringify(part));
    });

    this.insertArtifactsSync(artifacts);
    this.replaceMessageSearchRowSync(sessionID, storedMessage);
  }

  private externalizeMessageSync(message: ConversationMessage): {
    storedMessage: ConversationMessage;
    artifacts: ArtifactData[];
  } {
    const artifacts: ArtifactData[] = [];
    const storedInfo = parseJson<Message>(JSON.stringify(message.info));
    const storedParts = message.parts.map((part) => {
      const { storedPart, artifacts: nextArtifacts } = this.externalizePartSync(
        part,
        message.info.time.created,
      );
      artifacts.push(...nextArtifacts);
      return storedPart;
    });

    return {
      storedMessage: {
        info: storedInfo,
        parts: storedParts,
      },
      artifacts,
    };
  }

  private createArtifactData(input: {
    sessionID: string;
    messageID: string;
    partID: string;
    artifactKind: string;
    fieldName: string;
    contentText: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
    previewText?: string;
  }): ArtifactData {
    const contentHash = hashContent(input.contentText);
    return {
      artifactID: `art_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      sessionID: input.sessionID,
      messageID: input.messageID,
      partID: input.partID,
      artifactKind: input.artifactKind,
      fieldName: input.fieldName,
      previewText:
        input.previewText ??
        truncate(input.contentText.replace(/\s+/g, ' ').trim(), this.options.artifactPreviewChars),
      contentText: input.contentText,
      contentHash,
      charCount: input.contentText.length,
      createdAt: input.createdAt,
      metadata: input.metadata ?? {},
    };
  }

  private formatArtifactMetadataLines(metadata: Record<string, unknown>): string[] {
    const lines = Object.entries(metadata)
      .map(([key, value]) => {
        const formatted = formatMetadataValue(value);
        return formatted ? `${key}: ${formatted}` : undefined;
      })
      .filter((line): line is string => Boolean(line));

    return lines.length > 0 ? ['Metadata:', ...lines] : [];
  }

  private buildArtifactSearchContent(artifact: ArtifactData): string {
    const metadata = Object.entries(artifact.metadata)
      .map(([key, value]) => {
        const formatted = formatMetadataValue(value);
        return formatted ? `${key}: ${formatted}` : undefined;
      })
      .filter((line): line is string => Boolean(line))
      .join('\n');

    return [artifact.previewText, metadata, artifact.contentText].filter(Boolean).join('\n');
  }

  private buildFileArtifactMetadata(
    file: Extract<Part, { type: 'file' }>,
    extras: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const sourcePath = file.source && 'path' in file.source ? file.source.path : undefined;
    const extension = inferFileExtension(file.filename ?? sourcePath ?? file.url);
    const category = classifyFileCategory(file.mime, extension);
    return {
      category,
      extension,
      mime: file.mime,
      filename: file.filename,
      url: file.url,
      urlScheme: inferUrlScheme(file.url),
      sourceType: file.source?.type,
      sourcePath,
      hint: fileCategoryHint(category),
      ...extras,
    };
  }

  private buildBinaryPreviewArtifact(
    file: Extract<Part, { type: 'file' }>,
    fieldName: string,
    label: string,
    createdAt: number,
    extras: Record<string, unknown> = {},
  ): ArtifactData {
    const baseMetadata = this.buildFileArtifactMetadata(file, extras);
    const category = typeof baseMetadata.category === 'string' ? baseMetadata.category : 'binary';
    const extension =
      typeof baseMetadata.extension === 'string' ? baseMetadata.extension : undefined;
    const name =
      file.filename ??
      (typeof baseMetadata.sourcePath === 'string' ? baseMetadata.sourcePath : undefined) ??
      file.url ??
      'unknown file';
    const previewDetails = runBinaryPreviewProviders({
      workspaceDirectory: this.workspaceDirectory,
      file,
      category,
      extension,
      mime: file.mime,
      enabledProviders: this.options.binaryPreviewProviders,
      bytePeek: this.options.previewBytePeek,
    });
    const summary = previewDetails.summaryBits.slice(0, 3).join(', ');
    const contentText = [
      `${label}`,
      `Category: ${category}`,
      `Name: ${name}`,
      ...(typeof baseMetadata.sourcePath === 'string' ? [`Path: ${baseMetadata.sourcePath}`] : []),
      ...(file.mime ? [`MIME: ${file.mime}`] : []),
      ...(extension ? [`Extension: ${extension}`] : []),
      ...(typeof baseMetadata.urlScheme === 'string'
        ? [`URL scheme: ${baseMetadata.urlScheme}`]
        : []),
      ...(file.url ? [`URL: ${file.url}`] : []),
      ...(typeof baseMetadata.hint === 'string' ? [`Hint: ${baseMetadata.hint}`] : []),
      ...previewDetails.lines,
    ].join('\n');
    const previewText = truncate(
      `${label}: ${name} (${category}${summary ? `, ${summary}` : ''})`,
      this.options.artifactPreviewChars,
    );

    return this.createArtifactData({
      sessionID: file.sessionID,
      messageID: file.messageID,
      partID: file.id,
      artifactKind: 'file',
      fieldName,
      contentText,
      createdAt,
      metadata: { ...baseMetadata, ...previewDetails.metadata },
      previewText,
    });
  }

  private externalizeSessionSync(session: NormalizedSession): {
    storedSession: NormalizedSession;
    artifacts: ArtifactData[];
  } {
    const artifacts: ArtifactData[] = [];
    const storedMessages = session.messages.map((message) => {
      const storedInfo = parseJson<Message>(JSON.stringify(message.info));
      const storedParts = message.parts.map((part) => {
        const { storedPart, artifacts: nextArtifacts } = this.externalizePartSync(
          part,
          message.info.time.created,
        );
        artifacts.push(...nextArtifacts);
        return storedPart;
      });

      return {
        info: storedInfo,
        parts: storedParts,
      };
    });

    return {
      storedSession: {
        ...session,
        messages: storedMessages,
      },
      artifacts,
    };
  }

  private externalizePartSync(
    part: Part,
    createdAt: number,
  ): {
    storedPart: Part;
    artifacts: ArtifactData[];
  } {
    const storedPart = parseJson<Part>(JSON.stringify(part));
    const artifacts: ArtifactData[] = [];

    const externalize = (
      artifactKind: string,
      fieldName: string,
      value: string,
      metadata: Record<string, unknown> = {},
      previewText?: string,
    ): string => {
      if (value.length < this.options.largeContentThreshold) return value;

      const artifact = this.createArtifactData({
        sessionID: storedPart.sessionID,
        messageID: storedPart.messageID,
        partID: storedPart.id,
        artifactKind,
        fieldName,
        contentText: value,
        createdAt,
        metadata,
        previewText,
      });
      artifacts.push(artifact);
      return artifactPlaceholder(
        artifact.artifactID,
        `${artifactKind}/${fieldName}`,
        artifact.previewText,
        artifact.charCount,
      );
    };

    switch (storedPart.type) {
      case 'text':
        storedPart.text = externalize('message', 'text', storedPart.text);
        if (artifacts.length > 0) {
          storedPart.metadata = {
            ...(storedPart.metadata ?? {}),
            opencodeLcmArtifact: artifacts.map((artifact) => artifact.artifactID),
          };
        }
        break;
      case 'reasoning':
        storedPart.text = externalize('reasoning', 'text', storedPart.text);
        if (artifacts.length > 0) {
          storedPart.metadata = {
            ...(storedPart.metadata ?? {}),
            opencodeLcmArtifact: artifacts.map((artifact) => artifact.artifactID),
          };
        }
        break;
      case 'tool':
        if (storedPart.state.status === 'completed') {
          storedPart.state.output = externalize('tool', 'output', storedPart.state.output);
          if (storedPart.state.attachments) {
            storedPart.state.attachments = storedPart.state.attachments.map(
              (attachment: Extract<Part, { type: 'file' }>, index: number) => {
                const previewMetadata = {
                  attachmentIndex: index,
                  tool: storedPart.tool,
                  title:
                    storedPart.state.status === 'completed' ? storedPart.state.title : undefined,
                };
                artifacts.push(
                  this.buildBinaryPreviewArtifact(
                    attachment,
                    `attachment:${index}`,
                    `Tool attachment for ${storedPart.tool}`,
                    createdAt,
                    previewMetadata,
                  ),
                );

                if (attachment.source?.text?.value) {
                  attachment.source.text.value = externalize(
                    'file',
                    `attachment_text:${index}`,
                    attachment.source.text.value,
                    this.buildFileArtifactMetadata(attachment, previewMetadata),
                  );
                  attachment.source.text.start = 0;
                  attachment.source.text.end = attachment.source.text.value.length;
                }
                return attachment;
              },
            );
          }
        }
        if (storedPart.state.status === 'error') {
          storedPart.state.error = externalize('tool', 'error', storedPart.state.error);
        }
        break;
      case 'file':
        artifacts.push(
          this.buildBinaryPreviewArtifact(storedPart, 'reference', 'File reference', createdAt),
        );
        if (storedPart.source?.text?.value) {
          storedPart.source.text.value = externalize(
            'file',
            'source',
            storedPart.source.text.value,
            this.buildFileArtifactMetadata(storedPart),
          );
          storedPart.source.text.start = 0;
          storedPart.source.text.end = storedPart.source.text.value.length;
        }
        break;
      case 'snapshot':
        storedPart.snapshot = externalize('snapshot', 'snapshot', storedPart.snapshot);
        break;
      case 'agent':
        if (storedPart.source?.value) {
          storedPart.source.value = externalize('agent', 'source', storedPart.source.value);
          storedPart.source.start = 0;
          storedPart.source.end = storedPart.source.value.length;
        }
        break;
      case 'subtask':
        storedPart.prompt = externalize('subtask', 'prompt', storedPart.prompt);
        storedPart.description = externalize('subtask', 'description', storedPart.description);
        break;
      default:
        break;
    }

    return { storedPart, artifacts };
  }

  private insertArtifactsSync(artifacts: ArtifactData[]): void {
    if (artifacts.length === 0) return;

    const db = this.getDb();
    const insertBlob = db.prepare(
      `INSERT OR IGNORE INTO artifact_blobs (content_hash, content_text, char_count, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const insertArtifact = db.prepare(
      `INSERT INTO artifacts
       (artifact_id, session_id, message_id, part_id, artifact_kind, field_name, preview_text, content_text, content_hash, metadata_json, char_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(
      'INSERT INTO artifact_fts (session_id, artifact_id, message_id, part_id, artifact_kind, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    for (const artifact of artifacts) {
      insertBlob.run(
        artifact.contentHash,
        artifact.contentText,
        artifact.charCount,
        artifact.createdAt,
      );
      insertArtifact.run(
        artifact.artifactID,
        artifact.sessionID,
        artifact.messageID,
        artifact.partID,
        artifact.artifactKind,
        artifact.fieldName,
        artifact.previewText,
        '',
        artifact.contentHash,
        JSON.stringify(artifact.metadata),
        artifact.charCount,
        artifact.createdAt,
      );
      insertFts.run(
        artifact.sessionID,
        artifact.artifactID,
        artifact.messageID,
        artifact.partID,
        artifact.artifactKind,
        String(artifact.createdAt),
        this.buildArtifactSearchContent(artifact),
      );
    }
  }

  private writeEvent(event: CapturedEvent): void {
    const payloadStub =
      event.type.startsWith('message.') || event.type.startsWith('session.')
        ? `[${event.type}]`
        : '';
    this.getDb()
      .prepare(
        `INSERT OR IGNORE INTO events (id, session_id, event_type, ts, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.id, event.sessionID ?? null, event.type, event.timestamp, payloadStub);
  }

  private clearSummaryGraphSync(sessionID: string): void {
    const db = this.getDb();
    db.prepare('DELETE FROM summary_fts WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM summary_edges WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM summary_nodes WHERE session_id = ?').run(sessionID);
    db.prepare('DELETE FROM summary_state WHERE session_id = ?').run(sessionID);
  }

  private latestSessionIDSync(): string | undefined {
    const row = this.getDb()
      .prepare(
        'SELECT session_id FROM sessions WHERE event_count > 0 ORDER BY updated_at DESC LIMIT 1',
      )
      .get() as { session_id: string } | undefined;
    return row?.session_id;
  }

  private async migrateLegacyArtifacts(): Promise<void> {
    const db = this.getDb();
    const existing = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number;
    };
    if (existing.count > 0) return;

    const sessionsDir = path.join(this.baseDir, 'sessions');
    try {
      const entries = await readdir(sessionsDir);
      for (const entry of entries.filter((item) => item.endsWith('.json'))) {
        const content = await readFile(path.join(sessionsDir, entry), 'utf8');
        const session = parseJson<NormalizedSession>(content);
        this.persistSession(session);
      }
    } catch (error) {
      getLogger().debug('Legacy session snapshot migration skipped', { error });
    }

    const resumePath = path.join(this.baseDir, 'resume.json');
    try {
      const content = await readFile(resumePath, 'utf8');
      const resumes = parseJson<ResumeMap>(content);
      const insertResume = db.prepare(
        `INSERT INTO resumes (session_id, note, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      );
      const now = Date.now();
      for (const [sessionID, note] of Object.entries(resumes)) {
        insertResume.run(sessionID, note, now);
      }
    } catch (error) {
      getLogger().debug('Legacy resume migration skipped', { error });
    }

    const eventsPath = path.join(this.baseDir, 'events.jsonl');
    try {
      const content = await readFile(eventsPath, 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const event = parseJson<CapturedEvent>(line);
          this.writeEvent(event);
        } catch (error) {
          getLogger().debug('Malformed legacy event line skipped', { error });
        }
      }
    } catch (error) {
      getLogger().debug('Legacy event migration skipped', { error });
    }
  }

  private getDb(): SqlDatabaseLike {
    if (!this.db) throw new Error('LCM store not initialized');
    return this.db;
  }
}
